import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listingOf, LOOP_CONTRACT, parseAgentDocument, resolveAgent, versionHash, type Catalog, type Deployed, type MemberId } from "../packages/core/src/agent.ts";
import type { CardCore } from "../packages/core/src/card.ts";
import { parseConfig } from "../packages/core/src/config.ts";
import { DEFAULT_POLICY, Labelled, type DataClass } from "../packages/core/src/dataclass.ts";
import type { Surface } from "../packages/core/src/frontdoor.ts";
import { createGateway } from "../packages/core/src/gateway.ts";
import { createKbReader, memorySnapshots, snapshotFromFixture } from "../packages/core/src/kb.ts";
import { drive, type LoopDeps } from "../packages/core/src/loop.ts";
import { loadVersion } from "../packages/core/src/publish.ts";
import { createQueue } from "../packages/core/src/queue.ts";
import { createPayloadStore, oneKey, openJournal, type PayloadRef, type RunEvent, type RunId, type ThreadKey } from "../packages/core/src/record.ts";
import { loadAudit } from "../packages/core/src/audit.ts";
import { audit, exportBundle, ExportRefused, reexecute, type BundleIndex } from "../packages/core/src/replay.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { createStudy, freeze, unfreeze } from "../packages/core/src/study.ts";
import { builtinTools, createHttpEgress, createToolRunner, registryOf } from "../packages/core/src/tools.ts";
import { freshDatabase } from "./db.ts";
import { startFakeModel } from "./fake-model.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { db, url } = await freshDatabase("labh_test_replay");
const KEY = randomBytes(32).toString("hex");
const model = await startFakeModel("scripted-1", "search-then-answer");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "labh-replay-")));
after(async () => {
  await model.close();
  await db.end();
  rmSync(scratch, { recursive: true, force: true });
});

const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, keyring: oneKey(Buffer.from(KEY, "hex")) });
const loaded = snapshotFromFixture(JSON.parse(readFileSync(join(root, "fixtures/kb.json"), "utf8")), store.address);
const registry = registryOf(builtinTools());
const catalog: Catalog = {
  latestSkill: () => undefined,
  latestSnapshot: (kbId) => (kbId === "handbook" ? { id: loaded.snapshot.id, cls: loaded.snapshot.cls } : undefined),
  tool: (name) => {
    const t = registry.get(name);
    return t ? { hash: t.hash, reads: t.manifest.reads, effects: t.manifest.effects } : undefined;
  },
  endpoint: (id) => (id === "local" ? { placement: "lab" } : undefined),
  sandboxImage: () => undefined,
  dataset: () => undefined,
};
const parsed = parseAgentDocument(JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")));
assert.ok(parsed.ok);
const resolved = resolveAgent(parsed.doc, catalog);
assert.ok(resolved.ok);
const agent = resolved.agent;
const hash = versionHash(agent);
await db.query("insert into agent_versions (hash, agent_id, body) values ($1, $2, $3)", [hash, agent.agentId, JSON.stringify(agent)]);

const config = parseConfig(["[database]", 'url_env = "DATABASE_URL"', "[endpoints.local]", `base_url = "${model.url}"`, 'placement = "lab"', "[surfaces.web]", 'placement = "lab"'].join("\n"), "lab.toml");
const core: CardCore = { db, store, config, registry, fixtureSnapshots: [loaded], agents: [parsed.doc] };
const deployed: Deployed = { tools: registry.deployed(), snapshots: new Set([loaded.snapshot.id]), sandboxImages: new Set(), loopContract: LOOP_CONTRACT, retrieval: new Set(["bm25-v1"]) };
const kb = createKbReader(memorySnapshots([loaded]));
const surface: Surface = {
  id: "web" as Surface["id"],
  placement: "lab",
  startStream: async () => ({ push() {}, close: async () => false }),
  finalize: async () => ({ mode: "final-post", messageId: "1" }),
  askConfirm: async () => {},
  linkTo: () => "http://localhost/run",
};
const deps: LoopDeps = {
  gateway: createGateway([{ id: "local", baseUrl: model.url, placement: "lab", supportsLogprobs: false }], DEFAULT_POLICY, fetch),
  tools: createToolRunner(registry, { http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl: fetch }), kb }),
  kb,
  surfaces: () => surface,
  policy: DEFAULT_POLICY,
  loadAgent: (h) => loadVersion(db, h),
  deployed: async () => deployed,
  clock: { now: () => Date.now() },
  callSignal: () => ({ signal: new AbortController().signal, release() {} }),
  log: () => {},
};
const queue = createQueue(db);

