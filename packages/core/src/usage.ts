/**
 * Usage priced from the run record. A federal award may pay for a computing
 * service only when it is charged on actual usage at a schedule of rates
 * (2 CFR 200.468), so every number here comes from the record's own events:
 * tokens from model.completed, the endpoint and model from the model.requested
 * of the same step and attempt, the member and project from run.started, and
 * the price in force at the call's time from lab.toml's [prices]. Nothing is
 * stored beside the record.
 *
 * Money is exact: a price is held in millionths of a currency unit per
 * million tokens, so tokens x price is an integer in 1e-12 units, summed as
 * a bigint and rounded once, half up, when a total is printed.
 */

import type { StoredEvent } from "./record.ts";

/** One rate, in force from effective (00:00 UTC) until the next rate for the same key. */
export interface Price {
  readonly effective: string;
  readonly currency: string;
  /** Millionths of a currency unit per million tokens. */
  readonly inputMicro: bigint;
  readonly outputMicro: bigint;
}

/** Key: a model id or an endpoint id. Rates per key, oldest first. */
export type PriceBook = ReadonlyMap<string, readonly Price[]>;
export const NO_PRICES: PriceBook = new Map();

/** One model call as the record holds it. */
export interface UsageCall {
  readonly runId: string;
  readonly at: string;
  readonly agent: string;
  readonly project: string | null;
  /** The member id on the run's trigger: the [auth] id_claim under sign-on, else the member id the surface sent. Null for a run no member asked. */
  readonly member: string | null;
  readonly endpoint: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
}

/** The rate for a call: the model id's rates first, else the endpoint's; the latest whose effective date is not after the call. */
export function priceAt(book: PriceBook, endpoint: string, model: string, at: string): Price | null {
  const rates = book.get(model) ?? book.get(endpoint);
  if (!rates) return null;
  let found: Price | null = null;
  for (const r of rates) if (Date.parse(`${r.effective}T00:00:00Z`) <= Date.parse(at)) found = r;
  return found;
}

/** Every model call in one run's events, in record order. */
export function callsOf(events: readonly StoredEvent[]): UsageCall[] {
  const started = events.find((e) => e.event.t === "run.started")?.event;
  if (started?.t !== "run.started") return [];
  const member = "memberId" in started.trigger ? started.trigger.memberId : null;
  const targets = new Map<string, { endpoint: string; model: string }>();
  const calls: UsageCall[] = [];
  for (const { event: e, at, runId } of events) {
    if (e.t === "model.requested") targets.set(`${e.step}:${e.attempt}`, { endpoint: e.target.endpointId, model: e.target.modelId });
    else if (e.t === "model.completed") {
      const target = targets.get(`${e.step}:${e.attempt}`) ?? { endpoint: "(unknown)", model: e.providerModelId };
      calls.push({ runId, at, agent: started.agent, project: started.project ?? null, member, ...target, input: e.usage.input, output: e.usage.output });
    }
  }
  return calls;
}

/** Cost per currency, in 1e-12 units, plus what had no price. */
export interface Cost {
  readonly priced: ReadonlyMap<string, bigint>;
  readonly unpriced: { readonly calls: number; readonly input: number; readonly output: number };
}

export function costOf(calls: readonly UsageCall[], book: PriceBook): Cost {
  const priced = new Map<string, bigint>();
  const unpriced = { calls: 0, input: 0, output: 0 };
  for (const c of calls) {
    const p = priceAt(book, c.endpoint, c.model, c.at);
    if (!p) {
      unpriced.calls++;
      unpriced.input += c.input;
      unpriced.output += c.output;
      continue;
    }
    priced.set(p.currency, (priced.get(p.currency) ?? 0n) + BigInt(c.input) * p.inputMicro + BigInt(c.output) * p.outputMicro);
  }
  return { priced, unpriced };
}

/** An amount in 1e-12 units as a decimal string, rounded half up to `places`. */
export function formatAmount(units: bigint, places: number): string {
  const step = 10n ** BigInt(12 - places);
  const rounded = (units + step / 2n) / step;
  const s = rounded.toString().padStart(places + 1, "0");
  return places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
}

/** "USD 0.0042", "USD 1.20 + EUR 0.40", or null when nothing was priced. */
export function formatCost(cost: Cost, places: number): string | null {
  if (!cost.priced.size) return null;
  return [...cost.priced].map(([cur, units]) => `${cur} ${formatAmount(units, places)}`).join(" + ");
}

export const GROUP_BY = ["agent", "project", "member", "endpoint"] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export interface UsageRow {
  readonly key: string;
  readonly runs: number;
  readonly calls: number;
  readonly input: number;
  readonly output: number;
  readonly cost: Cost;
}

