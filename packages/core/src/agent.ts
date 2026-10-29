/**
 * The agent: an editable document, its routing listing, and its resolved,
 * hashed behavior.
 *
 *   AgentDocument  (draft, from studio or MCP; references float)
 *        |  resolveAgent(doc, catalog)      pure
 *        v
 *   ResolvedAgent  (every field the run loop reads; references pinned)
 *        |  versionHash()                   sha256(canonicalJson)
 *        v
 *   AgentVersionHash -> agent_versions row (immutable, upsert by hash)
 *
 * Freeze, run records, agent cards and replay all take an AgentVersionHash
 * and load the ResolvedAgent by it. Nothing else describes behavior.
 */

import { z } from "zod";
import { atMost, ceilingOf, DATA_CLASSES, Labelled, rank, type DataClass, type Placement } from "./dataclass.ts";
import { contentHash, type AgentVersionHash, type SkillVersionHash, type SnapshotId, type ToolHash, type Sha256 } from "./hash.ts";
import { DEFAULT_READ_CAP_TOKENS, RETRIEVAL_ALGORITHM } from "./kb.ts";
import type { ModelTarget, ExactModelId } from "./gateway.ts";
import type { AgentCliKind } from "./agents/backends.ts";

export type AgentId = string & { readonly __agent: true };
export type MemberId = string & { readonly __member: true };

export interface Limits {
  readonly maxSteps: number;
  readonly maxTokens: number;
  readonly maxWallMs: number;
}

/** Sanity's numbers. Applied at resolve time, so the hash always contains concrete limits. */
export const INTERACTIVE_LIMITS: Limits = { maxSteps: 40, maxTokens: 1_000_000, maxWallMs: 10 * 60_000 };
/** The spec gives steps and time only; tokens stay at 1M until a lab sets otherwise (open question). */
export const BACKGROUND_LIMITS: Limits = { maxSteps: 200, maxTokens: 1_000_000, maxWallMs: 60 * 60_000 };

export type Audience =
  | { readonly t: "lab" }
  | { readonly t: "study-team"; readonly studyId: string }
  | { readonly t: "pi-only" }
  | { readonly t: "members"; readonly members: readonly MemberId[] };

export interface EvalCase {
  readonly question: string;
  /** Exact expected text, or a rubric graded by a judge model through the gateway. */
  readonly expect: { readonly t: "contains"; readonly text: string } | { readonly t: "rubric"; readonly rubric: string };
}

export interface DocumentModel {
  readonly endpointId: string;
  readonly modelId: string;
  readonly params: ModelTarget["params"];
}

/**
 * The document a lab member edits. Parsed from Payload JSON (or MCP input) at
 * the studio boundary; core never sees Payload's shape.
 * References here are by id and float to the latest published version.
 */
export interface AgentDocument {
  readonly agentId: AgentId;
  readonly name: string;
  /** What the router reads. Must contain a "Use when" and a "Not for" sentence. */
  readonly description: string;
  readonly owner: MemberId;
  readonly maintainers: readonly MemberId[];
  readonly instructions: string;
  /** Class of the instructions text itself. D1 unless the author raises it. No detector reads instructions, so an author who writes restricted text into them must raise this. */
  readonly instructionsClass: DataClass;
  readonly model: DocumentModel;
  /** Optional per-class bands, lowest first: a call goes to the first band whose upTo admits its class. */
  readonly modelsByClass?: readonly { readonly upTo: DataClass; readonly model: DocumentModel }[];
  readonly skills: readonly string[];
  readonly knowledgeBases: readonly string[];
  /** kb_read's cap per call, in estimated tokens. Defaults to DEFAULT_READ_CAP_TOKENS. */
  readonly readCapTokens?: number;
  readonly tools: readonly { readonly name: string; readonly scopes: readonly string[] }[];
  readonly audience: Audience;
  readonly channels: readonly string[];
  readonly autoRespond: boolean;
  readonly routable: boolean;
  readonly sandbox: { readonly enabled: false } | { readonly enabled: true; readonly mountCeiling: DataClass; readonly mounts: readonly string[] };
  readonly kind: "interactive" | "background";
  readonly limits?: Partial<Limits>;
  readonly schedule?: { readonly cron: string; readonly prompt: string };
  readonly ceiling: DataClass;
  readonly provenancePolicy: { readonly numbersMustTrace: boolean; readonly claimsLinkEvidence: boolean };
  readonly evals: readonly EvalCase[];
  /** Questions this agent should win. Used by the router overlap check at publish. */
  readonly sampleQuestions: readonly string[];
  readonly irbProtocol?: string;
  /** The purpose stated against KB consent scopes. */
  readonly consentPurpose?: string;
}