/** One real run: queued, claimed, journaled to Postgres and driven against the fake model. */
async function recordRun(question: string, cls: DataClass, key: string): Promise<{ readonly runId: RunId; readonly input: PayloadRef }> {
  const input = await store.put(Labelled.stamp(question, cls, "gate:floor"));
  const thread = `web:lab:${key}` as ThreadKey;
  await queue.enqueue({ kind: "run", key }, thread, { agent: hash, kind: "interactive", trigger: { t: "message", surface: "web", messageId: key, memberId: "member-1" }, thread, surface: "web", threadId: key, input, history: [], studyId: "sleep-2026" });
  const job = await queue.claim("replay-test", ["run"], 60_000);
  assert.ok(job);
  const journal = await openJournal(db, store, { runId: job.id as RunId, epoch: job.epoch, owner: "replay-test" });
  assert.deepEqual(await drive(job, journal, deps), { t: "finished", outcome: "answered" });
  return { runId: job.id as RunId, input };
}

const pi = "pia" as MemberId;
await createStudy(db, { id: "sleep-2026", title: "Sleep diary study", owner: pi, dataFloor: "D1" });
await freeze(db, "sleep-2026", hash, pi, "pre-registered version", { listing: listingOf(parsed.doc), deployed });
await unfreeze(db, "sleep-2026", agent.agentId, pi, "the model endpoint moved mid-study");

const QUESTION = "What are the office hours?";
const SECRET = "Participant P-4417 asked when the office hours are";
const open = await recordRun(QUESTION, "D1", "m1");
const restricted = await recordRun(SECRET, "D3", "m2");

const bundle = join(scratch, "study-d1");
const index: BundleIndex = await exportBundle(core, { study: "sleep-2026" }, { clearance: "D1", out: bundle });

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [join(dir, n)]));
const lines = (runId: RunId) => readFileSync(join(bundle, "events", `${runId}.jsonl`), "utf8").trim().split("\n");
const eventAt = (runId: RunId, seq: number) => (JSON.parse(lines(runId)[seq]!) as { event: RunEvent }).event;

test("a study export holds both runs, the deviation, and every body at or below D1; the D3 run's bodies are only a hash and a class", async () => {
  assert.deepEqual(index.runs.map((r) => r.runId), [open.runId, restricted.runId]);
  assert.deepEqual(index.study?.deviations.map((d) => [d.agentId, d.by, d.reason]), [["handbook", "pia", "the model endpoint moved mid-study"]]);
  assert.deepEqual(index.agents, [{ hash, body: { t: "included" } }]);
  assert.deepEqual(index.snapshots, [{ id: loaded.snapshot.id, cls: "D1", manifest: { t: "included" }, entries: 4 }]);
  assert.deepEqual(JSON.parse(readFileSync(join(bundle, "payloads", `${open.input.hash}.json`), "utf8")), { cls: "D1", body: QUESTION });

  assert.deepEqual(
    index.payloads.find((p) => p.hash === restricted.input.hash),
    { hash: restricted.input.hash, cls: "D3", bytes: restricted.input.bytes, disclosure: { t: "withheld", refusal: { code: "above-clearance", payload: "D3", clearance: "D1" }, why: "D3 exceeds the reviewer clearance D1" }, sha256: null },
  );
  assert.equal(existsSync(join(bundle, "payloads", `${restricted.input.hash}.json`)), false);
  const leaks = filesUnder(bundle).filter((f) => readFileSync(f, "utf8").includes("P-4417"));
  assert.deepEqual(leaks, [], "the D3 question is in no file of a D1 bundle");
  await assert.rejects(exportBundle(core, { runs: [open.runId] }, { clearance: "D1", out: bundle }), ExportRefused);
  const exported = (await loadAudit(db)).filter((r) => r.event.t === "export.created").map((r) => [r.actor.replace(/os user .*/, "os user"), r.event]);
  assert.deepEqual(exported, [["os user", { t: "export.created", bundleId: index.id, scope: { study: "sleep-2026" }, clearance: "D1", runs: 2 }]]);
});

