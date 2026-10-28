/**
 * The durable run loop.
 *
 *   for (;;) {
 *     state  = fold(events)                 record.ts, pure
 *     action = next(state, agent, now)      this file, pure: the whole run policy
 *     execute(action)                       this file, the only IO: one model call, one tool call, or one post
 *   }
 *
 * Crash anywhere -> another worker claims the job, folds the same events, gets
 * the same action. No determinism rules for contributors: only data is replayed.
 *
 * Sanity defaults, encoded here:
 * - 3 attempts per call (RETRY), counted from the journal so a crash does not reset them
 * - stream fallback: finalize() posts the full answer unless the stream was confirmed closed
 * - stop means stop: a stop that ends the run (confirmed, or before step 1) aborts the in-flight
 *   call; an unconfirmed stop after step 1 is asked about and aborts nothing
 * - limits checked between steps; on a hit, one final no-tools call so the agent answers
 */

import { AgentUnavailable, instructionsOf, UnrunnableAgent, verifyRunnable, type Deployed, type ResolvedAgent } from "./agent.ts";
import { Labelled, type EgressPolicy } from "./dataclass.ts";
import { MalformedJob, parseRunJobPayload, postReply, SurfaceUnknown, type Surface } from "./frontdoor.ts";
import { Prompt, type ChatPart, type ModelGateway } from "./gateway.ts";
import type { AgentVersionHash } from "./hash.ts";
import type { KbReader } from "./kb.ts";
import { describeFailure, fold, LeaseLost, MAX_ATTEMPTS, PayloadUnavailable, StoreRefused, type FailureReason, type InboxItem, type PayloadRef, type RunJournal, type RunOutcome, type RunState, type StopNotice } from "./record.ts";
import type { ToolRunner } from "./tools.ts";
import { JOB_RETRY, type LeasedJob } from "./queue.ts";

export const RETRY = { maxAttempts: MAX_ATTEMPTS, backoffMs: [0, 1_000, 4_000] } as const;

/** A stop within this window of run start is counted as a likely accidental stop. */
export const ACCIDENTAL_STOP_MS = 5_000;

export type Notice = "stopped" | "refused" | "failed" | "unrunnable";

export type Action =
  | { readonly t: "consume-inbox"; readonly inboxId: string; readonly item: InboxItem }
  | { readonly t: "ask-stop-confirm" }
  | { readonly t: "record-stop"; readonly by: string; readonly sinceStartMs: number }
  | { readonly t: "call-model"; readonly step: number; readonly attempt: number; readonly final: boolean }
  | { readonly t: "call-tool"; readonly callId: string; readonly attempt: number }
  | { readonly t: "mark-unknown"; readonly callId: string }
  | { readonly t: "decline-tool"; readonly callId: string }
  | { readonly t: "ask-confirm"; readonly callId: string }
  | { readonly t: "limit"; readonly which: "steps" | "tokens" | "wall" }
  | { readonly t: "wait"; readonly until: "confirm" | "backoff"; readonly ms: number }
  | { readonly t: "post-reply"; readonly body: { readonly t: "answer"; readonly ref: PayloadRef } | { readonly t: "notice"; readonly notice: Notice } }
  | { readonly t: "finish"; readonly outcome: RunOutcome; readonly reason: FailureReason | null };

export interface ToolPolicy {
  readonly isRepeatable: (tool: string) => boolean;
  readonly needsConfirm: (tool: string) => boolean;
}

/**
 * Pure. The entire runtime policy. Precedence, first match wins:
 *  0. unconsumed inbox item           -> consume-inbox (journal it before acting)
 *     run.faulted recorded            -> notice, finish(failed | unrunnable) with the reason
 *  1. stop confirmed, or stop before step 1 -> record-stop, notice, finish(stopped)
 *     stop unconfirmed after step 1   -> ask-stop-confirm once (run continues)
 *     egress refused                  -> notice, finish(refused)
 *  2. open model call                 -> retry if attempts < 3 (after backoff), else notice, finish(failed)
 *     open tool call                  -> retry if attempts < 3 and (idempotent or read-only), else mark-unknown
 *  3. external-send call unconfirmed  -> ask-confirm, then wait(confirm) (lease released)
 *  4. answer present, not replied     -> post-reply
 *     replied                         -> finish(answered | limit)
 *  5. limit hit and no final call yet -> limit, then call-model(final: true, no tools)
 *  6. unresolved tool calls           -> call-tool(first)
 *  7. otherwise                       -> call-model
 * Limits gate new calls only, so an answer already in hand is posted even at the step cap.
 * The inbox and the tool policy are inputs, not lookups, so next() stays pure.
 */
