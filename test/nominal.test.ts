import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Every error tsc reports for the compile-fail project: (file, line) for file errors, "global" for config errors. */
function tscErrors(): { file: string; line: number; code: string }[] {
  const run = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "test/compile-fail/tsconfig.json", "--noEmit", "--pretty", "false"], { cwd: root, encoding: "utf8" });
  return (run.stdout + run.stderr)
    .split("\n")
    .filter((l) => /\berror TS\d+/.test(l))
    .map((l) => {
      const m = /^(.*?)\((\d+),\d+\): error (TS\d+)/.exec(l);
      return m ? { file: m[1]!.replace(/\\/g, "/"), line: Number(m[2]), code: m[3]! } : { file: "global", line: 0, code: l };
    });
}

test("object literals cannot pose as Labelled or Prompt, and derive cannot mint a class from nothing", () => {
  const errors = tscErrors();
  assert.deepEqual(
    errors.map((e) => [e.file, e.line]),
    [
      ["test/compile-fail/forge.ts", 5],
      ["test/compile-fail/forge.ts", 6],
      ["test/compile-fail/forge.ts", 7],
      ["test/compile-fail/forge.ts", 8],
    ],
    `tsc reported: ${JSON.stringify(errors)}`,
  );
});
