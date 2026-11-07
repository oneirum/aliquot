import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { appendAudit } from "../packages/core/src/audit.ts";
import { exportEvents, exportPage, parseSince, type ExportLine } from "../packages/core/src/audit-export.ts";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import { applySchema, connect } from "../packages/core/src/db.ts";
import type { AgentVersionHash, Sha256, SnapshotId } from "../packages/core/src/hash.ts";
import { createPayloadStore, openJournal, type RunId } from "../packages/core/src/record.ts";
import type { AgentId } from "../packages/core/src/agent.ts";
import { ADMIN_URL, databaseUrl, freshDatabase, testDatabase } from "./db.ts";
import { TARGET, started } from "./events.ts";

const { db, url } = await freshDatabase("labh_test_audit_export");
after(() => db.end());
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: randomBytes(32), keyId: "k1" });

/** Text that must never reach an export line, planted in every free-text field an event has and in a stored payload. */
const SECRET = "P-24680 told the RA about the relapse";

async function leasedRun(key: string): Promise<RunId> {
  const res = await db.query<{ id: string }>(
    "insert into jobs (kind, key, status, lease_owner, lease_epoch, lease_until, payload) values ('run', $1, 'leased', 'A', 1, now() + interval '1 minute', '{}') returning id",
    [key],
  );
  return res.rows[0]!.id as RunId;
}

const all = async (since = 0) => exportPage(db, since, 10_000);

test("a run and the audit stream export as one ordered stream with no payload text", async () => {
  const runId = await leasedRun("export-1");
  const j = await openJournal(db, store, { runId, epoch: 1, owner: "A" });
  const input = await store.put(Labelled.stamp(SECRET, "D3", "test"));
  await j.append(started(input));
  await j.append({ t: "model.requested", step: 1, attempt: 1, target: TARGET, prompt: input, final: false });
  await j.append({ t: "egress.refused", destination: `https://api.openalex.org/works?search=${encodeURIComponent(SECRET)}`, payload: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D0" } });
  await j.append({ t: "stop", by: "bob", sinceStartMs: 1200 });
  await j.append({ t: "run.finished", outcome: "stopped", answer: null, reason: null, flags: [{ t: "number-untraced", text: SECRET }] });
  await appendAudit(db, "carol", { t: "agent.published", agentId: "lab-helper" as AgentId, version: "b".repeat(64) as AgentVersionHash, previous: null, draftHash: "c".repeat(64) as Sha256, changelog: SECRET });
  await appendAudit(db, "carol", { t: "kb.published", kbId: "handbook", snapshot: "d".repeat(64) as SnapshotId, override: { note: SECRET, gaps: [SECRET] } });
  await appendAudit(db, "worker:w1", { t: "kb.compile-failed", job: "job-1", kbId: "handbook", reason: SECRET, refusal: null });

  const lines = await all();
  const text = lines.map((l) => JSON.stringify(l)).join("\n");
  assert.ok(!text.includes("P-24680") && !text.includes("relapse"), "no free text and no payload body reaches an export line");
  assert.ok(!text.includes("search="), "a refused URL is exported as its host only");

  assert.deepEqual(
    lines.map((l) => [l.stream, l.type, l.actor]),
    [
      ["run", "run.started", "alice"],
      ["run", "model.requested", null],
      ["run", "egress.refused", null],
      ["run", "stop", "bob"],
      ["run", "run.finished", null],
      ["audit", "agent.published", "carol"],
      ["audit", "kb.published", "carol"],
      ["audit", "kb.compile-failed", "worker:w1"],
    ],
  );
  assert.deepEqual(
    lines.map((l) => l.seq),
    [...lines.map((l) => l.seq)].sort((a, b) => a - b),
  );
  const refused = lines[2]!;
  assert.deepEqual(refused.refusal, { code: "class-above-ceiling", payload: "D3", ceiling: "D0" });
  assert.deepEqual(refused.detail, { destination: "api.openalex.org", payload: "D3" });
  assert.deepEqual(lines[0]!.refs, [{ hash: input.hash, cls: "D3", bytes: input.bytes }]);
  assert.equal(lines[0]!.cls, "D3");
  assert.equal(lines[0]!.run, runId);
  assert.deepEqual(lines[6]!.detail, { kbId: "handbook", snapshot: "d".repeat(64), overridden: true, gaps: 1 });
});

test("the line format is version 1 with every key present, in a fixed order", async () => {
  const lines = await all();
  const KEYS = ["v", "seq", "at", "stream", "type", "actor", "run", "runSeq", "cls", "hash", "prevHash", "refs", "refusal", "detail"];
  for (const l of lines) assert.deepEqual(Object.keys(l), KEYS);
  const published = lines.find((l) => l.type === "agent.published")!;
  assert.deepEqual(
    { ...published, seq: 0, at: "", hash: "" },
    {
      v: 1,
      seq: 0,
      at: "",
      stream: "audit",
      type: "agent.published",
      actor: "carol",
      run: null,
      runSeq: null,
      cls: null,
      hash: "",
      prevHash: published.prevHash,
      refs: [],
      refusal: null,
      detail: { agentId: "lab-helper", version: "b".repeat(64), previous: null, draftHash: "c".repeat(64) },
    } satisfies ExportLine,
  );
  assert.match(published.hash, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(published.at)));
});

test("--since takes a seq or a time", async () => {
  const lines = await all();
  const mid = lines[3]!;
  assert.deepEqual((await all(mid.seq)).map((l) => l.seq), lines.slice(4).map((l) => l.seq));
  assert.deepEqual(parseSince("12"), { t: "seq", after: 12 });
  assert.equal(parseSince("yesterday"), null);
  const future: string[] = [];
  await exportEvents(db, parseSince("2999-01-01T00:00:00Z")!, (l) => void future.push(l));
  assert.deepEqual(future, []);
  const fromStart: string[] = [];
  await exportEvents(db, parseSince("2000-01-01")!, (l) => void fromStart.push(l));
  assert.equal(fromStart.length, lines.length);
});

test("a row whose transaction commits late still exports in order, never skipped", async () => {
  const before = (await all()).at(-1)!.seq;
  const slow = await db.connect();
  await slow.query("begin");
  await slow.query("insert into audit_events (actor, prev_hash, hash, event) values ('slow', null, $1, $2)", ["e".repeat(64), { t: "kb.publish-refused", kbId: "slow", snapshot: "f".repeat(64), gaps: [] }]);
  // A second writer waits for the first to commit, so it cannot take a later position and become visible first.
  let fastDone = false;
  const fast = appendAudit(db, "fast", { t: "kb.publish-refused", kbId: "fast", snapshot: "f".repeat(64) as SnapshotId, gaps: [] }).then(() => (fastDone = true));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fastDone, false);
  assert.deepEqual(await all(before), []);
  await slow.query("commit");
  slow.release();
  await fast;
  assert.deepEqual((await all(before)).map((l) => l.actor), ["slow", "fast"]);
});

