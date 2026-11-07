/**
 * lab.toml: where a lab says what is where. Parsed once at startup, at the
 * boundary; everything after this sees typed config. Secrets are named by
 * environment variable and read from the environment, never from the file.
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { coveredModelRefusal, DATA_CLASSES, describeRefusal, PLACEMENTS, rank, type DataClass, type EgressPolicy, type Placement, type SurfaceId } from "./dataclass.ts";
import { AUTH_HEADERS, type ModelEndpoint } from "./gateway.ts";
import { PROTOCOLS } from "./gateway-wire.ts";
import type { Sha256 } from "./hash.ts";
import { HOSTED_PLACEMENTS, type AgentBackend } from "./agents/backends.ts";
import { ROLES, type Role } from "./roles.ts";

const placement = z.enum(PLACEMENTS);
const KEY_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** scripts/backup.sh and restore.sh read these names out of .env, so they must be names, never patterns. */
const keyEnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "an env var name is capital letters, digits and _, not starting with a digit");
const retentionDays = z.object({ keep_min_days: z.number().int().min(0).optional(), purge_payload_after_days: z.number().int().positive().optional() }).strict();

const IMAGE_BY_DIGEST = /^(?:[a-z0-9][a-z0-9._\/:-]*@)?sha256:([0-9a-f]{64})$/;

/** A directory run_code may mount read-only at /data/<id>. */
export interface Dataset {
  readonly id: string;
  readonly path: string;
  readonly cls: DataClass;
  readonly description: string;
}

export interface SandboxConfig {
  /** The reference the daemon is asked for, always ending in the digest. */
  readonly image: string;
  readonly digest: Sha256;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly timeoutMs: number;
  readonly socket: string;
}

/**
 * dev_shared_login names an operator's own logged-in state directory, for a developer's smoke test on synthetic data.
 * claude reads only the keychain item named after it; codex gets a copy of its auth.json. A personal login is a public
 * placement, so it is refused anywhere else, and it runs only under agent-worker --dev-shared-login.
 */
const devLogin = z.object({ kind: z.enum(["claude-code", "codex"]), placement: z.literal("public"), binary: z.string().optional(), dev_shared_login: z.string().min(1) }).strict();
/**
 * api_key_env names a key the lab or institution owns. auth_env names a personal subscription's OAuth token
 * (claude setup-token), which the vendors' terms keep off a shared server: public placement and dev-login mode only.
 */
const agentBackend = z.union([
  z.object({ kind: z.enum(["claude-code", "codex"]), placement: z.enum(HOSTED_PLACEMENTS), binary: z.string().optional(), api_key_env: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("codex"), placement: z.enum(HOSTED_PLACEMENTS), binary: z.string().optional(), auth_file: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("claude-code"), placement: z.literal("public"), binary: z.string().optional(), auth_env: z.string().min(1) }).strict(),
  devLogin,
]);

