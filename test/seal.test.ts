import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { ADMIN_URL } from "./db.ts";
import { startFakeModel } from "./fake-model.ts";
import type { ProbeReport } from "./plants/probe.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

interface Report extends ProbeReport {
  readonly denied: string | null;
  readonly postgres: string;
  readonly fs: string;
}

function probe(flags: readonly string[], url: string): Report {
  const dir = mkdtempSync(join(tmpdir(), "labh-seal-"));
  const lookalike = join(dir, "node_modules", "pg", "lookalike.mjs");
  mkdirSync(dirname(lookalike), { recursive: true });
  writeFileSync(lookalike, 'export default await import("node:net");\n');
  const run = spawnSync(process.execPath, [...flags, "test/plants/seal-probe.ts", url, ADMIN_URL, lookalike], { cwd: root, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Report;
}

test("a sealed process under the permission model refuses every runtime route and still reaches Postgres", async () => {
  const hosted = await startFakeModel("hosted-2", "answer");
  try {
    const report = probe(PERMISSION_FLAGS, `${hosted.url}/chat/completions`);
    assert.deepEqual(report.leaked, [], `routes that reached out: ${report.leaked.join(", ")}`);
    assert.equal(hosted.requests, 0, "nothing reached the endpoint");
    assert.equal(report.refused.length, report.total);
    assert.ok(report.total >= 26, `only ${report.total} routes tried`);
    for (const r of report.refused) assert.match(r.error, /NetworkSealed|ERR_ACCESS_DENIED|restricted/, `${r.route}: ${r.error}`);
    assert.deepEqual(report.permission, { child: false, worker: false, addon: false });
    assert.equal(report.denied, null);
    assert.equal(report.postgres, "1", "pg, under the allowance, still opens its socket");
    assert.equal(report.fs, "function");
  } finally {
    await hosted.close();
  }
});

test("without the permission model the seal alone still refuses every route, and the binaries would refuse to start", async () => {
  const hosted = await startFakeModel("hosted-2", "answer");
  try {
    const report = probe([], `${hosted.url}/chat/completions`);
    assert.deepEqual(report.leaked, []);
    assert.equal(hosted.requests, 0);
    assert.equal(report.permission, null);
    assert.match(report.denied ?? "", /runs only under the permission model/);
  } finally {
    await hosted.close();
  }
});
