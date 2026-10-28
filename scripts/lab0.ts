#!/usr/bin/env node
/**
 * pnpm lab0: the first-use check for one lab job. A lab member asks a
 * question and gets an answer from the lab's own documents, and restricted
 * data never reaches a hosted model. Synthetic lab (fixtures/lab0), real
 * Postgres, web, worker and kb processes, scripted fakes pinned in advance:
 * the compiler fake passes each "## " section through as one entry, the agent
 * fake calls kb_search once with the member's question verbatim and then
 * answers, and the hosted fake only counts requests. The fakes do not think,
 * so this checks orchestration, retrieval, provenance and egress control, not
 * answer quality.
 *
 * The expected entry per question and the pass rules are in
 * fixtures/lab0/questions.json, written before the first run, and the
 * protective checks added after two static reviews, still before any run,
 * are in fixtures/lab0/prereg-v2.json. Neither changes the other.
 *
 *   node scripts/lab0.ts
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAudit } from "../packages/core/src/audit.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import type { SnapshotId } from "../packages/core/src/hash.ts";
import { loadManifest, tokenize, type KbSnapshot } from "../packages/core/src/kb.ts";
import { createPayloadStore, loadEvents, verifyChain, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { checker, ensurePostgres, post, processes, waitFor } from "./procs.ts";

interface Prereg {
  readonly inDocument: readonly { readonly id: string; readonly question: string; readonly expected: string }[];
  readonly outsideDocuments: readonly { readonly id: string; readonly question: string }[];
  readonly restricted: { readonly pattern: string; readonly message: string; readonly control: string };
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".lab0");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const kbDir = join(work, "kb");
cpSync(join(root, "fixtures/lab0"), kbDir, { recursive: true });
const prereg = JSON.parse(readFileSync(join(kbDir, "questions.json"), "utf8")) as Prereg;
const v2 = JSON.parse(readFileSync(join(kbDir, "prereg-v2.json"), "utf8")) as { counts: { inDocument: number; outsideDocuments: number; runsA: number; runsB: number; runsC: number } };
const DOCUMENTS = ["sop-freezer.md", "codebook-sleep-diary.md", "onboarding-ra.md"];

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_lab0");

const compiler = await startFakeModel("scripted-1", "compile");
const agentModel = await startFakeModel("scripted-1", "search-then-answer");
const hosted = await startFakeModel("hosted-2", "answer");

const payloadKey = randomBytes(32).toString("hex");
const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: payloadKey };
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: Buffer.from(payloadKey, "hex"), keyId: "k1" });

const baseAgent = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
function agentFile(name: string, overrides: Record<string, unknown>): string {
  const path = join(work, `agent-${name}.json`);
  writeFileSync(path, JSON.stringify({ ...baseAgent, ...overrides }, null, 2));
  return path;
}
function config(name: string, agentPath: string): string {
  const endpoints = { local: [compiler.url, "lab"], agentlab: [agentModel.url, "lab"], hosted: [hosted.url, "zdr"] };
  const lines = [
    "[database]",
    'url_env = "DATABASE_URL"',
    "[store]",
    'placement = "lab"',
    'key_env = "LABH_PAYLOAD_KEY"',
    ...Object.entries(endpoints).flatMap(([id, [url, placement]]) => [`[endpoints.${id}]`, `base_url = "${url}"`, `placement = "${placement}"`]),
    "[surfaces.web]",
    'placement = "lab"',
    "port = 0",
    "[policy]",
    'review_confidential = "refuse"',
    `participant_id_patterns = ['${prereg.restricted.pattern}']`,
    "[agents]",
    `fixtures = ["${agentPath}"]`,
    "",
  ];
  const path = join(work, `lab-${name}.toml`);
  writeFileSync(path, lines.join("\n"));
  return path;
}
const cfgHandbook = config(
  "handbook",
  agentFile("handbook", {
    agentId: "lab0-handbook",
    name: "Lab0 handbook",
    instructions: "You answer lab members' practical questions from the lab0 handbook. Call kb_search with the member's question and answer from those entries only.",
    knowledgeBases: ["lab0-handbook"],
    model: { endpointId: "agentlab", modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 256 } },
  }),
);
// An agent whose model is the hosted endpoint, so a restricted message has somewhere to leak to.
const cfgHosted = config(
  "hosted",
  agentFile("hosted", {
    agentId: "lab0-hosted",
    name: "Lab0 hosted helper",
    instructions: "You answer short questions.",
    knowledgeBases: [],
    tools: [],
    ceiling: "D1",
    model: { endpointId: "hosted", modelId: "hosted-2", params: { temperature: 0, maxOutputTokens: 256 } },
  }),
);
// The same hosted model with the D3 roster KB attached (prereg-v2 F): whatever layer refuses, nothing may reach it.
const cfgHostedKb = config(
  "hosted-kb",
  agentFile("hosted-kb", {
    agentId: "lab0-hosted-kb",
    name: "Lab0 hosted roster helper",
    instructions: "You answer the study coordinator's questions from the roster. Call kb_search first.",
    knowledgeBases: ["lab0-roster"],
    // Ceiling D1 and a named protocol, so the only rule that can refuse this agent is the KB class above its ceiling.
    ceiling: "D1",
    irbProtocol: "lab0-protocol",
    model: { endpointId: "hosted", modelId: "hosted-2", params: { temperature: 0, maxOutputTokens: 256 } },
  }),
);

const ps = processes(root, work, childEnv);
const { check, results } = checker(ps, { counter: () => hosted.requests });
let kbRuns = 0;

async function kb(args: string[]): Promise<{ code: number | null; out: string }> {
  const proc = ps.start(`kb-${kbRuns++}`, "kb.ts", ["--config", cfgHandbook, ...args]);
  const exit = await proc.exit;
  return { code: exit.code, out: proc.out.join("").trim() };
}

type CompileOut = { jobId: string; result: { t: "compiled"; snapshot: SnapshotId; gaps: string[] } | { t: "failed"; reason: string; refusal: unknown } | null };
/** The last JSON line a kb command printed, so a stray warning line cannot fail a check. */
function lastJson<T>(out: string): T {
  const line = out.split("\n").findLast((l) => l.startsWith("{"));
  assert.ok(line, `kb printed no JSON: ${out}`);
  return JSON.parse(line) as T;
}
async function compile(defPath: string): Promise<CompileOut> {
  return lastJson<CompileOut>((await kb(["compile", "--definition", defPath, "--wait", "--timeout-ms", "60000"])).out);
}

