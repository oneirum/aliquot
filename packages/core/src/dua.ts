/**
 * Data use agreements: data bound to the people an agreement names and the day it ends.
 *
 * NIH controlled-access data may go to no individual the Data Access Request does not name, and into no hosted
 * generative AI tool (NOT-OD-25-081); a campus's restricted data needs each recipient's authorization checked. A DUA
 * in lab.toml (`[duas.<id>]`) names its members by the member id every run records (unit 11's member.id under
 * [auth]), the last day it holds, the data class its data is in, and the knowledge bases, entries and datasets it
 * covers. Every read of a knowledge base and every dataset a run's tools see passes through access(): a member the
 * DUA does not name, a run with no member (a schedule, an eval, a replay), and everyone after the DUA expires get
 * nothing from it, and are told which DUA and which rule. A member it names reads its data at the DUA's class level,
 * so the egress decision keeps it off every endpoint that class may not reach.
 *
 * A DUA's class may not be one a hosted model reads: parseDuas refuses it, so no lab.toml can bind a DUA's data to a
 * hosted tier.
 */

import { z } from "zod";
import { join as joinClass, Labelled, type DataClass } from "./dataclass.ts";
import type { KbReader, Outline, ReadResult, SearchHit } from "./kb.ts";
import type { SnapshotId } from "./hash.ts";
import type { Dataset } from "./config.ts";
import type { Policy } from "./policy.ts";
import type { StoredEvent } from "./record.ts";

export interface Dua {
  readonly id: string;
  /** Member ids, exactly as runs record them. */
  readonly members: readonly string[];
  /** YYYY-MM-DD, the last day (UTC) the agreement holds. From the next day it refuses everyone. */
  readonly expires: string;
  readonly classId: string;
  readonly level: DataClass;
  /** True for a class whose model_tier is none: no model reads the DUA's data, named member or not. */
  readonly noModel: boolean;
  /** Knowledge base ids whose every entry the DUA covers. */
  readonly knowledgeBases: readonly string[];
  /** Single entries, as kbId and path. */
  readonly entries: readonly { readonly kbId: string; readonly path: string }[];
  readonly datasets: readonly string[];
}

export type DuaRule = "expired" | "no-model" | "no-member" | "not-named";

export interface DuaRefusal {
  readonly dua: string;
  readonly rule: DuaRule;
  /** One sentence naming the DUA and the rule, for the model, the member and the record. Never names a member. */
  readonly reason: string;
}

export type Admission = { readonly t: "open" } | { readonly t: "admitted"; readonly dua: Dua } | { readonly t: "refused"; readonly refusal: DuaRefusal };