export function next(state: RunState, agent: ResolvedAgent, now: number, inbox: readonly { readonly id: string; readonly item: InboxItem }[], tools: ToolPolicy): Action {
  if (state.finished) throw new Error(`next() called on a finished run (${state.finished})`);
  const first = inbox[0];
  if (first) return { t: "consume-inbox", inboxId: first.id, item: first.item };

  if (state.fault) {
    const outcome = state.fault.t === "unrunnable" ? "unrunnable" : "failed";
    return state.replied ? { t: "finish", outcome, reason: state.fault } : { t: "post-reply", body: { t: "notice", notice: outcome } };
  }
  if (state.stop === "confirmed") {
    if (!state.stopRecorded) return { t: "record-stop", by: state.stopBy ?? "unknown", sinceStartMs: now - state.startedAt };
    return state.replied ? { t: "finish", outcome: "stopped", reason: null } : { t: "post-reply", body: { t: "notice", notice: "stopped" } };
  }
  if (state.stop === "requested-unconfirmed" && !state.stopAsked) return { t: "ask-stop-confirm" };
  if (state.refused) return state.replied ? { t: "finish", outcome: "refused", reason: null } : { t: "post-reply", body: { t: "notice", notice: "refused" } };

  const call = state.modelCall;
  if (call && call.status !== "completed") {
    const exhausted = call.attempts >= RETRY.maxAttempts || (call.status === "failed" && !call.lastFailure?.retryable);
    if (exhausted) return state.replied ? { t: "finish", outcome: "failed", reason: { t: "model-exhausted", attempts: call.attempts } } : { t: "post-reply", body: { t: "notice", notice: "failed" } };
    const wait = backoffRemaining(call.lastFailure?.at ?? null, call.attempts, now);
    if (wait > 0) return { t: "wait", until: "backoff", ms: wait };
    return { t: "call-model", step: call.step, attempt: call.attempts + 1, final: call.final };
  }

  const open = state.toolCalls.find((c) => c.status === "open");
  if (open) {
    if (!tools.isRepeatable(open.tool) || open.attempts >= RETRY.maxAttempts) return { t: "mark-unknown", callId: open.callId };
    return { t: "call-tool", callId: open.callId, attempt: open.attempts + 1 };
  }

  const unresolved = state.toolCalls.filter((c) => c.status !== "resolved");
  for (const c of unresolved) {
    if (!tools.needsConfirm(c.tool)) continue;
    const answer = state.confirmed.get(c.callId);
    if (answer === true) continue;
    if (answer === false) return { t: "decline-tool", callId: c.callId };
    return c.confirmAsked ? { t: "wait", until: "confirm", ms: 0 } : { t: "ask-confirm", callId: c.callId };
  }

  if (state.answer) {
    if (!state.replied) return { t: "post-reply", body: { t: "answer", ref: state.answer } };
    return { t: "finish", outcome: state.limitHit ? "limit" : "answered", reason: null };
  }

  const which = limitExceeded(state, agent, now);
  if (which && !state.limitHit) return { t: "limit", which };
  if (state.limitHit && !state.finalCalled) return { t: "call-model", step: (call?.step ?? 0) + 1, attempt: 1, final: true };

  const pending = unresolved[0];
  if (pending) {
    const wait = backoffRemaining(pending.lastFailure?.at ?? null, pending.attempts, now);
    if (wait > 0) return { t: "wait", until: "backoff", ms: wait };
    return { t: "call-tool", callId: pending.callId, attempt: pending.attempts + 1 };
  }
  return { t: "call-model", step: (call?.step ?? 0) + 1, attempt: 1, final: false };
}

