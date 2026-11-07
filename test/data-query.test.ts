/**
 * data_query: lab.toml [tables], the agent's grant, and the query path through the real sandbox container against
 * lab0's visits CSV and the fake REDCap dosing project. The answers are checked against fixtures/lab0/data/answers.json,
 * computed when the fixtures were generated, not by the engine. The container tests skip like run-code.test.ts when no
 * daemon answers or the image is not built.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../packages/core/src/config.ts";
import { DEFAULT_POLICY, Labelled, type DataClass } from "../packages/core/src/dataclass.ts";
import { createGateway, type ExactModelId } from "../packages/core/src/gateway.ts";
import type { Sha256 } from "../packages/core/src/hash.ts";
import { createKbReader, memorySnapshots, NO_MEMBER } from "../packages/core/src/kb.ts";
import { drive, type LoopDeps } from "../packages/core/src/loop.ts";
import { LOOP_CONTRACT, type AgentId, type ResolvedAgent } from "../packages/core/src/agent.ts";
import type { LeasedJob } from "../packages/core/src/queue.ts";
import type { RunEvent, RunId, ThreadKey } from "../packages/core/src/record.ts";
import { createSandbox, type Sandbox } from "../packages/core/src/sandbox.ts";
import type { Surface } from "../packages/core/src/frontdoor.ts";
import { executeQuery, restrictedColumn, sameAnswer, tableReader, type DataQuery, type QueryRecord, type Table, type TableSandbox } from "../packages/core/src/tables.ts";
import { builtinTools, createHttpEgress, createToolRunner, registryOf, type ToolEnv } from "../packages/core/src/tools.ts";
import { lab0Dosing, startFakeRedcap } from "../scripts/fake-redcap.ts";
import { startFakeModel } from "./fake-model.ts";
import { memoryJournal } from "./recorder.ts";
import { findDocker, get } from "./sandbox-docker.ts";

const docker = await findDocker();
const opts = { skip: typeof docker === "string" ? docker : false };

const DATA = fileURLToPath(new URL("../fixtures/lab0/data/", import.meta.url));
const truth = JSON.parse(readFileSync(`${DATA}answers.json`, "utf8")) as Record<string, number> & { visit3_done_by_site: Record<string, number> };
const visitsCsv = readFileSync(`${DATA}visits.csv`, "utf8");
const dosingCsv = readFileSync(`${DATA}redcap-dosing-records.csv`, "utf8");
/** Values that identify someone, from both sources. None may reach a model, in any form. */
const dosingHeader = dosingCsv.split("\n")[0]!.split(",");
const IDENTIFIER_FIELDS = ["first_name", "last_name", "mrn"];
const identifying = [
  ...visitsCsv.split("\n").slice(1).flatMap((l) => l.split(",").slice(0, 3)),
  ...dosingCsv.split("\n").slice(1).flatMap((l) => IDENTIFIER_FIELDS.map((f) => l.split(",")[dosingHeader.indexOf(f)] ?? "")),
].filter(Boolean);

const TOKEN = "lab0-redcap-token-for-tests";
const redcap = await startFakeRedcap(await lab0Dosing(TOKEN));
after(() => redcap.close());

const VISITS: Table = {
  id: "visits",
  description: "lab0 visit log, one row per participant",
  source: { kind: "csv", path: `${DATA}visits.csv` },
  columns: { participant_id: "restricted", initials: "restricted", dob: "restricted", cohort: "free", site: "free", visit3_done: "free", dose_mg: "free", sleep_hours: "free" },
  aggregateClass: "D1",
  minCell: 5,
};
const DOSING: Table = {
  id: "dosing",
  description: "lab0 dosing project in REDCap",
  // rosa is rlee (DAG madison, full export), kiran is kpatel (no DAG, de-identified), mei is mchen (expired),
  // owen is ostone (DAG milwaukee, no export on the enrollment form), ghost maps to a username the project lacks.
  source: { kind: "redcap", url: redcap.url, tokenEnv: "LAB0_REDCAP_TOKEN", users: { rosa: "rlee", kiran: "kpatel", mei: "mchen", owen: "ostone", ghost: "nobody" } },
  columns: { record_id: "restricted", arm: "free", weight_kg: "free", ae_grade: "free", consent_date: "free" },
  aggregateClass: "D1",
  minCell: 5,
};
const MISFILED: Table = { ...DOSING, id: "misfiled", columns: { ...DOSING.columns, mrn: "free" } };

