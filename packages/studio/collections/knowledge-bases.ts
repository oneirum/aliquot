/**
 * KB definitions. Like agents, Payload keeps the drafts and their revisions;
 * core owns snapshots and kb_heads. The form is generated from core's
 * kbDefinitionSchema, the same schema the kb command parses files with, and
 * the endpoints call the same core functions the kb command calls:
 * parseKbDefinition, readSources, requestCompile, compileResult,
 * renderCoverage and publishSnapshot. A sealed worker runs the compile.
 *
 * Source documents are attached at compile time and never stored in Payload's
 * tables, which are not encrypted. readSources reads them from the request in
 * memory and classifies them, and the text goes into the encrypted payload
 * store with the job. The studio never reads or writes a file for a source.
 */

import {
  attachedFiles,
  compileClass,
  compileResult,
  describeRoleRefusal,
  kbDefinitionSchema,
  loadManifest,
  kbPublishClass,
  loadOverrides,
  mayEdit,
  mayPreview,
  parseKbDefinition,
  publishSnapshot,
  readSources,
  renderCoverage,
  requestCompile,
  roleRefusal,
  type SnapshotId,
} from "@labh/core/studio";
import { addDataAndFileToRequest, type Access, type CollectionConfig, type PayloadRequest } from "payload";
import { actorOf, core, isEditor } from "../core.ts";
import { documentJson, formOf, issueOwner, payloadFields, validatedPaths } from "../fields.ts";

const form = formOf(kbDefinitionSchema);
const paths = validatedPaths(form);

const sentence = (m: string) => `${m[0]!.toUpperCase()}${m.slice(1)}${m.endsWith(".") ? "" : "."}`;

const fields = payloadFields(form, {
  presentation: { kbId: { unique: true }, purpose: { textarea: true } },
  validate: (path) => (_value, { data }) => {
    const parsed = kbDefinitionSchema.safeParse(documentJson(form, data));
    const mine = parsed.success ? [] : parsed.error.issues.filter((i) => issueOwner(paths, i.path.join(".")) === path);
    return mine.length ? mine.map((i) => sentence(i.message)).join(" ") : true;
  },
});

const signedIn: Access = ({ req }) => Boolean(req.user);
const editor: Access = ({ req }) => isEditor(req.user);

const json = (body: unknown, status = 200) => Response.json(body, { status });
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function savedDefinition(req: PayloadRequest) {
  const saved = await req.payload.findByID({ collection: "knowledge-bases", id: String(req.routeParams?.id), depth: 0, overrideAccess: false, user: req.user });
  return parseKbDefinition(documentJson(form, saved));
}

interface Attached {
  readonly name: string;
  readonly text: string;
}

export const KnowledgeBases: CollectionConfig = {
  slug: "knowledge-bases",
  labels: { singular: "Knowledge base", plural: "Knowledge bases" },
  versions: { drafts: false, maxPerDoc: 100 },
  lockDocuments: false,
  access: { read: signedIn, create: editor, update: editor, delete: () => false },
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "kbId", "updatedAt"],
    description: "A knowledge base is compiled from documents. Save the definition, attach the files and compile, read the coverage report, then publish.",
  },
  fields: [...fields, { name: "kbPanel", type: "ui", admin: { position: "sidebar", components: { Field: "/components/KbPanel.tsx#KbPanel" } } }],
  endpoints: [
    {
      path: "/:id/compile",
      method: "post",
      handler: async (req) => {
        const actor = actorOf(req.user);
        if (!actor || !mayEdit(actor.role)) return json({ error: "Authors and above compile knowledge bases." }, 403);
        await addDataAndFileToRequest(req);
        const files = ((req.data ?? {}) as { files?: Attached[] }).files ?? [];
        let def;
        try {
          def = await savedDefinition(req);
        } catch (err) {
          return json({ error: `The saved definition cannot compile: ${reason(err)}` }, 409);
        }
        const named = def.sources.filter((s) => s.kind === "file").map((s) => s.location);
        const attached = new Set(files.map((f) => String(f.name)));
        const missing = named.filter((n) => !attached.has(n));
        if (missing.length) return json({ error: `Attach ${missing.join(", ")} to compile.` }, 400);
        let sources;
        try {
          sources = attachedFiles(files.map((f) => ({ name: String(f.name), text: String(f.text) })));
        } catch (err) {
          return json({ error: reason(err) }, 400);
        }
        const c = await core();
        try {
          const loaded = await readSources(def, sources, { http: c.http, address: c.store.address, db: c.db, actor: actor.id, labPatterns: c.config.participantIdPatterns });
          return json(await requestCompile(c, def, loaded, new Date()));
        } catch (err) {
          return json({ error: reason(err) }, 409);
        }
      },
    },
    {
      path: "/compiles/:jobId",
      method: "get",
      handler: async (req) => {
        const actor = actorOf(req.user);
        if (!actor) return json({ error: "Sign in first." }, 401);
        const c = await core();
        const jobId = String(req.routeParams?.jobId);
        const cls = await compileClass(c.db, jobId);
        if (!cls) return json({ error: "No compile has that id." }, 404);
        if (!mayPreview(actor.role, cls)) return json({ error: `Reading a ${cls} compile needs the data steward or the PI.` }, 403);
        const result = await compileResult(c.db, jobId);
        if (result?.t !== "compiled") return json({ result });
        const snapshot = await loadManifest(c.db, c.store.address, result.snapshot);
        if (!snapshot) return json({ error: "That compile's snapshot is gone." }, 404);
        return json({ result, cls: snapshot.cls, coverage: renderCoverage(snapshot, await loadOverrides(c.db, snapshot.id)) });
      },
    },
    {
      path: "/:id/publish",
      method: "post",
      handler: async (req) => {
        const actor = actorOf(req.user);
        if (!actor) return json({ error: "Sign in first." }, 401);
        await addDataAndFileToRequest(req);
        const body = (req.data ?? {}) as { snapshot?: unknown; note?: unknown };
        const c = await core();
        const def = await savedDefinition(req);
        const snapshot = await loadManifest(c.db, c.store.address, String(body.snapshot ?? "") as SnapshotId);
        if (!snapshot || snapshot.kbId !== def.kbId) return json({ error: `That snapshot is not a compile of ${def.kbId}.` }, 404);
        const refusal = roleRefusal(actor, await kbPublishClass(c.db, snapshot));
        if (refusal) return json({ error: describeRoleRefusal(refusal) }, 403);
        const note = typeof body.note === "string" && body.note.trim() ? { note: body.note } : null;
        try {
          const result = await publishSnapshot(c.db, c.store.address, snapshot.id, actor.id, note);
          if (!result.ok) return json({ error: `Not published. No entry supports ${result.gaps.length === 1 ? "this coverage question" : `these ${result.gaps.length} coverage questions`}: ${result.gaps.join("; ")}. Add a source that answers it, or publish over the gaps with a note.`, gaps: result.gaps }, 409);
          return json(result);
        } catch (err) {
          return json({ error: reason(err) }, 409);
        }
      },
    },
  ],
};
