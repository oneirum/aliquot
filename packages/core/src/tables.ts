/**
 * Tabular sources: a CSV or a REDCap project the lab registers in lab.toml
 * as [tables.<id>], and data_query's path over them. The model writes a
 * structured query; the harness checks every column it names against the
 * table's classification before reading a byte; the rows go into a sandbox
 * container with no network, where table-engine.py computes the aggregate
 * and refuses any cell under the minimum size; the harness parses what comes
 * back against a fixed shape and checks the cells again. Rows and restricted
 * columns never enter the run, so they never reach a model.
 *
 * What enters the run is the aggregate, stamped at the table's
 * aggregate_class: the class the data steward declared for counts and means
 * over the free columns. That is a new origin, like a knowledge base
 * snapshot, not a lowered label on the rows.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DataClass } from "./dataclass.ts";
import { sha256, type Sha256 } from "./hash.ts";

export type ColumnClass = "free" | "restricted";

/**
 * A REDCap project answers each member with that member's own REDCap rights: `users` maps a member id to the REDCap
 * username whose export rights and Data Access Group apply. A member it does not name is refused.
 */
export type TableSource =
  | { readonly kind: "csv"; readonly path: string }
  | { readonly kind: "redcap"; readonly url: string; readonly tokenEnv: string; readonly users: Readonly<Record<string, string>> };

export interface Table {
  readonly id: string;
  readonly description: string;
  readonly source: TableSource;
  /** Declared columns. A column the table has and this map does not name is restricted. */
  readonly columns: Readonly<Record<string, ColumnClass>>;
  /** The class an aggregate that passed every check enters the run at. */
  readonly aggregateClass: DataClass;
  /** The smallest group, and the smallest count of values behind a mean or sum, that may leave the sandbox. At least MIN_CELL. */
  readonly minCell: number;
}

/** The floor for min_cell. A lab may raise it in lab.toml, never lower it. */
export const MIN_CELL = 5;
export const MAX_GROUPS = 50;
/** A table larger than this is refused before a container is made. */
export const TABLE_CAP_BYTES = 50 * 1024 * 1024;

const column = z.string().min(1).max(100);
const cell = z.union([z.string().max(200), z.number().finite()]);

export const whereClause = z.union([
  z.object({ column, op: z.enum(["eq", "ne"]), value: cell }).strict(),
  z.object({ column, op: z.literal("in"), value: z.array(cell).min(1).max(50) }).strict(),
  z.object({ column, op: z.enum(["lt", "le", "gt", "ge"]), value: z.number().finite() }).strict(),
  z.object({ column, op: z.enum(["present", "absent"]) }).strict(),
]);

export const measure = z.union([z.object({ fn: z.literal("count"), column: column.optional() }).strict(), z.object({ fn: z.enum(["mean", "sum", "sd"]), column }).strict()]);

/**
 * No min, max or median: each can be one participant's own value. No row listing of any kind.
 */
export const dataQuery = z
  .object({
    table: z.string().min(1).describe("A table id from the agent's tables"),
    where: z.array(whereClause).max(10).default([]).describe("Every clause must hold. eq, ne and in compare text, or numbers when the value is a number"),
    groupBy: z.array(column).max(3).default([]).describe("Free columns to group by"),
    measures: z.array(measure).min(1).max(8).describe("count with no column counts rows; count with a column counts its non-blank values"),
  })
  .strict();
export type DataQuery = z.infer<typeof dataQuery>;

export const measureName = (m: z.infer<typeof measure>): string => `${m.fn}(${m.column ?? "*"})`;

export function columnsOf(q: DataQuery): string[] {
  return [...new Set([...q.where.map((w) => w.column), ...q.groupBy, ...q.measures.flatMap((m) => (m.column ? [m.column] : []))])];
}

/** The first column the query names that is not free, or null. `identifiers` are the source's own identifier flags (REDCap's metadata). */
export function restrictedColumn(t: Table, q: DataQuery, identifiers: readonly string[] = []): string | null {
  return columnsOf(q).find((c) => t.columns[c] !== "free" || flaggedBy(c, identifiers)) ?? null;
}

/** REDCap exports a checkbox field as one column per choice, field___1 and so on, and flags only the field. */
const flaggedBy = (column: string, identifiers: readonly string[]) => identifiers.some((f) => column === f || column.startsWith(`${f}___`));

