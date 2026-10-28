#!/usr/bin/env node
/**
 * pnpm unit3: the definition of done for P1 unit 3 (KB compile and retrieval
 * tools) against real Postgres, worker, web and kb processes, a scripted
 * compiler, a counting hosted endpoint and, last, one smoke compile on Ollama.
 *
 *   node scripts/unit3.ts [--skip-ollama]
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadAudit, verifyAudit } from "../packages/core/src/audit.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import type { SnapshotId } from "../packages/core/src/hash.ts";
import { diffSnapshots, estimateTokens, loadManifest, storedSnapshots, type KbEntry } from "../packages/core/src/kb.ts";
import { createPayloadStore, loadEvents, verifyChain, type PayloadRef, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { startFakeModel, type FakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { checker, ensurePostgres, post, processes, waitFor, waitLine } from "./procs.ts";

const { values: flags } = parseArgs({ options: { "skip-ollama": { type: "boolean", default: false } } });

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".unit3");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const kbDir = join(work, "kb");
cpSync(join(root, "fixtures/kb-lab"), kbDir, { recursive: true });

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_unit3");

const compiler = await startFakeModel("scripted-1", "compile");
const hosted = await startFakeModel("hosted-2", "compile");
const agentModel = await startFakeModel("scripted-1", "search-read-answer");
const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434/v1";

// The onboarding note is a URL source, served the way a lab wiki page would be. lab.toml lists 127.0.0.1 as a lab host; localhost is unlisted, so public.
let wikiRequests = 0;
const wiki = createServer((req, res) => {
  wikiRequests += 1;
  if (req.url !== "/onboarding-note.md") return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
  res.end(readFileSync(join(kbDir, "onboarding-note.md"), "utf8"));
});
wiki.listen(0, "127.0.0.1");
await once(wiki, "listening");
const wikiPort = (wiki.address() as { port: number }).port;
const wikiUrl = `http://127.0.0.1:${wikiPort}/onboarding-note.md`;

const payloadKey = randomBytes(32).toString("hex");
const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: payloadKey };
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: Buffer.from(payloadKey, "hex"), keyId: "k1" });

const READ_CAP = 60;
const baseAgent = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
const agentPath = join(work, "agent.json");
writeFileSync(
  agentPath,
  JSON.stringify({
    ...baseAgent,
    agentId: "lab-handbook",
    instructions: "You answer lab members' practical questions from the lab handbook. Call kb_search, then kb_read the best paths, and answer from those entries only.",
    knowledgeBases: ["lab-handbook"],
    readCapTokens: READ_CAP,
    model: { endpointId: "agentlab", modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 256 } },
  }),
);
const cfg = join(work, "lab.toml");
const endpoints = { local: compiler.url, hosted: hosted.url, agentlab: agentModel.url, ollama: ollamaUrl };
const placements: Record<string, string> = { local: "lab", hosted: "zdr", agentlab: "lab", ollama: "lab" };
writeFileSync(
  cfg,
  [
    "[database]",
    'url_env = "DATABASE_URL"',
    "[store]",
    'placement = "lab"',
    'key_env = "LABH_PAYLOAD_KEY"',
    ...Object.entries(endpoints).flatMap(([id, url]) => [`[endpoints.${id}]`, `base_url = "${url}"`, `placement = "${placements[id]}"`]),
    "[hosts]",
    '"127.0.0.1" = "lab"',
    "[surfaces.web]",
    'placement = "lab"',
    "port = 0",
    "[policy]",
    'review_confidential = "refuse"',
    "participant_id_patterns = ['\\bP-\\d{5}\\b']",
    "[agents]",
    `fixtures = ["${agentPath}"]`,
    "",
  ].join("\n"),
);

/** Writes a definition next to the copied sources: the fixture with the onboarding note as a URL and any edits. */
function definition(name: string, edit: (d: Record<string, unknown>) => void = () => {}, url = wikiUrl): string {
  const d = JSON.parse(readFileSync(join(kbDir, "kb.json"), "utf8")) as { sources: { sourceId: string; kind: string; location: string }[] } & Record<string, unknown>;
  const onboarding = d.sources.find((s) => s.sourceId === "onboarding")!;
  onboarding.kind = "url";
  onboarding.location = url;
  edit(d);
  const path = join(kbDir, `${name}.json`);
  writeFileSync(path, JSON.stringify(d, null, 2));
  return path;
}
const GAP = "What is the parking reimbursement rate for visitors?";
const dropGap = (d: Record<string, unknown>) => (d.coverageQuestions = (d.coverageQuestions as string[]).filter((q) => q !== GAP));

