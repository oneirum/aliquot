/**
 * Front doors. An adapter (Chat SDK for Slack and Teams, the web page, later
 * email and MCP) does two things: turn its event into an InboundMessage and
 * call intake(), and implement Surface so the worker can reply.
 *
 * intake() order, all in one place:
 *   1. gate                         -> refuse with a user-facing message, or admit with class
 *   2. thread has an active background run -> write a steer inbox item, done      (later unit)
 *   3. channel bound to a study     -> frozen hash (router off)                   (later unit)
 *      else watched-channel post    -> shouldReply, maybe drop                    (later unit)
 *      else                         -> route(), resolve head AgentDocument -> hash (upsert)
 *                                      this build: the head bound to the channel, else the fixture; no router
 *   4. queue.enqueue(run key = surface:channel:thread:message)   idempotent
 */

import { z } from "zod";
import { resolveAgent, versionHash, type AgentDocument, type Catalog } from "./agent.ts";
import { decideEgress, type DataClass, type EgressPolicy, type Labelled, type Placement, type SurfaceId } from "./dataclass.ts";
import type { Db } from "./db.ts";
import { gate, type GateDeps, type InboundMessage } from "./gate.ts";
import type { AgentVersionHash } from "./hash.ts";
import type { Queue } from "./queue.ts";
import type { PayloadRef, PayloadStore, RunId, ThreadKey, Trigger } from "./record.ts";

export type IntakeResult =
  | { readonly t: "enqueued"; readonly runId: RunId; readonly agent: AgentVersionHash; readonly duplicate: boolean }
  | { readonly t: "steered"; readonly runId: RunId }
  | { readonly t: "asked-user"; readonly choices: readonly string[] }
  | { readonly t: "ignored"; readonly reason: "watched-no" | "own-message" }
  | { readonly t: "refused"; readonly userFacing: string };

const ref = z.object({ hash: z.string(), cls: z.string(), bytes: z.number() });

/** What a run job carries. Written by intake, read by drive() to write run.started. */
export const runJobPayloadSchema = z.object({
  agent: z.string(),
  kind: z.enum(["interactive", "background"]),
  trigger: z.discriminatedUnion("t", [
    z.object({ t: z.literal("message"), surface: z.string(), messageId: z.string(), memberId: z.string() }),
    z.object({ t: z.literal("test"), memberId: z.string() }),
  ]),
  thread: z.string(),
  surface: z.string(),
  threadId: z.string(),
  input: ref,
  history: z.array(ref),
  studyId: z.string().nullable(),
});

export interface RunJobPayload {
  readonly agent: AgentVersionHash;
  readonly kind: "interactive" | "background";
  readonly trigger: Trigger;
  readonly thread: ThreadKey;
  readonly surface: string;
  readonly threadId: string;
  readonly input: PayloadRef;
  readonly history: readonly PayloadRef[];
  readonly studyId: string | null;
}

/** A jobs row whose payload is not a run job. Nothing can be journaled for it, so the worker fails the job without a run record. */
export class MalformedJob extends Error {
  constructor(detail: string) {
    super(`run job payload is malformed: ${detail}`);
    this.name = "MalformedJob";
  }
}