export const SURFACE_KINDS = ["web", "slack", "teams", "phone", "acp", "mcp", "studio"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export interface WebSurfaceConfig {
  readonly id: SurfaceId;
  readonly kind: "web";
  readonly placement: Placement;
  readonly port: number;
  readonly baseUrl: string;
  /** The one channel this web surface serves, or null when the page names it. */
  readonly channel: string | null;
  /** The address the door listens on. Beyond loopback only with [auth], because without sign-on the door trusts the member id it is given. */
  readonly bind: string;
}

/**
 * [auth]: OpenID Connect sign-on for the web door. The member id is the provider's stable id for the person; the role
 * comes from a group claim when one is mapped, else from the studio account with the email the provider vouches for.
 * Secrets are named by env var.
 */
export interface SignOnConfig {
  readonly issuer: string;
  readonly clientId: string;
  /** Null for a public client, which PKCE alone protects. */
  readonly clientSecretEnv: string | null;
  /** Signs the session cookie. */
  readonly sessionSecretEnv: string;
  /** The ID token claim that holds the member's email: email for most providers, preferred_username for some Entra ID tenants. */
  readonly emailClaim: string;
  /**
   * Accept an email the provider does not say it verified (email_verified true) as the key to a studio account. Only for
   * a provider that never sends email_verified, and only when it vouches for every address it issues: otherwise anyone it
   * federates with could claim the PI's address. A role from roles_claim never needs it.
   */
  readonly trustUnverifiedEmail: boolean;
  /** The claim whose value is the member id every run records: sub by default, eppn on InCommon campuses. An email can change; this does not. */
  readonly idClaim: string;
  /** A session nobody has used for this long ends, and the next request signs in again (HIPAA automatic logoff). */
  readonly idleMinutes: number;
  /** A group or entitlement claim whose values name the role, or null to take every role from the studio account. */
  readonly rolesClaim: string | null;
  /** Claim value to role. When several values match, the highest role wins; when none does, the studio account decides. */
  readonly roleValues: Readonly<Record<string, Role>>;
  /** What /login asks the provider for. CILogon releases eppn only under org.cilogon.userinfo; Okta's groups claim may need groups. */
  readonly scopes: readonly string[];
}

/** Claims that look like an email but that nobody verified: Entra ID's preferred_username and upn. */
const UNVERIFIED_EMAIL_CLAIMS: readonly string[] = ["preferred_username", "upn", "unique_name"];

/** 127.0.0.0/8, ::1 and localhost: the addresses only this machine reaches. */
export function isLoopback(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  return a === "localhost" || a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Null when the door may be reached at this address; otherwise why not. The binary and lab.toml both ask. */
export function bindRefusal(address: string, signOn: boolean): string | null {
  return signOn || isLoopback(address) ? null : `${address} reaches beyond this machine, which needs [auth]: without sign-on the door trusts the member id it is given`;
}

/** A surface that names itself to the door with a bearer token, read from tokenEnv and never from lab.toml. */
export interface TokenSurfaceConfig {
  readonly id: SurfaceId;
  readonly kind: Exclude<SurfaceKind, "web">;
  readonly placement: Placement;
  readonly tokenEnv: string;
}

export type SurfaceConfig = WebSurfaceConfig | TokenSurfaceConfig;

/** The id is a segment of every run key, surface:channel:thread:message. */
const SURFACE_ID = /^[a-z][a-z0-9_-]*$/;
const webSurface = z
  .object({ kind: z.literal("web").optional(), placement: placement.default("lab"), port: z.number().int().default(3000), base_url: z.string().optional(), channel: z.string().regex(/^[^:]+$/).optional(), bind: z.string().min(1).default("127.0.0.1") })
  .strict();
const tokenSurface = z.object({ kind: z.enum(["slack", "teams", "phone", "acp", "mcp", "studio"]), placement, token_env: z.string().min(1) }).strict();

const REFUSED_PLACEMENTS: Partial<Record<SurfaceKind, { readonly placements: readonly Placement[]; readonly why: string }>> = {
  slack: { placements: ["lab", "institution"], why: "Slack's servers keep a copy of every answer, so a Slack surface is placement approved at most" },
  teams: { placements: ["lab"], why: "Microsoft keeps a copy of every Teams message in the institution's tenant, so a Teams surface is placement institution at most" },
};

function parseSurface(id: string, raw: unknown): SurfaceConfig {
  const fail = (why: string): never => {
    throw new Error(`lab.toml: [surfaces.${id}] ${why}`);
  };
  if (!SURFACE_ID.test(id)) fail("is not a surface id: lowercase letters, digits, _ and -, starting with a letter, because the id is part of every run key");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("must be a table");
  const kind = "kind" in raw ? raw.kind : id === "web" ? "web" : undefined;
  if (!SURFACE_KINDS.includes(kind as SurfaceKind)) fail(`needs kind = one of ${SURFACE_KINDS.join(", ")}`);
  if ((kind === "web") !== (id === "web")) fail("is not allowed: kind web is [surfaces.web] only, and [surfaces.web] is kind web, because there is one web door");
  if ((kind === "studio") !== (id === "studio")) fail("is not allowed: kind studio is [surfaces.studio] only, and [surfaces.studio] is kind studio, because there is one studio");
  // Read nowhere, so the lab would believe web is authenticated. It is not until sign-on.
  if (id === "web" && "token_env" in raw) fail("takes no token_env: the web door has no token until sign-on");
  const parsed = (id === "web" ? webSurface : tokenSurface).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return fail(issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message);
  }
  const e = parsed.data;
  if ("token_env" in e) {
    const refused = REFUSED_PLACEMENTS[e.kind];
    if (refused?.placements.includes(e.placement)) fail(`placement ${e.placement} is refused: ${refused.why}`);
    return { id: id as SurfaceId, kind: e.kind, placement: e.placement, tokenEnv: e.token_env };
  }
  return { id: id as SurfaceId, kind: "web", placement: e.placement, port: e.port, baseUrl: e.base_url ?? `http://localhost:${e.port}`, channel: e.channel ?? null, bind: e.bind };
}

/** Web first, then every other surface in file order. Without [surfaces.web], web is lab on port 3000, as before surfaces had ids. */
function parseSurfaces(tables: Record<string, unknown>): readonly [WebSurfaceConfig, ...TokenSurfaceConfig[]] {
  const all = Object.entries(tables).map(([id, raw]) => parseSurface(id, raw));
  const web = all.find((s): s is WebSurfaceConfig => s.kind === "web") ?? (parseSurface("web", {}) as WebSurfaceConfig);
  const others = all.filter((s): s is TokenSurfaceConfig => s.kind !== "web");
  const owner = new Map<string, SurfaceId>();
  for (const s of others) {
    const first = owner.get(s.tokenEnv);
    if (first) throw new Error(`lab.toml: [surfaces.${s.id}] names token_env ${s.tokenEnv}, which [surfaces.${first}] already names; one token is one surface`);
    owner.set(s.tokenEnv, s.id);
  }
  return [web, ...others];
}

const schema = z.object({
  database: z.object({ url_env: z.string().default("DATABASE_URL") }).default({ url_env: "DATABASE_URL" }),
  store: z
    .object({
      placement: placement.default("lab"),
      key_env: keyEnvName.optional(),
      keys: z.record(z.string().regex(KEY_ID, "a key id is lowercase letters, digits, _ and -, because every payload row names one"), keyEnvName).optional(),
      current: z.string().optional(),
      class_keys: z.partialRecord(z.enum(DATA_CLASSES), z.string()).default({}),
    })
    .strict()
    .default({ placement: "lab", class_keys: {} }),
  endpoints: z.record(
    z.string(),
    z.object({
      base_url: z.string().url(),
      placement,
      api_key_env: z.string().optional(),
      api_key_file: z.string().min(1).optional(),
      auth_header: z.enum(AUTH_HEADERS).optional(),
      models: z.array(z.string().min(1)).min(1).optional(),
      provider: z.object({ zdr: z.literal(true), data_collection: z.literal("deny"), allow_fallbacks: z.literal(false), only: z.array(z.string()) }).optional(),
      logprobs: z.boolean().default(false),
      protocol: z.enum(PROTOCOLS).default("openai-chat"),
      sampling: z.boolean().optional(),
    }),
  ),
  surfaces: z.record(z.string(), z.unknown()).default({}),
  hosts: z.record(z.string(), placement).default({}),
  policy: z
    .object({
      review_confidential: z.enum(["refuse", "lab-only"]).default("refuse"),
      participant_id_patterns: z.array(z.string()).default([]),
      retention: z.object({ ...retentionDays.shape, ...Object.fromEntries(DATA_CLASSES.map((cls) => [cls, retentionDays.optional()])) }).strict().optional(),
    })
    .default({ review_confidential: "refuse", participant_id_patterns: [] }),
  agents: z.object({ fixtures: z.array(z.string()).default([]) }).default({ fixtures: [] }),
  /**
   * "surface:channel" -> the class every message there starts at. Unlisted channels start at D1. Detectors only raise it.
   * A floor below D1 is allowed only for the channel [surfaces.web] channel binds, because anywhere else the sender names the channel.
   */
  channel_floors: z.record(z.string().regex(/^[a-z][a-z0-9_-]*:[^:]+$/), z.enum(DATA_CLASSES)).default({}),
  knowledge_bases: z.object({ fixtures: z.array(z.string()).default([]) }).default({ fixtures: [] }),
  agent_backends: z.record(z.string(), agentBackend).default({}),
  datasets: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "a dataset id is lowercase letters, digits, _ and -, because it names the mount /data/<id>"),
      z.object({ path: z.string().refine(isAbsolute, "must be an absolute path"), class: z.enum(DATA_CLASSES), description: z.string().min(1) }).strict(),
    )
    .default({}),
  sandbox: z
    .object({
      image: z.string().regex(IMAGE_BY_DIGEST, "must be pinned by digest (sha256:<64 hex> or name@sha256:<64 hex>), not a tag"),
      cpus: z.number().positive().default(1),
      memory_mb: z.number().int().min(64).default(1024),
      timeout_ms: z.number().int().positive().default(60_000),
      socket: z.string().refine(isAbsolute, "must be an absolute path").default("/var/run/docker.sock"),
    })
    .strict()
    .optional(),
  research: z.object({ contact_email_env: z.string().min(1).optional() }).strict().default({}),
  lab: z.object({ name: z.string().trim().min(1).optional() }).strict().default({}),
  anchor: z.object({ path: z.string().min(1), every_minutes: z.number().int().positive().default(15) }).strict().optional(),
  auth: z
    .object({
      issuer: z.string().url(),
      client_id: z.string().min(1),
      client_secret_env: z.string().min(1).optional(),
      session_secret_env: z.string().min(1).default("LABH_SESSION_SECRET"),
      email_claim: z.string().min(1).default("email"),
      trust_unverified_email: z.boolean().default(false),
      id_claim: z.string().min(1).default("sub"),
      idle_timeout_minutes: z.number().int().min(1).max(12 * 60).default(30),
      roles_claim: z.string().min(1).optional(),
      roles: z.record(z.string().min(1), z.enum(ROLES)).optional(),
      scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/, "a scope is one word")).refine((s) => s.includes("openid"), "scopes must include openid").default(["openid", "email", "profile"]),
    })
    .strict()
    .refine((a) => (a.roles_claim === undefined) === (a.roles === undefined), "roles_claim and [auth.roles] go together: the claim to read, and which of its values is which role")
    .refine(
      (a) => a.trust_unverified_email || !UNVERIFIED_EMAIL_CLAIMS.includes(a.email_claim),
      `email_claim names a claim nobody verified (preferred_username, upn, unique_name): a user or tenant admin can set it to any address, the PI's included. Use email, or set trust_unverified_email = true only for a provider that issues every address itself`,
    )
    .optional(),
});