/**
 * The version of next()'s semantics that this build runs. A version pinned
 * to another is unrunnable here. test/loop-contract.test.ts fingerprints
 * next() over a generated corpus and pins the result under this name, so a
 * change to the loop without a bump here fails the suite.
 */
export const LOOP_CONTRACT = "loop-v2";

/**
 * Behavior, and only behavior. Rule for contributors: a field is here if and
 * only if loop.ts (or something it calls during a run, verifyRunnable
 * included) reads it; test/agent.test.ts pins the rule. Everything else
 * (description, audience, channels, owner, sample questions, ceiling,
 * provenance policy, IRB protocol) is routing or governance and lives in
 * AgentListing, so editing it never changes a hash. Skills return here with
 * the skills unit, when the loop puts the catalog in the prompt.
 */
export interface ResolvedAgent {
  readonly schema: 2;
  readonly agentId: AgentId;
  /** Checked against LOOP_CONTRACT at run start, so a frozen card names the policy it ran under. */
  readonly loopContract: string;
  readonly instructions: string;
  readonly instructionsClass: DataClass;
  readonly model: ModelTarget;
  readonly knowledgeBases: readonly { readonly kbId: string; readonly snapshot: SnapshotId; readonly cls: DataClass }[];
  readonly tools: readonly { readonly name: string; readonly hash: ToolHash }[];
  readonly sandbox: null | { readonly imageDigest: Sha256; readonly mountCeiling: DataClass; readonly mounts: readonly string[] };
  /** The algorithm is checked against the deployed reader at run start; the cap is what kb_search and kb_read read up to. */
  readonly retrieval: { readonly algorithm: "bm25-v1"; readonly readCapTokens: number };
  readonly limits: Limits;
  /**
   * Present iff model.endpointId names an agent backend, and absent otherwise, so every version
   * hashed before agent backends existed keeps its hash (canonicalJson omits absent keys).
   */
  readonly agentCli?: { readonly kind: AgentCliKind; readonly cliVersion: string };
  /**
   * Per-class bands for the chat loop, lowest upTo first, each below the ceiling. model serves every class above
   * the last band. Absent: model serves every class, and every version hashed before bands existed keeps its hash.
   * Never present together with agentCli.
   */
  readonly modelsByClass?: readonly ModelBand[];
}

export interface ModelBand {
  readonly upTo: DataClass;
  readonly target: ModelTarget;
}

/** The target a prompt of this class goes to: the first band that admits it, otherwise model. */
export function modelFor(agent: ResolvedAgent, cls: DataClass): ModelTarget {
  return agent.modelsByClass?.find((b) => atMost(cls, b.upTo))?.target ?? agent.model;
}

/** What the router, gate, studio and card read. Mutable on publish, not hashed. */
export interface AgentListing {
  readonly agentId: AgentId;
  readonly name: string;
  readonly description: string;
  readonly owner: MemberId;
  readonly audience: Audience;
  readonly channels: readonly string[];
  readonly autoRespond: boolean;
  readonly routable: boolean;
  readonly sampleQuestions: readonly string[];
  readonly ceiling: DataClass;
  readonly provenancePolicy: AgentDocument["provenancePolicy"];
  readonly irbProtocol: string | null;
  readonly status: "published" | "retired" | "read-only";
}

