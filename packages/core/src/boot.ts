/**
 * Wiring for the sealed binaries. Everything every process shares comes from
 * boot-shared.ts; this adds what only a sealed process may hold: the model
 * gateway, the KB reader, the tool runner and the surfaces. The only module
 * that knows how the pieces fit; each piece knows only its own interfaces.
 */

import { bootShared, type BootOptions, type SharedCore } from "./boot-shared.ts";
import { createGateway, type ModelGateway } from "./gateway.ts";
import { createKbReader, firstOf, memorySnapshots, storedSnapshots, type KbReader } from "./kb.ts";
import { createToolRunner, type ToolRunner } from "./tools.ts";
import { contactFromEnv } from "./config.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import { SurfaceUnknown, type Surface } from "./frontdoor.ts";
import { createWebSurface } from "./surfaces/web.ts";

export type { BootOptions } from "./boot-shared.ts";

export interface Core extends SharedCore {
  readonly gateway: ModelGateway;
  readonly kb: KbReader;
  readonly tools: ToolRunner;
  readonly sandbox: Sandbox | null;
  readonly surfaces: (id: string) => Surface;
}

export async function boot(configPath: string, env: NodeJS.ProcessEnv = process.env, options: BootOptions = {}): Promise<Core> {
  const shared = await bootShared(configPath, env, options);
  const kb = createKbReader(firstOf(memorySnapshots(shared.fixtureSnapshots), storedSnapshots(shared.db, shared.store)));
  const web = createWebSurface(shared.db, shared.config);
  const sandbox = shared.config.sandbox ? createSandbox(shared.config.sandbox) : null;
  return {
    ...shared,
    gateway: createGateway(shared.config.endpoints, shared.config.policy, undefined, shared.config.agentBackends),
    kb,
    tools: createToolRunner(shared.registry, { http: shared.http, kb, contact: contactFromEnv(shared.config, env), datasets: shared.config.datasets, sandbox }),
    sandbox,
    surfaces: (id) => {
      if (id === web.id) return web;
      throw new SurfaceUnknown(id);
    },
  };
}
