/**
 * The audit stream: one hash-chained, append-only log for what happens
 * outside a run. Publishing an agent or a KB, gateway calls made before or without a run (KB compile now;
 * router and publish checks later), and HTTP refusals for KB URL sources, record here through the same CallRecorder
 * a run journal implements, so a refusal is recorded in exactly one place
 * whichever side made the call.
 *
 *   audit_events(seq, at, actor, prev_hash, hash, event jsonb)
 *
 * Events hold PayloadRefs, never bodies: a compile prompt holding D3 source
 * text is in the payload store, and the audit row holds its hash and class.
 * Appends take one transaction-scoped advisory lock, so concurrent writers
 * cannot fork the chain.
 */

import type { AgentId } from "./agent.ts";
import type { DataClass, EgressRefusal } from "./dataclass.ts";
import type { Db, Tx } from "./db.ts";
import { canonicalJson, sha256, type AgentVersionHash, type Sha256, type SnapshotId } from "./hash.ts";
import type { CallRecorder, PayloadStore, RunEvent } from "./record.ts";

/** What an out-of-run call was for: a compile job's model call, or reading a KB's URL source before the job exists. */
export type CallContext =
  | { readonly t: "kb-compile"; readonly job: string; readonly kbId: string; readonly step: { readonly t: "source"; readonly sourceId: string } | { readonly t: "coverage"; readonly question: string } }
  | { readonly t: "kb-source"; readonly kbId: string; readonly sourceId: string };

export type AuditEvent =
  | { readonly t: "call"; readonly context: CallContext; readonly event: RunEvent }
  | { readonly t: "kb.compiled"; readonly job: string; readonly kbId: string; readonly snapshot: SnapshotId; readonly cls: DataClass; readonly gaps: readonly string[] }
  | { readonly t: "kb.compile-failed"; readonly job: string; readonly kbId: string; readonly reason: string; readonly refusal: EgressRefusal | null }
  | { readonly t: "kb.published"; readonly kbId: string; readonly snapshot: SnapshotId; readonly override?: { readonly note: string; readonly gaps: readonly string[] } }
  | { readonly t: "kb.publish-refused"; readonly kbId: string; readonly snapshot: SnapshotId; readonly gaps: readonly string[] }
  | { readonly t: "agent.published"; readonly agentId: AgentId; readonly version: AgentVersionHash; readonly previous: AgentVersionHash | null; readonly draftHash: Sha256; readonly changelog: string };

export interface AuditRow {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  readonly prevHash: Sha256 | null;
  readonly hash: Sha256;
  readonly event: AuditEvent;
}

/** Any constant works; it names the one lock every audit append takes. */
const AUDIT_LOCK = 7_204_119;

export function auditHash(at: string, actor: string, prevHash: Sha256 | null, event: AuditEvent): Sha256 {
  return sha256(canonicalJson({ at, actor, prev: prevHash, event }));
}

/** Appends one event. `alsoInTx` runs in the same transaction after the insert, so a state change and its audit row commit together. */
export async function appendAudit(db: Db, actor: string, event: AuditEvent, alsoInTx?: (tx: Tx, row: AuditRow) => Promise<void>): Promise<AuditRow> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const row = await appendAuditInTx(client, actor, event);
    if (alsoInTx) await alsoInTx(client, row);
    await client.query("commit");
    return row;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** Appends one event inside the caller's open transaction, for a caller whose event depends on rows it reads under its own lock. */
export async function appendAuditInTx(tx: Tx, actor: string, event: AuditEvent): Promise<AuditRow> {
  await tx.query("select pg_advisory_xact_lock($1)", [AUDIT_LOCK]);
  const last = await tx.query<{ hash: Sha256 }>("select hash from audit_events order by seq desc limit 1");
  const prevHash = last.rows[0]?.hash ?? null;
  const at = new Date().toISOString();
  const hash = auditHash(at, actor, prevHash, event);
  const inserted = await tx.query<{ seq: string }>("insert into audit_events (at, actor, prev_hash, hash, event) values ($1, $2, $3, $4, $5) returning seq", [at, actor, prevHash, hash, event]);
  return { seq: Number(inserted.rows[0]!.seq), at, actor, prevHash, hash, event };
}

/** The CallRecorder for gateway calls outside a run: bodies to the payload store, events to the audit stream. */
export function auditRecorder(db: Db, store: PayloadStore, actor: string, context: CallContext): CallRecorder {
  return {
    async record(event) {
      await appendAudit(db, actor, { t: "call", context, event });
    },
    put: (content) => store.put(content),
  };
}

export async function loadAudit(db: Db, sinceSeq = 0): Promise<AuditRow[]> {
  const res = await db.query<{ seq: string; at: Date; actor: string; prev_hash: Sha256 | null; hash: Sha256; event: AuditEvent }>(
    "select seq, at, actor, prev_hash, hash, event from audit_events where seq > $1 order by seq",
    [sinceSeq],
  );
  return res.rows.map((r) => ({ seq: Number(r.seq), at: r.at.toISOString(), actor: r.actor, prevHash: r.prev_hash, hash: r.hash, event: r.event }));
}

/** Recomputes the chain over a full load. Returns the seq of the first bad row, or null. */
export function verifyAudit(rows: readonly AuditRow[]): number | null {
  let prev: Sha256 | null = null;
  for (const r of rows) {
    if (r.prevHash !== prev || r.hash !== auditHash(r.at, r.actor, r.prevHash, r.event)) return r.seq;
    prev = r.hash;
  }
  return null;
}
