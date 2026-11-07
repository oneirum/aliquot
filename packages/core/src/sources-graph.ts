/**
 * A SharePoint document library or a OneDrive through Microsoft Graph: `[sources.<id>] kind = "graph"`.
 *
 *   GET /v1.0/drives/{drive-id}/root/delta          every item the first time, then only what changed since the
 *                                                   deltaLink of the last sync; 410 Gone means start over
 *   GET /v1.0/drives/{drive-id}/items/{id}/permissions   who may see a file: its scope
 *   GET /v1.0/drives/{drive-id}/items/{id}/content  302 to a short-lived download URL, followed through the egress
 *
 * Invariants:
 * - scan() returns the whole library as it now is, like every DocumentSource; delta only decides what is fetched.
 *   A file deleted in SharePoint drops out of the next scan, so syncKb removes its entry.
 * - Delta on a business drive is supported on the root only, so the source always reads root delta and keeps the
 *   tree itself (delta items carry no parentReference.path). Locations are computed from that tree at the end of
 *   each scan, so a folder rename moves every file under it without the files appearing in the delta.
 * - Permissions are read before content, so a file no lab member may see is never downloaded. A file that appears
 *   in a delta has its permissions read again; a folder that appears in an incremental delta (a sharing change, a
 *   rename, a move) has every file under it read again, because inherited permissions change with it.
 * - A scan collects every delta page before it changes any state, and a file whose permissions or text could not
 *   be fetched keeps no cache entry, so a failed sync (which leaves the published head alone) retries it next time.
 * - Every request goes through the HTTP choke point at DEFINITION_CLASS, and the bearer token only ever goes to
 *   base_url: a nextLink or deltaLink naming another origin is refused, and the egress strips the token from the
 *   cross-origin download redirect.
 */

import { extname } from "node:path";
import { z } from "zod";
import { appendAudit } from "./audit.ts";
import type { DocumentSourceConfig } from "./config.ts";
import { Labelled } from "./dataclass.ts";
import { classifyText } from "./gate.ts";
import { DEFINITION_CLASS, readFileSource, SOURCE_FILE_TYPES } from "./kb-compile.ts";
import type { MemberDirectory } from "./members.ts";
import type { DocumentSource, DriveDeps, SourceDocument } from "./sources.ts";

export type GraphSourceConfig = Extract<DocumentSourceConfig, { kind: "graph" }>;

const identity = z.object({ id: z.string().optional(), displayName: z.string().optional(), email: z.string().optional(), loginName: z.string().optional() }).passthrough();
const identitySet = z.object({ user: identity.optional(), group: identity.optional(), siteUser: identity.optional(), siteGroup: identity.optional(), application: identity.optional() }).passthrough();
const graphPermission = z
  .object({
    id: z.string(),
    roles: z.array(z.string()).default([]),
    link: z.object({ scope: z.string().optional(), type: z.string().optional() }).passthrough().optional(),
    grantedToV2: identitySet.optional(),
    grantedToIdentitiesV2: z.array(identitySet).optional(),
    grantedTo: identitySet.optional(),
    grantedToIdentities: z.array(identitySet).optional(),
  })
  .passthrough();
export type GraphPermission = z.infer<typeof graphPermission>;
const permissionPage = z.object({ value: z.array(graphPermission), "@odata.nextLink": z.string().optional() });

const deltaItem = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    parentReference: z.object({ id: z.string().optional() }).passthrough().optional(),
    file: z.object({ mimeType: z.string().optional() }).passthrough().optional(),
    folder: z.object({}).passthrough().optional(),
    root: z.object({}).passthrough().optional(),
    deleted: z.object({}).passthrough().optional(),
    lastModifiedDateTime: z.string().optional(),
    cTag: z.string().optional(),
  })
  .passthrough();
const deltaPage = z.object({ value: z.array(deltaItem), "@odata.nextLink": z.string().optional(), "@odata.deltaLink": z.string().optional() });
type DeltaItem = z.infer<typeof deltaItem>;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);

/** SharePoint's claims login, "i:0#.f|membership|ana@lab.edu", ends in the user's address. */
function emailOf(i: z.infer<typeof identity> | undefined): string | null {
  if (!i) return null;
  if (i.email) return i.email;
  const tail = i.loginName?.split("|").pop();
  return tail && tail.includes("@") ? tail : null;
}

/**
 * Graph permissions to an entry scope. A sharing link for anyone or for the organization is the whole lab. A user
 * (an Entra user or a SharePoint site user) is the member the directory maps their address to; an Entra group is the
 * directory's group for its address; a SharePoint site group ("Lab Members") is what the source's site_groups table
 * names. Anything else adds no one.
 */
