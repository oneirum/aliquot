import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../packages/core/src/db.ts";
import type { IntakeDeps } from "../packages/core/src/frontdoor.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { createWebHandler, listenWeb } from "../packages/core/src/surfaces/web.ts";
import { freshDatabase } from "./db.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { db, url } = await freshDatabase("labh_test_healthz");
const { server, port } = await listenWeb(createWebHandler(db, {} as IntakeDeps), 0);
after(async () => {
  server.close();
  await db.end();
});

async function healthz(query = "", p = port): Promise<{ status: number; body: { ok: boolean; database: string; workerBeatAgeMs: number | null } }> {
  const res = await fetch(`http://127.0.0.1:${p}/healthz${query}`);
  return { status: res.status, body: (await res.json()) as { ok: boolean; database: string; workerBeatAgeMs: number | null } };
}

async function until(what: string, check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`not within ${ms} ms: ${what}`);
}

function startWorker(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "healthz-"));
  writeFileSync(join(dir, "lab.toml"), '[database]\nurl_env = "DATABASE_URL"\n[store]\nplacement = "lab"\nkey_env = "LABH_PAYLOAD_KEY"\n[endpoints.local]\nbase_url = "http://127.0.0.1:9/v1"\nplacement = "lab"\n');
  const child = spawn(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/worker.ts", "--config", join(dir, "lab.toml"), "--worker-id", id], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: url, LABH_PAYLOAD_KEY: randomBytes(32).toString("hex") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, exited, stderr: () => stderr };
}

test("/healthz is 503 with no worker, 200 while one runs, and 503 again once it stops", async () => {
  const none = await healthz();
  assert.equal(none.status, 503);
  assert.deepEqual([none.body.database, none.body.workerBeatAgeMs], ["ok", null]);

  const w = startWorker("health-w1");
  try {
    await until("the worker's first beat", async () => (await healthz()).status === 200);
    const up = await healthz();
    assert.equal(up.body.ok, true);
    assert.ok(up.body.workerBeatAgeMs !== null && up.body.workerBeatAgeMs < 30_000);
  } finally {
    w.child.kill("SIGTERM");
  }
  assert.equal(await w.exited, 0, w.stderr());
  const down = await healthz();
  assert.equal(down.status, 503);
  assert.equal(down.body.workerBeatAgeMs, null);
});

test("a worker that died without stopping goes stale, and max_age sets how stale is too stale", async () => {
  // What a SIGKILLed worker leaves: its row, beating no more.
  await db.query("insert into worker_heartbeats (worker_id, engine, beat_at) values ('killed', 'chat', now() - interval '45 seconds')");
  try {
    const stale = await healthz();
    assert.equal(stale.status, 503);
    assert.ok(stale.body.workerBeatAgeMs! >= 45_000);
    assert.equal((await healthz("?max_age=60")).status, 200);
    assert.equal((await healthz("?max_age=0")).status, 400);
    // An agent worker alone does not run chat runs or compiles, so it does not make the lab healthy.
    await db.query("update worker_heartbeats set engine = 'agent-cli', beat_at = now() where worker_id = 'killed'");
    assert.equal((await healthz()).status, 503);
  } finally {
    await db.query("delete from worker_heartbeats");
  }
});

test("/healthz is 503 when Postgres does not answer, and needs no token", async () => {
  const gone = connect("postgres://postgres:labh@127.0.0.1:9/none");
  const { server: s, port: p } = await listenWeb(createWebHandler(gone, {} as IntakeDeps), 0);
  try {
    const res = await healthz("", p);
    assert.equal(res.status, 503);
    assert.equal(res.body.database, "unreachable");
    const withBearer = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { authorization: "Bearer not-a-token" } });
    assert.equal(withBearer.status, 503);
  } finally {
    s.close();
    await gone.end();
  }
});
