/**
 * One run's record as a reader sees it: who answered, how it ended, whether
 * the hash chain holds, and one line per event. The record page and
 * `aliquot record` both print this, so they cannot disagree. Event
 * descriptions name classes, destinations and codes, never payload bodies.
 */

import { describeRefusal } from "./dataclass.ts";
import type { Db } from "./db.ts";
import { describeFailure, eventRefs, payloadStates, verifyChain, type PayloadState, type RedactionReason, type RunEvent, type StoredEvent } from "./record.ts";
import type { PayloadHash } from "./hash.ts";

export interface RecordView {
  readonly runId: string;
  readonly startedAt: string | null;
  readonly agent: string | null;
  readonly outcome: string;
  readonly chain: { readonly events: number; readonly firstBad: number | null };
  readonly summary: RunSummary;
  readonly rows: readonly { readonly seq: number; readonly ms: number; readonly t: RunEvent["t"]; readonly cls: string; readonly detail: string; readonly refused: boolean }[];
  /** Each body the run names, once, by hash: whether it is still stored, readable here, or redacted. Never the body. */
  readonly bodies: readonly BodyRow[];
}

export type BodyRow = {
  readonly hash: string;
  readonly cls: string;
  readonly bytes: number;
  /** The first event that names it, and what it is to that event. */
  readonly seq: number;
  readonly t: RunEvent["t"];
  readonly role: string;
} & (
  | { readonly state: "stored"; readonly keyId: string | null }
  /** Stored under a key id the process showing the record does not hold. */
  | { readonly state: "unavailable"; readonly keyId: string | null }
  | { readonly state: "redacted"; readonly at: string | null; readonly reason: RedactionReason | null }
  | { readonly state: "missing" }
);

export function bodyRows(events: readonly StoredEvent[], states: ReadonlyMap<PayloadHash, PayloadState>, held: ReadonlySet<string>): BodyRow[] {
  const seen = new Set<string>();
  const rows: BodyRow[] = [];
  for (const e of events) {
    for (const { role, ref } of eventRefs(e.event)) {
      if (seen.has(ref.hash)) continue;
      seen.add(ref.hash);
      const at = { hash: ref.hash, cls: ref.cls, bytes: ref.bytes, seq: e.seq, t: e.event.t, role };
      const s = states.get(ref.hash);
      if (!s) rows.push({ ...at, state: "missing" });
      else if (s.t === "redacted") rows.push({ ...at, state: "redacted", at: s.at, reason: s.reason });
      else rows.push({ ...at, state: s.keyId !== null && held.has(s.keyId) ? "stored" : "unavailable", keyId: s.keyId });
    }
  }
  return rows;
}

/** The record with each body's state, as a process holding `held` key ids sees it. */
export async function recordViewOf(db: Db, runId: string, events: readonly StoredEvent[], held: ReadonlySet<string>): Promise<RecordView> {
  const hashes = [...new Set(events.flatMap((e) => eventRefs(e.event).map((r) => r.ref.hash)))];
  return recordView(runId, events, bodyRows(events, await payloadStates(db, hashes), held));
}

/** One line for a terminal: what a reader of the record can learn about a body without reading it. */
export function describeBody(b: BodyRow): string {
  switch (b.state) {
    case "stored":
      return `stored, encrypted under key ${b.keyId}`;
    case "unavailable":
      return `unavailable here: encrypted under key ${b.keyId ?? "(none)"}, which this process does not hold`;
    case "redacted":
      return b.reason === "retention" && b.at ? `redacted on ${b.at.slice(0, 10)} by the lab's retention window` : "redacted";
    case "missing":
      return "missing from the payload store";
  }
}

/** What a reader asks first: how long, how many calls, what it cost, what it read, what was refused. */
export interface RunSummary {
  readonly ms: number;
  readonly modelCalls: number;
  readonly tokens: { readonly input: number; readonly output: number };
  readonly toolCalls: readonly { readonly tool: string; readonly calls: number }[];
  /** Distinct knowledge base entries any tool returned, cited or not. */
  readonly entriesRetrieved: number;
  readonly refused: number;
  readonly withheld: number;
}

