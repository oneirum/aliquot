import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import { createKbReader, loadManifest, memorySnapshots, saveSnapshot, snapshotFromFixture, storedSnapshots } from "../packages/core/src/kb.ts";
import { createPayloadStore } from "../packages/core/src/record.ts";
import { freshDatabase } from "./db.ts";

const { db } = await freshDatabase("labh_test_kb_store");
after(() => db.end());
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: randomBytes(32), keyId: "k1" });
const loaded = snapshotFromFixture(JSON.parse(await readFile(new URL("../fixtures/kb.json", import.meta.url), "utf8")), store.address);

test("a saved snapshot reads back from Postgres and the store with the same outline, reads and hits as in memory", async () => {
  await saveSnapshot(db, store, loaded.snapshot, loaded.entries);
  await saveSnapshot(db, store, loaded.snapshot, loaded.entries);
  const rows = await db.query<{ n: string }>("select count(*) as n from kb_snapshots");
  assert.equal(rows.rows[0]!.n, "1", "a second save is a no-op");
  const payloads = await db.query<{ hash: string }>("select hash from payloads order by hash");
  assert.deepEqual(
    payloads.rows.map((r) => r.hash),
    Object.values(loaded.snapshot.entries).sort(),
    "every entry body is stored under its entry hash, which is its keyed payload address",
  );

  const stored = createKbReader(storedSnapshots(db, store));
  const memory = createKbReader(memorySnapshots([loaded]));
  const id = loaded.snapshot.id;
  assert.deepEqual((await stored.outline(id)).value, (await memory.outline(id)).value);
  assert.deepEqual((await stored.search(id, "participant id data class", 3)).value, (await memory.search(id, "participant id data class", 3)).value);
  const read = await stored.read(id, ["equipment.md"], 15_000);
  assert.deepEqual(read.value.entries.map((e) => e.hash), [loaded.snapshot.entries["equipment.md"]]);
  assert.equal(read.cls, "D1");
  assert.deepEqual(await loadManifest(db, store.address, id), loaded.snapshot);
});

test("a tampered manifest is refused on load", async () => {
  const id = loaded.snapshot.id;
  await db.query("update kb_snapshots set manifest = jsonb_set(manifest, '{purpose}', '\"edited\"') where id = $1", [id]);
  await assert.rejects(loadManifest(db, store.address, id), /does not hash to its own id/);
});