const groupOut = z.object({ key: z.record(z.string(), z.string().max(200)), n: z.number().int().min(0), values: z.record(z.string(), z.number().finite().nullable()) }).strict();

const engineOut = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), rowsRead: z.number().int().min(0), rowsMatched: z.number().int().min(0), groups: z.array(groupOut).max(MAX_GROUPS) }).strict(),
  z.object({ ok: z.literal(false), refusal: z.enum(["restricted-column", "missing-column", "not-numeric", "cell-size", "too-many-groups", "missing-scope"]), column: z.string().optional() }).strict(),
]);

export type Group = z.infer<typeof groupOut>;

/**
 * REDCap's export rights, per form: 0 no access, 1 full data set, 2 de-identified (no identifier fields, dates,
 * unvalidated text or notes), 3 every identifier field removed.
 */
export type ExportLevel = "none" | "full" | "de-identified" | "no-identifiers";
const LEVELS: Readonly<Record<string, ExportLevel>> = { "0": "none", "1": "full", "2": "de-identified", "3": "no-identifiers" };

/** The REDCap rights a query ran under, as the record keeps them. */
export interface AppliedRights {
  readonly member: string;
  readonly redcapUser: string;
  /** The user's Data Access Group (its unique name), or null for a user in none, who sees every record. */
  readonly dag: string | null;
  readonly forms: Readonly<Record<string, ExportLevel>>;
}

/** The column a records export carries each record's DAG in, with exportDataAccessGroups=true. */
export const DAG_COLUMN = "redcap_data_access_group";

/** What a data_query call records as its output: enough for a reviewer to rerun it and compare. */
export interface QueryRecord {
  readonly table: string;
  readonly query: DataQuery;
  readonly source: { readonly kind: TableSource["kind"]; readonly sha256: Sha256; readonly bytes: number };
  readonly engine: { readonly sha256: Sha256; readonly image: Sha256 };
  readonly minCell: number;
  /** The REDCap rights applied, or null for a CSV. */
  readonly rights: AppliedRights | null;
  readonly rowsRead: number;
  readonly rowsMatched: number;
  readonly groups: readonly Group[];
}

let engineMemo: { readonly source: string; readonly sha256: Sha256 } | null = null;

/** Read at the first query, not at import: the studio's bundle loads this module through config.ts and has no engine file. */
export function engine(): { readonly source: string; readonly sha256: Sha256 } {
  if (!engineMemo) {
    const source = readFileSync(fileURLToPath(new URL("./table-engine.py", import.meta.url)), "utf8");
    engineMemo = { source, sha256: sha256(source) };
  }
  return engineMemo;
}

/** A refusal the agent sees. Its text names columns and rules, never a value or a cell's size. */
export class QueryRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryRefused";
  }
}

/** POST with a form body, through the run's egress check. */
export type FormPost = (url: string, form: Readonly<Record<string, string>>) => Promise<Response>;

export interface TableReaderDeps {
  readonly post: FormPost;
  readonly secret: (env: string) => string | undefined;
}

/** A field of a REDCap project's data dictionary, as far as export rights need it. */
export interface Field {
  readonly name: string;
  readonly form: string;
  readonly identifier: boolean;
  /** A date, an unvalidated text field or a notes field: what a de-identified export leaves out besides identifiers. */
  readonly deidentified: boolean;
}

/** A REDCap user's row in the project's user export, the part read here. */
export interface RedcapUserRights {
  readonly username: string;
  readonly expiration: string;
  readonly dataAccessGroup: string;
  readonly forms: Readonly<Record<string, ExportLevel>> | null;
  readonly dataExport: ExportLevel;
}

/** What a records export asks REDCap for: these fields only, and each record's DAG when the user has one. */
export interface RecordsRequest {
  readonly fields: readonly string[];
  readonly dags: boolean;
}

/** One table's source, read in steps so a query is refused on the dictionary or the member's rights before any record is requested. */
export interface TableReader {
  /** REDCap's data dictionary: the metadata export. None for a CSV. */
  dictionary(t: Table): Promise<readonly Field[]>;
  /** The REDCap user's rights in the project, from the user export, or null when the project has no such user. */
  user(t: Table, username: string): Promise<RedcapUserRights | null>;
  /** The rows as CSV: the file, or REDCap's flat records export of the fields asked for. */
  bytes(t: Table, request?: RecordsRequest): Promise<Uint8Array>;
}

