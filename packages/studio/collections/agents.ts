/**
 * Agent drafts. Payload owns drafts and revisions only: versions on, Payload
 * drafts off, so every save is a revision with a diff and a restore. What is
 * live is agent_heads, owned by core and moved only by confirmPublish, which
 * the web door runs for the studio (its /studio routes).
 *
 * Fields are generated from core's agentDocumentSchema (fields.ts). A save
 * needs a document that parses, so every revision can be tested and checked.
 * The lab rules (validateAgentDraft) block publish, not save: the publish
 * panel lists them and core refuses to publish past them. No lab rule is
 * written in this file.
 */

import { agentDocumentSchema, describePublishRefusal, parseAgentDocument, type AgentDocument, type Issue } from "@labh/core/studio";
import { addDataAndFileToRequest, type Access, type CollectionConfig, type PayloadRequest } from "payload";
import { actorOf, core, isEditor, relay } from "../core.ts";
import { documentJson, formOf, issueOwner, payloadFields, validatedPaths } from "../fields.ts";

const form = formOf(agentDocumentSchema);
const paths = validatedPaths(form);

function shapeIssues(data: unknown): readonly Issue[] {
  const parsed = parseAgentDocument(documentJson(form, data));
  return parsed.ok ? [] : parsed.issues;
}

const sentence = (m: string) => `${m[0]!.toUpperCase()}${m.slice(1)}${m.endsWith(".") ? "" : "."}`;

const fields = payloadFields(form, {
  presentation: { agentId: { unique: true }, description: { textarea: true }, instructions: { textarea: true } },
  validate: (path) => (_value, { data }) => {
    const mine = shapeIssues(data).filter((i) => i.severity === "error" && issueOwner(paths, i.field) === path);
    return mine.length ? mine.map((i) => sentence(i.message)).join(" ") : true;
  },
});

const signedIn: Access = ({ req }) => Boolean(req.user);
const editor: Access = ({ req }) => isEditor(req.user);

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * The saved document behind a request, parsed, and as the JSON the door parses again. Unsaved form edits are never
 * published or tested.
 */
async function savedDraft(req: PayloadRequest): Promise<{ ok: true; doc: AgentDocument; json: unknown } | { ok: false; issues: Issue[] }> {
  const saved = await req.payload.findByID({ collection: "agents", id: String(req.routeParams?.id), depth: 0, overrideAccess: false, user: req.user });
  const json = documentJson(form, saved);
  const parsed = parseAgentDocument(json);
  return parsed.ok ? { ...parsed, json } : parsed;
}

export const Agents: CollectionConfig = {
  slug: "agents",
  labels: { singular: "Agent", plural: "Agents" },
  versions: { drafts: false, maxPerDoc: 100 },
  // Payload's edit lock also blocks members who only read and test. Concurrent saves are safe without it:
  // each is a revision, and publish refuses a draft that changed after its checks ran.
  lockDocuments: false,
  access: { read: signedIn, create: editor, update: editor, delete: () => false },
  admin: {
    useAsTitle: "name",
    defaultColumns: ["name", "agentId", "updatedAt"],
    description: "Agents are documents. Save to keep a revision, test it in the thread beside the form, then run the checks and publish with a note.",
  },
  fields: [
    ...fields,
    { name: "publishPanel", type: "ui", admin: { position: "sidebar", components: { Field: "/components/PublishPanel.tsx#PublishPanel" } } },
    { name: "testThread", type: "ui", admin: { position: "sidebar", components: { Field: "/components/TestThread.tsx#TestThread" } } },
    { name: "toolsPanel", type: "ui", admin: { position: "sidebar", components: { Field: "/components/ToolsPanel.tsx#ToolsPanel" } } },
  ],
  endpoints: [
    {
      path: "/:id/check",
      method: "post",
      handler: async (req) => {
        const actor = actorOf(req.user);
        if (!actor) return json({ error: "Sign in first." }, 401);
        const draft = await savedDraft(req);
        if (!draft.ok) return json({ check: null, issues: draft.issues });
        return relay(await (await core()).call("agent-check", actor, { draft: draft.json }));
      },
    },
    {
      path: "/:id/publish",
      method: "post",
      handler: async (req) => {
        const actor = actorOf(req.user);
        if (!actor) return json({ error: "Sign in first." }, 401);
        await addDataAndFileToRequest(req);
        const body = (req.data ?? {}) as { draftHash?: unknown; changelog?: unknown };
        const draft = await savedDraft(req);
        if (!draft.ok) return json({ error: describePublishRefusal({ t: "invalid", issues: draft.issues }) }, 409);
        return relay(await (await core()).call("agent-publish", actor, { draft: draft.json, draftHash: String(body.draftHash ?? ""), changelog: String(body.changelog ?? "") }));
      },
    },
    {
      path: "/:id/test",
      method: "post",
      handler: async (req) => {
        const actor = actorOf(req.user);
        if (!actor) return json({ error: "Sign in first." }, 401);
        await addDataAndFileToRequest(req);
        const body = (req.data ?? {}) as { text?: unknown; thread?: unknown };
        const text = String(body.text ?? "").trim();
        if (!text) return json({ error: "Write a message to test with." }, 400);
        const draft = await savedDraft(req);
        if (!draft.ok) return json({ error: describePublishRefusal({ t: "invalid", issues: draft.issues }) }, 409);
        const thread = `studio-${String(req.routeParams?.id)}-${String(body.thread ?? "default").replace(/[^a-zA-Z0-9-]/g, "")}`;
        return relay(await (await core()).call("agent-test", actor, { draft: draft.json, thread, text }));
      },
    },
    {
      path: "/catalog/tools",
      method: "get",
      handler: async (req) => {
        if (!actorOf(req.user)) return json({ error: "Sign in first." }, 401);
        return json({ tools: (await core()).tools });
      },
    },
    {
      path: "/test-runs/:runId",
      method: "get",
      handler: async (req) => {
        const actor = actorOf(req.user);
        if (!actor) return json({ error: "Sign in first." }, 401);
        return relay(await (await core()).call("test-run", actor, { runId: String(req.routeParams?.runId) }));
      },
    },
  ],
};