/** Read side used by resolution and validation. Implemented over Postgres and fixtures; a fake in tests. */
export interface Catalog {
  latestSkill(skillId: string): { version: SkillVersionHash; name: string; summary: string; cls: DataClass } | undefined;
  latestSnapshot(kbId: string): { id: SnapshotId; cls: DataClass; consentScope?: string; irbProtocol?: string } | undefined;
  tool(name: string): { hash: ToolHash; reads: DataClass; effects: "read" | "lab-write" | "external-send" } | undefined;
  /** An endpoint, or an agent backend with the CLI version an agent worker last reported for it (null when none has). */
  endpoint(id: string): { placement: Placement; agentCli?: { kind: AgentCliKind; cliVersion: string | null } } | undefined;
  sandboxImage(): Sha256 | undefined;
  dataset(id: string): { cls: DataClass } | undefined;
}

export interface Issue {
  readonly field: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

const dataClass = z.enum(DATA_CLASSES);
const member = z.string().min(1);
/** Label and help text. The studio's form shows exactly these, so they are written for lab members, not developers. */
const says = (title: string, description?: string) => (description ? { title, description } : { title });

const modelSchema = z
  .object({
    endpointId: z.string().min(1).meta(says("Endpoint", "The model server from lab.toml that runs this agent, for example local.")),
    modelId: z.string().min(1).meta(says("Model id", "The exact model version, for example qwen3:8b. Aliases such as latest are refused, because they change under a study.")),
    params: z
      .object({
        temperature: z.number().min(0).max(2).default(0).meta(says("Temperature", "0 gives the most repeatable answers.")),
        maxOutputTokens: z.number().int().positive().default(1024).meta(says("Max output tokens", "The longest answer the model may write in one call.")),
        seed: z.number().int().optional().meta(says("Seed", "Optional. Some models repeat an answer exactly with the same seed.")),
        topP: z.number().min(0).max(1).optional().meta(says("Top p", "Optional sampling cutoff between 0 and 1.")),
      })
      .meta(says("Parameters")),
  });

/**
 * The one definition of the document's shape. The studio generates its form
 * fields, labels and help text from this schema; a field without a generated
 * form field fails test/studio-fields.test.ts.
 */
export const agentDocumentSchema = z.object({
  agentId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens, starting with a letter or digit")
    .meta(says("Agent id", "Short id used in links and run records, for example handbook. Lowercase letters, digits and hyphens.")),
  name: z.string().min(1).meta(says("Name", "What lab members see, for example Lab handbook.")),
  description: z
    .string()
    .min(1)
    .meta(says("Description", 'What the router reads to pick this agent. Write one sentence that starts with "Use when" and one that starts with "Not for".')),
  owner: member.meta(says("Owner", "The lab member responsible for this agent.")),
  maintainers: z.array(member).default([]).meta(says("Maintainers", "Other lab members who look after it.")),
  instructions: z.string().min(1).meta(says("Instructions", "What the agent is told at the start of every conversation.")),
  instructionsClass: dataClass.default("D1").meta(says("Instructions data class", "The data class of the instructions text itself. D1 unless the text contains restricted data.")),
  model: modelSchema.meta(says("Model")),
  modelsByClass: z
    .array(
      z.object({
        upTo: dataClass.meta(says("Up to data class", "This model answers questions up to this data class, which must be below the data ceiling. List the bands from the least restricted class to the most.")),
        model: modelSchema.meta(says("Model", "The model for this band. Its endpoint must be allowed to receive the band's data class.")),
      }),
    )
    .optional()
    .meta(says("Models by data class", "Optional. Send less restricted questions to other models, for example a hosted model for public data. Each band stops below the data ceiling, and the model above answers everything more restricted than the last band. Leave empty to use the model above for everything.")),
  skills: z.array(z.string()).default([]).meta(says("Skills", "Skill ids this agent may read.")),
  knowledgeBases: z.array(z.string()).default([]).meta(says("Knowledge bases", "Knowledge base ids. The agent searches the latest published snapshot of each.")),
  readCapTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .meta(says("Read cap (tokens)", "Optional. The most knowledge base text the agent may read in one call. Leave empty for the default.")),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).meta(says("Tool", "A deployed tool, for example kb_search.")),
        scopes: z.array(z.string()).default([]).meta(says("Scopes", "Optional limits on what the tool may touch.")),
      }),
    )
    .default([])
    .meta(says("Tools")),
  audience: z
    .discriminatedUnion("t", [
      z.object({ t: z.literal("lab").meta(says("Whole lab")) }),
      z.object({ t: z.literal("study-team").meta(says("A study team")), studyId: z.string().meta(says("Study id")) }),
      z.object({ t: z.literal("pi-only").meta(says("PI only")) }),
      z.object({ t: z.literal("members").meta(says("Named members")), members: z.array(member).meta(says("Members")) }),
    ])
    .default({ t: "lab" })
    .meta(says("Audience", "Who may talk to this agent.")),
  channels: z.array(z.string()).default([]).meta(says("Channels", "Where this agent answers without the router, as surface:channel, for example web:lab.")),
  autoRespond: z.boolean().default(false).meta(says("Answer without a mention", "Reply to every message in its channels, not only when addressed.")),
  routable: z.boolean().default(true).meta(says("Routable", "Let the router pick this agent for questions in shared channels.")),
  sandbox: z
    .discriminatedUnion("enabled", [
      z.object({ enabled: z.literal(false) }),
      z.object({
        enabled: z.literal(true).meta(says("Enabled")),
        mountCeiling: dataClass.meta(says("Mount ceiling", "The most restricted data class the sandbox may mount.")),
        mounts: z.array(z.string()).meta(says("Mounts", "Folder ids from the data steward's allowlist.")),
      }),
    ])
    .default({ enabled: false })
    .meta(says("Code sandbox", "Lets the agent run R and Python with no network.")),
  kind: z
    .enum(["interactive", "background"])
    .default("interactive")
    .meta(says("Kind", "Interactive agents answer in a thread. Background agents run longer jobs.")),
  limits: z
    .object({
      maxSteps: z.number().int().positive().optional().meta(says("Max steps")),
      maxTokens: z.number().int().positive().optional().meta(says("Max tokens")),
      maxWallMs: z.number().int().positive().optional().meta(says("Max time (ms)")),
    })
    .optional()
    .meta(says("Limits", "Leave empty for the lab defaults.")),
  schedule: z
    .object({ cron: z.string().meta(says("Cron", "When it runs, for example 0 9 * * 1.")), prompt: z.string().meta(says("Prompt", "What it is asked each time.")) })
    .optional()
    .meta(says("Schedule")),
  ceiling: dataClass.meta(says("Data ceiling", "The most restricted data class this agent may see. D3 or R needs a model endpoint on lab hardware.")),
  provenancePolicy: z
    .object({
      numbersMustTrace: z.boolean().default(false).meta(says("Numbers must trace to a source")),
      claimsLinkEvidence: z.boolean().default(false).meta(says("Claims link to evidence")),
    })
    .default({ numbersMustTrace: false, claimsLinkEvidence: false })
    .meta(says("Provenance")),
  evals: z
    .array(
      z.object({
        question: z.string().meta(says("Question")),
        expect: z
          .discriminatedUnion("t", [
            z.object({ t: z.literal("contains").meta(says("Answer contains")), text: z.string().meta(says("Text")) }),
            z.object({ t: z.literal("rubric").meta(says("Graded by rubric")), rubric: z.string().meta(says("Rubric")) }),
          ])
          .meta(says("Expected")),
      }),
    )
    .default([])
    .meta(says("Evals", "Questions checked before publish.")),
  sampleQuestions: z.array(z.string()).default([]).meta(says("Sample questions", "Questions this agent should win. The router uses them.")),
  irbProtocol: z.string().optional().meta(says("IRB protocol", "Required when the agent reads D3 data.")),
  consentPurpose: z.string().optional().meta(says("Consent purpose", "The purpose this agent serves, checked against knowledge base consent scopes.")),
});