/** REDCap's metadata export, the part read here. */
const redcapField = z.object({ field_name: z.string(), form_name: z.string(), field_type: z.string(), identifier: z.string().optional(), text_validation_type_or_show_slider_number: z.string().optional() }).loose();
const level = z.union([z.string(), z.number()]).transform((v) => LEVELS[String(v)] ?? "none");
/** forms_export is an object in REDCap's JSON user export, and "form:level,form:level" in some versions. */
const formsExport = z.union([z.record(z.string(), level), z.string().transform((s) => Object.fromEntries(s.split(",").filter(Boolean).map((p) => [p.split(":")[0]!, LEVELS[p.split(":")[1] ?? ""] ?? "none"])))]);
const redcapUser = z.object({ username: z.string(), expiration: z.string().nullish(), data_access_group: z.string().nullish(), data_export: level.optional(), forms_export: formsExport.nullish() }).loose();

const deidentifiedOut = (f: z.infer<typeof redcapField>): boolean => {
  const v = f.text_validation_type_or_show_slider_number ?? "";
  return f.field_type === "notes" || (f.field_type === "text" && (v === "" || /^(date|datetime|time)/.test(v)));
};

const tooLarge = (t: Table, bytes: Uint8Array) => {
  if (bytes.length > TABLE_CAP_BYTES) throw new QueryRefused(`table ${t.id} is over the ${TABLE_CAP_BYTES / 1024 / 1024} MB limit`);
  return bytes;
};

export function tableReader(deps: TableReaderDeps): TableReader {
  const redcap = async (t: Table, form: Record<string, string>): Promise<Uint8Array> => {
    if (t.source.kind !== "redcap") throw new Error(`table ${t.id} is not a REDCap project`);
    const token = deps.secret(t.source.tokenEnv);
    if (!token) throw new Error(`table ${t.id}: ${t.source.tokenEnv} is not set`);
    const res = await deps.post(t.source.url, { token, ...form, returnFormat: "json" });
    if (!res.ok) throw new Error(`table ${t.id}: REDCap answered ${res.status} to the ${form.content} export`);
    return new Uint8Array(await res.arrayBuffer());
  };
  return {
    async dictionary(t) {
      if (t.source.kind === "csv") return [];
      const meta = z.array(redcapField).parse(JSON.parse(Buffer.from(await redcap(t, { content: "metadata", format: "json" })).toString("utf8")));
      return meta.map((f) => ({ name: f.field_name, form: f.form_name, identifier: f.identifier === "y", deidentified: deidentifiedOut(f) }));
    },
    async user(t, username) {
      const users = z.array(redcapUser).parse(JSON.parse(Buffer.from(await redcap(t, { content: "user", format: "json" })).toString("utf8")));
      const u = users.find((x) => x.username === username);
      return u ? { username, expiration: u.expiration ?? "", dataAccessGroup: u.data_access_group ?? "", forms: u.forms_export ?? null, dataExport: u.data_export ?? "none" } : null;
    },
    async bytes(t, request) {
      if (t.source.kind === "csv") return tooLarge(t, await readFile(t.source.path));
      if (!request) throw new Error(`table ${t.id}: a REDCap records export names the fields it asks for`);
      const fields = Object.fromEntries(request.fields.map((f, i) => [`fields[${i}]`, f]));
      return tooLarge(t, await redcap(t, { content: "record", format: "csv", type: "flat", rawOrLabel: "raw", rawOrLabelHeaders: "raw", exportCheckboxLabel: "false", exportDataAccessGroups: String(request.dags), ...fields }));
    },
  };
}

/** The container run data_query needs: the engine over two uploaded files, stdout back. */
export interface TableSandbox {
  readonly image: Sha256;
  aggregate(files: readonly { readonly name: string; readonly data: Uint8Array }[], engine: string, signal: AbortSignal): Promise<{ readonly exitCode: number | null; readonly timedOut: boolean; readonly stdout: string }>;
}

