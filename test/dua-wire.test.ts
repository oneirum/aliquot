/**
 * DUAs on the wire: the lab0 DUA scenario (scripts/dua-lab.ts) through the real web door and worker, with every
 * request each fake model received. A member a DUA does not name gets no entry text in any model request; an expired
 * DUA refuses a member it names; a named member's question to an agent on a hosted model is refused at the door with
 * zero hosted requests, because a DUA's class is never one a hosted model reads.
 */
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDuaWalk, duaWalk } from "../scripts/dua-lab.ts";

test("DUA-bound entries reach only the members a live DUA names, and never a hosted model", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  checkDuaWalk(await duaWalk(root, mkdtempSync(join(tmpdir(), "labh-dua-")), "labh_test_dua"));
});