/** Boundary: untyped JSON in, a typed document out. The branded ids are applied here and nowhere else. */
export function parseAgentDocument(json: unknown): { readonly ok: true; readonly doc: AgentDocument } | { readonly ok: false; readonly issues: Issue[] } {
  const parsed = agentDocumentSchema.safeParse(json, { error: (iss) => (iss.input === undefined ? "This field is required." : undefined) });
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), severity: "error", message: i.message })) };
  }
  const d = parsed.data;
  const audience: Audience = d.audience.t === "members" ? { t: "members", members: d.audience.members as MemberId[] } : d.audience;
  const doc: AgentDocument = { ...d, agentId: d.agentId as AgentId, owner: d.owner as MemberId, maintainers: d.maintainers as MemberId[], audience };
  return { ok: true, doc };
}

/**
 * The lab rules. Single source: Payload field validation,
 * publish, and MCP draft writes all call this. Pure.
 * - description has "Use when" and "Not for"
 * - model id parses as ExactModelId
 * - ceiling >= every KB class, skill class and tool reads class
 * - ceiling >= D3 implies model endpoint placement allows D3
 * - agent touching a D3 KB, or with a D3 sandbox mount ceiling, requires irbProtocol; KB consent scope needs a stated consentPurpose
 * - frozen-only rule (fallback refuse) is structural: ResolvedAgent has no other fallback
 */
