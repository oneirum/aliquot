import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createQueue, runWorker, type LeasedJob } from "../packages/core/src/queue.ts";
import type { Db } from "../packages/core/src/db.ts";
import type { ThreadKey } from "../packages/core/src/record.ts";
import { freshDatabase } from "./db.ts";

const { db } = await freshDatabase("labh_test_queue");
after(() => db.end());
const queue = createQueue(db);
const thread = (t: string) => `web:c:${t}` as ThreadKey;

test("enqueue is idempotent by key", async () => {
  const a = await queue.enqueue({ kind: "run", key: "msg:web:c:t1:m1" }, thread("t1"), { n: 1 });
  const b = await queue.enqueue({ kind: "run", key: "msg:web:c:t1:m1" }, thread("t1"), { n: 2 });
  assert.equal(a.created, true);
  assert.deepEqual(b, { id: a.id, created: false });
  const rows = await db.query<{ payload: { n: number } }>("select payload from jobs where key = 'msg:web:c:t1:m1'");
  assert.deepEqual(rows.rows, [{ payload: { n: 1 } }]);
  const job = await queue.claim("A", ["run"], 60_000);
  assert.equal(job?.id, a.id);
  await queue.complete(job!, "done");
});

test("claim serializes runs per thread and hands out epochs", async () => {
  const first = await queue.enqueue({ kind: "run", key: "k:t2:1" }, thread("t2"), {});
  await queue.enqueue({ kind: "run", key: "k:t2:2" }, thread("t2"), {});
  const other = await queue.enqueue({ kind: "run", key: "k:t3:1" }, thread("t3"), {});
  const a = await queue.claim("A", ["run"], 60_000);
  assert.equal(a?.id, first.id);
  assert.equal(a?.epoch, 1);
  const b = await queue.claim("B", ["run"], 60_000);
  assert.equal(b?.id, other.id, "the second job in thread t2 waits while the first is leased");
  assert.equal(await queue.claim("C", ["run"], 60_000), null);
  assert.equal(await queue.complete(a!, "done"), true);
  const c = await queue.claim("C", ["run"], 60_000);
  assert.equal(c?.key, "k:t2:2");
  await queue.complete(b!, "done");
  await queue.complete(c!, "done");
});

test("two workers claiming two jobs of one thread at once lease only one of them", async () => {
  const first = await queue.enqueue({ kind: "run", key: "k:t8:1" }, thread("t8"), {});
  await queue.enqueue({ kind: "run", key: "k:t8:2" }, thread("t8"), {});
  // A's claim of the first job is open in a transaction, so B's claim cannot see it as leased.
  const client = await db.connect();
  const onClient = { query: (...args: Parameters<Db["query"]>) => client.query(...args), connect: async () => client } as unknown as Db;
  await client.query("begin");
  const a = await createQueue(onClient).claim("A", ["run"], 60_000);
  assert.equal(a?.id, first.id);
  const b = queue.claim("B", ["run"], 60_000);
  await sleep(100);
  await client.query("commit");
  client.release();
  assert.equal(await b, null, "the second job in the thread is not leased while the first is");
  const leased = await db.query<{ key: string }>("select key from jobs where thread_key = $1 and status = 'leased' order by key", [thread("t8")]);
  assert.deepEqual(
    leased.rows.map((r) => r.key),
    ["k:t8:1"],
  );
  await queue.complete(a!, "done");
  const c = await queue.claim("C", ["run"], 60_000);
  assert.equal(c?.key, "k:t8:2");
  await queue.complete(c!, "done");
});

test("an expired lease is reclaimed with a higher epoch and the old holder is fenced out", async () => {
  await queue.enqueue({ kind: "run", key: "k:t4:1" }, thread("t4"), {});
  const a = (await queue.claim("A", ["run"], 100)) as LeasedJob;
  assert.equal(a.epoch, 1);
  assert.equal(await queue.heartbeat(a, 100), true);
  await sleep(150);
  const b = (await queue.claim("B", ["run"], 60_000)) as LeasedJob;
  assert.equal(b.id, a.id);
  assert.equal(b.epoch, 2);
  assert.equal(await queue.heartbeat(a, 60_000), false);
  assert.equal(await queue.complete(a, "done"), false);
  const status = await db.query<{ status: string; lease_owner: string }>("select status, lease_owner from jobs where id = $1", [a.id]);
  assert.deepEqual(status.rows, [{ status: "leased", lease_owner: "B" }]);
  assert.equal(await queue.complete(b, "done"), true);
});

test("retry hands the job back after the delay with attempts counted, fenced like complete", async () => {
  await queue.enqueue({ kind: "run", key: "k:t7:1" }, thread("t7"), {});
  const a = (await queue.claim("A", ["run"], 60_000)) as LeasedJob;
  assert.equal(a.attempts, 0);
  assert.equal(await queue.retry(a, 150), true);
  assert.equal(await queue.claim("B", ["run"], 60_000), null, "not claimable before the delay");
  await sleep(200);
  const b = (await queue.claim("B", ["run"], 60_000)) as LeasedJob;
  assert.equal(b.id, a.id);
  assert.deepEqual([b.attempts, b.epoch], [1, 2]);
  assert.equal(await queue.retry(a, 0), false, "the old holder cannot hand it back again");
  assert.equal(await queue.retry(b, 0, true), true);
  const c = (await queue.claim("C", ["run"], 60_000)) as LeasedJob;
  assert.deepEqual([c.attempts, c.epoch], [1, 3], "a retry after progress starts the count over at one");
  await queue.complete(c, "done");
});