const head = async () => (await db.query<{ snapshot: SnapshotId }>("select snapshot from kb_heads where kb_id = 'lab0-handbook'")).rows[0]?.snapshot ?? null;

/** Every run this script started, for check D. */
const runs: { readonly label: string; readonly cfg: string; readonly runId: RunId }[] = [];
let messages = 0;

async function ask(base: string, cfg: string, label: string, text: string): Promise<StoredEvent[]> {
  const n = messages++;
  const sent = await post(base, "/message", { thread: `t-${label}-${n}`, message: `m-${label}-${n}`, text, user: "member-1" });
  assert.equal(sent.status, 202, JSON.stringify(sent.json));
  const runId = sent.json.runId as RunId;
  runs.push({ label, cfg, runId });
  return waitFor(`run.finished for ${label}`, async () => {
    const es = await loadEvents(db, runId);
    return es.some((e) => e.event.t === "run.finished") ? es : null;
  }, 20_000);
}

const finishedOf = (events: StoredEvent[]) => {
  const f = events.find((e) => e.event.t === "run.finished")?.event;
  assert.ok(f && f.t === "run.finished");
  return f;
};
const searchesOf = (events: StoredEvent[]) =>
  events.flatMap((e) => (e.event.t === "tool.completed" ? (e.event.retrieved ?? []) : []));
async function answerText(events: StoredEvent[]): Promise<string> {
  const f = finishedOf(events);
  if (!f.answer) return "";
  const body = await store.get(f.answer);
  return "redacted" in body ? "" : String(body.value);
}

let published: KbSnapshot | null = null;
const tally: Record<string, unknown> = {};