export function validateAgentDraft(doc: AgentDocument, catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  const error = (field: string, message: string) => issues.push({ field, severity: "error", message });
  if (!/use when/i.test(doc.description)) error("description", 'must say when to use this agent ("Use when ...")');
  if (!/not for/i.test(doc.description)) error("description", 'must say what this agent is not for ("Not for ...")');
  const modelId = parseExactModelId(doc.model.modelId);
  if (typeof modelId !== "string") issues.push(modelId);
  const endpoint = catalog.endpoint(doc.model.endpointId);
  if (!endpoint) error("model.endpointId", `endpoint ${doc.model.endpointId} is not in lab.toml`);
  else {
    const modelCeiling = ceilingOf("model", endpoint.placement);
    if (modelCeiling === "none" || !atMost(doc.ceiling, modelCeiling)) {
      error("model.endpointId", `ceiling ${doc.ceiling} needs an endpoint that may receive it; ${doc.model.endpointId} is placement ${endpoint.placement} (up to ${modelCeiling})`);
    }
  }
  let touchesD3 = false;
  for (const kbId of doc.knowledgeBases) {
    const snap = catalog.latestSnapshot(kbId);
    if (!snap) {
      error("knowledgeBases", `knowledge base ${kbId} has no published snapshot`);
      continue;
    }
    if (!atMost(snap.cls, doc.ceiling)) error("knowledgeBases", `knowledge base ${kbId} is ${snap.cls}, above the agent ceiling ${doc.ceiling}`);
    if (rank(snap.cls) >= rank("D3")) touchesD3 = true;
    if (snap.consentScope && !doc.consentPurpose) error("consentPurpose", `knowledge base ${kbId} has a consent scope; state the purpose this agent serves`);
  }
  for (const skillId of doc.skills) {
    const skill = catalog.latestSkill(skillId);
    if (!skill) error("skills", `skill ${skillId} has no published version`);
    else if (!atMost(skill.cls, doc.ceiling)) error("skills", `skill ${skillId} is ${skill.cls}, above the agent ceiling ${doc.ceiling}`);
  }
  for (const t of doc.tools) {
    const tool = catalog.tool(t.name);
    if (!tool) error("tools", `tool ${t.name} is not deployed`);
    else if (!atMost(tool.reads, doc.ceiling)) error("tools", `tool ${t.name} reads ${tool.reads}, above the agent ceiling ${doc.ceiling}`);
  }
  if (endpoint?.agentCli) {
    if (endpoint.agentCli.cliVersion === null) error("model.endpointId", `no agent worker has reported the ${endpoint.agentCli.kind} version for ${doc.model.endpointId}; start one before publishing`);
    // A crashed session restarts from the top and repeats its calls, which only a read-only tool makes safe.
    for (const t of doc.tools) {
      const tool = catalog.tool(t.name);
      if (tool && tool.effects !== "read") error("tools", `tool ${t.name} has effects ${tool.effects}; an agent CLI may hold only read tools`);
    }
  }
  issues.push(...bandIssues(doc, catalog));
  // mountable() admits any dataset at most the frozen mount ceiling, so a D3 ceiling reaches D3 data even if no mount is D3 today.
  if (doc.sandbox.enabled && rank(doc.sandbox.mountCeiling) >= rank("D3") && atMost(doc.sandbox.mountCeiling, doc.ceiling)) touchesD3 = true;
  if (touchesD3 && !doc.irbProtocol) error("irbProtocol", "an agent that reads D3 data must name its IRB protocol");
  if (doc.sandbox.enabled && !catalog.sandboxImage()) error("sandbox", "no sandbox image is deployed");
  if (doc.sandbox.enabled) {
    if (!atMost(doc.sandbox.mountCeiling, doc.ceiling)) error("sandbox", `mount ceiling ${doc.sandbox.mountCeiling} is above the agent ceiling ${doc.ceiling}`);
    for (const id of doc.sandbox.mounts) {
      const d = catalog.dataset(id);
      if (!d) error("sandbox", `dataset ${id} is not in lab.toml`);
      else if (!atMost(d.cls, doc.sandbox.mountCeiling)) error("sandbox", `dataset ${id} is ${d.cls}, above the mount ceiling ${doc.sandbox.mountCeiling}`);
    }
  }
  if (doc.tools.some((t) => t.name === "run_code") && !doc.sandbox.enabled) error("tools", "run_code needs the code sandbox enabled");
  return issues;
}

