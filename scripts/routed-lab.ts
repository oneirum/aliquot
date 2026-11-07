/**
 * lab0's shared channel: the handbook agent and the methods agent published on one channel, so the router picks
 * between them. pnpm lab0 (check R) and pnpm walk:router both set it up here, so they test the same lab.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentDocument, type AgentDocument, type MemberId } from "../packages/core/src/agent.ts";
import { bootShared } from "../packages/core/src/boot-shared.ts";
import type { RunJobPayload } from "../packages/core/src/frontdoor.ts";
import { confirmPublish, draftHashOf } from "../packages/core/src/publish.ts";
import { post } from "./procs.ts";

/** The channel id the web page names with ?channel=shared, and its key in agents' channels lists. */
export const SHARED = "shared";

/** The two agents of fixtures/lab0/routed-agents.json on fixtures/agent.json's defaults, answering through `endpointId`. */
export function routedAgents(root: string, endpointId: string, channels: readonly string[]): AgentDocument[] {
  const base = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
  const routed = JSON.parse(readFileSync(join(root, "fixtures/lab0/routed-agents.json"), "utf8")) as Record<string, unknown>[];
  return routed.map((overrides) => {
    const parsed = parseAgentDocument({ ...base, ...overrides, channels, ceiling: "D1", model: { endpointId, modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 256 } } });
    if (!parsed.ok) throw new Error(`routed agent ${String(overrides.agentId)}: ${JSON.stringify(parsed.issues)}`);
    return parsed.doc;
  });
}

/** Publishes both as the PI, the way the studio's Publish button does, against the lab's live catalog. Both KBs must be published first. */
export async function publishRoutedAgents(root: string, cfg: string, env: Record<string, string>, endpointId: string, channels: readonly string[]): Promise<AgentDocument[]> {
  const core = await bootShared(cfg, env);
  try {
    const docs = routedAgents(root, endpointId, channels);
    for (const doc of docs) await confirmPublish({ db: core.db, catalog: core.catalog }, doc, draftHashOf(doc), { id: "pi" as MemberId, role: "pi" }, "Answers in the shared channel");
    return docs;
  } finally {
    await core.close();
  }
}

export interface Sent {
  readonly status: number;
  readonly json: { t: string; runId?: string; answeredBy?: { agentId: string; name: string; line: string }; route?: RunJobPayload["route"] | { t: "ask-user"; top3: string[]; probs: Record<string, number>; confidence: number; router: string }; choices?: { agentId: string; name: string; line: string }[]; userFacing?: string };
}

/** One message to the shared channel through the web door, as the chat page sends it. */
export async function askShared(base: string, thread: string, message: string, text: string, agent?: string): Promise<Sent> {
  const sent = await post(base, "/message", { channel: SHARED, thread, message, text, user: "member-1", ...(agent ? { agent } : {}) });
  return sent as unknown as Sent;
}
