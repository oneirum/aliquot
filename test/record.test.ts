import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { canonicalJson, sha256 } from "../packages/core/src/hash.ts";
import { Labelled, DEFAULT_POLICY, decideEgress } from "../packages/core/src/dataclass.ts";
import { LeaseLost, PayloadUnavailable, RecordCorrupt, StoreRefused, createPayloadStore, fold, loadEvents, openJournal, sendToInbox, verifyChain, type RunId } from "../packages/core/src/record.ts";
import { createQueue } from "../packages/core/src/queue.ts";
import type { Db } from "../packages/core/src/db.ts";
import { freshDatabase } from "./db.ts";
import { AGENT, TARGET, chain, ref, started } from "./events.ts";

test("fold of a crash-cut tool call shows the open attempt and the pending answer", () => {
  const events = chain([
    started(ref("q", "D2")),
    { t: "model.requested", step: 1, attempt: 1, target: TARGET, prompt: ref("p", "D2"), final: false },
    {
      t: "model.completed",
      step: 1,
      attempt: 1,
      providerModelId: "scripted-1",
      output: ref("o1", "D2"),
      toolCalls: [{ id: "c1", name: "kb_search", args: ref("a1", "D2") }],
      usage: { input: 10, output: 5 },
      ms: 3,
    },
    { t: "tool.requested", callId: "c1", attempt: 1, tool: "kb_search", hash: "h".repeat(64) as never, input: ref("a1", "D2") },
  ]);
  const s = fold(events);
  assert.equal(s.agent, AGENT);
  assert.equal(s.cls, "D2");
  assert.equal(s.steps, 1);
  assert.equal(s.tokens, 15);
  assert.equal(s.answer, null);
  assert.deepEqual(s.modelCall, { step: 1, attempts: 1, final: false, status: "completed", lastFailure: null });
  assert.deepEqual(s.toolCalls, [{ callId: "c1", tool: "kb_search", input: ref("a1", "D2"), attempts: 1, status: "open", lastFailure: null, confirmAsked: false }]);
  assert.deepEqual(
    s.transcript.map((t) => t.role),
    ["user", "assistant"],
  );
});

test("fold resolves a tool after its third failure with an error the agent sees", () => {
  const completed = {
    t: "model.completed",
    step: 1,
    attempt: 1,
    providerModelId: "scripted-1",
    output: ref("o1"),
    toolCalls: [{ id: "c1", name: "kb_search", args: ref("a1") }],
    usage: { input: 1, output: 1 },
    ms: 1,
  } as const;
  const events = chain([
    started(),
    { t: "model.requested", step: 1, attempt: 1, target: TARGET, prompt: ref("p"), final: false },
    completed,
    { t: "tool.requested", callId: "c1", attempt: 1, tool: "kb_search", hash: "h".repeat(64) as never, input: ref("a1") },
    { t: "tool.failed", callId: "c1", attempt: 1, failure: { code: "thrown", detail: ref("boom", "D2") }, retryable: true },
    { t: "tool.requested", callId: "c1", attempt: 2, tool: "kb_search", hash: "h".repeat(64) as never, input: ref("a1") },
    { t: "tool.failed", callId: "c1", attempt: 2, failure: { code: "thrown", detail: ref("boom", "D2") }, retryable: true },
  ]);
  assert.equal(fold(events).toolCalls[0]?.status, "failed");
  const third = chain([
    ...events.map((e) => e.event),
    { t: "tool.requested", callId: "c1", attempt: 3, tool: "kb_search", hash: "h".repeat(64) as never, input: ref("a1") },
    { t: "tool.failed", callId: "c1", attempt: 3, failure: { code: "thrown", detail: ref("boom", "D2") }, retryable: true },
  ]);
  const s = fold(third);
  assert.equal(s.toolCalls[0]?.status, "resolved");
  assert.deepEqual(s.transcript.at(-1), { role: "tool", callId: "c1", name: "kb_search", result: { t: "error", failure: { code: "thrown", detail: ref("boom", "D2") } } });
  assert.equal(third.at(-1)?.cls, "D2", "a failure event takes the class of its detail payload");
});

