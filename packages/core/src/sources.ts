/**
 * Document sources: where a lab's knowledge actually lives, kept in step.
 *
 *   [sources.<id>] kind = "folder"   a Box, OneDrive or Google Drive desktop sync folder; the vendor's client keeps it
 *                                    current, and watchSources re-ingests it on every change. Scope from lab.toml.
 *   [sources.<id>] kind = "gdrive"   a Drive folder through the Drive API, polled. Scope from each file's permissions.
 *   [sources.<id>] kind = "graph"    a SharePoint library or OneDrive through Microsoft Graph delta, polled
 *                                    (sources-graph.ts). Scope from each file's permissions.
 *
 *   scan          one DocumentSource -> its documents: location, text, modifiedAt, scope
 *   buildSynced   every source feeding one KB -> a snapshot, one entry per document, each with provenance
 *                 (source, location, version, modifiedAt, scope) in the manifest
 *   syncKb        build, and when the snapshot differs from the published head, save it, audit kb.synced and
 *                 move kb_heads. Intake resolves agents per run, so the next question reads the new version.
 *   watchSources  fs.watch on folders and a poll on Drive, one sync at a time per KB
 *
 * Invariants:
 * - Idempotent by content. A document's version is the keyed address of its text, the snapshot's createdAt is the
 *   newest modifiedAt, and an unchanged document keeps the modifiedAt it was first seen with, so a sync of unchanged
 *   documents yields the head's own id and writes nothing.
 * - A document's class is its source's declared class raised by the gate's detectors and the lab's participant-id
 *   patterns over its name and text. The snapshot is the join, as for a compiled KB.
 * - Scope is data in the manifest; kb.ts enforces it at retrieval. A Drive file whose permissions name no lab member,
 *   group or the domain is not ingested at all.
 * - Drive requests go through the HTTP choke point at DEFINITION_CLASS, like a KB's URL source: the request carries
 *   folder and file ids, never document text. lab.toml must place the Drive host to allow that class.
 */

import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join as joinPath, relative, sep } from "node:path";
import { z } from "zod";
import { appendAudit } from "./audit.ts";
import type { DocumentSourceConfig } from "./config.ts";
import { join, Labelled, type DataClass } from "./dataclass.ts";
import type { Db } from "./db.ts";
import { docxToMarkdown } from "./docx.ts";
import { classifyText } from "./gate.ts";
import type { Addresser, Sha256, SnapshotId } from "./hash.ts";
import { diffSnapshots, hashEntry, loadManifest, saveSnapshot, snapshotId, type EntryProvenance, type HashedEntry, type KbSnapshot, type LoadedSnapshot, type SnapshotDiff } from "./kb.ts";
import { DEFINITION_CLASS, publishSnapshot, readFileSource, SOURCE_FILE_TYPES } from "./kb-compile.ts";
import type { MemberDirectory } from "./members.ts";
import type { PayloadStore } from "./record.ts";
import { graphSource } from "./sources-graph.ts";
import type { HttpEgress } from "./tools.ts";

export interface SourceDocument {
  /** Path inside the folder, slash separated; for Drive, the folder path of names. */
  readonly location: string;
  readonly text: string;
  readonly modifiedAt: string;
  readonly scope: readonly string[];
}

export interface ScanResult {
  readonly docs: readonly SourceDocument[];
  /** Files seen and left out, with why: a type Aliquot does not read, a PDF with no sandbox, nobody in scope. */
  readonly skipped: readonly { readonly location: string; readonly why: string }[];
}

/**
 * What every source kind implements. LabArchives and Benchling are this interface with no implementation in this
 * release: a lab syncs their exports to a folder and registers the folder.
 */
export interface DocumentSource {
  readonly id: string;
  readonly kind: EntryProvenance["kind"];
  readonly kb: string;
  readonly cls: DataClass;
  scan(): Promise<ScanResult>;
}

/** Office lock files, editor swap files and the Finder's and sync clients' own files are never documents. */
function ignored(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~$") || name.endsWith(".tmp") || name.endsWith("~") || name === "Icon\r" || name === "desktop.ini" || name === "Thumbs.db";
}

