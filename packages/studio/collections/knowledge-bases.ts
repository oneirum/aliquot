/**
 * KB definitions. Like agents, Payload keeps the drafts and their revisions;
 * core owns snapshots and kb_heads. The form is generated from core's
 * kbDefinitionSchema, the same schema the kb command parses files with, and
 * the endpoints pass each request to the web door's /studio routes, which
 * call the same core functions the kb command calls: parseKbDefinition,
 * readSources, requestCompile, compileResult, renderCoverage and
 * publishSnapshot. A sealed worker runs the compile.
 *
 * Source documents are attached at compile time and never stored in Payload's
 * tables, which are not encrypted. The studio passes them on from the request
 * in memory; the door classifies them and puts the text in the encrypted
 * payload store with the job. The studio never reads or writes a file for a
 * source, and never holds the key a source is stored under.
 */

import { kbDefinitionSchema, parseKbDefinition } from "@labh/core/studio";
import { addDataAndFileToRequest, type Access, type CollectionConfig, type PayloadRequest } from "payload";
import { actorOf, core, isEditor, relay } from "../core.ts";
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

/** The saved definition behind a request, as JSON for the door to parse. */
async function savedDefinition(req: PayloadRequest): Promise<unknown> {
  const saved = await req.payload.findByID({ collection: "knowledge-bases", id: String(req.routeParams?.id), depth: 0, overrideAccess: false, user: req.user });
  return documentJson(form, saved);
}

interface Attached {
  readonly name: string;
  readonly text?: string;
  readonly base64?: string;
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
  fields: [...fields, { name: "kbPanel", type: "ui", admin: { position: "sidebar", components: { Field: "/components/KbPanel.tsx#KbPanel" } } }, { name: "classesPanel", type: "ui", admin: { position: "sidebar", components: { Field: "/components/ClassesPanel.tsx#ClassesPanel" } } }],
  endpoints: [
    {
      path: "/catalog/classes",
      method: "get",
      handler: async (req) => {
        const actor = actorOf(req.user);
        if (!actor) return json({ error: "Sign in first." }, 401);
        return relay(await (await core()).call("data-classes", actor, {}));
      },
    },
    {
      path: "/:id/compile",
      method: "post",
      handler: async (req) => {
        const actor = actorOf(req.user);
        if (!actor) return json({ error: "Sign in first." }, 401);
        await addDataAndFileToRequest(req);
        const files = ((req.data ?? {}) as { files?: Attached[] }).files ?? [];
        const attached = files.map((f) => (typeof f.base64 === "string" ? { name: String(f.name), base64: f.base64 } : { name: String(f.name), text: String(f.text) }));
        return relay(await (await core()).call("kb-compile", actor, { definition: await savedDefinition(req), files: attached }));
      },
    },
    {
      path: "/compiles/:jobId",
      method: "get",
      handler: async (req) => {
        const actor = actorOf(req.user);
        if (!actor) return json({ error: "Sign in first." }, 401);
        return relay(await (await core()).call("kb-compile-result", actor, { jobId: String(req.routeParams?.jobId) }));
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
        const { kbId } = parseKbDefinition(await savedDefinition(req));
        return relay(await (await core()).call("kb-publish", actor, { kbId, snapshot: String(body.snapshot ?? ""), ...(typeof body.note === "string" ? { note: body.note } : {}) }));
      },
    },
  ],
};
