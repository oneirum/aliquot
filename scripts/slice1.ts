#!/usr/bin/env node
/**
 * pnpm slice1: every check in docs/design/SLICE.md against real Postgres, two
 * fake OpenAI-compatible endpoints (a scripted lab model and a counting hosted
 * one) and, last, one real question through Ollama.
 *
 * Workers and the web app run as separate processes from packages/core/bin.
 * Check 1 kills a worker with SIGKILL right after tool.requested is committed;
 * check 2 pauses one with SIGSTOP right before reply.posted and lets a second
 * worker finish the run before the first wakes up. Everything else goes
 * through the web surface's HTTP routes and the database.
 *
 *   node scripts/slice1.ts [--skip-ollama] [--only <regex over check names>]
 *
 * --only is for iterating on one check; checks 5 and 8 read the results of
 * earlier checks and fail when run alone.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseAgentDocument, resolveAgent, versionHash } from "../packages/core/src/agent.ts";
import { boot } from "../packages/core/src/boot.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { loadEvents, verifyChain, type PayloadRef, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import type { ProbeReport } from "../test/plants/probe.ts";
import { describe, PLANTS, plantedOverlay, scanBoundaries } from "./boundaries.ts";
import { checker, ensurePostgres, post, processes, waitFor, waitLine } from "./procs.ts";

const { values: flags } = parseArgs({ options: { "skip-ollama": { type: "boolean", default: false }, only: { type: "string" } } });
const only = flags.only ? new RegExp(flags.only) : null;

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".slice1");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_slice1");

const lab = await startFakeModel("scripted-1", "search-then-answer");
const hosted = await startFakeModel("hosted-2", "answer");
const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434/v1";

// The only variables a child process sees. Check 8 asserts there is no hosted credential among them. LABH_FAULTS unlocks --fault.
const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: randomBytes(32).toString("hex"), LABH_FAULTS: "1" };

// Configs and agent fixtures -------------------------------------------------

const baseAgent = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
function agentFixture(name: string, overrides: Record<string, unknown>): string {
  const path = join(work, `agent-${name}.json`);
  writeFileSync(path, JSON.stringify({ ...baseAgent, ...overrides }, null, 2));
  return path;
}
function config(name: string, endpoints: Record<string, { url: string; placement: string }>, agentPath: string): string {
  const lines = [
    "[database]",
    'url_env = "DATABASE_URL"',
    "[store]",
    'placement = "lab"',
    'key_env = "LABH_PAYLOAD_KEY"',
    ...Object.entries(endpoints).flatMap(([id, e]) => [`[endpoints.${id}]`, `base_url = "${e.url}"`, `placement = "${e.placement}"`]),
    "[surfaces.web]",
    'placement = "lab"',
    "port = 0",
    "[policy]",
    'review_confidential = "refuse"',
    "participant_id_patterns = ['\\bP-\\d{5}\\b']",
    "[agents]",
    `fixtures = ["${agentPath}"]`,
    "[knowledge_bases]",
    `fixtures = ["${join(root, "fixtures/kb.json")}"]`,
  ];
  const path = join(work, `lab-${name}.toml`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}
const scripted = { endpointId: "local", modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 256 } };
const cfgA = config("a", { local: { url: lab.url, placement: "lab" } }, agentFixture("a", { model: scripted }));
const cfgLimit = config("limit", { local: { url: lab.url, placement: "lab" } }, agentFixture("limit", { model: scripted, limits: { maxSteps: 2 } }));
// A D1-ceiling agent on a zdr endpoint is a valid document; the D3 message is what the gateway must refuse.
const cfgB = config("b", { local: { url: lab.url, placement: "lab" }, hosted: { url: hosted.url, placement: "zdr" } }, agentFixture("b", { ceiling: "D1", model: { ...scripted, endpointId: "hosted", modelId: "hosted-2" } }));
const cfgC = config("c", { local: { url: ollamaUrl, placement: "lab" } }, agentFixture("c", { model: { endpointId: "local", modelId: "qwen3:8b", params: { temperature: 0, maxOutputTokens: 512 } } }));

const ps = processes(root, work, childEnv);
const { startWeb, startWorker, stop } = ps;

/** `ps` state letter: T means stopped by a signal. */
const processState = (pid: number): string => execSync(`ps -o stat= -p ${pid}`).toString().trim();

