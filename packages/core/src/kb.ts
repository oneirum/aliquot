/**
 * Knowledge bases: immutable snapshots, and outline, read and search over them.
 * Compile (sources -> snapshot) lives in kb-compile.ts.
 *
 * A snapshot is a manifest: { path -> EntryHash } plus title, purpose,
 * sources, compiler, coverage and class. Entry bodies live in the payload
 * store under their own hash (an entry's hash is the payload hash of the
 * entry), so unchanged entries dedupe across snapshots and diff(a, b)
 * compares two maps.
 *
 * Invariants:
 * - Snapshots never change. SnapshotId = hash(manifest).
 * - snapshot.cls = join(source classes).
 * - Search is bm25-v1, owned here. Same snapshot + same query -> same hits, forever.
 *   Paths are taken in sorted order everywhere, so a snapshot read back from
 *   jsonb (which reorders keys) behaves exactly like the one that was written.
 * - The KB module does not write run events. The built-in tools in tools.ts
 *   call it and journal the returned entry hashes.
 */

import { z } from "zod";
import { DATA_CLASSES, Labelled, type DataClass } from "./dataclass.ts";
import type { Db } from "./db.ts";
import type { Addresser, EntryHash, PayloadHash, SnapshotId, Sha256 } from "./hash.ts";
import type { ModelTarget } from "./gateway.ts";
import type { PayloadStore } from "./record.ts";

export const SOURCE_KINDS = ["file", "url"] as const;
export const LICENCES = ["open", "internal-only", "copyrighted"] as const;

export interface SourceRef {
  readonly sourceId: string;
  readonly kind: (typeof SOURCE_KINDS)[number];
  /** A path relative to the KB definition file, or a URL. */
  readonly location: string;
  readonly cls: DataClass;
  readonly licence: (typeof LICENCES)[number];
  /** Keyed address of the source text as compiled, equal to its payload hash. */
  readonly contentHash: Sha256;
}

export interface Fact {
  readonly text: string;
  readonly sources: readonly { readonly sourceId: string; readonly locator: string }[];
}

export interface KbEntry {
  readonly path: string;
  readonly title: string;
  readonly body: string;
  readonly facts: readonly Fact[];
}

export type HashedEntry = KbEntry & { readonly hash: EntryHash };

export interface CoverageResult {
  readonly question: string;
  readonly answerable: boolean;
  /** Paths of the entries that support the answer. Empty when not answerable. */
  readonly entries: readonly string[];
}

export interface KbSnapshot {
  readonly id: SnapshotId;
  readonly kbId: string;
  readonly title: string;
  readonly cls: DataClass;
  readonly purpose: string;
  readonly entries: Readonly<Record<string, EntryHash>>;
  readonly sources: readonly SourceRef[];
  readonly compiler: { readonly target: ModelTarget; readonly promptHash: Sha256 } | null;
  readonly coverage: readonly CoverageResult[];
  readonly irbProtocol: string | null;
  readonly consentScope: string | null;
  readonly createdAt: string;
}

export interface Outline {
  readonly title: string;
  readonly purpose: string;
  readonly paths: readonly string[];
}

export interface ReadResult {
  readonly entries: readonly HashedEntry[];
  /** True when the cap cut entries. The agent is told, so it can read fewer paths. */
  readonly truncated: boolean;
  /** Paths that exist but did not fit under the cap. */
  readonly omitted: readonly string[];
  /** Paths the snapshot does not have. */
  readonly missing: readonly string[];
}

export interface SearchHit {
  readonly path: string;
  readonly hash: EntryHash;
  readonly title: string;
  readonly score: number;
}

/** Characters per token used for the read cap. Fixed so the cap is deterministic across models. */
export const CHARS_PER_TOKEN = 4;
export const DEFAULT_READ_CAP_TOKENS = 15_000;
/** The one search algorithm this reader serves. An agent pinned to another is unrunnable here. */
export const RETRIEVAL_ALGORITHM = "bm25-v1";

/** The deterministic size estimate the read cap counts. */
export function estimateTokens(entry: KbEntry): number {
  return Math.ceil((entry.title.length + entry.body.length) / CHARS_PER_TOKEN);
}

/** Equal to the payload hash of the same entry at the same class under the same key, so the manifest addresses the store directly. */
export function entryHash(address: Addresser, cls: DataClass, entry: KbEntry): EntryHash {
  return address(cls, entryValue(entry)) as string as EntryHash;
}

function entryValue(entry: KbEntry): KbEntry {
  return { path: entry.path, title: entry.title, body: entry.body, facts: entry.facts };
}

