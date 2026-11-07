/**
 * Router: which agent in a shared channel answers a message.
 *
 * This build runs the model-free `lexical` backend (DESIGN.md, synthesis graft from candidate 3): BM25 over each
 * option's name, description and sample questions, then a softmax. Nothing leaves the process, so it routes a D3
 * message as safely as a D1 one, and the web door, which holds no model gateway, can run it. A classifier backend
 * (RouterProfile, through the gateway, whose placement decides which classes it may see) is the later path.
 *
 * Rules, in order:
 *   no eligible option            -> unavailable
 *   one eligible option           -> it answers (basis "only")
 *   the thread's agent is eligible -> it answers again, so follow-ups stay put (basis "thread")
 *   top probability >= LOW_CONFIDENCE -> it answers (basis "score")
 *   otherwise                     -> ask the member to pick from the top three (ask-user)
 *
 * Study channels never call route(): intake pins the frozen version first.
 */

import { atMost, type DataClass } from "./dataclass.ts";
import type { AgentId, AgentListing, Audience, MemberId } from "./agent.ts";
import type { ModelGateway, ModelTarget } from "./gateway.ts";
import { tokenize } from "./kb.ts";
import type { CallRecorder } from "./record.ts";

export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_THREAD_MESSAGES = 20;
export const SELF_OPTION = "harness:self";

/** The backend and its version, recorded with every decision. Bump it when scoring or the constants below change. */
export const ROUTER = "lexical-v1";
/**
 * Set on lab0's two routed agents (fixtures/lab0/routed-agents.json, test/router.test.ts): with each sample question
 * left out of its own agent's profile, none goes to the other agent at or above this, and a question that names both
 * agents' topics falls below it. With two options, a question that shares no distinctive word with either scores 0.5.
 */
export const LOW_CONFIDENCE = 0.75;
/** Softmax temperature over BM25 scores. With two options, one distinctive word shared with only one of them gives about 0.87. */
export const TEMPERATURE = 0.5;

/**
 * One profile per classifier backend. lowConfidence is on that backend's own scale:
 * 0.4 is Jev's; a local logprob classifier is calibrated on the lab's labelled
 * question set and stores its own threshold here.
 */
export interface RouterProfile {
  readonly version: string;
  readonly target: ModelTarget;
  readonly lowConfidence: number;
  readonly watchedThreshold: number;
}

export interface RouteInput {
  readonly message: string;
  /** Eligible options only: see eligibleOptions(). */
  readonly candidates: readonly AgentListing[];
  /** Follow-ups stay put: the agent currently holding the thread. */
  readonly current: AgentId | null;
}

/** Why the agent answers: the only option, the agent already holding the thread, the top score, or the member's pick. */
export const ROUTE_BASES = ["only", "thread", "score", "picked"] as const;
export type RouteBasis = (typeof ROUTE_BASES)[number];

export type RouteDecision =
  | { readonly t: "agent"; readonly agentId: AgentId; readonly basis: RouteBasis; readonly probs: Readonly<Record<string, number>>; readonly confidence: number; readonly router: string }
  | { readonly t: "ask-user"; readonly top3: readonly AgentId[]; readonly probs: Readonly<Record<string, number>>; readonly confidence: number; readonly router: string }
  | { readonly t: "self"; readonly confidence: number; readonly router: string }
  | { readonly t: "unavailable"; readonly reason: string };

/** Who may reach an agent: the lab, its listed members, or an audience the member holds. */
export function audienceAdmits(audience: Audience, member: MemberId, held: readonly Audience[]): boolean {
  switch (audience.t) {
    case "members":
      return audience.members.includes(member);
    case "study-team":
      return held.some((h) => h.t === "study-team" && h.studyId === audience.studyId);
    case "lab":
    case "pi-only":
      return held.some((h) => h.t === audience.t);
  }
}

/** The options a message may be routed to: published, routable, open to this member, and with a ceiling that admits the message's class. */
export function eligibleOptions(listings: readonly AgentListing[], cls: DataClass, member: MemberId, held: readonly Audience[]): AgentListing[] {
  return listings.filter((l) => l.status === "published" && l.routable && atMost(cls, l.ceiling) && audienceAdmits(l.audience, member, held));
}