const REFUSALS: Record<Exclude<z.infer<typeof engineOut>, { ok: true }>["refusal"], (t: Table, column: string | undefined) => string> = {
  "restricted-column": (t, c) => `column ${c} of table ${t.id} is restricted; it never leaves the sandbox`,
  "missing-column": (t, c) => `table ${t.id} has no column ${c}`,
  "not-numeric": (t, c) => `column ${c} of table ${t.id} holds a value that is not a number`,
  "cell-size": (t) => `a group, or the values behind a measure, has fewer than ${t.minCell} rows; widen the groups or drop a filter`,
  "too-many-groups": () => `the query makes more than ${MAX_GROUPS} groups; group by fewer columns`,
  "missing-scope": (t) => `REDCap's export of table ${t.id} has no ${DAG_COLUMN} column, so the member's Data Access Group cannot be applied`,
};

const small = (n: number, min: number) => n > 0 && n < min;

/** The REDCap field a column comes from: a checkbox field's columns are field___1 and on. */
const fieldOf = (column: string) => column.replace(/___[^_]+$/, "");

/**
 * The member's REDCap rights over the columns a query names, or a refusal. A run with no member, a member the table
 * does not map, a username the project does not have, an expired user, and a column on a form the user may not export
 * or that their de-identified export leaves out are each refused before any record is requested.
 */
async function rightsFor(t: Table, q: DataQuery, dictionary: readonly Field[], read: TableReader, member: string | null, today: string): Promise<{ readonly rights: AppliedRights; readonly fields: string[] }> {
  if (t.source.kind !== "redcap") throw new Error("unreachable");
  const where = `[tables.${t.id}.redcap_users]`;
  if (member === null) throw new QueryRefused(`table ${t.id} is a REDCap project, which answers each member under their own REDCap rights, and this run has no member (a schedule, an eval or a replay)`);
  const username = Object.hasOwn(t.source.users, member) ? t.source.users[member] : undefined;
  if (username === undefined) throw new QueryRefused(`table ${t.id} is a REDCap project, and ${where} maps no REDCap user for the member who asked; rule: a member queries REDCap only under their own REDCap account`);
  const user = await read.user(t, username);
  if (!user) throw new QueryRefused(`table ${t.id}: the member's REDCap user is not a user of the project`);
  if (user.expiration !== "" && today > user.expiration) throw new QueryRefused(`table ${t.id}: the member's REDCap access to the project expired on ${user.expiration}`);
  const forms = Object.fromEntries([...new Set(dictionary.map((f) => f.form))].map((form) => [form, user.forms?.[form] ?? (user.forms ? "none" : user.dataExport)]));
  const fields: string[] = [];
  for (const column of columnsOf(q)) {
    const f = dictionary.find((x) => x.name === column) ?? dictionary.find((x) => x.name === fieldOf(column));
    if (!f) throw new QueryRefused(REFUSALS["missing-column"](t, column));
    const lvl = forms[f.form] ?? "none";
    if (lvl === "none") throw new QueryRefused(`column ${column} of table ${t.id} is on REDCap form ${f.form}, which the member's REDCap export rights do not reach`);
    if (lvl === "de-identified" && f.deidentified) throw new QueryRefused(`column ${column} of table ${t.id} is a date or free-text field, which the member's de-identified REDCap export rights leave out`);
    if (!fields.includes(f.name)) fields.push(f.name);
  }
  const recordId = dictionary[0]?.name;
  return {
    rights: { member, redcapUser: username, dag: user.dataAccessGroup === "" ? null : user.dataAccessGroup, forms },
    fields: recordId && !fields.includes(recordId) ? [recordId, ...fields] : fields,
  };
}

/**
 * Runs one query end to end: column check, read, engine in the sandbox, shape and cell check. Throws QueryRefused for
 * any refusal; nothing about the rows is in its message. Used by data_query and by a reviewer's rerun alike.
 */
export interface QueryDeps {
  readonly read: TableReader;
  readonly sandbox: TableSandbox;
  readonly signal: AbortSignal;
  /** The member the run is for, whose REDCap rights a REDCap table applies; null for a run no member started. */
  readonly member: string | null;
  /** Today's UTC day, YYYY-MM-DD, against a REDCap user's expiration. */
  readonly today: string;
}