const DUA_ID = /^[a-z0-9][a-z0-9_-]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const declared = z
  .object({
    members: z.array(z.string().min(1)).min(1, "names no member: a DUA binds its data to the people it names"),
    expires: z.union([z.string().regex(DAY, "is a date, YYYY-MM-DD"), z.date()]),
    class: z.string().min(1),
    knowledge_bases: z.array(z.string().min(1)).default([]),
    entries: z.array(z.string().regex(/^[^/]+\/.+$/, "is <kbId>/<path>")).default([]),
    datasets: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** A TOML local date parses to a Date at midnight UTC; a string must already be the day. */
function dayOf(v: string | Date): string {
  return typeof v === "string" ? v : v.toISOString().slice(0, 10);
}

/** [duas.<id>] tables to DUAs, checked against the lab's classes and datasets. Throws a lab.toml line on any fault. */
export function parseDuas(tables: Record<string, unknown>, policy: Policy, datasets: readonly Dataset[]): Dua[] {
  const covered = new Map<string, string>();
  const claim = (what: string, id: string) => {
    const first = covered.get(what);
    if (first) throw new Error(`lab.toml: [duas.${id}] covers ${what}, which [duas.${first}] already covers; one item is bound by one DUA`);
    covered.set(what, id);
  };
  return Object.entries(tables).map(([id, raw]) => {
    const fail = (why: string): never => {
      throw new Error(`lab.toml: [duas.${id}] ${why}`);
    };
    if (!DUA_ID.test(id)) fail("is not a DUA id: lowercase letters, digits, _ and -");
    const parsed = declared.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return fail(`${issue.path.join(".") || "table"} ${issue.message}`);
    }
    const d = parsed.data;
    const cls = policy.classes.find((c) => c.id === d.class) ?? fail(`class = "${d.class}" is not a data class; name one of ${policy.classes.map((c) => c.id).join(", ")}`);
    if (cls.modelTier === "hosted")
      fail(`class = "${cls.id}" is one a hosted model may read (model_tier = "hosted"), and a DUA's data goes to no hosted model (NIH NOT-OD-25-081); give it a class whose model_tier is "local" or "none"`);
    if (!d.knowledge_bases.length && !d.entries.length && !d.datasets.length) fail("covers nothing: list its knowledge_bases, entries or datasets");
    for (const ds of d.datasets) {
      const found = datasets.find((x) => x.id === ds) ?? fail(`datasets names ${ds}, which is not a [datasets] id`);
      if (found.cls !== joinClass(found.cls, cls.level)) fail(`binds dataset ${ds} at ${found.cls}, under its class ${cls.id} at ${cls.level}; declare [datasets.${ds}] class = "${cls.level}"`);
      claim(`dataset ${ds}`, id);
    }
    for (const kb of d.knowledge_bases) claim(`knowledge base ${kb}`, id);
    const entries = d.entries.map((e) => {
      const at = e.indexOf("/");
      return { kbId: e.slice(0, at), path: e.slice(at + 1) };
    });
    for (const e of entries) {
      if (d.knowledge_bases.includes(e.kbId) || covered.has(`knowledge base ${e.kbId}`)) fail(`entries names ${e.kbId}/${e.path}, whose whole knowledge base a DUA already covers`);
      claim(`entry ${e.kbId}/${e.path}`, id);
    }
    return { id, members: d.members, expires: dayOf(d.expires), classId: cls.id, level: cls.level, noModel: cls.modelTier === "none", knowledgeBases: d.knowledge_bases, entries, datasets: d.datasets };
  });
}

/** The UTC day of a clock reading, YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The member a run is for: the member id its trigger recorded, or null for a run no member started. */
export function memberOf(events: readonly StoredEvent[]): string | null {
  const started = events.find((e) => e.event.t === "run.started")?.event;
  if (started?.t !== "run.started") return null;
  return "memberId" in started.trigger ? started.trigger.memberId : null;
}

/** Why dua refuses member today, or null when it admits them. Expiry first: it refuses everyone. */
export function duaRefusal(dua: Dua, member: string | null, today: string): DuaRefusal | null {
  const r = (rule: DuaRule, reason: string): DuaRefusal => ({ dua: dua.id, rule, reason });
  if (today > dua.expires) return r("expired", `DUA ${dua.id} expired on ${dua.expires}; rule: no one reads its data after [duas.${dua.id}] expires, until the lab records a renewal`);
  if (dua.noModel) return r("no-model", `DUA ${dua.id} is in data class ${dua.classId}, whose model_tier = "none"; rule: no model reads its data, for any member`);
  if (member === null) return r("no-member", `DUA ${dua.id} binds its data to the members it names, and this run has no member (a schedule, an eval or a replay); rule: only a member [duas.${dua.id}] members names reads its data`);
  if (!dua.members.includes(member)) return r("not-named", `DUA ${dua.id} does not name the member who asked; rule: only the members [duas.${dua.id}] members names read its data`);
  return null;
}

export interface DuaAccess {
  entry(kbId: string, path: string): Admission;
  dataset(id: string): Admission;
}

/** What one run's member may see of the DUA-bound data today. */
export function duaAccess(duas: readonly Dua[], member: string | null, today: string): DuaAccess {
  const admit = (dua: Dua | undefined): Admission => {
    if (!dua) return { t: "open" };
    const refusal = duaRefusal(dua, member, today);
    return refusal ? { t: "refused", refusal } : { t: "admitted", dua };
  };
  return {
    entry: (kbId, path) => admit(duas.find((d) => d.knowledgeBases.includes(kbId) || d.entries.some((e) => e.kbId === kbId && e.path === path))),
    dataset: (id) => admit(duas.find((d) => d.datasets.includes(id))),
  };
}

/** A refusal as the tool that met it reports it: which item, when the model itself named it. */
export interface Withheld {
  readonly kbId: string;
  readonly path: string;
  readonly refusal: DuaRefusal;
}

/**
 * A KbReader that shows a run only what its member may see: refused entries leave the outline, the search hits and
 * the reads, and each refusal is pushed to `withheld`. A result holding an admitted DUA entry is raised to the DUA's
 * class level. kbOf names the knowledge base of each snapshot the run may read.
 */
export function scopeKb(kb: KbReader, kbOf: (snapshot: SnapshotId) => string | undefined, access: DuaAccess, withheld: Withheld[]): KbReader {
  const judge = (snapshot: SnapshotId, path: string): Admission => {
    const kbId = kbOf(snapshot);
    return kbId === undefined ? { t: "open" } : access.entry(kbId, path);
  };
  const levelOf = (snapshot: SnapshotId, paths: readonly string[]): DataClass => joinClass(...paths.map((p) => judge(snapshot, p)).flatMap((a) => (a.t === "admitted" ? [a.dua.level] : [])));
  const refusedOf = (snapshot: SnapshotId, paths: readonly string[]) => paths.flatMap((path) => {
    const a = judge(snapshot, path);
    return a.t === "refused" ? [{ kbId: kbOf(snapshot)!, path, refusal: a.refusal }] : [];
  });
  /** Rebuild only when something changed, so a run with no DUA in play reads exactly what it read before. */
  const scoped = <T>(orig: Labelled<T>, value: T, changed: boolean, floor: DataClass, snapshot: SnapshotId): Labelled<T> =>
    changed || floor !== "D0" ? Labelled.derive(value, [orig], `dua:${kbOf(snapshot) ?? snapshot}`, floor) : orig;
  return {
    has: (snapshot) => kb.has(snapshot),
    async outline(snapshot) {
      const o = await kb.outline(snapshot);
      const refused = new Set(refusedOf(snapshot, o.value.paths).map((w) => w.path));
      const paths = o.value.paths.filter((p) => !refused.has(p));
      return scoped<Outline>(o, { ...o.value, paths }, refused.size > 0, levelOf(snapshot, paths), snapshot);
    },
    async search(snapshot, query, k) {
      // Ask for enough hits that the k best open ones survive the filter, and count only refusals in the unfiltered top k.
      const all = (await kb.outline(snapshot)).value.paths;
      const extra = refusedOf(snapshot, all).length;
      const hits = await kb.search(snapshot, query, k + extra);
      const refused = refusedOf(snapshot, hits.value.slice(0, k).map((h) => h.path));
      withheld.push(...refused);
      const shown = hits.value.filter((h) => judge(snapshot, h.path).t !== "refused").slice(0, k);
      return scoped<readonly SearchHit[]>(hits, shown, extra > 0, levelOf(snapshot, shown.map((h) => h.path)), snapshot);
    },
    async read(snapshot, paths, cap) {
      const refused = refusedOf(snapshot, [...new Set(paths)]);
      withheld.push(...refused);
      const gone = new Set(refused.map((w) => w.path));
      const r = await kb.read(snapshot, paths.filter((p) => !gone.has(p)), cap);
      return scoped<ReadResult>(r, r.value, gone.size > 0, levelOf(snapshot, r.value.entries.map((e) => e.path)), snapshot);
    },
  };
}