export interface LabConfig {
  readonly path: string;
  readonly databaseUrlEnv: string;
  readonly store: StoreKeys & { readonly placement: Placement };
  readonly endpoints: readonly ModelEndpoint[];
  /** Agent CLIs. Their ids share one namespace with endpoints, because an agent names either as model.endpointId. */
  readonly agentBackends: readonly AgentBackend[];
  readonly web: WebSurfaceConfig;
  /** Every [surfaces.<id>], web first and the same object as web. */
  readonly surfaces: readonly SurfaceConfig[];
  readonly hosts: Readonly<Record<string, Placement>>;
  readonly policy: EgressPolicy;
  readonly participantIdPatterns: readonly RegExp[];
  /** Absolute paths. This build reads agents and knowledge bases from fixture files; the studio replaces the agent list. */
  readonly agentFixtures: readonly string[];
  readonly kbFixtures: readonly string[];
  readonly channelFloors: Readonly<Record<string, DataClass>>;
  readonly datasets: readonly Dataset[];
  readonly sandbox: SandboxConfig | null;
  /** The env var whose value literature tools send as the polite-pool contact. */
  readonly contactEmailEnv: string | null;
  /** [lab] name: what the web pages show as the lab's name, or null to show the machine's hostname. */
  readonly labName: string | null;
  /** [anchor]: the append-only log signed checkpoints of the hash chains go to (absolute), and how often the worker writes one. */
  readonly anchor: { readonly path: string; readonly everyMinutes: number } | null;
  readonly retention: Retention;
  /** [auth], or null: the door then trusts the member id it is given, and listens on loopback only. */
  readonly signOn: SignOnConfig | null;
}