const config = typeof docker === "string" ? null : { image: docker.image, digest: docker.image.slice(7) as Sha256, cpus: 1, memoryMb: 512, timeoutMs: 20_000, socket: docker.socket };

/** The real sandbox, counting its data_query containers and keeping the table each one was given. */
function countingSandbox(): { sandbox: Sandbox | null; aggregates: () => number; tables: string[] } {
  const tables: string[] = [];
  if (!config) return { sandbox: null, aggregates: () => 0, tables };
  const real = createSandbox(config);
  return { sandbox: { ...real, aggregate: (files, engine, signal) => (tables.push(Buffer.from(files.find((f) => f.name === "table.csv")!.data).toString("utf8")), real.aggregate(files, engine, signal)) }, aggregates: () => tables.length, tables };
}

const secret = (name: string) => (name === "LAB0_REDCAP_TOKEN" ? TOKEN : undefined);
const http = createHttpEgress({ policy: DEFAULT_POLICY, hosts: { "127.0.0.1": "lab" } });

function runnerWith(sandbox: Sandbox | null) {
  return createToolRunner(registryOf(builtinTools()), { http, kb: createKbReader(memorySnapshots([])), tables: [VISITS, DOSING, MISFILED], sandbox, sandboxImage: config?.digest ?? null, secret });
}

const env: ToolEnv = { viewer: NO_MEMBER, knowledgeBases: [], retrieval: { algorithm: "bm25-v1", readCapTokens: 1000 }, sandbox: null, tables: ["visits", "dosing", "misfiled"] };

type Outcome = { readonly ok: true; readonly cls: DataClass; readonly record: QueryRecord } | { readonly ok: false; readonly code: string; readonly detail: string; readonly cls: DataClass | null };

/** One data_query call in a run the member started; member null is a run no member started, like a schedule. */
async function query(q: Partial<DataQuery> & Pick<DataQuery, "table" | "measures">, sandbox = countingSandbox().sandbox, tables: ToolEnv["tables"] = env.tables, member: string | null = "kiran"): Promise<Outcome> {
  const j = memoryJournal("00000000-0000-4000-8000-0000000000dd" as RunId);
  const trigger = member === null ? { t: "schedule", scheduleId: "nightly" } : { t: "test", memberId: member };
  await j.append({ t: "run.started", trigger, input: await j.put(Labelled.stamp("q", "D0", "test")), history: [] } as unknown as RunEvent);
  const ref = await j.put(Labelled.stamp(q, "D1", "test"));
  await runnerWith(sandbox).invoke(j, { callId: "c1", tool: "data_query", attempt: 1, input: ref }, { ...env, tables }, new AbortController().signal);
  const last = j.log.at(-1)!;
  if (last.t === "tool.completed") return { ok: true, cls: last.output.cls, record: j.body(last.output) as QueryRecord };
  assert.equal(last.t, "tool.failed");
  if (last.t !== "tool.failed") throw new Error("unreachable");
  return { ok: false, code: last.failure.code, detail: String(last.failure.detail ? j.body(last.failure.detail) : ""), cls: last.failure.detail?.cls ?? null };
}

const values = (o: Outcome) => (o.ok ? o.record.groups.map((g) => ({ ...g.key, n: g.n, ...g.values })) : o);

async function leftoverContainers(): Promise<number> {
  if (typeof docker === "string") return 0;
  const filters = encodeURIComponent(JSON.stringify({ label: ["aliquot.data_query=1"] }));
  return (JSON.parse((await get(docker.socket, `/containers/json?all=true&filters=${filters}`)).body) as unknown[]).length;
}