/** agentNames maps a version hash to its agent id, so a row reads handbook rather than a hash. */
export function usageRows(calls: readonly UsageCall[], book: PriceBook, by: GroupBy, agentNames: ReadonlyMap<string, string> = new Map()): UsageRow[] {
  const keyOf = (c: UsageCall): string => {
    switch (by) {
      case "agent":
        return agentNames.get(c.agent) ?? c.agent.slice(0, 12);
      case "project":
        return c.project ?? "(no project)";
      case "member":
        return c.member ?? "(no member)";
      case "endpoint":
        return `${c.endpoint}/${c.model}`;
    }
  };
  const groups = new Map<string, UsageCall[]>();
  for (const c of calls) {
    const k = keyOf(c);
    const group = groups.get(k);
    if (group) group.push(c);
    else groups.set(k, [c]);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, cs]) => ({
      key,
      runs: new Set(cs.map((c) => c.runId)).size,
      calls: cs.length,
      input: cs.reduce((n, c) => n + c.input, 0),
      output: cs.reduce((n, c) => n + c.output, 0),
      cost: costOf(cs, book),
    }));
}

/** Totals are summed exactly before rounding, so a total can differ from the sum of the rounded rows by a cent. */
export function usageTotal(rows: readonly UsageRow[]): UsageRow {
  const priced = new Map<string, bigint>();
  for (const r of rows) for (const [cur, u] of r.cost.priced) priced.set(cur, (priced.get(cur) ?? 0n) + u);
  const sum = (f: (r: UsageRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  return {
    key: "total",
    runs: sum((r) => r.runs),
    calls: sum((r) => r.calls),
    input: sum((r) => r.input),
    output: sum((r) => r.output),
    cost: { priced, unpriced: { calls: sum((r) => r.cost.unpriced.calls), input: sum((r) => r.cost.unpriced.input), output: sum((r) => r.cost.unpriced.output) } },
  };
}

/** Cents, except that a cost below half a cent reads <0.01, so a priced call never looks free. */
function centsCell(c: Cost): string | null {
  if (!c.priced.size) return null;
  return [...c.priced].map(([cur, u]) => `${cur} ${u > 0n && u < 5_000_000_000n ? "<0.01" : formatAmount(u, 2)}`).join(" + ");
}

function costCell(c: Cost): string {
  const priced = centsCell(c);
  if (!c.unpriced.calls) return priced ?? "-";
  const none = `no price for ${c.unpriced.calls} ${c.unpriced.calls === 1 ? "call" : "calls"}`;
  return priced ? `${priced}; ${none}` : "no price";
}

export function formatUsageTable(rows: readonly UsageRow[], by: GroupBy): string {
  if (!rows.length) return "no model calls in this range";
  const all = [...rows, usageTotal(rows)];
  const cells = all.map((r) => [r.key, String(r.runs), String(r.calls), String(r.input), String(r.output), costCell(r.cost)]);
  const head = [by, "runs", "calls", "tokens in", "tokens out", "cost"];
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: readonly string[]) => c.map((v, i) => (i === 0 || i === 5 ? v.padEnd(w[i]!) : v.padStart(w[i]!))).join("  ").trimEnd();
  return [line(head), ...cells.slice(0, -1).map(line), line(cells.at(-1)!)].join("\n");
}

/** One row per group and currency; a group's unpriced tokens get their own row with an empty amount. */
export function formatUsageCsv(rows: readonly UsageRow[], by: GroupBy): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const out = [`${by},runs,calls,tokens_in,tokens_out,currency,amount,amount_exact,priced`];
  for (const r of rows) {
    for (const [cur, u] of r.cost.priced) out.push([q(r.key), r.runs, r.calls, r.input, r.output, cur, formatAmount(u, 2), formatAmount(u, 6), "yes"].join(","));
    if (r.cost.unpriced.calls) out.push([q(r.key), r.runs, r.cost.unpriced.calls, r.cost.unpriced.input, r.cost.unpriced.output, "", "", "", "no price"].join(","));
  }
  return out.join("\n");
}

export function usageJson(rows: readonly UsageRow[], by: GroupBy, range: { from: string; to: string }): unknown {
  const cost = (c: Cost) => ({
    priced: Object.fromEntries([...c.priced].map(([cur, u]) => [cur, formatAmount(u, 2)])),
    exact: Object.fromEntries([...c.priced].map(([cur, u]) => [cur, formatAmount(u, 6)])),
    unpriced: c.unpriced,
  });
  return { by, from: range.from, to: range.to, rows: rows.map((r) => ({ ...r, cost: cost(r.cost) })), total: (({ key: _, ...t }) => ({ ...t, cost: cost(t.cost) }))(usageTotal(rows)) };
}
