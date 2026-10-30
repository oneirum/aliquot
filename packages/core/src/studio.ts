/**
 * The studio's one entry into core (`@labh/core/studio`).
 *
 * The studio is a Next app, and Next cannot run under the permission model
 * (it starts child processes and worker threads and loads native addons), so
 * nothing in its process is sealed. That process therefore builds no model
 * gateway and no tool runner (boot-shared.ts constructs neither): a test
 * message and a KB compile are queued here and run by a sealed worker. What the studio does call is the same publish,
 * intake, source-reading and KB publish code the web door and the kb command
 * run. scripts/boundaries.ts refuses any other import of core under
 * packages/studio.
 */

import { bootShared, type SharedCore } from "./boot-shared.ts";
import type { DataClass } from "./dataclass.ts";
import type { Effect, RegisteredTool } from "./tools.ts";

/** What the studio shows about a deployed tool: plain data from its manifest, never the manifest or its code. */
export interface ToolInfo {
  readonly name: string;
  /** The first sentence of the description the model reads. */
  readonly summary: string;
  readonly reads: DataClass;
  readonly effects: Effect;
  readonly egress: readonly string[];
}

export type StudioCore = Pick<SharedCore, "config" | "db" | "store" | "queue" | "http" | "catalog" | "intake" | "close"> & { readonly tools: readonly ToolInfo[] };

export async function bootStudio(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<StudioCore> {
  const { config, db, store, queue, http, catalog, intake, close, registry } = await bootShared(configPath, env);
  return { config, db, store, queue, http, catalog, intake, close, tools: toolInfos(registry.list()) };
}

export function toolInfos(tools: readonly RegisteredTool[]): ToolInfo[] {
  return tools.map(({ manifest: m }) => ({ name: m.name, summary: /^.*?\.(?=\s|$)/.exec(m.description)?.[0] ?? m.description, reads: m.reads, effects: m.effects, egress: [...m.egress] }));
}

export { agentDocumentSchema, parseAgentDocument } from "./agent.ts";
export type { AgentDocument, Issue, MemberId } from "./agent.ts";
export { confirmPublish, describePublishRefusal, PublishRefused, requestPublish } from "./publish.ts";
export { describeRoleRefusal, mayEdit, mayManageAccounts, mayPreview, roleRefusal, ROLES } from "./roles.ts";
export type { Actor, Role } from "./roles.ts";
export { isTestRunOf, readReplies, testDraft } from "./surfaces/web.ts";
export { loadEvents } from "./record.ts";
export type { RunId } from "./record.ts";
export type { Sha256, SnapshotId } from "./hash.ts";
export { loadManifest } from "./kb.ts";
export { attachedFiles, compileClass, compileResult, gapsOf, kbPublishClass, kbDefinitionSchema, loadOverrides, parseKbDefinition, publishSnapshot, readSources, renderCoverage, requestCompile } from "./kb-compile.ts";
