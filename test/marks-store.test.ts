/** Marks go into the payload store with the content and come back out with it; a ref cannot shed them. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import { createPayloadStore, oneKey } from "../packages/core/src/record.ts";
import { parseRunJobPayload } from "../packages/core/src/frontdoor.ts";
import { freshDatabase } from "./db.ts";

const { db } = await freshDatabase("labh_test_marks");
after(() => db.end());
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, keyring: oneKey(randomBytes(32)) });

test("a marked payload reads back with its marks, and an unmarked one with none, as before", async () => {
  const marked = await store.put(Labelled.stamp("MRN 0012345", "D3", "gate:mrn", ["phi"]));
  assert.deepEqual(marked.marks, ["phi"]);
  const back = await store.get(marked);
  assert.ok(!("redacted" in back));
  assert.deepEqual((back as Labelled<unknown>).marks, ["phi"]);
  const plain = await store.put(Labelled.stamp("office hours", "D1", "gate:floor"));
  assert.equal("marks" in plain, false, "an unmarked ref has the shape every older record has");
  assert.deepEqual(((await store.get(plain)) as Labelled<unknown>).marks, []);
});

test("the same bytes marked and unmarked are two rows, and a ref with its marks removed does not decrypt", async () => {
  const marked = await store.put(Labelled.stamp("drawing 7", "D2", "gate", ["export-controlled"]));
  const plain = await store.put(Labelled.stamp("drawing 7", "D2", "gate"));
  assert.notEqual(marked.hash, plain.hash);
  const { marks: _dropped, ...stripped } = marked;
  await assert.rejects(store.get(stripped));
  await assert.rejects(store.get({ ...marked, marks: ["cui"] }));
});

test("a run job carries the input's marks through to the worker", () => {
  const ref = { hash: "h", cls: "D3", bytes: 3, marks: ["phi"] };
  const p = parseRunJobPayload({ agent: "a", kind: "interactive", trigger: { t: "test", memberId: "m" }, thread: "t", surface: "web", threadId: "1", input: ref, history: [{ hash: "g", cls: "D1", bytes: 1 }], studyId: null });
  assert.deepEqual(p.input.marks, ["phi"]);
  assert.equal("marks" in p.history[0]!, false);
});