test("fold treats a stop before the first step as confirmed and a later one as a question", () => {
  const base = [started(), { t: "inbox.consumed", inboxId: "i1", item: { t: "stop", confirmed: false, by: "alice" } }] as const;
  assert.equal(fold(chain([...base])).stop, "confirmed");
  const later = chain([
    started(),
    { t: "model.requested", step: 1, attempt: 1, target: TARGET, prompt: ref("p"), final: false },
    { t: "model.completed", step: 1, attempt: 1, providerModelId: "scripted-1", output: ref("o"), toolCalls: [{ id: "c1", name: "kb_search", args: ref("a") }], usage: { input: 1, output: 1 }, ms: 1 },
    { t: "inbox.consumed", inboxId: "i1", item: { t: "stop", confirmed: false, by: "alice" } },
  ]);
  assert.equal(fold(later).stop, "requested-unconfirmed");
  const twice = chain([...later.map((e) => e.event), { t: "inbox.consumed", inboxId: "i2", item: { t: "stop", confirmed: false, by: "alice" } }]);
  assert.equal(fold(twice).stop, "confirmed");
});

test("verifyChain finds the first tampered, reordered or misclassed event", () => {
  const events = chain([started(), { t: "model.requested", step: 1, attempt: 1, target: TARGET, prompt: ref("p"), final: false }, { t: "limit.hit", which: "steps" }]);
  assert.equal(verifyChain(events), null);
  const tampered = events.map((e, i) => (i === 1 ? { ...e, event: { ...e.event, attempt: 2 } } : e));
  assert.equal(verifyChain(tampered as typeof events), 1);
  const misclassed = events.map((e, i) => (i === 1 ? { ...e, cls: "D0" as const } : e));
  assert.equal(verifyChain(misclassed), 1);
  assert.equal(verifyChain([events[0]!, events[2]!]), 1);
});

const { db } = await freshDatabase("labh_test_record");
after(() => db.end());
const storeKey = randomBytes(32);
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: storeKey, keyId: "k1" });

test("a content address is the HMAC of the class and the plaintext under an HKDF address subkey, so a hash alone confirms nothing", async () => {
  const value = { text: "participant P-12345 withdrew" };
  const r = await store.put(Labelled.stamp(value, "D3", "test"));
  const plaintext = canonicalJson(value);
  assert.notEqual(r.hash, sha256(plaintext), "an unkeyed digest of a guessed body would match the address");
  assert.notEqual(r.hash, createHmac("sha256", storeKey).update(plaintext).digest("hex"), "the master key is never the address key");
  const addressKey = Buffer.from(hkdfSync("sha256", storeKey, "", "labh:payload:address:v1", 32));
  assert.equal(r.hash, createHmac("sha256", addressKey).update(`D3\n${plaintext}`).digest("hex"));
  const cipherKey = Buffer.from(hkdfSync("sha256", storeKey, "", "labh:payload:cipher:v1", 32));
  const row = (await db.query<{ ciphertext: Buffer; nonce: Buffer }>("select ciphertext, nonce from payloads where hash = $1", [r.hash])).rows[0]!;
  const decipher = createDecipheriv("aes-256-gcm", cipherKey, row.nonce);
  decipher.setAAD(Buffer.from(r.hash));
  decipher.setAuthTag(row.ciphertext.subarray(row.ciphertext.length - 16));
  assert.equal(Buffer.concat([decipher.update(row.ciphertext.subarray(0, row.ciphertext.length - 16)), decipher.final()]).toString("utf8"), plaintext, "the body decrypts under the cipher subkey, not the master");
  const otherKey = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: randomBytes(32), keyId: "k9" });
  assert.notEqual((await otherKey.put(Labelled.stamp(value, "D3", "test"))).hash, r.hash, "the same bytes under another key have another address");
});

