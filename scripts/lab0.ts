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
 * Check K, added with document sources, is not pre-registered: a Box sync folder and a fake Drive feed one KB with
 * scoped entries, and it checks change detection, the version in the record and scope at retrieval. Check K2, added
 * with the Graph source, is not pre-registered either: a fake SharePoint library, by delta, with an edit, a delete and
 * a folder shared with one group.
 *
 *   node scripts/lab0.ts
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAudit } from "../packages/core/src/audit.ts";
import { agentCardSchema } from "../packages/core/src/card.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import type { SnapshotId } from "../packages/core/src/hash.ts";
import { loadManifest, tokenize, type KbSnapshot } from "../packages/core/src/kb.ts";
import { createPayloadStore, oneKey, loadEvents, verifyChain, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { startFakeSlack } from "../test/fake-slack.ts";
import { APP_ID, APP_SECRET, startFakeTeams, TENANT } from "./fake-teams.ts";
import { freshDatabase } from "../test/db.ts";
import { checker, ensurePostgres, get, post, processes, runWithInput, waitFor, waitLine } from "./procs.ts";
import { askShared, publishRoutedAgents, SHARED, type Sent } from "./routed-lab.ts";
import { newAnchorKeyPem } from "../packages/core/src/anchor.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { GOOGLE_DOC, startFakeDrive } from "./fake-drive.ts";
import { DOCX, startFakeGraph } from "./fake-graph.ts";
import { freezerSop } from "../test/docx-fixture.ts";
import type { SourceStatus } from "../packages/core/src/record-view.ts";

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
const acpToken = randomBytes(32).toString("hex");
const mcpToken = randomBytes(32).toString("hex");
const personalToken = randomBytes(32).toString("hex");
const slackToken = randomBytes(32).toString("hex");
const teamsToken = randomBytes(32).toString("hex");
const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: payloadKey, LAB0_ACP_TOKEN: acpToken, LAB0_MCP_TOKEN: mcpToken, LAB0_PERSONAL_TOKEN: personalToken, LAB0_SLACK_TOKEN: slackToken, LAB0_TEAMS_TOKEN: teamsToken, LABH_ANCHOR_KEY_FILE: join(work, "anchor.key") };
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, keyring: oneKey(Buffer.from(payloadKey, "hex")) });

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
    // zdr shows D1 at most, and the handbook is D1, so check G's tokened ask still gets the cited answer.
    "[surfaces.acp]",
    'kind = "acp"',
    'placement = "zdr"',
    'token_env = "LAB0_ACP_TOKEN"',
    // Check H: an MCP client on an approved seat (zdr, D1) gets the answer; one on a personal subscription (public, D0) gets the link.
    "[surfaces.mcp]",
    'kind = "mcp"',
    'placement = "zdr"',
    'token_env = "LAB0_MCP_TOKEN"',
    "[surfaces.personal]",
    'kind = "mcp"',
    'placement = "public"',
    'token_env = "LAB0_PERSONAL_TOKEN"',
    // Check S: the Slack door at approved (D2), so the D1 handbook answer posts in the thread.
    "[surfaces.slack]",
    'kind = "slack"',
    'placement = "approved"',
    'token_env = "LAB0_SLACK_TOKEN"',
    // Check T: the Teams door at institution (D2), the university's own tenant, so the D1 handbook answer posts in the thread.
    "[surfaces.teams]",
    'kind = "teams"',
    'placement = "institution"',
    'token_env = "LAB0_TEAMS_TOKEN"',
    "[policy]",
    'review_confidential = "refuse"',
    `participant_id_patterns = ['${prereg.restricted.pattern}']`,
    "[agents]",
    `fixtures = ["${agentPath}"]`,
    // Synthetic rates, large enough that the scripted model's 15-token calls cost cents. hosted has none, so its calls print "no price".
    "[prices.agentlab]",
    "input_per_mtok = 2000",
    "output_per_mtok = 6000",
    'currency = "USD"',
    "effective = 2026-01-01",
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
    project: "lab0-grant",
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

  await check("check G: aliquot ask --json with the acp surface's token, the contract T3 Code and tmux use, gets the same cited answer and a record whose chain verifies", async () => {
    assert.ok(published, "check 1 published a snapshot");
    await ps.stopAll();
    const web = await ps.startWeb(cfgHandbook);
    ps.startWorker(cfgHandbook, "WG");
    const q = prereg.inDocument[0]!;
    const asker = processes(root, work, { PATH: childEnv.PATH!, HOME: childEnv.HOME!, ALIQUOT_SURFACE_TOKEN: acpToken });
    const cli = asker.start("ask-G", "aliquot.ts", ["ask", "--door", web.base, "--user", "member-1", "--json", q.question]);
    const { code } = await cli.exit;
    assert.equal(code, 0, cli.out.join(""));
    // out holds stderr too (Node's warnings); the events are the JSON lines.
    const events = cli.out.join("").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { t: string; runId: string; answer?: string; recordUrl: string });
    const finished = events.at(-1)!;
    assert.equal(finished.t, "finished");
    assert.ok(finished.answer?.includes(q.expected), `the answer does not name ${q.expected}: ${finished.answer}`);
    assert.equal(finished.recordUrl, `${web.base}/runs/${finished.runId}`);
    const recorded = await loadEvents(db, finished.runId as RunId);
    assert.equal(verifyChain(recorded), null);
    const surface = recorded[0]?.event.t === "run.started" ? recorded[0].event.surface : null;
    assert.equal(surface, "acp", "the door took the token for the acp surface");
    assert.ok(searchesOf(recorded).some((r) => r.entries.includes(published!.entries[q.expected]!)), "the run retrieved the pre-registered entry");
    await ps.stopAll();
    return `${events.map((e) => e.t).join(", ")}; surface ${surface}; answer names ${q.expected}; record ${finished.runId.slice(0, 8)} chain verified`;
  });

  await check("check H: aliquot mcp lists one tool, ask; through a zdr surface it returns the cited answer and the record link, through a public one the record link only", async () => {
    assert.ok(published, "check 1 published a snapshot");
    await ps.stopAll();
    const web = await ps.startWeb(cfgHandbook);
    ps.startWorker(cfgHandbook, "WH");
    const q = prereg.inDocument[0]!;
    /** One MCP session over stdio: initialize, tools/list, one ask; stdin closes and the server exits once the ask answers. */
    const session = async (token: string) => {
      const msgs = [
        { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lab0", version: "1" } } },
        { method: "notifications/initialized" },
        { id: 2, method: "tools/list", params: {} },
        { id: 3, method: "tools/call", params: { name: "ask", arguments: { question: q.question } } },
      ];
      const input = msgs.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n";
      const { code, stdout: out } = await runWithInput(root, "aliquot.ts", ["mcp", "--door", web.base, "--user", "member-1"], { PATH: childEnv.PATH!, HOME: childEnv.HOME!, ALIQUOT_SURFACE_TOKEN: token }, input);
      assert.equal(code, 0);
      const byId = new Map(out.trim().split("\n").map((l) => JSON.parse(l) as { id: number; result: any }).map((m) => [m.id, m.result]));
      return { tools: byId.get(2).tools.map((t: { name: string }) => t.name), call: byId.get(3) };
    };
    const seat = await session(mcpToken);
    assert.deepEqual(seat.tools, ["ask"]);
    const answered = seat.call.structuredContent;
    assert.ok(answered.answer?.includes(q.expected), `the answer does not name ${q.expected}: ${answered.answer}`);
    const runId = answered.recordUrl.split("/").at(-1);
    const recorded = await loadEvents(db, runId as RunId);
    assert.equal(verifyChain(recorded), null);
    assert.equal(recorded[0]?.event.t === "run.started" ? recorded[0].event.surface : null, "mcp");
    const personal = (await session(personalToken)).call;
    assert.equal(personal.structuredContent.withheld, true);
    assert.equal(personal.structuredContent.answer, null);
    assert.deepEqual(personal.content, [{ type: "text", text: `The answer is above what this client may keep. Read it in the record: ${personal.structuredContent.recordUrl}` }]);
    assert.ok(!JSON.stringify(personal).includes(q.expected), "nothing of the answer reaches the public surface's client");
    await ps.stopAll();
    return `tools [ask]; zdr surface: answer names ${q.expected}, record ${runId.slice(0, 8)} on surface mcp, chain verified; public surface: withheld, record link only`;
  });

  await check("check S: through a fake Slack API, a mention gets the cited answer in its thread with a record link that resolves, and a participant id is refused with zero hosted requests", async () => {
    assert.ok(published, "check 1 published a snapshot");
    await ps.stopAll();
    const slack = await startFakeSlack();
    const slackDoors = processes(root, work, { PATH: childEnv.PATH!, HOME: childEnv.HOME!, ALIQUOT_SURFACE_TOKEN: slackToken, SLACK_APP_TOKEN: "xapp-1-lab0", SLACK_BOT_TOKEN: "xoxb-lab0", ALIQUOT_SLACK_API: slack.api });
    try {
      const q = prereg.inDocument[0]!;
      const door = (base: string) => slackDoors.start("slack-S", "aliquot.ts", ["slack", "--door", base]);
      /** The edit of the "looking" message in the thread a mention at ts started. */
      const reply = async (ts: string) => {
        await slack.waitFor(`the reply in thread ${ts}`, () => slack.calls.some((c) => c.method === "chat.postMessage" && c.body.thread_ts === ts));
        const looking = slack.calls.findIndex((c) => c.method === "chat.postMessage" && c.body.thread_ts === ts);
        return slack.waitFor(`the answer in thread ${ts}`, () => slack.calls.slice(looking).find((c) => c.method === "chat.update")?.body.text as string | undefined, 30_000);
      };
      const runIn = (text: string) => /\/runs\/([0-9a-f-]{36})/.exec(text)?.[1] as RunId | undefined;

      let web = await ps.startWeb(cfgHandbook);
      ps.startWorker(cfgHandbook, "WS");
      door(web.base);
      await slack.connected();
      slack.deliver("S-1", { type: "app_mention", user: "U0MEMBER", text: `<@U0ALIQUOT> ${q.question}`, channel: "C0LAB", ts: "1730200000.000100" });
      const answered = await reply("1730200000.000100");
      assert.ok(answered.includes(q.expected), `the thread's answer does not name ${q.expected}: ${answered}`);
      assert.ok(slack.acks.includes("S-1"), "the envelope was acknowledged");
      const runId = runIn(answered);
      assert.ok(runId, `the answer carries a record link: ${answered}`);
      const recorded = await loadEvents(db, runId);
      assert.equal(verifyChain(recorded), null);
      assert.equal(recorded[0]?.event.t === "run.started" ? recorded[0].event.surface : null, "slack");
      const page = await get(`${web.base}/runs/${runId}`);
      assert.equal(page.status, 200);
      assert.ok(page.text.includes(runId), "the record page names the run");
      await slackDoors.stopAll();
      await ps.stopAll();

      const start = hosted.requests;
      web = await ps.startWeb(cfgHosted);
      ps.startWorker(cfgHosted, "WS2");
      door(web.base);
      await slack.connected();
      slack.deliver("S-2", { type: "app_mention", user: "U0MEMBER", text: `<@U0ALIQUOT> ${prereg.restricted.message}`, channel: "C0LAB", ts: "1730200000.000200" });
      const refused = await reply("1730200000.000200");
      const refusedRun = runIn(refused);
      assert.ok(refusedRun, `the refusal carries a record link: ${refused}`);
      const refusedEvents = await loadEvents(db, refusedRun);
      assert.equal(finishedOf(refusedEvents).outcome, "refused");
      assert.equal(refusedEvents.some((e) => e.event.t === "model.requested"), false, "no model.requested was journaled");
      assert.equal(hosted.requests, start, "the participant id sent nothing to the hosted endpoint");
      await slackDoors.stopAll();
      await ps.stopAll();
      return `answer in thread names ${q.expected}, record ${runId.slice(0, 8)} on surface slack, chain verified, record page 200; participant id: run ${refusedRun.slice(0, 8)} refused, hosted requests ${start} -> ${hosted.requests}; Slack saw: ${refused.split("\n")[0]}`;
    } finally {
      await slackDoors.stopAll();
      await slack.close();
    }
  });

  await check("check R: one shared channel, two published agents: the router sends each question to the agent it fits, asks the member when unsure, runs the pick, and keeps a follow-up with it", async () => {
    assert.ok(published, "check 1 published a snapshot");
    const start = hosted.requests;
    await ps.stopAll();
    ps.startWorker(cfgHandbook, "CR");
    const methodsKb = await compile(join(kbDir, "kb-methods.json"));
    assert.equal(methodsKb.result?.t, "compiled", JSON.stringify(methodsKb));
    if (methodsKb.result?.t !== "compiled") throw new Error("unreachable");
    assert.deepEqual(lastJson((await kb(["publish", "--snapshot", methodsKb.result.snapshot])).out), { ok: true });
    await publishRoutedAgents(root, cfgHandbook, childEnv, "agentlab", [`web:${SHARED}`]);
    const web = await ps.startWeb(cfgHandbook);
    const finished = (runId: string) => waitFor(`run.finished for ${runId}`, async () => {
      const es = await loadEvents(db, runId as RunId);
      return es.some((e) => e.event.t === "run.finished") ? es : null;
    }, 20_000);
    /** The run's answer and its run.started route, after checking that its chain verifies. */
    const settle = async (runId: string) => {
      const events = await finished(runId);
      assert.equal(verifyChain(events), null);
      const s = events[0]?.event;
      assert.ok(s?.t === "run.started");
      return { answer: await answerText(events), route: s.route };
    };
    const routedTo = (r: Sent, agentId: string, basis: string) => {
      assert.equal(r.status, 202, JSON.stringify(r.json));
      assert.ok(r.json.route?.t === "agent" && r.json.answeredBy?.agentId === agentId && r.json.route.basis === basis, JSON.stringify(r.json));
      return { runId: r.json.runId!, confidence: (r.json.route as { confidence: number }).confidence };
    };

    const q05 = prereg.inDocument.find((q) => q.id === "Q05")!;
    const handbook = routedTo(await askShared(web.base, "R-1", "R-1a", q05.question), "lab0-desk", "score");
    const handbookRun = await settle(handbook.runId);
    assert.ok(handbookRun.answer.includes(q05.expected), `the handbook answer does not name ${q05.expected}: ${handbookRun.answer}`);
    assert.ok(handbookRun.route.t === "agent" && handbookRun.route.agentId === "lab0-desk", "run.started carries the decision");
    const view = JSON.parse((await get(`${web.base}/runs/${handbook.runId}/view`)).text) as { route: string | null };
    assert.match(view.route ?? "", /^lab0-desk: the router's top score, confidence [01]\.\d\d \(lab0-methods 0\.\d\d\), router lexical-v1$/);

    const methods = routedTo(await askShared(web.base, "R-2", "R-2a", "How many participants per group for a two-group comparison?"), "lab0-methods", "score");
    const methodsRun = await settle(methods.runId);
    assert.ok(methodsRun.answer.includes("methods/sample-size.md"), `the methods answer does not cite methods/sample-size.md: ${methodsRun.answer}`);

    const unsure = "Do skipped diary items count as missing data?";
    const asked = await askShared(web.base, "R-3", "R-3a", unsure);
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    assert.equal(asked.json.t, "asked-user");
    assert.deepEqual(asked.json.choices?.map((c) => c.name).sort(), ["Lab handbook", "Methods desk"]);
    const pickedRun = routedTo(await askShared(web.base, "R-3", "R-3a", unsure, "lab0-methods"), "lab0-methods", "picked");
    assert.ok((await settle(pickedRun.runId)).answer.includes("methods/missing-data.md"), "the picked agent searched its own KB");
    const followUp = routedTo(await askShared(web.base, "R-3", "R-3b", "What about the diary nights?"), "lab0-methods", "thread");
    await settle(followUp.runId);
    const alone = await askShared(web.base, "R-4", "R-4a", "What about the diary nights?");
    assert.equal(alone.json.answeredBy?.agentId, "lab0-desk", "the same follow-up in a new thread goes to the handbook, so the thread is what held it");
    await settle(alone.json.runId!);
    assert.equal(hosted.requests, start, "routing sent nothing to the hosted endpoint");
    return `${q05.id} to Lab handbook (confidence ${handbook.confidence}), cites ${q05.expected}; sample size to Methods desk (${methods.confidence}), cites methods/sample-size.md; "${unsure}": asked, choices Lab handbook and Methods desk; pick ran Methods desk; follow-up stayed (basis thread), alone it went to Lab handbook; record page shows the route; hosted requests ${start} -> ${hosted.requests}`;
  });


  await check("check T: through a fake Teams and Bot Framework, a channel mention gets the cited answer in its thread with a record link that resolves, and a participant id is refused with zero hosted requests", async () => {
    assert.ok(published, "check 1 published a snapshot");
    await ps.stopAll();
    const teams = await startFakeTeams();
    const teamsEnv = { PATH: childEnv.PATH!, HOME: childEnv.HOME!, ALIQUOT_SURFACE_TOKEN: teamsToken, MICROSOFT_APP_ID: APP_ID, MICROSOFT_APP_PASSWORD: APP_SECRET, MICROSOFT_APP_TENANT_ID: TENANT, ALIQUOT_TEAMS_OPENID: teams.openid, ALIQUOT_TEAMS_LOGIN: teams.login };
    const teamsDoors = processes(root, work, teamsEnv);
    try {
      const q = prereg.inDocument[0]!;
      /** Starts aliquot teams on a free port and returns its messaging endpoint. */
      const door = async (base: string) => {
        const proc = teamsDoors.start("teams-T", "aliquot.ts", ["teams", "--door", base, "--listen", "127.0.0.1:0"]);
        return waitFor("the Teams door to listen", async () => /listening on (http:\/\/\S+\/api\/messages)/.exec(proc.out.join(""))?.[1] ?? null, 15_000);
      };
      const runIn = (text: string) => /\/runs\/([0-9a-f-]{36})/.exec(text)?.[1] as RunId | undefined;

      let web = await ps.startWeb(cfgHandbook);
      ps.startWorker(cfgHandbook, "WT");
      let endpoint = await door(web.base);
      const mention = teams.activity(q.question);
      assert.equal(await teams.deliver(endpoint, mention), 200);
      const answered = await teams.answerTo(mention.id);
      assert.ok(answered.includes(q.expected), `the thread's answer does not name ${q.expected}: ${answered}`);
      const looking = teams.calls.find((c) => c.method === "POST" && c.activityId === mention.id)!;
      assert.equal(looking.conversationId, mention.conversation.id, "the reply is in the channel thread the mention started");
      const runId = runIn(answered);
      assert.ok(runId, `the answer carries a record link: ${answered}`);
      const recorded = await loadEvents(db, runId);
      assert.equal(verifyChain(recorded), null);
      assert.equal(recorded[0]?.event.t === "run.started" ? recorded[0].event.surface : null, "teams");
      const page = await get(`${web.base}/runs/${runId}`);
      assert.equal(page.status, 200);
      assert.ok(page.text.includes(runId), "the record page names the run");
      assert.equal(await teams.deliver(endpoint, teams.activity(q.question), "forged"), 401, "an activity the Bot Framework did not sign is refused");
      await teamsDoors.stopAll();
      await ps.stopAll();

      const start = hosted.requests;
      web = await ps.startWeb(cfgHosted);
      ps.startWorker(cfgHosted, "WT2");
      endpoint = await door(web.base);
      const restricted = teams.activity(prereg.restricted.message);
      assert.equal(await teams.deliver(endpoint, restricted), 200);
      const refused = await teams.answerTo(restricted.id);
      const refusedRun = runIn(refused);
      assert.ok(refusedRun, `the refusal carries a record link: ${refused}`);
      const refusedEvents = await loadEvents(db, refusedRun);
      assert.equal(finishedOf(refusedEvents).outcome, "refused");
      assert.equal(refusedEvents.some((e) => e.event.t === "model.requested"), false, "no model.requested was journaled");
      assert.equal(hosted.requests, start, "the participant id sent nothing to the hosted endpoint");
      await teamsDoors.stopAll();
      await ps.stopAll();
      return `answer in thread names ${q.expected}, record ${runId.slice(0, 8)} on surface teams, chain verified, record page 200, forged activity 401; participant id: run ${refusedRun.slice(0, 8)} refused, hosted requests ${start} -> ${hosted.requests}; Teams saw: ${refused.split("\n")[0]}`;
    } finally {
      await teamsDoors.stopAll();
      await teams.close();
    }
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

  await check("check U: aliquot usage totals the handbook agent's calls under its project, priced from the records alone", async () => {
    let input = 0, output = 0, calls = 0;
    // Every door's runs count (web, ask, mcp, slack), so the expected sum reads the records, not this script's list.
    const tagged = await db.query<{ run_id: RunId }>("select run_id from run_events where event->>'t' = 'run.started' and event->>'project' = 'lab0-grant'");
    assert.ok(tagged.rowCount, "the handbook agent's runs carry its project");
    for (const { run_id } of tagged.rows)
      for (const e of await loadEvents(db, run_id))
        if (e.event.t === "model.completed") {
          calls++;
          input += e.event.usage.input;
          output += e.event.usage.output;
        }
    // 2000 and 6000 per million tokens: cents = (input x 2000 + output x 6000) / 10^4, rounded half up.
    const cents = Math.floor((input * 2000 + output * 6000 + 5000) / 10_000);
    const today = new Date().toISOString().slice(0, 10);
    const { code, stdout } = await runWithInput(root, "aliquot.ts", ["--config", cfgHandbook, "usage", "--from", "2026-01-01", "--to", today, "--by", "project"], childEnv, "");
    assert.equal(code, 0, stdout);
    const line = stdout.split("\n").find((l) => l.startsWith("lab0-grant"));
    assert.ok(line, stdout);
    assert.match(line, new RegExp(`^lab0-grant +\\d+ +${calls} +${input} +${output}  USD ${Math.floor(cents / 100)}\\.${String(cents % 100).padStart(2, "0")}$`));
    return line.replace(/ +/g, " ");
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

  await check("check Y: aliquot sheet lists exactly lab0's surfaces, endpoints and agents, and aliquot card of the handbook's version matches the card schema", async () => {
    const sheet = await runWithInput(root, "aliquot.ts", ["--config", cfgHandbook, "sheet"], childEnv, "");
    assert.equal(sheet.code, 0, sheet.stdout);
    const rows = (heading: string) =>
      sheet.stdout.split(`## ${heading}\n`)[1]!.split("\n## ")[0]!.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---")).slice(1).map((l) => l.split(" | ").map((c) => c.replace(/^\| | \|$/g, "")));
    assert.deepEqual(rows("Surfaces").map((r) => [r[0], r[2], r[3]]), [["web", "lab", "up to D3"], ["acp", "zdr", "up to D1"], ["mcp", "zdr", "up to D1"], ["personal", "public", "up to D0"], ["slack", "approved", "up to D2"], ["teams", "institution", "up to D2"]]);
    assert.deepEqual(rows("Model endpoints").map((r) => [r[0], r[1], r[2]]), [["local", compiler.url, "lab"], ["agentlab", agentModel.url, "lab"], ["hosted", hosted.url, "zdr"]]);
    assert.deepEqual(rows("Agents").map((r) => [r[0], r[2], r[3]]), [["lab0-desk", "published", "scripted-1 on agentlab"], ["lab0-methods", "published", "scripted-1 on agentlab"], ["lab0-handbook", "lab.toml", "scripted-1 on agentlab"]]);
    assert.match(sheet.stdout, /No study is registered\./);
    const run = runs.find((r) => r.label.startsWith("Q") && r.cfg === cfgHandbook)!;
    const started = (await loadEvents(db, run.runId)).find((e) => e.event.t === "run.started")!.event;
    assert.ok(started.t === "run.started");
    const printed = await runWithInput(root, "aliquot.ts", ["--config", cfgHandbook, "card", started.agent], childEnv, "");
    assert.equal(printed.code, 0, printed.stdout);
    const card = agentCardSchema.parse(JSON.parse(printed.stdout));
    assert.deepEqual([card.hash, card.model.endpointId, card.model.placement, card.model.receivesUpTo], [started.agent, "agentlab", "lab", "D3"]);
    assert.deepEqual(card.tools.map((t) => [t.name, t.deployedNow]), [["kb_search", true], ["kb_read", true]]);
    assert.deepEqual(card.knowledgeBases.map((k) => [k.kbId, k.snapshot, k.cls]), [["lab0-handbook", published!.id, published!.cls]]);
    assert.match(card.prompt.systemTextSha256 ?? "", /^[0-9a-f]{64}$/);
    return `sheet: 6 surfaces, 3 endpoints, 3 agents (two published by check R); card ${card.hash.slice(0, 12)} validates`;
  });

  await check("check K: a synced folder and a fake Drive feed one KB with scoped entries; an edit reaches the next answer, the record cites the version, and an out-of-scope member's run never reads the scoped entry", async () => {
    // The earlier checks' workers would claim this check's runs on configs without its endpoint, so they stop first.
    await ps.stopAll();
    const box = join(work, "Box", "Lab SOPs");
    mkdirSync(box, { recursive: true });
    const sop = readFileSync(join(kbDir, "sop-freezer.md"), "utf8");
    writeFileSync(join(box, "sop-freezer.md"), sop);
    const cite = await startFakeModel("scripted-1", "cite");
    const drive = await startFakeDrive();
    try {
      drive.put({ id: "d-onboarding", name: "Onboarding", mimeType: GOOGLE_DOC, parent: "lab0-folder", content: readFileSync(join(kbDir, "onboarding-ra.md"), "utf8"), permissions: [{ type: "domain", role: "reader", domain: "lab0.example" }] });
      drive.put({ id: "d-cryo", name: "Cryostat protocol", mimeType: GOOGLE_DOC, parent: "lab0-folder", content: "# Cryostat protocol\n\nThe cryostat zephyrine wash runs every Friday at 4 pm, cryo group only.\n", permissions: [{ type: "group", role: "reader", emailAddress: "cryo@lab0.example" }] });
      const agentPath = agentFile("sources", { agentId: "lab0-sources", name: "Lab0 synced documents", knowledgeBases: ["lab0-docs"], instructions: "Answer from the lab's documents and end with a Source: line." });
      const cfg = join(work, "lab-sources.toml");
      writeFileSync(cfg, [
        "[endpoints.local]", `base_url = "${cite.url}"`, 'placement = "lab"',
        "[surfaces.web]", 'placement = "lab"', "port = 0",
        "[hosts]", '"127.0.0.1" = "lab"',
        "[policy]", `participant_id_patterns = ['${prereg.restricted.pattern}']`,
        "[agents]", `fixtures = ["${agentPath}"]`,
        "[sources.box-sops]", 'kind = "folder"', `path = "${box}"`, 'kb = "lab0-docs"', 'class = "D1"', 'scope = ["lab"]',
        "[sources.lab0-drive]", 'kind = "gdrive"', 'folder_id = "lab0-folder"', 'token_env = "LAB0_DRIVE_TOKEN"', `base_url = "${drive.url}"`, 'kb = "lab0-docs"', 'class = "D1"', "poll_seconds = 5",
        "[directory.groups]", 'cryo = ["member-cryo"]',
        "[directory.emails]", '"cryo@lab0.example" = "group:cryo"', "",
      ].join("\n"));
      const ks = processes(root, work, { ...childEnv, LAB0_DRIVE_TOKEN: drive.token });
      try {
        const sync = ks.start("sources-sync", "kb.ts", ["sync", "--watch", "--config", cfg]);
        await waitLine(sync, /watching 2 sources/, 20_000);
        const { base } = await ks.startWeb(cfg);
        ks.startWorker(cfg, "K1");
        let k = 0;
        const askAs = async (user: string, text: string) => {
          const sent = await post(base, "/message", { thread: `t-K-${k}`, message: `m-K-${k++}`, text, user });
          assert.equal(sent.status, 202, JSON.stringify(sent.json));
          const runId = sent.json.runId as RunId;
          const events = await waitFor(`run.finished for K ${text}`, async () => {
            const es = await loadEvents(db, runId);
            return es.some((e) => e.event.t === "run.finished") ? es : null;
          }, 20_000);
          const sources = JSON.parse((await get(`${base}/runs/${runId}/sources`)).text) as SourceStatus[];
          return { runId, events, answer: await answerText(events), sources };
        };
        const q = "Who answers the freezer alarm?";
        const first = await askAs("member-1", q);
        const v1 = first.sources.find((v) => v.location === "sop-freezer.md");
        assert.ok(v1 && v1.state === "current", `the first answer cites the SOP's version: ${JSON.stringify(first.sources)}`);
        const marker = "Edited by lab0 check K.";
        const before = sync.out.join("").length;
        writeFileSync(join(box, "sop-freezer.md"), sop.replace(/^(# .*\n)/, `$1\n${marker}\n`));
        await waitFor("the watcher to publish the edit", async () => (/published .*changed box-sops\/sop-freezer\.md/.test(sync.out.join("").slice(before)) ? true : null), 15_000);
        const recheck = JSON.parse((await get(`${base}/runs/${first.runId}/sources`)).text) as SourceStatus[];
        assert.equal(recheck.find((v) => v.location === "sop-freezer.md")?.state, "changed", "the first answer now says its source changed");
        const second = await askAs("member-1", q);
        assert.ok(second.answer.includes(marker), `the next answer reads the edit: ${second.answer}`);
        const v2s = second.sources.find((v) => v.location === "sop-freezer.md");
        assert.ok(v2s && v2s.state === "current" && v2s.version !== v1.version, "the record cites the new version");
        const outside = await askAs("member-1", "zephyrine wash cryostat");
        const leaked = JSON.stringify(outside.events).includes("cryostat-protocol") || /zephyrine wash runs|Friday/.test(outside.answer) || outside.sources.some((v) => v.location === "Cryostat protocol");
        assert.equal(leaked, false, "member-1 is not in cryo, so the cryostat entry is never retrieved, cited or answered from");
        const inside = await askAs("member-cryo", "zephyrine wash cryostat");
        assert.match(inside.answer, /zephyrine wash runs every Friday/);
        assert.ok(inside.sources.some((v) => v.location === "Cryostat protocol" && v.source === "lab0-drive"));
        return `box folder + fake Drive -> lab0-docs; edit reached the next answer (version ${v1.version.slice(0, 8)} -> ${v2s.version.slice(0, 8)}), first answer marked changed; cryo entry: 0 retrievals for member-1, cited for member-cryo`;
      } finally {
        await ks.stopAll();
      }
    } finally {
      await cite.close();
      await drive.close();
    }
  });

  await check("check K2: a fake SharePoint library feeds a KB through Graph delta; an edit and a delete reach the next answer, and a folder shared with one group is never read by anyone else", async () => {
    await ps.stopAll();
    const cite = await startFakeModel("scripted-1", "cite");
    const graph = await startFakeGraph();
    try {
      graph.put({ id: "root", name: "root", folder: true, grants: [{ kind: "siteGroup", name: "Lab0 SOPs Members" }] });
      graph.put({ id: "sp-sops", name: "Lab SOPs", folder: true });
      graph.put({ id: "sp-freezer", name: "Freezer storage.docx", parent: "sp-sops", mimeType: DOCX, content: freezerSop() });
      graph.put({ id: "sp-cryo", name: "Cryo", parent: "sp-sops", folder: true, inherits: false, grants: [{ kind: "group", email: "cryo@lab0.example" }] });
      graph.put({ id: "sp-cryostat", name: "Cryostat rinse.md", parent: "sp-cryo", content: "# Cryostat rinse\n\nThe cryostat quillon rinse runs every Tuesday at 9 am, cryo group only.\n" });
      const agentPath = agentFile("sharepoint", { agentId: "lab0-sharepoint", name: "Lab0 SharePoint documents", knowledgeBases: ["lab0-sp"], instructions: "Answer from the lab's documents and end with a Source: line." });
      const cfg = join(work, "lab-sharepoint.toml");
      writeFileSync(cfg, [
        "[endpoints.local]", `base_url = "${cite.url}"`, 'placement = "lab"',
        "[surfaces.web]", 'placement = "lab"', "port = 0",
        // Graph and the download host are both on loopback here; a real lab places graph.microsoft.com and <tenant>.sharepoint.com.
        "[hosts]", '"127.0.0.1" = "lab"',
        "[agents]", `fixtures = ["${agentPath}"]`,
        "[sources.lab0-sharepoint]", 'kind = "graph"', `drive_id = "${graph.driveId}"`, 'token_env = "LAB0_GRAPH_TOKEN"', `base_url = "${graph.url}"`, 'kb = "lab0-sp"', 'class = "D1"', "poll_seconds = 5",
        "[sources.lab0-sharepoint.site_groups]", '"Lab0 SOPs Members" = "lab"',
        "[directory.groups]", 'cryo = ["member-cryo"]',
        "[directory.emails]", '"cryo@lab0.example" = "group:cryo"', "",
      ].join("\n"));
      const ks = processes(root, work, { ...childEnv, LAB0_GRAPH_TOKEN: graph.token });
      try {
        const sync = ks.start("sharepoint-sync", "kb.ts", ["sync", "--watch", "--config", cfg]);
        await waitLine(sync, /watching 1 source: lab0-sharepoint \(every 5 s\)/, 20_000);
        const { base } = await ks.startWeb(cfg);
        ks.startWorker(cfg, "K2");
        let k = 0;
        const askAs = async (user: string, text: string) => {
          const sent = await post(base, "/message", { thread: `t-K2-${k}`, message: `m-K2-${k++}`, text, user });
          assert.equal(sent.status, 202, JSON.stringify(sent.json));
          const runId = sent.json.runId as RunId;
          const events = await waitFor(`run.finished for K2 ${text}`, async () => {
            const es = await loadEvents(db, runId);
            return es.some((e) => e.event.t === "run.finished") ? es : null;
          }, 20_000);
          const sources = JSON.parse((await get(`${base}/runs/${runId}/sources`)).text) as SourceStatus[];
          return { runId, events, answer: await answerText(events), sources };
        };
        const statusOf = async (runId: RunId) => (JSON.parse((await get(`${base}/runs/${runId}/sources`)).text) as SourceStatus[]).find((v) => v.location === "Lab SOPs/Freezer storage.docx")?.state;
        const q = "Where do aliquots go in the freezer?";
        const first = await askAs("member-1", q);
        assert.match(first.answer, /room 214, rack C/, `the answer quotes the Word document: ${first.answer}`);
        const v1 = first.sources.find((v) => v.location === "Lab SOPs/Freezer storage.docx" && v.source === "lab0-sharepoint");
        assert.ok(v1 && v1.state === "current", `the answer cites the SharePoint file's version: ${JSON.stringify(first.sources)}`);

        let before = sync.out.join("").length;
        graph.edit("sp-freezer", freezerSop("Edited in SharePoint by lab0 check K2."));
        await waitFor("the delta poll to publish the edit", async () => (/published .*changed lab0-sharepoint\/lab-sops\/freezer-storage\.md/.test(sync.out.join("").slice(before)) ? true : null), 20_000);
        assert.equal(await statusOf(first.runId), "changed", "the first answer now says its source changed");
        const second = await askAs("member-1", q);
        const v2 = second.sources.find((v) => v.location === "Lab SOPs/Freezer storage.docx");
        assert.ok(v2 && v2.state === "current" && v2.version !== v1.version, "the next answer cites the edited version");

        before = sync.out.join("").length;
        graph.remove("sp-freezer");
        await waitFor("the delta poll to publish the delete", async () => (/published .*removed lab0-sharepoint\/lab-sops\/freezer-storage\.md/.test(sync.out.join("").slice(before)) ? true : null), 20_000);
        assert.equal(await statusOf(second.runId), "removed", "an answer from the deleted file says its source was removed");
        const third = await askAs("member-1", q);
        assert.ok(!/rack C/.test(third.answer) && !third.sources.some((v) => v.location === "Lab SOPs/Freezer storage.docx"), `the deleted file left the knowledge base: ${third.answer}`);

        const outside = await askAs("member-1", "quillon rinse cryostat");
        const leaked = JSON.stringify(outside.events).includes("cryostat-rinse") || /quillon rinse runs|Tuesday/.test(outside.answer) || outside.sources.some((v) => v.location.includes("Cryostat"));
        assert.equal(leaked, false, "member-1 is not in the cryo group the folder is shared with, so its file is never retrieved, cited or answered from");
        const inside = await askAs("member-cryo", "quillon rinse cryostat");
        assert.match(inside.answer, /quillon rinse runs every Tuesday/);
        assert.ok(inside.sources.some((v) => v.location === "Lab SOPs/Cryo/Cryostat rinse.md" && v.source === "lab0-sharepoint"));
        const contentHops = graph.requests.filter((r) => r.startsWith("GET download:")).length;
        assert.ok(graph.downloadAuth.every((a) => a === undefined), "no download hop carried the Graph token");
        return `fake SharePoint library -> lab0-sp by delta; edit (version ${v1.version.slice(0, 8)} -> ${v2.version.slice(0, 8)}) and delete reached the next answer, earlier answers marked changed then removed; cryo folder: 0 retrievals for member-1, cited for member-cryo; ${contentHops} downloads, none with the token`;
      } finally {
        await ks.stopAll();
      }
    } finally {
      await cite.close();
      await graph.close();
    }
  });

  await check("check O: research IT exports every event as JSON lines with no question text, and /healthz follows the worker", async () => {
    await ps.stopAll();
    const { code, stdout } = await runWithInput(root, "aliquot.ts", ["--config", cfgHandbook, "audit", "export"], { PATH: childEnv.PATH!, HOME: childEnv.HOME!, DATABASE_URL: dbUrl }, "");
    assert.equal(code, 0, stdout);
    const lines = stdout.trim().split("\n").map((l) => JSON.parse(l) as { seq: number; type: string; run: string | null; refusal: { code: string } | null });
    assert.deepEqual(lines.map((l) => l.seq), [...lines.map((l) => l.seq)].sort((a, b) => a - b), "lines come out in seq order");
    const started = new Set(lines.filter((l) => l.type === "run.started").map((l) => l.run));
    assert.deepEqual(runs.filter((r) => !started.has(r.runId)).map((r) => r.label), [], "every run's start is exported");
    const refusals = lines.filter((l) => l.refusal?.code === "class-above-ceiling").length;
    assert.ok(refusals >= 1, "the roster refusals are exported");
    const texts = [prereg.restricted.message, ...prereg.inDocument.map((q) => q.question), ...prereg.outsideDocuments.map((q) => q.question)];
    assert.deepEqual(texts.filter((t) => stdout.includes(t)), [], "no question or message text is in the export");
    assert.equal(new RegExp(prereg.restricted.pattern).test(stdout), false, "no roster id is in the export");

    const web = await ps.startWeb(cfgHandbook);
    const status = async () => (await get(`${web.base}/healthz`)).status;
    const before = await status();
    const worker = ps.startWorker(cfgHandbook, "WO");
    await waitFor("/healthz 200 once the worker beats", async () => ((await status()) === 200 ? true : null), 15_000);
    await ps.stop(worker);
    const after = await status();
    assert.deepEqual([before, after], [503, 503]);
    return `${lines.length} lines, ${started.size} runs, ${refusals} class-above-ceiling refusals, no question text; /healthz 503 -> 200 with a worker -> 503 when it stops`;
  });

  await check("total: the hosted endpoint saw exactly the one control request", async () => {
    assert.equal(hosted.requests, 1);
    return "hosted requests over the whole script: 1";
  });

  await check("check Z: the worker signs an anchor of every chain into a log outside the database, and aliquot verify --anchors holds it", async () => {
    const keyPath = childEnv.LABH_ANCHOR_KEY_FILE!;
    const logPath = join(work, "anchors.log");
    writeFileSync(keyPath, newAnchorKeyPem(), { mode: 0o600 });
    const cfgAnchor = join(work, "lab-anchor.toml");
    writeFileSync(cfgAnchor, `${readFileSync(cfgHandbook, "utf8")}[anchor]\npath = "anchors.log"\nevery_minutes = 15\n`);
    const bin = (b: string) => join(root, "packages/core/bin", b);
    const worker = ps.startGroup("worker-anchor", process.execPath, [...PERMISSION_FLAGS, `--allow-fs-write=${logPath}`, bin("worker.ts"), "--config", cfgAnchor, "--worker-id", "WZ"], root);
    const line = await waitLine(worker, /anchor \{.*\}/, 15_000);
    await ps.stop(worker);
    const anchor = JSON.parse(line.slice(line.indexOf("{"))) as { n: number; audit: { seq: number } | null; runs: unknown[] };
    assert.equal(anchor.n, 1);
    assert.ok(anchor.runs.length >= runs.length, `${anchor.runs.length} runs anchored, ${runs.length} started by this script`);
    const verify = await runWithInput(root, "aliquot.ts", ["--config", cfgAnchor, "verify", "--anchors"], childEnv, "");
    assert.equal(verify.code, 0, verify.stdout);
    const held = verify.stdout.trim().split("\n").at(-1)!;
    assert.match(held, /^anchors: 1 line, every signature valid/);
    return `anchor line 1: audit seq ${anchor.audit?.seq ?? "none"}, ${anchor.runs.length} closed runs; ${held}`;
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
