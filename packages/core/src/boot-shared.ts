/**
 * The wiring every sealed process shares: lab.toml and the environment read once,
 * Postgres, the payload store, the queue, the HTTP choke point, the catalog a
 * draft resolves against, and intake. It builds no model gateway and no tool
 * runner; the sealed binaries add those in boot.ts. It reads the payload keys,
 * so the studio never loads it (test/boundaries.test.ts).
 */

import { readFile } from "node:fs/promises";
import { LOOP_CONTRACT, parseAgentDocument, type AgentDocument, type Catalog, type Deployed, type MemberId } from "./agent.ts";
import type { SnapshotId } from "./hash.ts";
import { databaseUrlFromEnv, loadConfig, type LabConfig } from "./config.ts";
import { applySchema, connect, type Db } from "./db.ts";
import type { IntakeDeps } from "./frontdoor.ts";
import type { GateDeps } from "./gate.ts";
import { publishedSnapshots, RETRIEVAL_ALGORITHM, snapshotFromFixture, type KbSnapshot, type LoadedSnapshot } from "./kb.ts";
import { publishedAgentsFor } from "./publish.ts";
import { createQueue, type Queue } from "./queue.ts";
import type { PayloadStore } from "./record.ts";
import { openPayloadStore } from "./steward.ts";
import { builtinTools, createHttpEgress, registryOf, type HttpEgress, type RegisteredTool, type ToolRegistry } from "./tools.ts";

export interface SharedCore {
  readonly config: LabConfig;
  readonly db: Db;
  readonly store: PayloadStore;
  readonly queue: Queue;
  readonly http: HttpEgress;
  /** What a draft resolves against now: published KB heads are read on every call. */
  readonly catalog: () => Promise<Catalog>;
  readonly agents: readonly AgentDocument[];
  readonly intake: IntakeDeps;
  /** lab.toml's fixture KBs, which the catalog and the KB reader both serve. */
  readonly fixtureSnapshots: readonly LoadedSnapshot[];
  /** Tool manifests and hashes. The catalog resolves tools against it; only boot.ts builds a runner over it. */
  readonly registry: ToolRegistry;
  close(): Promise<void>;
}

export interface BootOptions {
  /** Tools that replace a built-in of the same name or add to the registry. Only the test harnesses plant tools here. */
  readonly tools?: readonly RegisteredTool[];
}

export async function bootShared(configPath: string, env: NodeJS.ProcessEnv = process.env, options: BootOptions = {}): Promise<SharedCore> {
  const config = await loadConfig(configPath);
  const db = connect(databaseUrlFromEnv(config, env));
  await applySchema(db);
  const { store } = await openPayloadStore(db, config, env);
  const fixtureSnapshots = await Promise.all(config.kbFixtures.map(async (f) => snapshotFromFixture(JSON.parse(await readFile(f, "utf8")), store.address)));
  const planted = new Set((options.tools ?? []).map((t) => t.manifest.name));
  const registry = registryOf([...builtinTools().filter((t) => !planted.has(t.manifest.name)), ...(options.tools ?? [])]);
  const endpoints = new Map(config.endpoints.map((e) => [e.id, e]));
  const backends = new Map(config.agentBackends.map((b) => [b.id, b]));
  const catalogOf = (published: readonly KbSnapshot[], cliSeen: ReadonlyMap<string, string>): Catalog => ({
    latestSkill: () => undefined,
    latestSnapshot: (kbId) => {
      const s = published.find((p) => p.kbId === kbId) ?? fixtureSnapshots.find((l) => l.snapshot.kbId === kbId)?.snapshot;
      return s ? { id: s.id, cls: s.cls, ...(s.consentScope ? { consentScope: s.consentScope } : {}), ...(s.irbProtocol ? { irbProtocol: s.irbProtocol } : {}) } : undefined;
    },
    tool: (name) => {
      const t = registry.get(name);
      return t ? { hash: t.hash, reads: t.manifest.reads, effects: t.manifest.effects } : undefined;
    },
    endpoint: (id) => {
      const e = endpoints.get(id);
      if (e) return { placement: e.placement };
      const b = backends.get(id);
      return b ? { placement: b.placement, agentCli: { kind: b.kind, cliVersion: cliSeen.get(b.id) ?? null } } : undefined;
    },
    sandboxImage: () => config.sandbox?.digest,
    dataset: (id) => {
      const d = config.datasets.find((x) => x.id === id);
      return d ? { cls: d.cls } : undefined;
    },
  });
  const cliSeen = async () =>
    new Map((await db.query<{ backend_id: string; kind: string; cli_version: string }>("select backend_id, kind, cli_version from agent_cli_seen")).rows.filter((r) => backends.get(r.backend_id)?.kind === r.kind).map((r) => [r.backend_id, r.cli_version]));
  const catalog = async () => catalogOf(await publishedSnapshots(db, store.address), config.agentBackends.length ? await cliSeen() : new Map());
  const agents = await Promise.all(
    config.agentFixtures.map(async (f) => {
      const parsed = parseAgentDocument(JSON.parse(await readFile(f, "utf8")));
      if (!parsed.ok) throw new Error(`${f}: ${parsed.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`);
      return parsed.doc;
    }),
  );
  // Membership: this build trusts the user id the web page sends. University sign-on replaces this.
  const gate: GateDeps = {
    members: async (platformUserId) => ({ id: platformUserId as MemberId, audiences: [{ t: "lab" }] }),
    channelFloor: async (c) => config.channelFloors[`${c.surface}:${c.channelId}`] ?? "D1",
    labPatterns: config.participantIdPatterns,
    policy: config.policy,
  };
  return {
    config,
    db,
    store,
    queue: createQueue(db),
    http: createHttpEgress({ policy: config.policy, hosts: config.hosts }),
    catalog,
    agents,
    intake: { db, store, queue: createQueue(db), gate, catalog, agentsFor: async (channel) => { const heads = await publishedAgentsFor(db, channel); return heads.length ? heads : agents; } },
    fixtureSnapshots,
    registry,
    close: () => db.end(),
  };
}

/** What this deployment serves for verifyRunnable outside a worker (a freeze): tools, every snapshot it holds, this build's loop and retrieval. */
export async function servedNow(core: Pick<SharedCore, "db" | "registry" | "fixtureSnapshots" | "config">): Promise<Deployed> {
  const stored = await core.db.query<{ id: SnapshotId }>("select id from kb_snapshots");
  return {
    tools: core.registry.deployed(),
    snapshots: new Set([...stored.rows.map((r) => r.id), ...core.fixtureSnapshots.map((s) => s.snapshot.id)]),
    sandboxImages: new Set(core.config.sandbox ? [core.config.sandbox.digest] : []),
    loopContract: LOOP_CONTRACT,
    retrieval: new Set([RETRIEVAL_ALGORITHM]),
  };
}