export function folderSource(cfg: Extract<DocumentSourceConfig, { kind: "folder" }>, pdf?: (bytes: Uint8Array, name: string) => Promise<string>): DocumentSource {
  return {
    id: cfg.id,
    kind: "folder",
    kb: cfg.kb,
    cls: cfg.cls,
    async scan() {
      const docs: SourceDocument[] = [];
      const skipped: { location: string; why: string }[] = [];
      const walk = async (dir: string): Promise<void> => {
        const names = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const d of names) {
          if (ignored(d.name)) continue;
          const full = joinPath(dir, d.name);
          const location = relative(cfg.path, full).split(sep).join("/");
          if (d.isDirectory()) {
            await walk(full);
            continue;
          }
          if (!d.isFile()) continue;
          const ext = extname(d.name).toLowerCase();
          if (!SOURCE_FILE_TYPES.includes(ext)) {
            skipped.push({ location, why: `${ext || "no extension"} is not a document type Aliquot reads` });
            continue;
          }
          try {
            const [text, st] = await Promise.all([readFileSource(d.name, () => readFile(full), pdf), stat(full)]);
            docs.push({ location, text, modifiedAt: st.mtime.toISOString(), scope: cfg.scope });
          } catch (err) {
            // A file deleted between readdir and read, or a sync client's placeholder that would not download.
            skipped.push({ location, why: err instanceof Error ? err.message : String(err) });
          }
        }
      };
      await walk(cfg.path);
      return { docs, skipped };
    },
  };
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);

const driveList = z.object({
  nextPageToken: z.string().optional(),
  files: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      mimeType: z.string(),
      modifiedTime: z.string(),
      permissions: z.array(z.object({ type: z.enum(["user", "group", "domain", "anyone"]), role: z.string(), emailAddress: z.string().optional(), domain: z.string().optional() })).default([]),
    }),
  ),
});
type DriveFile = z.infer<typeof driveList>["files"][number];

/**
 * Drive permissions to an entry scope: anyone or the domain is the whole lab, a user is the lab member the directory
 * maps their email to, a group is the directory's group for its address. An email the directory does not know is
 * nobody in the lab, so it adds no one.
 */
export function scopeFromPermissions(perms: DriveFile["permissions"], directory: MemberDirectory): string[] {
  const scope = new Set<string>();
  for (const p of perms) {
    if (p.type === "anyone" || p.type === "domain") scope.add("lab");
    else if (p.type === "user" && p.emailAddress) {
      const m = directory.memberForEmail(p.emailAddress);
      if (m) scope.add(`member:${m}`);
    } else if (p.type === "group" && p.emailAddress) {
      const g = directory.groupForEmail(p.emailAddress);
      if (g) scope.add(`group:${g}`);
    }
  }
  return [...scope].sort();
}

export interface DriveDeps {
  readonly http: HttpEgress;
  readonly db: Db;
  /** The OAuth access token, from the env var lab.toml names. The fake Drive takes any. */
  readonly token: string;
  readonly directory: MemberDirectory;
  readonly labPatterns: readonly RegExp[];
  readonly pdf?: (bytes: Uint8Array, name: string) => Promise<string>;
}

/**
 * A Drive folder, its subfolders included, through files.list, files.export (Google Docs, as plain text) and
 * files.get?alt=media (Markdown, text, Word, PDF). Text is cached by file id and modifiedTime, so a poll downloads
 * only what changed.
 */
