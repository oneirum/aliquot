/**
 * Public surface of @labh/core. Everything not exported here is unreachable
 * from the studio (package.json "exports" lists "." and "./studio").
 *
 * Callers:
 *   front-door adapters  -> intake
 *   studio               -> @labh/core/studio (studio.ts), which holds no gateway and no tool runner
 *   CLI / web            -> replay, studies
 *   worker binary        -> startWorker
 */

export { intake, postReply } from "./frontdoor.ts";
export type { InboundMessage } from "./gate.ts";
export type { Surface, IntakeResult } from "./frontdoor.ts";

export { agentDocumentSchema, validateAgentDraft, parseExactModelId, parseAgentDocument, resolveAgent, versionHash } from "./agent.ts";
export type { AgentDocument, AgentListing, AgentCard, Catalog, Issue, MemberId } from "./agent.ts";

export { requestPublish, confirmPublish, unpublish, PublishRefused, describePublishRefusal } from "./publish.ts";
export type { PublishCheck, Published } from "./publish.ts";
export { ROLES, mayPublish } from "./roles.ts";
export type { Actor, Role } from "./roles.ts";
export * as studies from "./study.ts";
export * as replay from "./replay.ts";

export { boot } from "./boot.ts";
export type { Core } from "./boot.ts";
export { startWorker } from "./worker.ts";
export { fold, verifyChain, loadEvents } from "./record.ts";
export type { RunEvent, StoredEvent, RunState, RunId } from "./record.ts";

export type { DataClass, Placement } from "./dataclass.ts";
export type { AgentVersionHash, Sha256, SnapshotId } from "./hash.ts";
