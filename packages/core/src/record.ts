/**
 * The run record. It is also the workflow history: the durable loop keeps no
 * other state. Resume is fold(events) then next(state).
 *
 * Storage:
 *   run_events(run_id, seq, at, cls, prev_hash, hash, event jsonb)   append-only, hash-chained per run
 *   payloads(hash, cls, ciphertext, nonce, key_id, created_at)        addressed by HMAC-SHA256 of (class, plaintext) under the address
 *                                                                     subkey, AES-256-GCM under the cipher subkey; both HKDF from one master
 *   run_inbox(id, run_id, at, item jsonb, consumed_seq)               written by front doors only
 *
 * Invariants:
 * - One writer per run stream: the lease holder. append() is fenced by the
 *   lease epoch and the unique (run_id, seq). A zombie worker's append fails.
 * - seq is contiguous from 0. event 0 is always run.started.
 * - Exactly one run.finished per run, and nothing after it.
 * - Every *.requested has at most one terminal event per attempt.
 * - Events hold PayloadRefs, never bodies above a few hundred bytes. Bodies
 *   live in payloads, so redaction and retention delete bodies and keep hashes.
 * - An event's class is computed from the refs it holds, never passed in.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Db } from "./db.ts";
import { decideEgress, describeRefusal, join, Labelled, type DataClass, type EgressPolicy, type EgressRefusal, type Placement } from "./dataclass.ts";
import { canonicalJson, keyedAddresser, sha256, type Addresser, type AgentVersionHash, type EntryHash, type PayloadHash, type Sha256, type SnapshotId, type ToolHash } from "./hash.ts";
import type { RouteDecision } from "./router.ts";
import type { ModelTarget } from "./gateway.ts";
import type { Unrunnable } from "./agent.ts";

export type RunId = string & { readonly __run: true };
/** `${surface}:${channel}:${threadId}`. Runs in one thread are serialized by the claim query. */
export type ThreadKey = string & { readonly __thread: true };

export interface PayloadRef {
  readonly hash: PayloadHash;
  readonly cls: DataClass;
  readonly bytes: number;
}

export type Trigger =
  | { readonly t: "message"; readonly surface: string; readonly messageId: string; readonly memberId: string }
  | { readonly t: "schedule"; readonly scheduleId: string; readonly fireAt: string }
  | { readonly t: "eval"; readonly publishTicket: string; readonly caseIndex: number }
  | { readonly t: "test"; readonly memberId: string }
  | { readonly t: "replay"; readonly of: RunId; readonly tools: "recorded" | "live" };

export type RunOutcome = "answered" | "stopped" | "limit" | "failed" | "refused" | "unrunnable";

/**
 * Why a run ended failed or unrunnable. Typed so the console counts them by
 * code; free text (the error message) is a payload at the run's class, never
 * a string in the event.
 */
export type FailureReason =
  | { readonly t: "model-exhausted"; readonly attempts: number }
  | { readonly t: "store-refused"; readonly refusal: EgressRefusal }
  | { readonly t: "payload-unavailable"; readonly hash: PayloadHash; readonly why: PayloadUnavailable["why"] }
  | { readonly t: "surface-unknown"; readonly surface: string }
  | { readonly t: "agent-unavailable"; readonly agent: AgentVersionHash; readonly why: "missing" | "hash-mismatch" | "schema" }
  | { readonly t: "unrunnable"; readonly problems: readonly Unrunnable[] }
  | { readonly t: "retries-exhausted"; readonly attempts: number; readonly error: PayloadRef | null }
  /**
   * An agent CLI's self-check failed: it loaded tools, servers or a model the version did not pin. The CLI wrote the
   * names in why, so why is a payload at the session's class.
   */
  | { readonly t: "agent-not-confined"; readonly check: ConfinementCheck; readonly why: PayloadRef };

/** Which part of an agent CLI session was not the confined session its version promised. */
export type ConfinementCheck = "writer-tool" | "own-tool" | "own-server" | "model" | "version" | "own-call" | "own-item" | "no-init";

export interface ToolCallRef {
  readonly id: string;
  readonly name: string;
  readonly args: PayloadRef;
}

/**
 * Why a model or tool call failed: a code the console counts, an HTTP status
 * when there is one, and the free text (a provider error body, a thrown
 * message) as a payload at the call's class. A provider body can echo the
 * prompt, so it never sits in event JSON at D0.
 */