/** `cls` is the snapshot's: entries are stored at it, because the payload address commits to a class and the manifest names one. */
export function hashEntry(address: Addresser, cls: DataClass, entry: KbEntry): HashedEntry {
  const value = entryValue(entry);
  return { ...value, hash: entryHash(address, cls, value) };
}

/** The id is the keyed address of everything else in the manifest. */
export function snapshotId(address: Addresser, manifest: Omit<KbSnapshot, "id">): SnapshotId {
  return address(manifest.cls, manifest) as string as SnapshotId;
}

export interface LoadedSnapshot {
  readonly snapshot: KbSnapshot;
  /** Sorted by path. */
  readonly entries: readonly HashedEntry[];
}

function sortedEntries(entries: readonly HashedEntry[]): HashedEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const factSchema = z.object({ text: z.string(), sources: z.array(z.object({ sourceId: z.string(), locator: z.string() })) });

const fixtureSchema = z.object({
  kbId: z.string().min(1),
  title: z.string().min(1).optional(),
  purpose: z.string().min(1),
  cls: z.enum(DATA_CLASSES),
  createdAt: z.string().default("2026-01-01T00:00:00.000Z"),
  irbProtocol: z.string().optional(),
  consentScope: z.string().optional(),
  entries: z.array(z.object({ path: z.string().min(1), title: z.string().min(1), body: z.string(), facts: z.array(factSchema).default([]) })).min(1),
});

/** Boundary: a JSON fixture in, a hashed snapshot out. The same shape a compile produces, minus sources and compiler. */
export function snapshotFromFixture(json: unknown, address: Addresser): LoadedSnapshot {
  const f = fixtureSchema.parse(json);
  const entries = sortedEntries(f.entries.map((e) => hashEntry(address, f.cls, e)));
  const manifest: Omit<KbSnapshot, "id"> = {
    kbId: f.kbId,
    title: f.title ?? f.kbId,
    cls: f.cls,
    purpose: f.purpose,
    entries: Object.fromEntries(entries.map((e) => [e.path, e.hash])),
    sources: [],
    compiler: null,
    coverage: [],
    irbProtocol: f.irbProtocol ?? null,
    consentScope: f.consentScope ?? null,
    createdAt: f.createdAt,
  };
  return { snapshot: { id: snapshotId(address, manifest), ...manifest }, entries };
}

/** Where a reader finds snapshots. Fixtures in memory, or the database and payload store. */
export interface SnapshotSource {
  load(id: SnapshotId): Promise<LoadedSnapshot | undefined>;
  has(id: SnapshotId): Promise<boolean>;
}

export function memorySnapshots(loaded: readonly LoadedSnapshot[]): SnapshotSource {
  const byId = new Map(loaded.map((l) => [l.snapshot.id, l]));
  return { load: async (id) => byId.get(id), has: async (id) => byId.has(id) };
}

/** Tries each source in order. */
export function firstOf(...sources: readonly SnapshotSource[]): SnapshotSource {
  return {
    async load(id) {
      for (const s of sources) {
        const l = await s.load(id);
        if (l) return l;
      }
      return undefined;
    },
    async has(id) {
      for (const s of sources) if (await s.has(id)) return true;
      return false;
    },
  };
}

/**
 * Writes the manifest and every entry body. Idempotent: the snapshot row and
 * the payloads are keyed by content, so a second save of the same snapshot
 * changes nothing. Every entry is stored at the snapshot's class: the payload
 * address commits to a class, and the manifest records only the snapshot's.
 */
export async function saveSnapshot(db: Db, store: PayloadStore, snapshot: KbSnapshot, entries: readonly HashedEntry[]): Promise<void> {
  for (const entry of entries) {
    const ref = await store.put(Labelled.stamp(entryValue(entry), snapshot.cls, `kb:${snapshot.kbId}:entry`));
    if ((ref.hash as string) !== entry.hash) throw new Error(`entry ${entry.path} stored as ${ref.hash}, expected ${entry.hash}`);
  }
  const { id, ...manifest } = snapshot;
  if (snapshotId(store.address, manifest) !== id) throw new Error(`snapshot ${id} does not hash to its own id`);
  await db.query("insert into kb_snapshots (id, kb_id, cls, manifest) values ($1, $2, $3, $4) on conflict (id) do nothing", [id, snapshot.kbId, snapshot.cls, JSON.stringify(manifest)]);
}