test("lab.toml registers a CSV and a REDCap table, and refuses a REDCap host it does not place, a min_cell under 5, or both sources at once", () => {
  const base = `[endpoints.local]\nbase_url = "http://127.0.0.1:1/v1"\nplacement = "lab"\n[hosts]\n"redcap.lab.example.edu" = "institution"\n`;
  const csv = `[tables.visits]\ndescription = "visit log"\ncsv = "data/visits.csv"\naggregate_class = "D1"\n[tables.visits.columns]\nparticipant_id = "restricted"\ncohort = "free"\n`;
  const rc = `[tables.dosing]\ndescription = "dosing"\nredcap_url = "https://redcap.lab.example.edu/api/"\nredcap_token_env = "REDCAP_TOKEN"\naggregate_class = "D1"\nmin_cell = 11\n[tables.dosing.columns]\narm = "free"\n`;
  const c = parseConfig(base + csv + rc, "/lab/lab.toml");
  assert.deepEqual(c.tables, [
    { id: "visits", description: "visit log", columns: { participant_id: "restricted", cohort: "free" }, aggregateClass: "D1", minCell: 5, source: { kind: "csv", path: "/lab/data/visits.csv" } },
    { id: "dosing", description: "dosing", columns: { arm: "free" }, aggregateClass: "D1", minCell: 11, source: { kind: "redcap", url: "https://redcap.lab.example.edu/api/", tokenEnv: "REDCAP_TOKEN", users: {} } },
  ]);
  const mapped = parseConfig(base + rc.replace("min_cell = 11", 'min_cell = 11\n[tables.dosing.redcap_users]\n"ana@lab0.example" = "alee"'), "/lab/lab.toml");
  assert.deepEqual(mapped.tables[0]!.source, { kind: "redcap", url: "https://redcap.lab.example.edu/api/", tokenEnv: "REDCAP_TOKEN", users: { "ana@lab0.example": "alee" } });
  assert.throws(() => parseConfig(base + csv + '[tables.visits.redcap_users]\n"ana@lab0.example" = "alee"\n', "/lab/lab.toml"), { message: "lab.toml: [tables.visits] names redcap_users, which only a REDCap table takes" });
  assert.throws(() => parseConfig(base + rc.replace("redcap.lab.example.edu/api", "redcap.vendor.example.com/api"), "/lab/lab.toml"), { message: "lab.toml: [tables.dosing] names REDCap at redcap.vendor.example.com, which [hosts] does not place as lab or institution; the export request carries the token there" });
  assert.throws(() => parseConfig(base + csv.replace('aggregate_class = "D1"', 'aggregate_class = "D1"\nmin_cell = 3'), "/lab/lab.toml"), /may not be below 5/);
  assert.throws(() => parseConfig(base + csv.replace('csv = "data/visits.csv"', 'csv = "data/visits.csv"\nredcap_url = "https://redcap.lab.example.edu/api/"'), "/lab/lab.toml"), { message: "lab.toml: [tables.visits] needs csv, or redcap_url with redcap_token_env, and not both" });
});

test("a count, a mean and a group-by over the visits CSV come back as the ground truth, at the table's aggregate class", opts, async () => {
  const count = await query({ table: "visits", where: [{ column: "visit3_done", op: "eq", value: 1 }], measures: [{ fn: "count" }] });
  assert.deepEqual(values(count), [{ n: truth.visit3_done_count, "count(*)": truth.visit3_done_count }]);
  assert.equal(count.ok && count.cls, "D1");
  const mean = await query({ table: "visits", where: [{ column: "cohort", op: "eq", value: "B" }], measures: [{ fn: "mean", column: "dose_mg" }] });
  assert.deepEqual(values(mean), [{ n: truth.cohort_b_n, "mean(dose_mg)": truth.cohort_b_mean_dose }]);
  const bySite = await query({ table: "visits", where: [{ column: "visit3_done", op: "eq", value: 1 }], groupBy: ["site"], measures: [{ fn: "count" }] });
  assert.deepEqual(values(bySite), Object.entries(truth.visit3_done_by_site).sort().map(([site, n]) => ({ site, n, "count(*)": n })));
  assert.ok(bySite.ok);
  if (!bySite.ok) return;
  assert.deepEqual([bySite.record.rowsRead, bySite.record.rowsMatched, bySite.record.source.kind, bySite.record.minCell], [truth.rows, truth.visit3_done_count, "csv", 5]);
  assert.equal(await leftoverContainers(), 0);
});