export function scopeFromGraphPermissions(perms: readonly GraphPermission[], directory: MemberDirectory, siteGroups: Readonly<Record<string, string>>): string[] {
  const scope = new Set<string>();
  for (const p of perms) {
    if (p.link?.scope === "anonymous" || p.link?.scope === "organization") scope.add("lab");
    const grants = [p.grantedToV2, ...(p.grantedToIdentitiesV2 ?? []), p.grantedTo, ...(p.grantedToIdentities ?? [])];
    for (const g of grants) {
      if (!g) continue;
      for (const u of [g.user, g.siteUser]) {
        const email = emailOf(u);
        const m = email ? directory.memberForEmail(email) : null;
        if (m) scope.add(`member:${m}`);
      }
      const groupEmail = emailOf(g.group);
      const grp = groupEmail ? directory.groupForEmail(groupEmail) : null;
      if (grp) scope.add(`group:${grp}`);
      const named = g.siteGroup?.displayName ? siteGroups[g.siteGroup.displayName] : undefined;
      if (named) scope.add(named);
    }
  }
  return [...scope].sort();
}

interface Node {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly kind: "root" | "folder" | "file";
  readonly mimeType: string;
  readonly modifiedAt: string;
  readonly cTag: string;
}

export type GraphDeps = DriveDeps;

/** What a Graph source keeps between scans; exposed for tests, which check that delta, not a full listing, drives a re-sync. */
export interface GraphState {
  readonly fullSyncs: number;
  readonly deltaSyncs: number;
}

