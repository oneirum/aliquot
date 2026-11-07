/**
 * Studies and freezes.
 *
 *   studies(id PK, title, owner, prereg_url, irb_protocol, consent_scope, data_floor)
 *   study_channels(study_id, surface, channel_id)    PK(surface, channel_id): a channel belongs to at most one study
 *   freezes(study_id, agent_id, hash, frozen_by, at, note, listing, unfrozen_at, unfrozen_by, reason)
 *
 * Invariants:
 * - A freeze binds a study to an AgentVersionHash. Hashes are immutable, so no
 *   later edit, publish or unpublish can change what a study channel runs.
 * - At most one active freeze per (study, agent).
 * - freeze is idempotent: freezing the same hash again returns the existing row.
 *   Freezing another hash while one is active is refused: the owner unfreezes first.
 * - Unfreeze needs the study owner and a reason, and is exported as a protocol deviation.
 * - Every write appends to the audit stream in the same transaction.
 * - The freezes guard (migration 0005) refuses a delete, and any update but the one that ends a freeze.
 */

import { atMost, rank, type DataClass } from "./dataclass.ts";
import { verifyRunnable, type AgentId, type AgentListing, type Deployed, type MemberId } from "./agent.ts";
import { appendAudit } from "./audit.ts";
import type { Db } from "./db.ts";
import type { ChannelRef } from "./gate.ts";
import type { AgentVersionHash } from "./hash.ts";
import { loadVersion } from "./publish.ts";

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
  /** The agent's listing (ceiling, IRB protocol, provenance policy) when it was frozen. */
  readonly listing: AgentListing;
}

/** A freeze ended before the study did: when the version was frozen and by whom, and when, by whom and why it ended. */
export interface Deviation {
  readonly studyId: string;
  readonly agentId: AgentId;
  readonly hash: AgentVersionHash;
  readonly frozenBy: MemberId;
  readonly frozenAt: string;
  readonly note: string;
  readonly by: MemberId;
  readonly reason: string;
  readonly at: string;
}

/** A study write the actor or the study's rules do not allow. The message is for the person who asked. */
export class StudyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudyRefused";
  }
}

export type NewStudy = Omit<Study, "channels" | "preregUrl" | "irbProtocol" | "consentScope"> & Partial<Pick<Study, "preregUrl" | "irbProtocol" | "consentScope">>;

interface StudyRow {
  id: string;
  title: string;
  owner: string;
  prereg_url: string | null;
  irb_protocol: string | null;
  consent_scope: string | null;
  data_floor: DataClass;
}

export async function getStudy(db: Db, studyId: string): Promise<Study | null> {
  const row = (await db.query<StudyRow>("select id, title, owner, prereg_url, irb_protocol, consent_scope, data_floor from studies where id = $1", [studyId])).rows[0];
  if (!row) return null;
  const channels = await db.query<{ surface: string; channel_id: string }>("select surface, channel_id from study_channels where study_id = $1 order by surface, channel_id", [studyId]);
  return {
    id: row.id,
    title: row.title,
    owner: row.owner as MemberId,
    preregUrl: row.prereg_url,
    irbProtocol: row.irb_protocol,
    consentScope: row.consent_scope,
    dataFloor: row.data_floor,
    channels: channels.rows.map((c) => ({ surface: c.surface, channelId: c.channel_id })),
  };
}

export async function listStudies(db: Db): Promise<Study[]> {
  const ids = await db.query<{ id: string }>("select id from studies order by id");
  return (await Promise.all(ids.rows.map((r) => getStudy(db, r.id)))).filter((s): s is Study => s !== null);
}

async function owned(db: Db, studyId: string, actor: MemberId): Promise<Study> {
  const study = await getStudy(db, studyId);
  if (!study) throw new StudyRefused(`no study ${studyId}`);
  if (study.owner !== actor) throw new StudyRefused(`only the study owner, ${study.owner}, may change study ${studyId}`);
  return study;
}