test("the REDCap source answers through the same path: the metadata, the member's user rights, then the flat records export, with the token from the environment", opts, async () => {
  const before = redcap.requests.length;
  const byArm = await query({ table: "dosing", groupBy: ["arm"], measures: [{ fn: "count" }, { fn: "mean", column: "weight_kg" }] });
  assert.deepEqual(values(byArm), [
    { arm: "1", n: truth.arm1_n, "count(*)": truth.arm1_n, "mean(weight_kg)": truth.arm1_mean_weight },
    { arm: "2", n: truth.arm2_n, "count(*)": truth.arm2_n, "mean(weight_kg)": truth.arm2_mean_weight },
  ]);
  const ae = await query({ table: "dosing", where: [{ column: "ae_grade", op: "ge", value: 2 }], measures: [{ fn: "count" }] });
  assert.deepEqual(values(ae), [{ n: truth.ae_grade_ge2_count, "count(*)": truth.ae_grade_ge2_count }]);
  assert.deepEqual(
    redcap.requests.slice(before).map((r) => [r.content, r.format, r.token]),
    [["metadata", "json", "valid"], ["user", "json", "valid"], ["record", "csv", "valid"], ["metadata", "json", "valid"], ["user", "json", "valid"], ["record", "csv", "valid"]],
  );
  assert.deepEqual(byArm.ok && byArm.record.rights, { member: "kiran", redcapUser: "kpatel", dag: null, forms: { enrollment: "de-identified", dosing: "de-identified" } });
});

test("a query that names a restricted column is refused before the table is read: no container, no records export", opts, async () => {
  const counted = countingSandbox();
  const before = redcap.requests.length;
  const dob = await query({ table: "visits", groupBy: ["dob"], measures: [{ fn: "count" }] }, counted.sandbox);
  assert.deepEqual(dob, { ok: false, code: "invalid-input", detail: "column dob of table visits is restricted; it never leaves the sandbox", cls: "D1" });
  const undeclared = await query({ table: "dosing", where: [{ column: "first_name", op: "eq", value: "Ava" }], measures: [{ fn: "count" }] }, counted.sandbox);
  assert.deepEqual(undeclared, { ok: false, code: "invalid-input", detail: "column first_name of table dosing is restricted; it never leaves the sandbox", cls: "D1" });
  // Declared free in lab.toml, but REDCap's own dictionary flags it: the metadata is read, the records never are.
  const flagged = await query({ table: "misfiled", groupBy: ["mrn"], measures: [{ fn: "count" }] }, counted.sandbox);
  assert.deepEqual(flagged, { ok: false, code: "invalid-input", detail: "column mrn of table misfiled is restricted; it never leaves the sandbox (the source flags it as an identifier)", cls: "D1" });
  assert.equal(counted.aggregates(), 0, "no container was started");
  assert.deepEqual(redcap.requests.slice(before).map((r) => r.content), ["metadata"]);
});

test("a REDCap identifier flag covers the field's checkbox columns, field___1 and on", () => {
  const t: Table = { ...DOSING, columns: { arm: "free", race___1: "free", race_other: "free" } };
  const q = (column: string): DataQuery => ({ table: "dosing", where: [], groupBy: [column], measures: [{ fn: "count" }] });
  assert.deepEqual(["race___1", "race_other", "arm"].map((c) => restrictedColumn(t, q(c), ["race"])), ["race___1", null, null]);
});

