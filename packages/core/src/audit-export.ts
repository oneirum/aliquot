/**
 * `aliquot audit export`: the audit stream and every run record as JSON lines, for syslog or a SIEM forwarder.
 *
 * One line per stored event, in export_seq order (migration 0009), which is commit order across both tables, so a
 * reader that resumes after the last seq it printed misses nothing and repeats nothing. A line is a projection, never
 * the stored event: ids, classes, hashes, actors, refusal codes and the hash, class and size of each payload an event
 * references. Free text an event carries (a changelog, an override note, a failure reason, a URL's path and query, an
 * untraced number) is left out, so the forwarder holds nothing above D0 whatever the events were about.
 *
 * Line format, version 1. Every key is always present, in this order; detail holds the scalars named in DETAIL_KEYS.
 *   {"v":1,"seq":n,"at":iso,"stream":"audit"|"run","type":t,"actor":s|null,"run":uuid|null,"runSeq":n|null,
 *    "cls":"D0".."D3"|null,"hash":hex,"prevHash":hex|null,"refs":[{"hash","cls","bytes"}],"refusal":{...}|null,"detail":{...}}
 */

import type { AuditEvent } from "./audit.ts";
import type { DataClass, EgressRefusal } from "./dataclass.ts";
import type { Db } from "./db.ts";
import { eventClass, type PayloadRef, type RunEvent } from "./record.ts";

export const EXPORT_FORMAT = 1;

type Scalar = string | number | boolean | null;

export interface ExportLine {
  readonly v: typeof EXPORT_FORMAT;
  readonly seq: number;
  readonly at: string;
  readonly stream: "audit" | "run";
  readonly type: string;
  readonly actor: string | null;
  readonly run: string | null;
  readonly runSeq: number | null;
  readonly cls: DataClass | null;
  readonly hash: string;
  readonly prevHash: string | null;
  readonly refs: readonly PayloadRef[];
  readonly refusal: Readonly<Record<string, string>> | null;
  readonly detail: Readonly<Record<string, Scalar>>;
}

/** Where an export starts: after a seq a previous export printed, or at the first event at or after a time. */
export type ExportFrom = { readonly t: "seq"; readonly after: number } | { readonly t: "time"; readonly at: Date };

export function parseSince(text: string): ExportFrom | null {
  if (/^\d+$/.test(text)) return { t: "seq", after: Number(text) };
  // A date or a date-time; a bare number is a seq, above.
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : { t: "time", at };
}

const CLASSES = new Set(["D0", "D1", "D2", "D3"]);
const isRef = (v: Record<string, unknown>): boolean => typeof v.hash === "string" && typeof v.bytes === "number" && typeof v.cls === "string" && CLASSES.has(v.cls);

/** Every payload ref anywhere in the event, as hash, class and size only, in the order they appear. */
function refsOf(value: unknown, out: PayloadRef[] = []): PayloadRef[] {
  if (Array.isArray(value)) for (const v of value) refsOf(v, out);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (isRef(o)) out.push({ hash: o.hash, cls: o.cls, bytes: o.bytes } as PayloadRef);
    else for (const v of Object.values(o)) refsOf(v, out);
  }
  return out;
}

/** The fields an EgressRefusal may carry, every one a code, a class, a placement, a host or a model id. */
const REFUSAL_KEYS = ["code", "payload", "ceiling", "clearance", "placement", "host", "modelId"] as const;

function refusalOf(value: unknown): Record<string, string> | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = refusalOf(v);
      if (r) return r;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const r = o.refusal as Partial<Record<(typeof REFUSAL_KEYS)[number], unknown>> | null | undefined;
  if (r && typeof r === "object" && typeof r.code === "string") {
    const kept: Record<string, string> = {};
    for (const k of REFUSAL_KEYS) if (typeof r[k] === "string") kept[k] = r[k];
    return kept;
  }
  for (const v of Object.values(o)) {
    const found = refusalOf(v);
    if (found) return found;
  }
  return null;
}

/** A destination or redirect hop as its host only: a URL's path and query can carry what the call was about. */
function hostOf(text: string): string | null {
  try {
    const u = new URL(text);
    if (u.protocol === "http:" || u.protocol === "https:") return u.host;
  } catch {}
  return /^[a-z-]+:[\w.-]{1,200}$/i.test(text) ? text : null;
}

