/**
 * Agent drafts. Payload owns drafts and revisions only: versions on, Payload
 * drafts off, so every save is a revision with a diff and a restore. What is
 * live is agent_heads, owned by core and moved only by confirmPublish.
 *
 * Fields are generated from core's agentDocumentSchema (fields.ts). A save
 * needs a document that parses, so every revision can be tested and checked.
 * The lab rules (validateAgentDraft) block publish, not save: the publish
 * panel lists them and core refuses to publish past them. No lab rule is
 * written in this file.
 */

import { randomUUID } from "node:crypto";
import {
  agentDocumentSchema,
  confirmPublish,
  describePublishRefusal,
  isTestRunOf,
  loadEvents,
  mayPreview,
  parseAgentDocument,
  PublishRefused,
  readReplies,
  requestPublish,
  testDraft,
  type AgentDocument,
  type Issue,
  type RunId,
  type Sha256,
} from "@labh/core/studio";
import { addDataAndFileToRequest, type Access, type CollectionConfig, type PayloadRequest } from "payload";
import { actorOf, core, isEditor } from "../core.ts";
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

/** The saved document behind a request, as core's AgentDocument. Unsaved form edits are never published or tested. */
async function savedDraft(req: PayloadRequest): Promise<{ ok: true; doc: AgentDocument } | { ok: false; issues: Issue[] }> {
  const saved = await req.payload.findByID({ collection: "agents", id: String(req.routeParams?.id), depth: 0, overrideAccess: false, user: req.user });
  return parseAgentDocument(documentJson(form, saved));
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
        const c = await core();
        const check = await requestPublish({ db: c.db, catalog: c.catalog }, draft.doc, actor);
        return json({ check, refusal: check.refusal ? describePublishRefusal(check.refusal) : null });
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
        const c = await core();
        try {
          const result = await confirmPublish({ db: c.db, catalog: c.catalog }, draft.doc, String(body.draftHash ?? "") as Sha256, actor, String(body.changelog ?? ""));
          return json(result);
        } catch (err) {
          if (err instanceof PublishRefused) return json({ error: err.message, refusal: err.refusal }, err.refusal.t === "role" ? 403 : 409);
          throw err;
        }
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
        if (!mayPreview(actor.role, draft.doc.ceiling)) return json({ error: `Testing an agent at ${draft.doc.ceiling} needs the data steward or the PI.` }, 403);
        const c = await core();
        const thread = `studio-${String(req.routeParams?.id)}-${String(body.thread ?? "default").replace(/[^a-zA-Z0-9-]/g, "")}`;
        return json(await testDraft(draft.doc, { member: actor.id, thread, message: randomUUID(), text }, c.intake));
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
        const runId = String(req.routeParams?.runId) as RunId;
        if (!/^[0-9a-f-]{36}$/.test(runId)) return json({ error: "Not a run id." }, 400);
        const c = await core();
        if (!(await isTestRunOf(c.db, runId, actor.id))) return json({ error: "No test run of yours has that id." }, 404);
        const events = await loadEvents(c.db, runId);
        const started = events.find((e) => e.event.t === "run.started")?.event;
        const finished = events.find((e) => e.event.t === "run.finished")?.event;
        return json({
          agent: started?.t === "run.started" ? started.agent : null,
          outcome: finished?.t === "run.finished" ? finished.outcome : null,
          replies: await readReplies(c.db, runId),
        });
      },
    },
  ],
};
