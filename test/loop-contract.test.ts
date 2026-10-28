/**
 * The loop contract guard. LOOP_CONTRACT names next()'s semantics and is
 * hashed into every agent version, so it must move when next() moves. This
 * test derives a fingerprint from next()'s behavior over a generated corpus
 * of run states and pins it under the contract name in loop-contract.json.
 * A change to next() (or to RETRY, which it reads) changes the fingerprint,
 * and the test fails until LOOP_CONTRACT is bumped and the new name pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LOOP_CONTRACT, type AgentId, type ResolvedAgent } from "../packages/core/src/agent.ts";
import { canonicalJson } from "../packages/core/src/hash.ts";
import { next, type ToolPolicy } from "../packages/core/src/loop.ts";
import type { CallFailure, InboxItem, ModelCallState, RunState, ToolCallState } from "../packages/core/src/record.ts";
import { AGENT, RUN, TARGET, ref } from "./events.ts";

const pinned = JSON.parse(await readFile(new URL("./loop-contract.json", import.meta.url), "utf8")) as Record<string, string>;

const NOW = Date.parse("2026-01-01T00:10:00.000Z");
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
  limits: { maxSteps: 2, maxTokens: 1_000, maxWallMs: 600_000 },
};
const tools: ToolPolicy = { isRepeatable: (t) => t !== "send_email", needsConfirm: (t) => t === "send_email" };

const base: RunState = {
  runId: RUN,
  agent: AGENT,
  kind: "interactive",
  surface: "web",
  threadId: "t",
  startedAt: NOW - 60_000,
  cls: "D1",
  steps: 1,
  tokens: 100,
  transcript: [],
  modelCall: null,
  toolCalls: [],
  confirmed: new Map(),
  stop: "none",
  stopBy: null,
  stopAsked: false,
  stopRecorded: false,
  refused: null,
  fault: null,
  limitHit: null,
  finalCalled: false,
  answer: null,
  replied: false,
  finished: null,
};

const failure = (retryable: boolean, at: number) => ({ at, retryable, failure: { code: "http", status: 503, detail: null } as CallFailure });
const model = (patch: Partial<ModelCallState>): ModelCallState => ({ step: 1, attempts: 1, final: false, status: "open", lastFailure: null, ...patch });
const tool = (patch: Partial<ToolCallState>): ToolCallState => ({ callId: "c1", tool: "kb_search", input: ref("a1"), attempts: 0, status: "pending", lastFailure: null, confirmAsked: false, ...patch });

/** Each dimension is a list of alternatives; the corpus is their product. Order matters to the fingerprint, so append only at the end of a list. */
const dimensions: readonly (readonly Partial<RunState>[])[] = [
  [{ fault: null }, { fault: { t: "store-refused", refusal: { code: "review-confidential-refused" } } }, { fault: { t: "unrunnable", problems: [] } }],
  [{ stop: "none" }, { stop: "requested-unconfirmed", stopAsked: false }, { stop: "requested-unconfirmed", stopAsked: true }, { stop: "confirmed", stopRecorded: false, stopBy: "alice" }, { stop: "confirmed", stopRecorded: true, stopBy: "alice" }],
  [{ refused: null }, { refused: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } }],
  [
    { modelCall: null },
    { modelCall: model({}) },
    { modelCall: model({ attempts: 3 }) },
    { modelCall: model({ status: "failed", lastFailure: failure(true, NOW - 10_000) }) },
    { modelCall: model({ status: "failed", lastFailure: failure(true, NOW - 100) }) },
    { modelCall: model({ attempts: 2, status: "failed", lastFailure: failure(true, NOW - 10_000) }) },
    { modelCall: model({ status: "failed", lastFailure: failure(false, NOW - 10_000) }) },
    { modelCall: model({ status: "completed" }) },
    { modelCall: model({ step: 2, status: "completed", final: true }) },
    { modelCall: model({ attempts: 2, status: "failed", lastFailure: failure(true, NOW - 100) }) },
  ],
  [
    { toolCalls: [] },
    { toolCalls: [tool({})] },
    { toolCalls: [tool({ status: "open", attempts: 1 })] },
    { toolCalls: [tool({ status: "open", attempts: 3 })] },
    { toolCalls: [tool({ tool: "send_email", status: "open", attempts: 1 })] },
    { toolCalls: [tool({ status: "failed", attempts: 1, lastFailure: failure(true, NOW - 10_000) })] },
    { toolCalls: [tool({ status: "failed", attempts: 1, lastFailure: failure(true, NOW - 100) })] },
    { toolCalls: [tool({ tool: "send_email" })] },
    { toolCalls: [tool({ tool: "send_email", confirmAsked: true })] },
    { toolCalls: [tool({ tool: "send_email" })], confirmed: new Map([["c1", true]]) },
    { toolCalls: [tool({ tool: "send_email" })], confirmed: new Map([["c1", false]]) },
    { toolCalls: [tool({ status: "resolved" })] },
    { toolCalls: [tool({ status: "resolved" }), tool({ callId: "c2" })] },
    { toolCalls: [tool({ status: "failed", attempts: 2, lastFailure: failure(true, NOW - 100) })] },
  ],
  [{ answer: null, replied: false }, { answer: null, replied: true }, { answer: ref("ans"), replied: false }, { answer: ref("ans"), replied: true }],
  [{ steps: 1 }, { steps: 2 }, { steps: 2, limitHit: "steps" }, { steps: 2, limitHit: "steps", finalCalled: true }, { tokens: 1_000 }, { startedAt: NOW - 600_000 }],
];
const inboxes: readonly (readonly { readonly id: string; readonly item: InboxItem }[])[] = [[], [{ id: "i1", item: { t: "stop", confirmed: true, by: "alice" } }]];

function* corpus(): Generator<{ readonly inbox: (typeof inboxes)[number]; readonly state: RunState }> {
  const walk = function* (i: number, acc: RunState): Generator<RunState> {
    if (i === dimensions.length) return yield acc;
    for (const patch of dimensions[i]!) yield* walk(i + 1, { ...acc, ...patch });
  };
  for (const inbox of inboxes) for (const state of walk(0, base)) yield { inbox, state };
}

function fingerprint(): { readonly hash: string; readonly cases: number } {
  const hash = createHash("sha256");
  let cases = 0;
  for (const { inbox, state } of corpus()) {
    let action: unknown;
    try {
      action = next(state, agent, NOW, inbox, tools);
    } catch (err) {
      action = { threw: err instanceof Error ? err.message : String(err) };
    }
    hash.update(canonicalJson({ inbox, state: { ...state, confirmed: [...state.confirmed] }, action }));
    cases += 1;
  }
  return { hash: hash.digest("hex"), cases };
}

test("next() behaves as the pinned loop contract says, or the contract name was bumped and pinned", () => {
  const { hash, cases } = fingerprint();
  assert.ok(cases > 50_000, `corpus has ${cases} cases`);
  const expected = pinned[LOOP_CONTRACT];
  assert.ok(expected, `LOOP_CONTRACT ${LOOP_CONTRACT} has no fingerprint in test/loop-contract.json: add {"${LOOP_CONTRACT}": "${hash}"} after checking the loop change is intended`);
  assert.equal(hash, expected, `next() behaves differently from what ${LOOP_CONTRACT} pinned. Bump LOOP_CONTRACT in packages/core/src/agent.ts and pin the new name to ${hash}, or revert the loop change.`);
});
