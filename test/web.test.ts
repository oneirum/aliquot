import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../packages/core/src/db.ts";
import type { IntakeDeps } from "../packages/core/src/frontdoor.ts";
import type { LabConfig } from "../packages/core/src/config.ts";
import type { RunId } from "../packages/core/src/record.ts";
import { createWebHandler, createWebSurface, listenWeb, MAX_BODY_BYTES } from "../packages/core/src/surfaces/web.ts";
import { freshDatabase } from "./db.ts";

const { db } = await freshDatabase("labh_test_web");
const logged: string[] = [];
const deps = {} as IntakeDeps;
const { server, port } = await listenWeb(createWebHandler(db, deps, (line) => logged.push(line)), 0);
const base = `http://127.0.0.1:${port}`;
after(async () => {
  server.close();
  await db.end();
});

const UUID = "00000000-0000-4000-8000-000000000009";
const DB_TEXT = 'relation "web_messages" does not exist';

async function call(method: string, path: string, body?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body }) });
  return { status: res.status, body: await res.json() };
}

test("askConfirm posts one notice per run and call, however many times a resumed run asks", async () => {
  const run = (await db.query<{ id: string }>("insert into jobs (kind, key, payload) values ('run', 'k:web:ask', '{}') returning id")).rows[0]!.id as RunId;
  const surface = createWebSurface(db, { web: { placement: "lab", port: 0, baseUrl: "http://localhost" } } as LabConfig);
  await surface.askConfirm(run, "t", "Approve?", "c1");
  await surface.askConfirm(run, "t", "Approve?", "c1");
  await surface.askConfirm(run, "t", "Stop this run?", "stop");
  const rows = await db.query<{ text: string }>("select text from web_messages where run_id = $1 and kind = 'notice' order by id", [run]);
  assert.deepEqual(
    rows.rows.map((r) => r.text),
    ["Approve?", "Stop this run?"],
  );
});

test("a body over the cap is refused with 413 before it is parsed", async () => {
  const big = JSON.stringify({ thread: "t", message: "m", user: "u", text: "x".repeat(MAX_BODY_BYTES) });
  assert.deepEqual(await call("POST", "/message", big), { status: 413, body: { error: `body exceeds ${MAX_BODY_BYTES} bytes` } });
});

test("malformed JSON and a non-uuid run id are clean 400s", async () => {
  assert.deepEqual(await call("POST", "/stop", "{not json"), { status: 400, body: { error: "body is not JSON" } });
  assert.deepEqual(await call("GET", "/replies?runId=not-a-uuid"), { status: 400, body: { error: "runId must be a uuid" } });
  assert.deepEqual(await call("GET", "/runs/not-a-uuid/events"), { status: 404, body: { error: "not found" } });
  const stop = await call("POST", "/stop", JSON.stringify({ runId: "not-a-uuid", user: "alice" }));
  assert.equal(stop.status, 400);
});

test("a stop for a run that does not exist is a 404, not a foreign key error", async () => {
  const res = await call("POST", "/stop", JSON.stringify({ runId: UUID, user: "alice" }));
  assert.deepEqual(res, { status: 404, body: { error: "no such run" } });
});

test("a database error is logged and answered with a generic 500 that carries no database text", async () => {
  const broken = { query: async () => { throw new Error(DB_TEXT); } } as unknown as Db;
  const { server: s2, port: p2 } = await listenWeb(createWebHandler(broken, deps, (line) => logged.push(line)), 0);
  try {
    const res = await fetch(`http://127.0.0.1:${p2}/replies?runId=${UUID}`);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.equal(text.includes("web_messages"), false, `response leaked: ${text}`);
    assert.deepEqual(JSON.parse(text), { error: "internal error" });
    assert.ok(logged.some((l) => l.includes(DB_TEXT)), "the real error went to the log");
  } finally {
    s2.close();
  }
});
