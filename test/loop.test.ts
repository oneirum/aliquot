import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, type RunEvent } from "../packages/core/src/record.ts";
import { next, stopAborts, type ToolPolicy } from "../packages/core/src/loop.ts";
import { LOOP_CONTRACT, type ResolvedAgent, type AgentId } from "../packages/core/src/agent.ts";
import { TARGET, chain, ref, started } from "./events.ts";

const agent: ResolvedAgent = {
  schema: 2,
  agentId: "handbook" as AgentId,
  loopContract: LOOP_CONTRACT,
  instructions: "answer",
  instructionsClass: "D1",
  model: TARGET,
  knowledgeBases: [],
  tools: [{ name: "kb_search", hash: "h".repeat(64) as never }],
  sandbox: null,
  retrieval: { algorithm: "bm25-v1", readCapTokens: 15_000 },
  limits: { maxSteps: 2, maxTokens: 1_000_000, maxWallMs: 600_000 },
};
const tools: ToolPolicy = { isRepeatable: (t) => t !== "send_email", needsConfirm: (t) => t === "send_email" };
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const decide = (events: readonly RunEvent[], now = T0 + 60_000, inbox: { id: string; item: never }[] = []) => next(fold(chain(events, T0)), agent, now, inbox, tools);

const requested = (step: number, attempt = 1, final = false): RunEvent => ({ t: "model.requested", step, attempt, target: TARGET, prompt: ref(`p${step}`), final });
const completedWithTool = (step: number, tool = "kb_search"): RunEvent => ({
  t: "model.completed",
  step,
  attempt: 1,
  providerModelId: "scripted-1",
  output: ref(`o${step}`),
  toolCalls: [{ id: `c${step}`, name: tool, args: ref(`a${step}`) }],
  usage: { input: 10, output: 5 },
  ms: 1,
});
const answered = (step: number): RunEvent => ({ t: "model.completed", step, attempt: 1, providerModelId: "scripted-1", output: ref(`ans${step}`), toolCalls: [], usage: { input: 10, output: 5 }, ms: 1 });
const toolRequested = (step: number, attempt: number): RunEvent => ({ t: "tool.requested", callId: `c${step}`, attempt, tool: "kb_search", hash: "h".repeat(64) as never, input: ref(`a${step}`) });
const toolDone = (step: number, attempt: number): RunEvent => ({ t: "tool.completed", callId: `c${step}`, attempt, output: ref(`r${step}`), ms: 1 });

test("a fresh run calls the model for step 1", () => {
  assert.deepEqual(decide([started()]), { t: "call-model", step: 1, attempt: 1, final: false });
});

test("a crash-cut repeatable tool call is retried as attempt 2; a non-repeatable one is marked unknown", () => {
  const cut = [started(), requested(1), completedWithTool(1), toolRequested(1, 1)];
  assert.deepEqual(decide(cut), { t: "call-tool", callId: "c1", attempt: 2 });
  const sendCut: RunEvent[] = [started(), requested(1), completedWithTool(1, "send_email"), { t: "inbox.consumed", inboxId: "i", item: { t: "confirm", callId: "c1", approve: true, by: "alice" } }, { t: "tool.requested", callId: "c1", attempt: 1, tool: "send_email", hash: "h".repeat(64) as never, input: ref("a1") }];
  assert.deepEqual(decide(sendCut), { t: "mark-unknown", callId: "c1" });
});

test("a crash-cut model call is retried without waiting, a failed one waits out its backoff", () => {
  assert.deepEqual(decide([started(), requested(1)]), { t: "call-model", step: 1, attempt: 2, final: false });
  const failed: RunEvent[] = [started(), requested(1), { t: "model.failed", step: 1, attempt: 1, failure: { code: "http", status: 503, detail: null }, retryable: true }];
  const failedAt = T0 + 2000;
  assert.deepEqual(decide(failed, failedAt + 200), { t: "wait", until: "backoff", ms: 800 });
  assert.deepEqual(decide(failed, failedAt + 1000), { t: "call-model", step: 1, attempt: 2, final: false });
});

test("three failed model attempts end the run failed, after a notice", () => {
  const events: RunEvent[] = [started()];
  for (let a = 1; a <= 3; a++) events.push(requested(1, a), { t: "model.failed", step: 1, attempt: a, failure: { code: "http", status: 503, detail: null }, retryable: true });
  assert.deepEqual(decide(events), { t: "post-reply", body: { t: "notice", notice: "failed" } });
  assert.deepEqual(decide([...events, { t: "reply.posted", mode: "final-post", surfaceMessageId: "m" }]), { t: "finish", outcome: "failed", reason: { t: "model-exhausted", attempts: 3 } });
  const fatal: RunEvent[] = [started(), requested(1), { t: "model.failed", step: 1, attempt: 1, failure: { code: "http", status: 400, detail: null }, retryable: false }];
  assert.deepEqual(decide(fatal), { t: "post-reply", body: { t: "notice", notice: "failed" } });
});

test("limits are checked between steps and produce exactly one final no-tools call", () => {
  const twoSteps = [started(), requested(1), completedWithTool(1), toolRequested(1, 1), toolDone(1, 1), requested(2), completedWithTool(2)];
  assert.deepEqual(decide(twoSteps), { t: "limit", which: "steps" });
  const hit: RunEvent[] = [...twoSteps, { t: "limit.hit", which: "steps" }];
  assert.deepEqual(decide(hit), { t: "call-model", step: 3, attempt: 1, final: true });
  const finalDone: RunEvent[] = [...hit, requested(3, 1, true), answered(3)];
  assert.deepEqual(decide(finalDone), { t: "post-reply", body: { t: "answer", ref: ref("ans3") } });
  assert.deepEqual(decide([...finalDone, { t: "reply.posted", mode: "final-post", surfaceMessageId: "m" }]), { t: "finish", outcome: "limit", reason: null });
  const oneStep = [started(), requested(1), completedWithTool(1)];
  assert.deepEqual(decide(oneStep), { t: "call-tool", callId: "c1", attempt: 1 });
});