/**
 * The modelsByClass rules: bands climb strictly by upTo and stay below the ceiling, so model always serves the
 * ceiling and is never dead config; each band's endpoint may receive its upTo; and an agent whose model is an
 * agent CLI has no bands, because the CLI session never reads them.
 */
function bandIssues(doc: AgentDocument, catalog: Catalog): Issue[] {
  const bands = doc.modelsByClass ?? [];
  const issues: Issue[] = [];
  const error = (message: string) => issues.push({ field: "modelsByClass", severity: "error", message });
  if (bands.length && catalog.endpoint(doc.model.endpointId)?.agentCli) {
    error(`${doc.model.endpointId} is an agent CLI, which runs every class itself; remove the bands or pick a model endpoint`);
    return issues;
  }
  bands.forEach((b, i) => {
    const n = `band ${i + 1}`;
    const prev = bands[i - 1];
    if (prev && rank(b.upTo) <= rank(prev.upTo)) error(`${n} is up to ${b.upTo}, which does not climb above band ${i} (${prev.upTo}); list bands from the least restricted class up`);
    if (rank(b.upTo) >= rank(doc.ceiling)) error(`${n} is up to ${b.upTo}, which reaches the ceiling ${doc.ceiling}; the model above answers every class past the last band, so a band stops below the ceiling`);
    const id = parseExactModelId(b.model.modelId);
    if (typeof id !== "string") error(`${n}: ${id.message}`);
    const endpoint = catalog.endpoint(b.model.endpointId);
    if (!endpoint) return error(`${n}: endpoint ${b.model.endpointId} is not in lab.toml`);
    if (endpoint.agentCli) return error(`${n}: ${b.model.endpointId} is an agent CLI; a band needs a model endpoint`);
    const ceiling = ceilingOf("model", endpoint.placement);
    if (ceiling === "none" || !atMost(b.upTo, ceiling)) error(`${n} is up to ${b.upTo}, but ${b.model.endpointId} is placement ${endpoint.placement} (up to ${ceiling})`);
  });
  return issues;
}

export type Resolution = { readonly ok: true; readonly agent: ResolvedAgent } | { readonly ok: false; readonly issues: Issue[] };

/** Pure. Pins every floating reference to the catalog's current version and applies limit defaults. */
export function resolveAgent(doc: AgentDocument, catalog: Catalog): Resolution {
  const issues = validateAgentDraft(doc, catalog);
  if (issues.some((i) => i.severity === "error")) return { ok: false, issues };
  const modelId = parseExactModelId(doc.model.modelId) as ExactModelId;
  const defaults = doc.kind === "background" ? BACKGROUND_LIMITS : INTERACTIVE_LIMITS;
  const image = doc.sandbox.enabled ? catalog.sandboxImage()! : null;
  const agent: ResolvedAgent = {
    schema: 2,
    agentId: doc.agentId,
    loopContract: LOOP_CONTRACT,
    instructions: doc.instructions,
    instructionsClass: doc.instructionsClass,
    model: { endpointId: doc.model.endpointId, modelId, params: doc.model.params },
    knowledgeBases: doc.knowledgeBases.map((kbId) => {
      const s = catalog.latestSnapshot(kbId)!;
      return { kbId, snapshot: s.id, cls: s.cls };
    }),
    tools: doc.tools.map((t) => ({ name: t.name, hash: catalog.tool(t.name)!.hash })),
    sandbox: doc.sandbox.enabled && image ? { imageDigest: image, mountCeiling: doc.sandbox.mountCeiling, mounts: doc.sandbox.mounts } : null,
    retrieval: { algorithm: RETRIEVAL_ALGORITHM, readCapTokens: doc.readCapTokens ?? DEFAULT_READ_CAP_TOKENS },
    limits: withDefaults(defaults, doc.limits ?? {}),
  };
  const cli = catalog.endpoint(doc.model.endpointId)?.agentCli;
  if (cli?.cliVersion) return { ok: true, agent: { ...agent, agentCli: { kind: cli.kind, cliVersion: cli.cliVersion } } };
  const bands = doc.modelsByClass ?? [];
  if (!bands.length) return { ok: true, agent };
  const modelsByClass = bands.map((b) => ({ upTo: b.upTo, target: { endpointId: b.model.endpointId, modelId: parseExactModelId(b.model.modelId) as ExactModelId, params: b.model.params } }));
  return { ok: true, agent: { ...agent, modelsByClass } };
}

