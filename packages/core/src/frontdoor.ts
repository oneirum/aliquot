/**
 * Front doors. An adapter (Chat SDK for Slack and Teams, the web page, later
 * email and MCP) does two things: turn its event into an InboundMessage and
 * call intake(), and implement Surface so the worker can reply.
 *
 * intake() order, all in one place:
 *   1. gate                         -> refuse with a user-facing message, or admit with class
 *   2. thread has an active background run -> write a steer inbox item, done      (later unit)
 *   3. channel bound to a study     -> frozen hash (router off): choosePinned, study.ts pinFor
 *      else watched-channel post    -> shouldReply, maybe drop                    (later unit)
 *      else one agent on the channel -> it answers, route "direct"
 *      else                         -> route() over the channel's agents: one answers, or the member picks (asked-user)
 *      then resolve the AgentDocument -> hash (upsert)
 *   4. queue.enqueue(run key = surface:channel:thread:message)   idempotent
 */

import { z } from "zod";
import { listingOf, resolveAgent, versionHash, type AgentDocument, type AgentId, type AgentListing, type Catalog } from "./agent.ts";
import { decideEgress, type DataClass, type EgressPolicy, type Labelled, type Placement, type SurfaceId } from "./dataclass.ts";
import type { Db } from "./db.ts";
import { gate, type GateDeps, type GateResult, type InboundMessage } from "./gate.ts";
import type { AgentVersionHash } from "./hash.ts";
import { loadVersion } from "./publish.ts";
import { ENGINES, type Engine, type Queue } from "./queue.ts";
import type { PayloadRef, PayloadStore, RunId, ThreadKey, Trigger } from "./record.ts";
import { eligibleOptions, picked, route, ROUTE_BASES, type RouteDecision } from "./router.ts";
import { pinFor, type Freeze } from "./study.ts";

/** An agent as a member sees it when it answers or when they pick one: its name and the first sentence of its description. */
export interface AgentChoice {
  readonly agentId: AgentId;
  readonly name: string;
  readonly line: string;
}

/** Why this agent runs, written into run.started: the router's decision, "pinned" on a study channel, or "direct" when the channel has one agent. */
export type RunRoute = Extract<RouteDecision, { t: "agent" }> | { readonly t: "pinned"; readonly studyId: string } | { readonly t: "direct" };

export type IntakeResult =
  | { readonly t: "enqueued"; readonly runId: RunId; readonly agent: AgentVersionHash; readonly duplicate: boolean; readonly answeredBy: AgentChoice; readonly route: RunRoute }
  | { readonly t: "steered"; readonly runId: RunId }
  /** The router was unsure: the member picks one, and the same message goes again naming that agent. */
  | { readonly t: "asked-user"; readonly choices: readonly AgentChoice[]; readonly route: Extract<RouteDecision, { t: "ask-user" }> }
  | { readonly t: "ignored"; readonly reason: "watched-no" | "own-message" }
  | { readonly t: "refused"; readonly userFacing: string };

const ref = z.object({ hash: z.string(), cls: z.string(), bytes: z.number() });
const routeSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("direct") }),
  z.object({ t: z.literal("pinned"), studyId: z.string() }),
  z.object({ t: z.literal("agent"), agentId: z.string(), basis: z.enum(ROUTE_BASES), probs: z.record(z.string(), z.number()), confidence: z.number(), router: z.string() }),
]);

/** What a run job carries. Written by intake, read by drive() to write run.started. */
export const runJobPayloadSchema = z.object({
  agent: z.string(),
  // A payload written before agent backends existed is a chat run.
  engine: z.enum(ENGINES).default(ENGINES[0]),
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
  // A payload written before the router existed ran its channel's one agent.
  route: routeSchema.default({ t: "direct" }),
  studyId: z.string().nullable(),
});

export interface RunJobPayload {
  readonly agent: AgentVersionHash;
  /** The worker binary that claims this run: the chat loop, or the agent worker for an agent CLI. */
  readonly engine: Engine;
  readonly kind: "interactive" | "background";
  readonly trigger: Trigger;
  readonly thread: ThreadKey;
  readonly surface: string;
  readonly threadId: string;
  readonly input: PayloadRef;
  readonly history: readonly PayloadRef[];
  readonly route: RunRoute;
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
  const route: RunRoute = p.route.t === "agent" ? { ...p.route, agentId: p.route.agentId as AgentId } : p.route;
  return { ...p, agent: p.agent as AgentVersionHash, thread: p.thread as ThreadKey, input: ref(p.input), history: p.history.map(ref), route };
}