test("payload store round-trips a body, dedupes by content within a class and refuses what the DB placement may not hold", async () => {
  const a = await store.put(Labelled.stamp({ text: "hello" }, "D1", "test"));
  const again = await store.put(Labelled.stamp({ text: "hello" }, "D1", "test"));
  const b = await store.put(Labelled.stamp({ text: "hello" }, "D3", "test"));
  assert.equal(a.hash, again.hash, "the same bytes at the same class are one row");
  assert.notEqual(a.hash, b.hash, "the same bytes at another class are another row");
  assert.equal(a.bytes, 16);
  const got = await store.get(a);
  assert.ok(!("redacted" in got));
  assert.deepEqual(got.value, { text: "hello" });
  assert.equal(got.cls, "D1", "a row's class is the class it was put under");
  assert.equal(!("redacted" in (await store.get(b))) && (await store.get(b)).cls, "D3");
  const raw = await db.query<{ ciphertext: Buffer }>("select ciphertext from payloads where hash = $1", [a.hash]);
  assert.ok(!raw.rows[0]!.ciphertext.toString("utf8").includes("hello"), "bodies are not stored in the clear");
  const hosted = createPayloadStore(db, { placement: "zdr", policy: DEFAULT_POLICY, key: randomBytes(32), keyId: "k2" });
  await assert.rejects(hosted.put(Labelled.stamp("x", "D1", "test")), (err: unknown) => err instanceof StoreRefused && err.refusal.code === "destination-receives-nothing");
  await db.query("update payloads set ciphertext = null, nonce = null where hash = $1", [a.hash]);
  assert.deepEqual(await store.get(a), { redacted: true, hash: a.hash, cls: "D1" });
});

test("the store refuses a forged label, whether parsed from JSON or built on the prototype", async () => {
  const real = Labelled.stamp({ text: "forged" }, "D1", "test");
  const parsed = JSON.parse(JSON.stringify(real)) as Labelled<unknown>;
  const created = Object.assign(Object.create(Labelled.prototype), { value: real.value, cls: "D0", origin: "nowhere" }) as Labelled<unknown>;
  for (const forged of [parsed, created]) await assert.rejects(store.put(forged), (err: unknown) => err instanceof StoreRefused && err.refusal.code === "unlabelled");
  assert.equal((await db.query("select 1 from payloads where cls = 'D0'")).rowCount, 0, "nothing was stored at the forged class");
});

test("the thanks probe: a D0 run's own bytes stay D0 after a D3 channel stored the same bytes, and a ref cannot read a row of another class", async () => {
  const fromD3Channel = await store.put(Labelled.stamp("thanks", "D3", "gate:channel-floor"));
  const fromD0Run = await store.put(Labelled.stamp("thanks", "D0", "gate:floor"));
  const got = await store.get(fromD0Run);
  assert.ok(!("redacted" in got));
  assert.equal(got.cls, "D0", "a D0 user's thanks reads back as what the D0 run stored");
  assert.notEqual(fromD0Run.hash, fromD3Channel.hash, "one row never spans two classes");
  assert.equal(decideEgress(got, { kind: "model", endpointId: "hosted", placement: "zdr" }, DEFAULT_POLICY).allow, true, "the D0 user's thanks reaches the hosted model");
  const high = await store.get(fromD3Channel);
  assert.equal(!("redacted" in high) && high.cls, "D3");
  assert.equal(decideEgress(high as Labelled<unknown>, { kind: "model", endpointId: "hosted", placement: "zdr" }, DEFAULT_POLICY).allow, false);
  await assert.rejects(store.get({ ...fromD0Run, cls: "D3" }), (err: unknown) => err instanceof PayloadUnavailable && err.why === "class-mismatch");
});

async function leasedRun(key: string): Promise<RunId> {
  const res = await db.query<{ id: string }>(
    "insert into jobs (kind, key, status, lease_owner, lease_epoch, lease_until, payload) values ('run', $1, 'leased', 'A', 1, now() + interval '1 minute', '{}') returning id",
    [key],
  );
  return res.rows[0]!.id as RunId;
}

test("journal appends a verifiable chain and a stale epoch cannot append", async () => {
  const runId = await leasedRun("j1");
  const a = await openJournal(db, store, { runId, epoch: 1, owner: "A" });
  const e0 = await a.append(started());
  assert.equal(e0.seq, 0);
  assert.equal(e0.prevHash, null);
  await a.append({ t: "model.requested", step: 1, attempt: 1, target: TARGET, prompt: ref("p"), final: false });
  assert.equal(verifyChain(await loadEvents(db, runId)), null);

  await db.query("update jobs set lease_owner = 'B', lease_epoch = 2 where id = $1", [runId]);
  await assert.rejects(a.append({ t: "limit.hit", which: "steps" }), LeaseLost);
  const b = await openJournal(db, store, { runId, epoch: 2, owner: "B" });
  const e2 = await b.append({ t: "limit.hit", which: "steps" });
  assert.equal(e2.seq, 2);
  await assert.rejects(a.append({ t: "limit.hit", which: "wall" }), LeaseLost);
  const rows = await loadEvents(db, runId);
  assert.deepEqual(
    rows.map((r) => r.event.t),
    ["run.started", "model.requested", "limit.hit"],
  );
  assert.equal(verifyChain(rows), null);
});