test("a cell under 5 is refused inside the container, and the refusal names no value and no size", opts, async () => {
  const counted = countingSandbox();
  const cohortC = await query({ table: "visits", where: [{ column: "cohort", op: "eq", value: "C" }], measures: [{ fn: "mean", column: "dose_mg" }] }, counted.sandbox);
  const refusal = "a group, or the values behind a measure, has fewer than 5 rows; widen the groups or drop a filter";
  assert.deepEqual(cohortC, { ok: false, code: "invalid-input", detail: refusal, cls: "D1" });
  const byCohort = await query({ table: "visits", groupBy: ["cohort"], measures: [{ fn: "count" }] }, counted.sandbox);
  assert.deepEqual(byCohort, { ok: false, code: "invalid-input", detail: refusal, cls: "D1" });
  const grade3 = await query({ table: "dosing", where: [{ column: "ae_grade", op: "eq", value: 3 }], measures: [{ fn: "count" }] }, counted.sandbox);
  assert.deepEqual(grade3, { ok: false, code: "invalid-input", detail: refusal, cls: "D1" });
  assert.equal(counted.aggregates(), 3, "each was computed in the container, which refused it");
  assert.equal(await leftoverContainers(), 0);
});

test("a table the agent was not granted is refused, and so is a query when the deployment has no sandbox", async () => {
  assert.deepEqual(await query({ table: "dosing", measures: [{ fn: "count" }] }, null, ["visits"]), { ok: false, code: "invalid-input", detail: "table dosing is not one this agent may query; its tables are visits", cls: "D1" });
  assert.deepEqual(await query({ table: "visits", measures: [{ fn: "count" }] }, null), { ok: false, code: "invalid-input", detail: "data_query runs in the sandbox, and this deployment has none", cls: "D1" });
  const minmax = await query({ table: "visits", measures: [{ fn: "max" as "sum", column: "dose_mg" }] }, null);
  assert.equal(minmax.ok, false);
  assert.equal(!minmax.ok && minmax.code, "invalid-input");
});

test("the record replays: the same query over the same source gives the same number, and a changed source says so", opts, async () => {
  const first = await query({ table: "visits", where: [{ column: "cohort", op: "eq", value: "B" }], measures: [{ fn: "mean", column: "dose_mg" }] });
  assert.ok(first.ok);
  if (!first.ok) return;
  const rec = first.record;
  const sandbox: TableSandbox = { image: config!.digest, aggregate: (f, e, s) => createSandbox(config!).aggregate(f, e, s) };
  const read = tableReader({ post: async () => new Response(null, { status: 500 }), secret });
  const deps = { read, sandbox, signal: new AbortController().signal, member: null, today: "2026-11-07" };
  const rerun = await executeQuery(VISITS, rec.query, deps);
  assert.deepEqual(sameAnswer(rec, rerun), { same: true, why: null });
  assert.equal(rerun.groups[0]!.values["mean(dose_mg)"], truth.cohort_b_mean_dose);
  const edited: typeof read = { dictionary: async () => [], user: async () => null, bytes: async () => Buffer.from(visitsCsv.replace("P101,", "P101x,")) };
  const changed = await executeQuery(VISITS, rec.query, { ...deps, read: edited });
  assert.equal(sameAnswer(rec, changed).same, false);
  assert.match(sameAnswer(rec, changed).why!, /^the source changed/);
});