export function driveSource(cfg: Extract<DocumentSourceConfig, { kind: "gdrive" }>, deps: DriveDeps): DocumentSource {
  const cache = new Map<string, { readonly modifiedTime: string; readonly text: string }>();
  const get = async (path: string, params: Record<string, string>): Promise<Response> => {
    const url = `${cfg.baseUrl}${path}?${new URLSearchParams(params)}`;
    // The request carries ids, which are lab.toml's text: DEFINITION_CLASS, raised if an id matches a pattern.
    const payload = Labelled.stamp(url, classifyText(url, DEFINITION_CLASS, deps.labPatterns).cls, `source:${cfg.id}`);
    const res = await deps.http.request(url, payload, async (refused) => {
      await appendAudit(deps.db, `source:${cfg.id}`, { t: "call", context: { t: "kb-source", kbId: cfg.kb, sourceId: cfg.id }, event: refused });
    }, { headers: { authorization: `Bearer ${deps.token}` }, redirect: "error" });
    if (!res.ok) throw new Error(`Drive ${path}: HTTP ${res.status}`);
    return res;
  };
  const list = async (folderId: string): Promise<DriveFile[]> => {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string> = {
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime, permissions(type, role, emailAddress, domain))",
        pageSize: "100",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      };
      const page = driveList.parse(await (await get("/drive/v3/files", params)).json());
      files.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };
  const content = async (f: DriveFile): Promise<string | { readonly why: string }> => {
    const hit = cache.get(f.id);
    if (hit && hit.modifiedTime === f.modifiedTime) return hit.text;
    let text: string;
    if (f.mimeType === GOOGLE_DOC_MIME) text = await (await get(`/drive/v3/files/${encodeURIComponent(f.id)}/export`, { mimeType: "text/plain" })).text();
    else if (f.mimeType.startsWith("application/vnd.google-apps.")) return { why: `${f.mimeType} has no text export Aliquot reads` };
    else {
      const ext = extname(f.name).toLowerCase();
      const readable = TEXT_MIMES.has(f.mimeType) || f.mimeType === DOCX_MIME || SOURCE_FILE_TYPES.includes(ext);
      if (!readable) return { why: `${f.mimeType} is not a document type Aliquot reads` };
      const bytes = new Uint8Array(await (await get(`/drive/v3/files/${encodeURIComponent(f.id)}`, { alt: "media", supportsAllDrives: "true" })).arrayBuffer());
      const name = SOURCE_FILE_TYPES.includes(ext) ? f.name : f.mimeType === DOCX_MIME ? `${f.name}.docx` : `${f.name}.txt`;
      text = extname(name).toLowerCase() === ".docx" ? docxToMarkdown(bytes, name) : await readFileSource(name, async () => bytes, deps.pdf);
    }
    cache.set(f.id, { modifiedTime: f.modifiedTime, text });
    return text;
  };
  return {
    id: cfg.id,
    kind: "gdrive",
    kb: cfg.kb,
    cls: cfg.cls,
    async scan() {
      const docs: SourceDocument[] = [];
      const skipped: { location: string; why: string }[] = [];
      const walk = async (folderId: string, prefix: string): Promise<void> => {
        for (const f of await list(folderId)) {
          const location = `${prefix}${f.name}`;
          if (f.mimeType === FOLDER_MIME) {
            await walk(f.id, `${location}/`);
            continue;
          }
          const scope = scopeFromPermissions(f.permissions, deps.directory);
          if (!scope.length) {
            skipped.push({ location, why: "its Drive permissions name no lab member, group or the domain" });
            continue;
          }
          try {
            const text = await content(f);
            if (typeof text !== "string") skipped.push({ location, why: text.why });
            else docs.push({ location, text, modifiedAt: new Date(f.modifiedTime).toISOString(), scope });
          } catch (err) {
            skipped.push({ location, why: err instanceof Error ? err.message : String(err) });
          }
        }
      };
      await walk(cfg.folderId, "");
      return { docs, skipped };
    },
  };
}

/** `sop/Freezer Log.docx` from source `box-sops` -> `box-sops/sop/freezer-log.md`. */
export function entryPathOf(sourceId: string, location: string): string {
  const stem = location.slice(0, location.length - extname(location).length);
  const slug = stem
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9/_.-]/g, "")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
  return `${sourceId}/${slug || "untitled"}.md`;
}

function titleOf(location: string, text: string): string {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(text)?.[1];
  return heading || basename(location, extname(location));
}

export interface SyncedBuild {
  readonly loaded: LoadedSnapshot;
  readonly skipped: readonly { readonly source: string; readonly location: string; readonly why: string }[];
}

/**
 * Every source feeding one KB, scanned, to one snapshot. `previous` is the published head: an unchanged document
 * keeps the modifiedAt the head recorded, so touching a file without changing it does not make a new snapshot.
 */
