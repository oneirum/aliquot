import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadAudit } from "../packages/core/src/audit.ts";
import { DEFAULT_POLICY, Labelled, type DataClass } from "../packages/core/src/dataclass.ts";
import { createPayloadStore, KeyNotHeld, labAddressKey, payloadStates, PayloadUnavailable, verifyChain, type Keyring, type PayloadRef, type RunEvent, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { recordViewOf } from "../packages/core/src/record-view.ts";
import { recordPage } from "../packages/core/src/surfaces/web-pages.ts";
import { readReplies } from "../packages/core/src/surfaces/web.ts";
import { pastRetention, reencryptAll, sweepRetention } from "../packages/core/src/steward.ts";
import { freshDatabase } from "./db.ts";
import { chain, started } from "./events.ts";

const { db } = await freshDatabase("labh_test_keys");
after(() => db.end());

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const k3 = randomBytes(32);
const ring = (keys: Record<string, Buffer>, current: string, classKeys: Keyring["classKeys"] = {}): Keyring => ({ keys: new Map(Object.entries(keys)), current, classKeys });
const open = async (keyring: Keyring) => createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, keyring, addressKey: await labAddressKey(db, keyring) });
const body = (value: unknown, cls: DataClass = "D1") => Labelled.stamp(value, cls, "test");
const read = async (store: Awaited<ReturnType<typeof open>>, ref: PayloadRef) => {
  const got = await store.get(ref);
  return "redacted" in got ? "(redacted)" : got.value;
};
const keyOf = async (ref: PayloadRef) => {
  const s = (await payloadStates(db, [ref.hash])).get(ref.hash);
  return s?.t === "stored" ? s.keyId : s?.t;
};

test("a rotation reads old and new payloads mid-rotation, re-encrypts without moving a hash, and then needs only the new key", async () => {
  const before = await open(ring({ k1 }, "k1"));
  const old = await before.put(body({ text: "freezer 3 alarm" }));
  assert.equal(await keyOf(old), "k1");

  const mid = await open(ring({ k1, k2 }, "k2"));
  const fresh = await mid.put(body({ text: "asked after the rotation" }));
  assert.equal(await keyOf(fresh), "k2", "new writes go under the current key");
  assert.deepEqual(await read(mid, old), { text: "freezer 3 alarm" }, "mid-rotation, a k1 body still opens");
  assert.deepEqual(await read(mid, fresh), { text: "asked after the rotation" }, "and so does a k2 body");
  assert.equal(mid.address("D1", { text: "freezer 3 alarm" }), old.hash, "the address of old bytes did not move with the key");

  assert.equal(await reencryptAll(db, mid, ring({ k1, k2 }, "k2"), "test", 1), 1);
  assert.equal(await keyOf(old), "k2", "the old body is under k2 now");
  assert.equal(await reencryptAll(db, mid, ring({ k1, k2 }, "k2"), "test"), 0, "a second run finds nothing to move");
  assert.equal((await loadAudit(db)).filter((r) => r.event.t === "keys.reencrypted").length, 1, "only the run that moved something is audited");

  const after = await open(ring({ k2 }, "k2"));
  assert.deepEqual(await read(after, old), { text: "freezer 3 alarm" }, "with k1 gone, the re-encrypted body opens under k2 alone");
  assert.equal(after.address("D1", { text: "freezer 3 alarm" }), old.hash, "and addresses still match the hashes in the record");
  assert.equal((await after.put(body({ text: "freezer 3 alarm" }))).hash, old.hash, "the same bytes dedupe to the same row");

  await assert.rejects(open(ring({ k1: k3 }, "k1")), /payload key k1 is not the key this lab knows as k1/, "a wrong key under a known id is refused at startup");
  await assert.rejects(open(ring({ k1, k2: k3 }, "k2")), /payload key k2 is not the key this lab knows as k2/, "every held key is checked, not only the first that unwraps");
});

