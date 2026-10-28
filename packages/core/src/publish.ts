/**
 * Publish: the gate between a draft (owned by the studio) and the live head
 * (owned here).
 *
 *   agent_heads(agent_id PK, document, listing, version, draft_hash, published_by, published_at, changelog)
 *
 * Invariants:
 * - Only confirmPublish writes agent_heads, in one transaction with the
 *   agent_versions insert and the audit row. One owner of "what is live".
 * - The head stores the AgentDocument with floating refs; intake resolves it
 *   per run. `version` is the hash it resolved to at publish, for the record.
 * - The author confirms what they checked: confirmPublish takes the draft hash
 *   the check reported and refuses a document that no longer hashes to it.
 * - Confirming the same draft twice is a no-op.
 * - The role must cover the draft's ceiling, the ceiling of the head it
 *   replaces, and the ceiling of every head serving a channel it binds. A
 *   publisher cannot lower a steward's D3 agent to take its head or its
 *   channel.
 *
 * Checks in this build are validation only. Evals and router overlap join
 * the report with their units.
 */

import { listingOf, parseAgentDocument, resolveAgent, versionHash, type AgentDocument, type AgentId, type Catalog, type Issue, type MemberId } from "./agent.ts";
import { appendAuditInTx } from "./audit.ts";
import { join, type DataClass } from "./dataclass.ts";
import type { Db, Tx } from "./db.ts";
import type { ChannelRef } from "./gate.ts";
import { contentHash, type AgentVersionHash, type Sha256 } from "./hash.ts";
import { describeRoleRefusal, roleRefusal, type Actor, type RoleRefusal } from "./roles.ts";

export type PublishRefusal =
  | RoleRefusal
  | { readonly t: "invalid"; readonly issues: readonly Issue[] }
  | { readonly t: "stale"; readonly checked: Sha256; readonly current: Sha256 }
  | { readonly t: "changelog-missing" };

export function describePublishRefusal(r: PublishRefusal): string {
  switch (r.t) {
    case "role":
      return describeRoleRefusal(r);
    case "invalid":
      return `Fix ${r.issues.length === 1 ? "this error" : `these ${r.issues.length} errors`} first: ${r.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`;
    case "stale":
      return "The agent changed after the checks ran. Run the checks again.";
    case "changelog-missing":
      return "Write a changelog note: what changed and why.";
  }
}

export class PublishRefused extends Error {
  readonly refusal: PublishRefusal;
  constructor(refusal: PublishRefusal) {
    super(describePublishRefusal(refusal));
    this.name = "PublishRefused";
    this.refusal = refusal;
  }
}

export interface Head {
  readonly agentId: AgentId;
  readonly version: AgentVersionHash;
  readonly draftHash: Sha256;
  readonly publishedBy: MemberId;
  readonly publishedAt: string;
  readonly changelog: string;
}

export interface PublishCheck {
  readonly agentId: AgentId;
  /** Content hash of the document checked. confirmPublish refuses any other. */
  readonly draftHash: Sha256;
  /** What the draft resolves to now. Null when it does not resolve. */
  readonly version: AgentVersionHash | null;
  readonly head: Head | null;
  readonly validation: readonly Issue[];
  /** Why this actor cannot confirm this draft, or null when they can (given a changelog). */
  readonly refusal: PublishRefusal | null;
}

export interface PublishDeps {
  readonly db: Db;
  /** Read per check, so a KB or skill published a moment ago resolves. */
  readonly catalog: () => Promise<Catalog>;
}

export function draftHashOf(doc: AgentDocument): Sha256 {
  return contentHash(doc);
}

function invalid(issues: readonly Issue[]): PublishRefusal {
  return { t: "invalid", issues: issues.filter((i) => i.severity === "error") };
}

/** The class a publish of this draft moves: its ceiling joined with the ceilings of the head it replaces and of every head on a channel it binds. */
async function publishClass(q: Db | Tx, doc: AgentDocument): Promise<DataClass> {
  const held = await q.query<{ ceiling: DataClass }>("select document->>'ceiling' as ceiling from agent_heads where agent_id = $1 or document->'channels' ?| $2::text[]", [doc.agentId, doc.channels]);
  return join(doc.ceiling, ...held.rows.map((r) => r.ceiling));
}

/** Runs the checks and reports them. Writes nothing; any role may look. */
export async function requestPublish(deps: PublishDeps, doc: AgentDocument, actor: Actor): Promise<PublishCheck> {
  const resolved = resolveAgent(doc, await deps.catalog());
  const validation = resolved.ok ? [] : resolved.issues;
  return {
    agentId: doc.agentId,
    draftHash: draftHashOf(doc),
    version: resolved.ok ? versionHash(resolved.agent) : null,
    head: await headOf(deps.db, doc.agentId),
    validation,
    refusal: roleRefusal(actor, await publishClass(deps.db, doc)) ?? (resolved.ok ? null : invalid(validation)),
  };
}