test("from the bundle alone, every chain verifies and the audit view shows the tool call, the entries retrieved and the answer", async () => {
  const view = await audit(bundle);
  assert.deepEqual(view.runs.map((r) => r.chain.firstBad), [null, null]);
  const [first, second] = view.runs;
  assert.deepEqual(first!.version, { hash, body: "verified", why: null, model: "scripted-1", endpoint: "local", placement: "lab", from: "agent" });
  assert.deepEqual(view.runs.map((r) => r.brokenBodies), [[], []]);
  assert.deepEqual(first!.toolCalls.map((c) => [c.tool, c.input]), [["kb_search", { t: "body", body: { query: QUESTION, k: 3 } }]]);
  assert.deepEqual(first!.toolCalls[0]!.retrieved[0]!.entries.map((e) => e.path), ["office-hours.md", "equipment.md", "onboarding.md"]);
  const answer = eventAt(open.runId, lines(open.runId).length - 1);
  assert.ok(answer.t === "run.finished" && answer.answer);
  assert.deepEqual(first!.answer, { t: "body", body: JSON.parse(readFileSync(join(bundle, "payloads", `${answer.answer.hash}.json`), "utf8")).body });
  assert.match(String(first!.answer?.t === "body" && first!.answer.body), /^Scripted answer from 1 search result\(s\): /);
  assert.deepEqual(second!.toolCalls.map((c) => c.input), [{ t: "withheld", cls: "D3", why: "D3 exceeds the reviewer clearance D1" }]);
  assert.deepEqual(second!.answer, { t: "withheld", cls: "D3", why: "D3 exceeds the reviewer clearance D1" });
});

test("tampering with one event line makes the audit report that seq as the break", async () => {
  const tampered = join(scratch, "tampered");
  cpSync(bundle, tampered, { recursive: true });
  const file = join(tampered, "events", `${open.runId}.jsonl`);
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { at: string });
  rows[3]!.at = "2020-01-01T00:00:00.000Z";
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const view = await audit(tampered);
  assert.deepEqual(view.runs.map((r) => r.chain.firstBad), [3, null]);
  assert.equal(view.runs[0]!.rows.length, 3, "only the verified events are shown");
});

test("replay checks what bundle.json says against the files: an edited body, a run naming another agent, a card for another version", async () => {
  const edited = join(scratch, "edited");
  cpSync(bundle, edited, { recursive: true });
  writeFileSync(join(edited, "payloads", `${open.input.hash}.json`), JSON.stringify({ cls: "D1", body: "What are the office hours on Sunday?" }));
  const indexFile = join(edited, "bundle.json");
  const raw = JSON.parse(readFileSync(indexFile, "utf8")) as { runs: { agent: string }[] };
  raw.runs[1]!.agent = "0".repeat(64);
  writeFileSync(indexFile, JSON.stringify(raw));
  const cardFile = join(edited, "cards", `${hash}.json`);
  writeFileSync(cardFile, JSON.stringify({ ...JSON.parse(readFileSync(cardFile, "utf8")), hash: "1".repeat(64), model: { endpointId: "elsewhere", modelId: "other-model", placement: "public", receivesUpTo: "D0", params: {} } }));

  const view = await audit(edited);
  assert.deepEqual(view.runs[0]!.brokenBodies, [open.input.hash]);
  assert.deepEqual(view.runs[1]!.chain.firstBad, 0, "the record's run.started names another agent than the index");
  assert.deepEqual(view.runs[0]!.version, { hash, body: "verified", why: null, model: "scripted-1", endpoint: "local", placement: null, from: "agent" });
  const plain = await cli(["replay", edited]);
  assert.equal(plain.code, 3);
  assert.match(plain.stdout, new RegExp(`BROKEN   body ${open.input.hash.slice(0, 12)}: the payload file does not hash to its sha256 in bundle.json`));
  const [first] = await reexecute(edited, { endpoint: model.url, endpointPlacement: "lab" });
  assert.deepEqual(first, { t: "skipped", original: open.runId, why: `payload ${open.input.hash.slice(0, 12)}: the payload file does not hash to its sha256 in bundle.json` });
});