/** Idempotent: creating the same study again returns it; the same id with other fields is refused. */
export async function createStudy(db: Db, s: NewStudy): Promise<Study> {
  const existing = await getStudy(db, s.id);
  const same = (e: Study) => e.title === s.title && e.owner === s.owner && e.dataFloor === s.dataFloor && e.irbProtocol === (s.irbProtocol ?? null) && e.preregUrl === (s.preregUrl ?? null) && e.consentScope === (s.consentScope ?? null);
  if (existing) {
    if (same(existing)) return existing;
    throw new StudyRefused(`study ${s.id} exists with other details`);
  }
  if (rank(s.dataFloor) >= rank("D3") && !s.irbProtocol) throw new StudyRefused(`a study with a ${s.dataFloor} floor must name its IRB protocol`);
  await appendAudit(db, s.owner, { t: "study.created", studyId: s.id, title: s.title, owner: s.owner, irbProtocol: s.irbProtocol ?? null, dataFloor: s.dataFloor }, async (tx) => {
    await tx.query("insert into studies (id, title, owner, prereg_url, irb_protocol, consent_scope, data_floor) values ($1, $2, $3, $4, $5, $6, $7)", [
      s.id,
      s.title,
      s.owner,
      s.preregUrl ?? null,
      s.irbProtocol ?? null,
      s.consentScope ?? null,
      s.dataFloor,
    ]);
  });
  return (await getStudy(db, s.id))!;
}

/** Idempotent. A channel already in another study is refused: a channel belongs to at most one study. */
export async function bindChannel(db: Db, studyId: string, channel: ChannelRef, actor: MemberId): Promise<Study> {
  await owned(db, studyId, actor);
  const held = (await db.query<{ study_id: string }>("select study_id from study_channels where surface = $1 and channel_id = $2", [channel.surface, channel.channelId])).rows[0];
  if (held?.study_id === studyId) return (await getStudy(db, studyId))!;
  if (held) throw new StudyRefused(`channel ${channel.surface}:${channel.channelId} belongs to study ${held.study_id}`);
  await appendAudit(db, actor, { t: "study.channel-bound", studyId, surface: channel.surface, channelId: channel.channelId }, async (tx) => {
    await tx.query("insert into study_channels (study_id, surface, channel_id) values ($1, $2, $3)", [studyId, channel.surface, channel.channelId]);
  });
  return (await getStudy(db, studyId))!;
}

interface FreezeRow {
  study_id: string;
  agent_id: string;
  hash: string;
  frozen_by: string;
  at: Date;
  note: string;
  listing: AgentListing;
}

const FREEZE_COLUMNS = "study_id, agent_id, hash, frozen_by, at, note, listing";

function freezeOf(r: FreezeRow): Freeze {
  return { studyId: r.study_id, agentId: r.agent_id as AgentId, hash: r.hash as AgentVersionHash, frozenBy: r.frozen_by as MemberId, at: r.at.toISOString(), note: r.note, listing: r.listing };
}

export async function activeFreezes(db: Db, studyId: string): Promise<Freeze[]> {
  const rows = await db.query<FreezeRow>(`select ${FREEZE_COLUMNS} from freezes where study_id = $1 and unfrozen_at is null order by agent_id`, [studyId]);
  return rows.rows.map(freezeOf);
}

/**
 * Checks: actor is study owner; verifyRunnable(hash) is empty; the listing's ceiling admits the study's floor; the
 * listing names the study's IRB protocol when the floor is D3 or above. `listing` is the agent's listing now, stored
 * with the freeze; `deployed` is what this deployment serves.
 */
