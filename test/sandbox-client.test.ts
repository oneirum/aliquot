/**
 * The Docker client's stop and timeout paths, against a scripted daemon on a unix socket. No Docker needed, so these
 * run on CI too; test/run-code.test.ts covers the real daemon.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createSandbox, DOCKER_GRACE_MS } from "../packages/core/src/sandbox.ts";
import type { SandboxConfig } from "../packages/core/src/config.ts";
import type { Sha256 } from "../packages/core/src/hash.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

const dir = mkdtempSync(join(tmpdir(), "dockerd-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

/** A daemon that logs each request as "METHOD path" and answers by the first matching route; unmatched requests get 204. */
async function daemon(routes: Record<string, Handler>): Promise<{ readonly log: string[]; readonly config: SandboxConfig; close(): Promise<void> }> {
  const log: string[] = [];
  const socket = join(dir, `d${n++}.sock`);
  const server = createServer(async (req, res) => {
    const line = `${req.method} ${req.url}`;
    log.push(line);
    const route = Object.entries(routes).find(([k]) => line.startsWith(k))?.[1];
    if (route) await route(req, res);
    else res.writeHead(204).end();
  });
  await new Promise<void>((r) => server.listen(socket, r));
  const config: SandboxConfig = { image: `sha256:${"a".repeat(64)}`, digest: "a".repeat(64) as Sha256, cpus: 1, memoryMb: 256, timeoutMs: 100, socket };
  return { log, config, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

const created: Handler = (_req, res) => void res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ Id: "c1" }));
const spec = { language: "python", code: "print(1)", mounts: [] } as const;

test("a stop before the call creates no container", async () => {
  const d = await daemon({ "POST /v1.41/containers/create": created });
  try {
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(createSandbox(d.config).run(spec, stop.signal), { name: "AbortError" });
    assert.deepEqual(d.log, []);
  } finally {
    await d.close();
  }
});

test("a stop while the container is being created ends the call before start, and the container is removed", async () => {
  const stop = new AbortController();
  const d = await daemon({
    "POST /v1.41/containers/create": async (req, res) => {
      stop.abort();
      await sleep(50);
      created(req, res);
    },
  });
  try {
    await assert.rejects(createSandbox(d.config).run(spec, stop.signal), { name: "AbortError" });
    assert.deepEqual(d.log, ["POST /v1.41/containers/create", "DELETE /v1.41/containers/c1?force=true&v=true"]);
  } finally {
    await d.close();
  }
});

test("a daemon that accepts the connection and stalls fails the call after the timeout and the grace", async () => {
  const d = await daemon({ "POST /v1.41/containers/create": () => new Promise<void>(() => {}) });
  try {
    await assert.rejects(createSandbox(d.config).run(spec, new AbortController().signal), { message: `docker POST /containers/create: no answer within ${100 + DOCKER_GRACE_MS} ms` });
  } finally {
    await d.close();
  }
});

test("a timeout that fires while the container starts reports timedOut, not a crash", async () => {
  const d = await daemon({
    "POST /v1.41/containers/c1/start": async (_req, res) => {
      await sleep(300);
      res.writeHead(204).end();
    },
    "POST /v1.41/containers/c1/exec": (_req, res) => void res.writeHead(409).end("container c1 is not running"),
    "POST /v1.41/containers/create": created,
  });
  try {
    const r = await createSandbox(d.config).run(spec, new AbortController().signal);
    assert.deepEqual(r, { exitCode: null, timedOut: true, stdout: "", stderr: "", files: [], truncated: { stdout: false, stderr: false, filesOmitted: [], filesUnlisted: false } });
    assert.deepEqual(d.log, ["POST /v1.41/containers/create", "POST /v1.41/containers/c1/start", "POST /v1.41/containers/c1/kill", "POST /v1.41/containers/c1/exec", "DELETE /v1.41/containers/c1?force=true&v=true"]);
  } finally {
    await d.close();
  }
});
