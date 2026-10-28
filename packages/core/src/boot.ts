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
import { SurfaceUnknown, type Surface } from "./frontdoor.ts";
import { createWebSurface } from "./surfaces/web.ts";

export type { BootOptions } from "./boot-shared.ts";

export interface Core extends SharedCore {
  readonly gateway: ModelGateway;
  readonly kb: KbReader;
  readonly tools: ToolRunner;
  readonly surfaces: (id: string) => Surface;
}

export async function boot(configPath: string, env: NodeJS.ProcessEnv = process.env, options: BootOptions = {}): Promise<Core> {
  const shared = await bootShared(configPath, env, options);
  const kb = createKbReader(firstOf(memorySnapshots(shared.fixtureSnapshots), storedSnapshots(shared.db, shared.store)));
  const web = createWebSurface(shared.db, shared.config);
  return {
    ...shared,
    gateway: createGateway(shared.config.endpoints, shared.config.policy),
    kb,
    tools: createToolRunner(shared.registry, { http: shared.http, kb }),
    surfaces: (id) => {
      if (id === web.id) return web;
      throw new SurfaceUnknown(id);
    },
  };
}