export interface CallFailure {
  readonly code: "aborted" | "network" | "http" | "unparseable" | "model-mismatch" | "invalid-input" | "unknown-tool" | "egress-refused" | "declined" | "thrown";
  readonly status?: number;
  readonly detail: PayloadRef | null;
}

/** One line for logs and the agent's tool result. The detail body, when the caller has it, says more. */
export function describeFailure(f: CallFailure): string {
  switch (f.code) {
    case "aborted":
      return "the call was aborted";
    case "network":
      return "the endpoint could not be reached";
    case "http":
      return `the endpoint answered HTTP ${f.status ?? "error"}`;
    case "unparseable":
      return "the endpoint's answer could not be parsed";
    case "model-mismatch":
      return "the endpoint served a different model than the one pinned";
    case "invalid-input":
      return "the input did not match the tool's schema";
    case "unknown-tool":
      return "no such tool is deployed";
    case "egress-refused":
      return "the tool may not send this data where it tried to";
    case "declined":
      return "declined in the thread";
    case "thrown":
      return "the tool threw";
    default: {
      const never: never = f.code;
      return never;
    }
  }
}

export type RunEvent =
  | {
      readonly t: "run.started";
      readonly agent: AgentVersionHash;
      readonly kind: "interactive" | "background";
      readonly trigger: Trigger;
      readonly thread: ThreadKey;
      readonly surface: string;
      readonly threadId: string;
      readonly input: PayloadRef;
      /** Prior thread turns given to the agent, as refs. */
      readonly history: readonly PayloadRef[];
      readonly route: RouteDecision | { readonly t: "pinned"; readonly studyId: string } | { readonly t: "direct" };
      readonly studyId: string | null;
    }
  | { readonly t: "model.requested"; readonly step: number; readonly attempt: number; readonly target: ModelTarget; readonly prompt: PayloadRef; readonly final: boolean }
  | {
      readonly t: "model.completed";
      readonly step: number;
      readonly attempt: number;
      readonly providerModelId: string;
      readonly output: PayloadRef;
      readonly toolCalls: readonly ToolCallRef[];
      readonly usage: { readonly input: number; readonly output: number };
      readonly ms: number;
      /** Opaque provider state to send back with the tool calls (reasoning, thinking), at the prompt's class. */
      readonly providerState?: PayloadRef;
    }
  | { readonly t: "model.failed"; readonly step: number; readonly attempt: number; readonly failure: CallFailure; readonly retryable: boolean }
  | { readonly t: "tool.requested"; readonly callId: string; readonly attempt: number; readonly tool: string; readonly hash: ToolHash; readonly input: PayloadRef }
  | {
      readonly t: "tool.completed";
      readonly callId: string;
      readonly attempt: number;
      readonly output: PayloadRef;
      /** Set by kb_read and kb_search: every entry returned, cited or not, per snapshot touched. */
      readonly retrieved?: readonly { readonly snapshot: SnapshotId; readonly entries: readonly EntryHash[]; readonly truncated: boolean }[];
      readonly ms: number;
    }
  | { readonly t: "tool.failed"; readonly callId: string; readonly attempt: number; readonly failure: CallFailure; readonly retryable: boolean }
  | { readonly t: "tool.outcome-unknown"; readonly callId: string }
  /** A bridged tool result the agent CLI's backend may not receive. The agent saw only the refusal; the run goes on. */
  | { readonly t: "tool.withheld"; readonly callId: string; readonly refusal: EgressRefusal; readonly cls: DataClass }
  /**
   * One agent CLI session, written once when the CLI exits. argvHash is the sha256 of the argv template and the
   * environment names (not values), so a reviewer can rebuild the confinement from the version.
   */
  | {
      readonly t: "agent.session";
      readonly attempt: number;
      readonly kind: string;
      readonly cliVersion: string;
      readonly argvHash: Sha256;
      readonly workspace: string;
      readonly exit: { readonly code: number | null; readonly signal: string | null };
      /** Bridged tool calls the CLI made. */
      readonly turns: number;
      readonly hostsTunneled: readonly string[];
      /** How many proxy requests were refused. Their targets are CLI-written, so they are a payload at the session's class. */
      readonly hostsRefused: number;
      readonly refusedTargets: PayloadRef | null;
    }
  /** payload is "unverified" when the content was refused for carrying no genuine label. */
  | { readonly t: "egress.refused"; readonly destination: string; readonly payload: DataClass | "unverified"; readonly refusal: EgressRefusal }
  /** A redirect the egress layer followed, written after the hop's host passed the egress list and decideEgress and before it was sent. */
  | { readonly t: "egress.redirected"; readonly from: string; readonly to: string; readonly status: number }
  | { readonly t: "confirm.asked"; readonly callId: string }
  | { readonly t: "inbox.consumed"; readonly inboxId: string; readonly item: InboxItem }
  | { readonly t: "stop.asked" }
  | { readonly t: "stop"; readonly by: string; readonly sinceStartMs: number }
  | { readonly t: "limit.hit"; readonly which: "steps" | "tokens" | "wall" }
  | { readonly t: "reply.posted"; readonly mode: "stream-confirmed" | "final-post" | "link-only"; readonly surfaceMessageId: string }
  /** A terminal error the loop could not continue past. Only reply.posted and run.finished follow it. */
  | { readonly t: "run.faulted"; readonly reason: FailureReason }
  | { readonly t: "run.finished"; readonly outcome: RunOutcome; readonly answer: PayloadRef | null; readonly reason: FailureReason | null; readonly flags: readonly ProvenanceFlag[] };

