/**
 * Wiring for the sealed binaries. Everything every process shares comes from
 * boot-shared.ts; this adds what only a sealed process may hold: the model
 * gateway, the KB reader, the tool runner and the surfaces. The only module
 * that knows how the pieces fit; each piece knows only its own interfaces.
 */

import { bootShared, type BootOptions, type SharedCore } from "./boot-shared.ts";
import { createGateway, type ModelGateway } from "./gateway.ts";
import { directoryFromConfig, type MemberDirectory } from "./members.ts";
import { createKbReader, firstOf, memorySnapshots, storedSnapshots, type KbReader } from "./kb.ts";
import { createToolRunner, type ToolRunner } from "./tools.ts";
import { contactFromEnv } from "./config.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import { SurfaceUnknown, type Surface } from "./frontdoor.ts";
import { createWebSurface, DOOR_KINDS } from "./surfaces/web.ts";

export type { BootOptions } from "./boot-shared.ts";

export interface Core extends SharedCore {
  readonly gateway: ModelGateway;
  readonly kb: KbReader;
  readonly tools: ToolRunner;
  readonly sandbox: Sandbox | null;
  readonly surfaces: (id: string) => Surface;
  /** Groups by member, for entry scopes. The stand-in from [directory] until the identity unit's directory replaces it. */
  readonly directory: MemberDirectory;
}

export async function boot(configPath: string, env: NodeJS.ProcessEnv = process.env, options: BootOptions = {}): Promise<Core> {
  const shared = await bootShared(configPath, env, options);
  const kb = createKbReader(firstOf(memorySnapshots(shared.fixtureSnapshots), storedSnapshots(shared.db, shared.store)));
  // Every surface the door serves posts through web_messages; Slack waits for its own adapter.
  const served = new Map<string, Surface>(shared.config.surfaces.filter((s) => s.kind === "web" || DOOR_KINDS.includes(s.kind)).map((s) => [s.id, createWebSurface(shared.db, shared.config, s)]));
  const sandbox = shared.config.sandbox ? createSandbox(shared.config.sandbox) : null;
  return {
    ...shared,
    gateway: createGateway(shared.config.endpoints, shared.config.policy, undefined, shared.config.agentBackends),
    kb,
    tools: createToolRunner(shared.registry, { http: shared.http, kb, contact: contactFromEnv(shared.config, env), datasets: shared.config.datasets, duas: shared.config.duas, sandbox }),
    sandbox,
    directory: directoryFromConfig(shared.config.directory),
    surfaces: (id) => {
      const surface = served.get(id);
      if (surface) return surface;
      throw new SurfaceUnknown(id);
    },
  };
}
