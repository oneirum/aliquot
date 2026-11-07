import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorSignatureValid, describeAnchorProblem, keyFingerprint, loadAnchorKey, newAnchorKeyPem, parseAnchorLine, signAnchor, verifyAnchors, writeAnchor, type Anchor, type AnchorSigner } from "../packages/core/src/anchor.ts";
import { appendAudit, auditHash, loadAudit, verifyAudit, type AuditRow } from "../packages/core/src/audit.ts";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import type { Db } from "../packages/core/src/db.ts";
import { canonicalJson, sha256, type Sha256, type SnapshotId } from "../packages/core/src/hash.ts";
import { createPayloadStore, eventClass, eventHash, loadEvents, verifyChain, type RunEvent, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { freshDatabase } from "./db.ts";
import { chain, ref, started } from "./events.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "aliquot-anchor-")));
const keyPath = join(dir, "anchor.key");
writeFileSync(keyPath, newAnchorKeyPem(), { mode: 0o600 });
const signer: AnchorSigner = { path: join(dir, "anchors.log"), key: loadAnchorKey(keyPath) };
const finished = { t: "run.finished", outcome: "answered", answer: null, reason: null, flags: [] } as const satisfies RunEvent;

let db: Db;
let url: string;
const RUN_A = "00000000-0000-4000-8000-00000000000a" as RunId;
const RUN_B = "00000000-0000-4000-8000-00000000000b" as RunId;

async function insertRun(events: readonly StoredEvent[], status = "done"): Promise<void> {
  const head = events.at(-1)!;
  await db.query("insert into jobs (id, kind, key, payload, status, head_seq, head_hash) values ($1, 'run', $5, '{}', $2, $3, $4)", [head.runId, status, head.seq, head.hash, head.runId]);
  for (const e of events)
    await db.query("insert into run_events (run_id, seq, at, cls, prev_hash, hash, event) values ($1, $2, $3, $4, $5, $6, $7)", [e.runId, e.seq, e.at, e.cls, e.prevHash, e.hash, e.event]);
}

const publish = (i: number) => appendAudit(db, "steward-1", { t: "kb.published", kbId: `kb-${i}`, snapshot: "s".repeat(64) as SnapshotId });

/** What someone with database write access does: change one audit row's event, then recompute every hash after it. */
async function rewriteAudit(seq: number, event: AuditRow["event"]): Promise<void> {
  const rows = await loadAudit(db);
  let prev: AuditRow["prevHash"] = null;
  for (const r of rows) {
    const ev = r.seq === seq ? event : r.event;
    const hash: Sha256 = r.seq >= seq ? auditHash(r.at, r.actor, prev, ev) : r.hash;
    if (r.seq >= seq) await db.query("update audit_events set event = $2, prev_hash = $3, hash = $4 where seq = $1", [r.seq, ev, prev, hash]);
    prev = hash;
  }
}

/** The same for one run: the immutability trigger is the table owner's to disable, so it stops nobody who owns the database. */
async function rewriteRun(runId: RunId, seq: number, event: RunEvent): Promise<void> {
  const events = await loadEvents(db, runId);
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("alter table run_events disable trigger run_events_immutable");
    let prev: StoredEvent["prevHash"] = null;
    for (const e of events) {
      const ev = e.seq === seq ? event : e.event;
      const cls = eventClass(ev);
      const hash: Sha256 = e.seq >= seq ? eventHash(runId, e.seq, e.at, cls, prev, ev) : e.hash;
      if (e.seq >= seq) await client.query("update run_events set event = $3, cls = $4, prev_hash = $5, hash = $6 where run_id = $1 and seq = $2", [runId, e.seq, ev, cls, prev, hash]);
      prev = hash;
    }
    await client.query("update jobs set head_hash = $2 where id = $1", [runId, prev]);
    await client.query("alter table run_events enable trigger run_events_immutable");
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

const log = () => readFileSync(signer.path, "utf8");

before(async () => {
  ({ db, url } = await freshDatabase("labh_test_anchor"));
});
after(async () => {
  await db.end();
});

test("each anchor signs the audit head and every run closed since the last one, and the log verifies", async () => {
  await insertRun(chain([started(ref("q")), finished], Date.parse("2026-01-01T00:00:00.000Z"), RUN_A));
  await insertRun(chain([started(ref("q2"))], Date.parse("2026-01-01T00:01:00.000Z"), RUN_B), "waiting");
  for (let i = 1; i <= 4; i++) {
    await publish(i);
    await writeAnchor(db, signer);
  }
  const lines = log().trim().split("\n").map((l) => parseAnchorLine(l) as Anchor);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((a) => a.audit?.seq), [1, 2, 3, 4]);
  assert.deepEqual(lines.map((a) => a.runs.map((r) => r.run)), [[RUN_A], [], [], []], "a run is anchored once, and only once it is closed");
  assert.equal(lines[0]!.prev, null);
  assert.equal(lines[1]!.prev, sha256(log().split("\n")[0]!));
  assert.ok(lines.every((a) => anchorSignatureValid(a, signer.key) && a.key === keyFingerprint(signer.key)));

  const report = await verifyAnchors(db, log(), signer.key);
  assert.deepEqual(report.problems, []);
  assert.equal(report.auditThrough, 4);
  assert.equal(report.runsChecked, 1);
});

test("a redacted payload keeps its hash, so the run still verifies against its anchor (the seam unit 12's retention sweep uses)", async () => {
  const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: randomBytes(32), keyId: "k1" });
  const input = await store.put(Labelled.stamp("which freezer holds the wave 1 samples?", "D1", "test"));
  const runId = "00000000-0000-4000-8000-00000000000c" as RunId;
  await insertRun(chain([started(input), finished], Date.parse("2026-01-01T00:02:00.000Z"), runId));
  await writeAnchor(db, signer);
  // What redaction and retention do to a body: delete the ciphertext, keep the row and its address.
  await db.query("update payloads set ciphertext = null, nonce = null where hash = $1", [input.hash]);
  assert.deepEqual(await store.get(input), { redacted: true, hash: input.hash, cls: "D1" });
  const report = await verifyAnchors(db, log(), signer.key);
  assert.deepEqual(report.problems, []);
  assert.equal(report.runsChecked, 2);
});

