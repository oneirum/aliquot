/** Builders for hand-written event lists, shared by the fold, next() and chain tests. */
import { eventClass, eventHash, type PayloadRef, type RunEvent, type RunId, type StoredEvent, type ThreadKey } from "../packages/core/src/record.ts";
import type { AgentVersionHash, PayloadHash, Sha256 } from "../packages/core/src/hash.ts";
import type { DataClass } from "../packages/core/src/dataclass.ts";
import type { ModelTarget, ExactModelId } from "../packages/core/src/gateway.ts";

export const RUN = "00000000-0000-4000-8000-000000000001" as RunId;
export const AGENT = "a".repeat(64) as AgentVersionHash;
export const TARGET: ModelTarget = { endpointId: "local", modelId: "scripted-1" as ExactModelId, params: { temperature: 0, maxOutputTokens: 256 } };

export function ref(name: string, cls: DataClass = "D1"): PayloadRef {
  return { hash: name.padEnd(64, "0") as PayloadHash, cls, bytes: name.length };
}

export function started(input: PayloadRef = ref("q")): RunEvent {
  return {
    t: "run.started",
    agent: AGENT,
    kind: "interactive",
    trigger: { t: "message", surface: "web", messageId: "m1", memberId: "alice" },
    thread: "web:c:t" as ThreadKey,
    surface: "web",
    threadId: "t",
    input,
    history: [],
    route: { t: "direct" },
    studyId: null,
  };
}

/** Chains the events as the journal would, with `at` spaced one second apart from a fixed start. */
export function chain(events: readonly RunEvent[], startMs = Date.parse("2026-01-01T00:00:00.000Z")): StoredEvent[] {
  const out: StoredEvent[] = [];
  let prev: Sha256 | null = null;
  events.forEach((event, seq) => {
    const at = new Date(startMs + seq * 1000).toISOString();
    const cls = eventClass(event);
    const hash = eventHash(RUN, seq, at, cls, prev, event);
    out.push({ runId: RUN, seq, at, cls, prevHash: prev, hash, event });
    prev = hash;
  });
  return out;
}