test("park releases the lease and wake makes the job claimable again", async () => {
  await queue.enqueue({ kind: "run", key: "k:t5:1" }, thread("t5"), {});
  const a = (await queue.claim("A", ["run"], 60_000)) as LeasedJob;
  assert.equal(await queue.park(a), true);
  assert.equal(await queue.claim("B", ["run"], 60_000), null);
  await queue.wake(a.id);
  const b = await queue.claim("B", ["run"], 60_000);
  assert.equal(b?.id, a.id);
  assert.equal(b?.epoch, 2);
  await queue.complete(b!, "done");
});

test("a heartbeat that throws is logged, leaves the job to the fence, and does not crash the worker", async () => {
  const rejections: unknown[] = [];
  const onRejection = (r: unknown) => rejections.push(r);
  process.on("unhandledRejection", onRejection);
  const lines: string[] = [];
  const stop = new AbortController();
  const flaky = { ...queue, heartbeat: async () => { throw new Error("heartbeat blip"); } };
  const worker = runWorker("H", db, flaky, { run: async () => (await sleep(350), "done") }, { leaseMs: 300, pollMs: 50, signal: stop.signal, log: (l) => lines.push(l) });
  const job = await queue.enqueue({ kind: "run", key: "k:t9:1" }, thread("t9"), {});
  await sleep(600);
  stop.abort();
  await worker;
  process.off("unhandledRejection", onRejection);
  assert.deepEqual(rejections, []);
  assert.ok(lines.some((l) => /heartbeat.*heartbeat blip/.test(l)), `logged: ${lines.join(" | ")}`);
  assert.deepEqual((await db.query<{ status: string }>("select status from jobs where id = $1", [job.id])).rows, [{ status: "done" }]);
});

test("runWorker claims, runs the handler, and marks the job done", async () => {
  const seen: string[] = [];
  const stop = new AbortController();
  const worker = runWorker("W", db, queue, { run: async (job) => (seen.push(job.key), "done") }, { leaseMs: 1000, pollMs: 50, signal: stop.signal, log: () => {} });
  const job = await queue.enqueue({ kind: "run", key: "k:t6:1" }, thread("t6"), {});
  for (let i = 0; i < 40 && seen.length === 0; i++) await sleep(25);
  stop.abort();
  await worker;
  assert.deepEqual(seen, ["k:t6:1"]);
  const row = await db.query<{ status: string }>("select status from jobs where id = $1", [job.id]);
  assert.deepEqual(row.rows, [{ status: "done" }]);
});

test("a later job in a thread waits while an earlier one sits in retry backoff or waits for a confirmation", async () => {
  const first = await queue.enqueue({ kind: "run", key: "k:t10:1" }, thread("t10"), {});
  const second = await queue.enqueue({ kind: "run", key: "k:t10:2" }, thread("t10"), {});
  const a = (await queue.claim("A", ["run"], 60_000)) as LeasedJob;
  assert.equal(a.id, first.id);
  assert.equal(await queue.retry(a, 300), true);
  assert.equal(await queue.claim("B", ["run"], 60_000), null, "the second job does not start while the first is queued for a retry");
  await sleep(350);
  const again = (await queue.claim("B", ["run"], 60_000)) as LeasedJob;
  assert.equal(again.id, first.id);
  assert.equal(await queue.park(again), true);
  assert.equal(await queue.claim("C", ["run"], 60_000), null, "nor while the first waits for a confirmation");
  await queue.wake(first.id);
  const woken = (await queue.claim("C", ["run"], 60_000)) as LeasedJob;
  assert.equal(woken.id, first.id);
  await queue.complete(woken, "done");
  const b = (await queue.claim("D", ["run"], 60_000)) as LeasedJob;
  assert.equal(b.id, second.id, "the second job runs once the first is done");
  await queue.complete(b, "done");
});

test("a handler that lost the lease only in memory is handed back while its lease is still held", async () => {
  const stop = new AbortController();
  let calls = 0;
  const worker = runWorker("L", db, queue, { run: async () => (++calls === 1 ? "lease-lost" : "done") }, { leaseMs: 60_000, pollMs: 50, signal: stop.signal, log: () => {} });
  const job = await queue.enqueue({ kind: "run", key: "k:t11:1" }, thread("t11"), {});
  for (let i = 0; i < 80 && calls < 2; i++) await sleep(50);
  stop.abort();
  await worker;
  assert.equal(calls, 2, "the job was claimed again instead of sitting leased until the lease expired");
  assert.deepEqual((await db.query<{ status: string; attempts: number }>("select status, attempts from jobs where id = $1", [job.id])).rows, [{ status: "done", attempts: 1 }]);
});
