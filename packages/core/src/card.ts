/**
 * The agent card: what an IRB, a research IT reviewer or a paper's methods
 * section needs to say which agent answered, as JSON a schema checks.
 *
 *   ResolvedAgent (by hash) + lab.toml placements + tool registry + snapshot manifests + listing + freezes
 *        |  agentCard()      pure
 *        v
 *   AgentCard  -> `aliquot card <hash>`, the reviewer bundle, schemas/agent-card.schema.json
 *
 * Everything that describes behavior comes from the version, so two cards of
 * one hash differ only in what the deployment says around it (placements,
 * which tools are deployed now, the listing and the study freezes).
 */

import { z } from "zod";
import { listingOf, parseAgentDocument, promptFrameOf, PROMPT_FRAME_V1, type AgentId, type AgentListing, type ResolvedAgent } from "./agent.ts";
import type { SharedCore } from "./boot-shared.ts";
import { ceilingOf, DATA_CLASSES, join, PLACEMENTS, type Placement } from "./dataclass.ts";
import { canonicalJson, contentHash, sha256, type AgentVersionHash } from "./hash.ts";
import { loadManifest, type KbSnapshot, type Outline } from "./kb.ts";
import { systemPrompt } from "./loop.ts";
import { loadVersion } from "./publish.ts";
import type { Freeze } from "./study.ts";
import type { ToolRegistry } from "./tools.ts";

const dataClass = z.enum(DATA_CLASSES);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const placement = z.enum(PLACEMENTS);
const receives = z.union([dataClass, z.literal("none")]).describe("The most restricted class this destination may receive, from its placement (CEILINGS in dataclass.ts). none: nothing.");

const modelPlacement = z.object({
  endpointId: z.string(),
  modelId: z.string(),
  placement: placement.nullable().describe("From lab.toml. Null when this deployment has no such endpoint."),
  receivesUpTo: receives.nullable(),
});

export const agentCardSchema = z
  .object({
    format: z.literal("aliquot-agent-card-v1"),
    hash: hex64.describe("The agent version: sha256 of the canonical JSON of the resolved agent."),
    agentId: z.string(),
    name: z.string().nullable(),
    loopContract: z.string().describe("The run policy this version runs under."),
    model: modelPlacement.extend({ params: z.record(z.string(), z.unknown()) }),
    modelsByClass: z.array(modelPlacement.extend({ upTo: dataClass })).describe("Per-class bands, lowest first. Empty: model answers every class."),
    agentCli: z.object({ kind: z.string(), cliVersion: z.string() }).nullable(),
    tools: z.array(
      z.object({
        name: z.string(),
        specHash: hex64.describe("sha256 of the tool's spec: description, input schema, reads, effects, egress."),
        deployedNow: z.boolean().describe("Whether this deployment serves this spec hash today."),
        reads: dataClass.nullable(),
        effects: z.enum(["read", "lab-write", "external-send"]).nullable(),
        egress: z.array(z.string()).nullable().describe("Hosts the tool may reach."),
      }),
    ),
    knowledgeBases: z.array(
      z.object({
        kbId: z.string(),
        snapshot: hex64,
        cls: dataClass,
        title: z.string().nullable(),
        entries: z.number().int().nullable(),
        irbProtocol: z.string().nullable(),
        consentScope: z.string().nullable(),
      }),
    ),
    dataCeilings: z.object({
      agent: dataClass.nullable().describe("The listing's ceiling: the most restricted class the agent may see."),
      instructions: dataClass,
      knowledgeBases: dataClass.nullable().describe("The highest class among the knowledge bases. Null: none."),
      sandboxMounts: dataClass.nullable(),
    }),
    prompt: z.object({
      frame: z.enum(["v1", "custom"]).describe("v1: PROMPT_FRAME_V1. custom: a frame written by a later release, in the resolved agent."),
      frameSha256: hex64,
      systemTextSha256: hex64.nullable().describe("sha256 of the exact system prompt text. Null when a snapshot manifest was not available."),
    }),
    retrieval: z.object({ algorithm: z.string(), readCapTokens: z.number().int() }),
    limits: z.object({ maxSteps: z.number().int(), maxTokens: z.number().int(), maxWallMs: z.number().int() }),
    sandbox: z.object({ imageDigest: z.string(), mountCeiling: dataClass, mounts: z.array(z.string()) }).nullable(),
    listing: z
      .object({
        description: z.string(),
        owner: z.string(),
        audience: z.unknown(),
        irbProtocol: z.string().nullable(),
        provenancePolicy: z.object({ numbersMustTrace: z.boolean(), claimsLinkEvidence: z.boolean() }),
      })
      .nullable()
      .describe("Routing and governance, not behavior: the listing at freeze when frozen, else the published one."),
    studies: z.array(z.object({ studyId: z.string(), frozenBy: z.string(), at: z.string(), note: z.string() })).describe("Active freezes of this exact version."),
  })
  .strict()
  .meta({ title: "Aliquot agent card" });

export type AgentCard = z.infer<typeof agentCardSchema>;

/** The card's JSON Schema, as schemas/agent-card.schema.json holds it. */
export function agentCardJsonSchema(): unknown {
  return z.toJSONSchema(agentCardSchema, { target: "draft-2020-12" });
}

export interface CardSources {
  readonly placements: ReadonlyMap<string, Placement>;
  readonly registry: ToolRegistry;
  /** The manifests of the version's snapshots this deployment has; a missing one leaves its fields and the system text hash null. */
  readonly snapshots: ReadonlyMap<string, KbSnapshot>;
  readonly name: string | null;
  readonly listing: AgentListing | null;
  readonly freezes: readonly Freeze[];
}