/**
 * Pure. Whether a stop arriving mid-call ends the run, and so aborts the
 * call. The same rule fold applies when the stop is consumed: confirmed, or
 * before the first step, or a second stop after the question was asked.
 */
export function stopAborts(state: RunState): (stop: StopNotice) => boolean {
  return (stop) => stop.confirmed || state.steps === 0 || state.stop === "requested-unconfirmed";
}

function backoffRemaining(failedAt: number | null, attempts: number, now: number): number {
  if (failedAt === null) return 0;
  const delay = RETRY.backoffMs[Math.min(attempts, RETRY.backoffMs.length - 1)] ?? 0;
  return Math.max(0, failedAt + delay - now);
}

function limitExceeded(state: RunState, agent: ResolvedAgent, now: number): "steps" | "tokens" | "wall" | null {
  if (state.steps >= agent.limits.maxSteps) return "steps";
  if (state.tokens >= agent.limits.maxTokens) return "tokens";
  if (now - state.startedAt >= agent.limits.maxWallMs) return "wall";
  return null;
}

export interface LoopDeps {
  readonly gateway: ModelGateway;
  readonly tools: ToolRunner;
  readonly kb: KbReader;
  readonly surfaces: (surfaceId: string) => Surface;
  readonly policy: EgressPolicy;
  readonly loadAgent: (hash: AgentVersionHash) => Promise<ResolvedAgent>;
  /** What this deployment serves for this agent. Every run start checks the version's pins against it. */
  readonly deployed: (agent: ResolvedAgent) => Promise<Deployed>;
  readonly clock: { now(): number };
  /**
   * A signal for one call. Aborts when the lease is lost, or when a stop
   * notice (Postgres NOTIFY run_stop) arrives that abortsOn accepts. Released
   * after the call, so a stop never outlives the call it was aimed at.
   */
  readonly callSignal: (abortsOn: (stop: StopNotice) => boolean) => { readonly signal: AbortSignal; release(): void };
  readonly log: (line: string) => void;
}

export type DriveResult =
  | { readonly t: "finished"; readonly outcome: RunOutcome }
  | { readonly t: "parked"; readonly until: "confirm" }
  | { readonly t: "lease-lost" }
  /**
   * A transient error outside a journaled call. The worker requeues the job with backoff; job.attempts bounds
   * the handbacks without progress, and progressed (an event landed during this claim) starts that count over.
   */
  | { readonly t: "retry"; readonly error: string; readonly progressed: boolean }
  /** The job cannot start a run at all (malformed payload), so there is no record to finish. The worker fails the job. */
  | { readonly t: "unstartable"; readonly error: string };

/** Sanity's retrieval contract, told to every agent with a knowledge base. */
const RETRIEVAL_INSTRUCTIONS =
  "Use kb_search to find entries and kb_read to read whole entries by path. Answer only from entries you have read. If they do not contain the answer, say that you could not find it in the knowledge base.";

const NOTICES: Record<Notice, string> = {
  stopped: "Stopped.",
  refused: "This request cannot be answered here: it contains restricted data that the configured model may not receive.",
  failed: "The run failed after repeated errors. Please try again.",
  unrunnable: "This agent version cannot run on this deployment. Ask the lab manager to check it.",
};

/**
 * The shell. Writes run.started from the job on first claim, loads the agent
 * by hash, then loops fold -> next -> execute until finish or park. Each
 * execute writes its requested event before IO and its terminal event after,
 * through the journal. A LeaseLost from any append ends the loop: another
 * worker owns the run now. Any other error goes to settle(), which either
 * hands the job back for a bounded retry or records the fault and finishes.
 */
