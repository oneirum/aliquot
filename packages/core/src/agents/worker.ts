/**
 * The agent worker: the chat worker's loop, claiming only agent-cli runs and
 * running each through the session driver. At start it finds every agent
 * backend's CLI and records the version it found, which is what a draft that
 * names the backend resolves agentCli.cliVersion to.
 */

import { readdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type { Db } from "../db.ts";
import { boot } from "../boot.ts";
import { workOn, type WorkerOptions } from "../worker.ts";
import { confinementAvailable } from "./confine.ts";
import { agentSession, clearRun } from "./session.ts";
import { installedCli, type InstalledCli } from "./spawn.ts";

export interface AgentWorkerOptions extends Omit<WorkerOptions, "engine" | "agentSession" | "agentClis" | "confinement"> {
  /** Real path of the workspaces root, the only place this process may write. */
  readonly workspaces: string;
  readonly inboxPollMs?: number;
  /** agent-worker --dev-shared-login: dev_shared_login backends may run. */
  readonly devSharedLogin?: boolean;
}

export async function startAgentWorker(configPath: string, opts: AgentWorkerOptions): Promise<void> {
  const core = await boot(configPath, process.env, { tools: opts.tools ?? [] });
  try {
    const clis = new Map<string, InstalledCli>();
    if (opts.devSharedLogin) opts.log("DEVELOPMENT MODE: dev_shared_login backends run agent CLIs on the operator's own login and keychain. Synthetic data only.");
    for (const backend of core.config.agentBackends) {
      try {
        const cli = await installedCli(backend, process.env, opts.devSharedLogin ?? false);
        clis.set(backend.id, cli);
        await core.db.query(
          `insert into agent_cli_seen (backend_id, kind, cli_version, binary_path, binary_sha256) values ($1, $2, $3, $4, $5)
           on conflict (backend_id) do update set kind = $2, cli_version = $3, binary_path = $4, binary_sha256 = $5, seen_at = now()`,
          [backend.id, backend.kind, cli.cliVersion, cli.binary, cli.sha256],
        );
        opts.log(`agent backend ${backend.id}: ${backend.kind} ${cli.cliVersion} at ${cli.binary}`);
      } catch (err) {
        // Its versions are then unrunnable here (agent-cli-version); the worker still serves the other backends.
        opts.log(err instanceof Error ? err.message : String(err));
      }
    }
    const swept = await sweepWorkspaces(core.db, opts.workspaces);
    if (swept) opts.log(`swept ${swept} workspaces of runs no live worker holds`);
    await workOn(core, {
      ...opts,
      engine: "agent-cli",
      agentClis: new Map([...clis].map(([id, c]) => [id, c.cliVersion])),
      confinement: { available: confinementAvailable(), platform: platform() },
      agentSession: agentSession({ gateway: core.gateway, tools: core.tools, kb: core.kb, clis, workspaces: opts.workspaces, env: process.env, ...(opts.inboxPollMs ? { inboxPollMs: opts.inboxPollMs } : {}) }),
    });
  } finally {
    await core.close();
  }
}

/**
 * A worker that died, lost its lease or settled a run without entering it again left that run's workspace behind,
 * holding a login copy and maybe a live CLI. At boot, every run directory whose job no worker holds a live lease on
 * is cleared.
 */
async function sweepWorkspaces(db: Db, root: string): Promise<number> {
  let swept = 0;
  for (const runId of readdirSync(root)) {
    const held = await db.query("select 1 from jobs where id::text = $1 and status = 'leased' and lease_until >= now()", [runId]);
    if (held.rowCount) continue;
    await clearRun(join(root, runId));
    swept += 1;
  }
  return swept;
}