export type InboxItem =
  | { readonly t: "stop"; readonly confirmed: boolean; readonly by: string }
  | { readonly t: "steer"; readonly text: PayloadRef; readonly by: string }
  | { readonly t: "confirm"; readonly callId: string; readonly approve: boolean; readonly by: string }
  | { readonly t: "feedback"; readonly value: "up" | "down"; readonly by: string };

export interface ProvenanceFlag {
  readonly t: "number-untraced";
  readonly text: string;
}

export interface StoredEvent {
  readonly runId: RunId;
  readonly seq: number;
  readonly at: string;
  readonly cls: DataClass;
  readonly prevHash: Sha256 | null;
  readonly hash: Sha256;
  readonly event: RunEvent;
}

/** The class of an event is the join of the classes of the bodies it references. Control events are D0. */
export function eventClass(e: RunEvent): DataClass {
  switch (e.t) {
    case "run.started":
      return join(e.input.cls, ...e.history.map((h) => h.cls));
    case "model.requested":
      return e.prompt.cls;
    case "model.completed":
      return join(e.output.cls, ...e.toolCalls.map((c) => c.args.cls), ...(e.providerState ? [e.providerState.cls] : []));
    case "tool.requested":
      return e.input.cls;
    case "tool.completed":
      return e.output.cls;
    case "inbox.consumed":
      return e.item.t === "steer" ? e.item.text.cls : "D0";
    case "run.faulted":
      return reasonClass(e.reason);
    case "run.finished":
      return join(e.answer?.cls ?? "D0", e.reason ? reasonClass(e.reason) : "D0");
    case "model.failed":
    case "tool.failed":
      return e.failure.detail?.cls ?? "D0";
    case "agent.session":
      return e.refusedTargets?.cls ?? "D0";
    case "tool.outcome-unknown":
    case "tool.withheld":
    case "egress.refused":
    case "egress.redirected":
    case "confirm.asked":
    case "stop.asked":
    case "stop":
    case "limit.hit":
    case "reply.posted":
      return "D0";
    default: {
      const never: never = e;
      return never;
    }
  }
}

function reasonClass(r: FailureReason): DataClass {
  if (r.t === "agent-not-confined") return r.why.cls;
  return r.t === "retries-exhausted" && r.error ? r.error.cls : "D0";
}

export function eventHash(runId: RunId, seq: number, at: string, cls: DataClass, prevHash: Sha256 | null, event: RunEvent): Sha256 {
  return sha256(canonicalJson({ runId, seq, at, cls, prev: prevHash, event }));
}

/**
 * Sink every gateway and tool call writes through. Inside a run it is the
 * RunJournal. Outside a run (KB compile, router before a run exists, publish
 * checks) it is the audit stream. There is no model call without one.
 */
export interface CallRecorder {
  record(e: RunEvent): Promise<void>;
  put(content: Labelled<unknown>): Promise<PayloadRef>;
}