export async function freeze(db: Db, studyId: string, hash: AgentVersionHash, actor: MemberId, note: string, check: { readonly listing: AgentListing; readonly deployed: Deployed }): Promise<Freeze> {
  const study = await owned(db, studyId, actor);
  const agent = await loadVersion(db, hash);
  const active = (await activeFreezes(db, studyId)).find((f) => f.agentId === agent.agentId);
  if (active?.hash === hash) return active;
  if (active) throw new StudyRefused(`study ${studyId} has ${agent.agentId} frozen at ${active.hash.slice(0, 12)}; unfreeze it first, with a reason`);
  if (!note.trim()) throw new StudyRefused("a freeze needs a note");
  const problems = verifyRunnable(agent, check.deployed);
  if (problems.length) throw new StudyRefused(`version ${hash.slice(0, 12)} cannot run on this deployment: ${problems.map((p) => p.t).join(", ")}`);
  if (!atMost(study.dataFloor, check.listing.ceiling)) throw new StudyRefused(`${agent.agentId} has ceiling ${check.listing.ceiling}, below the study's floor ${study.dataFloor}`);
  if (rank(study.dataFloor) >= rank("D3") && check.listing.irbProtocol !== study.irbProtocol) {
    throw new StudyRefused(`${agent.agentId} names IRB protocol ${check.listing.irbProtocol ?? "none"}; study ${studyId} runs under ${study.irbProtocol}`);
  }
  await appendAudit(db, actor, { t: "agent.frozen", studyId, agentId: agent.agentId, version: hash, note }, async (tx) => {
    await tx.query("insert into freezes (study_id, agent_id, hash, frozen_by, note, listing) values ($1, $2, $3, $4, $5, $6)", [studyId, agent.agentId, hash, actor, note, JSON.stringify(check.listing)]);
  });
  return (await activeFreezes(db, studyId)).find((f) => f.agentId === agent.agentId)!;
}

export async function unfreeze(db: Db, studyId: string, agentId: AgentId, actor: MemberId, reason: string): Promise<Deviation> {
  await owned(db, studyId, actor);
  if (!reason.trim()) throw new StudyRefused("an unfreeze needs a reason; it is recorded as a protocol deviation");
  const active = (await activeFreezes(db, studyId)).find((f) => f.agentId === agentId);
  if (!active) throw new StudyRefused(`study ${studyId} has no active freeze of ${agentId}`);
  await appendAudit(db, actor, { t: "agent.unfrozen", studyId, agentId, version: active.hash, reason }, async (tx) => {
    await tx.query("update freezes set unfrozen_at = now(), unfrozen_by = $3, reason = $4 where study_id = $1 and agent_id = $2 and unfrozen_at is null", [studyId, agentId, actor, reason]);
  });
  return (await deviations(db, studyId)).findLast((d) => d.agentId === agentId)!;
}

/** Every freeze ended before the study did, oldest first. */
export async function deviations(db: Db, studyId: string): Promise<Deviation[]> {
  const rows = await db.query<{ agent_id: string; hash: string; frozen_by: string; at: Date; note: string; unfrozen_by: string; reason: string; unfrozen_at: Date }>(
    "select agent_id, hash, frozen_by, at, note, unfrozen_by, reason, unfrozen_at from freezes where study_id = $1 and unfrozen_at is not null order by unfrozen_at",
    [studyId],
  );
  return rows.rows.map((r) => ({
    studyId,
    agentId: r.agent_id as AgentId,
    hash: r.hash as AgentVersionHash,
    frozenBy: r.frozen_by as MemberId,
    frozenAt: r.at.toISOString(),
    note: r.note,
    by: r.unfrozen_by as MemberId,
    reason: r.reason,
    at: r.unfrozen_at.toISOString(),
  }));
}

/**
 * Called by intake before routing. Null when the channel is in no study. A study channel never routes: with one
 * active freeze it runs that hash, with several the member picks from the frozen agents only, with none it refuses.
 */
export async function pinFor(db: Db, channel: ChannelRef): Promise<{ readonly study: Study; readonly freezes: readonly Freeze[] } | null> {
  const row = (await db.query<{ study_id: string }>("select study_id from study_channels where surface = $1 and channel_id = $2", [channel.surface, channel.channelId])).rows[0];
  if (!row) return null;
  const study = await getStudy(db, row.study_id);
  return study ? { study, freezes: await activeFreezes(db, study.id) } : null;
}

/** Helper: where participant data goes for this study, drafted for the IRB to edit. Derived from the frozen versions' model placements, retention and record access. */
export async function consentDisclosureDraft(_studyId: string): Promise<string> {
  throw new Error("not implemented");
}