function runDetail(e: RunEvent): { readonly actor: string | null; readonly detail: Record<string, Scalar> } {
  switch (e.t) {
    case "run.started": {
      const tr = e.trigger;
      const actor = tr.t === "message" || tr.t === "test" ? tr.memberId : tr.t === "schedule" ? `schedule:${tr.scheduleId}` : tr.t === "replay" ? `replay:${tr.of}` : `eval:${tr.publishTicket}`;
      return { actor, detail: { agent: e.agent, kind: e.kind, trigger: tr.t, surface: e.surface, route: e.route.t, studyId: e.studyId, history: e.history.length } };
    }
    case "model.requested":
      return { actor: null, detail: { step: e.step, attempt: e.attempt, endpoint: e.target.endpointId, model: e.target.modelId, final: e.final } };
    case "model.completed":
      return { actor: null, detail: { step: e.step, attempt: e.attempt, model: e.providerModelId, toolCalls: e.toolCalls.length, inputTokens: e.usage.input, outputTokens: e.usage.output, ms: e.ms } };
    case "model.failed":
      return { actor: null, detail: { step: e.step, attempt: e.attempt, failure: e.failure.code, retryable: e.retryable } };
    case "tool.requested":
      return { actor: null, detail: { callId: e.callId, attempt: e.attempt, tool: e.tool, toolHash: e.hash } };
    case "tool.completed":
      return { actor: null, detail: { callId: e.callId, attempt: e.attempt, ms: e.ms, retrieved: (e.retrieved ?? []).reduce((n, r) => n + r.entries.length, 0) } };
    case "tool.failed":
      return { actor: null, detail: { callId: e.callId, attempt: e.attempt, failure: e.failure.code, retryable: e.retryable } };
    case "tool.outcome-unknown":
    case "confirm.asked":
      return { actor: null, detail: { callId: e.callId } };
    case "tool.withheld":
      return { actor: null, detail: { callId: e.callId, withheldCls: e.cls } };
    case "agent.session":
      return {
        actor: null,
        detail: { attempt: e.attempt, kind: e.kind, cliVersion: e.cliVersion, argvHash: e.argvHash, exitCode: e.exit.code, exitSignal: e.exit.signal, turns: e.turns, hostsTunneled: e.hostsTunneled.length, hostsRefused: e.hostsRefused },
      };
    case "egress.refused":
      return { actor: null, detail: { destination: hostOf(e.destination), payload: e.payload } };
    case "egress.redirected":
      return { actor: null, detail: { from: hostOf(e.from), to: hostOf(e.to), status: e.status } };
    case "inbox.consumed": {
      const i = e.item;
      return { actor: i.by, detail: { item: i.t, ...(i.t === "confirm" ? { callId: i.callId, approve: i.approve } : i.t === "feedback" ? { value: i.value } : i.t === "stop" ? { confirmed: i.confirmed } : {}) } };
    }
    case "stop":
      return { actor: e.by, detail: { sinceStartMs: e.sinceStartMs } };
    case "limit.hit":
      return { actor: null, detail: { which: e.which } };
    case "reply.posted":
      return { actor: null, detail: { mode: e.mode } };
    case "run.faulted":
      return { actor: null, detail: { reason: e.reason.t } };
    case "run.finished":
      return { actor: null, detail: { outcome: e.outcome, reason: e.reason?.t ?? null, untracedNumbers: e.flags.length } };
    default:
      return { actor: null, detail: {} };
  }
}