export function route(input: RouteInput): RouteDecision {
  const { candidates } = input;
  if (!candidates.length) return { t: "unavailable", reason: "No agent in this channel is open to you for this message." };
  const probs = scoreOptions(input.message, candidates);
  if (candidates.length === 1) return decided(candidates[0]!.agentId, "only", probs);
  const held = candidates.find((c) => c.agentId === input.current);
  if (held) return decided(held.agentId, "thread", probs);
  const ranked = [...candidates].sort((a, b) => probs[b.agentId]! - probs[a.agentId]! || (a.agentId < b.agentId ? -1 : 1));
  const confidence = probs[ranked[0]!.agentId]!;
  if (confidence < LOW_CONFIDENCE) return { t: "ask-user", top3: ranked.slice(0, 3).map((c) => c.agentId), probs, confidence, router: ROUTER };
  return decided(ranked[0]!.agentId, "score", probs);
}

/** The member chose from the choices route() offered. The scores are kept, so the record shows what the router thought. */
export function picked(input: RouteInput, agentId: AgentId): RouteDecision {
  if (!input.candidates.some((c) => c.agentId === agentId)) return { t: "unavailable", reason: "That agent does not answer in this channel." };
  return decided(agentId, "picked", scoreOptions(input.message, input.candidates));
}

function decided(agentId: AgentId, basis: RouteBasis, probs: Readonly<Record<string, number>>): RouteDecision {
  return { t: "agent", agentId, basis, probs, confidence: probs[agentId]!, router: ROUTER };
}

/** Words that say nothing about which agent a question is for. */
const STOPWORDS = new Set("a about am an and any are as at be by can could do does for from get had has have how i if in is it me my of on or our should so than that the their there this to was we what when where which who why will with would you your".split(" "));
const termsOf = (text: string) => tokenize(text).filter((t) => !STOPWORDS.has(t));

/** What the router reads of an option. A description's "Not for" sentence names other agents' topics, so it is left out. */
export function profileText(l: Pick<AgentListing, "name" | "description" | "sampleQuestions">): string {
  const description = l.description.split(/(?<=[.!?])\s+/).filter((s) => !/^not for\b/i.test(s));
  return [l.name, ...description, ...l.sampleQuestions].join("\n");
}

const K1 = 1.2;
const B = 0.75;

/**
 * BM25 of the message against each option's profile, then a softmax. The idf is log(n / df), so a word every option
 * uses scores zero: it cannot tell them apart. No shared word at all leaves every option equal.
 */
export function scoreOptions(message: string, candidates: readonly AgentListing[]): Record<string, number> {
  const docs = candidates.map((c) => {
    const tf = new Map<string, number>();
    for (const t of termsOf(profileText(c))) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });
  const lengths = docs.map((tf) => [...tf.values()].reduce((s, n) => s + n, 0));
  const avg = lengths.reduce((s, n) => s + n, 0) / (lengths.length || 1) || 1;
  const terms = [...new Set(termsOf(message.slice(0, MAX_MESSAGE_CHARS)))];
  const raw = docs.map((tf, i) => {
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term);
      if (!f) continue;
      const idf = Math.log(docs.length / docs.filter((d) => d.has(term)).length);
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * lengths[i]!) / avg));
    }
    return score;
  });
  const top = Math.max(...raw);
  const exps = raw.map((s) => Math.exp((s - top) / TEMPERATURE));
  const z = exps.reduce((s, e) => s + e, 0);
  return Object.fromEntries(candidates.map((c, i) => [c.agentId, Math.round((exps[i]! / z) * 1e4) / 1e4]));
}

/** Watched channels: should this agent reply to a post nobody addressed? Yes/no via choose() with two options. */
export async function shouldReply(_post: string, _agent: AgentListing, _cls: DataClass, _profiles: readonly RouterProfile[], _gateway: ModelGateway, _rec: CallRecorder, _signal: AbortSignal): Promise<{ readonly reply: boolean; readonly p: number; readonly threshold: number; readonly router: string }> {
  throw new Error("not implemented");
}

export interface OverlapReport {
  /** Share of other agents' sample questions the draft would capture. High = HAL. */
  readonly captures: readonly { readonly agentId: AgentId; readonly share: number }[];
  /** Share of the draft's own sample questions it wins. Low = never chosen. */
  readonly ownWinRate: number;
  readonly blocking: boolean;
}

/** Pure over decisions already made by route(). Publish runs route() on every sample question with the draft added, then calls this. */
export function overlapReport(_draft: AgentId, _decisions: readonly { readonly question: string; readonly owner: AgentId; readonly decision: RouteDecision }[]): OverlapReport {
  throw new Error("not implemented");
}
