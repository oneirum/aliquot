/**
 * Studies and freezes.
 *
 *   studies(id PK, title, owner, prereg_url, irb_protocol, consent_scope, data_floor)
 *   study_channels(study_id, surface, channel_id)    PK(surface, channel_id): a channel belongs to at most one study
 *   freezes(study_id, agent_id, hash, frozen_by, at, note, unfrozen_at, unfrozen_by, reason)
 *
 * Invariants:
 * - A freeze binds a study to an AgentVersionHash. Hashes are immutable, so no
 *   later edit, publish or unpublish can change what a study channel runs.
 * - At most one active freeze per (study, agent).
 * - freeze is idempotent: freezing the same hash again returns the existing row.
 * - Unfreeze needs the study owner and a reason, and is exported as a protocol deviation.
 * - Every write appends to the audit stream in the same transaction.
 */

import type { AgentId, MemberId, AgentCard } from "./agent.ts";
import type { AgentVersionHash } from "./hash.ts";
import type { DataClass } from "./dataclass.ts";
import type { ChannelRef } from "./gate.ts";

export interface Study {
  readonly id: string;
  readonly title: string;
  readonly owner: MemberId;
  readonly preregUrl: string | null;
  readonly irbProtocol: string | null;
  readonly consentScope: string | null;
  /** Class floor for messages in this study's channels. */
  readonly dataFloor: DataClass;
  readonly channels: readonly ChannelRef[];
}

export interface Freeze {
  readonly studyId: string;
  readonly agentId: AgentId;
  readonly hash: AgentVersionHash;
  readonly frozenBy: MemberId;
  readonly at: string;
  readonly note: string;
}

export interface Deviation {
  readonly studyId: string;
  readonly agentId: AgentId;
  readonly hash: AgentVersionHash;
  readonly by: MemberId;
  readonly reason: string;
  readonly at: string;
}

/** Checks: actor is study owner; verifyRunnable(hash) is empty; agent.ceiling >= study.dataFloor; irbProtocol matches when floor >= D3. */
export async function freeze(_studyId: string, _agentId: AgentId, _hash: AgentVersionHash, _actor: MemberId, _note: string): Promise<Freeze> {
  throw new Error("not implemented");
}

export async function unfreeze(_studyId: string, _agentId: AgentId, _actor: MemberId, _reason: string): Promise<Deviation> {
  throw new Error("not implemented");
}

/** Called by intake before routing. A study channel with one active freeze pins it; with several, the user picks from the frozen agents only. */
export async function pinFor(_channel: ChannelRef): Promise<{ readonly study: Study; readonly freezes: readonly Freeze[] } | null> {
  throw new Error("not implemented");
}

export async function card(_hash: AgentVersionHash): Promise<AgentCard> {
  throw new Error("not implemented");
}

/** Helper: where participant data goes for this study, drafted for the IRB to edit. Derived from the frozen versions' model placements, retention and record access. */
export async function consentDisclosureDraft(_studyId: string): Promise<string> {
  throw new Error("not implemented");
}