function auditDetail(e: AuditEvent): { readonly type: string; readonly cls: DataClass | null; readonly detail: Record<string, Scalar> } {
  switch (e.t) {
    case "call": {
      const c = e.context;
      const inner = runDetail(e.event);
      return { type: e.event.t, cls: eventClass(e.event), detail: { context: c.t, kbId: c.kbId, ...(c.t === "kb-compile" ? { job: c.job } : { sourceId: c.sourceId }), ...inner.detail } };
    }
    case "kb.compiled":
      return { type: e.t, cls: e.cls, detail: { job: e.job, kbId: e.kbId, snapshot: e.snapshot, gaps: e.gaps.length } };
    case "kb.compile-failed":
      return { type: e.t, cls: null, detail: { job: e.job, kbId: e.kbId } };
    case "kb.published":
      return { type: e.t, cls: null, detail: { kbId: e.kbId, snapshot: e.snapshot, overridden: !!e.override, gaps: e.override?.gaps.length ?? 0 } };
    case "kb.publish-refused":
      return { type: e.t, cls: null, detail: { kbId: e.kbId, snapshot: e.snapshot, gaps: e.gaps.length } };
    case "agent.published":
      return { type: e.t, cls: null, detail: { agentId: e.agentId, version: e.version, previous: e.previous, draftHash: e.draftHash } };
    default:
      // An event type this build does not know: its type, refs and refusal, and no fields it cannot vouch for.
      return { type: String((e as { t?: unknown }).t ?? "unknown"), cls: null, detail: {} };
  }
}

interface Row {
  readonly stream: "audit" | "run";
  readonly export_seq: string;
  readonly at: Date;
  readonly actor: string | null;
  readonly run_id: string | null;
  readonly run_seq: number | null;
  readonly cls: DataClass | null;
  readonly prev_hash: string | null;
  readonly hash: string;
  readonly event: AuditEvent | RunEvent;
}

export function toLine(r: Row): ExportLine {
  const base = { v: EXPORT_FORMAT, seq: Number(r.export_seq), at: r.at.toISOString(), stream: r.stream } as const;
  const shared = { hash: r.hash, prevHash: r.prev_hash, refs: refsOf(r.event), refusal: refusalOf(r.event) };
  const type = String((r.event as { t?: unknown }).t ?? "unknown");
  // A stored event of an older or newer shape than this build's types still exports, with its type, refs and refusal.
  const attempt = <T,>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  if (r.stream === "audit") {
    const a = attempt(() => auditDetail(r.event as AuditEvent), { type, cls: null, detail: {} });
    return { ...base, type: a.type, actor: r.actor, run: null, runSeq: null, cls: a.cls, ...shared, detail: a.detail };
  }
  const d = attempt(() => runDetail(r.event as RunEvent), { actor: null, detail: {} });
  return { ...base, type, actor: d.actor, run: r.run_id, runSeq: r.run_seq, cls: r.cls, ...shared, detail: d.detail };
}

const PAGE = `
  select * from (
    select 'audit' as stream, export_seq, at, actor, null::uuid as run_id, null::int as run_seq, null::text as cls, prev_hash, hash, event
      from audit_events where export_seq > $1
    union all
    select 'run', export_seq, at, null, run_id, seq, cls, prev_hash, hash, event
      from run_events where export_seq > $1) e
  order by export_seq limit $2`;

/** The seq to export after: for a time, just before the first event at or after it, read in one snapshot. */
export async function startAfter(db: Db, from: ExportFrom): Promise<number> {
  if (from.t === "seq") return from.after;
  const res = await db.query<{ after: string }>(
    `select coalesce(
       (select min(export_seq) - 1 from (select export_seq from audit_events where at >= $1 union all select export_seq from run_events where at >= $1) s),
       (select greatest((select coalesce(max(export_seq), 0) from audit_events), (select coalesce(max(export_seq), 0) from run_events)))) as after`,
    [from.at],
  );
  return Number(res.rows[0]!.after);
}

/** Up to limit lines after seq `after`, oldest first. */
export async function exportPage(db: Db, after: number, limit = 1000): Promise<ExportLine[]> {
  return (await db.query<Row>(PAGE, [after, limit])).rows.map(toLine);
}

/**
 * Writes every line after `from`; with follow, keeps polling for new ones until the signal aborts. write may return a
 * promise (a slow pipe); the next page waits for it.
 */
export async function exportEvents(db: Db, from: ExportFrom, write: (line: string) => void | Promise<void>, opts: { readonly follow?: boolean; readonly pollMs?: number; readonly signal?: AbortSignal } = {}): Promise<number> {
  let after = await startAfter(db, from);
  for (;;) {
    if (opts.signal?.aborted) return after;
    const page = await exportPage(db, after);
    for (const line of page) {
      await write(JSON.stringify(line));
      after = line.seq;
    }
    if (page.length === 1000) continue;
    if (!opts.follow) return after;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.pollMs ?? 1000);
      opts.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}
