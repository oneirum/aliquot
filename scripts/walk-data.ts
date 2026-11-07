#!/usr/bin/env node
/**
 * pnpm walk:data: a lab0 member asks the lab's data, not its documents. The
 * lab registers a visits CSV and a REDCap dosing project (the fake REDCap
 * API) as [tables] in lab.toml, and an agent on a hosted model (placement
 * zdr) holds data_query over both. Real Postgres, web door and worker, the
 * sandbox image, and a scripted model that sends a pinned query per question
 * and quotes the result back. For each question it prints the answer and the
 * record: the query, the source's hash, the rows read and matched, and the
 * aggregate. REDCap answers each member under their own REDCap account:
 * member-1 is rlee, in the madison Data Access Group, and member-2 is
 * kpatel, with de-identified export rights and no DAG, so the same question
 * gets two counts; a date field is refused to member-2, and member-3, whom
 * lab.toml maps to no REDCap user, is refused. Then it reruns each recorded
 * query under the rights it recorded and checks the number is the same, and
 * checks that no participant id, initials, birth date, name or MRN reached
 * the model.
 *
 *   node scripts/walk-data.ts      (needs Docker and the aliquot-sandbox image)
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import { createPayloadStore, loadEvents, oneKey, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { createSandbox } from "../packages/core/src/sandbox.ts";
import { executeQuery, sameAnswer, tableReader, type QueryRecord, type Table } from "../packages/core/src/tables.ts";
import type { Sha256 } from "../packages/core/src/hash.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { findDocker } from "../test/sandbox-docker.ts";
import { lab0Dosing, startFakeRedcap } from "./fake-redcap.ts";
import { ensurePostgres, post, processes, waitFor } from "./procs.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".walk-data");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const DATA = join(root, "fixtures/lab0/data");

const docker = await findDocker();
if (typeof docker === "string") {
  console.error(`walk:data needs the sandbox: ${docker}`);
  process.exit(1);
}

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_walk_data");
const token = randomBytes(16).toString("hex");
const redcap = await startFakeRedcap(await lab0Dosing(token));
const model = await startFakeModel("hosted-2", "data");

const ENROLLED = "How many participants are in the dosing study?";
const QUESTIONS = [
  { user: "member-1", text: "How many participants finished visit 3?", query: { table: "visits", where: [{ column: "visit3_done", op: "eq", value: 1 }], measures: [{ fn: "count" }] } },
  { user: "member-1", text: "What was the mean dose in cohort B?", query: { table: "visits", where: [{ column: "cohort", op: "eq", value: "B" }], measures: [{ fn: "mean", column: "dose_mg" }] } },
  { user: "member-1", text: ENROLLED, query: { table: "dosing", measures: [{ fn: "count" }] } },
  { user: "member-2", text: ENROLLED, query: { table: "dosing", measures: [{ fn: "count" }] } },
  { user: "member-2", text: "What is the mean weight in each arm of the dosing study?", query: { table: "dosing", groupBy: ["arm"], measures: [{ fn: "count" }, { fn: "mean", column: "weight_kg" }] } },
  { user: "member-1", text: "List the birth dates of cohort C.", query: { table: "visits", where: [{ column: "cohort", op: "eq", value: "C" }], groupBy: ["dob"], measures: [{ fn: "count" }] }, refusal: /column dob of table visits is restricted/ },
  { user: "member-2", text: "How many dosing participants have a consent date?", query: { table: "dosing", measures: [{ fn: "count", column: "consent_date" }] }, refusal: /de-identified REDCap export rights leave out/ },
  { user: "member-3", text: "How many participants are enrolled in dosing?", query: { table: "dosing", measures: [{ fn: "count" }] }, refusal: /maps no REDCap user for the member who asked/ },
] as const;
model.queries = Object.fromEntries(QUESTIONS.map((q) => [q.text, q.query]));
const REDCAP_USERS = { "member-1": "rlee", "member-2": "kpatel" };

const payloadKey = randomBytes(32).toString("hex");
const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: payloadKey, LAB0_REDCAP_TOKEN: token };
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, keyring: oneKey(Buffer.from(payloadKey, "hex")) });

const baseAgent = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
const agentPath = join(work, "agent-data.json");
writeFileSync(
  agentPath,
  JSON.stringify({
    ...baseAgent,
    agentId: "lab0-data",
    name: "Lab0 data",
    instructions: "You answer lab members' questions about the lab's studies with data_query. Report the numbers it returns, and say so when it refuses.",
    knowledgeBases: [],
    tools: [{ name: "data_query" }],
    tables: ["visits", "dosing"],
    ceiling: "D1",
    model: { endpointId: "hosted", modelId: "hosted-2", params: { temperature: 0, maxOutputTokens: 256 } },
  }),
);
const columns = (c: Record<string, string>) => Object.entries(c).map(([k, v]) => `${k} = "${v}"`);
const VISIT_COLUMNS = { participant_id: "restricted", initials: "restricted", dob: "restricted", cohort: "free", site: "free", visit3_done: "free", dose_mg: "free", sleep_hours: "free" };
const DOSING_COLUMNS = { record_id: "restricted", arm: "free", weight_kg: "free", ae_grade: "free", consent_date: "free" };
const cfg = join(work, "lab.toml");
writeFileSync(
  cfg,
  [
    "[endpoints.hosted]",
    `base_url = "${model.url}"`,
    'placement = "zdr"',
    "[surfaces.web]",
    'placement = "lab"',
    "port = 0",
    "[hosts]",
    '"127.0.0.1" = "lab"',
    "[sandbox]",
    `image = "${docker.image}"`,
    `socket = "${docker.socket}"`,
    "timeout_ms = 20000",
    "[tables.visits]",
    'description = "lab0 visit log, one row per participant"',
    `csv = "${join(DATA, "visits.csv")}"`,
    'aggregate_class = "D1"',
    "[tables.visits.columns]",
    ...columns(VISIT_COLUMNS),
    "[tables.dosing]",
    'description = "lab0 dosing study in REDCap"',
    `redcap_url = "${redcap.url}"`,
    'redcap_token_env = "LAB0_REDCAP_TOKEN"',
    'aggregate_class = "D1"',
    "[tables.dosing.columns]",
    ...columns(DOSING_COLUMNS),
    "[tables.dosing.redcap_users]",
    ...columns(REDCAP_USERS),
    "[agents]",
    `fixtures = ["${agentPath}"]`,
    "",
  ].join("\n"),
);

const ps = processes(root, work, env);
const short = (h: string) => h.slice(0, 12);
let failed = false;
try {
  const web = await ps.startWeb(cfg);
  ps.startWorker(cfg, "W1");
  console.log(`walk:data: lab0 with a visits CSV and a REDCap dosing project (${redcap.url}), an agent on a hosted model (zdr), sandbox ${short(docker.image.slice(7))}\n`);
  const records: QueryRecord[] = [];
  for (const [i, q] of QUESTIONS.entries()) {
    const sent = await post(web.base, "/message", { thread: `t-data-${i}`, message: `m-data-${i}`, text: q.text, user: q.user });
    assert.equal(sent.status, 202, JSON.stringify(sent.json));
    const runId = sent.json.runId as RunId;
    const events = await waitFor(`run ${i}`, async () => {
      const es = await loadEvents(db, runId);
      return es.some((e) => e.event.t === "run.finished") ? es : null;
    }, 30_000);
    const ev = (t: StoredEvent["event"]["t"]) => events.map((e) => e.event).find((e) => e.t === t);
    const finished = ev("run.finished");
    assert.ok(finished?.t === "run.finished");
    console.log(`${q.user}: ${q.text}`);
    const done = ev("tool.completed");
    const failedCall = ev("tool.failed");
    if (!("refusal" in q)) {
      assert.ok(done?.t === "tool.completed", `${q.user} asked "${q.text}" and data_query did not complete`);
      const body = await store.get(done.output);
      assert.ok(!("redacted" in body));
      const rec = body.value as QueryRecord;
      records.push(rec);
      const numbers = rec.groups.map((g) => `${Object.entries(g.key).map(([k, v]) => `${k}=${v} `).join("")}${Object.entries(g.values).map(([k, v]) => `${k} ${v}`).join(", ")}`).join("; ");
      console.log(`aliquot: ${numbers}  (${finished.outcome})`);
      console.log(`  record: run ${short(runId)}, data_query on ${rec.table} (${rec.source.kind}, source ${short(rec.source.sha256)}, ${rec.source.bytes} bytes), engine ${short(rec.engine.sha256)}`);
      console.log(`          query ${JSON.stringify(rec.query)}`);
      if (rec.rights) console.log(`          rights: ${q.user} as REDCap user ${rec.rights.redcapUser}, DAG ${rec.rights.dag ?? "none (every record)"}, export ${Object.entries(rec.rights.forms).map(([f, l]) => `${f} ${l}`).join(", ")}`);
      console.log(`          ${rec.rowsRead} rows read, ${rec.rowsMatched} matched, min cell ${rec.minCell}, answer class ${done.output.cls}\n`);
    } else {
      assert.ok(failedCall?.t === "tool.failed");
      const detail = failedCall.failure.detail ? await store.get(failedCall.failure.detail) : null;
      const why = detail && !("redacted" in detail) ? String(detail.value) : "";
      assert.match(why, q.refusal);
      console.log(`aliquot: refused. ${why}  (${finished.outcome})`);
      console.log(`  record: run ${short(runId)}, data_query refused before the table was read, 0 rows left the sandbox\n`);
    }
  }
  assert.equal(records.length, 5);

  const sandbox = createSandbox({ image: docker.image, digest: docker.image.slice(7) as Sha256, cpus: 1, memoryMb: 1024, timeoutMs: 20_000, socket: docker.socket });
  const tables: Table[] = [
    { id: "visits", description: "", source: { kind: "csv", path: join(DATA, "visits.csv") }, columns: VISIT_COLUMNS as Table["columns"], aggregateClass: "D1", minCell: 5 },
    { id: "dosing", description: "", source: { kind: "redcap", url: redcap.url, tokenEnv: "LAB0_REDCAP_TOKEN", users: REDCAP_USERS }, columns: DOSING_COLUMNS as Table["columns"], aggregateClass: "D1", minCell: 5 },
  ];
  const read = tableReader({ post: (url, form) => fetch(url, { method: "POST", body: new URLSearchParams(form) }), secret: (name) => env[name] });
  for (const rec of records) {
    const deps = { read, sandbox: { image: docker.image.slice(7) as Sha256, aggregate: sandbox.aggregate }, signal: new AbortController().signal, member: rec.rights?.member ?? null, today: new Date().toISOString().slice(0, 10) };
    const again = await executeQuery(tables.find((t) => t.id === rec.table)!, rec.query, deps);
    const same = sameAnswer(rec, again);
    assert.ok(same.same, same.why ?? "");
    console.log(`rerun ${rec.table}${rec.rights ? ` as ${rec.rights.member}` : ""}: same numbers from source ${short(again.source.sha256)} and engine ${short(again.engine.sha256)}`);
  }

  const answers = JSON.parse(readFileSync(join(DATA, "answers.json"), "utf8")) as Record<string, number>;
  assert.equal(records[0]!.groups[0]!.values["count(*)"], answers.visit3_done_count);
  assert.equal(records[1]!.groups[0]!.values["mean(dose_mg)"], answers.cohort_b_mean_dose);
  assert.deepEqual([records[2]!.groups[0]!.values["count(*)"], records[3]!.groups[0]!.values["count(*)"]], [answers.dag_madison_n, answers.redcap_rows]);
  assert.deepEqual(records[4]!.groups.map((g) => g.values["mean(weight_kg)"]), [answers.arm1_mean_weight, answers.arm2_mean_weight]);
  console.log("\nground truth (fixtures/lab0/data/answers.json): all five numbers match");
  console.log(`same question, two members: member-1 (REDCap rlee, DAG madison) counted ${answers.dag_madison_n} records, member-2 (REDCap kpatel, no DAG) counted ${answers.redcap_rows}`);

  const rows = (file: string, cols: readonly number[]) => readFileSync(join(DATA, file), "utf8").split("\n").slice(1).flatMap((l) => cols.map((c) => l.split(",")[c] ?? "")).filter(Boolean);
  const dosingHeader = readFileSync(join(DATA, "redcap-dosing-records.csv"), "utf8").split("\n")[0]!.split(",");
  const identifying = [...rows("visits.csv", [0, 1, 2]), ...rows("redcap-dosing-records.csv", ["first_name", "last_name", "mrn"].map((f) => dosingHeader.indexOf(f)))];
  const wire = JSON.stringify(model.bodies);
  assert.deepEqual(identifying.filter((v) => wire.includes(v)), []);
  console.log(`on the wire: ${model.bodies.length} requests reached the hosted model; none holds any of ${identifying.length} identifying values from the two sources`);
} catch (err) {
  failed = true;
  console.error(`walk:data FAILED: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await ps.stopAll();
  await model.close();
  await redcap.close();
  await db.end();
}
process.exit(failed ? 1 : 0);
