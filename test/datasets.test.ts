import { test, after } from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMount } from "../packages/core/src/datasets.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "datasets-")));
after(() => rm(root, { recursive: true, force: true }));

test("a dataset file that is a hard link to a file elsewhere is refused, and a plain copy is not", async () => {
  await writeFile(join(root, "restricted.csv"), "id,diagnosis\n");
  await mkdir(join(root, "cohort"));
  await link(join(root, "restricted.csv"), join(root, "cohort", "notes.csv"));
  assert.deepEqual(await checkMount({ id: "cohort", path: join(root, "cohort"), cls: "D1", description: "c" }), { ok: false, reason: "dataset cohort: notes.csv has 2 hard links; copy the file into the dataset instead" });
  await rm(join(root, "cohort", "notes.csv"));
  await writeFile(join(root, "cohort", "notes.csv"), "id,diagnosis\n");
  assert.deepEqual(await checkMount({ id: "cohort", path: join(root, "cohort"), cls: "D1", description: "c" }), { ok: true, hostPath: join(root, "cohort") });
});