export function summarize(events: readonly StoredEvent[]): RunSummary {
  const tools = new Map<string, number>();
  const entries = new Set<string>();
  let modelCalls = 0, input = 0, output = 0, refused = 0, withheld = 0;
  for (const { event: e } of events) {
    if (e.t === "model.completed") { modelCalls++; input += e.usage.input; output += e.usage.output; }
    else if (e.t === "tool.requested") tools.set(e.tool, (tools.get(e.tool) ?? 0) + 1);
    else if (e.t === "tool.completed") for (const r of e.retrieved ?? []) for (const h of r.entries) entries.add(h);
    else if (e.t === "egress.refused") refused++;
    else if (e.t === "tool.withheld") withheld++;
  }
  return {
    ms: events.length ? Date.parse(events.at(-1)!.at) - Date.parse(events[0]!.at) : 0,
    modelCalls,
    tokens: { input, output },
    toolCalls: [...tools].map(([tool, calls]) => ({ tool, calls })),
    entriesRetrieved: entries.size,
    refused,
    withheld,
  };
}

/** One line for a terminal: `2 model calls, 30 tokens in, 15 out; tools kb_search, kb_read; 3 entries retrieved; 0 refused`. */
export function formatSummary(s: RunSummary): string {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const tools = s.toolCalls.length ? `tools ${s.toolCalls.map((t) => (t.calls > 1 ? `${t.tool} x${t.calls}` : t.tool)).join(", ")}` : "no tool calls";
  const parts = [`${s.ms} ms`, n(s.modelCalls, "model call"), `${s.tokens.input} tokens in, ${s.tokens.output} out`, tools, n(s.entriesRetrieved, "entry retrieved", "entries retrieved"), `${s.refused} refused`];
  if (s.withheld) parts.push(`${s.withheld} withheld`);
  return parts.join("; ");
}

export function describeEvent(e: RunEvent): string {
  switch (e.t) {
    case "run.started":
      return `${e.surface} thread, trigger ${e.trigger.t}, ${e.history.length} earlier turns`;
    case "model.requested":
      return `to ${e.target.endpointId}, model ${e.target.modelId}, step ${e.step}${e.attempt > 1 ? `, attempt ${e.attempt}` : ""}${e.final ? ", final" : ""}`;
    case "model.completed":
      return `served by ${e.providerModelId}, ${e.usage.input} tokens in, ${e.usage.output} out, ${e.ms} ms${e.toolCalls.length ? `, asked for ${e.toolCalls.map((c) => c.name).join(", ")}` : ""}`;
    case "model.failed":
    case "tool.failed":
      return `${describeFailure(e.failure)}${e.retryable ? ", will retry" : ""}`;
    case "tool.requested":
      return e.hash ? `${e.tool}, version ${e.hash.slice(0, 12)}` : `${e.tool}, not deployed`;
    case "tool.completed":
      return e.retrieved?.length ? e.retrieved.map((r) => `${r.entries.length} ${r.entries.length === 1 ? "entry" : "entries"} from snapshot ${r.snapshot.slice(0, 12)}${r.truncated ? " (truncated)" : ""}`).join("; ") : `${e.ms} ms`;
    case "tool.outcome-unknown":
      return `call ${e.callId}: the worker stopped before the outcome was written`;
    case "egress.refused":
      return `${e.payload} content to ${e.destination}: ${describeRefusal(e.refusal)}`;
    case "egress.redirected":
      return `followed a ${e.status} from ${e.from} to ${e.to}`;
    case "tool.withheld":
      return `${e.cls} result withheld from the agent: ${describeRefusal(e.refusal)}`;
    case "agent.session":
      return `${e.kind} ${e.cliVersion}, attempt ${e.attempt}, exit ${e.exit.code ?? e.exit.signal}, ${e.turns} tool calls, tunnels to ${e.hostsTunneled.join(", ") || "none"}${e.hostsRefused ? `, ${e.hostsRefused} proxy requests refused` : ""}`;
    case "confirm.asked":
      return `asked the member to confirm call ${e.callId}`;
    case "inbox.consumed":
      return `${e.item.t} from ${e.item.by}`;
    case "stop.asked":
      return "asked the member to confirm the stop";
    case "stop":
      return `by ${e.by} after ${e.sinceStartMs} ms`;
    case "limit.hit":
      return `${e.which} limit`;
    case "reply.posted":
      return e.mode;
    case "run.faulted":
      return e.reason.t === "agent-not-confined" ? `${e.reason.t}: ${e.reason.check}` : e.reason.t;
    case "run.finished":
      return `${e.outcome}${e.reason ? `, ${e.reason.t}` : ""}${e.flags.length ? `, ${e.flags.length} provenance flags` : ""}`;
  }
}