/** Reads manifests from kb_snapshots and bodies from the payload store, checking every hash on the way in. */
export function storedSnapshots(db: Db, store: PayloadStore): SnapshotSource {
  return {
    async load(id) {
      const snapshot = await loadManifest(db, store.address, id);
      if (!snapshot) return undefined;
      const entries = await Promise.all(
        Object.entries(snapshot.entries).map(async ([path, hash]) => {
          const body = await store.get({ hash: hash as string as PayloadHash, cls: snapshot.cls, bytes: 0 });
          if ("redacted" in body) throw new Error(`entry ${path} of snapshot ${id} was redacted`);
          const entry = hashEntry(store.address, snapshot.cls, body.value as KbEntry);
          if (entry.hash !== hash || entry.path !== path) throw new Error(`entry ${path} of snapshot ${id} does not match its hash`);
          return entry;
        }),
      );
      return { snapshot, entries: sortedEntries(entries) };
    },
    has: async (id) => ((await db.query("select 1 from kb_snapshots where id = $1", [id])).rowCount ?? 0) > 0,
  };
}

export async function loadManifest(db: Db, address: Addresser, id: SnapshotId): Promise<KbSnapshot | undefined> {
  const row = await db.query<{ manifest: Omit<KbSnapshot, "id"> }>("select manifest from kb_snapshots where id = $1", [id]);
  const manifest = row.rows[0]?.manifest;
  if (!manifest) return undefined;
  if (snapshotId(address, manifest) !== id) throw new Error(`snapshot ${id} does not hash to its own id`);
  return { id, ...manifest };
}

/** The published snapshot of every knowledge base, from kb_heads. */
export async function publishedSnapshots(db: Db, address: Addresser): Promise<KbSnapshot[]> {
  const rows = await db.query<{ snapshot: SnapshotId }>("select snapshot from kb_heads order by kb_id");
  const out: KbSnapshot[] = [];
  for (const r of rows.rows) {
    const s = await loadManifest(db, address, r.snapshot);
    if (s) out.push(s);
  }
  return out;
}

export interface KbReader {
  has(snapshot: SnapshotId): Promise<boolean>;
  outline(snapshot: SnapshotId): Promise<Labelled<Outline>>;
  read(snapshot: SnapshotId, paths: readonly string[], capTokens: number): Promise<Labelled<ReadResult>>;
  search(snapshot: SnapshotId, query: string, k: number): Promise<Labelled<readonly SearchHit[]>>;
}

/** One loaded snapshot and one bm25 index per snapshot id, built on first use. No invalidation needed: snapshots are immutable. */
export function createKbReader(source: SnapshotSource): KbReader {
  const loaded = new Map<SnapshotId, Promise<LoadedSnapshot>>();
  const indexes = new Map<SnapshotId, Bm25Index>();
  const get = (id: SnapshotId): Promise<LoadedSnapshot> => {
    let l = loaded.get(id);
    if (!l) {
      l = source.load(id).then((s) => {
        if (!s) throw new Error(`snapshot ${id} is not loaded`);
        return s;
      });
      l.catch(() => loaded.delete(id));
      loaded.set(id, l);
    }
    return l;
  };
  const stamp = <T>(l: LoadedSnapshot, value: T) => Labelled.stamp(value, l.snapshot.cls, `kb:${l.snapshot.id}`);
  return {
    has: (id) => source.has(id),
    async outline(id) {
      const l = await get(id);
      return stamp(l, { title: l.snapshot.title, purpose: l.snapshot.purpose, paths: l.entries.map((e) => e.path) });
    },
    async read(id, paths, capTokens) {
      const l = await get(id);
      return stamp(l, readCapped(l.entries, paths, capTokens));
    },
    async search(id, query, k) {
      const l = await get(id);
      let index = indexes.get(id);
      if (!index) {
        index = buildBm25(l.entries);
        indexes.set(id, index);
      }
      return stamp(l, searchBm25(index, query, k));
    },
  };
}

/** Whole entries in the order asked, until the next one would pass the cap. Duplicate paths are read once. */
export function readCapped(entries: readonly HashedEntry[], paths: readonly string[], capTokens: number): ReadResult {
  const out: HashedEntry[] = [];
  const omitted: string[] = [];
  const missing: string[] = [];
  let used = 0;
  for (const path of new Set(paths)) {
    const entry = entries.find((e) => e.path === path);
    if (!entry) {
      missing.push(path);
      continue;
    }
    const size = estimateTokens(entry);
    if (omitted.length || used + size > capTokens) {
      omitted.push(path);
      continue;
    }
    out.push(entry);
    used += size;
  }
  return { entries: out, truncated: omitted.length > 0, omitted, missing };
}