test("prov.json names the run as an activity, the version as a SoftwareAgent, and the input used and the answer generated", () => {
  const prov = JSON.parse(readFileSync(join(bundle, "prov.json"), "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
  const activity = `labh:run-${open.runId}`;
  assert.equal(prov.activity![activity]!["labh:outcome"], "answered");
  const software = prov.agent![`labh:agent-${hash}`]!;
  assert.deepEqual([software["prov:type"], software["labh:versionHash"], software["labh:placement"]], [{ $: "prov:SoftwareAgent", type: "prov:QUALIFIED_NAME" }, hash, "lab"]);
  const answer = eventAt(open.runId, lines(open.runId).length - 1);
  assert.ok(answer.t === "run.finished" && answer.answer);
  const pairs = (kind: string) => Object.values(prov[kind]!).map((r) => [r["prov:activity"], r["prov:entity"]]);
  assert.ok(pairs("used").some(([a, e]) => a === activity && e === `labh:payload-${open.input.hash}`), "the run used its input");
  assert.ok(pairs("wasGeneratedBy").some(([a, e]) => a === activity && e === `labh:payload-${answer.answer!.hash}`), "the run generated its answer");
  const requested = lines(open.runId).map((l) => (JSON.parse(l) as { event: RunEvent }).event).find((e) => e.t === "tool.requested");
  assert.ok(requested?.t === "tool.requested");
  assert.deepEqual((prov.entity![`labh:payload-${requested.input.hash}`] as Record<string, unknown>)["labh:role"], ["tool-input"]);
  assert.deepEqual(prov.entity![`labh:payload-${restricted.input.hash}`], { "prov:type": { $: "labh:Payload", type: "prov:QUALIFIED_NAME" }, "labh:class": "D3", "labh:bytes": restricted.input.bytes, "labh:included": false, "labh:role": ["input"] });
});

test("re-execution with recorded tools reproduces the recorded tool sequence exactly, and skips the run whose bodies are above the clearance", async () => {
  model.script = "search-then-answer";
  const [first, second] = await reexecute(bundle, { endpoint: model.url, endpointPlacement: "lab" });
  assert.ok(first?.t === "replayed");
  assert.deepEqual(first.tools, { recorded: [["kb_search", { query: QUESTION, k: 3 }]], replay: [["kb_search", { query: QUESTION, k: 3 }]] });
  assert.deepEqual([first.agreement, first.divergence, first.outcome, first.unfinished], [{ exact: true, sameTools: true, sameAnswer: true, sameOutcome: true }, null, { recorded: "answered", replay: "answered" }, null]);
  assert.deepEqual(second, { t: "skipped", original: restricted.runId, why: "re-execution needs clearance D3, and this bundle is D1" });
});

test("re-execution takes the endpoint's placement from the operator: a D3 run is not sent to an endpoint placed public, whatever the card says", async () => {
  const d3 = join(scratch, "study-d3");
  await exportBundle(core, { runs: [restricted.runId] }, { clearance: "D3", out: d3 });
  assert.equal(JSON.parse(readFileSync(join(d3, "cards", `${hash}.json`), "utf8")).model.placement, "lab", "the card says lab");
  const before = model.bodies.length;
  const [refused] = await reexecute(d3, { endpoint: model.url });
  assert.deepEqual(refused, { t: "skipped", original: restricted.runId, why: `it would send D3 to the model, and an endpoint placed public receives up to D0; pass --endpoint-placement if ${model.url} runs somewhere that may receive D3` });
  assert.equal(model.bodies.length, before, "the endpoint received no request");
  const [lab] = await reexecute(d3, { endpoint: model.url, endpointPlacement: "lab" });
  assert.equal(lab?.t, "replayed");
  assert.ok(model.bodies.slice(before).some((b) => JSON.stringify(b).includes("P-4417")), "placed lab, the same run does send the D3 question");
});

test("a model that asks for a call the record does not have is reported at its first divergence", async () => {
  model.script = "search-read-answer";
  try {
    const [first] = await reexecute(bundle, { endpoint: model.url, endpointPlacement: "lab" });
    assert.ok(first?.t === "replayed");
    const read: readonly [string, unknown] = ["kb_read", { paths: ["office-hours.md", "equipment.md", "onboarding.md"] }];
    assert.deepEqual(first.divergence, { step: 2, asked: read, expected: "no further tool call" });
    assert.deepEqual(first.tools.replay, [["kb_search", { query: QUESTION, k: 3 }], read]);
    assert.deepEqual([first.agreement.exact, first.outcome.replay, first.unfinished], [false, null, "the model asked for a kb_read call the record does not have"]);
  } finally {
    model.script = "search-then-answer";
  }
});

const cli = (args: readonly string[], flags: readonly string[] = [], env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    // From a directory with no lab.toml and, unless a test passes them, no database variables, as a reviewer would run it.
    execFile(process.execPath, [...PERMISSION_FLAGS, ...flags, "--disable-warning=ExperimentalWarning", join(root, "packages/core/bin/aliquot.ts"), ...args], { cwd: scratch, env: { PATH: process.env.PATH ?? "", ...env } }, (err, stdout) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? null) : 0, stdout }),
    );
  });