/** Handle owned by the current lease holder. Opened by the worker for the job it leased; a stale handle fails on its first append. */
export interface RunJournal extends CallRecorder {
  readonly runId: RunId;
  readonly epoch: number;
  /** Fenced append. Rejects with LeaseLost if the epoch moved or seq is taken. Returns the stored, chained event. */
  append(e: RunEvent): Promise<StoredEvent>;
  events(): readonly StoredEvent[];
  get(ref: PayloadRef): Promise<Labelled<unknown>>;
  /** Unconsumed inbox rows, oldest first. The loop journals each with inbox.consumed before acting on it. */
  pendingInbox(): Promise<readonly { readonly id: string; readonly item: InboxItem }[]>;
  /** inbox.consumed plus the consumed_seq mark, in one fenced transaction. */
  consumeInbox(inboxId: string, item: InboxItem): Promise<StoredEvent>;
}

export class LeaseLost extends Error {
  constructor(runId: RunId, epoch: number, seq: number) {
    super(`lease lost: run ${runId} epoch ${epoch} could not append seq ${seq}`);
    this.name = "LeaseLost";
  }
}

export class StoreRefused extends Error {
  readonly refusal: EgressRefusal;
  constructor(refusal: EgressRefusal) {
    super(`payload store refused: ${describeRefusal(refusal)}`);
    this.name = "StoreRefused";
    this.refusal = refusal;
  }
}

/** The stored chain does not verify, or does not end at the head the job row anchors. Nothing is appended to a corrupt record. */
export class RecordCorrupt extends Error {
  readonly runId: RunId;
  constructor(runId: RunId, detail: string) {
    super(`run ${runId} record is corrupt: ${detail}`);
    this.name = "RecordCorrupt";
    this.runId = runId;
  }
}

/** A body the run needs cannot be read back. Terminal: the run cannot be continued without it. */
export class PayloadUnavailable extends Error {
  readonly hash: PayloadHash;
  /** class-mismatch: the row's class is not the ref's, which the address rules out unless the row was tampered with. */
  readonly why: "redacted" | "missing" | "key-mismatch" | "class-mismatch";
  constructor(hash: PayloadHash, why: PayloadUnavailable["why"]) {
    super(`payload ${hash} is ${why === "key-mismatch" ? "under another key" : why === "class-mismatch" ? "stored at another class than the ref names" : why}`);
    this.name = "PayloadUnavailable";
    this.hash = hash;
    this.why = why;
  }
}

export type Redacted = { readonly redacted: true; readonly hash: PayloadHash; readonly cls: DataClass };

/**
 * Content-addressed by (class, plaintext), encrypted at rest. put() takes
 * only a genuine Labelled and checks decideEgress(content, {kind:"store"})
 * against the DB placement. Because the class is part of the address, one
 * row never spans two classes: "thanks" stored by a D3 channel and "thanks"
 * stored by a D0 run are two rows, and the D0 run reads back D0.
 */
export interface PayloadStore {
  put(content: Labelled<unknown>): Promise<PayloadRef>;
  /** The address put() gives a value at a class. Names derived from bodies (KB entries and snapshots) use it too. */
  readonly address: Addresser;
  /** The body at the ref's class, which its address commits to. */
  get(ref: PayloadRef): Promise<Labelled<unknown> | Redacted>;
  /** Deletes bodies past their class's retention. Events keep hashes. Idempotent. */
  sweepRetention(now: Date): Promise<number>;
}

export interface StoreConfig {
  readonly placement: Placement;
  readonly policy: EgressPolicy;
  /** 32 bytes. The master key: the address and cipher subkeys derive from it and it is never used directly. key_id names it on every row. */
  readonly key: Uint8Array;
  readonly keyId: string;
}

const GCM_TAG_BYTES = 16;
/** HKDF info for the cipher subkey. Fixed for the life of the data; the address subkey's is in hash.ts. */
const CIPHER_INFO = "labh:payload:cipher:v1";

