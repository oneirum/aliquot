import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { faultsAllowed } from "../packages/core/src/worker.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("fault injection is allowed only when a test harness says so, and never in production", () => {
  assert.equal(faultsAllowed({}), false);
  assert.equal(faultsAllowed({ LABH_FAULTS: "1" }), true);
  assert.equal(faultsAllowed({ LABH_FAULTS: "1", NODE_ENV: "production" }), false);
  assert.equal(faultsAllowed({ LABH_FAULTS: "yes" }), false);
});

const run = (flags: readonly string[], args: readonly string[], env: Record<string, string>) => spawnSync(process.execPath, [...flags, "packages/core/bin/worker.ts", "--config", "does-not-exist.toml", ...args], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

test("the binaries refuse to start outside the permission model, or with child processes, workers or addons allowed", () => {
  const bare = run([], [], {});
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /runs only under the permission model/);
  const open = run([...PERMISSION_FLAGS, "--allow-child-process", "--allow-worker"], [], {});
  assert.equal(open.status, 2);
  assert.match(open.stderr, /must deny child, worker/);
  const web = spawnSync(process.execPath, ["packages/core/bin/web.ts", "--config", "does-not-exist.toml"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(web.status, 2);
  assert.match(web.stderr, /runs only under the permission model/);
});

test("the worker binary refuses --fault and --plant-tool without the harness variable, before it reads any config", () => {
  const bare = run(PERMISSION_FLAGS, ["--fault", "kill-after:stop"], {});
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /need LABH_FAULTS=1/);
  const plant = run(PERMISSION_FLAGS, ["--plant-tool", "test/plants/fetch-tool.ts"], {});
  assert.equal(plant.status, 2);
  assert.match(plant.stderr, /need LABH_FAULTS=1/);
  const prod = run(PERMISSION_FLAGS, ["--fault", "kill-after:stop"], { LABH_FAULTS: "1", NODE_ENV: "production" });
  assert.equal(prod.status, 2);
  assert.match(prod.stderr, /never in production/);
});
