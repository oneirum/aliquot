import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../packages/core/src/config.ts";
import type { Db } from "../packages/core/src/db.ts";
import type { ExactModelId } from "../packages/core/src/gateway.ts";
import type { RunEvent, RunId, StoredEvent } from "../packages/core/src/record.ts";
import { formatRecordView, recordView } from "../packages/core/src/record-view.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { callsOf, formatAmount, formatUsageCsv, formatUsageTable, priceAt, usageRows, usageTotal } from "../packages/core/src/usage.ts";
import { freshDatabase } from "./db.ts";
import { chain, ref, started } from "./events.ts";

/**
 * A schedule of rates with a mid-month change: the hosted endpoint drops from 3.00/15.00 to 2.50/10.00 per million
 * tokens on 15 October, and one model on it, cheap-1, has its own rate that beats the endpoint's. local has no rate.
 */
const PRICES = `
[endpoints.hosted]
base_url = "http://127.0.0.1:9/v1"
placement = "zdr"
[endpoints.local]
base_url = "http://127.0.0.1:11434/v1"
placement = "lab"

[[prices.hosted]]
input_per_mtok = 3.00
output_per_mtok = 15.00
currency = "USD"
effective = 2026-10-01

[[prices.hosted]]
input_per_mtok = 2.50
output_per_mtok = 10.00
currency = "USD"
effective = 2026-10-15

[prices."cheap-1"]
input_per_mtok = 0.15
output_per_mtok = 0.60
currency = "USD"
effective = "2026-09-01"
`;
const config = parseConfig(PRICES, "/lab/lab.toml");

const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as RunId;
type Call = { endpoint: string; model: string; input: number; output: number };

/** One run: run.started with the project and member, then a requested/completed pair per call, one second apart. */
function run(n: number, at: string, project: string | null, member: string, calls: readonly Call[]): StoredEvent[] {
  const events: RunEvent[] = [{ ...(started(ref(`q${n}`)) as Extract<RunEvent, { t: "run.started" }>), trigger: { t: "message", surface: "web", messageId: `m${n}`, memberId: member }, ...(project ? { project } : {}) }];
  calls.forEach((c, i) => {
    const target = { endpointId: c.endpoint, modelId: c.model as ExactModelId, params: { temperature: 0, maxOutputTokens: 256 } };
    events.push({ t: "model.requested", step: i + 1, attempt: 1, target, prompt: ref(`p${n}.${i}`), final: false });
    events.push({ t: "model.completed", step: i + 1, attempt: 1, providerModelId: c.model, output: ref(`o${n}.${i}`), toolCalls: [], usage: { input: c.input, output: c.output }, ms: 5 });
  });
  events.push({ t: "run.finished", outcome: "answered", answer: null, reason: null, flags: [] });
  return chain(events, Date.parse(at), runId(n));
}

const big = (input: number, output: number): Call => ({ endpoint: "hosted", model: "big-1", input, output });
/**
 * Hand-summed, per call:
 *   r1 GRANT-A  3 Oct   big-1 at 3.00/15.00: 120000 in 0.360000 + 8000 out 0.120000; 50000 in 0.150000 + 2000 out 0.030000 = 0.660000
 *   r2 GRANT-A 20 Oct   big-1 at 2.50/10.00: 200000 in 0.500000 + 12345 out 0.123450                                     = 0.623450
 *   r3 GRANT-B 14 Oct 23:59:58, the last second before the change, at 3.00/15.00: 333333 in 0.999999 + 33333 out 0.499995 = 1.499994
 *   r4 GRANT-B 15 Oct 00:00:00, cheap-1's own rate 0.15/0.60: 1000000 in 0.150000 + 500000 out 0.300000                      = 0.450000
 *   r5 none    22 Oct   local, no rate: 5000 in, 700 out                                                                 no price
 * GRANT-A 1.283450 -> 1.28; GRANT-B 1.949994 -> 1.95; total 3.233444 -> 3.23.
 * r3's model.completed lands at +2 s (run.started at +0, model.requested at +1), so it starts at 23:59:56.
 */
const RUNS = [
  run(1, "2026-10-03T10:00:00.000Z", "GRANT-A", "alice", [big(120_000, 8_000), big(50_000, 2_000)]),
  run(2, "2026-10-20T09:00:00.000Z", "GRANT-A", "bob", [big(200_000, 12_345)]),
  run(3, "2026-10-14T23:59:56.000Z", "GRANT-B", "alice", [big(333_333, 33_333)]),
  run(4, "2026-10-14T23:59:58.000Z", "GRANT-B", "carol", [{ endpoint: "hosted", model: "cheap-1", input: 1_000_000, output: 500_000 }]),
  run(5, "2026-10-22T12:00:00.000Z", null, "bob", [{ endpoint: "local", model: "qwen3:8b", input: 5_000, output: 700 }]),
];
/** Outside October, so a range that leaked either in would change the token totals. */
const OUTSIDE = [run(6, "2026-09-30T23:00:00.000Z", "GRANT-A", "alice", [big(1_000_000, 0)]), run(7, "2026-11-01T00:00:00.000Z", "GRANT-B", "alice", [big(1_000_000, 0)])];