test("a class that names its own key is written under it, and a process without that key says the body is unavailable", async () => {
  const withD3 = await open(ring({ k2, k3 }, "k2", { D3: "k3" }));
  const roster = await withD3.put(body({ participant: "P-10422" }, "D3"));
  assert.equal(await keyOf(roster), "k3");
  assert.deepEqual(await read(withD3, roster), { participant: "P-10422" });

  const without = await open(ring({ k2 }, "k2", { D3: "k3" }));
  await assert.rejects(without.get(roster), (err: unknown) => err instanceof PayloadUnavailable && err.why === "key-mismatch" && /under key k3, which this process does not hold/.test(err.message));
  await assert.rejects(without.put(body({ participant: "P-10999" }, "D3")), (err: unknown) => err instanceof KeyNotHeld && err.message === "D3 payloads are stored under key k3, which this process does not hold");
  assert.deepEqual(await read(without, await without.put(body({ text: "D1 still works" }))), { text: "D1 still works" });
});

async function insertRun(runId: RunId, events: readonly RunEvent[], startMs: number): Promise<StoredEvent[]> {
  const stored = chain(events, startMs, runId);
  await db.query("insert into jobs (id, kind, key, payload) values ($1, 'run', $2, '{}')", [runId, runId]);
  for (const e of stored) await db.query("insert into run_events (run_id, seq, at, cls, prev_hash, hash, event) values ($1, $2, $3, $4, $5, $6, $7)", [e.runId, e.seq, e.at, e.cls, e.prevHash, e.hash, e.event]);
  return stored;
}