test("on the wire: a hosted model asking three questions sees two aggregates and one refusal, and no row value in any request", opts, async () => {
  const model = await startFakeModel("hosted-2", "data");
  after(() => model.close());
  model.queries = {
    "How many participants finished visit 3?": { table: "visits", where: [{ column: "visit3_done", op: "eq", value: 1 }], measures: [{ fn: "count" }] },
    "What was the mean dose in cohort B?": { table: "visits", where: [{ column: "cohort", op: "eq", value: "B" }], measures: [{ fn: "mean", column: "dose_mg" }] },
    "List the birth dates in cohort C.": { table: "visits", where: [{ column: "cohort", op: "eq", value: "C" }], groupBy: ["dob"], measures: [{ fn: "count" }] },
  };
  const gateway = createGateway([{ id: "hosted", baseUrl: model.url, placement: "zdr", supportsLogprobs: false }], DEFAULT_POLICY, fetch);
  const registry = registryOf(builtinTools());
  const agent: ResolvedAgent = {
    schema: 2,
    agentId: "lab0-data" as AgentId,
    loopContract: LOOP_CONTRACT,
    instructions: "Answer from the lab's tables with data_query.",
    instructionsClass: "D0",
    model: { endpointId: "hosted", modelId: "hosted-2" as ExactModelId, params: { temperature: 0, maxOutputTokens: 256 } },
    knowledgeBases: [],
    tools: [{ name: "data_query", hash: registry.get("data_query")!.hash }],
    sandbox: null,
    retrieval: { algorithm: "bm25-v1", readCapTokens: 1000 },
    limits: { maxSteps: 10, maxTokens: 100_000, maxWallMs: 60_000 },
    tables: ["visits"],
  };
  const answers: string[] = [];
  for (const [i, text] of Object.keys(model.queries).entries()) {
    const RUN = `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}` as RunId;
    const journal = memoryJournal(RUN);
    const input = await journal.put(Labelled.stamp(text, "D1", "gate:floor"));
    const surface: Surface = {
      id: "web" as Surface["id"],
      placement: "lab",
      startStream: async () => ({ push() {}, close: async () => false }),
      finalize: async (_r: unknown, _t: unknown, posted: string) => (answers.push(posted), { mode: "final-post", messageId: String(answers.length) }),
      askConfirm: async () => {},
      linkTo: () => "http://localhost/run",
    };
    const job: LeasedJob = {
      id: RUN,
      kind: "run",
      key: `msg:web:lab:t${i}:m`,
      thread: `web:lab:t${i}` as ThreadKey,
      owner: "A",
      epoch: 1,
      attempts: 0,
      payload: { agent: "a".repeat(64), kind: "interactive", trigger: { t: "message", surface: "web", messageId: "m", memberId: "alice" }, thread: `web:lab:t${i}`, surface: "web", threadId: `t${i}`, input, history: [], studyId: null },
    };
    const kb = createKbReader(memorySnapshots([]));
    const deps: LoopDeps = {
      gateway,
      tools: createToolRunner(registry, { http, kb, tables: [VISITS], sandbox: createSandbox(config!), sandboxImage: config!.digest, secret }),
      kb,
      surfaces: () => surface,
      policy: DEFAULT_POLICY,
      loadAgent: async () => agent,
      deployed: async () => ({ tools: registry.deployed(), snapshots: new Set(), sandboxImages: new Set(), loopContract: LOOP_CONTRACT, retrieval: new Set(["bm25-v1"]) }),
      clock: { now: () => Date.now() },
      callSignal: () => ({ signal: new AbortController().signal, release() {} }),
      log: () => {},
    };
    assert.deepEqual(await drive(job, journal, deps), { t: "finished", outcome: "answered" });
    assert.equal(journal.log.filter((e: RunEvent) => e.t === "egress.refused").length, 0);
  }
  assert.match(answers[0]!, new RegExp(`"count\\(\\*\\)":${truth.visit3_done_count}`));
  assert.match(answers[1]!, new RegExp(`"mean\\(dose_mg\\)":${truth.cohort_b_mean_dose}`));
  assert.match(answers[2]!, /column dob of table visits is restricted/);
  const wire = JSON.stringify(model.bodies);
  const leaked = identifying.filter((v) => wire.includes(v));
  assert.deepEqual(leaked, [], "no participant id, initials, birth date, name or MRN reached the model");
  assert.equal(model.bodies.length, 6, "two model calls per question");
});