/** Boundary: the jobs row's JSON in, the typed payload out. The brands are applied here, once. */
export function parseRunJobPayload(json: unknown): RunJobPayload {
  const parsed = runJobPayloadSchema.safeParse(json);
  if (!parsed.success) throw new MalformedJob(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const p = parsed.data;
  const ref = (r: { hash: string; cls: string; bytes: number }): PayloadRef => ({ hash: r.hash as PayloadRef["hash"], cls: r.cls as DataClass, bytes: r.bytes });
  return { ...p, agent: p.agent as AgentVersionHash, thread: p.thread as ThreadKey, input: ref(p.input), history: p.history.map(ref) };
}

export interface IntakeDeps {
  readonly db: Db;
  readonly store: PayloadStore;
  readonly queue: Queue;
  readonly gate: GateDeps;
  /** Read per message, so a publish reaches the next message without a restart. */
  readonly catalog: () => Promise<Catalog>;
  /** The agent for a channel: the published head bound to it, else the deployment's fixture. The router replaces this for unbound channels. */
  readonly agentFor: (channel: InboundMessage["channel"]) => Promise<AgentDocument | undefined>;
}

export async function intake(msg: InboundMessage, deps: IntakeDeps): Promise<IntakeResult> {
  const doc = await deps.agentFor(msg.channel);
  if (!doc) return { t: "refused", userFacing: "No agent is published for this channel." };
  const key = `msg:${msg.channel.surface}:${msg.channel.channelId}:${msg.threadId}:${msg.messageId}`;
  return admit(msg, doc, key, (member) => ({ t: "message", surface: msg.channel.surface, messageId: msg.messageId, memberId: member }), deps);
}

/** A studio test message: the same gate, resolution and queue as intake, on a draft that is not published. */
export async function intakeTest(msg: InboundMessage, draft: AgentDocument, deps: IntakeDeps): Promise<IntakeResult> {
  const key = `test:${msg.channel.surface}:${msg.channel.channelId}:${msg.threadId}:${msg.messageId}`;
  return admit(msg, draft, key, (member) => ({ t: "test", memberId: member }), deps);
}

async function admit(msg: InboundMessage, doc: AgentDocument, key: string, trigger: (member: string) => Trigger, deps: IntakeDeps): Promise<IntakeResult> {
  const admitted = await gate(msg, deps.gate);
  if (admitted.t === "refuse") return { t: "refused", userFacing: admitted.userFacing };
  const resolved = resolveAgent(doc, await deps.catalog());
  if (!resolved.ok) return { t: "refused", userFacing: `The agent cannot run: ${resolved.issues.map((i) => i.message).join("; ")}` };
  const hash = versionHash(resolved.agent);
  await deps.db.query("insert into agent_versions (hash, agent_id, body) values ($1, $2, $3) on conflict (hash) do nothing", [hash, resolved.agent.agentId, JSON.stringify(resolved.agent)]);
  const input = await deps.store.put(admitted.text);
  const thread = `${msg.channel.surface}:${msg.channel.channelId}:${msg.threadId}` as ThreadKey;
  const payload: RunJobPayload = {
    agent: hash,
    kind: doc.kind,
    trigger: trigger(admitted.member),
    thread,
    surface: msg.channel.surface,
    threadId: msg.threadId,
    input,
    history: [],
    studyId: null,
  };
  const job = await deps.queue.enqueue({ kind: "run", key }, thread, payload);
  return { t: "enqueued", runId: job.id as RunId, agent: hash, duplicate: !job.created };
}

/** A run names a surface this deployment does not serve. Terminal, and no reply can be posted anywhere. */
export class SurfaceUnknown extends Error {
  readonly surface: string;
  constructor(surface: string) {
    super(`no surface ${surface} in this build`);
    this.name = "SurfaceUnknown";
    this.surface = surface;
  }
}

/** Implemented per surface. All methods idempotent by runId so a resumed run never double-posts. */
export interface Surface {
  readonly id: SurfaceId;
  readonly placement: Placement;
  /** Live deltas. Best effort. Returns a handle the run can confirm or abandon. */
  startStream(runId: RunId, threadId: string): Promise<{ push(delta: string): void; close(): Promise<boolean> }>;
  /** Stream fallback: if the stream was not confirmed closed, post or edit to the full text. */
  finalize(runId: RunId, threadId: string, text: string): Promise<{ readonly mode: "stream-confirmed" | "final-post"; readonly messageId: string }>;
  askConfirm(runId: RunId, threadId: string, prompt: string, callId: string): Promise<void>;
  /** Link to the lab-hosted web view of a run, behind sign-on. */
  linkTo(runId: RunId): string;
}

/**
 * The chat egress call site. decideEgress(answer, {kind:"chat", surface placement}):
 * allowed -> finalize with the text; refused -> finalize with a link-only notice.
 * Streaming is only started when the run's class at step start already fits the surface.
 */
export async function postReply(
  surface: Surface,
  runId: RunId,
  threadId: string,
  answer: Labelled<string>,
  policy: EgressPolicy,
): Promise<{ readonly mode: "stream-confirmed" | "final-post" | "link-only"; readonly messageId: string }> {
  const decision = decideEgress(answer, { kind: "chat", surface: surface.id, placement: surface.placement }, policy);
  if (decision.allow) return surface.finalize(runId, threadId, answer.value);
  const posted = await surface.finalize(runId, threadId, `This answer contains restricted data. Open it here: ${surface.linkTo(runId)}`);
  return { mode: "link-only", messageId: posted.messageId };
}
