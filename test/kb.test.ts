import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { keyedAddresser } from "../packages/core/src/hash.ts";
import { buildBm25, createKbReader, diffSnapshots, entryHash, lineDiff, memorySnapshots, renderDiff, searchBm25, snapshotFromFixture, tokenize } from "../packages/core/src/kb.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/kb.json", import.meta.url), "utf8")) as unknown;
const address = keyedAddresser(randomBytes(32));
const loaded = snapshotFromFixture(fixture, address);

test("a fixture snapshot is addressed by its content under the store key, and its id follows its entries", () => {
  assert.equal(loaded.snapshot.kbId, "handbook");
  assert.equal(loaded.snapshot.cls, "D1");
  assert.match(loaded.snapshot.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(loaded.snapshot.entries).sort(), ["data-classes.md", "equipment.md", "office-hours.md", "onboarding.md"]);
  assert.equal(snapshotFromFixture(fixture, address).snapshot.id, loaded.snapshot.id);
  const otherKey = snapshotFromFixture(fixture, keyedAddresser(randomBytes(32)));
  assert.notEqual(otherKey.snapshot.id, loaded.snapshot.id, "the id is keyed: a reader of it cannot confirm a guessed manifest");
  assert.notEqual(otherKey.snapshot.entries["office-hours.md"], loaded.snapshot.entries["office-hours.md"], "and so is every entry hash");
  const edited = structuredClone(fixture) as { entries: { body: string }[] };
  edited.entries[0]!.body += " ";
  const other = snapshotFromFixture(edited, address);
  assert.notEqual(other.snapshot.id, loaded.snapshot.id);
  const d = diffSnapshots(loaded.snapshot, other.snapshot);
  assert.deepEqual({ added: d.added, removed: d.removed, changed: d.changed, sources: d.sources }, { added: [], removed: [], changed: ["office-hours.md"], sources: [] });
  assert.equal(snapshotFromFixture({ ...(fixture as object), entries: [...(fixture as { entries: unknown[] }).entries].reverse() }, address).snapshot.id, loaded.snapshot.id, "entry order does not change the id");
});

test("tokenize is NFKC, lowercase, unicode-aware and unstemmed", () => {
  assert.deepEqual(tokenize("Ｏffice-Hours: Tuesday's 2pm, naïve café!"), ["office", "hours", "tuesday", "s", "2pm", "naïve", "café"]);
});

test("bm25-v1 ranks the office hours entry first for an office hours question, with a stable score", () => {
  const index = buildBm25(loaded.entries);
  const hits = searchBm25(index, "when are the PI office hours", 3);
  assert.equal(hits[0]?.path, "office-hours.md");
  assert.equal(hits[0]?.hash, entryHash(address, loaded.snapshot.cls, loaded.entries.find((e) => e.path === "office-hours.md")!));
  assert.deepEqual(
    hits.map((h) => h.path),
    ["office-hours.md", "equipment.md", "onboarding.md"],
  );
  assert.equal(hits[0]?.score, 5.078176, "bm25-v1 is a frozen scorer: this number is part of what a study reproduces");
  assert.deepEqual(searchBm25(index, "zzzz nothing matches", 3), []);
});

test("the reader stamps results with the snapshot class and caps reads", async () => {
  const reader = createKbReader(memorySnapshots([loaded]));
  const outline = await reader.outline(loaded.snapshot.id);
  assert.equal(outline.cls, "D1");
  assert.equal(outline.origin, `kb:${loaded.snapshot.id}`);
  assert.equal(outline.value.title, "handbook", "a fixture without a title is titled by its id");
  assert.deepEqual(outline.value.paths, ["data-classes.md", "equipment.md", "office-hours.md", "onboarding.md"]);
  const hits = await reader.search(loaded.snapshot.id, "participant id data class", 2);
  assert.equal(hits.value[0]?.path, "data-classes.md");
  const capped = await reader.read(loaded.snapshot.id, ["office-hours.md", "data-classes.md", "nope.md", "onboarding.md"], 50);
  assert.deepEqual(
    { paths: capped.value.entries.map((e) => e.path), truncated: capped.value.truncated, omitted: capped.value.omitted, missing: capped.value.missing },
    { paths: ["office-hours.md"], truncated: true, omitted: ["data-classes.md", "onboarding.md"], missing: ["nope.md"] },
    "office-hours.md is 41 estimated tokens, data-classes.md would pass the 50 cap, and nothing after a cut is read",
  );
  const full = await reader.read(loaded.snapshot.id, ["office-hours.md", "data-classes.md"], 15_000);
  assert.equal(full.value.entries.length, 2);
  assert.equal(full.value.truncated, false);
  await assert.rejects(reader.search("0".repeat(64) as never, "x", 1), /is not loaded/);
});

test("renderDiff names the changed entry and only its changed lines", () => {
  const edited = structuredClone(fixture) as { entries: { path: string; body: string }[] };
  edited.entries.find((e) => e.path === "equipment.md")!.body = "The eye tracker lives in room 311.\nReturn cables to the labelled drawer.";
  edited.entries.push({ path: "parking.md", body: "No parking." } as never);
  (edited.entries.at(-1) as unknown as { title: string }).title = "Parking";
  const before = structuredClone(fixture) as { entries: { path: string; body: string }[] };
  before.entries.find((e) => e.path === "equipment.md")!.body = "The eye tracker lives in room 310.\nReturn cables to the labelled drawer.";
  const a = snapshotFromFixture(before, address);
  const b = snapshotFromFixture(edited, address);
  assert.equal(
    renderDiff(a, b),
    [
      `kb handbook: ${a.snapshot.id.slice(0, 12)} -> ${b.snapshot.id.slice(0, 12)}`,
      "+ parking.md",
      "    + # Parking",
      "    + No parking.",
      "~ equipment.md",
      "    - The eye tracker lives in room 310.",
      "    + The eye tracker lives in room 311.",
    ].join("\n"),
  );
  assert.match(renderDiff(a, a), /no changes$/);
});

test("lineDiff puts removals before additions and keeps common lines out", () => {
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a", "x", "c", "d"]), ["- b", "+ x", "+ d"]);
  assert.deepEqual(lineDiff([], ["a"]), ["+ a"]);
  assert.deepEqual(lineDiff(["a"], []), ["- a"]);
});