test("an audit row rewritten with every later hash recomputed passes verify, and verify --anchors names the seq", async () => {
  const before = await loadAudit(db);
  await rewriteAudit(2, { t: "kb.published", kbId: "kb-quietly-swapped", snapshot: "t".repeat(64) as SnapshotId });
  const rows = await loadAudit(db);
  assert.equal(verifyAudit(rows), null, "the internal chain check is fooled");
  assert.notEqual(rows[1]!.hash, before[1]!.hash);

  const report = await verifyAnchors(db, log(), signer.key);
  assert.equal(report.auditThrough, 1);
  const diverged = report.problems.filter((p) => p.t === "audit-diverged");
  assert.equal(diverged.length, 1);
  assert.match(describeAnchorProblem(diverged[0]!), /^audit seq 2 changed after anchor line 2 signed it at \S+: the database no longer holds the signed hash at seq 2, the row now dated \S+; 3 later anchors disagree too$/);

  await assert.rejects(writeAnchor(db, signer), /audit seq 4 no longer holds the hash the last anchor signed/, "the next anchor refuses to sign over the rewrite");
  await rewriteAudit(2, before[1]!.event);
  assert.deepEqual((await verifyAnchors(db, log(), signer.key)).problems, [], "putting the row back restores every anchor");
});

test("a run event rewritten with its chain and head recomputed passes verifyChain, and the anchor catches it", async () => {
  await rewriteRun(RUN_A, 1, { ...finished, outcome: "refused" });
  assert.equal(verifyChain(await loadEvents(db, RUN_A)), null);
  const problems = (await verifyAnchors(db, log(), signer.key)).problems;
  assert.equal(problems.length, 1);
  assert.match(describeAnchorProblem(problems[0]!), new RegExp(`^run ${RUN_A}: changed at or before seq 1 after anchor line 1 signed it at `));
  await rewriteRun(RUN_A, 1, finished);
});

