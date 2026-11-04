/**
 * The studio's one entry into core (`@labh/core/studio`).
 *
 * The studio is a Next app, and Next cannot run under the permission model
 * (it starts child processes and worker threads and loads native addons), so
 * nothing in its process is sealed. That process therefore holds no payload
 * key, no handle on core's tables, no model gateway and no tool runner. Its
 * reads and writes of core go to the web door's /studio routes with
 * [surfaces.studio]'s token (studioCall in door-client.ts), and the door runs
 * the same publish, intake, source-reading and KB publish code the kb
 * command runs; a test message and a KB compile then run in a sealed worker.
 * scripts/boundaries.ts refuses any other import of core under
 * packages/studio, and test/boundaries.test.ts fails when anything this
 * entry loads reads the payload key.
 */

import { loadConfig } from "./config.ts";
import type { DataClass } from "./dataclass.ts";
import { DoorError, STUDIO_DOOR_URL_ENV, studioCall, type StudioOpName } from "./door-client.ts";
import type { Actor } from "./roles.ts";
import { builtinTools, type Effect, type RegisteredTool } from "./tools.ts";

/** What the studio shows about a deployed tool: plain data from its manifest, never the manifest or its code. */
export interface ToolInfo {
  readonly name: string;
  /** The first sentence of the description the model reads. */
  readonly summary: string;
  readonly reads: DataClass;
  readonly effects: Effect;
  readonly egress: readonly string[];
}

export interface StudioCore {
  /** One op on the web door as the signed-in actor: its status and JSON, which the studio's route answers with. */
  call(op: StudioOpName, actor: Actor, fields: Record<string, unknown>): Promise<{ readonly status: number; readonly json: unknown }>;
  readonly tools: readonly ToolInfo[];
}

/** Reads lab.toml for [surfaces.studio] and the door's address, and the token from the env var it names. Opens no connection. */
export async function bootStudio(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<StudioCore> {
  const config = await loadConfig(configPath);
  const surface = config.surfaces.find((s) => s.kind === "studio");
  if (!surface || !("tokenEnv" in surface))
    throw new Error(`${configPath} has no [surfaces.studio]. The studio reaches core through the web door with that surface's token: add [surfaces.studio] with kind = "studio", a placement and a token_env`);
  const token = env[surface.tokenEnv];
  if (!token) throw new Error(`${surface.tokenEnv} is not set: the studio sends it to the web door as [surfaces.studio]'s token`);
  const door = { url: env[STUDIO_DOOR_URL_ENV] || config.web.baseUrl, token };
  return {
    // An unreachable door is the studio's 503 with the client's sentence, not an internal error.
    call: (op, actor, fields) => studioCall(door, surface.tokenEnv, op, actor, fields).catch((err: unknown) => {
      if (err instanceof DoorError) return { status: 503, json: { error: err.message } };
      throw err;
    }),
    tools: toolInfos(builtinTools()),
  };
}

export function toolInfos(tools: readonly RegisteredTool[]): ToolInfo[] {
  return tools.map(({ manifest: m }) => ({ name: m.name, summary: /^.*?\.(?=\s|$)/.exec(m.description)?.[0] ?? m.description, reads: m.reads, effects: m.effects, egress: [...m.egress] }));
}

export { agentDocumentSchema, parseAgentDocument } from "./agent.ts";
export type { AgentDocument, Issue, MemberId } from "./agent.ts";
export { describePublishRefusal } from "./publish.ts";
export { mayEdit, mayManageAccounts, ROLES } from "./roles.ts";
export type { Actor, Role } from "./roles.ts";
export { kbDefinitionSchema, parseKbDefinition } from "./kb-compile.ts";