export async function executeQuery(t: Table, q: DataQuery, deps: QueryDeps): Promise<QueryRecord> {
  const declared = restrictedColumn(t, q);
  if (declared) throw new QueryRefused(REFUSALS["restricted-column"](t, declared));
  const dictionary = await deps.read.dictionary(t);
  const identifiers = dictionary.filter((f) => f.identifier).map((f) => f.name);
  const flagged = restrictedColumn(t, q, identifiers);
  if (flagged) throw new QueryRefused(`${REFUSALS["restricted-column"](t, flagged)} (the source flags it as an identifier)`);
  const granted = t.source.kind === "redcap" ? await rightsFor(t, q, dictionary, deps.read, deps.member, deps.today) : null;
  const bytes = await deps.read.bytes(t, granted ? { fields: granted.fields, dags: granted.rights.dag !== null } : undefined);
  const free = Object.entries(t.columns).filter(([c, cls]) => cls === "free" && !flaggedBy(c, identifiers)).map(([c]) => c);
  // A user in a DAG sees only its records: the engine drops every other row before it counts anything.
  const scope = granted?.rights.dag ? { column: DAG_COLUMN, value: granted.rights.dag } : null;
  const envelope = JSON.stringify({ query: q, free, minCell: t.minCell, maxGroups: MAX_GROUPS, scope });
  const run = await deps.sandbox.aggregate([{ name: "table.csv", data: bytes }, { name: "query.json", data: Buffer.from(envelope) }], engine().source, deps.signal);
  if (run.timedOut) throw new Error(`table ${t.id}: the query took longer than the sandbox's timeout`);
  // stderr is never read: a traceback quotes the line it failed on, and that line can hold a row.
  if (run.exitCode !== 0) throw new Error(`table ${t.id}: the query engine exited with ${run.exitCode}`);
  let parsed: z.infer<typeof engineOut>;
  try {
    parsed = engineOut.parse(JSON.parse(run.stdout));
  } catch {
    throw new Error(`table ${t.id}: the query engine's output is not an aggregate`);
  }
  if (!parsed.ok) {
    const c = parsed.column !== undefined && columnsOf(q).includes(parsed.column) ? parsed.column : undefined;
    throw new QueryRefused(REFUSALS[parsed.refusal](t, c));
  }
  const names = q.measures.map(measureName);
  for (const g of parsed.groups) {
    const shapeOk = Object.keys(g.key).sort().join() === [...q.groupBy].sort().join() && Object.keys(g.values).sort().join() === [...names].sort().join();
    if (!shapeOk) throw new Error(`table ${t.id}: the query engine's output does not match the query`);
    if (small(g.n, t.minCell) || q.measures.some((m) => m.fn === "count" && small(g.values[measureName(m)] ?? 0, t.minCell))) throw new QueryRefused(REFUSALS["cell-size"](t, undefined));
  }
  if (small(parsed.rowsMatched, t.minCell)) throw new QueryRefused(REFUSALS["cell-size"](t, undefined));
  return {
    table: t.id,
    query: q,
    source: { kind: t.source.kind, sha256: sha256(bytes), bytes: bytes.length },
    engine: { sha256: engine().sha256, image: deps.sandbox.image },
    minCell: t.minCell,
    rights: granted?.rights ?? null,
    rowsRead: parsed.rowsRead,
    rowsMatched: parsed.rowsMatched,
    groups: parsed.groups,
  };
}

/** Rights compared by value: a record read back from the store's jsonb has its forms in another key order. */
const rightsKey = (r: AppliedRights | null) => (r ? JSON.stringify([r.member, r.redcapUser, r.dag, Object.entries(r.forms).sort(([x], [y]) => x.localeCompare(y))]) : "null");

/** A rerun matches when the rights, the source bytes, the engine and the numbers are the same. */
export function sameAnswer(a: QueryRecord, b: QueryRecord): { readonly same: boolean; readonly why: string | null } {
  if (rightsKey(a.rights) !== rightsKey(b.rights)) return { same: false, why: "the member's REDCap rights changed" };
  if (a.source.sha256 !== b.source.sha256) return { same: false, why: `the source changed (${a.source.sha256.slice(0, 12)} then ${b.source.sha256.slice(0, 12)})` };
  if (a.engine.sha256 !== b.engine.sha256) return { same: false, why: "the query engine changed" };
  const numbers = (r: QueryRecord) => JSON.stringify({ rowsRead: r.rowsRead, rowsMatched: r.rowsMatched, groups: r.groups });
  return numbers(a) === numbers(b) ? { same: true, why: null } : { same: false, why: "the same source and engine gave different numbers" };
}
