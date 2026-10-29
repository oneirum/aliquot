import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentPermissionFlags, PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { bootStudio } from "../packages/core/src/studio.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const MESSAGE = "lab.toml has a [tools] table, but contributed tool folders are not supported in v0.2. They are planned for v0.3. Remove [tools]: v0.2 runs only its built-in tools.";
const dir = realpathSync(mkdtempSync(join(tmpdir(), "tools-refused-")));
const cfg = join(dir, "lab.toml");
writeFileSync(cfg, '[endpoints.local]\nbase_url = "http://127.0.0.1:11434/v1"\nplacement = "lab"\n[tools]\ndir = "tools"\n');

const binaries: Record<string, readonly string[]> = {
  web: [...PERMISSION_FLAGS, "packages/core/bin/web.ts", "--config", cfg],
  worker: [...PERMISSION_FLAGS, "packages/core/bin/worker.ts", "--config", cfg],
  kb: [...PERMISSION_FLAGS, "packages/core/bin/kb.ts", "search", "--config", cfg],
  aliquot: [...PERMISSION_FLAGS, "packages/core/bin/aliquot.ts", "--config", cfg, "record", "00000000-0000-4000-8000-000000000001"],
  "agent-worker": [...agentPermissionFlags(dir), "packages/core/bin/agent-worker.ts", "--config", cfg, "--workspaces", dir],
};

for (const [name, args] of Object.entries(binaries)) {
  test(`${name} refuses a lab.toml with [tools] at startup, with the one message`, () => {
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" }, timeout: 30_000 });
    assert.deepEqual({ status: r.status, stderr: r.stderr }, { status: 2, stderr: `${MESSAGE}\n` });
  });
}

test("the studio refuses the same lab.toml with the same message", async () => {
  await assert.rejects(bootStudio(cfg), { message: MESSAGE });
});

test("aliquot --help prints its usage and exits 0", () => {
  const r = spawnSync(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/aliquot.ts", "--help"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" }, timeout: 30_000 });
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: "usage: aliquot [--config lab.toml] record <run-id>\n", stderr: "" });
});
