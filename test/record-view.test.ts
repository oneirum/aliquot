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
      [0, 0, "run.started", false, "web thread, trigger message, 0 earlier turns"],
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