export async function drive(job: LeasedJob, journal: RunJournal, deps: LoopDeps): Promise<DriveResult> {
  let surface: Surface | null = null;
  const openedWith = journal.events().length;
  try {
    if (journal.events().length === 0) {
      const p = parseRunJobPayload(job.payload);
      await journal.append({ t: "run.started", agent: p.agent, kind: p.kind, trigger: p.trigger, thread: p.thread, surface: p.surface, threadId: p.threadId, input: p.input, history: p.history, route: { t: "direct" }, studyId: p.studyId });
    }
    const start = fold(journal.events());
    const known = deps.surfaces(start.surface);
    surface = known;
    const agent = await deps.loadAgent(start.agent);
    const problems = verifyRunnable(agent, await deps.deployed(agent));
    if (problems.length) throw new UnrunnableAgent(problems);
    const policy: ToolPolicy = { isRepeatable: (t) => deps.tools.isRepeatable(t), needsConfirm: (t) => deps.tools.needsConfirm(t) };
    const withSignal = async <T>(abortsOn: (stop: StopNotice) => boolean, io: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const call = deps.callSignal(abortsOn);
      try {
        return await io(call.signal);
      } finally {
        call.release();
      }
    };

    /** One action's IO. Returns a result only when the run leaves the loop (parked). */
    const execute = async (action: Action, state: RunState, signal: AbortSignal): Promise<DriveResult | null> => {
      switch (action.t) {
        case "consume-inbox":
          await journal.consumeInbox(action.inboxId, action.item);
          return null;
        case "ask-stop-confirm":
          await known.askConfirm(state.runId, state.threadId, "Stop this run? Send stop again to confirm.", "stop");
          await journal.append({ t: "stop.asked" });
          return null;
        case "record-stop":
          await journal.append({ t: "stop", by: action.by, sinceStartMs: action.sinceStartMs });
          return null;
        case "call-model": {
          const prompt = await buildPrompt(state, agent, journal, deps, action.final);
          await deps.gateway.complete(agent.model, prompt, journal, { signal, step: action.step, attempt: action.attempt, final: action.final });
          return null;
        }
        case "call-tool": {
          const call = state.toolCalls.find((c) => c.callId === action.callId)!;
          await deps.tools.invoke(journal, { callId: call.callId, tool: call.tool, attempt: action.attempt, input: call.input }, { knowledgeBases: agent.knowledgeBases, retrieval: agent.retrieval }, signal);
          return null;
        }
        case "mark-unknown":
          await journal.append({ t: "tool.outcome-unknown", callId: action.callId });
          return null;
        case "decline-tool": {
          const call = state.toolCalls.find((c) => c.callId === action.callId)!;
          await journal.append({ t: "tool.failed", callId: call.callId, attempt: call.attempts + 1, failure: { code: "declined", detail: null }, retryable: false });
          return null;
        }
        case "ask-confirm": {
          const call = state.toolCalls.find((c) => c.callId === action.callId)!;
          await known.askConfirm(state.runId, state.threadId, `The agent wants to run ${call.tool}, which sends data outside the lab. Approve?`, call.callId);
          await journal.append({ t: "confirm.asked", callId: call.callId });
          return null;
        }
        case "limit":
          await journal.append({ t: "limit.hit", which: action.which });
          return null;
        case "wait":
          if (action.until === "confirm") return { t: "parked", until: "confirm" };
          // Any stop cuts the backoff short so the inbox is consumed and answered promptly.
          await withSignal(() => true, (any) => sleep(action.ms, any));
          return null;
        case "post-reply": {
          let answer: Labelled<string>;
          if (action.body.t === "answer") {
            const body = await journal.get(action.body.ref);
            answer = Labelled.derive(String(body.value), [body], "loop:answer");
          } else answer = Labelled.stamp(NOTICES[action.body.notice], "D0", "loop:notice");
          await postNotice(known, state, answer, journal, deps);
          return null;
        }
        case "finish":
          await journal.append({ t: "run.finished", outcome: action.outcome, answer: action.outcome === "answered" || action.outcome === "limit" ? state.answer : null, reason: action.reason, flags: [] });
          return null;
        default: {
          const never: never = action;
          throw new Error(`drive: unknown action ${JSON.stringify(never)}`);
        }
      }
    };

    for (;;) {
      const state = fold(journal.events());
      if (state.finished) return { t: "finished", outcome: state.finished };
      // The stop listener is registered before the inbox is read: a notice that lands before the read is
      // in the inbox and gets consumed; one that lands after it reaches the listener and aborts the call.
      const left = await withSignal(stopAborts(state), async (signal) => {
        const action = next(state, agent, deps.clock.now(), await journal.pendingInbox(), policy);
        deps.log(`run ${state.runId}: ${action.t}${"step" in action ? ` step ${action.step} attempt ${action.attempt}` : ""}${"callId" in action ? ` ${action.callId}` : ""}`);
        return execute(action, state, signal);
      });
      if (left) return left;
    }
  } catch (err) {
    return settle(err, job, journal, surface, deps, journal.events().length > openedWith);
  }
}