test("the retention sweep redacts bodies whose newest run is past the window, keeps tombstones, and every chain still verifies", async () => {
  const store = await open(ring({ k2 }, "k2"));
  const question = await store.put(body({ text: "how cold is freezer 3?" }));
  const answer = await store.put(body({ text: "minus eighty" }));
  const publicNote = await store.put(body({ text: "see the SOP" }, "D0"));
  const followUp = await store.put(body({ text: "and freezer 4?" }));
  const oldRun = "00000000-0000-4000-8000-0000000000a1" as RunId;
  const newRun = "00000000-0000-4000-8000-0000000000a2" as RunId;
  const oldEvents = await insertRun(oldRun, [started(question), { t: "run.finished", outcome: "answered", answer, reason: null, flags: [] }, { t: "inbox.consumed", inboxId: "i1", item: { t: "steer", text: publicNote, by: "alice" } }], Date.parse("2026-01-10T00:00:00Z"));
  await insertRun(newRun, [{ ...(started(followUp) as Extract<RunEvent, { t: "run.started" }>), history: [question] }], Date.parse("2026-05-01T00:00:00Z"));
  const reply = "Freezer 3 runs at minus eighty.";
  await db.query("insert into web_messages (run_id, thread_id, kind, text) values ($1, 't', 'reply', $2), ($3, 't', 'reply', 'Freezer 4 too.')", [oldRun, reply, newRun]);
  const retention = { purgeDays: { D1: 30 }, keepMinDays: {} };

  const floored = await pastRetention(db, { purgeDays: { D1: 30 }, keepMinDays: { D1: 60 } }, new Date("2026-03-01T00:00:00Z"));
  assert.deepEqual(floored, [], "a body 50 days unused is under a 60-day floor, whatever the purge says");
  const preview = await pastRetention(db, retention, new Date("2026-03-01T00:00:00Z"));
  assert.deepEqual(preview.map((c) => [c.hash, c.runs]), [[answer.hash, [oldRun]]], "the question is still in a later turn's history, and D0 has no window");
  assert.equal(await keyOf(answer), "k2", "a preview changes nothing");

  const summaryBefore = (await recordViewOf(db, oldRun, oldEvents, store.held)).summary;
  const swept = await sweepRetention(db, retention, new Date("2026-03-01T00:00:00Z"), "steward");
  assert.deepEqual(swept.redacted.map((c) => c.hash), [answer.hash]);
  assert.deepEqual(swept.audit.event, { t: "retention.swept", purgeDays: { D1: 30 }, keepMinDays: {}, asOf: "2026-03-01T00:00:00.000Z", redacted: 1, bytes: answer.bytes, runs: 1, replies: 1 });
  const replyText = async (run: RunId) => (await db.query<{ text: string }>("select text from web_messages where run_id = $1", [run])).rows[0]!.text;
  assert.equal(await replyText(oldRun), "", "the door's plaintext copy of the redacted answer is gone");
  assert.equal((await db.query("select 1 from web_messages where text like '%minus eighty%'")).rowCount, 0);
  assert.deepEqual((await readReplies(db, oldRun)).map((r) => r.text), [`Redacted on ${new Date().toISOString().slice(0, 10)} by the lab's retention window.`]);
  assert.equal(await replyText(newRun), "Freezer 4 too.", "a run whose answer is kept keeps its reply");
  assert.equal(await read(store, answer), "(redacted)");
  assert.deepEqual(await read(store, question), { text: "how cold is freezer 3?" });
  const tomb = (await db.query("select hash, cls, bytes, ciphertext, redacted_at, redaction_reason from payloads where hash = $1", [answer.hash])).rows[0];
  assert.ok(tomb && Date.now() - (tomb.redacted_at as Date).getTime() < 60_000, "the tombstone records when the sweep ran, not the date it judged the window by");
  assert.deepEqual({ ...tomb, redacted_at: null }, { hash: answer.hash, cls: "D1", bytes: answer.bytes, ciphertext: null, redacted_at: null, redaction_reason: "retention" });
  await assert.rejects(db.query("update payloads set redacted_at = now() where hash = $1", [answer.hash]), /tombstone is written once/);

  const view = await recordViewOf(db, oldRun, oldEvents, store.held);
  assert.equal(view.chain.firstBad, null, "the chain verifies after the redaction");
  assert.equal(verifyChain(oldEvents), null);
  assert.deepEqual(view.summary, summaryBefore, "the summary still counts the redacted run");
  assert.deepEqual(
    view.bodies.map((b) => [b.seq, b.role, b.state]),
    [
      [0, "input", "stored"],
      [1, "answer", "redacted"],
      [2, "steer", "stored"],
    ],
  );
  const redacted = view.bodies[1]!;
  assert.deepEqual(redacted, { hash: answer.hash, cls: "D1", bytes: answer.bytes, seq: 1, t: "run.finished", role: "answer", state: "redacted", at: (tomb!.redacted_at as Date).toISOString(), reason: "retention" });
  const page = recordPage(view);
  assert.ok(page.includes(`"state":"redacted"`) && page.includes(answer.hash), "the record page carries the redacted body and its hash");
  assert.ok(page.includes("by the lab's retention window"), "and the line it shows for it");

  const again = await sweepRetention(db, retention, new Date("2026-03-01T00:00:00Z"), "steward");
  assert.equal(again.redacted.length, 0, "a second sweep redacts nothing");
  assert.deepEqual((await loadAudit(db)).filter((r) => r.event.t === "retention.swept").map((r) => (r.event as { redacted: number }).redacted), [1, 0], "and each sweep is audited");
  assert.deepEqual((await sweepRetention(db, retention, new Date("2026-07-01T00:00:00Z"), "steward")).redacted.map((c) => c.hash).sort(), [question.hash, followUp.hash].sort(), "once the later run is past the window too, its bodies go");

  const asked = await store.put(body({ text: "how cold is freezer 3?" }));
  assert.equal(asked.hash, question.hash, "asking the same question again addresses the tombstoned row");
  assert.deepEqual(await read(store, asked), { text: "how cold is freezer 3?" }, "and the put stores its body again, so a run on it can read it");
  assert.equal(await keyOf(asked), "k2", "under the current key");
  assert.deepEqual((await db.query("select redacted_at, redaction_reason from payloads where hash = $1", [question.hash])).rows[0], { redacted_at: null, redaction_reason: null });
  await assert.rejects(db.query("update payloads set redacted_at = null, redaction_reason = null where hash = $1", [followUp.hash]), /tombstone is written once/, "a tombstone is cleared only by a new body");
});
