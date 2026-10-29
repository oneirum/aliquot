/**
 * lab.toml: where a lab says what is where. Parsed once at startup, at the
 * boundary; everything after this sees typed config. Secrets are named by
 * environment variable and read from the environment, never from the file.
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { DATA_CLASSES, PLACEMENTS, rank, type DataClass, type EgressPolicy, type Placement } from "./dataclass.ts";
import type { ModelEndpoint } from "./gateway.ts";
import { PROTOCOLS } from "./gateway-wire.ts";
import type { Sha256 } from "./hash.ts";
import { HOSTED_PLACEMENTS, type AgentBackend } from "./agents/backends.ts";

const placement = z.enum(PLACEMENTS);

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
const agentBackend = z.union([
  z.object({ kind: z.literal("claude-code"), placement: z.enum(HOSTED_PLACEMENTS), binary: z.string().optional(), auth_env: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("codex"), placement: z.enum(HOSTED_PLACEMENTS), binary: z.string().optional(), auth_file: z.string().min(1) }).strict(),
  devLogin,
]);

const schema = z.object({
  database: z.object({ url_env: z.string().default("DATABASE_URL") }).default({ url_env: "DATABASE_URL" }),
  store: z.object({ placement: placement.default("lab"), key_env: z.string().default("LABH_PAYLOAD_KEY") }).default({ placement: "lab", key_env: "LABH_PAYLOAD_KEY" }),
  endpoints: z.record(
    z.string(),
    z.object({
      base_url: z.string().url(),
      placement,
      api_key_env: z.string().optional(),
      provider: z.object({ zdr: z.literal(true), data_collection: z.literal("deny"), allow_fallbacks: z.literal(false), only: z.array(z.string()) }).optional(),
      logprobs: z.boolean().default(false),
      protocol: z.enum(PROTOCOLS).default("openai-chat"),
      sampling: z.boolean().optional(),
    }),
  ),
  surfaces: z
    .object({
      web: z
        .object({ placement: placement.default("lab"), port: z.number().int().default(3000), base_url: z.string().optional(), channel: z.string().regex(/^[^:]+$/).optional() })
        .default({ placement: "lab", port: 3000 }),
    })
    .default({ web: { placement: "lab", port: 3000 } }),
  hosts: z.record(z.string(), placement).default({}),
  policy: z.object({ review_confidential: z.enum(["refuse", "lab-only"]).default("refuse"), participant_id_patterns: z.array(z.string()).default([]) }).default({ review_confidential: "refuse", participant_id_patterns: [] }),
  agents: z.object({ fixtures: z.array(z.string()).default([]) }).default({ fixtures: [] }),
  /**
   * "surface:channel" -> the class every message there starts at. Unlisted channels start at D1. Detectors only raise it.
   * A floor below D1 is allowed only for the channel [surfaces.web] channel binds, because anywhere else the sender names the channel.
   */
  channel_floors: z.record(z.string().regex(/^[a-z]+:[^:]+$/), z.enum(DATA_CLASSES)).default({}),
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
});

export interface LabConfig {
  readonly path: string;
  readonly databaseUrlEnv: string;
  readonly store: { readonly placement: Placement; readonly keyEnv: string };
  readonly endpoints: readonly ModelEndpoint[];
  /** Agent CLIs. Their ids share one namespace with endpoints, because an agent names either as model.endpointId. */
  readonly agentBackends: readonly AgentBackend[];
  /** channel: the one channel this web surface serves, or null when the page names it. */
  readonly web: { readonly placement: Placement; readonly port: number; readonly baseUrl: string; readonly channel: string | null };
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
}

/** What loadConfig throws, and every binary prints, for a lab.toml with a [tools] table. */
const TOOL_FOLDERS_REFUSED = "lab.toml has a [tools] table, but contributed tool folders are not supported in v0.2. They are planned for v0.3. Remove [tools]: v0.2 runs only its built-in tools.";

export function parseConfig(text: string, path: string): LabConfig {
  const raw = parseToml(text);
  // The schema strips unknown tables, so a lab that expects its tools to load would otherwise start without them.
  if ("tools" in raw) throw new Error(TOOL_FOLDERS_REFUSED);
  const c = schema.parse(raw);
  const dir = dirname(path);
  const clash = Object.keys(c.agent_backends).filter((id) => id in c.endpoints);
  if (clash.length) throw new Error(`lab.toml: ${clash.join(", ")} is both an endpoint and an agent backend; ids share one namespace`);
  const bound = c.surfaces.web.channel ?? null;
  const lowered = Object.entries(c.channel_floors).filter(([key, cls]) => rank(cls) < rank("D1") && key !== `web:${bound}`);
  if (lowered.length)
    throw new Error(`lab.toml: channel_floors ${lowered.map(([k]) => k).join(", ")} is below D1, which only the channel [surfaces.web] channel binds may be; the sender names any other channel`);
  return {
    path,
    databaseUrlEnv: c.database.url_env,
    store: { placement: c.store.placement, keyEnv: c.store.key_env },
    endpoints: Object.entries(c.endpoints).map(([id, e]) => ({
      id,
      baseUrl: e.base_url,
      placement: e.placement,
      ...(e.api_key_env ? { apiKeyEnv: e.api_key_env } : {}),
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
      auth: "dev_shared_login" in b ? { t: "dev-shared", dir: resolve(dir, b.dev_shared_login) } : "auth_env" in b ? { t: "env", env: b.auth_env } : { t: "file", path: resolve(dir, b.auth_file) },
    })),
    web: { placement: c.surfaces.web.placement, port: c.surfaces.web.port, baseUrl: c.surfaces.web.base_url ?? `http://localhost:${c.surfaces.web.port}`, channel: bound },
    hosts: Object.fromEntries(Object.entries(c.hosts).map(([h, p]) => [h.toLowerCase(), p])),
    policy: { reviewConfidential: c.policy.review_confidential },
    participantIdPatterns: c.policy.participant_id_patterns.map((p) => new RegExp(p)),
    agentFixtures: c.agents.fixtures.map((f) => resolve(dir, f)),
    kbFixtures: c.knowledge_bases.fixtures.map((f) => resolve(dir, f)),
    channelFloors: c.channel_floors,
    datasets: Object.entries(c.datasets).map(([id, d]) => ({ id, path: resolve(d.path), cls: d.class, description: d.description })),
    sandbox: c.sandbox ? { image: c.sandbox.image, digest: IMAGE_BY_DIGEST.exec(c.sandbox.image)![1]! as Sha256, cpus: c.sandbox.cpus, memoryMb: c.sandbox.memory_mb, timeoutMs: c.sandbox.timeout_ms, socket: c.sandbox.socket } : null,
    contactEmailEnv: c.research.contact_email_env ?? null,
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

/** Reads the one secret the store needs. 64 hex characters, from the env var lab.toml names. */
export function payloadKeyFromEnv(config: LabConfig, env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const hex = env[config.store.keyEnv];
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${config.store.keyEnv} must hold 64 hex characters (32 bytes) for the payload store`);
  return Buffer.from(hex, "hex");
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