async function postNotice(surface: Surface, state: RunState, answer: Labelled<string>, journal: RunJournal, deps: LoopDeps): Promise<void> {
  const posted = await postReply(surface, state.runId, state.threadId, answer, deps.policy);
  await journal.append({ t: "reply.posted", mode: posted.mode, surfaceMessageId: posted.messageId });
}

/**
 * Terminal errors the loop cannot continue past, by class. Anything else is
 * treated as transient (retried, bounded by job.attempts): a Postgres blip
 * and an unknown bug both get three tries, then the run finishes failed with
 * the message stored as a payload.
 */
export function faultOf(err: unknown): FailureReason | null {
  if (err instanceof StoreRefused) return { t: "store-refused", refusal: err.refusal };
  if (err instanceof PayloadUnavailable) return { t: "payload-unavailable", hash: err.hash, why: err.why };
  if (err instanceof SurfaceUnknown) return { t: "surface-unknown", surface: err.surface };
  if (err instanceof AgentUnavailable) return { t: "agent-unavailable", agent: err.hash, why: err.why };
  if (err instanceof UnrunnableAgent) return { t: "unrunnable", problems: err.problems };
  return null;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The one exit for errors. Records the fault once (a resume after a crash
 * finds it already there), posts the failure notice when the surface is
 * known, and finishes. Every step is fenced and idempotent, so a blip while
 * settling hands the job back and the next claim converges on the same end.
 * The retry bound counts handbacks with no progress: a claim that journaled
 * something before it blipped starts the count over, so three blips spread
 * over a run's life never end it.
 */
async function settle(err: unknown, job: LeasedJob, journal: RunJournal, surface: Surface | null, deps: LoopDeps, progressed: boolean): Promise<DriveResult> {
  if (err instanceof LeaseLost) {
    deps.log(err.message);
    return { t: "lease-lost" };
  }
  deps.log(`run ${job.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  const terminal = faultOf(err);
  const attempts = (progressed ? 0 : job.attempts) + 1;
  const retry: DriveResult = { t: "retry", error: messageOf(err), progressed };
  if (journal.events().length === 0) {
    if (err instanceof MalformedJob || attempts >= JOB_RETRY.maxAttempts) return { t: "unstartable", error: messageOf(err) };
    return retry;
  }
  if (terminal === null && attempts < JOB_RETRY.maxAttempts) return retry;
  try {
    let state = fold(journal.events());
    if (!state.fault) {
      await journal.append({ t: "run.faulted", reason: terminal ?? { t: "retries-exhausted", attempts, error: await errorPayload(err, state, journal) } });
      state = fold(journal.events());
    }
    const outcome: RunOutcome = state.fault?.t === "unrunnable" ? "unrunnable" : "failed";
    if (!state.replied && surface) await postNotice(surface, state, Labelled.stamp(NOTICES[outcome], "D0", "loop:notice"), journal, deps);
    await journal.append({ t: "run.finished", outcome, answer: null, reason: state.fault, flags: [] });
    return { t: "finished", outcome };
  } catch (again) {
    if (again instanceof LeaseLost) {
      deps.log(again.message);
      return { t: "lease-lost" };
    }
    deps.log(`run ${job.id}: while settling: ${messageOf(again)}`);
    return { t: "retry", error: messageOf(again), progressed };
  }
}

/** The error text at the run's class. A store that refuses it leaves the reason with no text rather than failing the settle. */
async function errorPayload(err: unknown, state: RunState, journal: RunJournal): Promise<PayloadRef | null> {
  try {
    return await journal.put(Labelled.stamp(messageOf(err), state.cls, "loop:error"));
  } catch (putErr) {
    if (putErr instanceof StoreRefused) return null;
    throw putErr;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The prompt is built from refs: every body is fetched from the store with
 * its class, and Prompt.of joins them. The system part carries the
 * instructions and each knowledge base's outline, as Sanity does, so an agent
 * with a D3 knowledge base is D3 on every call.
 */
async function buildPrompt(state: RunState, agent: ResolvedAgent, journal: RunJournal, deps: LoopDeps, final: boolean): Promise<Prompt> {
  const instructions = instructionsOf(agent);
  const outlines = await Promise.all(agent.knowledgeBases.map((kb) => deps.kb.outline(kb.snapshot)));
  const systemText = [
    instructions.value,
    ...outlines.map((o, i) => `Knowledge base "${o.value.title}" (id ${agent.knowledgeBases[i]!.kbId}): ${o.value.purpose}\nEntries:\n${o.value.paths.map((p) => `- ${p}`).join("\n")}`),
    outlines.length ? RETRIEVAL_INSTRUCTIONS : "",
    final ? "You have reached this run's limit. Answer now with what you have, without calling tools." : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const system: ChatPart = { role: "system", content: Labelled.derive(systemText, [instructions, ...outlines], "loop:system") };
  const parts: ChatPart[] = [];
  // journal.get labels the body with the ref's class, which its address commits to, so nothing here can understate it.
  const text = async (ref: PayloadRef): Promise<Labelled<string>> => {
    const body = await journal.get(ref);
    return Labelled.derive(typeof body.value === "string" ? body.value : JSON.stringify(body.value), [body], body.origin);
  };
  for (const item of state.transcript) {
    switch (item.role) {
      case "user":
        parts.push({ role: "user", content: await text(item.content) });
        break;
      case "steer": {
        const t = await text(item.content);
        parts.push({ role: "user", content: Labelled.derive(`Steering note from the thread: ${t.value}`, [t], t.origin) });
        break;
      }
      case "assistant": {
        const content = await text(item.content);
        if (content.value) parts.push({ role: "assistant", content });
        const [first, ...rest] = await Promise.all(item.toolCalls.map(async (c) => ({ body: await journal.get(c.args), id: c.id, name: c.name })));
        if (first) {
          const calls = [first, ...rest];
          parts.push({ role: "assistant", toolCalls: Labelled.derive(calls.map((c) => ({ id: c.id, name: c.name, args: c.body.value })), [first.body, ...rest.map((c) => c.body)], "loop:tool-calls") });
        }
        break;
      }
      case "tool": {
        const r = item.result;
        let content: Labelled<string>;
        if (r.t === "output") content = await text(r.content);
        else if (r.t === "unknown") content = Labelled.stamp("The outcome of this call is unknown: it was interrupted and could not be safely repeated.", "D0", "loop:tool-result");
        else if (r.failure.detail) {
          const detail = await text(r.failure.detail);
          content = Labelled.derive(`Error: ${describeFailure(r.failure)}: ${detail.value}`, [detail], "loop:tool-result");
        } else content = Labelled.stamp(`Error: ${describeFailure(r.failure)}`, "D0", "loop:tool-result");
        parts.push({ role: "tool", callId: item.callId, content });
        break;
      }
    }
  }
  if (final) {
    for (const c of state.toolCalls) {
      if (c.status !== "resolved") parts.push({ role: "tool", callId: c.callId, content: Labelled.stamp("Not executed: the run reached its limit.", "D0", "loop:limit") });
    }
  }
  return Prompt.of([system, ...parts], final ? [] : deps.tools.specs(agent.tools.map((t) => t.name)));
}