test("two holders racing for the same seq: exactly one insert wins", async () => {
  const runId = await leasedRun("j2");
  const a = await openJournal(db, store, { runId, epoch: 1, owner: "A" });
  await a.append(started());
  const b = await openJournal(db, store, { runId, epoch: 1, owner: "A" });
  await a.append({ t: "limit.hit", which: "steps" });
  await assert.rejects(b.append({ t: "limit.hit", which: "wall" }), LeaseLost);
  assert.equal((await loadEvents(db, runId)).length, 2);
});

test("an append that races a claim loses: the stale holder writes nothing and the new holder never collides", async () => {
  const runId = await leasedRun("j6");
  await db.query("update jobs set lease_until = now() - interval '1 second' where id = $1", [runId]);
  const a = await openJournal(db, store, { runId, epoch: 1, owner: "A" });
  await a.append(started());

  // B's claim is open in a transaction: epoch 2 written, row locked, not yet committed.
  const client = await db.connect();
  const onClient = { query: (...args: Parameters<Db["query"]>) => client.query(...args), connect: async () => client } as unknown as Db;
  await client.query("begin");
  const claimed = await createQueue(onClient).claim("B", ["run"], 60_000);
  assert.equal(claimed?.epoch, 2);
  // A's append starts now and must wait for the row, then see the moved epoch.
  const stale = a.append({ t: "limit.hit", which: "steps" });
  await new Promise((r) => setTimeout(r, 100));
  await client.query("commit");
  client.release();
  await assert.rejects(stale, LeaseLost, "the stale holder's append must not land after the claim committed");

  const b = await openJournal(db, store, { runId, epoch: 2, owner: "B" });
  assert.equal(b.events().length, 1, "only run.started is on the record");
  const next = await b.append({ t: "limit.hit", which: "tokens" });
  assert.equal(next.seq, 1, "the new holder appends without a collision");
});

test("inbox items are consumed once, in one transaction with their event", async () => {
  const runId = await leasedRun("j3");
  const j = await openJournal(db, store, { runId, epoch: 1, owner: "A" });
  await j.append(started());
  const id = await sendToInbox(db, runId, { t: "stop", confirmed: false, by: "alice" });
  const pending = await j.pendingInbox();
  assert.deepEqual(pending, [{ id, item: { t: "stop", confirmed: false, by: "alice" } }]);
  const stored = await j.consumeInbox(id, pending[0]!.item);
  assert.equal(stored.seq, 1);
  assert.deepEqual(await j.pendingInbox(), []);
  const mark = await db.query<{ consumed_seq: number }>("select consumed_seq from run_inbox where id = $1", [id]);
  assert.equal(mark.rows[0]!.consumed_seq, 1);
  assert.equal(fold(j.events()).stop, "confirmed");
});

test("a blip inside consumeInbox leaves the in-memory chain intact, and the next consume lands", async () => {
  const runId = await leasedRun("j7");
  let blips = 1;
  const real = await db.connect();
  const flaky = {
    query: (...args: Parameters<Db["query"]>) => db.query(...args),
    connect: async () => ({
      query: async (...args: Parameters<Db["query"]>) => {
        if (blips > 0 && String(args[0]).startsWith("begin")) {
          blips -= 1;
          throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
        }
        return real.query(...args);
      },
      release: () => {},
    }),
  } as unknown as Db;
  try {
    const j = await openJournal(flaky, store, { runId, epoch: 1, owner: "A" });
    await j.append(started());
    const item = { t: "stop", confirmed: true, by: "alice" } as const;
    const id = await sendToInbox(db, runId, item);
    await assert.rejects(j.consumeInbox(id, item), /Connection terminated/);
    assert.equal(j.events().length, 1, "the blip dropped nothing from memory");
    assert.equal((await j.consumeInbox(id, item)).seq, 1, "the retried consume takes the next seq");
    assert.equal(verifyChain(await loadEvents(db, runId)), null);
  } finally {
    real.release();
  }
});

