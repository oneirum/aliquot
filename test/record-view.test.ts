import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRecordView, recordView } from "../packages/core/src/record-view.ts";
import { AGENT, RUN, chain, ref, started } from "./events.ts";

const refusedRun = () =>
  chain([
    started(ref("q", "D3")),
    { t: "egress.refused", destination: "model:hosted", payload: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } },
    { t: "reply.posted", mode: "final-post", surfaceMessageId: "1" },
    { t: "run.finished", outcome: "refused", answer: null, reason: null, flags: [] },
  ]);

test("the record view names the agent, the outcome, an intact chain and what each refusal refused", () => {
  const v = recordView(RUN, refusedRun());
  assert.equal(v.agent, AGENT);
  assert.equal(v.outcome, "refused");
  assert.deepEqual(v.chain, { events: 4, firstBad: null });
  assert.deepEqual(
    v.rows.map((r) => [r.seq, r.ms, r.t, r.refused, r.detail]),
    [
      [0, 0, "run.started", false, "web thread, trigger message from alice, 0 earlier turns"],
      [1, 1000, "egress.refused", true, "D3 content to model:hosted: D3 exceeds the destination ceiling D1"],
      [2, 2000, "reply.posted", false, "final-post"],
      [3, 3000, "run.finished", false, "refused"],
    ],
  );
});

test("an edited event shows as a broken chain at that event, in the view and in the terminal text", () => {
  const events = refusedRun();
  events[2] = { ...events[2]!, event: { t: "reply.posted", mode: "link-only", surfaceMessageId: "1" } };
  const v = recordView(RUN, events);
  assert.deepEqual(v.chain, { events: 4, firstBad: 2 });
  assert.match(formatRecordView(v), /^chain {4}CHAIN BROKEN at event 2$/m);
});

test("the summary counts model calls, tokens, tool calls, distinct entries retrieved and refusals, in the view and the terminal text", () => {
  const events = chain([
    started(ref("q", "D1")),
    { t: "model.completed", step: 1, attempt: 1, providerModelId: "m", output: ref("o1"), toolCalls: [], usage: { input: 10, output: 5 }, ms: 3 },
    { t: "tool.requested", callId: "c1", attempt: 1, tool: "kb_search", hash: "h" as never, input: ref("i1") },
    { t: "tool.completed", callId: "c1", attempt: 1, output: ref("r1"), retrieved: [{ snapshot: "s" as never, entries: ["e1", "e2"] as never, truncated: false }], ms: 1 },
    { t: "model.completed", step: 2, attempt: 1, providerModelId: "m", output: ref("o2"), toolCalls: [], usage: { input: 12, output: 4 }, ms: 3 },
    { t: "tool.requested", callId: "c2", attempt: 1, tool: "kb_read", hash: "h" as never, input: ref("i2") },
    { t: "tool.completed", callId: "c2", attempt: 1, output: ref("r2"), retrieved: [{ snapshot: "s" as never, entries: ["e2"] as never, truncated: false }], ms: 1 },
    { t: "tool.requested", callId: "c3", attempt: 1, tool: "kb_search", hash: "h" as never, input: ref("i3") },
    { t: "run.finished", outcome: "answered", answer: null, reason: null, flags: [] },
  ]);
  const v = recordView(RUN, events);
  assert.deepEqual(v.summary, {
    ms: 8000,
    modelCalls: 2,
    tokens: { input: 22, output: 9 },
    toolCalls: [{ tool: "kb_search", calls: 2 }, { tool: "kb_read", calls: 1 }],
    entriesRetrieved: 2,
    refused: 0,
    withheld: 0,
    cost: null,
  });
  assert.match(formatRecordView(v), /^summary  8000 ms; 2 model calls; 22 tokens in, 9 out; tools kb_search x2, kb_read; 2 entries retrieved; 0 refused$/m);
});

test("a refused run's summary has no model calls and one refusal", () => {
  const s = recordView(RUN, refusedRun()).summary;
  assert.equal(s.modelCalls, 0);
  assert.equal(s.refused, 1);
  assert.deepEqual(s.toolCalls, []);
});