function withDefaults(defaults: Limits, overrides: Partial<Limits>): Limits {
  return {
    maxSteps: overrides.maxSteps ?? defaults.maxSteps,
    maxTokens: overrides.maxTokens ?? defaults.maxTokens,
    maxWallMs: overrides.maxWallMs ?? defaults.maxWallMs,
  };
}

export function versionHash(agent: ResolvedAgent): AgentVersionHash {
  return contentHash(agent) as string as AgentVersionHash;
}

/** The instructions as content with the class the author gave them. The origin a prompt's system part comes from. */
export function instructionsOf(agent: ResolvedAgent): Labelled<string> {
  return Labelled.stamp(agent.instructions, agent.instructionsClass, `agent:${agent.agentId}:instructions`);
}

export function listingOf(doc: AgentDocument): AgentListing {
  return {
    agentId: doc.agentId,
    name: doc.name,
    description: doc.description,
    owner: doc.owner,
    audience: doc.audience,
    channels: doc.channels,
    autoRespond: doc.autoRespond,
    routable: doc.routable,
    sampleQuestions: doc.sampleQuestions,
    ceiling: doc.ceiling,
    provenancePolicy: doc.provenancePolicy,
    irbProtocol: doc.irbProtocol ?? null,
    status: "published",
  };
}

/**
 * Rejects floating aliases: "latest", ":latest", "auto" routes, and ids with no
 * version or date in them (no digit anywhere). A frozen study needs a name
 * that cannot move under it.
 */
export function parseExactModelId(s: string): ExactModelId | Issue {
  const bad = (message: string): Issue => ({ field: "model.modelId", severity: "error", message });
  const id = s.trim();
  if (id === "") return bad("model id is empty");
  if (/(^|[:/])latest$/i.test(id)) return bad(`"${id}" floats to the latest version; name an exact version`);
  if (/(^|[:/-])auto($|[:/-])/i.test(id)) return bad(`"${id}" is a provider auto route; name an exact model`);
  if (!/\d/.test(id)) return bad(`"${id}" names no version or date; name an exact version`);
  return id as ExactModelId;
}

/** What the current deployment cannot honor for this version. Empty means runnable. Checked at every run start. */
export type Unrunnable =
  | { readonly t: "tool-changed"; readonly tool: string; readonly pinned: ToolHash; readonly deployed: ToolHash | null }
  | { readonly t: "snapshot-missing"; readonly snapshot: SnapshotId }
  | { readonly t: "model-unavailable"; readonly modelId: ExactModelId }
  | { readonly t: "sandbox-image-missing"; readonly digest: Sha256 }
  | { readonly t: "loop-contract"; readonly pinned: string; readonly current: string }
  | { readonly t: "retrieval-missing"; readonly algorithm: string }
  | { readonly t: "agent-cli-version"; readonly backend: string; readonly pinned: string; readonly installed: string | null }
  | { readonly t: "agent-confinement-missing"; readonly platform: string };