/**
 * [policy.retention], resolved per class: a class's own table, else the lab-wide keys. purgeDays: a run's bodies are
 * redacted this many days after the last run that names them; a class without one is kept. keepMinDays: the floor the
 * lab's records rule sets (for example seven years after close-out). Events, chains and tombstones are never deleted,
 * so the record always meets it; no body is redacted younger than it, and a purge under it is refused at startup.
 */
export interface Retention {
  readonly purgeDays: Readonly<Partial<Record<DataClass, number>>>;
  readonly keepMinDays: Readonly<Partial<Record<DataClass, number>>>;
}

type RetentionTable = { keep_min_days?: number | undefined; purge_payload_after_days?: number | undefined };

function retentionOf(t: (RetentionTable & Partial<Record<DataClass, RetentionTable | undefined>>) | undefined): Retention {
  const purgeDays: Partial<Record<DataClass, number>> = {};
  const keepMinDays: Partial<Record<DataClass, number>> = {};
  for (const cls of DATA_CLASSES) {
    const purge = t?.[cls]?.purge_payload_after_days ?? t?.purge_payload_after_days;
    const keep = t?.[cls]?.keep_min_days ?? t?.keep_min_days;
    if (purge !== undefined && keep !== undefined && purge < keep)
      throw new Error(`lab.toml: [policy.retention] purges ${cls} bodies after ${purge} days, under its keep_min_days of ${keep}: the purge would delete what the floor keeps. Raise purge_payload_after_days, or set a lower keep_min_days in [policy.retention.${cls}] if the lab's rules allow it`);
    if (purge !== undefined) purgeDays[cls] = purge;
    if (keep !== undefined) keepMinDays[cls] = keep;
  }
  return { purgeDays, keepMinDays };
}