test("aliquot audit export --follow prints events written after it started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-export-"));
  writeFileSync(join(dir, "lab.toml"), '[database]\nurl_env = "DATABASE_URL"\n[store]\nplacement = "lab"\nkey_env = "LABH_PAYLOAD_KEY"\n[endpoints.local]\nbase_url = "http://127.0.0.1:9/v1"\nplacement = "lab"\n');
  const last = (await all()).at(-1)!.seq;
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--permission", "--allow-fs-read=*", "--allow-net", "packages/core/bin/aliquot.ts", "--config", join(dir, "lab.toml"), "audit", "export", "--since", String(last), "--follow", "--poll-ms", "100"],
    { env: { PATH: process.env.PATH ?? "", DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    await new Promise((r) => setTimeout(r, 400));
    await appendAudit(db, "dave", { t: "kb.publish-refused", kbId: "late", snapshot: "1".repeat(64) as SnapshotId, gaps: ["q"] });
    if (child.exitCode !== null) assert.fail(`export exited ${child.exitCode}: ${stderr}`);
    const next = await Promise.race([lines.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no line in 10 s; stderr: ${stderr}`)), 10_000))]);
    const line = JSON.parse(next.value as string) as ExportLine;
    assert.equal(line.actor, "dave");
    assert.equal(line.type, "kb.publish-refused");
    assert.ok(line.seq > last);
  } finally {
    child.kill("SIGTERM");
  }
  const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  assert.equal(code, 0, stderr);
});

test("migrating a database that already has events numbers them in time order", async () => {
  const name = testDatabase("labh_test_export_backfill");
  const admin = connect(ADMIN_URL);
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const old = connect(databaseUrl(name));
  try {
    // The schema as 0.6 left it: migrations 0001 to 0004 only.
    const dir = join(import.meta.dirname, "..", "packages", "core", "migrations");
    await old.query("create table schema_migrations (id text primary key, applied_at timestamptz not null default now())");
    for (const f of ["0001_initial.sql", "0002_payload_class_in_address.sql", "0003_agent_heads_version.sql", "0004_agent_cli_seen.sql"]) {
      await old.query(readFileSync(join(dir, f), "utf8"));
      await old.query("insert into schema_migrations (id) values ($1)", [f]);
    }
    const job = (await old.query<{ id: string }>("insert into jobs (kind, key, status, payload) values ('run', 'old', 'done', '{}') returning id")).rows[0]!.id;
    const ev = (t: string) => JSON.stringify({ t });
    await old.query("insert into run_events (run_id, seq, at, cls, prev_hash, hash, event) values ($1, 0, '2026-01-01T00:00:02Z', 'D0', null, 'h0', $2), ($1, 1, '2026-01-01T00:00:04Z', 'D0', 'h0', 'h1', $3)", [job, ev("stop.asked"), ev("limit.hit")]);
    await old.query("insert into audit_events (at, actor, prev_hash, hash, event) values ('2026-01-01T00:00:01Z', 'x', null, 'a1', $1), ('2026-01-01T00:00:03Z', 'y', 'a1', 'a2', $1)", [ev("kb.publish-refused")]);
    await old.query("insert into audit_events (at, actor, prev_hash, hash, event) values ('2026-01-01T00:00:05Z', 'w', 'a2', 'a9', $1)", [JSON.stringify({ t: "some.future-type", note: "kept out" })]);
    await applySchema(old);
    const order = (await exportPage(old, 0, 100)).map((l) => [l.seq, l.hash]);
    assert.deepEqual(order, [
      [1, "a1"],
      [2, "h0"],
      [3, "a2"],
      [4, "h1"],
      [5, "a9"],
    ]);
    const future = (await exportPage(old, 4, 100))[0]!;
    assert.deepEqual([future.type, future.detail], ["some.future-type", {}]);
    await old.query("insert into audit_events (actor, prev_hash, hash, event) values ('z', 'a2', 'a3', $1)", [ev("kb.publish-refused")]);
    assert.deepEqual((await exportPage(old, 5, 100)).map((l) => [l.seq, l.hash]), [[6, "a3"]]);
  } finally {
    await old.end();
  }
});