/** bm25-v1: NFKC, lowercase, split on Unicode non-letters/digits, no stemming, k1 1.2, b 0.75, title weight 2.0. */
export interface Bm25Index {
  readonly algorithm: "bm25-v1";
  readonly docs: readonly { readonly entry: HashedEntry; readonly tf: ReadonlyMap<string, number>; readonly length: number }[];
  readonly df: ReadonlyMap<string, number>;
  readonly avgLength: number;
}

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 2.0;

export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

export function buildBm25(entries: readonly HashedEntry[]): Bm25Index {
  const df = new Map<string, number>();
  const docs = sortedEntries(entries).map((entry) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(entry.title)) tf.set(t, (tf.get(t) ?? 0) + TITLE_WEIGHT);
    for (const t of tokenize(entry.body)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let length = 0;
    for (const [term, n] of tf) {
      length += n;
      df.set(term, (df.get(term) ?? 0) + 1);
    }
    return { entry, tf, length };
  });
  const avgLength = docs.length ? docs.reduce((s, d) => s + d.length, 0) / docs.length : 0;
  return { algorithm: "bm25-v1", docs, df, avgLength };
}

export function searchBm25(index: Bm25Index, query: string, k: number): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  const n = index.docs.length;
  const scored = index.docs.map((d) => {
    let score = 0;
    for (const term of terms) {
      const tf = d.tf.get(term);
      if (!tf) continue;
      const df = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / (index.avgLength || 1)));
    }
    return { path: d.entry.path, hash: d.entry.hash, title: d.entry.title, score };
  });
  return scored
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, k)
    .map((h) => ({ ...h, score: Math.round(h.score * 1e6) / 1e6 }));
}

export interface SnapshotDiff {
  readonly kbId: string;
  readonly from: SnapshotId;
  readonly to: SnapshotId;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  /** Sources by id whose content hash, class or licence differs, or that exist on one side only. */
  readonly sources: readonly { readonly sourceId: string; readonly change: "added" | "removed" | "changed" }[];
}

export function diffSnapshots(a: KbSnapshot, b: KbSnapshot): SnapshotDiff {
  const added = Object.keys(b.entries).filter((p) => !(p in a.entries));
  const removed = Object.keys(a.entries).filter((p) => !(p in b.entries));
  const changed = Object.keys(a.entries).filter((p) => p in b.entries && a.entries[p] !== b.entries[p]);
  const before = new Map(a.sources.map((s) => [s.sourceId, s]));
  const after = new Map(b.sources.map((s) => [s.sourceId, s]));
  const sources: SnapshotDiff["sources"][number][] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const x = before.get(id);
    const y = after.get(id);
    if (!x) sources.push({ sourceId: id, change: "added" });
    else if (!y) sources.push({ sourceId: id, change: "removed" });
    else if (x.contentHash !== y.contentHash || x.cls !== y.cls || x.licence !== y.licence) sources.push({ sourceId: id, change: "changed" });
  }
  return { kbId: b.kbId, from: a.id, to: b.id, added: added.sort(), removed: removed.sort(), changed: changed.sort(), sources };
}

/** The diff as text a person reads: changed sources, then each entry with its changed lines. */
export function renderDiff(a: LoadedSnapshot, b: LoadedSnapshot): string {
  const d = diffSnapshots(a.snapshot, b.snapshot);
  const entryOf = (l: LoadedSnapshot, path: string) => l.entries.find((e) => e.path === path)!;
  const linesOf = (e: KbEntry) => [`# ${e.title}`, ...e.body.split("\n"), ...e.facts.map((f) => `fact: ${f.text} [${f.sources.map((s) => `${s.sourceId} ${s.locator}`).join("; ")}]`)];
  const out = [`kb ${d.kbId}: ${d.from.slice(0, 12)} -> ${d.to.slice(0, 12)}`];
  for (const s of d.sources) out.push(`source ${s.sourceId}: ${s.change}`);
  for (const p of d.added) out.push(`+ ${p}`, ...linesOf(entryOf(b, p)).map((l) => `    + ${l}`));
  for (const p of d.removed) out.push(`- ${p}`, ...linesOf(entryOf(a, p)).map((l) => `    - ${l}`));
  for (const p of d.changed) out.push(`~ ${p}`, ...lineDiff(linesOf(entryOf(a, p)), linesOf(entryOf(b, p))).map((l) => `    ${l}`));
  if (out.length === 1) out.push("no changes");
  return out.join("\n");
}

/** Changed lines only, by longest common subsequence. Entries are short, so the quadratic table is fine. */
export function lineDiff(a: readonly string[], b: readonly string[]): string[] {
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  return out;
}