test("run_events refuses updates and deletes at the database level", async () => {
  const runId = await leasedRun("j4");
  const j = await openJournal(db, store, { runId, epoch: 1, owner: "A" });
  await j.append(started());
  await assert.rejects(db.query("update run_events set event = '{}' where run_id = $1 and seq = 0", [runId]), /run_events is insert-only/);
  await assert.rejects(db.query("delete from run_events where run_id = $1", [runId]), /run_events is insert-only/);
  assert.equal((await loadEvents(db, runId)).length, 1);
});

test("payloads rows allow only a redaction and a key rewrap; the class and the address never change", async () => {
  const r = await store.put(Labelled.stamp({ text: "guarded" }, "D1", "test"));
  await assert.rejects(db.query("delete from payloads where hash = $1", [r.hash]), /payloads is insert-only/);
  await assert.rejects(db.query("update payloads set cls = 'D0' where hash = $1", [r.hash]), /immutable/);
  await assert.rejects(db.query("update payloads set cls = 'D2' where hash = $1", [r.hash]), /immutable/);
  await assert.rejects(db.query("update payloads set ciphertext = 'x'::bytea where hash = $1", [r.hash]), /redact.*or rewrap/);
  await assert.rejects(db.query("update payloads set key_id = 'k2' where hash = $1", [r.hash]), /redact.*or rewrap/);
  await assert.rejects(db.query("update payloads set hash = 'other' where hash = $1", [r.hash]), /immutable/);
  await db.query("update payloads set ciphertext = 'y'::bytea, nonce = 'n'::bytea, key_id = 'k2' where hash = $1", [r.hash]);
  await assert.rejects(store.get(r), (err: unknown) => err instanceof PayloadUnavailable && err.why === "key-mismatch", "a rewrapped row reads only under its new key");
  await db.query("update payloads set ciphertext = null, nonce = null where hash = $1", [r.hash]);
  assert.deepEqual(await store.get(r), { redacted: true, hash: r.hash, cls: "D1" });
  await assert.rejects(db.query("update payloads set ciphertext = 'z'::bytea, nonce = 'n'::bytea, key_id = 'k3' where hash = $1", [r.hash]), /redact.*or rewrap/, "a redacted body cannot come back");
});

test("the chain head is anchored on the job and a resume refuses a record that does not match it", async () => {
  const runId = await leasedRun("j5");
  const a = await openJournal(db, store, { runId, epoch: 1, owner: "A" });
  await a.append(started());
  await a.append({ t: "limit.hit", which: "steps" });
  const last = await a.append({ t: "limit.hit", which: "tokens" });
  const anchor = () => db.query<{ head_seq: number; head_hash: string }>("select head_seq, head_hash from jobs where id = $1", [runId]);
  assert.deepEqual((await anchor()).rows, [{ head_seq: 2, head_hash: last.hash }]);
  const resumed = await openJournal(db, store, { runId, epoch: 1, owner: "A" });
  assert.equal(resumed.events().length, 3);

  await db.query("alter table run_events disable trigger run_events_immutable");
  try {
    await db.query("delete from run_events where run_id = $1 and seq = 2", [runId]);
    await assert.rejects(openJournal(db, store, { runId, epoch: 1, owner: "A" }), (err: unknown) => err instanceof RecordCorrupt && /anchor/.test(err.message));
    await db.query("update jobs set head_seq = 1, head_hash = (select hash from run_events where run_id = $1 and seq = 1) where id = $1", [runId]);
    await db.query("update run_events set event = jsonb_set(event, '{which}', '\"wall\"') where run_id = $1 and seq = 1", [runId]);
    await assert.rejects(openJournal(db, store, { runId, epoch: 1, owner: "A" }), (err: unknown) => err instanceof RecordCorrupt && /seq 1/.test(err.message));
  } finally {
    await db.query("alter table run_events enable trigger run_events_immutable");
  }
});

test("agent_versions refuses updates and deletes at the database level", async () => {
  await db.query("insert into agent_versions (hash, agent_id, body) values ('v1', 'a', '{}')");
  await assert.rejects(db.query("update agent_versions set body = '{\"x\":1}' where hash = 'v1'"), /agent_versions is insert-only/);
  await assert.rejects(db.query("delete from agent_versions where hash = 'v1'"), /agent_versions is insert-only/);
  assert.deepEqual((await db.query<{ body: unknown }>("select body from agent_versions where hash = 'v1'")).rows[0]!.body, {});
});