export function buildSynced(kbId: string, scans: readonly { readonly source: DocumentSource; readonly result: ScanResult }[], previous: KbSnapshot | null, address: Addresser, labPatterns: readonly RegExp[]): SyncedBuild {
  const skipped: { source: string; location: string; why: string }[] = [];
  const docs: { path: string; title: string; text: string; cls: DataClass; prov: Omit<EntryProvenance, "version" | "modifiedAt"> & { modifiedAt: string } }[] = [];
  const taken = new Set<string>();
  for (const { source, result } of scans) {
    for (const s of result.skipped) skipped.push({ source: source.id, ...s });
    for (const d of result.docs) {
      const path = entryPathOf(source.id, d.location);
      if (taken.has(path)) {
        skipped.push({ source: source.id, location: d.location, why: `another file in this source also becomes ${path}; rename one` });
        continue;
      }
      taken.add(path);
      const cls = classifyText(`${d.location}\n${d.text}`, source.cls, labPatterns).cls;
      docs.push({ path, title: titleOf(d.location, d.text), text: d.text, cls, prov: { source: source.id, kind: source.kind, location: d.location, scope: [...d.scope].sort(), modifiedAt: d.modifiedAt } });
    }
  }
  const cls = join(...docs.map((d) => d.cls));
  const provenance: Record<string, EntryProvenance> = {};
  const entries: HashedEntry[] = [];
  for (const d of docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const version = address(cls, d.text) as string as Sha256;
    const before = previous?.provenance?.[d.path];
    const modifiedAt = before && before.version === version ? before.modifiedAt : d.prov.modifiedAt;
    provenance[d.path] = { ...d.prov, version, modifiedAt };
    entries.push(hashEntry(address, cls, { path: d.path, title: d.title, body: d.text, facts: [] }));
  }
  const manifest: Omit<KbSnapshot, "id"> = {
    kbId,
    title: kbId,
    cls,
    // Every member reads the purpose in the outline, so it names no source: a source id can say what a scope hides.
    purpose: "Documents synced from the lab's document sources.",
    entries: Object.fromEntries(entries.map((e) => [e.path, e.hash])),
    sources: [],
    compiler: null,
    coverage: [],
    irbProtocol: null,
    consentScope: null,
    createdAt: Object.values(provenance).reduce((max, p) => (p.modifiedAt > max ? p.modifiedAt : max), "1970-01-01T00:00:00.000Z"),
    provenance,
  };
  return { loaded: { snapshot: { id: snapshotId(address, manifest), ...manifest }, entries }, skipped };
}

export type SyncResult =
  | { readonly t: "unchanged"; readonly snapshot: SnapshotId; readonly skipped: SyncedBuild["skipped"] }
  | { readonly t: "published"; readonly snapshot: SnapshotId; readonly previous: SnapshotId | null; readonly diff: SnapshotDiff | null; readonly skipped: SyncedBuild["skipped"] };

export interface SyncDeps {
  readonly db: Db;
  readonly store: PayloadStore;
  readonly labPatterns: readonly RegExp[];
  /** Who the audit stream names: "source-sync" unless a person ran it. */
  readonly actor: string;
}

/** One KB's sources, scanned and, when anything changed, published. A source that fails to scan fails the sync, so a Drive outage never publishes a KB with its documents missing. */
export async function syncKb(deps: SyncDeps, kbId: string, sources: readonly DocumentSource[]): Promise<SyncResult> {
  const scans = await Promise.all(sources.map(async (source) => ({ source, result: await source.scan() })));
  const headRow = await deps.db.query<{ snapshot: SnapshotId }>("select snapshot from kb_heads where kb_id = $1", [kbId]);
  const headId = headRow.rows[0]?.snapshot ?? null;
  const head = headId ? ((await loadManifest(deps.db, deps.store.address, headId)) ?? null) : null;
  const built = buildSynced(kbId, scans, head, deps.store.address, deps.labPatterns);
  const s = built.loaded.snapshot;
  if (s.id === headId) return { t: "unchanged", snapshot: s.id, skipped: built.skipped };
  await saveSnapshot(deps.db, deps.store, s, built.loaded.entries);
  const diff = head ? diffSnapshots(head, s) : null;
  await appendAudit(deps.db, deps.actor, {
    t: "kb.synced",
    kbId,
    snapshot: s.id,
    previous: headId,
    added: diff ? diff.added.length : built.loaded.entries.length,
    removed: diff?.removed.length ?? 0,
    changed: diff?.changed.length ?? 0,
    skipped: built.skipped.length,
  });
  const published = await publishSnapshot(deps.db, deps.store.address, s.id, deps.actor);
  if (!published.ok) throw new Error(`synced snapshot ${s.id} has coverage gaps, which a synced KB never has`);
  return { t: "published", snapshot: s.id, previous: headId, diff, skipped: built.skipped };
}

