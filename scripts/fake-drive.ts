/**
 * A fake Google Drive API v3, enough for driveSource (packages/core/src/sources.ts): files.list on a parent folder
 * with permissions, files.export of a Google Doc as text/plain, and files.get?alt=media. A live OAuth token later
 * takes the same path; only base_url and the token change.
 *
 * Every request needs "Authorization: Bearer <token>". Files live in memory, and the walk and the tests edit them
 * through put(), edit() and share().
 */

import { createServer, type Server } from "node:http";
import { once } from "node:events";

export interface FakePermission {
  readonly type: "user" | "group" | "domain" | "anyone";
  readonly role: "reader" | "writer" | "owner";
  readonly emailAddress?: string;
  readonly domain?: string;
}

export interface FakeFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly parent: string;
  modifiedTime: string;
  content: string;
  permissions: FakePermission[];
}

export const GOOGLE_DOC = "application/vnd.google-apps.document";
export const FOLDER = "application/vnd.google-apps.folder";

export interface FakeDrive {
  /** http://127.0.0.1:<port>, for [sources.<id>] base_url. */
  readonly url: string;
  readonly token: string;
  /** "METHOD path?query" of each request, in order. */
  readonly requests: readonly string[];
  put(file: Omit<FakeFile, "modifiedTime"> & { modifiedTime?: string }): FakeFile;
  /** New content, and modifiedTime moves to `at` (default now). */
  edit(id: string, content: string, at?: string): void;
  share(id: string, permissions: FakePermission[]): void;
  remove(id: string): void;
  close(): Promise<void>;
}

/** Page size the fake uses, small so the tests cover pagination. */
const PAGE = 2;

export async function startFakeDrive(token = "fake-drive-token"): Promise<FakeDrive> {
  const files = new Map<string, FakeFile>();
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
    if (req.method !== "GET") return send(405, { error: { code: 405 } });
    if (url.pathname === "/drive/v3/files") {
      const parent = /^'([^']+)' in parents and trashed = false$/.exec(url.searchParams.get("q") ?? "")?.[1];
      if (!parent) return send(400, { error: { code: 400, message: "q must be '<folder>' in parents and trashed = false" } });
      const all = [...files.values()].filter((f) => f.parent === parent).sort((a, b) => (a.id < b.id ? -1 : 1));
      const start = Number(url.searchParams.get("pageToken") ?? "0");
      const page = all.slice(start, start + PAGE);
      const withPerms = (url.searchParams.get("fields") ?? "").includes("permissions");
      return send(200, {
        files: page.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, ...(withPerms ? { permissions: f.permissions } : {}) })),
        ...(start + PAGE < all.length ? { nextPageToken: String(start + PAGE) } : {}),
      });
    }
    const exp = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname);
    if (exp) {
      const f = files.get(decodeURIComponent(exp[1]!));
      if (!f) return send(404, { error: { code: 404 } });
      if (f.mimeType !== GOOGLE_DOC) return send(403, { error: { code: 403, message: "Export only supports Docs Editors files." } });
      if (url.searchParams.get("mimeType") !== "text/plain") return send(400, { error: { code: 400 } });
      return send(200, f.content, "text/plain; charset=utf-8");
    }
    const get = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (get && url.searchParams.get("alt") === "media") {
      const f = files.get(decodeURIComponent(get[1]!));
      if (!f) return send(404, { error: { code: 404 } });
      if (f.mimeType.startsWith("application/vnd.google-apps.")) return send(403, { error: { code: 403, message: "Only files with binary content can be downloaded. Use Export with Docs Editors files." } });
      return send(200, f.content, f.mimeType);
    }
    return send(404, { error: { code: 404 } });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const must = (id: string) => {
    const f = files.get(id);
    if (!f) throw new Error(`no fake Drive file ${id}`);
    return f;
  };
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    requests,
    put(file) {
      const f: FakeFile = { ...file, modifiedTime: file.modifiedTime ?? new Date().toISOString(), permissions: [...file.permissions] };
      files.set(f.id, f);
      return f;
    },
    edit(id, content, at = new Date().toISOString()) {
      const f = must(id);
      f.content = content;
      f.modifiedTime = at;
    },
    share(id, permissions) {
      must(id).permissions = [...permissions];
    },
    remove(id) {
      files.delete(id);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