const ps = processes(root, work, childEnv);
const { check, results } = checker(ps);
let kbRuns = 0;

/** One kb command as its own process. */
async function kb(args: string[]): Promise<{ code: number | null; out: string }> {
  const proc = ps.start(`kb-${kbRuns++}`, "kb.ts", ["--config", cfg, ...args]);
  const exit = await proc.exit;
  // procs.ts merges stderr into out; drop node's own warning lines (node 26 flags --allow-net as experimental).
  // Only that one warning and its trace hint are dropped; any other warning stays visible to the checks.
  const lines = proc.out.join("").split("\n");
  const out = lines.filter((l, i) => !/^\(node:\d+\) ExperimentalWarning: The flag --allow-net/.test(l)
    && !(/^\(Use `node --trace-warnings/.test(l) && /ExperimentalWarning: The flag --allow-net/.test(lines[i - 1] ?? ""))).join("\n");
  return { code: exit.code, out: out.trim() };
}

type CompileOut = { jobId: string; result: { t: "compiled"; snapshot: SnapshotId; gaps: string[] } | { t: "failed"; reason: string; refusal: unknown } | null };
async function compile(defPath: string, timeoutMs = 60_000): Promise<CompileOut> {
  const r = await kb(["compile", "--definition", defPath, "--wait", "--timeout-ms", String(timeoutMs)]);
  return lastJson<CompileOut>(r.out);
}

/** The last JSON line a kb command printed, so a stray warning line (node's --allow-net notice) cannot fail a check. */
function lastJson<T>(out: string): T {
  const line = out.split("\n").findLast((l) => l.startsWith("{") || l.startsWith("["));
  assert.ok(line, `kb printed no JSON: ${out}`);
  return JSON.parse(line) as T;
}

/** What a fake compiler was asked, from its request bodies: a source id per compile call, a question per coverage call. */
function compilerCalls(fake: FakeModel, from = 0): { sources: string[]; coverage: string[] } {
  const out = { sources: [] as string[], coverage: [] as string[] };
  for (const body of fake.bodies.slice(from) as { messages: { role: string; content: string }[] }[]) {
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages.find((m) => m.role === "user")?.content ?? "";
    if (system.startsWith("You compile")) out.sources.push(/Source id: (\S+)/.exec(user)?.[1] ?? "?");
    else out.coverage.push(/Question: (.*)/.exec(user)?.[1] ?? "?");
  }
  return out;
}

const count = (xs: readonly string[]) => Object.fromEntries([...new Set(xs)].sort().map((x) => [x, xs.filter((y) => y === x).length]));

let published: SnapshotId | null = null;
let gapped: SnapshotId | null = null;
let unpublished: SnapshotId | null = null;

try {
  await check("check 1: compile a synthetic lab KB; coverage names the unanswerable question and blocks publish", async () => {
    ps.startWorker(cfg, "C1");
    const v1 = await compile(definition("kb-v1"));
    assert.equal(v1.result?.t, "compiled", JSON.stringify(v1));
    if (v1.result?.t !== "compiled") throw new Error("unreachable");
    assert.deepEqual(v1.result.gaps, [GAP]);
    const calls = compilerCalls(compiler);
    assert.deepEqual(count(calls.sources), { codebook: 1, onboarding: 1, sop: 1 });
    assert.equal(calls.coverage.length, 6);
    const s = (await loadManifest(db, store.address, v1.result.snapshot))!;
    gapped = s.id;
    assert.equal(s.cls, "D2", "the join of D1, D2 and D1 sources");
    assert.equal(s.sources.find((x) => x.sourceId === "onboarding")?.location, wikiUrl);
    assert.ok(Object.keys(s.entries).includes("onboarding/who-to-ask.md"), "the URL source was compiled");
    const loaded = (await storedSnapshots(db, store).load(s.id))!;
    assert.ok(loaded.entries.every((e) => e.facts.length > 0 && e.facts.every((f) => f.sources.length === 1)), "every entry has facts, each with its source");
    const report = await kb(["coverage", "--snapshot", s.id]);
    console.log(report.out.replace(/^/gm, "    "));
    assert.match(report.out, new RegExp(`  GAP  ${GAP.replace(/\?/g, "\\?")}`));
    const refused = await kb(["publish", "--snapshot", s.id]);
    assert.equal(refused.code, 1);
    assert.deepEqual(JSON.parse(refused.out), { ok: false, gaps: [GAP] });

    const before = compiler.requests;
    const v2 = await compile(definition("kb-v2", dropGap));
    assert.equal(v2.result?.t, "compiled", JSON.stringify(v2));
    if (v2.result?.t !== "compiled") throw new Error("unreachable");
    assert.equal(compiler.requests, before, "v2 reuses every cached source result and verdict");
    const ok = await kb(["publish", "--snapshot", v2.result.snapshot]);
    assert.deepEqual(JSON.parse(ok.out), { ok: true });
    published = v2.result.snapshot;
    return `v1 ${s.id.slice(0, 12)} (${Object.keys(s.entries).length} entries, ${s.cls}) from 3 compiler calls + 6 judgments, gap "${GAP}", publish refused; v2 without that question: 0 new calls, published ${published.slice(0, 12)}`;
  });

  await check("check 2: a D3 source aimed at a hosted compiler is refused, with zero hosted requests, in the audit stream", async () => {
    ps.startWorker(cfg, "C2");
    const out = await compile(join(kbDir, "kb-restricted.json"));
    assert.deepEqual(out.result, { t: "failed", reason: "snapshot class D3 refused by egress", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } });
    assert.equal(hosted.requests, 0, "the hosted compiler received nothing");
    const audit = await loadAudit(db);
    assert.equal(verifyAudit(audit), null);
    const mine = audit.filter((r) => (r.event.t === "call" ? ("job" in r.event.context ? r.event.context.job : null) : "job" in r.event ? r.event.job : null) === out.jobId);
    assert.deepEqual(
      mine.map((r) => r.event),
      [
        { t: "call", context: { t: "kb-compile", job: out.jobId, kbId: "visit-log", step: { t: "source", sourceId: "visits" } }, event: { t: "egress.refused", destination: "model:hosted", payload: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } } },
        { t: "kb.compile-failed", job: out.jobId, kbId: "visit-log", reason: "snapshot class D3 refused by egress", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } },
      ],
    );
    const snapshots = await db.query("select 1 from kb_snapshots where kb_id = 'visit-log'");
    assert.equal(snapshots.rowCount, 0);
    return `audit seq ${mine.map((r) => r.seq).join(", ")}: egress.refused model:hosted D3 > D1, then kb.compile-failed; hosted requests 0; audit chain verified over ${audit.length} rows`;
  });

  await check("check 3: SIGKILL mid-compile; the restarted worker recompiles only unfinished sources", async () => {
    const def = definition("kb-kill", (d) => ((d.compiler as { modelId: string }).modelId = "scripted-kill-1"));
    const from = compiler.bodies.length;
    compiler.delayMs = 700;
    try {
      const k1 = ps.startWorker(cfg, "K1", ["--lease-ms", "1500"]);
      const enqueued = await kb(["compile", "--definition", def]);
      const { jobId } = JSON.parse(enqueued.out) as { jobId: string };
      await waitLine(k1, /source sop compiled/, 20_000);
      await waitFor("the codebook call in flight", async () => (compilerCalls(compiler, from).sources.includes("codebook") ? true : null), 5_000);
      k1.child.kill("SIGKILL");
      const exit = await k1.exit;
      assert.equal(exit.signal, "SIGKILL");
      const beforeRestart = compilerCalls(compiler, from);
      assert.deepEqual(beforeRestart.sources, ["sop", "codebook"], "sop finished, codebook was in flight");
      const restartFrom = compiler.bodies.length;
      const k2 = ps.startWorker(cfg, "K2", ["--lease-ms", "1500"]);
      const result = await waitFor("the compile to end", async () => {
        const r = await db.query<{ event: { t: string; snapshot?: string } }>("select event from audit_events where event->>'job' = $1 and event->>'t' = 'kb.compiled'", [jobId]);
        return r.rows[0]?.event ?? null;
      }, 30_000);
      await waitLine(k2, /source sop cached/, 1_000);
      const afterRestart = compilerCalls(compiler, restartFrom);
      assert.deepEqual(afterRestart.sources, ["codebook", "onboarding"], "only the unfinished sources were compiled again");
      assert.equal(afterRestart.coverage.length, 6);
      const total = compilerCalls(compiler, from);
      assert.deepEqual(count(total.sources), { codebook: 2, onboarding: 1, sop: 1 });
      return `K1 killed with sop cached and codebook in flight; K2 compiled [${afterRestart.sources.join(", ")}] + ${afterRestart.coverage.length} judgments, sop from cache; per-source calls over both workers ${JSON.stringify(count(total.sources))}; snapshot ${String(result.snapshot).slice(0, 12)}`;
    } finally {
      compiler.delayMs = 0;
    }
  });

  await check("check 4: an agent run with the KB attached: outline in the prompt, kb_search then kb_read journaled, cap enforced, hits stable across processes", async () => {
    assert.ok(published, "check 1 published a snapshot");
    const web = await ps.startWeb(cfg);
    ps.startWorker(cfg, "W4");
    const question = "How long are intake samples kept in the freezer?";
    const sent = await post(web.base, "/message", { thread: "t4", message: "m4", text: question, user: "alice" });
    assert.equal(sent.status, 202, JSON.stringify(sent.json));
    const runId = sent.json.runId as RunId;
    const events = await waitFor("run.finished", async () => {
      const es = await loadEvents(db, runId);
      return es.some((e) => e.event.t === "run.finished") ? es : null;
    }, 20_000);
    assert.equal(verifyChain(events), null);
    const finished = events.find((e) => e.event.t === "run.finished")!.event;
    assert.ok(finished.t === "run.finished" && finished.outcome === "answered", JSON.stringify(finished));

    const body = async (ref: PayloadRef) => {
      const b = await store.get(ref);
      assert.ok(!("redacted" in b));
      return b.value;
    };
    const requested = events.find((e) => e.event.t === "model.requested")!.event as Extract<StoredEvent["event"], { t: "model.requested" }>;
    const prompt = (await body(requested.prompt)) as { parts: { role: string; content: string }[] };
    const system = prompt.parts[0]!.content;
    const snapshot = (await storedSnapshots(db, store).load(published!))!;
    assert.match(system, /Knowledge base "Lab handbook" \(id lab-handbook\): How the lab handles samples/);
    for (const path of Object.keys(snapshot.snapshot.entries)) assert.ok(system.includes(`\n- ${path}`), `outline lists ${path}`);
    assert.match(system, /If they do not contain the answer, say that you could not find it/);
    assert.equal(requested.prompt.cls, "D2", "the outline makes every call as sensitive as the KB");

    const tools = events.filter((e) => e.event.t === "tool.requested").map((e) => (e.event.t === "tool.requested" ? e.event.tool : ""));
    assert.deepEqual(tools, ["kb_search", "kb_read"]);
    const completed = events.filter((e) => e.event.t === "tool.completed").map((e) => e.event as Extract<StoredEvent["event"], { t: "tool.completed" }>);
    const [search, read] = completed;
    assert.ok(search && read);
    const hits = (await body(search.output)) as { results: { path: string; score: number }[] };
    const hashOf = (path: string) => snapshot.snapshot.entries[path];
    assert.deepEqual(search.retrieved, [{ snapshot: published, entries: hits.results.map((h) => hashOf(h.path)), truncated: false }], "every search hit is journaled");
    const readOut = (await body(read.output)) as { entries: KbEntry[]; omitted: string[]; note: string };
    assert.deepEqual(read.retrieved, [{ snapshot: published, entries: readOut.entries.map((e) => hashOf(e.path)), truncated: true }], "every entry read is journaled, and the cut is recorded");
    assert.deepEqual([...readOut.entries.map((e) => e.path), ...readOut.omitted], hits.results.map((h) => h.path), "the read asked for every hit");
    const used = readOut.entries.reduce((n, e) => n + estimateTokens(e), 0);
    assert.ok(readOut.entries.length >= 1 && used <= READ_CAP, `read ${used} estimated tokens under a cap of ${READ_CAP}`);
    assert.ok(readOut.omitted.length >= 1);

    const runs = await Promise.all([1, 2].map(() => kb(["search", "--snapshot", published!, "--query", question, "--k", "3"])));
    const cli = JSON.parse(runs[0]!.out) as { path: string; score: number }[];
    assert.deepEqual(JSON.parse(runs[1]!.out), cli, "two processes, same hits");
    assert.deepEqual(cli.map((h) => [h.path, h.score]), hits.results.map((h) => [h.path, h.score]), "and the same hits the run journaled");
    return `prompt ${requested.prompt.cls} lists all ${Object.keys(snapshot.snapshot.entries).length} paths; kb_search journaled ${hits.results.length} hashes, kb_read returned ${readOut.entries.length} entry (${used} est. tokens, cap ${READ_CAP}) and omitted ${readOut.omitted.length}, truncated recorded; two kb search processes: ${cli.map((h) => `${h.path} ${h.score}`).join(", ")}`;
  });

  await check("check 5: the snapshot diff after editing one source shows exactly that change", async () => {
    assert.ok(published, "check 1 published a snapshot");
    ps.startWorker(cfg, "W5");
    const sop = join(kbDir, "sop-sample-intake.md");
    writeFileSync(sop, readFileSync(sop, "utf8").replace("for at most 24 months", "for at most 36 months"));
    const from = compiler.bodies.length;
    const v3 = await compile(definition("kb-v3", dropGap));
    assert.equal(v3.result?.t, "compiled", JSON.stringify(v3));
    if (v3.result?.t !== "compiled") throw new Error("unreachable");
    unpublished = v3.result.snapshot;
    const calls = compilerCalls(compiler, from);
    const judged = (compiler.bodies.slice(from) as { messages: { role: string; content: string }[] }[]).map((b) => b.messages.find((m) => m.role === "user")?.content ?? "").filter((u) => u.startsWith("Question: "));
    assert.ok(judged.length > 0 && judged.every((u) => u.includes('<entry path="sop/storage.md">')), "only verdicts whose candidates include the changed entry were judged again");
    const [a, b] = await Promise.all([loadManifest(db, store.address, published!), loadManifest(db, store.address, v3.result.snapshot)]);
    const d = diffSnapshots(a!, b!);
    assert.deepEqual({ added: d.added, removed: d.removed, changed: d.changed, sources: d.sources }, { added: [], removed: [], changed: ["sop/storage.md"], sources: [{ sourceId: "sop", change: "changed" }] });
    const text = (await kb(["diff", "--from", published!, "--to", v3.result.snapshot])).out;
    console.log(text.replace(/^/gm, "    "));
    assert.equal(
      text,
      [
        `kb lab-handbook: ${published!.slice(0, 12)} -> ${v3.result.snapshot.slice(0, 12)}`,
        "source sop: changed",
        "~ sop/storage.md",
        "    - Intake samples are kept in the minus 80 freezer in room 214 for at most 24 months.",
        "    + Intake samples are kept in the minus 80 freezer in room 214 for at most 36 months.",
        "    - fact: Intake samples are kept in the minus 80 freezer in room 214 for at most 24 months. [sop ## Storage]",
        "    + fact: Intake samples are kept in the minus 80 freezer in room 214 for at most 36 months. [sop ## Storage]",
      ].join("\n"),
    );
    return `one edited line in the SOP -> 1 changed entry, 0 added, 0 removed; recompile cost ${calls.sources.length} source call (${calls.sources.join(", ")}) and ${calls.coverage.length} coverage judgments, one per question whose candidates included the changed entry`;
  });

  await check("check 6: a URL source goes out only through the HTTP choke point; an unlisted host is refused before any request", async () => {
    const before = wikiRequests;
    const auditBefore = (await loadAudit(db)).length;
    const r = await kb(["compile", "--definition", definition("kb-public-url", dropGap, `http://localhost:${wikiPort}/onboarding-note.md`)]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /egress refused/);
    assert.equal(wikiRequests, before, "the unlisted host received nothing");
    const added = (await loadAudit(db)).slice(auditBefore);
    const refusal = { code: "class-above-ceiling", payload: "D1", ceiling: "D0" };
    assert.deepEqual(added.map((row) => row.event), [{ t: "call", context: { t: "kb-source", kbId: "lab-handbook", sourceId: "onboarding" }, event: { t: "egress.refused", destination: "http:localhost", payload: "D1", refusal } }]);
    const jobs = await db.query("select 1 from jobs where kind = 'kb-compile' and payload::text like '%localhost%'");
    assert.equal(jobs.rowCount, 0, "no compile job was queued");
    return `definition text (D1) to an unlisted host (public, ceiling D0): refused, 0 requests at the wiki, audit seq ${added[0]!.seq} egress.refused http:localhost, no job; the same page via 127.0.0.1 (listed lab) was read in checks 1, 3 and 5`;
  });

  await check("check 7: a KB mixing D1 and D3 sources on a hosted compiler is refused whole, with zero hosted requests", async () => {
    ps.startWorker(cfg, "C7");
    const before = hosted.requests;
    const def = definition("kb-mixed", (d) => {
      dropGap(d);
      (d.sources as unknown[]).push({ sourceId: "visits", kind: "file", location: "visit-log.md", cls: "D3", licence: "internal-only" });
      d.compiler = { endpointId: "hosted", modelId: "hosted-2" };
    });
    const out = await compile(def);
    const refusal = { code: "class-above-ceiling", payload: "D3", ceiling: "D1" };
    assert.deepEqual(out.result, { t: "failed", reason: "snapshot class D3 refused by egress", refusal });
    assert.equal(hosted.requests - before, 0, "not even the D1 sources reached the hosted compiler");
    const mine = (await loadAudit(db)).filter((r) => (r.event.t === "call" ? ("job" in r.event.context ? r.event.context.job : null) : "job" in r.event ? r.event.job : null) === out.jobId);
    assert.deepEqual(mine.map((r) => (r.event.t === "call" ? `call ${r.event.event.t} ${r.event.event.t === "egress.refused" ? r.event.event.payload : ""}` : r.event.t)), ["call egress.refused D3", "kb.compile-failed"]);
    return `D1 sop, D2 codebook, D1 onboarding and D3 visits on zdr: snapshot class D3 computed first, the first call refused at D3 > D1, compile failed; hosted requests 0; audit seq ${mine.map((r) => r.seq).join(", ")}`;
  });

  await check("check 8: a publisher overrides a coverage gap with a note; the note is in the audit stream, on the snapshot and in the coverage report", async () => {
    assert.ok(gapped, "check 1 compiled a snapshot with a gap");
    const note = "Parking is out of scope for this handbook; visitors ask the front desk.";
    const anonymous = await kb(["publish", "--snapshot", gapped!, "--override-gaps", note]);
    assert.equal(anonymous.code, 1);
    assert.match(anonymous.out, /--override-gaps needs --actor naming the publisher/);
    const blank = await kb(["publish", "--snapshot", gapped!, "--override-gaps", " ", "--actor", "pi-1"]);
    assert.equal(blank.code, 1);
    assert.match(blank.out, /a coverage override needs a note/);
    const auditBefore = (await loadAudit(db)).length;
    const ok = await kb(["publish", "--snapshot", gapped!, "--override-gaps", note, "--actor", "pi-1"]);
    assert.equal(ok.code, 0, ok.out);
    assert.deepEqual(JSON.parse(ok.out), { ok: true, overridden: [GAP] });
    const added = (await loadAudit(db)).slice(auditBefore);
    assert.deepEqual(added.map((r) => [r.actor, r.event]), [["pi-1", { t: "kb.published", kbId: "lab-handbook", snapshot: gapped, override: { note, gaps: [GAP] } }]]);
    const row = await db.query<{ publisher: string; note: string; audit_seq: string }>("select publisher, note, audit_seq from kb_coverage_overrides where snapshot = $1", [gapped]);
    assert.deepEqual(row.rows.map((r) => [r.publisher, r.note, Number(r.audit_seq)]), [["pi-1", note, added[0]!.seq]]);
    const head = await db.query<{ snapshot: string }>("select snapshot from kb_heads where kb_id = 'lab-handbook'");
    assert.equal(head.rows[0]?.snapshot, gapped);
    const report = await kb(["coverage", "--snapshot", gapped!]);
    console.log(report.out.replace(/^/gm, "    "));
    assert.match(report.out, new RegExp(`  GAP  ${GAP.replace(/\?/g, "\\?")}\n  OVERRIDE by pi-1 at \\S+: ${note}`));
    return `no --actor and a blank note both refused; with both, published ${gapped!.slice(0, 12)} over 1 gap, audit seq ${added[0]!.seq} kb.published by pi-1 with the note, kb_coverage_overrides row pointing at that seq, coverage report shows OVERRIDE under the GAP`;
  });

  await check("check 9: a publish while web and worker run reaches the next message's run", async () => {
    assert.ok(unpublished, "check 5 compiled a snapshot it did not publish");
    const web = await ps.startWeb(cfg);
    ps.startWorker(cfg, "W9");
    const head = async () => (await db.query<{ snapshot: SnapshotId }>("select snapshot from kb_heads where kb_id = 'lab-handbook'")).rows[0]!.snapshot;
    /** The snapshot a run's agent version pins and the snapshot its kb_search touched. */
    const ask = async (thread: string) => {
      const sent = await post(web.base, "/message", { thread, message: `${thread}-m`, text: "How long are intake samples kept in the freezer?", user: "alice" });
      assert.equal(sent.status, 202, JSON.stringify(sent.json));
      const runId = sent.json.runId as RunId;
      const events = await waitFor("run.finished", async () => {
        const es = await loadEvents(db, runId);
        return es.some((e) => e.event.t === "run.finished") ? es : null;
      }, 20_000);
      const started = events.find((e) => e.event.t === "run.started")!.event;
      assert.ok(started.t === "run.started");
      const version = await db.query<{ body: { knowledgeBases: { snapshot: SnapshotId }[] } }>("select body from agent_versions where hash = $1", [started.agent]);
      const searched = events.find((e) => e.event.t === "tool.completed")!.event;
      assert.ok(searched.t === "tool.completed");
      return { pinned: version.rows[0]!.body.knowledgeBases[0]!.snapshot, searched: searched.retrieved![0]!.snapshot };
    };
    const before = await head();
    const first = await ask("t9a");
    assert.deepEqual(first, { pinned: before, searched: before });
    const published = await kb(["publish", "--snapshot", unpublished!]);
    assert.deepEqual(JSON.parse(published.out), { ok: true });
    assert.equal(await head(), unpublished);
    const second = await ask("t9b");
    assert.deepEqual(second, { pinned: unpublished, searched: unpublished }, "the run after the publish uses the new snapshot");
    return `web and worker up; run 1 pinned and searched ${before.slice(0, 12)}; published ${unpublished!.slice(0, 12)} from a separate kb process; the next message's run pinned and searched ${unpublished!.slice(0, 12)}, no restart`;
  });

  if (flags["skip-ollama"]) {
    console.log("SKIP smoke: compile on ollama (--skip-ollama)");
  } else {
    await check("smoke: compile the lab KB on Ollama qwen3:8b", async () => {
      ps.startWorker(cfg, "S1", ["--lease-ms", "10000"]);
      const out = await compile(
        definition("kb-ollama", (d) => (d.compiler = { endpointId: "ollama", modelId: "qwen3:8b", params: { temperature: 0, maxOutputTokens: 8192, seed: 7 } })),
        1_200_000,
      );
      assert.equal(out.result?.t, "compiled", JSON.stringify(out));
      if (out.result?.t !== "compiled") throw new Error("unreachable");
      const s = (await loadManifest(db, store.address, out.result.snapshot))!;
      const report = await kb(["coverage", "--snapshot", s.id]);
      console.log(report.out.replace(/^/gm, "    "));
      const paths = Object.keys(s.entries);
      assert.equal(s.compiler?.target.modelId, "qwen3:8b");
      assert.ok(paths.length >= 3, `entries: ${paths.join(", ")}`);
      const loaded = (await storedSnapshots(db, store).load(s.id))!;
      const cited = new Set(loaded.entries.flatMap((e) => e.facts.flatMap((f) => f.sources.map((x) => x.sourceId))));
      assert.deepEqual([...cited].sort(), ["codebook", "onboarding", "sop"], "facts cite every source");
      assert.ok(out.result.gaps.includes(GAP), `gaps: ${JSON.stringify(out.result.gaps)}`);
      return `${paths.length} entries (${paths.join(", ")}), facts cite all 3 sources, gaps ${JSON.stringify(out.result.gaps)}`;
    });
  }
} finally {
  await ps.stopAll();
  await compiler.close();
  await hosted.close();
  await agentModel.close();
  wiki.close();
  await db.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