// HTTP and database helpers ---------------------------------------------------

async function get(base: string, path: string): Promise<unknown> {
  return (await fetch(`${base}${path}`)).json();
}

const eventsOf = (runId: RunId) => loadEvents(db, runId);
const waitForEvent = (runId: RunId, t: string, timeoutMs: number) =>
  waitFor(`${t} on run ${runId}`, async () => {
    const es = await eventsOf(runId);
    return es.some((e) => e.event.t === t) ? es : null;
  }, timeoutMs);
const waitForFinish = (runId: RunId, timeoutMs: number) => waitForEvent(runId, "run.finished", timeoutMs);
const replies = async (runId: RunId) => (await db.query<{ kind: string; text: string }>("select kind, text from web_messages where run_id = $1 order by id", [runId])).rows;
/** How many times any worker called finalize for the run. The unique index makes a double post invisible in web_messages; this does not. */
const postAttempts = async (runId: RunId) => Number((await db.query<{ n: string }>("select count(*) as n from web_finalize_attempts where run_id = $1", [runId])).rows[0]!.n);
const finishedOutcome = (events: StoredEvent[]) => events.filter((e) => e.event.t === "run.finished").map((e) => (e.event.t === "run.finished" ? e.event.outcome : ""));

/** Every *.requested attempt and how many terminal events it has. */
function attempts(events: StoredEvent[]): Map<string, number> {
  const table = new Map<string, number>();
  for (const { event } of events) {
    if (event.t === "model.requested") table.set(`model:${event.step}#${event.attempt}`, 0);
    if (event.t === "tool.requested") table.set(`tool:${event.callId}#${event.attempt}`, 0);
  }
  for (const { event } of events) {
    const key =
      event.t === "model.completed" || event.t === "model.failed"
        ? `model:${event.step}#${event.attempt}`
        : event.t === "tool.completed" || event.t === "tool.failed"
          ? `tool:${event.callId}#${event.attempt}`
          : null;
    if (key) table.set(key, (table.get(key) ?? 0) + 1);
  }
  return table;
}

async function sendMessage(base: string, thread: string, message: string, text: string): Promise<{ runId: RunId; duplicate: boolean }> {
  const r = await post(base, "/message", { thread, message, text, user: "alice" });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  return { runId: r.json.runId as RunId, duplicate: r.json.duplicate as boolean };
}

// Checks ------------------------------------------------------------------------

const { check, results } = checker(ps, { only, counter: () => hosted.requests });

let check1Run: RunId | null = null;

