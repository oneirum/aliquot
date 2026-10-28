/** In-memory recorder and journal for gateway and tool tests: events in a list, payloads in a map, no Postgres. */
import { canonicalJson, sha256, type PayloadHash } from "../packages/core/src/hash.ts";
import { Labelled } from "../packages/core/src/dataclass.ts";
import { eventClass, eventHash, type CallRecorder, type PayloadRef, type RunEvent, type RunId, type RunJournal, type StoredEvent } from "../packages/core/src/record.ts";

export interface MemoryRecorder extends CallRecorder {
  readonly events: RunEvent[];
  readonly bodies: Map<string, Labelled<unknown>>;
  body(ref: PayloadRef): unknown;
}

export function memoryRecorder(): MemoryRecorder {
  const events: RunEvent[] = [];
  const bodies = new Map<string, Labelled<unknown>>();
  return {
    events,
    bodies,
    async record(e) {
      events.push(e);
    },
    async put(content) {
      const text = canonicalJson(content.value);
      const hash = sha256(text) as string as PayloadHash;
      bodies.set(hash, Labelled.stamp(content.value, content.cls, content.origin));
      return { hash, cls: content.cls, bytes: Buffer.byteLength(text) };
    },
    body: (ref) => bodies.get(ref.hash)?.value,
  };
}

export function memoryJournal(runId: RunId): RunJournal & { readonly log: RunEvent[]; body(ref: PayloadRef): unknown } {
  const rec = memoryRecorder();
  const stored: StoredEvent[] = [];
  const append = async (event: RunEvent): Promise<StoredEvent> => {
    const seq = stored.length;
    const prev = stored[seq - 1]?.hash ?? null;
    const at = new Date().toISOString();
    const cls = eventClass(event);
    const e: StoredEvent = { runId, seq, at, cls, prevHash: prev, hash: eventHash(runId, seq, at, cls, prev, event), event };
    stored.push(e);
    rec.events.push(event);
    return e;
  };
  return {
    log: rec.events,
    body: rec.body,
    put: rec.put,
    runId,
    epoch: 1,
    append,
    record: async (e) => {
      await append(e);
    },
    events: () => stored,
    async get(ref) {
      const b = rec.bodies.get(ref.hash);
      if (!b) throw new Error(`no body ${ref.hash}`);
      return b;
    },
    pendingInbox: async () => [],
    consumeInbox: (inboxId, item) => append({ t: "inbox.consumed", inboxId, item }),
  };
}