/** One line per sync for the kb command and its log. */
export function describeSync(kbId: string, r: SyncResult): string {
  const skipped = r.skipped.length ? `; skipped ${r.skipped.map((s) => `${s.source}/${s.location} (${s.why})`).join(", ")}` : "";
  if (r.t === "unchanged") return `kb ${kbId}: unchanged at ${r.snapshot.slice(0, 12)}${skipped}`;
  const d = r.diff;
  const what = d ? [d.added.length && `added ${d.added.join(", ")}`, d.changed.length && `changed ${d.changed.join(", ")}`, d.removed.length && `removed ${d.removed.join(", ")}`].filter(Boolean).join("; ") : "first sync";
  return `kb ${kbId}: published ${r.snapshot.slice(0, 12)}${r.previous ? ` (was ${r.previous.slice(0, 12)})` : ""}: ${what}${skipped}`;
}

export interface Watching {
  /** Resolves once every KB's first sync has ended. */
  readonly ready: Promise<void>;
  close(): void;
}

/** How long a folder stays quiet before it is synced: a save is often several writes, and a sync client's download many. */
export const SETTLE_MS = 300;

/**
 * Syncs every KB once, then again whenever one of its folders changes (fs.watch, recursive) or its Drive poll comes
 * round. At most one sync per KB runs at a time; a change during a sync queues exactly one more.
 */
export function watchSources(deps: SyncDeps, sources: readonly DocumentSource[], folders: ReadonlyMap<string, string>, pollSeconds: ReadonlyMap<string, number>, log: (line: string) => void): Watching {
  const byKb = new Map<string, DocumentSource[]>();
  for (const s of sources) byKb.set(s.kb, [...(byKb.get(s.kb) ?? []), s]);
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();
  let closed = false;
  const sync = (kb: string): Promise<void> => {
    if (running.has(kb)) {
      again.add(kb);
      return running.get(kb)!;
    }
    const p = (async () => {
      do {
        again.delete(kb);
        try {
          log(describeSync(kb, await syncKb(deps, kb, byKb.get(kb)!)));
        } catch (err) {
          log(`kb ${kb}: sync failed, head unchanged: ${err instanceof Error ? err.message : String(err)}`);
        }
      } while (again.has(kb) && !closed);
    })().finally(() => running.delete(kb));
    running.set(kb, p);
    return p;
  };
  const watchers: FSWatcher[] = [];
  const timers: NodeJS.Timeout[] = [];
  const stops: (() => void)[] = [];
  for (const s of sources) {
    const dir = folders.get(s.id);
    if (dir) {
      let settle: NodeJS.Timeout | null = null;
      const w = watch(dir, { recursive: true }, () => {
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => void sync(s.kb), SETTLE_MS);
      });
      w.on("error", (err) => log(`source ${s.id}: watch failed: ${err.message}`));
      watchers.push(w);
      stops.push(() => settle && clearTimeout(settle));
    }
    const every = pollSeconds.get(s.id);
    if (every) timers.push(setInterval(() => void sync(s.kb), every * 1000));
  }
  const ready = Promise.all([...byKb.keys()].map((kb) => sync(kb))).then(() => undefined);
  return {
    ready,
    close() {
      closed = true;
      for (const w of watchers) w.close();
      for (const t of timers) clearInterval(t);
      for (const stop of stops) stop();
    },
  };
}

/** The DocumentSources lab.toml names, built for the kb command. */
export function sourcesFromConfig(configs: readonly DocumentSourceConfig[], drive: Omit<DriveDeps, "token">, env: NodeJS.ProcessEnv): DocumentSource[] {
  return configs.map((c) => {
    if (c.kind === "folder") return folderSource(c, drive.pdf);
    const token = env[c.tokenEnv];
    if (!token) throw new Error(`source ${c.id}: ${c.tokenEnv} is not set; it holds the ${c.kind === "graph" ? "Microsoft Graph" : "Drive OAuth"} access token`);
    return c.kind === "graph" ? graphSource(c, { ...drive, token }) : driveSource(c, { ...drive, token });
  });
}