test("a forged line, a line under another key and a removed line are each reported", async () => {
  const good = log();
  const lines = good.trim().split("\n");
  const last = parseAnchorLine(lines.at(-1)!) as Anchor;

  // Same key id, contents changed after signing: the signature no longer holds.
  const forged = { ...last, n: last.n + 1, prev: sha256(lines.at(-1)!), audit: { seq: 99, hash: "f".repeat(64) as Sha256 } };
  const withForged = `${good}${canonicalJson(forged)}\n`;
  let problems = (await verifyAnchors(db, withForged, signer.key)).problems;
  assert.deepEqual(problems.map((p) => p.t), ["bad-signature"]);
  assert.match(describeAnchorProblem(problems[0]!), /^line 6 \(\S+\): the signature does not verify/);

  // A whole line signed by a key the database admin made: properly signed, by the wrong key.
  const other = loadAnchorKeyFromPem(newAnchorKeyPem());
  const { sig: _sig, ...body } = forged;
  const otherLine = signAnchor({ ...body, key: keyFingerprint(other) }, other);
  problems = (await verifyAnchors(db, `${good}${canonicalJson(otherLine)}\n`, signer.key)).problems;
  assert.deepEqual(problems.map((p) => p.t), ["other-key"]);

  // A line dropped from the middle of a copy.
  problems = (await verifyAnchors(db, [lines[0], ...lines.slice(2)].join("\n"), signer.key)).problems;
  assert.deepEqual(problems.map((p) => [p.t, "line" in p ? p.line : null]), [["log-chain", 2], ["log-chain", 3], ["log-chain", 4]]);

  problems = (await verifyAnchors(db, `${good}not json\n`, signer.key)).problems;
  assert.deepEqual(problems, [{ t: "bad-line", line: 6, why: "not JSON" }]);
});

function loadAnchorKeyFromPem(pem: string) {
  const p = join(dir, `other-${randomBytes(4).toString("hex")}.key`);
  writeFileSync(p, pem, { mode: 0o600 });
  return loadAnchorKey(p);
}

function aliquot(args: readonly string[], write: readonly string[] = []) {
  return spawnSync(process.execPath, [...PERMISSION_FLAGS, ...write.map((w) => `--allow-fs-write=${w}`), "packages/core/bin/aliquot.ts", "--config", cfg, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", DATABASE_URL: url, LABH_ANCHOR_KEY_FILE: keyPath },
    timeout: 30_000,
  });
}
const cliLog = join(dir, "cli-anchors.log");
const cfg = join(dir, "lab.toml");
writeFileSync(cfg, `[endpoints.local]\nbase_url = "http://127.0.0.1:11434/v1"\nplacement = "lab"\n[anchor]\npath = "cli-anchors.log"\nevery_minutes = 5\n`);

test("aliquot anchor needs a grant for the log alone, prints the line it appends, and aliquot verify --anchors checks it", () => {
  const denied = aliquot(["anchor"]);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, new RegExp(`--allow-fs-write=${cliLog.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const r = aliquot(["anchor"], [cliLog]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, readFileSync(cliLog, "utf8"), "stdout is exactly the appended line, for a shipper to forward");
  assert.equal((parseAnchorLine(r.stdout.trim()) as Anchor).n, 1);

  const v = aliquot(["verify", "--anchors"]);
  assert.equal(v.status, 0, v.stderr + v.stdout);
  assert.match(v.stdout, /anchors: 1 line, every signature valid, the database matches through audit seq \d+/);
});

test("aliquot verify --anchors exits 3 and names the seq after a recomputed rewrite, while plain verify passes", async () => {
  await rewriteAudit(3, { t: "kb.published", kbId: "kb-again", snapshot: "u".repeat(64) as SnapshotId });
  const plain = aliquot(["verify"]);
  assert.equal(plain.status, 0, plain.stderr + plain.stdout);
  const v = aliquot(["verify", "--anchors"]);
  assert.equal(v.status, 3, v.stdout);
  assert.match(v.stdout, /audit seqs 1 to 4 changed after anchor line 1 signed it at \S+: the database no longer holds the signed hash at seq 4/);
  appendFileSync(cliLog, "{}\n");
  assert.match(aliquot(["verify", "--anchors"]).stdout, /line 2: not an anchor line/);
});