test("each call is priced at the rate in force at its own time: model id before endpoint, the change at 00:00 UTC", () => {
  assert.equal(priceAt(config.prices, "hosted", "big-1", "2026-10-14T23:59:59.999Z")?.inputMicro, 3_000_000n);
  assert.equal(priceAt(config.prices, "hosted", "big-1", "2026-10-15T00:00:00.000Z")?.inputMicro, 2_500_000n);
  assert.equal(priceAt(config.prices, "hosted", "cheap-1", "2026-10-02T00:00:00.000Z")?.inputMicro, 150_000n);
  assert.equal(priceAt(config.prices, "hosted", "big-1", "2026-09-30T23:59:59.000Z"), null, "before the first rate there is no price");
  assert.equal(priceAt(config.prices, "local", "qwen3:8b", "2026-10-20T00:00:00.000Z"), null);
});

test("totals per project from fixture records match the hand-summed totals to the cent, across the mid-month price change", () => {
  const calls = RUNS.flatMap((r) => callsOf(r));
  assert.equal(calls.length, 6);
  const rows = usageRows(calls, config.prices, "project");
  const cents = (r: (typeof rows)[number]) => (r.cost.priced.has("USD") ? formatAmount(r.cost.priced.get("USD")!, 2) : null);
  assert.deepEqual(
    rows.map((r) => [r.key, r.runs, r.calls, r.input, r.output, cents(r), r.cost.unpriced.calls]),
    [
      ["(no project)", 1, 1, 5_000, 700, null, 1],
      ["GRANT-A", 2, 3, 370_000, 22_345, "1.28", 0],
      ["GRANT-B", 2, 2, 1_333_333, 533_333, "1.95", 0],
    ],
  );
  const total = usageTotal(rows);
  assert.equal(formatAmount(total.cost.priced.get("USD")!, 2), "3.23");
  assert.equal(formatAmount(total.cost.priced.get("USD")!, 6), "3.233444", "exact before rounding");
});

test("a run with no price prints its tokens and no price, never zero", () => {
  const rows = usageRows(callsOf(RUNS[4]!), config.prices, "project");
  const table = formatUsageTable(rows, "project");
  assert.match(table, /^\(no project\) +1 +1 +5000 +700  no price$/m);
  assert.doesNotMatch(table, /0\.00/);
  assert.match(formatUsageCsv(rows, "project"), /^\(no project\),1,1,5000,700,,,,no price$/m);

  const v = recordView(runId(5), RUNS[4]!, [], config.prices);
  assert.deepEqual(v.summary.cost, { amounts: [], unpricedCalls: 1 });
  assert.match(formatRecordView(v), /; cost no price$/m);
});

test("the record summary shows the run's cost when lab.toml has prices, and nothing about cost when it has none", () => {
  const v = recordView(runId(2), RUNS[1]!, [], config.prices);
  assert.deepEqual(v.summary.cost, { amounts: [{ currency: "USD", amount: "0.6235" }], unpricedCalls: 0 });
  assert.match(formatRecordView(v), /; cost USD 0\.6235$/m);
  const bare = recordView(runId(2), RUNS[1]!);
  assert.equal(bare.summary.cost, null);
  assert.doesNotMatch(formatRecordView(bare), /cost/);
});

test("a priced total under half a cent reads <0.01 in the table, and its exact amount in CSV, so it never looks free", () => {
  const rows = usageRows(callsOf(run(8, "2026-10-05T00:00:00.000Z", "GRANT-A", "alice", [big(60, 30)])), config.prices, "project");
  assert.match(formatUsageTable(rows, "project"), /^GRANT-A +1 +1 +60 +30  USD <0\.01$/m);
  assert.match(formatUsageCsv(rows, "project"), /^GRANT-A,1,1,60,30,USD,0\.00,0\.000630,yes$/m);
});

test("by endpoint, member and agent group the same calls", () => {
  const calls = RUNS.flatMap((r) => callsOf(r));
  assert.deepEqual(
    usageRows(calls, config.prices, "endpoint").map((r) => r.key),
    ["hosted/big-1", "hosted/cheap-1", "local/qwen3:8b"],
  );
  assert.deepEqual(
    usageRows(calls, config.prices, "member").map((r) => [r.key, r.runs]),
    [["alice", 2], ["bob", 2], ["carol", 1]],
  );
  assert.deepEqual(usageRows(calls, config.prices, "agent", new Map([["a".repeat(64), "handbook"]])).map((r) => r.key), ["handbook"]);
});

