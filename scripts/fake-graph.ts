/**
 * A fake Microsoft Graph, enough for graphSource (packages/core/src/sources-graph.ts): one drive (a SharePoint
 * document library) with root delta, nextLink pages and a deltaLink, an item's effective permissions, and content as
 * a 302 to a pre-authenticated download URL. A real token later takes the same path; only base_url, the drive id and
 * the token change.
 *
 *   GET /v1.0/drives/{drive}/root/delta[?token=N]       pages of PAGE items; the last page has @odata.deltaLink
 *   GET /v1.0/drives/{drive}/items/{id}/permissions     own grants, then inherited ones unless the item breaks
 *                                                       inheritance (restrict), each with inheritedFrom
 *   GET /v1.0/drives/{drive}/items/{id}/content         302 to /_download/{id}?tempauth=... on a second port (its own
 *                                                       origin, like <tenant>.sharepoint.com), which needs no bearer
 *
 * Every Graph call needs "Authorization: Bearer <token>". The tests and the walk edit the library through put(),
 * edit(), share(), restrict(), rename() and remove(); each change moves the item in the change log, as Graph does,
 * and expireDelta() makes every outstanding deltaLink answer 410 Gone.
 */

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

export type FakeGrant =
  | { readonly kind: "link"; readonly scope: "anonymous" | "organization" | "users"; readonly roles?: readonly string[] }
  | { readonly kind: "user"; readonly email: string; readonly roles?: readonly string[] }
  | { readonly kind: "group"; readonly email: string; readonly roles?: readonly string[] }
  | { readonly kind: "siteGroup"; readonly name: string; readonly roles?: readonly string[] };

export interface FakeItem {
  readonly id: string;
  name: string;
  parent: string;
  readonly folder: boolean;
  readonly mimeType: string;
  content: Uint8Array;
  modified: string;
  cTag: number;
  grants: FakeGrant[];
  /** False once the item has unique permissions: its ancestors' grants no longer apply. */
  inherits: boolean;
}

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PDF = "application/pdf";

export interface FakeGraph {
  /** http://127.0.0.1:<port>, for [sources.<id>] base_url. */
  readonly url: string;
  readonly token: string;
  readonly driveId: string;
  /** "METHOD path?query" of each request, in order. */
  readonly requests: readonly string[];
  /** The authorization header each download hop arrived with: the token must never reach it. */
  readonly downloadAuth: readonly (string | undefined)[];
  put(item: { id: string; name: string; parent?: string; folder?: boolean; mimeType?: string; content?: string | Uint8Array; grants?: FakeGrant[]; inherits?: boolean; modified?: string }): void;
  edit(id: string, content: string | Uint8Array, at?: string): void;
  /** Replace the item's own grants (a sharing change); inheritance stays as it was. */
  share(id: string, grants: FakeGrant[]): void;
  /** Break inheritance and give the item exactly these grants. */
  restrict(id: string, grants: FakeGrant[]): void;
  rename(id: string, name: string): void;
  remove(id: string): void;
  expireDelta(): void;
  close(): Promise<void>;
}

/** Items per delta page, small so the tests cover nextLink. */
const PAGE = 2;
const ROOT = "root";