/** What this deployment serves, for verifyRunnable. The worker builds it from the registry, the KB reader and this build's constants. */
export interface Deployed {
  readonly tools: ReadonlyMap<string, ToolHash>;
  readonly snapshots: ReadonlySet<SnapshotId>;
  readonly sandboxImages: ReadonlySet<Sha256>;
  readonly loopContract: string;
  readonly retrieval: ReadonlySet<string>;
  /** Agent backend id -> the installed CLI's --version. Absent in a process that runs no agent CLI. */
  readonly agentClis?: ReadonlyMap<string, string>;
  /** Endpoint id -> the exact model ids it served at run start, asked for a band agent's model and every band's target. Absent: not checked. */
  readonly served?: ReadonlyMap<string, ReadonlySet<string>>;
  /** This process can confine an agent CLI (macOS seatbelt). Running one unconfined is never a fallback. */
  readonly confinement?: { readonly available: boolean; readonly platform: string };
}

/** A version row that cannot be loaded as the agent it names. Terminal for the run. */
export class AgentUnavailable extends Error {
  readonly hash: AgentVersionHash;
  readonly why: "missing" | "hash-mismatch" | "schema";
  constructor(hash: AgentVersionHash, why: AgentUnavailable["why"]) {
    super(`agent version ${hash}: ${why === "missing" ? "not in agent_versions" : why === "hash-mismatch" ? "does not hash to its own id" : "unsupported schema"}`);
    this.name = "AgentUnavailable";
    this.hash = hash;
    this.why = why;
  }
}

/** Thrown at run start when verifyRunnable finds a problem. */
export class UnrunnableAgent extends Error {
  readonly problems: readonly Unrunnable[];
  constructor(problems: readonly Unrunnable[]) {
    super(`agent version is not runnable here: ${problems.map((p) => p.t).join(", ")}`);
    this.name = "UnrunnableAgent";
    this.problems = problems;
  }
}

export function verifyRunnable(agent: ResolvedAgent, deployed: Deployed): Unrunnable[] {
  const out: Unrunnable[] = [];
  for (const t of agent.tools) {
    const current = deployed.tools.get(t.name) ?? null;
    if (current !== t.hash) out.push({ t: "tool-changed", tool: t.name, pinned: t.hash, deployed: current });
  }
  for (const kb of agent.knowledgeBases) if (!deployed.snapshots.has(kb.snapshot)) out.push({ t: "snapshot-missing", snapshot: kb.snapshot });
  if (agent.sandbox && !deployed.sandboxImages.has(agent.sandbox.imageDigest)) out.push({ t: "sandbox-image-missing", digest: agent.sandbox.imageDigest });
  if (agent.loopContract !== deployed.loopContract) out.push({ t: "loop-contract", pinned: agent.loopContract, current: deployed.loopContract });
  if (!deployed.retrieval.has(agent.retrieval.algorithm)) out.push({ t: "retrieval-missing", algorithm: agent.retrieval.algorithm });
  if (deployed.served && agent.modelsByClass) {
    for (const t of [...agent.modelsByClass.map((b) => b.target), agent.model]) if (!deployed.served.get(t.endpointId)?.has(t.modelId)) out.push({ t: "model-unavailable", modelId: t.modelId });
  }
  if (agent.agentCli) {
    const installed = deployed.agentClis?.get(agent.model.endpointId) ?? null;
    if (installed !== agent.agentCli.cliVersion) out.push({ t: "agent-cli-version", backend: agent.model.endpointId, pinned: agent.agentCli.cliVersion, installed });
    if (!deployed.confinement?.available) out.push({ t: "agent-confinement-missing", platform: deployed.confinement?.platform ?? "unknown" });
  }
  return out;
}

/** Agent card: every ResolvedAgent field, the hash, eval results, the listing at freeze time, and the validity sentence. */
export interface AgentCard {
  readonly hash: AgentVersionHash;
  readonly agent: ResolvedAgent;
  readonly listingAtFreeze: AgentListing;
  readonly evals: readonly { readonly question: string; readonly passed: boolean; readonly runId: string }[];
  readonly markdown: string;
}

export function renderAgentCard(_hash: AgentVersionHash, _agent: ResolvedAgent, _listing: AgentListing, _evals: AgentCard["evals"]): AgentCard {
  throw new Error("agent cards arrive with studies");
}
