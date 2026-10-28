import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyText, gate, type InboundMessage } from "../packages/core/src/gate.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import type { MemberId } from "../packages/core/src/agent.ts";

const labPatterns = [/\bP-\d{5}\b/];

test("classifyText raises to the highest detection and never below the floor", () => {
  assert.deepEqual(classifyText("What are the office hours?", "D1", labPatterns), { cls: "D1", detections: [] });
  assert.deepEqual(classifyText("Did P-12345 finish the survey?", "D1", labPatterns), { cls: "D3", detections: [{ kind: "participant-id", cls: "D3", span: [4, 11] }] });
  assert.equal(classifyText("mail me at someone@example.org", "D0", labPatterns).cls, "D2");
  assert.equal(classifyText("mail me at someone@example.org", "D3", labPatterns).cls, "D3");
  assert.equal(classifyText("call 608-555-0100", "D0", labPatterns).cls, "D2");
  assert.equal(classifyText("ssn 123-45-6789", "D0", labPatterns).cls, "D3");
  assert.equal(classifyText("MRN 0012345", "D0", labPatterns).cls, "D3");
  assert.equal(classifyText("DOB: 04/12/1990", "D0", labPatterns).cls, "D3");
  assert.equal(classifyText("this is REVIEW-CONFIDENTIAL", "D0", labPatterns).cls, "R");
});

test("classifyText is stateless across calls with the same global pattern", () => {
  const first = classifyText("P-11111 then P-22222", "D0", labPatterns).detections.length;
  const second = classifyText("P-11111 then P-22222", "D0", labPatterns).detections.length;
  assert.equal(first, 2);
  assert.equal(second, 2);
});

const msg = (text: string, user = "alice"): InboundMessage => ({ channel: { surface: "web", channelId: "lab" }, threadId: "t1", messageId: "m1", platformUserId: user, text, attachments: [], addressed: true, at: "2026-01-01T00:00:00.000Z" });
const deps = {
  members: async (id: string) => (id === "alice" ? { id: "alice" as MemberId, audiences: [{ t: "lab" as const }] } : null),
  channelFloor: async () => "D1" as const,
  labPatterns,
  policy: DEFAULT_POLICY,
};

test("gate admits members with the message class and refuses strangers and review-confidential content", async () => {
  const admitted = await gate(msg("Did P-12345 finish?"), deps);
  assert.equal(admitted.t, "admit");
  if (admitted.t !== "admit") return;
  const { text, ...rest } = admitted;
  assert.deepEqual(rest, { t: "admit", member: "alice", audiences: [{ t: "lab" }], cls: "D3", detections: [{ kind: "participant-id", cls: "D3", span: [4, 11] }] });
  assert.deepEqual({ value: text.value, cls: text.cls, origin: text.origin }, { value: "Did P-12345 finish?", cls: "D3", origin: "gate:participant-id" });
  const stranger = await gate(msg("hi", "mallory"), deps);
  assert.equal(stranger.t === "refuse" && stranger.reason, "unknown-member");
  const r = await gate(msg("REVIEW-CONFIDENTIAL: the reviewer said"), deps);
  assert.equal(r.t === "refuse" && r.reason, "review-confidential");
  const labOnly = await gate(msg("REVIEW-CONFIDENTIAL: the reviewer said"), { ...deps, policy: { reviewConfidential: "lab-only" } });
  assert.equal(labOnly.t === "admit" && labOnly.cls, "R");
});