test("lab.toml refuses a rate it cannot price exactly, a currency it cannot name, and two rates on one day", () => {
  const base = '[endpoints.local]\nbase_url = "http://127.0.0.1:11434/v1"\nplacement = "lab"\n';
  assert.throws(() => parseConfig(`${base}[prices.local]\ninput_per_mtok = 0.0000001\noutput_per_mtok = 1\ncurrency = "USD"\neffective = 2026-10-01\n`, "/l.toml"), /\[prices\.local\] input_per_mtok: has more than 6 decimal places/);
  assert.throws(() => parseConfig(`${base}[prices.local]\ninput_per_mtok = 1\noutput_per_mtok = 1\ncurrency = "$"\neffective = 2026-10-01\n`, "/l.toml"), /three-letter code/);
  assert.throws(
    () => parseConfig(`${base}[[prices.local]]\ninput_per_mtok = 1\noutput_per_mtok = 1\ncurrency = "USD"\neffective = 2026-10-01\n[[prices.local]]\ninput_per_mtok = 2\noutput_per_mtok = 2\ncurrency = "USD"\neffective = "2026-10-01"\n`, "/l.toml"),
    /two rates effective 2026-10-01/,
  );
  assert.equal(parseConfig(base, "/l.toml").prices.size, 0);
});

describeCli();

function describeCli(): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aliquot-usage-")));
  const cfg = join(dir, "lab.toml");
  writeFileSync(cfg, PRICES);
  let db: Db;
  let url: string;

  before(async () => {
    ({ db, url } = await freshDatabase("labh_usage_cli"));
    for (const events of [...RUNS, ...OUTSIDE]) {
      await db.query("insert into jobs (id, kind, key, payload) values ($1, 'run', $2, '{}')", [events[0]!.runId, events[0]!.runId]);
      for (const e of events)
        await db.query("insert into run_events (run_id, seq, at, cls, prev_hash, hash, event) values ($1, $2, $3, $4, $5, $6, $7)", [e.runId, e.seq, e.at, e.cls, e.prevHash, e.hash, e.event]);
    }
  });
  after(async () => {
    await db.end();
  });

  const aliquot = (args: readonly string[]) =>
    spawnSync(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/aliquot.ts", "--config", cfg, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", DATABASE_URL: url },
      timeout: 30_000,
    });

  test("aliquot usage over October reads the records alone and prints the hand-summed totals; September and November stay out", () => {
    const r = aliquot(["usage", "--from", "2026-10-01", "--to", "2026-10-31", "--by", "project"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage 2026-10-01 to 2026-10-31 \(UTC\), by project, from 5 run records$/m);
    assert.match(r.stdout, /^\(no project\) +1 +1 +5000 +700  no price$/m);
    assert.match(r.stdout, /^GRANT-A +2 +3 +370000 +22345  USD 1\.28$/m);
    assert.match(r.stdout, /^GRANT-B +2 +2 +1333333 +533333  USD 1\.95$/m);
    assert.match(r.stdout, /^total +5 +6 +1708333 +556378  USD 3\.23; no price for 1 call$/m);
  });

  test("aliquot usage --json and --csv carry the same totals", () => {
    const j = aliquot(["usage", "--from", "2026-10-01", "--to", "2026-10-31", "--json"]);
    assert.equal(j.status, 0, j.stderr);
    const out = JSON.parse(j.stdout) as { total: { cost: { priced: Record<string, string>; unpriced: { calls: number } } }; brokenChains: string[] };
    assert.deepEqual(out.total.cost.priced, { USD: "3.23" });
    assert.equal(out.total.cost.unpriced.calls, 1);
    assert.deepEqual(out.brokenChains, []);
    const c = aliquot(["usage", "--from", "2026-10-01", "--to", "2026-10-31", "--by", "member", "--csv"]);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(c.stdout.split("\n")[0], "member,runs,calls,tokens_in,tokens_out,currency,amount,amount_exact,priced");
  });

  test("aliquot usage refuses a bad range or grouping as a usage problem", () => {
    assert.equal(aliquot(["usage", "--from", "2026-10-31", "--to", "2026-10-01"]).status, 2);
    assert.equal(aliquot(["usage", "--by", "grant"]).status, 2);
    assert.equal(aliquot(["usage", "--csv", "--json"]).status, 2);
    assert.equal(aliquot(["runs", "--csv"]).status, 2);
  });
}