/**
 * Which env var holds each payload key id, which id new payloads go under, and the classes that name their own key.
 * The one-key form, key_env = "X", is { k1: "X" } with k1 current, which is how every store stamped its rows before.
 */
export interface StoreKeys {
  readonly keyEnvs: Readonly<Record<string, string>>;
  readonly current: string;
  readonly classKeys: Readonly<Partial<Record<DataClass, string>>>;
}

function storeKeys(s: { key_env?: string | undefined; keys?: Record<string, string> | undefined; current?: string | undefined; class_keys: Partial<Record<DataClass, string>> }): StoreKeys {
  const fail = (why: string): never => {
    throw new Error(`lab.toml: [store] ${why}`);
  };
  if (s.key_env !== undefined && s.keys !== undefined) fail('names both key_env and [store.keys]; key_env = "X" is the one-key form of [store.keys] k1 = "X"');
  const keyEnvs = s.keys ?? { k1: s.key_env ?? "LABH_PAYLOAD_KEY" };
  const ids = Object.keys(keyEnvs);
  if (!ids.length) fail("[store.keys] names no key");
  const current = s.current ?? (ids.length === 1 ? ids[0]! : fail(`current is missing: name which of ${ids.join(", ")} new payloads go under`));
  if (!(current in keyEnvs)) fail(`current = "${current}" is not a key in [store.keys]`);
  for (const [cls, id] of Object.entries(s.class_keys)) if (!(id in keyEnvs)) fail(`class_keys ${cls} = "${id}" is not a key in [store.keys]`);
  const owner = new Map<string, string>();
  for (const [id, env] of Object.entries(keyEnvs)) {
    const first = owner.get(env);
    if (first) fail(`keys ${first} and ${id} both read ${env}; one env var is one key`);
    owner.set(env, id);
  }
  return { keyEnvs, current, classKeys: s.class_keys };
}