export function createPayloadStore(db: Db, config: StoreConfig): PayloadStore {
  if (config.key.length !== 32) throw new Error("payload key must be 32 bytes");
  const cipherKey = Buffer.from(hkdfSync("sha256", config.key, "", CIPHER_INFO, 32));
  const address = keyedAddresser(config.key);
  return {
    address,
    async put(content) {
      const decision = decideEgress(content, { kind: "store", placement: config.placement }, config.policy);
      if (!decision.allow) throw new StoreRefused(decision.refusal);
      const plaintext = Buffer.from(canonicalJson(content.value), "utf8");
      // Keyed: the address is in events that leave the store (the run record, the web API), so an unkeyed
      // digest would let anyone confirm a guessed body (a participant id) against it.
      const hash = address(content.cls, content.value) as string as PayloadHash;
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", cipherKey, nonce);
      cipher.setAAD(Buffer.from(hash));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      // The same bytes at the same class are one row already; at another class the address differs.
      await db.query(
        `insert into payloads (hash, cls, ciphertext, nonce, key_id, bytes) values ($1, $2, $3, $4, $5, $6)
         on conflict (hash) do nothing`,
        [hash, content.cls, ciphertext, nonce, config.keyId, plaintext.length],
      );
      return { hash, cls: content.cls, bytes: plaintext.length };
    },
    async get(ref) {
      const res = await db.query<{ cls: DataClass; ciphertext: Buffer | null; nonce: Buffer | null; key_id: string | null }>(
        "select cls, ciphertext, nonce, key_id from payloads where hash = $1",
        [ref.hash],
      );
      const row = res.rows[0];
      if (!row) throw new PayloadUnavailable(ref.hash, "missing");
      if (row.cls !== ref.cls) throw new PayloadUnavailable(ref.hash, "class-mismatch");
      if (!row.ciphertext || !row.nonce) return { redacted: true, hash: ref.hash, cls: ref.cls };
      if (row.key_id !== config.keyId) throw new PayloadUnavailable(ref.hash, "key-mismatch");
      const decipher = createDecipheriv("aes-256-gcm", cipherKey, row.nonce);
      decipher.setAAD(Buffer.from(ref.hash));
      decipher.setAuthTag(row.ciphertext.subarray(row.ciphertext.length - GCM_TAG_BYTES));
      const plaintext = Buffer.concat([decipher.update(row.ciphertext.subarray(0, row.ciphertext.length - GCM_TAG_BYTES)), decipher.final()]);
      return Labelled.stamp(JSON.parse(plaintext.toString("utf8")) as unknown, ref.cls, `store:${ref.hash}`);
    },
    async sweepRetention() {
      throw new Error("retention sweep is not part of this build");
    },
  };
}

export interface Lease {
  readonly runId: RunId;
  readonly epoch: number;
  readonly owner: string;
}

interface EventRow {
  run_id: string;
  seq: number;
  at: Date;
  cls: DataClass;
  prev_hash: string | null;
  hash: string;
  event: RunEvent;
}

function fromRow(r: EventRow): StoredEvent {
  return { runId: r.run_id as RunId, seq: r.seq, at: r.at.toISOString(), cls: r.cls, prevHash: r.prev_hash as Sha256 | null, hash: r.hash as Sha256, event: r.event };
}

export async function loadEvents(db: Db, runId: RunId): Promise<StoredEvent[]> {
  const res = await db.query<EventRow>("select run_id, seq, at, cls, prev_hash, hash, event from run_events where run_id = $1 order by seq", [runId]);
  return res.rows.map(fromRow);
}

/**
 * The job row is locked first, so the fence is evaluated after any claim
 * that is in flight commits (a plain existence check read its own snapshot
 * and let a stale holder's event land behind a new claim). The insert then
 * happens only for a held lease, and the same statement moves the job's
 * chain anchor to the new head.
 */
const FENCED_APPEND = `
  with lease as (
    select id from jobs where id = $1 and lease_epoch = $8 and lease_owner = $9 for update),
  ins as (
    insert into run_events (run_id, seq, at, cls, prev_hash, hash, event)
    select $1, $2, $3, $4, $5, $6, $7 from lease
    returning seq, hash)
  update jobs set head_seq = ins.seq, head_hash = ins.hash from ins where jobs.id = $1`;

/**
 * Opens the journal for a job the caller has leased, with the chain loaded
 * and verified: every hash recomputes, and the last event is the head the
 * job row anchors. A record that fails either is refused, not extended.
 */