try {
  await check("check 1: crash and resume, exactly once", async () => {
    lab.script = "search-then-answer";
    const web = await startWeb(cfgA);
    const a = startWorker(cfgA, "A", ["--fault", "kill-after:tool.requested", "--lease-ms", "1500"]);
    const { runId } = await sendMessage(web.base, "t1", "m1", "What are the PI office hours?");
    check1Run = runId;
    const exit = await Promise.race([a.exit, sleep(20000).then(() => null)]);
    assert.ok(exit, "worker A did not exit after the fault");
    assert.equal(exit.signal, "SIGKILL", `worker A exit: ${JSON.stringify(exit)}`);
    const cut = await eventsOf(runId);
    assert.equal(cut.at(-1)?.event.t, "tool.requested", `last committed event before the kill: ${cut.at(-1)?.event.t}`);
    const cutEvent = cut.at(-1)!.event as Extract<StoredEvent["event"], { t: "tool.requested" }>;
    assert.equal(cutEvent.attempt, 1);
    startWorker(cfgA, "B", ["--lease-ms", "1500"]);
    const events = await waitForFinish(runId, 25000);
    assert.deepEqual(finishedOutcome(events), ["answered"]);
    const posted = await replies(runId);
    assert.deepEqual(
      posted.map((r) => r.kind),
      ["reply"],
    );
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, i) => i),
      "seq is contiguous from 0",
    );
    assert.equal(verifyChain(events), null);
    const table = attempts(events);
    const cutKey = `tool:${cutEvent.callId}#1`;
    assert.equal(table.get(cutKey), 0, "the cut attempt has no terminal event");
    assert.equal(table.get(`tool:${cutEvent.callId}#2`), 1, "the retry is attempt 2 with one terminal event");
    for (const [key, n] of table) if (key !== cutKey) assert.equal(n, 1, `${key} has ${n} terminal events`);
    assert.equal(await postAttempts(runId), 1, "finalize was called exactly once across both workers");
    return `${events.length} events, ${cutKey} cut by SIGKILL and retried as #2, one run.finished answered, one finalize attempt, one reply: "${posted[0]!.text.slice(0, 60)}"`;
  });

  await check("check 2: zombie fence", async () => {
    lab.script = "answer";
    const web = await startWeb(cfgA);
    const a = startWorker(cfgA, "A2", ["--fault", "stop-before:reply.posted", "--lease-ms", "1500"]);
    const { runId } = await sendMessage(web.base, "t2", "m2", "Say hello.");
    await waitLine(a, /fault: SIGSTOP before reply\.posted/, 20000);
    await waitFor("worker A2 stopped (ps state T)", async () => (processState(a.child.pid!).startsWith("T") ? true : null), 5000);
    const postedByA = await replies(runId);
    assert.equal(postedByA.length, 1, "A2 posted its reply before the pause");
    const paused = await eventsOf(runId);
    assert.equal(paused.some((e) => e.event.t === "reply.posted"), false, "A2 has not journaled reply.posted");
    // The epoch moves with nothing else: no new holder, no event written, same owner. A2's next seq is free,
    // so the unique (run_id, seq) cannot refuse it. Only the epoch condition in the fence can.
    await db.query("update jobs set lease_epoch = lease_epoch + 1 where id = $1", [runId]);
    process.kill(a.child.pid!, "SIGCONT");
    await waitLine(a, /fault: resumed, now appending reply\.posted/, 5000);
    await waitLine(a, /lease lost: run .* epoch 1 could not append seq/, 10000);
    await stop(a);
    const afterStale = await eventsOf(runId);
    assert.equal(afterStale.length, paused.length, "the stale append at a free seq was refused by the epoch alone");
    assert.equal(await postAttempts(runId), 1, "A2's one finalize happened before the pause");

    const b = startWorker(cfgA, "B2", ["--lease-ms", "1500"]);
    const events = await waitForFinish(runId, 25000);
    await waitLine(b, /run .*: finished answered/, 5000);
    assert.deepEqual(finishedOutcome(events), ["answered"]);
    assert.equal(verifyChain(events), null);
    const posted = await replies(runId);
    assert.equal(posted.length, 1, "exactly one reply after B2's finalize");
    assert.equal(await postAttempts(runId), 2, "B2 called finalize again (no reply.posted on the record) and the index kept one reply");
    const epochs = await db.query<{ lease_epoch: number }>("select lease_epoch from jobs where id = $1", [runId]);
    assert.equal(epochs.rows[0]!.lease_epoch, 3);
    return `A2 (epoch 1) posted and paused; epoch bumped to 2 with no event written; A2 woke and its append at the free seq got LeaseLost on the epoch alone, ${afterStale.length} events unchanged; B2 (epoch 3) finalized again and finished: 2 finalize attempts, 1 reply`;
  });

  await check("check 3: idempotent intake", async () => {
    lab.script = "answer";
    const web = await startWeb(cfgA);
    startWorker(cfgA, "W3");
    const first = await sendMessage(web.base, "t3", "m3", "Where is the eye tracker?");
    const second = await sendMessage(web.base, "t3", "m3", "Where is the eye tracker?");
    assert.equal(second.runId, first.runId);
    assert.deepEqual([first.duplicate, second.duplicate], [false, true]);
    const jobs = await db.query<{ n: string }>("select count(*) as n from jobs where key = 'msg:web:lab:t3:m3'");
    assert.equal(jobs.rows[0]!.n, "1");
    const events = await waitForFinish(first.runId, 20000);
    assert.equal(events.filter((e) => e.event.t === "run.started").length, 1);
    const posted = (await get(web.base, `/replies?runId=${first.runId}`)) as { kind: string }[];
    assert.deepEqual(
      posted.map((p) => p.kind),
      ["reply"],
    );
    return `two POSTs of (web, lab, t3, m3) -> one job ${first.runId}, duplicate flags [false, true], one run, one reply`;
  });

  await check("check 4: D3 never leaves", async () => {
    hosted.script = "answer";
    const web = await startWeb(cfgB);
    startWorker(cfgB, "W4");
    const before = hosted.requests;
    const { runId } = await sendMessage(web.base, "t4", "m4", "Did participant P-12345 finish the survey?");
    const events = await waitForFinish(runId, 20000);
    assert.deepEqual(finishedOutcome(events), ["refused"]);
    const refused = events.find((e) => e.event.t === "egress.refused")?.event;
    assert.deepEqual(refused, { t: "egress.refused", destination: "model:hosted", payload: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } });
    assert.equal(events.some((e) => e.event.t === "model.requested"), false, "no model.requested was journaled");
    assert.equal(hosted.requests, before, "the hosted endpoint's request counter did not move");
    const posted = await replies(runId);
    assert.match(posted[0]?.text ?? "", /restricted data/);
    const control = await sendMessage(web.base, "t4b", "m4b", "What are the office hours?");
    const controlEvents = await waitForFinish(control.runId, 20000);
    assert.deepEqual(finishedOutcome(controlEvents), ["answered"]);
    assert.equal(hosted.requests, before + 1, "a D1 message to the same endpoint does reach it");
    return `D3 message -> refused with ${refused && "refusal" in refused ? refused.refusal.code : "?"}, hosted requests ${before} -> ${before} (control D1 message: ${before + 1})`;
  });

  await check("check 5: hash pins behavior", async () => {
    const core = await boot(cfgA, childEnv);
    try {
      const fixture = JSON.parse(readFileSync(join(work, "agent-a.json"), "utf8")) as Record<string, unknown>;
      const catalog = await core.catalog();
      const hashOf = (doc: Record<string, unknown>) => {
        const parsed = parseAgentDocument(doc);
        assert.ok(parsed.ok, JSON.stringify(parsed));
        const resolved = resolveAgent(parsed.doc, catalog);
        assert.ok(resolved.ok, JSON.stringify(resolved));
        return versionHash(resolved.agent);
      };
      const expected = hashOf(fixture);
      assert.ok(check1Run, "check 1 produced a run");
      const started = (await eventsOf(check1Run))[0]!.event;
      assert.equal(started.t, "run.started");
      assert.equal(started.t === "run.started" && started.agent, expected);
      const row = await db.query<{ agent_id: string }>("select agent_id from agent_versions where hash = $1", [expected]);
      assert.equal(row.rows[0]?.agent_id, "handbook");
      const edited = hashOf({ ...fixture, instructions: `${fixture.instructions as string}.` });
      const described = hashOf({ ...fixture, description: "Use when someone asks anything at all. Not for nothing." });
      assert.notEqual(edited, expected);
      assert.equal(described, expected);
      return `run.started.agent = ${expected.slice(0, 12)} = versionHash(resolveAgent(fixture)); +1 char in instructions -> ${edited.slice(0, 12)}; new description -> unchanged`;
    } finally {
      await core.close();
    }
  });

  await check("check 6: limits between steps", async () => {
    lab.script = "always-search";
    const web = await startWeb(cfgLimit);
    startWorker(cfgLimit, "W6");
    const { runId } = await sendMessage(web.base, "t6", "m6", "Keep searching.");
    const events = await waitForFinish(runId, 25000);
    assert.deepEqual(finishedOutcome(events), ["limit"]);
    assert.deepEqual(
      events.filter((e) => e.event.t === "limit.hit").map((e) => e.event),
      [{ t: "limit.hit", which: "steps" }],
    );
    const requested = events.filter((e) => e.event.t === "model.requested").map((e) => (e.event.t === "model.requested" ? e.event.final : null));
    assert.deepEqual(requested, [false, false, true], "two normal calls then exactly one final call");
    const posted = await replies(runId);
    assert.deepEqual(posted, [{ kind: "reply", text: "Scripted final answer with no tools available." }]);
    const finished = events.find((e) => e.event.t === "run.finished")!.event;
    assert.ok(finished.t === "run.finished" && finished.answer !== null, "the final answer is in run.finished");
    return `maxSteps 2 with an always-search model: limit.hit steps, model.requested final flags [false, false, true], answer posted, run.finished limit`;
  });

  await check("check 7: stop", async () => {
    lab.script = "answer";
    lab.delayMs = 3000;
    try {
      const web = await startWeb(cfgA);
      startWorker(cfgA, "W7");
      const { runId } = await sendMessage(web.base, "t7", "m7", "Tell me everything.");
      await waitForEvent(runId, "model.requested", 10000);
      const stopRes = await post(web.base, "/stop", { runId, user: "alice" });
      assert.equal(stopRes.status, 202);
      const events = await waitForFinish(runId, 15000);
      assert.deepEqual(finishedOutcome(events), ["stopped"]);
      const stopEvent = events.find((e) => e.event.t === "stop")?.event;
      assert.ok(stopEvent && stopEvent.t === "stop", "a stop event was journaled");
      assert.ok(stopEvent.sinceStartMs < 5000, `sinceStartMs ${stopEvent.sinceStartMs}`);
      const failed = events.find((e) => e.event.t === "model.failed")?.event;
      assert.deepEqual(failed && failed.t === "model.failed" ? failed.failure : null, { code: "aborted", detail: null }, "the in-flight model call was aborted through NOTIFY");
      assert.equal(events.some((e) => e.event.t === "model.completed"), false);
      const posted = await replies(runId);
      assert.deepEqual(posted, [{ kind: "reply", text: "Stopped." }]);
      return `stop ${stopEvent.sinceStartMs}ms after start aborted the in-flight call; outcome stopped, reply "Stopped.", no answer reply`;
    } finally {
      lab.delayMs = 0;
    }
  });

  await check("check 11: stop after step 1 asks first, and only a confirmed stop aborts", async () => {
    lab.script = "search-then-answer";
    lab.delayMs = 2000;
    try {
      const web = await startWeb(cfgA);
      startWorker(cfgA, "W11");
      const asked = await sendMessage(web.base, "t11a", "m11a", "What are the PI office hours?");
      await waitForEvent(asked.runId, "tool.completed", 15000);
      assert.equal((await post(web.base, "/stop", { runId: asked.runId, user: "alice" })).status, 202);
      const events = await waitForFinish(asked.runId, 20000);
      assert.deepEqual(finishedOutcome(events), ["answered"]);
      assert.equal(events.some((e) => e.event.t === "stop.asked"), true, "the unconfirmed stop was asked about");
      assert.equal(events.some((e) => e.event.t === "stop"), false, "nothing stopped");
      assert.equal(events.some((e) => e.event.t === "model.failed"), false, "the in-flight call was not aborted");
      assert.equal(events.filter((e) => e.event.t === "model.completed").length, 2);
      const posted = await replies(asked.runId);
      assert.deepEqual(posted.map((r) => r.kind), ["notice", "reply"]);
      assert.equal(posted[0]!.text, "Stop this run? Send stop again to confirm.");

      const stopped = await sendMessage(web.base, "t11b", "m11b", "What are the PI office hours?");
      await waitForEvent(stopped.runId, "tool.completed", 15000);
      // Land the stop while the 2 s step 2 call is in flight, not in the few ms before it starts.
      await sleep(300);
      assert.equal((await post(web.base, "/stop", { runId: stopped.runId, user: "alice", confirmed: true })).status, 202);
      const after = await waitForFinish(stopped.runId, 20000);
      assert.deepEqual(finishedOutcome(after), ["stopped"]);
      assert.equal(after.filter((e) => e.event.t === "model.completed").length, 1, "step 2 never completed");
      const failed = after.find((e) => e.event.t === "model.failed")?.event;
      assert.deepEqual(failed && failed.t === "model.failed" ? [failed.step, failed.failure.code] : null, [2, "aborted"], "the confirmed stop aborted the in-flight step 2 call");
      assert.deepEqual(await replies(stopped.runId), [{ kind: "reply", text: "Stopped." }]);
      return `unconfirmed stop during step 2: asked, call completed, run answered; confirmed stop during step 2: call aborted, run stopped`;
    } finally {
      lab.delayMs = 0;
    }
  });

  await check("check 8: no hosted egress on a laptop", async () => {
    const cfg = await loadConfig(cfgA);
    assert.deepEqual(
      cfg.endpoints.map((e) => [e.id, e.placement]),
      [["local", "lab"]],
    );
    const keys = Object.keys(childEnv).sort();
    assert.deepEqual(keys, ["DATABASE_URL", "HOME", "LABH_FAULTS", "LABH_PAYLOAD_KEY", "PATH"]);
    const passed = results.filter((r) => r.ok).map((r) => r.name);
    for (const n of ["check 1", "check 2", "check 3", "check 5", "check 6"]) assert.ok(passed.some((p) => p.startsWith(n)), `${n} did not pass`);
    // The hosted fake counted every request it ever received. Only check 4's D1 control message may have reached it.
    const reached = results.filter((r) => r.hostedRequests > 0).map((r) => `${r.name.split(":")[0]}: ${r.hostedRequests}`);
    assert.deepEqual(reached, ["check 4: 1"], "no check other than check 4's control message reached the hosted endpoint");
    assert.equal(hosted.requests, 1);
    return `checks 1, 2, 3, 5, 6 ran with lab.toml endpoints [local: lab] and a worker env of exactly ${keys.join(", ")} (the payload key is the local store's AES key, not a hosted credential); the hosted endpoint saw ${hosted.requests} request across all checks so far, check 4's D1 control`;
  });

  await check("check 10: a Postgres blip retries the job and a StoreRefused finishes failed, each with one reply", async () => {
    lab.script = "search-then-answer";
    const web = await startWeb(cfgA);
    const blip = startWorker(cfgA, "W10a", ["--fault", "throw-before:model.requested:pg-blip"]);
    const a = await sendMessage(web.base, "t10a", "m10a", "What are the PI office hours?");
    const blipped = await waitForFinish(a.runId, 25000);
    await waitLine(blip, /job .* run retry-after-progress attempt 1 in 1000ms/, 1000);
    assert.deepEqual(finishedOutcome(blipped), ["answered"]);
    assert.equal(verifyChain(blipped), null);
    const job = await db.query<{ attempts: number; status: string }>("select attempts, status from jobs where id = $1", [a.runId]);
    assert.deepEqual(job.rows, [{ attempts: 1, status: "done" }]);
    assert.deepEqual((await replies(a.runId)).map((r) => r.kind), ["reply"]);
    assert.equal(blipped.filter((e) => e.event.t === "model.requested").length, 2, "the blipped step was requested once per attempt");
    await stop(blip);

    const w10b = startWorker(cfgA, "W10b", ["--fault", "throw-before:tool.completed:store-refused"]);
    const b = await sendMessage(web.base, "t10b", "m10b", "What are the PI office hours?");
    const refused = await waitForFinish(b.runId, 25000);
    assert.equal(verifyChain(refused), null);
    const finished = refused.filter((e) => e.event.t === "run.finished").map((e) => e.event);
    assert.deepEqual(finished, [{ t: "run.finished", outcome: "failed", answer: null, reason: { t: "store-refused", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D2" } }, flags: [] }]);
    assert.deepEqual(
      refused.map((e) => e.event.t).slice(-3),
      ["run.faulted", "reply.posted", "run.finished"],
    );
    assert.equal(refused.some((e) => e.event.t === "tool.completed"), false);
    assert.deepEqual(await replies(b.runId), [{ kind: "reply", text: "The run failed after repeated errors. Please try again." }]);
    await stop(w10b);

    startWorker(cfgA, "W10c", ["--fault", "throw-before:journal-open:pg-blip"]);
    const c = await sendMessage(web.base, "t10c", "m10c", "What are the PI office hours?");
    const settled = await waitFor(
      `job ${c.runId} to settle`,
      async () => {
        const row = (await db.query<{ status: string; attempts: number }>("select status, attempts from jobs where id = $1", [c.runId])).rows[0]!;
        return row.status === "done" || row.status === "failed" ? row : null;
      },
      25000,
    );
    assert.deepEqual(settled, { status: "done", attempts: 1 }, "a blip while opening the journal hands the job back, it does not fail it");
    assert.deepEqual(finishedOutcome(await eventsOf(c.runId)), ["answered"]);
    assert.deepEqual((await replies(c.runId)).map((r) => r.kind), ["reply"]);
    return `pg blip before model.requested: job attempts 1, run answered, one reply; StoreRefused before tool.completed: run.faulted then one failed reply and run.finished failed (store-refused); pg blip while opening the journal: job attempts 1, run answered, one reply`;
  });

  await check("check 12: a runtime route planted in a tool is refused by the sealed worker, with the static scanner not run", async () => {
    lab.script = "search-then-answer";
    const web = await startWeb(cfgA);
    const target = `${hosted.url}/chat/completions`;
    const before = hosted.requests;
    const core = await boot(cfgA, childEnv);
    const body = async (ref: PayloadRef): Promise<unknown> => {
      const got = await core.store.get(ref);
      return "redacted" in got ? null : got.value;
    };
    try {
      const direct = startWorker(cfgA, "W12a", ["--plant-tool", join(root, "test/plants/fetch-tool.ts")]);
      const a = await sendMessage(web.base, "t12a", "m12a", target);
      const events = await waitForFinish(a.runId, 30000);
      assert.deepEqual(finishedOutcome(events), ["answered"]);
      const failed = events.flatMap((e) => (e.event.t === "tool.failed" ? [e.event] : []));
      assert.deepEqual(
        failed.map((f) => [f.attempt, f.failure.code, f.retryable]),
        [
          [1, "thrown", true],
          [2, "thrown", true],
          [3, "thrown", true],
        ],
      );
      assert.equal(events.some((e) => e.event.t === "tool.completed"), false, "the planted kb_search never completed");
      assert.match(String(await body(failed[0]!.failure.detail!)), /network is sealed in this process: global fetch/);
      assert.equal(hosted.requests, before, "the hosted endpoint saw nothing");
      await stop(direct);

      startWorker(cfgA, "W12b", ["--plant-tool", join(root, "test/plants/probe-tool.ts")]);
      const b = await sendMessage(web.base, "t12b", "m12b", target);
      const probed = await waitForFinish(b.runId, 30000);
      assert.deepEqual(finishedOutcome(probed), ["answered"]);
      const completed = probed.find((e) => e.event.t === "tool.completed")?.event;
      assert.ok(completed && completed.t === "tool.completed", "the probe tool completed with its report");
      const report = (await body(completed.output)) as ProbeReport;
      assert.deepEqual(report.leaked, [], `routes that reached out: ${report.leaked.join(", ")}`);
      assert.equal(report.refused.length, report.total);
      assert.deepEqual(report.permission, { child: false, worker: false, addon: false });
      assert.equal(hosted.requests, before);
      // Neither plant was scanned before it ran. For the record, the scanner reports the direct one too.
      const statically = scanBoundaries(root, new Map([["tools/planted/tool.ts", readFileSync(join(root, "test/plants/fetch-tool.ts"), "utf8")]]));
      assert.ok(statically.some((v) => v.file === "tools/planted/tool.ts" && v.rule === "global fetch through globalThis"), statically.map(describe).join("\n"));
      return `fetch taken at module load inside a planted kb_search: 3 tool.failed thrown ("network is sealed"), run answered, hosted requests ${before} -> ${hosted.requests}; probe tool: ${report.refused.length} routes refused, 0 leaked, permission model denies child, worker and addon`;
    } finally {
      await core.close();
    }
  });

  await check("check 9: boundary gate", async () => {
    assert.deepEqual(scanBoundaries(root).map(describe), []);
    const { overlay, at } = plantedOverlay(root);
    const violations = scanBoundaries(root, overlay);
    const caught: string[] = [];
    for (const plant of PLANTS) {
      const where = at.get(plant.name)!;
      const hit = violations.filter((v) => v.file === where.file && v.line === where.line);
      assert.ok(hit.some((v) => v.rule === plant.rule), `planted ${plant.name}: expected "${plant.rule}" at ${where.file}:${where.line}, got ${hit.map(describe).join(" | ") || "nothing"}`);
      caught.push(plant.name);
    }
    const plantedLines = new Set(PLANTS.map((p) => `${at.get(p.name)!.file}:${at.get(p.name)!.line}`));
    assert.deepEqual(violations.filter((v) => !plantedLines.has(`${v.file}:${v.line}`)).map(describe), [], "only planted lines are reported");
    return `clean tree: 0 violations over packages, tools, scripts and bin; ${PLANTS.length} planted routes each reported on its line: ${caught.join("; ")}`;
  });

  if (flags["skip-ollama"]) {
    console.log("SKIP smoke: ollama (--skip-ollama)");
  } else {
    await check("smoke: one real question through Ollama qwen3:8b", async () => {
      const web = await startWeb(cfgC);
      startWorker(cfgC, "WC", ["--lease-ms", "10000"]);
      const { runId } = await sendMessage(web.base, "tc", "mc", "What are the PI office hours?");
      const events = await waitForFinish(runId, 240000);
      assert.deepEqual(finishedOutcome(events), ["answered"]);
      assert.equal(verifyChain(events), null);
      const completed = events.filter((e) => e.event.t === "model.completed").map((e) => (e.event.t === "model.completed" ? e.event.providerModelId : ""));
      assert.ok(completed.length >= 1 && completed.every((m) => m === "qwen3:8b"), `provider model ids: ${completed.join(",")}`);
      const tools = events.filter((e) => e.event.t === "tool.completed").length;
      const posted = await replies(runId);
      assert.equal(posted.length, 1);
      assert.ok(posted[0]!.text.trim().length > 0, "non-empty answer");
      return `${events.length} events, ${completed.length} model call(s) served by qwen3:8b, ${tools} kb_search result(s), chain verified; answer: "${posted[0]!.text.replace(/\s+/g, " ").slice(0, 160)}"`;
    });
  }
} finally {
  await ps.stopAll();
  await lab.close();
  await hosted.close();
  await db.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
