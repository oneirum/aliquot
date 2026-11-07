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
import { z } from "zod";
import type { DataClass } from "./dataclass.ts";
import { sha256, type Sha256 } from "./hash.ts";

export type ColumnClass = "free" | "restricted";

export type TableSource = { readonly kind: "csv"; readonly path: string } | { readonly kind: "redcap"; readonly url: string; readonly tokenEnv: string };

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
  z.object({ ok: z.literal(false), refusal: z.enum(["restricted-column", "missing-column", "not-numeric", "cell-size", "too-many-groups"]), column: z.string().optional() }).strict(),
]);

export type Group = z.infer<typeof groupOut>;

/** What a data_query call records as its output: enough for a reviewer to rerun it and compare. */
export interface QueryRecord {
  readonly table: string;
  readonly query: DataQuery;
  readonly source: { readonly kind: TableSource["kind"]; readonly sha256: Sha256; readonly bytes: number };
  readonly engine: { readonly sha256: Sha256; readonly image: Sha256 };
  readonly minCell: number;
  readonly rowsRead: number;
  readonly rowsMatched: number;
  readonly groups: readonly Group[];
}

export const ENGINE = readFileSync(new URL("./table-engine.py", import.meta.url), "utf8");
export const ENGINE_HASH = sha256(ENGINE);

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

/** One table's source, read in two steps so a query on a flagged column is refused before any record is requested. */
export interface TableReader {
  /** Columns the source itself flags as identifiers: REDCap's metadata export. None for a CSV. */
  identifiers(t: Table): Promise<readonly string[]>;
  /** The rows as CSV: the file, or REDCap's flat records export. */
  bytes(t: Table): Promise<Uint8Array>;
}

/** REDCap's metadata export, the part read here: which fields are flagged as identifiers. */
const redcapField = z.object({ field_name: z.string(), identifier: z.string().optional() }).loose();

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
    async identifiers(t) {
      if (t.source.kind === "csv") return [];
      const meta = z.array(redcapField).parse(JSON.parse(Buffer.from(await redcap(t, { content: "metadata", format: "json" })).toString("utf8")));
      return meta.filter((f) => f.identifier === "y").map((f) => f.field_name);
    },
    async bytes(t) {
      if (t.source.kind === "csv") return tooLarge(t, await readFile(t.source.path));
      return tooLarge(t, await redcap(t, { content: "record", format: "csv", type: "flat", rawOrLabel: "raw", rawOrLabelHeaders: "raw", exportCheckboxLabel: "false" }));
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
};

const small = (n: number, min: number) => n > 0 && n < min;

/**
 * Runs one query end to end: column check, read, engine in the sandbox, shape and cell check. Throws QueryRefused for
 * any refusal; nothing about the rows is in its message. Used by data_query and by a reviewer's rerun alike.
 */
export async function executeQuery(t: Table, q: DataQuery, deps: { readonly read: TableReader; readonly sandbox: TableSandbox; readonly signal: AbortSignal }): Promise<QueryRecord> {
  const declared = restrictedColumn(t, q);
  if (declared) throw new QueryRefused(REFUSALS["restricted-column"](t, declared));
  const identifiers = await deps.read.identifiers(t);
  const flagged = restrictedColumn(t, q, identifiers);
  if (flagged) throw new QueryRefused(`${REFUSALS["restricted-column"](t, flagged)} (the source flags it as an identifier)`);
  const bytes = await deps.read.bytes(t);
  const free = Object.entries(t.columns).filter(([c, cls]) => cls === "free" && !flaggedBy(c, identifiers)).map(([c]) => c);
  const envelope = JSON.stringify({ query: q, free, minCell: t.minCell, maxGroups: MAX_GROUPS });
  const run = await deps.sandbox.aggregate([{ name: "table.csv", data: bytes }, { name: "query.json", data: Buffer.from(envelope) }], ENGINE, deps.signal);
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
    engine: { sha256: ENGINE_HASH, image: deps.sandbox.image },
    minCell: t.minCell,
    rowsRead: parsed.rowsRead,
    rowsMatched: parsed.rowsMatched,
    groups: parsed.groups,
  };
}

/** A rerun matches when the source bytes, the engine and the numbers are the same. */
export function sameAnswer(a: QueryRecord, b: QueryRecord): { readonly same: boolean; readonly why: string | null } {
  if (a.source.sha256 !== b.source.sha256) return { same: false, why: `the source changed (${a.source.sha256.slice(0, 12)} then ${b.source.sha256.slice(0, 12)})` };
  if (a.engine.sha256 !== b.engine.sha256) return { same: false, why: "the query engine changed" };
  const numbers = (r: QueryRecord) => JSON.stringify({ rowsRead: r.rowsRead, rowsMatched: r.rowsMatched, groups: r.groups });
  return numbers(a) === numbers(b) ? { same: true, why: null } : { same: false, why: "the same source and engine gave different numbers" };
}
