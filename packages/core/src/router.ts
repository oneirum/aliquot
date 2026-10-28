/**
 * Router: Sanity's classifier design with its defaults.
 *
 * Policy lives here; transport and egress live in the gateway. A hosted
 * decision model is just a ModelTarget whose endpoint placement is zdr or
 * approved, so a D3 message can never reach it: route() picks the profile
 * whose placement admits the message class, and the gateway enforces it anyway.
 *
 * Study channels never call route(): intake pins the frozen version first.
 */

import type { DataClass } from "./dataclass.ts";
import type { AgentId, AgentListing } from "./agent.ts";
import type { ModelGateway, ModelTarget } from "./gateway.ts";
import type { CallRecorder } from "./record.ts";

export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_THREAD_MESSAGES = 20;
export const SELF_OPTION = "harness:self";

/**
 * One profile per backend. lowConfidence is on that backend's own scale:
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
  readonly thread: readonly string[];
  readonly cls: DataClass;
  readonly candidates: readonly AgentListing[];
  /** Follow-ups stay put: the agent currently holding the thread. */
  readonly current: AgentId | null;
}

export type RouteDecision =
  | { readonly t: "agent"; readonly agentId: AgentId; readonly probs: Readonly<Record<string, number>>; readonly confidence: number; readonly router: string }
  | { readonly t: "ask-user"; readonly top3: readonly AgentId[]; readonly probs: Readonly<Record<string, number>>; readonly confidence: number; readonly router: string }
  | { readonly t: "self"; readonly confidence: number; readonly router: string }
  | { readonly t: "unavailable"; readonly reason: string };

/** Profiles ordered by preference; the first whose endpoint placement admits input.cls is used. None -> menu of routable agents. */
export async function route(_input: RouteInput, _profiles: readonly RouterProfile[], _gateway: ModelGateway, _rec: CallRecorder, _signal: AbortSignal): Promise<RouteDecision> {
  throw new Error("not implemented");
  // TODO truncate message to 8000 chars and thread to last 20; options = candidates (routable, audience-allowed) + SELF_OPTION;
  // state includes "current agent: X" when current != null; argmax wins unless confidence < lowConfidence -> ask-user top3.
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