try {
  await check("precondition: the pre-registered counts hold, and no out-of-document question shares a bm25 token with the documents", async () => {
    assert.equal(prereg.inDocument.length, v2.counts.inDocument);
    assert.equal(prereg.outsideDocuments.length, v2.counts.outsideDocuments);
    const docTokens = new Set(DOCUMENTS.flatMap((f) => tokenize(readFileSync(join(kbDir, f), "utf8"))));
    const shared = prereg.outsideDocuments.map((o) => ({ id: o.id, shared: tokenize(o.question).filter((t) => docTokens.has(t)) })).filter((o) => o.shared.length);
    assert.deepEqual(shared, []);
    return `${prereg.outsideDocuments.length} questions, 0 shared tokens with ${DOCUMENTS.length} documents (${docTokens.size} distinct tokens)`;
  });

  await check("check 1: a steward compiles the lab KB with the kb command and publishes it", async () => {
    ps.startWorker(cfgHandbook, "C1");
    const out = await compile(join(kbDir, "kb.json"));
    assert.equal(out.result?.t, "compiled", JSON.stringify(out));
    if (out.result?.t !== "compiled") throw new Error("unreachable");
    assert.deepEqual(out.result.gaps, []);
    const ok = await kb(["publish", "--snapshot", out.result.snapshot]);
    assert.deepEqual(lastJson(ok.out), { ok: true });
    published = (await loadManifest(db, store.address, out.result.snapshot))!;
    assert.equal(await head(), published.id);
    const missing = prereg.inDocument.filter((q) => !(q.expected in published!.entries)).map((q) => `${q.id} ${q.expected}`);
    assert.deepEqual(missing, [], "every pre-registered path is an entry");
    return `snapshot ${published.id.slice(0, 12)} (${Object.keys(published.entries).length} entries, ${published.cls}), 0 gaps over ${published.coverage.length} coverage questions, published`;
  });

  await check("check A: 20 member questions through the web door each cite their pre-registered entry", async () => {
    assert.ok(published, "check 1 published a snapshot");
    const web = await ps.startWeb(cfgHandbook);
    ps.startWorker(cfgHandbook, "WA");
    const rows: { id: string; ok: boolean; why: string; rank: number }[] = [];
    for (const q of prereg.inDocument) {
      const events = await ask(web.base, cfgHandbook, q.id, q.question);
      const f = finishedOf(events);
      const want = published!.entries[q.expected]!;
      const retrieved = searchesOf(events).flatMap((r) => r.entries);
      const answer = await answerText(events);
      const why = [f.outcome !== "answered" ? `outcome ${f.outcome}` : "", retrieved.includes(want) ? "" : "expected entry not retrieved", answer.includes(q.expected) ? "" : "answer does not name the path"].filter(Boolean).join("; ");
      // Reported, not a threshold (prereg-v2 A_rank_report): 1 is the top hit, 0 is not retrieved.
      rows.push({ id: q.id, ok: !why, why, rank: retrieved.indexOf(want) + 1 });
    }
    tally.A = rows;
    const rank1 = rows.filter((r) => r.rank === 1).length;
    const misses = rows.filter((r) => !r.ok);
    assert.deepEqual(misses, [], `${rows.length - misses.length}/${rows.length} cited; expected entry ranked first in ${rank1}/${rows.length}`);
    return `${rows.length}/${rows.length} answered, retrieved and named the pre-registered entry; ranked first in ${rank1}/${rows.length}`;
  });

  await check("check B: questions outside the documents get the coverage-gap behaviour", async () => {
    assert.ok(published, "check 1 published a snapshot");
    const web = await ps.startWeb(cfgHandbook);
    ps.startWorker(cfgHandbook, "WB");
    const asRuns: { id: string; tools: string[]; completed: number; failed: number; retrieved: number[]; outcome: string }[] = [];
    for (const o of prereg.outsideDocuments) {
      const events = await ask(web.base, cfgHandbook, o.id, o.question);
      asRuns.push({
        id: o.id,
        tools: events.flatMap((e) => (e.event.t === "tool.requested" ? [e.event.tool] : [])),
        completed: events.filter((e) => e.event.t === "tool.completed").length,
        failed: events.filter((e) => e.event.t === "tool.failed").length,
        retrieved: searchesOf(events).map((r) => r.entries.length),
        outcome: finishedOf(events).outcome,
      });
    }
    tally.B_runs = asRuns;
    // The search has to have run and come back empty; a failed search with no tool.completed would otherwise look like "nothing retrieved".
    const notEmpty = asRuns.filter((r) => r.tools.join() !== "kb_search" || r.completed !== 1 || r.failed !== 0 || r.retrieved.join() !== "0" || r.outcome !== "answered");
    assert.deepEqual(notEmpty, [], "each out-of-document run made one kb_search that completed with no entry");

    const def = JSON.parse(readFileSync(join(kbDir, "kb.json"), "utf8")) as { coverageQuestions: string[] };
    const outside = prereg.outsideDocuments.map((o) => o.question);
    def.coverageQuestions = [...def.coverageQuestions, ...outside];
    const gapsDef = join(kbDir, "kb-gaps.json");
    writeFileSync(gapsDef, JSON.stringify(def, null, 2));
    const from = compiler.bodies.length;
    const out = await compile(gapsDef);
    assert.equal(out.result?.t, "compiled", JSON.stringify(out));
    if (out.result?.t !== "compiled") throw new Error("unreachable");
    assert.deepEqual([...out.result.gaps].sort(), [...outside].sort());
    const asked = (compiler.bodies.slice(from) as { messages: { content: string }[] }[]).filter((b) => outside.some((q) => b.messages.some((m) => (m.content ?? "").includes(q))));
    assert.equal(asked.length, 0, "no compiler request mentions an out-of-document question");
    const refused = await kb(["publish", "--snapshot", out.result.snapshot]);
    assert.equal(refused.code, 1);
    const body = lastJson<{ ok: boolean; gaps: string[] }>(refused.out);
    assert.deepEqual({ ok: body.ok, gaps: [...body.gaps].sort() }, { ok: false, gaps: [...outside].sort() });
    assert.equal(await head(), published!.id, "the published head did not move");
    return `as runs: ${asRuns.length}/${asRuns.length} retrieved 0 entries; as coverage questions: ${out.result.gaps.length} gaps, 0 compiler requests about them, publish refused naming them, head unchanged`;
  });

  await check("check C: the D3 roster and a message with a roster id never reach the hosted endpoint", async () => {
    const start = hosted.requests;
    ps.startWorker(cfgHandbook, "CC");
    const roster = await compile(join(kbDir, "kb-roster.json"));
    assert.equal(roster.result?.t, "failed", JSON.stringify(roster));
    if (roster.result?.t !== "failed") throw new Error("unreachable");
    assert.equal(roster.result.reason, "snapshot class D3 refused by egress");
    assert.deepEqual(roster.result.refusal, { code: "class-above-ceiling", payload: "D3", ceiling: "D1" });
    const audited = (await loadAudit(db)).filter(
      (r) => r.event.t === "call" && r.event.context.t === "kb-compile" && r.event.context.kbId === "lab0-roster" && r.event.event.t === "egress.refused",
    );
    assert.deepEqual(
      audited.map((r) => (r.event.t === "call" && r.event.event.t === "egress.refused" ? [r.event.event.destination, r.event.event.payload] : [])),
      [["model:hosted", "D3"]],
      "the refusal is in the audit stream, at the hosted model, at D3",
    );
    assert.equal(hosted.requests, start, "the roster compile sent nothing");
    await ps.stopAll();

    const web = await ps.startWeb(cfgHosted);
    ps.startWorker(cfgHosted, "WC");
    const events = await ask(web.base, cfgHosted, "C-roster-id", prereg.restricted.message);
    assert.equal(finishedOf(events).outcome, "refused");
    assert.equal(events.some((e) => e.event.t === "model.requested"), false, "no model.requested was journaled");
    assert.equal(hosted.requests, start, "the roster-id message sent nothing");
    const control = await ask(web.base, cfgHosted, "C-control", prereg.restricted.control);
    assert.equal(finishedOf(control).outcome, "answered");
    assert.equal(hosted.requests, start + 1, "a D1 message to the same endpoint does reach it");
    return `roster compile: ${roster.result.reason} (audit: egress.refused model:hosted D3); roster-id message: refused; hosted requests ${start} -> ${start} -> ${start + 1} (D1 control)`;
  });

  await check("check E: a declared class is a floor: a roster id in a D1 document or in the purpose keeps the KB off the hosted compiler", async () => {
    const start = hosted.requests;
    ps.startWorker(cfgHandbook, "CE");
    const outcomes: string[] = [];
    for (const def of ["kb-leak-doc.json", "kb-leak-purpose.json"]) {
      const out = await compile(join(kbDir, def));
      assert.equal(out.result?.t, "failed", `${def}: ${JSON.stringify(out)}`);
      if (out.result?.t !== "failed") throw new Error("unreachable");
      assert.equal(out.result.reason, "snapshot class D3 refused by egress", def);
      outcomes.push(`${def}: ${out.result.reason}`);
    }
    assert.equal(hosted.requests, start, "neither compile sent anything to the hosted endpoint");
    return `${outcomes.join("; ")}; hosted requests ${start} -> ${hosted.requests}`;
  });

  await check("check F: a D3 snapshot attached to a hosted agent never reaches the hosted endpoint", async () => {
    const start = hosted.requests;
    ps.startWorker(cfgHandbook, "CF");
    const out = await compile(join(kbDir, "kb-roster-local.json"));
    assert.equal(out.result?.t, "compiled", JSON.stringify(out));
    if (out.result?.t !== "compiled") throw new Error("unreachable");
    const snapshot = (await loadManifest(db, store.address, out.result.snapshot))!;
    assert.equal(snapshot.cls, "D3");
    const pub = out.result.gaps.length
      ? await kb(["publish", "--snapshot", snapshot.id, "--override-gaps", "lab0 check F: gaps are not under test here", "--actor", "steward-1"])
      : await kb(["publish", "--snapshot", snapshot.id]);
    assert.deepEqual(lastJson(pub.out), out.result.gaps.length ? { ok: true, overridden: out.result.gaps } : { ok: true });
    await ps.stopAll();

    const web = await ps.startWeb(cfgHostedKb);
    ps.startWorker(cfgHostedKb, "WF");
    const n = messages++;
    const sent = await post(web.base, "/message", { thread: `t-F-${n}`, message: `m-F-${n}`, text: "Which participants completed wave 1?", user: "member-1" });
    let outcome = `intake ${sent.status}`;
    if (sent.status !== 202) {
      assert.equal(sent.status, 403, JSON.stringify(sent.json));
      assert.match(String(sent.json.userFacing), /knowledge base lab0-roster is D3, above the agent ceiling D1/);
    } else {
      const runId = sent.json.runId as RunId;
      runs.push({ label: "F-roster-kb", cfg: cfgHostedKb, runId });
      const events = await waitFor("run.finished for F", async () => {
        const es = await loadEvents(db, runId);
        return es.some((e) => e.event.t === "run.finished") ? es : null;
      }, 20_000);
      outcome = finishedOf(events).outcome;
      assert.notEqual(outcome, "answered");
    }
    assert.equal(hosted.requests, start, "nothing reached the hosted endpoint");
    return `roster snapshot ${snapshot.id.slice(0, 12)} (D3) published${out.result.gaps.length ? ` over ${out.result.gaps.length} gaps with a note` : ""}; hosted agent with it attached: ${outcome}; hosted requests ${start} -> ${hosted.requests}`;
  });

  await check("check D: every run has a verified run record and an agent version hash", async () => {
    const byPrefix = (p: string) => runs.filter((r) => r.label.startsWith(p)).length;
    assert.deepEqual(
      { A: byPrefix("Q"), B: byPrefix("O"), C: byPrefix("C-") },
      { A: v2.counts.runsA, B: v2.counts.runsB, C: v2.counts.runsC },
      "every pre-registered run was started",
    );
    const bad: string[] = [];
    const hashes = new Map<string, Set<string>>();
    for (const r of runs) {
      const events = await loadEvents(db, r.runId);
      const started = events.find((e) => e.event.t === "run.started")?.event;
      const chain = verifyChain(events);
      if (!started || started.t !== "run.started") bad.push(`${r.label}: no run.started`);
      else {
        const hash = started.agent as string;
        const stored = (await db.query("select 1 from agent_versions where hash = $1", [hash])).rowCount ?? 0;
        if (!/^[0-9a-f]{64}$/.test(hash) || stored !== 1) bad.push(`${r.label}: version hash ${hash} not in agent_versions`);
        hashes.set(r.cfg, (hashes.get(r.cfg) ?? new Set()).add(hash));
      }
      if (!events.some((e) => e.event.t === "run.finished")) bad.push(`${r.label}: no run.finished`);
      if (chain !== null) bad.push(`${r.label}: chain ${JSON.stringify(chain)}`);
    }
    for (const [cfg, set] of hashes) if (set.size !== 1) bad.push(`${cfg}: ${set.size} version hashes for one agent and one published snapshot`);
    assert.deepEqual(bad, []);
    return `${runs.length} runs, every chain verified, ${hashes.size} agents with one version hash each`;
  });

  await check("total: the hosted endpoint saw exactly the one control request", async () => {
    assert.equal(hosted.requests, 1);
    return "hosted requests over the whole script: 1";
  });
} finally {
  await ps.stopAll();
  await compiler.close();
  await agentModel.close();
  await hosted.close();
  await db.end();
}

writeFileSync(join(work, "results.json"), JSON.stringify({ results, tally }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