/** What loadConfig throws, and every binary prints, for a lab.toml with a [tools] table. */
const TOOL_FOLDERS_REFUSED = "lab.toml has a [tools] table, but Aliquot does not load contributed tools yet. Remove [tools]: Aliquot runs only its built-in tools.";

export function parseConfig(text: string, path: string): LabConfig {
  const raw = parseToml(text);
  // The schema strips unknown tables, so a lab that expects its tools to load would otherwise start without them.
  if ("tools" in raw) throw new Error(TOOL_FOLDERS_REFUSED);
  for (const [id, b] of Object.entries((raw.agent_backends ?? {}) as Record<string, Record<string, unknown>>)) {
    if ("auth_env" in b && b.placement !== "public")
      throw new Error(`lab.toml: agent backend ${id}: auth_env is a personal subscription's OAuth token, which only a public placement under agent-worker --dev-shared-login may use; a lab's key goes in api_key_env`);
  }
  for (const [id, e] of Object.entries((raw.endpoints ?? {}) as Record<string, Record<string, unknown>>)) {
    const fail = (why: string): never => {
      throw new Error(`lab.toml: endpoint ${id} ${why}`);
    };
    if ("api_key_env" in e && "api_key_file" in e) fail("names both api_key_env and api_key_file; the key comes from one of them");
    if ("auth_header" in e && !AUTH_HEADERS.includes(e.auth_header as never)) fail(`auth_header must be one of ${AUTH_HEADERS.join(", ")}`);
    if (Array.isArray(e.models) && e.models.length === 0) fail("has models = [], so it serves nothing; list its exact ids or remove models to ask the provider");
    for (const m of Array.isArray(e.models) ? e.models : []) {
      const covered = typeof m === "string" && typeof e.placement === "string" ? coveredModelRefusal(m, e.placement as Placement) : null;
      if (covered) throw new Error(`lab.toml: endpoint ${id}: ${describeRefusal(covered)}; give it the placement that 30-day retention allows`);
    }
  }
  const c = schema.parse(raw);
  const dir = dirname(path);
  const clash = Object.keys(c.agent_backends).filter((id) => id in c.endpoints);
  if (clash.length) throw new Error(`lab.toml: ${clash.join(", ")} is both an endpoint and an agent backend; ids share one namespace`);
  const surfaces = parseSurfaces(c.surfaces);
  const refused = bindRefusal(surfaces[0].bind, c.auth !== undefined);
  if (refused) throw new Error(`lab.toml: [surfaces.web] bind: ${refused}`);
  const bound = surfaces[0].channel;
  const lowered = Object.entries(c.channel_floors).filter(([key, cls]) => rank(cls) < rank("D1") && key !== `web:${bound}`);
  if (lowered.length)
    throw new Error(`lab.toml: channel_floors ${lowered.map(([k]) => k).join(", ")} is below D1, which only the channel [surfaces.web] channel binds may be; the sender names any other channel`);
  return {
    path,
    databaseUrlEnv: c.database.url_env,
    store: { placement: c.store.placement, ...storeKeys(c.store) },
    endpoints: Object.entries(c.endpoints).map(([id, e]) => ({
      id,
      baseUrl: e.base_url,
      placement: e.placement,
      ...(e.api_key_env ? { apiKeyEnv: e.api_key_env } : {}),
      ...(e.api_key_file ? { apiKeyFile: resolve(dir, e.api_key_file) } : {}),
      ...(e.auth_header ? { authHeader: e.auth_header } : {}),
      ...(e.models ? { models: e.models } : {}),
      ...(e.provider ? { providerRouting: e.provider } : {}),
      supportsLogprobs: e.logprobs,
      protocol: e.protocol,
      ...(e.sampling !== undefined ? { sampling: e.sampling } : {}),
    })),
    agentBackends: Object.entries(c.agent_backends).map(([id, b]) => ({
      id,
      kind: b.kind,
      placement: b.placement,
      binary: b.binary === undefined ? null : b.binary.includes("/") ? resolve(dir, b.binary) : b.binary,
      auth:
        "dev_shared_login" in b ? { t: "dev-shared", dir: resolve(dir, b.dev_shared_login) }
        : "api_key_env" in b ? { t: "api-key-env", env: b.api_key_env }
        : "auth_env" in b ? { t: "oauth-env", env: b.auth_env }
        : { t: "file", path: resolve(dir, b.auth_file) },
    })),
    web: surfaces[0],
    surfaces,
    hosts: Object.fromEntries(Object.entries(c.hosts).map(([h, p]) => [h.toLowerCase(), p])),
    policy: { reviewConfidential: c.policy.review_confidential },
    participantIdPatterns: c.policy.participant_id_patterns.map((p) => new RegExp(p)),
    agentFixtures: c.agents.fixtures.map((f) => resolve(dir, f)),
    kbFixtures: c.knowledge_bases.fixtures.map((f) => resolve(dir, f)),
    channelFloors: c.channel_floors,
    datasets: Object.entries(c.datasets).map(([id, d]) => ({ id, path: resolve(d.path), cls: d.class, description: d.description })),
    sandbox: c.sandbox ? { image: c.sandbox.image, digest: IMAGE_BY_DIGEST.exec(c.sandbox.image)![1]! as Sha256, cpus: c.sandbox.cpus, memoryMb: c.sandbox.memory_mb, timeoutMs: c.sandbox.timeout_ms, socket: c.sandbox.socket } : null,
    contactEmailEnv: c.research.contact_email_env ?? null,
    labName: c.lab.name ?? null,
    anchor: c.anchor ? { path: resolve(dir, c.anchor.path), everyMinutes: c.anchor.every_minutes } : null,
    retention: retentionOf(c.policy.retention as Parameters<typeof retentionOf>[0]),
    signOn: c.auth
      ? {
          issuer: c.auth.issuer,
          clientId: c.auth.client_id,
          clientSecretEnv: c.auth.client_secret_env ?? null,
          sessionSecretEnv: c.auth.session_secret_env,
          emailClaim: c.auth.email_claim,
          trustUnverifiedEmail: c.auth.trust_unverified_email,
          idClaim: c.auth.id_claim,
          idleMinutes: c.auth.idle_timeout_minutes,
          rolesClaim: c.auth.roles_claim ?? null,
          roleValues: c.auth.roles ?? {},
          scopes: c.auth.scopes,
        }
      : null,
  };
}

export async function loadConfig(path: string): Promise<LabConfig> {
  const abs = resolve(path);
  return parseConfig(await readFile(abs, "utf8"), abs);
}

/** Null when lab.toml loads; otherwise the line a binary prints before it exits, in place of a stack trace. */
export async function configProblem(path: string): Promise<string | null> {
  try {
    await loadConfig(path);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The polite-pool contact, or null when lab.toml names no env var or the var is unset. */
export function contactFromEnv(config: LabConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  return (config.contactEmailEnv && env[config.contactEmailEnv]) || null;
}

export function databaseUrlFromEnv(config: LabConfig, env: NodeJS.ProcessEnv = process.env): string {
  const url = env[config.databaseUrlEnv];
  if (!url) throw new Error(`${config.databaseUrlEnv} is not set`);
  return url;
}