test("aliquot replay verifies a bundle with no lab.toml or database, and --reexecute exits 0 on exact agreement and 4 on divergence", async () => {
  const single = join(scratch, "one-run");
  await exportBundle(core, { runs: [open.runId] }, { clearance: "D1", out: single });
  const plain = await cli(["replay", single]);
  assert.equal(plain.code, 0);
  assert.match(plain.stdout, /proves {3}the bundle is internally consistent, not that it is the lab's record/);
  assert.match(plain.stdout, new RegExp(`chain    verified: chain intact over ${lines(open.runId).length} events`));
  assert.match(plain.stdout, /tool 1 {3}kb_search \(spec [0-9a-f]{12}\) \{"k":3,"query":"What are the office hours\?"\}/);

  assert.equal((await cli(["replay", join(scratch, "tampered")])).code, 3);
  assert.equal((await cli(["replay", bundle, "--reexecute", "--endpoint", model.url, "--endpoint-placement", "lab"])).code, 5, "a skipped run is not agreement");
  const agreed = await cli(["replay", single, "--reexecute", "--endpoint", model.url, "--endpoint-placement", "lab"]);
  assert.equal(agreed.code, 0);
  assert.match(agreed.stdout, new RegExp(`replay   ${open.runId} as [0-9a-f-]{36}: agrees exactly`));
  model.script = "search-read-answer";
  try {
    const diverged = await cli(["replay", single, "--reexecute", "--endpoint", model.url, "--endpoint-placement", "lab"]);
    assert.equal(diverged.code, 4);
    assert.match(diverged.stdout, /DIVERGED at step 2: asked kb_read \{"paths":\["office-hours.md","equipment.md","onboarding.md"\]\}, the record has no further tool call/);
  } finally {
    model.script = "search-then-answer";
  }
});

test("aliquot export writes a bundle only where the permission flags allow, and the bundle it writes replays", async () => {
  const lab = join(scratch, "lab.toml");
  writeFileSync(lab, ["[database]", 'url_env = "DATABASE_URL"', "[store]", 'key_env = "LABH_PAYLOAD_KEY"', "[endpoints.local]", `base_url = "${model.url}"`, 'placement = "lab"', "[surfaces.web]", 'placement = "lab"', "[knowledge_bases]", `fixtures = ["${join(root, "fixtures/kb.json")}"]`].join("\n"));
  const out = join(scratch, "cli-bundle");
  const args = ["--config", lab, "export", "--runs", open.runId, "--clearance", "D1", "--out", out];
  const env = { DATABASE_URL: url, LABH_PAYLOAD_KEY: KEY };
  assert.equal((await cli(args, [], env)).code, 2, "no write permission, nothing written");
  assert.equal(existsSync(out), false);
  const wrote = await cli(args, [`--allow-fs-write=${out}/*`], env);
  assert.equal(wrote.code, 0);
  assert.match(wrote.stdout, /wrote .*cli-bundle: 1 runs, \d+ bodies included, 0 withheld at clearance D1/);
  assert.equal((await cli(["replay", out, "--reexecute", "--endpoint", model.url, "--endpoint-placement", "lab"])).code, 0);
});