export async function startFakeGraph(token = "fake-graph-token", driveId = "b!lab0-sops"): Promise<FakeGraph> {
  const items = new Map<string, FakeItem>();
  /** Item id -> the sequence number of its last change; deleted items stay as tombstones. */
  const changed = new Map<string, number>();
  const tombstones = new Set<string>();
  let seq = 0;
  let epoch = 0;
  const tempauth = new Map<string, string>();
  const rounds = new Map<string, { readonly ids: readonly string[]; readonly upTo: number }>();
  const requests: string[] = [];
  const downloadAuth: (string | undefined)[] = [];
  /** Item id -> the seq of its last sharing change, so the delta can carry @microsoft.graph.sharedChanged. */
  const sharedAt = new Map<string, number>();
  // A change moves the item and, as on SharePoint, every folder above it (their size and modified time change).
  const touch = (id: string) => {
    const at = ++seq;
    changed.set(id, at);
    for (let p = items.get(id)?.parent; p; p = items.get(p)?.parent) changed.set(p, at);
    return at;
  };
  items.set(ROOT, { id: ROOT, name: "root", parent: "", folder: true, mimeType: "", content: new Uint8Array(), modified: new Date().toISOString(), cTag: 1, grants: [], inherits: false });
  touch(ROOT);

  const ancestors = (it: FakeItem): FakeItem[] => {
    const out: FakeItem[] = [];
    for (let at = items.get(it.parent); at; at = items.get(at.parent)) out.push(at);
    return out;
  };
  const permission = (g: FakeGrant, i: number, from: FakeItem | null) => {
    const roles = g.roles ?? ["read"];
    const inheritedFrom = from ? { inheritedFrom: { driveId, id: from.id } } : {};
    const id = `${from?.id ?? "own"}-${i}`;
    if (g.kind === "link") return { id, roles, link: { scope: g.scope, type: "view" }, ...(g.scope === "users" ? { grantedToIdentitiesV2: [] } : {}), ...inheritedFrom };
    if (g.kind === "user") return { id, roles, grantedToV2: { user: { id: `u-${g.email}`, displayName: g.email.split("@")[0], email: g.email }, siteUser: { id: "7", loginName: `i:0#.f|membership|${g.email}` } }, ...inheritedFrom };
    if (g.kind === "group") return { id, roles, grantedToV2: { group: { id: `g-${g.email}`, displayName: g.email.split("@")[0], email: g.email } }, ...inheritedFrom };
    return { id, roles, grantedToV2: { siteGroup: { id: "3", displayName: g.name, loginName: g.name } }, ...inheritedFrom };
  };
  const effective = (it: FakeItem) => {
    const own = it.grants.map((g, i) => permission(g, i, null));
    if (!it.inherits) return own;
    const inherited: ReturnType<typeof permission>[] = [];
    for (const a of ancestors(it)) {
      inherited.push(...a.grants.map((g, i) => permission(g, i, a)));
      if (!a.inherits) break;
    }
    return [...own, ...inherited];
  };
  const driveItem = (it: FakeItem) => ({
    id: it.id,
    name: it.name,
    eTag: `"{${it.id}},${changed.get(it.id)}"`,
    cTag: `"c:{${it.id}},${it.cTag}"`,
    lastModifiedDateTime: it.modified,
    parentReference: it.id === ROOT ? { driveId, driveType: "documentLibrary" } : { driveId, driveType: "documentLibrary", id: it.parent },
    ...(sharedAt.get(it.id) === changed.get(it.id) ? { "@microsoft.graph.sharedChanged": "True" } : {}),
    ...(it.id === ROOT ? { root: {}, folder: { childCount: 0 } } : it.folder ? { folder: { childCount: [...items.values()].filter((c) => c.parent === it.id).length } } : { file: { mimeType: it.mimeType } }),
  });

  // The download host is its own origin, as <tenant>.sharepoint.com is to graph.microsoft.com.
  const downloads: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push(`${req.method} download:${url.pathname}`);
    const send = (status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => {
      res.writeHead(status, headers);
      res.end(body instanceof Uint8Array ? body : JSON.stringify(body));
    };
    const download = /^\/_download\/([^/]+)$/.exec(url.pathname);
    if (download) {
      downloadAuth.push(req.headers.authorization);
      const id = decodeURIComponent(download[1]!);
      const it = items.get(id);
      if (!it || tempauth.get(id) !== url.searchParams.get("tempauth")) return send(401, { error: { code: "unauthenticated" } });
      return send(200, it.content, { "content-type": it.mimeType || "application/octet-stream" });
    }
    return send(404, { error: { code: "itemNotFound" } });
  });
  downloads.listen(0, "127.0.0.1");
  await once(downloads, "listening");
  const dlAddress = downloads.address();
  const downloadUrl = `http://127.0.0.1:${typeof dlAddress === "object" && dlAddress ? dlAddress.port : 0}`;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => {
      res.writeHead(status, headers);
      res.end(body instanceof Uint8Array ? body : typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } });
    if (req.method !== "GET") return send(405, { error: { code: "invalidRequest" } });
    const self = `http://${req.headers.host}`;
    const drivePath = `/v1.0/drives/${encodeURIComponent(driveId)}`;
    if (url.pathname === `${drivePath}/root/delta`) {
      // A deltaLink is token=<epoch>.<seq>; a nextLink is round=<id>&offset=<n>, a page of a round listed when it began.
      const roundId = url.searchParams.get("round");
      let round = roundId ? rounds.get(roundId) : undefined;
      if (roundId && !round) return send(400, { error: { code: "invalidRequest", message: "unknown round" } });
      if (!round) {
        const [e, since] = (url.searchParams.get("token") ?? `${epoch}.0`).split(".").map(Number) as [number, number];
        if (e !== epoch) return send(410, { error: { code: "resyncRequired", message: "The delta token is no longer valid." } });
        const ids = [...changed.entries()].filter(([, at]) => at > since).sort((x, y) => x[1] - y[1]).map(([id]) => id);
        // The first round lists what exists; later rounds report deletions too.
        round = { ids: ids.filter((id) => items.has(id) || (since > 0 && tombstones.has(id))), upTo: seq };
        rounds.set(String(rounds.size + 1), round);
      }
      const id = roundId ?? String(rounds.size);
      const start = Number(url.searchParams.get("offset") ?? "0");
      const page = round.ids.slice(start, start + PAGE).map((i) => {
        const it = items.get(i);
        return it ? driveItem(it) : { id: i, deleted: { state: "deleted" }, parentReference: { driveId } };
      });
      const end = start + PAGE >= round.ids.length;
      return send(200, {
        "@odata.context": `${self}/v1.0/$metadata#Collection(driveItem)`,
        value: page,
        ...(end ? { "@odata.deltaLink": `${self}${drivePath}/root/delta?token=${epoch}.${round.upTo}` } : { "@odata.nextLink": `${self}${drivePath}/root/delta?round=${id}&offset=${start + PAGE}` }),
      });
    }
    const perms = new RegExp(`^${drivePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/items/([^/]+)/permissions$`).exec(url.pathname);
    if (perms) {
      const it = items.get(decodeURIComponent(perms[1]!));
      if (!it) return send(404, { error: { code: "itemNotFound" } });
      return send(200, { value: effective(it) });
    }
    const content = new RegExp(`^${drivePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/items/([^/]+)/content$`).exec(url.pathname);
    if (content) {
      const it = items.get(decodeURIComponent(content[1]!));
      if (!it || it.folder) return send(404, { error: { code: "itemNotFound" } });
      const auth = randomBytes(12).toString("hex");
      tempauth.set(it.id, auth);
      return send(302, "", { location: `${downloadUrl}/_download/${encodeURIComponent(it.id)}?tempauth=${auth}` });
    }
    return send(404, { error: { code: "itemNotFound" } });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const must = (id: string) => {
    const it = items.get(id);
    if (!it) throw new Error(`no fake Graph item ${id}`);
    return it;
  };
  const bytes = (c: string | Uint8Array) => (typeof c === "string" ? new TextEncoder().encode(c) : c);
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    driveId,
    requests,
    downloadAuth,
    put(item) {
      // The root has no parent and nothing to inherit from: put("root") only sets its grants.
      const isRoot = item.id === ROOT;
      items.set(item.id, { id: item.id, name: item.name, parent: isRoot ? "" : (item.parent ?? ROOT), folder: isRoot || (item.folder ?? false), mimeType: item.mimeType ?? (item.folder ? "" : "text/markdown"), content: bytes(item.content ?? ""), modified: item.modified ?? new Date().toISOString(), cTag: 1, grants: [...(item.grants ?? [])], inherits: isRoot ? false : (item.inherits ?? true) });
      tombstones.delete(item.id);
      touch(item.id);
    },
    edit(id, content, at = new Date().toISOString()) {
      const it = must(id);
      it.content = bytes(content);
      it.modified = at;
      it.cTag++;
      touch(id);
    },
    share(id, grants) {
      must(id).grants = [...grants];
      sharedAt.set(id, touch(id));
    },
    restrict(id, grants) {
      const it = must(id);
      it.grants = [...grants];
      it.inherits = false;
      sharedAt.set(id, touch(id));
    },
    rename(id, name) {
      must(id).name = name;
      touch(id);
    },
    remove(id) {
      touch(id);
      const gone = [id];
      for (let i = 0; i < gone.length; i++) for (const c of items.values()) if (c.parent === gone[i]) gone.push(c.id);
      for (const g of gone) {
        items.delete(g);
        tombstones.add(g);
        touch(g);
      }
    },
    expireDelta() {
      epoch++;
    },
    close: async () => {
      await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => downloads.close(() => resolve()))]);
    },
  };
}