export function recordView(runId: string, events: readonly StoredEvent[], bodies: readonly BodyRow[] = []): RecordView {
  const started = events.find((e) => e.event.t === "run.started")?.event;
  const finished = events.find((e) => e.event.t === "run.finished")?.event;
  const t0 = events.length ? Date.parse(events[0]!.at) : 0;
  return {
    runId,
    startedAt: events[0]?.at ?? null,
    agent: started?.t === "run.started" ? started.agent : null,
    outcome: finished?.t === "run.finished" ? finished.outcome : "running",
    chain: { events: events.length, firstBad: verifyChain(events) },
    summary: summarize(events),
    rows: events.map((e) => ({ seq: e.seq, ms: Date.parse(e.at) - t0, t: e.event.t, cls: e.cls, detail: describeEvent(e.event), refused: e.event.t === "egress.refused" || e.event.t === "tool.withheld" })),
    bodies,
  };
}

/** Plain text for a terminal. */
export function formatRecordView(v: RecordView): string {
  const chain = v.chain.firstBad === null ? `verified: chain intact over ${v.chain.events} events` : `CHAIN BROKEN at event ${v.chain.firstBad}`;
  const width = Math.max(...v.rows.map((r) => r.t.length), 5);
  return [
    `run      ${v.runId}`,
    `agent    ${v.agent ?? "(no run.started)"}`,
    `outcome  ${v.outcome}`,
    `chain    ${chain}`,
    `summary  ${formatSummary(v.summary)}`,
    "",
    ...v.rows.map((r) => `${String(r.seq).padStart(3)}  +${String(r.ms).padStart(6)} ms  ${r.t.padEnd(width)}  ${r.cls.padEnd(2)}  ${r.detail}`),
    ...(v.bodies.length ? ["", "bodies", ...v.bodies.map((b) => `${String(b.seq).padStart(3)}  ${`${b.t} ${b.role}`.padEnd(width + 16)}  ${b.cls.padEnd(2)}  ${`${b.bytes} B`.padStart(8)}  ${b.hash}  ${describeBody(b)}`)] : []),
  ].join("\n");
}

/** One line per run for `aliquot runs`: when it started, which agent version, how it ended, and whether its chain holds. */
export function formatRunList(views: readonly RecordView[]): string {
  if (!views.length) return "no runs in this database";
  const width = Math.max(...views.map((v) => v.outcome.length), 7);
  const when = (at: string | null) => (at ? `${at.slice(0, 19).replace("T", " ")}Z` : "-".padEnd(20));
  return [
    `${"started (UTC)".padEnd(20)}  ${"run".padEnd(36)}  ${"agent".padEnd(12)}  ${"outcome".padEnd(width)}  events  chain`,
    ...views.map((v) =>
      [when(v.startedAt), v.runId, (v.agent?.slice(0, 12) ?? "-").padEnd(12), v.outcome.padEnd(width), String(v.chain.events).padStart(6), v.chain.firstBad === null ? "intact" : `BROKEN at event ${v.chain.firstBad}`].join("  "),
    ),
  ].join("\n");
}
