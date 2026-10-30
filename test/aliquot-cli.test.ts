import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../packages/core/src/db.ts";
import type { RunId, StoredEvent } from "../packages/core/src/record.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { freshDatabase } from "./db.ts";
import { RUN, chain, ref, started } from "./events.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "aliquot-cli-")));
const cfg = join(dir, "lab.toml");
writeFileSync(cfg, '[endpoints.local]\nbase_url = "http://127.0.0.1:11434/v1"\nplacement = "lab"\n');
const LATER = "00000000-0000-4000-8000-000000000002" as RunId;

let db: Db;
let url: string;

async function insert(events: readonly StoredEvent[]): Promise<void> {
  await db.query("insert into jobs (id, kind, key, payload) values ($1, 'run', $2, '{}')", [events[0]!.runId, events[0]!.runId]);
  for (const e of events)
    await db.query("insert into run_events (run_id, seq, at, cls, prev_hash, hash, event) values ($1, $2, $3, $4, $5, $6, $7)", [e.runId, e.seq, e.at, e.cls, e.prevHash, e.hash, e.event]);
}

before(async () => {
  ({ db, url } = await freshDatabase("labh_aliquot_cli"));
  const finished = { t: "run.finished", outcome: "answered", answer: null, reason: null, flags: [] } as const;
  await insert(chain([started(ref("q")), finished]));
  await insert(chain([started(ref("q2")), { ...finished, outcome: "refused" }], Date.parse("2026-01-02T00:00:00.000Z"), LATER));
});
after(async () => {
  await db.end();
});

function aliquot(args: readonly string[], env: Record<string, string> = { DATABASE_URL: url }) {
  return spawnSync(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/aliquot.ts", "--config", cfg, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", ...env },
    timeout: 30_000,
  });
}

test("aliquot runs lists the newest run first, with its outcome and an intact chain", () => {
  const r = aliquot(["runs"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.match(lines[0]!, /^started \(UTC\) +run +agent +outcome +events +chain$/);
  assert.match(lines[1]!, new RegExp(`^2026-01-02 00:00:00Z  ${LATER}  a{12}  refused +2  intact$`));
  assert.match(lines[2]!, new RegExp(`^2026-01-01 00:00:00Z  ${RUN}  a{12}  answered +2  intact$`));
  assert.equal(lines.length, 3);
});

test("aliquot runs --limit 1 keeps only the newest", () => {
  const r = aliquot(["runs", "--limit", "1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trimEnd().split("\n").length, 2);
  assert.ok(r.stdout.includes(LATER));
});

test("aliquot --json record prints the record view as JSON", () => {
  const r = aliquot(["--json", "record", RUN]);
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.deepEqual({ runId: v.runId, outcome: v.outcome, chain: v.chain, startedAt: v.startedAt, rows: v.rows.length }, { runId: RUN, outcome: "answered", chain: { events: 2, firstBad: null }, startedAt: "2026-01-01T00:00:00.000Z", rows: 2 });
});

test("aliquot --json runs prints an array, newest first", () => {
  const r = aliquot(["--json", "runs"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((v: { runId: string }) => v.runId), [LATER, RUN]);
});

test("an unknown run exits 1 with one line", () => {
  const r = aliquot(["record", "00000000-0000-4000-8000-0000000000ff"]);
  assert.deepEqual({ status: r.status, stderr: r.stderr }, { status: 1, stderr: "no run 00000000-0000-4000-8000-0000000000ff in this database\n" });
});

test("a bad command, a bad limit or an extra argument prints the usage and exits 2", () => {
  for (const args of [["list"], ["runs", "--limit", "0"], ["runs", "--limit", "x"], ["record", RUN, "extra"], ["runs", "--nope"]]) {
    const r = aliquot(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /^usage: aliquot/, args.join(" "));
  }
});

test("setup problems are one line, not a stack trace", () => {
  const unset = aliquot(["runs"], {});
  assert.deepEqual({ status: unset.status, stderr: unset.stderr }, { status: 2, stderr: "DATABASE_URL is not set\n" });
  const down = aliquot(["runs"], { DATABASE_URL: "postgres://postgres:secret@127.0.0.1:1/labh" });
  assert.deepEqual({ status: down.status, stderr: down.stderr }, { status: 2, stderr: "cannot reach Postgres at 127.0.0.1:1/labh. Is it running? (docker compose up -d postgres)\n" });
  assert.ok(!down.stderr.includes("secret"));
});
