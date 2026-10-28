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

export type StudioCore = Pick<SharedCore, "config" | "db" | "store" | "queue" | "http" | "catalog" | "intake" | "close">;

export async function bootStudio(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<StudioCore> {
  const { config, db, store, queue, http, catalog, intake, close } = await bootShared(configPath, env);
  return { config, db, store, queue, http, catalog, intake, close };
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