test("a member in a Data Access Group gets aggregates over that DAG's records only, and a member in none over every record", opts, async () => {
  const before = redcap.requests.length;
  const rosa = await query({ table: "dosing", groupBy: ["arm"], measures: [{ fn: "count" }, { fn: "mean", column: "weight_kg" }] }, undefined, undefined, "rosa");
  assert.deepEqual(values(rosa), [
    { arm: "1", n: truth.dag_madison_arm1_n, "count(*)": truth.dag_madison_arm1_n, "mean(weight_kg)": truth.dag_madison_arm1_mean_weight },
    { arm: "2", n: truth.dag_madison_arm2_n, "count(*)": truth.dag_madison_arm2_n, "mean(weight_kg)": truth.dag_madison_arm2_mean_weight },
  ]);
  assert.ok(rosa.ok);
  if (!rosa.ok) return;
  assert.deepEqual([rosa.record.rowsRead, rosa.record.rowsMatched], [truth.dag_madison_n, truth.dag_madison_n]);
  assert.deepEqual(rosa.record.rights, { member: "rosa", redcapUser: "rlee", dag: "madison", forms: { enrollment: "full", dosing: "full" } });
  const ae = await query({ table: "dosing", where: [{ column: "ae_grade", op: "ge", value: 2 }], groupBy: [], measures: [{ fn: "count" }] }, undefined, undefined, "kiran");
  assert.deepEqual(values(ae), [{ n: truth.ae_grade_ge2_count, "count(*)": truth.ae_grade_ge2_count }]);
  const all = await query({ table: "dosing", measures: [{ fn: "count" }] }, undefined, undefined, "kiran");
  const madison = await query({ table: "dosing", measures: [{ fn: "count" }] }, undefined, undefined, "rosa");
  assert.deepEqual([values(all), values(madison)], [[{ n: truth.redcap_rows, "count(*)": truth.redcap_rows }], [{ n: truth.dag_madison_n, "count(*)": truth.dag_madison_n }]]);
  const exports = redcap.requests.slice(before).filter((r) => r.content === "record").map((r) => r.exportDataAccessGroups);
  assert.deepEqual(exports, ["true", "false", "false", "true"], "only a user in a DAG asks for each record's DAG");
  // A user with no export on the enrollment form can still count a dosing-form field, in their own DAG.
  const owen = await query({ table: "dosing", measures: [{ fn: "count", column: "weight_kg" }] }, undefined, undefined, "owen");
  assert.deepEqual(values(owen), [{ n: truth.redcap_rows! - truth.dag_madison_n!, "count(weight_kg)": truth.redcap_rows! - truth.dag_madison_n! }]);
});

test("a de-identified member never touches an identifier field: the export asks only for the query's fields, and a date is refused before any record is read", opts, async () => {
  const counted = countingSandbox();
  const before = redcap.requests.length;
  const ok = await query({ table: "dosing", groupBy: ["arm"], measures: [{ fn: "mean", column: "weight_kg" }] }, counted.sandbox, undefined, "kiran");
  assert.ok(ok.ok);
  const asked = redcap.requests.slice(before).find((r) => r.content === "record")!;
  assert.deepEqual(Object.entries(asked).filter(([k]) => k.startsWith("fields[")).map(([, v]) => v), ["record_id", "arm", "weight_kg"]);
  const uploaded = counted.tables.join("\n");
  assert.equal(uploaded.split("\n")[0], "record_id,arm,weight_kg");
  assert.deepEqual(identifying.filter((v) => uploaded.includes(v)), [], "no name or MRN entered the sandbox");
  const mark = redcap.requests.length;
  const date = await query({ table: "dosing", measures: [{ fn: "count", column: "consent_date" }] }, counted.sandbox, undefined, "kiran");
  assert.deepEqual(date, { ok: false, code: "invalid-input", detail: "column consent_date of table dosing is a date or free-text field, which the member's de-identified REDCap export rights leave out", cls: "D1" });
  const mrn = await query({ table: "misfiled", groupBy: ["mrn"], measures: [{ fn: "count" }] }, counted.sandbox, ["misfiled"], "kiran");
  assert.equal(!mrn.ok && mrn.detail, "column mrn of table misfiled is restricted; it never leaves the sandbox (the source flags it as an identifier)");
  assert.deepEqual(redcap.requests.slice(mark).map((r) => r.content), ["metadata", "user", "metadata"], "neither refusal requested a record");
  assert.equal(counted.aggregates(), 1);
  // The same date field, for a member with full export, in their DAG.
  const rosa = await query({ table: "dosing", measures: [{ fn: "count", column: "consent_date" }] }, undefined, undefined, "rosa");
  assert.deepEqual(values(rosa), [{ n: truth.dag_madison_n, "count(consent_date)": truth.dag_madison_n }]);
});

