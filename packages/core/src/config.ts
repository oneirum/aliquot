/**
 * lab.toml: where a lab says what is where. Parsed once at startup, at the
 * boundary; everything after this sees typed config. Secrets are named by
 * environment variable and read from the environment, never from the file.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { PLACEMENTS, type EgressPolicy, type Placement } from "./dataclass.ts";
import type { ModelEndpoint } from "./gateway.ts";

const placement = z.enum(PLACEMENTS);

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
    }),
  ),
  surfaces: z.object({ web: z.object({ placement: placement.default("lab"), port: z.number().int().default(3000), base_url: z.string().optional() }).default({ placement: "lab", port: 3000 }) }).default({ web: { placement: "lab", port: 3000 } }),
  hosts: z.record(z.string(), placement).default({}),
  policy: z.object({ review_confidential: z.enum(["refuse", "lab-only"]).default("refuse"), participant_id_patterns: z.array(z.string()).default([]) }).default({ review_confidential: "refuse", participant_id_patterns: [] }),
  agents: z.object({ fixtures: z.array(z.string()).default([]) }).default({ fixtures: [] }),
  knowledge_bases: z.object({ fixtures: z.array(z.string()).default([]) }).default({ fixtures: [] }),
});

export interface LabConfig {
  readonly path: string;
  readonly databaseUrlEnv: string;
  readonly store: { readonly placement: Placement; readonly keyEnv: string };
  readonly endpoints: readonly ModelEndpoint[];
  readonly web: { readonly placement: Placement; readonly port: number; readonly baseUrl: string };
  readonly hosts: Readonly<Record<string, Placement>>;
  readonly policy: EgressPolicy;
  readonly participantIdPatterns: readonly RegExp[];
  /** Absolute paths. This build reads agents and knowledge bases from fixture files; the studio replaces the agent list. */
  readonly agentFixtures: readonly string[];
  readonly kbFixtures: readonly string[];
}

export function parseConfig(text: string, path: string): LabConfig {
  const c = schema.parse(parseToml(text));
  const dir = dirname(path);
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
    })),
    web: { placement: c.surfaces.web.placement, port: c.surfaces.web.port, baseUrl: c.surfaces.web.base_url ?? `http://localhost:${c.surfaces.web.port}` },
    hosts: Object.fromEntries(Object.entries(c.hosts).map(([h, p]) => [h.toLowerCase(), p])),
    policy: { reviewConfidential: c.policy.review_confidential },
    participantIdPatterns: c.policy.participant_id_patterns.map((p) => new RegExp(p)),
    agentFixtures: c.agents.fixtures.map((f) => resolve(dir, f)),
    kbFixtures: c.knowledge_bases.fixtures.map((f) => resolve(dir, f)),
  };
}

export async function loadConfig(path: string): Promise<LabConfig> {
  const abs = resolve(path);
  return parseConfig(await readFile(abs, "utf8"), abs);
}

/** Reads the one secret the store needs. 64 hex characters, from the env var lab.toml names. */
export function payloadKeyFromEnv(config: LabConfig, env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const hex = env[config.store.keyEnv];
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${config.store.keyEnv} must hold 64 hex characters (32 bytes) for the payload store`);
  return Buffer.from(hex, "hex");
}

export function databaseUrlFromEnv(config: LabConfig, env: NodeJS.ProcessEnv = process.env): string {
  const url = env[config.databaseUrlEnv];
  if (!url) throw new Error(`${config.databaseUrlEnv} is not set`);
  return url;
}