export interface IntakeDeps {
  readonly db: Db;
  readonly store: PayloadStore;
  readonly queue: Queue;
  readonly gate: GateDeps;
  /** Read per message, so a publish reaches the next message without a restart. */
  readonly catalog: () => Promise<Catalog>;
  /** The agents that answer in a channel: the published heads bound to it, else the deployment's fixtures. Two or more are routed. */
  readonly agentsFor: (channel: InboundMessage["channel"]) => Promise<readonly AgentDocument[]>;
}

/** pick is the agent the member chose from an earlier asked-user result for this same message. */
export async function intake(msg: InboundMessage, deps: IntakeDeps, pick?: AgentId): Promise<IntakeResult> {
  const key = `msg:${msg.channel.surface}:${msg.channel.channelId}:${msg.threadId}:${msg.messageId}`;
  return admit(msg, key, (member) => ({ t: "message", surface: msg.channel.surface, messageId: msg.messageId, memberId: member }), deps, (admitted) => chooseAgent(msg, admitted, deps, pick));
}

/** A studio test message: the same gate, resolution and queue as intake, on a draft that is not published. */
export async function intakeTest(msg: InboundMessage, draft: AgentDocument, deps: IntakeDeps): Promise<IntakeResult> {
  const key = `test:${msg.channel.surface}:${msg.channel.channelId}:${msg.threadId}:${msg.messageId}`;
  return admit(msg, key, (member) => ({ t: "test", memberId: member }), deps, async () => ({ t: "agent", doc: draft, route: { t: "direct" } }));
}

type Admitted = Extract<GateResult, { t: "admit" }>;
type Chosen =
  | { readonly t: "agent"; readonly doc: AgentDocument; readonly route: RunRoute }
  /** A study channel's frozen version: run by its hash, never resolved again. */
  | { readonly t: "pinned"; readonly freeze: Freeze }
  | Extract<IntakeResult, { t: "refused" | "asked-user" }>;

const threadOf = (msg: InboundMessage) => `${msg.channel.surface}:${msg.channel.channelId}:${msg.threadId}` as ThreadKey;

export function choiceOf(listing: AgentListing): AgentChoice {
  return { agentId: listing.agentId, name: listing.name, line: listing.description.split(/(?<=[.!?])\s+/)[0] ?? "" };
}

/**
 * Step 3, after the gate, because routing reads the message's class and the member's audiences. A study channel's pin
 * goes first, before agentsFor: a pinned channel runs its frozen version and never reaches route().
 */
async function chooseAgent(msg: InboundMessage, admitted: Admitted, deps: IntakeDeps, pick: AgentId | undefined): Promise<Chosen> {
  const pin = await pinFor(deps.db, msg.channel);
  if (pin) return choosePinned(pin.study, pin.freezes, pick);
  const docs = await deps.agentsFor(msg.channel);
  if (!docs.length) return { t: "refused", userFacing: "No agent is published for this channel." };
  if (docs.length === 1 && pick === undefined) return { t: "agent", doc: docs[0]!, route: { t: "direct" } };
  const listings = docs.map(listingOf);
  const input = { message: admitted.text.value, candidates: eligibleOptions(listings, admitted.cls, admitted.member, admitted.audiences), current: await threadHolder(deps.db, threadOf(msg)) };
  const decision = pick === undefined ? route(input) : picked(input, pick);
  switch (decision.t) {
    case "agent":
      return { t: "agent", doc: docs.find((d) => d.agentId === decision.agentId)!, route: decision };
    case "ask-user":
      return { t: "asked-user", choices: decision.top3.map((id) => choiceOf(listings.find((l) => l.agentId === id)!)), route: decision };
    case "self":
      return { t: "refused", userFacing: "No agent in this channel takes this message." };
    case "unavailable":
      return { t: "refused", userFacing: decision.reason };
  }
}

/** One active freeze runs; with several the member picks from the frozen agents only; with none the channel refuses. */
function choosePinned(study: { readonly id: string; readonly owner: string }, freezes: readonly Freeze[], pick: AgentId | undefined): Chosen {
  if (!freezes.length) return { t: "refused", userFacing: `This channel belongs to study ${study.id}, which has no frozen agent. Ask the study owner, ${study.owner}.` };
  const freeze = pick === undefined ? (freezes.length === 1 ? freezes[0] : undefined) : freezes.find((f) => f.agentId === pick);
  if (freeze) return { t: "pinned", freeze };
  if (pick !== undefined) return { t: "refused", userFacing: "That agent was not one of the choices for this message." };
  const top = freezes.map((f) => f.agentId);
  return { t: "asked-user", choices: freezes.map((f) => choiceOf(f.listing)), route: { t: "ask-user", top3: top, probs: {}, confidence: 0, router: "pinned" } };
}