test("a member the table maps to no REDCap user, a run with no member, a user the project lacks, an expired user, and a form without export rights are each refused before any record is read", opts, async () => {
  const counted = countingSandbox();
  const before = redcap.requests.length;
  const q = { table: "dosing", groupBy: ["arm"], measures: [{ fn: "count" as const }] };
  const refused = async (member: string | null) => {
    const o = await query(q, counted.sandbox, undefined, member);
    assert.equal(o.ok, false);
    return !o.ok && o.detail;
  };
  assert.equal(await refused("alice"), "table dosing is a REDCap project, and [tables.dosing.redcap_users] maps no REDCap user for the member who asked; rule: a member queries REDCap only under their own REDCap account");
  assert.equal(await refused(null), "table dosing is a REDCap project, which answers each member under their own REDCap rights, and this run has no member (a schedule, an eval or a replay)");
  assert.equal(await refused("ghost"), "table dosing: the member's REDCap user is not a user of the project");
  assert.equal(await refused("mei"), "table dosing: the member's REDCap access to the project expired on 2026-01-31");
  assert.equal(await refused("owen"), "column arm of table dosing is on REDCap form enrollment, which the member's REDCap export rights do not reach");
  assert.equal(counted.aggregates(), 0);
  assert.equal(redcap.requests.slice(before).filter((r) => r.content === "record").length, 0);
  // A CSV table has no REDCap rights and answers a run with no member as before.
  assert.ok((await query({ table: "visits", measures: [{ fn: "count" }] }, undefined, undefined, null)).ok);
});

test("REDCap's user export: forms_export as an object or as form:level text, and data_export when a version sends no forms_export", async () => {
  const project = await lab0Dosing(TOKEN);
  const users = [
    { username: "a", expiration: "", data_access_group: "", data_export: "1", forms_export: "enrollment:3,dosing:0" },
    { username: "b", expiration: null, data_access_group: null, data_export: 2 },
  ];
  const fake = await startFakeRedcap({ ...project, users: users as never });
  after(() => fake.close());
  const read = tableReader({ post: (url, form) => fetch(url, { method: "POST", body: new URLSearchParams(form) }), secret });
  const t: Table = { ...DOSING, source: { kind: "redcap", url: fake.url, tokenEnv: "LAB0_REDCAP_TOKEN", users: {} } };
  assert.deepEqual(await read.user(t, "a"), { username: "a", expiration: "", dataAccessGroup: "", forms: { enrollment: "no-identifiers", dosing: "none" }, dataExport: "full" });
  assert.deepEqual(await read.user(t, "b"), { username: "b", expiration: "", dataAccessGroup: "", forms: null, dataExport: "de-identified" });
  assert.equal(await read.user(t, "c"), null);
  const dictionary = await read.dictionary(t);
  assert.deepEqual(dictionary.filter((f) => f.identifier).map((f) => f.name), IDENTIFIER_FIELDS);
  assert.deepEqual(dictionary.filter((f) => f.deidentified).map((f) => f.name), ["record_id", "first_name", "last_name", "mrn", "consent_date"]);
});

test("a rerun under changed REDCap rights says so, even when the numbers agree", () => {
  const rec: QueryRecord = { table: "dosing", query: { table: "dosing", where: [], groupBy: [], measures: [{ fn: "count" }] }, source: { kind: "redcap", sha256: "a".repeat(64) as Sha256, bytes: 1 }, engine: { sha256: "b".repeat(64) as Sha256, image: "c".repeat(64) as Sha256 }, minCell: 5, rights: { member: "rosa", redcapUser: "rlee", dag: "madison", forms: { enrollment: "full" } }, rowsRead: 12, rowsMatched: 12, groups: [] };
  assert.deepEqual(sameAnswer(rec, { ...rec, rights: { ...rec.rights!, dag: null } }), { same: false, why: "the member's REDCap rights changed" });
  assert.deepEqual(sameAnswer(rec, rec), { same: true, why: null });
  const reordered: QueryRecord = { ...rec, rights: { ...rec.rights!, forms: { dosing: "full", enrollment: "full" } } };
  assert.deepEqual(sameAnswer({ ...rec, rights: { ...rec.rights!, forms: { enrollment: "full", dosing: "full" } } }, reordered), { same: true, why: null }, "the forms' key order is not a change");
});