export function graphSource(cfg: GraphSourceConfig, deps: GraphDeps): DocumentSource & { state(): GraphState } {
  const nodes = new Map<string, Node>();
  const scopes = new Map<string, readonly string[]>();
  /** By item id, for the cTag (content version) it was read at: the text, or why the readers could not read it. */
  const texts = new Map<string, { readonly cTag: string; readonly text: string } | { readonly cTag: string; readonly why: string }>();
  let deltaLink: string | null = null;
  let fullSyncs = 0;
  let deltaSyncs = 0;
  const origin = new URL(cfg.baseUrl).origin;
  const drive = `${cfg.baseUrl}/v1.0/drives/${encodeURIComponent(cfg.driveId)}`;

  const request = async (url: string, init: RequestInit, auth: boolean): Promise<Response> => {
    // The request carries drive and item ids and, on a download hop, a signed URL: lab.toml's text and Graph's, never
    // a document's. DEFINITION_CLASS, raised if an id matches a participant pattern.
    const payload = Labelled.stamp(url, classifyText(url, DEFINITION_CLASS, deps.labPatterns).cls, `source:${cfg.id}`);
    return deps.http.request(url, payload, async (event) => {
      await appendAudit(deps.db, `source:${cfg.id}`, { t: "call", context: { t: "kb-source", kbId: cfg.kb, sourceId: cfg.id }, event });
    }, { ...init, headers: { ...(auth ? { authorization: `Bearer ${deps.token}` } : {}), ...(init.headers as Record<string, string> | undefined) } });
  };
  const graphGet = async (url: string, headers: Record<string, string> = {}): Promise<Response> => {
    if (new URL(url).origin !== origin) throw new Error(`Graph returned a link to ${new URL(url).origin}, not ${origin}; the token is not sent there`);
    return request(url, { headers, redirect: "error" }, true);
  };

  /** Every page of one delta round, collected before any state changes. Null when Graph says the deltaLink expired. */
  const readDelta = async (start: string): Promise<{ readonly items: readonly DeltaItem[]; readonly next: string } | null> => {
    const items: DeltaItem[] = [];
    let url = start;
    for (;;) {
      // deltashowremovedasdeleted: a file moved out of reach is reported as deleted, not silently dropped.
      // deltashowsharingchanges: a file whose sharing changed appears in the delta.
      const res = await graphGet(url, { prefer: "deltashowremovedasdeleted, deltatraversepermissiongaps, deltashowsharingchanges" });
      if (res.status === 410) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) throw new Error(`Graph delta: HTTP ${res.status}`);
      const page = deltaPage.parse(await res.json());
      items.push(...page.value);
      if (page["@odata.nextLink"]) url = page["@odata.nextLink"];
      else if (page["@odata.deltaLink"]) return { items, next: page["@odata.deltaLink"] };
      else throw new Error("Graph delta: a page with neither nextLink nor deltaLink");
    }
  };

  const children = (folderId: string): string[] => [...nodes.values()].filter((n) => n.parentId === folderId).flatMap((n) => (n.kind === "file" ? [n.id] : [n.id, ...children(n.id)]));

  const apply = (items: readonly DeltaItem[], incremental: boolean): void => {
    for (const it of items) {
      scopes.delete(it.id);
      if (it.deleted) {
        if (nodes.get(it.id)?.kind === "folder") for (const c of children(it.id)) (scopes.delete(c), texts.delete(c), nodes.delete(c));
        nodes.delete(it.id);
        texts.delete(it.id);
        continue;
      }
      const kind = it.root ? "root" : it.folder ? "folder" : it.file ? "file" : null;
      if (!kind) continue; // a package (a OneNote notebook) or a remote item: not a document Aliquot reads
      nodes.set(it.id, { id: it.id, name: it.name ?? "", parentId: it.parentReference?.id ?? null, kind, mimeType: it.file?.mimeType ?? "", modifiedAt: it.lastModifiedDateTime ?? "1970-01-01T00:00:00.000Z", cTag: it.cTag ?? it.lastModifiedDateTime ?? "" });
      if (incremental && kind !== "file") for (const c of children(it.id)) scopes.delete(c);
    }
  };

  /** "Lab SOPs/Freezer alarm.docx", or null for a file whose chain to the root is broken (its folder was deleted). */
  const pathOf = (n: Node): string | null => {
    const parts: string[] = [];
    let at: Node | undefined = n;
    for (let guard = 0; at && at.kind !== "root"; guard++) {
      if (guard > 256) return null;
      parts.unshift(at.name);
      at = at.parentId ? nodes.get(at.parentId) : undefined;
    }
    return at ? parts.join("/") : null;
  };

  const scopeOf = async (n: Node): Promise<readonly string[]> => {
    const hit = scopes.get(n.id);
    if (hit) return hit;
    const perms: GraphPermission[] = [];
    let url: string | undefined = `${drive}/items/${encodeURIComponent(n.id)}/permissions`;
    while (url) {
      const res = await graphGet(url);
      if (!res.ok) throw new Error(`Graph permissions of ${n.name}: HTTP ${res.status}`);
      const page = permissionPage.parse(await res.json());
      perms.push(...page.value);
      url = page["@odata.nextLink"];
    }
    const scope = scopeFromGraphPermissions(perms, deps.directory, cfg.siteGroups);
    scopes.set(n.id, scope);
    return scope;
  };

  /** The file's text, or why the readers skip it. A fetch that fails throws: the sync fails and the head keeps the file. */
  const textOf = async (n: Node): Promise<string | { readonly why: string }> => {
    const hit = texts.get(n.id);
    if (hit && hit.cTag === n.cTag) return "text" in hit ? hit.text : { why: hit.why };
    const ext = extname(n.name).toLowerCase();
    const name = SOURCE_FILE_TYPES.includes(ext) ? n.name : n.mimeType === DOCX_MIME ? `${n.name}.docx` : `${n.name}.txt`;
    if (extname(name).toLowerCase() === ".pdf" && !deps.pdf) return { why: "PDFs are read in the sandbox container; set [sandbox] in lab.toml" };
    // Graph answers 302 with a pre-authenticated URL on the tenant's SharePoint host. The egress decides that hop as
    // its own destination, and drops the bearer token because the origin changes.
    const res = await request(`${drive}/items/${encodeURIComponent(n.id)}/content`, { redirect: "follow" }, true);
    if (!res.ok) throw new Error(`Graph content of ${n.name}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let read: { readonly cTag: string; readonly text: string } | { readonly cTag: string; readonly why: string };
    try {
      read = { cTag: n.cTag, text: await readFileSource(name, async () => bytes, deps.pdf) };
    } catch (err) {
      read = { cTag: n.cTag, why: err instanceof Error ? err.message : String(err) };
    }
    texts.set(n.id, read);
    return "text" in read ? read.text : { why: read.why };
  };

  return {
    id: cfg.id,
    kind: "graph",
    kb: cfg.kb,
    cls: cfg.cls,
    state: () => ({ fullSyncs, deltaSyncs }),
    async scan() {
      let round = deltaLink ? await readDelta(deltaLink) : null;
      const incremental = round !== null;
      if (!round) {
        round = await readDelta(`${drive}/root/delta`);
        if (!round) throw new Error("Graph delta: the first delta request answered 410 Gone");
        nodes.clear();
        scopes.clear();
        fullSyncs++;
      } else deltaSyncs++;
      apply(round.items, incremental);
      deltaLink = round.next;

      const prefix = cfg.folder ? `${cfg.folder.replace(/^\/+|\/+$/g, "")}/` : "";
      const docs: SourceDocument[] = [];
      const skipped: { location: string; why: string }[] = [];
      const files = [...nodes.values()].filter((n) => n.kind === "file").flatMap((n) => {
        const path = pathOf(n);
        return path !== null && path.startsWith(prefix) ? [{ n, location: path.slice(prefix.length) }] : [];
      });
      for (const { n, location } of files.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0))) {
        const ext = extname(n.name).toLowerCase();
        if (!(SOURCE_FILE_TYPES.includes(ext) || TEXT_MIMES.has(n.mimeType) || n.mimeType === DOCX_MIME)) {
          skipped.push({ location, why: `${ext || n.mimeType || "no extension"} is not a document type Aliquot reads` });
          continue;
        }
        const scope = await scopeOf(n);
        if (!scope.length) {
          skipped.push({ location, why: "its SharePoint permissions name no lab member, group or the organization" });
          continue;
        }
        const text = await textOf(n);
        if (typeof text !== "string") skipped.push({ location, why: text.why });
        else docs.push({ location, text, modifiedAt: new Date(n.modifiedAt).toISOString(), scope });
      }
      return { docs, skipped };
    },
  };
}