test("an answer is posted once and then the run finishes answered", () => {
  const done = [started(), requested(1), completedWithTool(1), toolRequested(1, 1), toolDone(1, 1), requested(2), answered(2)];
  assert.deepEqual(decide(done), { t: "post-reply", body: { t: "answer", ref: ref("ans2") } });
  assert.deepEqual(decide([...done, { t: "reply.posted", mode: "final-post", surfaceMessageId: "m" }]), { t: "finish", outcome: "answered", reason: null });
});

test("a recorded fault gets the failure notice and then finishes with its reason, ahead of any other policy", () => {
  const reason = { t: "store-refused", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D2" } } as const;
  const faulted: RunEvent[] = [started(), requested(1), completedWithTool(1), { t: "run.faulted", reason }];
  assert.deepEqual(decide(faulted), { t: "post-reply", body: { t: "notice", notice: "failed" } });
  assert.deepEqual(decide([...faulted, { t: "reply.posted", mode: "final-post", surfaceMessageId: "m" }]), { t: "finish", outcome: "failed", reason });
  const unrunnable: RunEvent[] = [started(), { t: "run.faulted", reason: { t: "unrunnable", problems: [{ t: "snapshot-missing", snapshot: "s".repeat(64) as never }] } }];
  assert.deepEqual(decide(unrunnable), { t: "post-reply", body: { t: "notice", notice: "unrunnable" } });
});

test("a stop before step 1 is recorded, replied and finished; one after step 1 is asked once", () => {
  const early: RunEvent[] = [started(), { t: "inbox.consumed", inboxId: "i1", item: { t: "stop", confirmed: false, by: "alice" } }];
  assert.deepEqual(decide(early, T0 + 1500), { t: "record-stop", by: "alice", sinceStartMs: 1500 });
  const recorded: RunEvent[] = [...early, { t: "stop", by: "alice", sinceStartMs: 1500 }];
  assert.deepEqual(decide(recorded), { t: "post-reply", body: { t: "notice", notice: "stopped" } });
  assert.deepEqual(decide([...recorded, { t: "reply.posted", mode: "final-post", surfaceMessageId: "m" }]), { t: "finish", outcome: "stopped", reason: null });
  const late: RunEvent[] = [started(), requested(1), completedWithTool(1), { t: "inbox.consumed", inboxId: "i1", item: { t: "stop", confirmed: false, by: "alice" } }];
  assert.deepEqual(decide(late), { t: "ask-stop-confirm" });
  assert.deepEqual(decide([...late, { t: "stop.asked" }]), { t: "call-tool", callId: "c1", attempt: 1 });
});

test("a stop notice aborts the in-flight call only when it would end the run", () => {
  const beforeStep1 = fold(chain([started(), requested(1)], T0));
  assert.equal(stopAborts(beforeStep1)({ runId: beforeStep1.runId, confirmed: false }), true);
  const afterStep1 = fold(chain([started(), requested(1), completedWithTool(1), toolRequested(1, 1), toolDone(1, 1), requested(2)], T0));
  assert.equal(stopAborts(afterStep1)({ runId: afterStep1.runId, confirmed: false }), false);
  assert.equal(stopAborts(afterStep1)({ runId: afterStep1.runId, confirmed: true }), true);
  const asked = fold(chain([started(), requested(1), completedWithTool(1), { t: "inbox.consumed", inboxId: "i1", item: { t: "stop", confirmed: false, by: "alice" } }, { t: "stop.asked" }, toolRequested(1, 1)], T0));
  assert.equal(stopAborts(asked)({ runId: asked.runId, confirmed: false }), true, "a second stop after the question confirms it");
});

test("a pending inbox item is consumed before anything else", () => {
  const item = { t: "stop", confirmed: false, by: "alice" } as const;
  assert.deepEqual(decide([started(), requested(1)], T0, [{ id: "i9", item: item as never }]), { t: "consume-inbox", inboxId: "i9", item });
});

test("an egress refusal gets a notice and finishes refused", () => {
  const refused: RunEvent[] = [started(ref("q", "D3")), { t: "egress.refused", destination: "model:hosted", payload: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } }];
  assert.deepEqual(decide(refused), { t: "post-reply", body: { t: "notice", notice: "refused" } });
  assert.deepEqual(decide([...refused, { t: "reply.posted", mode: "final-post", surfaceMessageId: "m" }]), { t: "finish", outcome: "refused", reason: null });
});

test("an external-send tool is asked for confirmation, then waits, then runs or is declined", () => {
  const pending = [started(), requested(1), completedWithTool(1, "send_email")];
  assert.deepEqual(decide(pending), { t: "ask-confirm", callId: "c1" });
  assert.deepEqual(decide([...pending, { t: "confirm.asked", callId: "c1" }]), { t: "wait", until: "confirm", ms: 0 });
  const yes: RunEvent[] = [...pending, { t: "confirm.asked", callId: "c1" }, { t: "inbox.consumed", inboxId: "i", item: { t: "confirm", callId: "c1", approve: true, by: "alice" } }];
  assert.deepEqual(decide(yes), { t: "call-tool", callId: "c1", attempt: 1 });
  const no: RunEvent[] = [...pending, { t: "confirm.asked", callId: "c1" }, { t: "inbox.consumed", inboxId: "i", item: { t: "confirm", callId: "c1", approve: false, by: "alice" } }];
  assert.deepEqual(decide(no), { t: "decline-tool", callId: "c1" });
});