/** The agent of the newest run in this thread, so a follow-up stays with it. */
async function threadHolder(db: Db, thread: ThreadKey): Promise<AgentId | null> {
  const row = await db.query<{ agent_id: AgentId }>("select v.agent_id from jobs j join agent_versions v on v.hash = j.payload->>'agent' where j.kind = 'run' and j.thread_key = $1 order by j.created_at desc limit 1", [thread]);
  return row.rows[0]?.agent_id ?? null;
}

async function admit(msg: InboundMessage, key: string, trigger: (member: string) => Trigger, deps: IntakeDeps, choose: (admitted: Admitted) => Promise<Chosen>): Promise<IntakeResult> {
  const admitted = await gate(msg, deps.gate);
  if (admitted.t === "refuse") return { t: "refused", userFacing: admitted.userFacing };
  const chosen = await choose(admitted);
  if (chosen.t === "pinned") {
    const { freeze } = chosen;
    const agent = await loadVersion(deps.db, freeze.hash);
    const run = { hash: freeze.hash, engine: agent.agentCli ? "agent-cli" : "chat", kind: "interactive", studyId: freeze.studyId, route: { t: "pinned", studyId: freeze.studyId }, answeredBy: choiceOf(freeze.listing) } as const;
    return enqueueRun(msg, admitted, run, key, trigger, deps);
  }
  if (chosen.t !== "agent") return chosen;
  const { doc } = chosen;
  const resolved = resolveAgent(doc, await deps.catalog());
  if (!resolved.ok) return { t: "refused", userFacing: `The agent cannot run: ${resolved.issues.map((i) => i.message).join("; ")}` };
  const hash = versionHash(resolved.agent);
  await deps.db.query("insert into agent_versions (hash, agent_id, body) values ($1, $2, $3) on conflict (hash) do nothing", [hash, resolved.agent.agentId, JSON.stringify(resolved.agent)]);
  return enqueueRun(msg, admitted, { hash, engine: resolved.agent.agentCli ? "agent-cli" : "chat", kind: doc.kind, studyId: null, route: chosen.route, answeredBy: choiceOf(listingOf(doc)) }, key, trigger, deps);
}

async function enqueueRun(
  msg: InboundMessage,
  admitted: Extract<GateResult, { t: "admit" }>,
  run: Pick<RunJobPayload, "engine" | "kind" | "route" | "studyId"> & { readonly hash: AgentVersionHash; readonly answeredBy: AgentChoice },
  key: string,
  trigger: (member: string) => Trigger,
  deps: IntakeDeps,
): Promise<IntakeResult> {
  const hash = run.hash;
  const input = await deps.store.put(admitted.text);
  const thread = threadOf(msg);
  const payload: RunJobPayload = {
    agent: hash,
    engine: run.engine,
    kind: run.kind,
    trigger: trigger(admitted.member),
    thread,
    surface: msg.channel.surface,
    threadId: msg.threadId,
    input,
    history: [],
    route: run.route,
    studyId: run.studyId,
  };
  const job = await deps.queue.enqueue({ kind: "run", key }, thread, payload);
  if (!job.created) {
    // A resend of a message already queued: report the run that exists, not the agent this request would have picked.
    const first = await deps.db.query<{ agent: AgentVersionHash; route: RunRoute | null; agent_id: AgentId }>(
      "select j.payload->>'agent' as agent, j.payload->'route' as route, v.agent_id from jobs j join agent_versions v on v.hash = j.payload->>'agent' where j.id = $1",
      [job.id],
    );
    const row = first.rows[0];
    if (row && row.agent !== hash) {
      return { t: "enqueued", runId: job.id as RunId, agent: row.agent, duplicate: true, answeredBy: { agentId: row.agent_id, name: row.agent_id, line: "" }, route: row.route ?? { t: "direct" } };
    }
  }
  return { t: "enqueued", runId: job.id as RunId, agent: hash, duplicate: !job.created, answeredBy: run.answeredBy, route: run.route };
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
