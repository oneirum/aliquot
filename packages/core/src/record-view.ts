/**
 * One run's record as a reader sees it: who answered, how it ended, whether
 * the hash chain holds, and one line per event. The record page and
 * `aliquot record` both print this, so they cannot disagree. Event
 * descriptions name classes, destinations and codes, never payload bodies.
 */

import { describeRefusal } from "./dataclass.ts";
import { describeFailure, verifyChain, type RunEvent, type StoredEvent } from "./record.ts";

export interface RecordView {
  readonly runId: string;
  readonly agent: string | null;
  readonly outcome: string;
  readonly chain: { readonly events: number; readonly firstBad: number | null };
  readonly rows: readonly { readonly seq: number; readonly ms: number; readonly t: RunEvent["t"]; readonly cls: string; readonly detail: string; readonly refused: boolean }[];
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

export function recordView(runId: string, events: readonly StoredEvent[]): RecordView {
  const started = events.find((e) => e.event.t === "run.started")?.event;
  const finished = events.find((e) => e.event.t === "run.finished")?.event;
  const t0 = events.length ? Date.parse(events[0]!.at) : 0;
  return {
    runId,
    agent: started?.t === "run.started" ? started.agent : null,
    outcome: finished?.t === "run.finished" ? finished.outcome : "running",
    chain: { events: events.length, firstBad: verifyChain(events) },
    rows: events.map((e) => ({ seq: e.seq, ms: Date.parse(e.at) - t0, t: e.event.t, cls: e.cls, detail: describeEvent(e.event), refused: e.event.t === "egress.refused" || e.event.t === "tool.withheld" })),
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
    "",
    ...v.rows.map((r) => `${String(r.seq).padStart(3)}  +${String(r.ms).padStart(6)} ms  ${r.t.padEnd(width)}  ${r.cls.padEnd(2)}  ${r.detail}`),
  ].join("\n");
}