export function outlineOf(s: KbSnapshot): Outline {
  return { title: s.title, purpose: s.purpose, paths: Object.keys(s.entries).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
}

/** Pure. Throws if the result does not match the schema, so no card leaves that a reviewer's validator would refuse. */
export function agentCard(hash: AgentVersionHash, agent: ResolvedAgent, src: CardSources): AgentCard {
  const where = (endpointId: string, modelId: string) => {
    const p = src.placements.get(endpointId) ?? null;
    return { endpointId, modelId, placement: p, receivesUpTo: p ? ceilingOf("model", p) : null };
  };
  const snaps = agent.knowledgeBases.map((kb) => src.snapshots.get(kb.snapshot) ?? null);
  const frame = promptFrameOf(agent);
  const listing = src.freezes[0]?.listing ?? src.listing;
  const deployed = src.registry.deployed();
  const card: AgentCard = {
    format: "aliquot-agent-card-v1",
    hash,
    agentId: agent.agentId,
    name: src.name,
    loopContract: agent.loopContract,
    model: { ...where(agent.model.endpointId, agent.model.modelId), params: { ...agent.model.params } },
    modelsByClass: (agent.modelsByClass ?? []).map((b) => ({ upTo: b.upTo, ...where(b.target.endpointId, b.target.modelId) })),
    agentCli: agent.agentCli ? { ...agent.agentCli } : null,
    tools: agent.tools.map((t) => {
      const m = src.registry.get(t.name)?.manifest;
      return { name: t.name, specHash: t.hash, deployedNow: deployed.get(t.name) === t.hash, reads: m?.reads ?? null, effects: m?.effects ?? null, egress: m ? [...m.egress] : null };
    }),
    knowledgeBases: agent.knowledgeBases.map((kb, i) => {
      const s = snaps[i];
      return { kbId: kb.kbId, snapshot: kb.snapshot, cls: kb.cls, title: s?.title ?? null, entries: s ? Object.keys(s.entries).length : null, irbProtocol: s?.irbProtocol ?? null, consentScope: s?.consentScope ?? null };
    }),
    dataCeilings: {
      agent: listing?.ceiling ?? null,
      instructions: agent.instructionsClass,
      knowledgeBases: agent.knowledgeBases.length ? join(...agent.knowledgeBases.map((k) => k.cls)) : null,
      sandboxMounts: agent.sandbox?.mountCeiling ?? null,
    },
    prompt: {
      frame: canonicalJson(frame) === canonicalJson(PROMPT_FRAME_V1) ? "v1" : "custom",
      frameSha256: contentHash(frame),
      systemTextSha256: snaps.every((s) => s !== null) ? sha256(systemPrompt(agent, snaps.map((s) => outlineOf(s!)))) : null,
    },
    retrieval: { ...agent.retrieval },
    limits: { ...agent.limits },
    sandbox: agent.sandbox ? { imageDigest: agent.sandbox.imageDigest, mountCeiling: agent.sandbox.mountCeiling, mounts: [...agent.sandbox.mounts] } : null,
    listing: listing ? { description: listing.description, owner: listing.owner, audience: listing.audience, irbProtocol: listing.irbProtocol, provenancePolicy: { ...listing.provenancePolicy } } : null,
    studies: src.freezes.map((f) => ({ studyId: f.studyId, frozenBy: f.frozenBy, at: f.at, note: f.note })),
  };
  return agentCardSchema.parse(card);
}

export type CardCore = Pick<SharedCore, "db" | "store" | "config" | "registry" | "fixtureSnapshots" | "agents">;

/** The listing and name an agent id has now: its published head, else the deployment's fixture. */
export async function listingNow(core: CardCore, agentId: AgentId): Promise<{ readonly name: string; readonly listing: AgentListing } | null> {
  const head = (await core.db.query<{ document: unknown; listing: AgentListing }>("select document, listing from agent_heads where agent_id = $1", [agentId])).rows[0];
  if (head) {
    const parsed = parseAgentDocument(head.document);
    return { name: parsed.ok ? parsed.doc.name : agentId, listing: head.listing };
  }
  const doc = core.agents.find((a) => a.agentId === agentId);
  return doc ? { name: doc.name, listing: listingOf(doc) } : null;
}

/** The card of a stored version on this deployment. */
export async function cardFor(core: CardCore, hash: AgentVersionHash): Promise<AgentCard> {
  const agent = await loadVersion(core.db, hash);
  const snapshots = new Map<string, KbSnapshot>();
  for (const kb of agent.knowledgeBases) {
    const s = core.fixtureSnapshots.find((l) => l.snapshot.id === kb.snapshot)?.snapshot ?? (await loadManifest(core.db, core.store.address, kb.snapshot));
    if (s) snapshots.set(kb.snapshot, s);
  }
  const rows = await core.db.query<{ study_id: string; agent_id: string; hash: string; frozen_by: string; at: Date; note: string; listing: AgentListing }>(
    "select study_id, agent_id, hash, frozen_by, at, note, listing from freezes where hash = $1 and unfrozen_at is null order by study_id",
    [hash],
  );
  const freezes: Freeze[] = rows.rows.map((r) => ({ studyId: r.study_id, agentId: r.agent_id as AgentId, hash, frozenBy: r.frozen_by as Freeze["frozenBy"], at: r.at.toISOString(), note: r.note, listing: r.listing }));
  const now = await listingNow(core, agent.agentId);
  const placements = new Map<string, Placement>([...core.config.endpoints.map((e) => [e.id, e.placement] as const), ...core.config.agentBackends.map((b) => [b.id, b.placement] as const)]);
  return agentCard(hash, agent, { placements, registry: core.registry, snapshots, name: now?.name ?? null, listing: now?.listing ?? null, freezes });
}