export type Published = { readonly t: "published"; readonly head: Head; readonly previous: AgentVersionHash | null } | { readonly t: "unchanged"; readonly head: Head };

/** One transaction: the version row, the head and the audit row. Throws PublishRefused. */
export async function confirmPublish(deps: PublishDeps, doc: AgentDocument, checked: Sha256, actor: Actor, changelog: string): Promise<Published> {
  const note = changelog.trim();
  if (!note) throw new PublishRefused({ t: "changelog-missing" });
  const draftHash = draftHashOf(doc);
  if (draftHash !== checked) throw new PublishRefused({ t: "stale", checked, current: draftHash });
  const role = roleRefusal(actor, doc.ceiling);
  if (role) throw new PublishRefused(role);
  const resolved = resolveAgent(doc, await deps.catalog());
  if (!resolved.ok) throw new PublishRefused(invalid(resolved.issues));
  const version = versionHash(resolved.agent);

  const client = await deps.db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 1))", [`agent_heads:${doc.agentId}`]);
    const held = roleRefusal(actor, await publishClass(client, doc));
    if (held) throw new PublishRefused(held);
    const before = await client.query<HeadRow>(`select ${HEAD_COLUMNS} from agent_heads where agent_id = $1`, [doc.agentId]);
    const previous = before.rows[0] ? headFromRow(before.rows[0]) : null;
    if (previous?.draftHash === draftHash) {
      await client.query("commit");
      return { t: "unchanged", head: previous };
    }
    await client.query("insert into agent_versions (hash, agent_id, body) values ($1, $2, $3) on conflict (hash) do nothing", [version, doc.agentId, JSON.stringify(resolved.agent)]);
    const written = await client.query<HeadRow>(
      `insert into agent_heads (agent_id, document, listing, version, draft_hash, published_by, published_at, changelog)
       values ($1, $2, $3, $4, $5, $6, now(), $7)
       on conflict (agent_id) do update set document = excluded.document, listing = excluded.listing, version = excluded.version,
         draft_hash = excluded.draft_hash, published_by = excluded.published_by, published_at = excluded.published_at, changelog = excluded.changelog
       returning ${HEAD_COLUMNS}`,
      [doc.agentId, JSON.stringify(doc), JSON.stringify(listingOf(doc)), version, draftHash, actor.id, note],
    );
    await appendAuditInTx(client, actor.id, { t: "agent.published", agentId: doc.agentId, version, previous: previous?.version ?? null, draftHash, changelog: note });
    await client.query("commit");
    return { t: "published", head: headFromRow(written.rows[0]!), previous: previous?.version ?? null };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

const HEAD_COLUMNS = "agent_id, version, draft_hash, published_by, published_at, changelog";

interface HeadRow {
  agent_id: string;
  version: string;
  draft_hash: string;
  published_by: string;
  published_at: Date;
  changelog: string;
}

function headFromRow(r: HeadRow): Head {
  return {
    agentId: r.agent_id as AgentId,
    version: r.version as AgentVersionHash,
    draftHash: r.draft_hash as Sha256,
    publishedBy: r.published_by as MemberId,
    publishedAt: r.published_at.toISOString(),
    changelog: r.changelog,
  };
}

export async function headOf(db: Db, agentId: AgentId): Promise<Head | null> {
  const row = await db.query<HeadRow>(`select ${HEAD_COLUMNS} from agent_heads where agent_id = $1`, [agentId]);
  return row.rows[0] ? headFromRow(row.rows[0]) : null;
}

/** The published agent bound to a channel (its `channels` list names `surface:channel`), newest publish first. The router replaces this for unbound channels. */
export async function publishedAgentFor(db: Db, channel: ChannelRef): Promise<AgentDocument | undefined> {
  const row = await db.query<{ document: unknown }>("select document from agent_heads where document->'channels' ? $1 order by published_at desc limit 1", [`${channel.surface}:${channel.channelId}`]);
  if (!row.rows[0]) return undefined;
  const parsed = parseAgentDocument(row.rows[0].document);
  if (!parsed.ok) throw new Error(`agent_heads holds a document that no longer parses: ${parsed.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`);
  return parsed.doc;
}

export async function unpublish(_agentId: AgentId, _actor: MemberId, _reason: string): Promise<void> {
  throw new Error("unpublish arrives with the router unit");
  // Keeps KBs and skills (kill the agent, keep the knowledge). Frozen bindings keep working: they reference hashes, not heads.
}