export async function openJournal(db: Db, store: PayloadStore, lease: Lease): Promise<RunJournal> {
  const events = await loadEvents(db, lease.runId);
  const bad = verifyChain(events);
  if (bad !== null) throw new RecordCorrupt(lease.runId, `seq ${bad} does not verify`);
  const anchor = (await db.query<{ head_seq: number | null; head_hash: string | null }>("select head_seq, head_hash from jobs where id = $1", [lease.runId])).rows[0];
  const head = events.at(-1);
  if ((anchor?.head_seq ?? null) !== (head?.seq ?? null) || (anchor?.head_hash ?? null) !== (head?.hash ?? null)) {
    throw new RecordCorrupt(lease.runId, `anchor is seq ${anchor?.head_seq ?? "none"} but the stored chain ends at seq ${head?.seq ?? "none"}`);
  }
  const runFenced = async (q: { query: Db["query"] }, e: RunEvent): Promise<StoredEvent> => {
    const seq = events.length;
    const prev = events[seq - 1]?.hash ?? null;
    const at = new Date().toISOString();
    const cls = eventClass(e);
    const hash = eventHash(lease.runId, seq, at, cls, prev, e);
    let rowCount: number | null;
    try {
      rowCount = (await q.query(FENCED_APPEND, [lease.runId, seq, at, cls, prev, hash, e, lease.epoch, lease.owner])).rowCount;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new LeaseLost(lease.runId, lease.epoch, seq);
      throw err;
    }
    if (!rowCount) throw new LeaseLost(lease.runId, lease.epoch, seq);
    const stored: StoredEvent = { runId: lease.runId, seq, at, cls, prevHash: prev, hash, event: e };
    events.push(stored);
    return stored;
  };
  return {
    runId: lease.runId,
    epoch: lease.epoch,
    append: (e) => runFenced(db, e),
    async record(e) {
      await runFenced(db, e);
    },
    put: (content) => store.put(content),
    events: () => events,
    async get(ref) {
      const body = await store.get(ref);
      if ("redacted" in body) throw new PayloadUnavailable(ref.hash, "redacted");
      return body;
    },
    async pendingInbox() {
      const res = await db.query<{ id: string; item: InboxItem }>("select id, item from run_inbox where run_id = $1 and consumed_seq is null order by at, id", [lease.runId]);
      return res.rows;
    },
    async consumeInbox(inboxId, item) {
      const client = await db.connect();
      let appended = false;
      try {
        await client.query("begin");
        const stored = await runFenced(client, { t: "inbox.consumed", inboxId, item });
        appended = true;
        await client.query("update run_inbox set consumed_seq = $3 where id = $1 and run_id = $2 and consumed_seq is null", [inboxId, lease.runId, stored.seq]);
        await client.query("commit");
        return stored;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        // Only an event this call pushed is rolled back with the transaction; a failure before the insert touched nothing.
        if (appended && !(err instanceof LeaseLost)) events.pop();
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Front doors write here, never to run_events. A stop also notifies the lease
 * holder, with whether it is confirmed, so the holder can abort an in-flight
 * call when the stop is one that ends the run (loop.ts stopAborts).
 */
export async function sendToInbox(db: Db, runId: RunId, item: InboxItem): Promise<string> {
  const res = await db.query<{ id: string }>("insert into run_inbox (run_id, item) values ($1, $2) returning id", [runId, item]);
  await db.query("update jobs set not_before = now(), status = 'queued' where id = $1 and status = 'waiting'", [runId]);
  if (item.t === "stop") await db.query("select pg_notify('run_stop', $1)", [stopNotification(runId, item.confirmed)]);
  return res.rows[0]!.id;
}

export interface StopNotice {
  readonly runId: RunId;
  readonly confirmed: boolean;
}

export function stopNotification(runId: RunId, confirmed: boolean): string {
  return `${runId}:${confirmed ? "confirmed" : "unconfirmed"}`;
}

export function parseStopNotification(payload: string): StopNotice | null {
  const m = /^([0-9a-f-]{36}):(confirmed|unconfirmed)$/.exec(payload);
  return m ? { runId: m[1] as RunId, confirmed: m[2] === "confirmed" } : null;
}

/** Everything next() needs, derived from events alone. Holds refs, not bodies. */
export interface RunState {
  readonly runId: RunId;
  readonly agent: AgentVersionHash;
  readonly kind: "interactive" | "background";
  readonly surface: string;
  readonly threadId: string;
  readonly startedAt: number;
  readonly cls: DataClass;
  /** Completed model steps. */
  readonly steps: number;
  readonly tokens: number;
  readonly transcript: readonly TranscriptItem[];
  /** The latest model step and how its attempts went. */
  readonly modelCall: ModelCallState | null;
  /** Tool calls the latest completed output asked for, in order, with what has happened to each. */
  readonly toolCalls: readonly ToolCallState[];
  readonly confirmed: ReadonlyMap<string, boolean>;
  readonly stop: "none" | "requested-unconfirmed" | "confirmed";
  readonly stopBy: string | null;
  readonly stopAsked: boolean;
  readonly stopRecorded: boolean;
  readonly refused: EgressRefusal | null;
  /** Set by run.faulted. From then on the only actions are the failure notice and the finish. */
  readonly fault: FailureReason | null;
  readonly limitHit: "steps" | "tokens" | "wall" | null;
  readonly finalCalled: boolean;
  readonly answer: PayloadRef | null;
  readonly replied: boolean;
  readonly finished: RunOutcome | null;
}

export interface ModelCallState {
  readonly step: number;
  readonly attempts: number;
  readonly final: boolean;
  readonly status: "open" | "failed" | "completed";
  readonly lastFailure: { readonly at: number; readonly retryable: boolean; readonly failure: CallFailure } | null;
}

export interface ToolCallState {
  readonly callId: string;
  readonly tool: string;
  readonly input: PayloadRef;
  readonly attempts: number;
  readonly status: "pending" | "open" | "failed" | "resolved";
  readonly lastFailure: { readonly at: number; readonly retryable: boolean; readonly failure: CallFailure } | null;
  readonly confirmAsked: boolean;
}

export type TranscriptItem =
  | { readonly role: "user" | "steer"; readonly content: PayloadRef }
  | { readonly role: "assistant"; readonly content: PayloadRef; readonly toolCalls: readonly ToolCallRef[]; readonly providerState?: PayloadRef }
  | { readonly role: "tool"; readonly callId: string; readonly name: string; readonly result: ToolResult };

export type ToolResult = { readonly t: "output"; readonly content: PayloadRef } | { readonly t: "error"; readonly failure: CallFailure } | { readonly t: "unknown" };

/** Attempts per call before the error goes to the agent. loop.ts RETRY.maxAttempts is the same number; both read it from here. */
export const MAX_ATTEMPTS = 3;

/** Pure. Total over any valid event list, including one cut off by a crash at any point. cls = join of every event's cls. */
export function fold(events: readonly StoredEvent[]): RunState {
  const first = events[0];
  if (!first || first.event.t !== "run.started") throw new Error("fold: event 0 must be run.started");
  const started = first.event;
  const s = {
    runId: first.runId,
    agent: started.agent,
    kind: started.kind,
    surface: started.surface,
    threadId: started.threadId,
    startedAt: Date.parse(first.at),
    cls: first.cls,
    steps: 0,
    tokens: 0,
    transcript: [{ role: "user", content: started.input }] as TranscriptItem[],
    modelCall: null as ModelCallState | null,
    toolCalls: [] as ToolCallState[],
    confirmed: new Map<string, boolean>(),
    stop: "none" as RunState["stop"],
    stopBy: null as string | null,
    stopAsked: false,
    stopRecorded: false,
    refused: null as EgressRefusal | null,
    fault: null as FailureReason | null,
    limitHit: null as RunState["limitHit"],
    finalCalled: false,
    answer: null as PayloadRef | null,
    replied: false,
    finished: null as RunOutcome | null,
  };
  const toolCall = (callId: string) => s.toolCalls.find((c) => c.callId === callId);
  const patchTool = (callId: string, patch: Partial<ToolCallState>) => {
    s.toolCalls = s.toolCalls.map((c) => (c.callId === callId ? { ...c, ...patch } : c));
  };
  for (const stored of events.slice(1)) {
    const e = stored.event;
    const at = Date.parse(stored.at);
    s.cls = join(s.cls, stored.cls);
    switch (e.t) {
      case "run.started":
        throw new Error(`fold: second run.started at seq ${stored.seq}`);
      case "model.requested":
        s.modelCall = { step: e.step, attempts: e.attempt, final: e.final, status: "open", lastFailure: null };
        if (e.final) s.finalCalled = true;
        break;
      case "model.completed": {
        s.steps += 1;
        s.tokens += e.usage.input + e.usage.output;
        s.transcript.push({ role: "assistant", content: e.output, toolCalls: e.toolCalls, ...(e.providerState ? { providerState: e.providerState } : {}) });
        const final = s.modelCall?.final ?? false;
        s.modelCall = { step: e.step, attempts: e.attempt, final, status: "completed", lastFailure: null };
        if (e.toolCalls.length === 0 || final) {
          s.answer = e.output;
          s.toolCalls = [];
        } else {
          s.toolCalls = e.toolCalls.map((c) => ({ callId: c.id, tool: c.name, input: c.args, attempts: 0, status: "pending", lastFailure: null, confirmAsked: false }));
        }
        break;
      }
      case "model.failed":
        s.modelCall = { step: e.step, attempts: e.attempt, final: s.modelCall?.final ?? false, status: "failed", lastFailure: { at, retryable: e.retryable, failure: e.failure } };
        break;
      case "tool.requested":
        patchTool(e.callId, { attempts: e.attempt, status: "open" });
        break;
      case "tool.completed": {
        const c = toolCall(e.callId);
        if (c) {
          patchTool(e.callId, { status: "resolved" });
          s.transcript.push({ role: "tool", callId: e.callId, name: c.tool, result: { t: "output", content: e.output } });
        }
        break;
      }
      case "tool.failed": {
        const c = toolCall(e.callId);
        if (c) {
          const exhausted = !e.retryable || e.attempt >= MAX_ATTEMPTS;
          patchTool(e.callId, { status: exhausted ? "resolved" : "failed", lastFailure: { at, retryable: e.retryable, failure: e.failure } });
          if (exhausted) s.transcript.push({ role: "tool", callId: e.callId, name: c.tool, result: { t: "error", failure: e.failure } });
        }
        break;
      }
      case "tool.outcome-unknown": {
        const c = toolCall(e.callId);
        if (c) {
          patchTool(e.callId, { status: "resolved" });
          s.transcript.push({ role: "tool", callId: e.callId, name: c.tool, result: { t: "unknown" } });
        }
        break;
      }
      case "egress.refused":
        s.refused = e.refusal;
        break;
      // A session folds as one model call: its bridged tool events name callIds no model.completed lists, and a
      // withheld result is the run going on, not a refused run.
      case "tool.withheld":
      case "agent.session":
      case "egress.redirected":
        break;
      case "confirm.asked":
        patchTool(e.callId, { confirmAsked: true });
        break;
      case "inbox.consumed":
        switch (e.item.t) {
          case "stop":
            s.stopBy = e.item.by;
            s.stop = e.item.confirmed || s.steps === 0 || s.stop === "requested-unconfirmed" ? "confirmed" : "requested-unconfirmed";
            break;
          case "steer":
            s.transcript.push({ role: "steer", content: e.item.text });
            break;
          case "confirm":
            s.confirmed.set(e.item.callId, e.item.approve);
            break;
          case "feedback":
            break;
        }
        break;
      case "stop.asked":
        s.stopAsked = true;
        break;
      case "stop":
        s.stopRecorded = true;
        break;
      case "limit.hit":
        s.limitHit = e.which;
        break;
      case "reply.posted":
        s.replied = true;
        break;
      case "run.faulted":
        s.fault = e.reason;
        break;
      case "run.finished":
        s.finished = e.outcome;
        break;
      default: {
        const never: never = e;
        throw new Error(`fold: unknown event ${JSON.stringify(never)}`);
      }
    }
  }
  return s;
}

/** Recomputes the chain. Returns the first bad seq, or null. Used by tests, audit replay and bundle import. */
export function verifyChain(events: readonly StoredEvent[]): number | null {
  let prev: Sha256 | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== i || e.prevHash !== prev || e.cls !== eventClass(e.event)) return i;
    if (e.hash !== eventHash(e.runId, e.seq, e.at, e.cls, e.prevHash, e.event)) return i;
    prev = e.hash;
  }
  return null;
}

/** W3C PROV-JSON projection of a run. Derived, never stored. */
export function toProv(_events: readonly StoredEvent[]): unknown {
  throw new Error("PROV export is not part of this build");
}
