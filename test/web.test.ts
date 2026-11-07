import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import type { Db } from "../packages/core/src/db.ts";
import type { IntakeDeps } from "../packages/core/src/frontdoor.ts";
import type { LabConfig } from "../packages/core/src/config.ts";
import { request } from "node:http";
import { gunzipSync } from "node:zlib";
import type { ToolHash } from "../packages/core/src/hash.ts";
import type { RunEvent, RunId } from "../packages/core/src/record.ts";
import { recordView } from "../packages/core/src/record-view.ts";
import { createWebHandler, createWebSurface, listenWeb, MAX_BODY_BYTES } from "../packages/core/src/surfaces/web.ts";
import { recordPage } from "../packages/core/src/surfaces/web-pages.ts";
import { freshDatabase } from "./db.ts";
import { RUN, chain, ref, started } from "./events.ts";

const { db } = await freshDatabase("labh_test_web");
const logged: string[] = [];
const deps = { store: { held: new Set<string>() } } as unknown as IntakeDeps;
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

test("the chat page and the record page are self-contained HTML that loads nothing from another origin", async () => {
  for (const path of ["/", `/runs/${UUID}`]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const html = await res.text();
    assert.deepEqual(html.match(/(?:src|href)="https?:/g), null);
  }
});

test("both pages name the lab at the top, escaped, and carry no slogan or status label", async () => {
  const { server: s, port: p } = await listenWeb(createWebHandler(db, deps, (line) => logged.push(line), null, "Lab <b>&</b>"), 0);
  try {
    for (const path of ["/", `/runs/${UUID}`]) {
      const html = await (await fetch(`http://127.0.0.1:${p}${path}`)).text();
      assert.ok(html.includes('<span class="where">Lab &#60;b&#62;&#38;&#60;/b&#62;</span>'), path);
      for (const label of ["Runs on this machine", "Read only", "Every answer leaves a record", "never goes to a hosted model"]) assert.ok(!html.includes(label), `${path}: ${label}`);
    }
  } finally {
    s.close();
  }
  assert.ok(!(await (await fetch(`${base}/`)).text()).includes('class="where"'), "no name, no label");
});

test("the record view of a run with no events yet is empty, running and intact", async () => {
  assert.deepEqual(await call("GET", `/runs/${UUID}/view`), { status: 200, body: { runId: UUID, startedAt: null, agent: null, route: null, outcome: "running", chain: { events: 0, firstBad: null }, summary: { ms: 0, modelCalls: 0, tokens: { input: 0, output: 0 }, toolCalls: [], entriesRetrieved: 0, refused: 0, withheld: 0, cost: null }, rows: [], bodies: [] } });
});

test("a web surface bound to a channel puts every message there and refuses a body that names another", async () => {
  const seen: string[] = [];
  const gate = { members: async (id: string) => ({ id, audiences: [] }), channelFloor: async () => "D1", labPatterns: [], policy: DEFAULT_POLICY };
  const probe = { db, gate, agentsFor: async (c: { channelId: string }) => (seen.push(c.channelId), []) } as unknown as IntakeDeps;
  const message = (extra: Record<string, unknown>) => JSON.stringify({ thread: "t", message: "m", text: "hi", user: "alice", ...extra });
  for (const [bound, body, want] of [
    ["public", message({}), { status: 403, channel: "public" }],
    ["public", message({ channel: "public" }), { status: 403, channel: "public" }],
    ["public", message({ channel: "lab" }), { status: 400, channel: null }],
    [null, message({ channel: "public" }), { status: 403, channel: "public" }],
    [null, message({}), { status: 403, channel: "lab" }],
  ] as const) {
    seen.length = 0;
    const { server: s, port: p } = await listenWeb(createWebHandler(db, probe, (line) => logged.push(line), bound), 0);
    try {
      const res = await fetch(`http://127.0.0.1:${p}/message`, { method: "POST", headers: { "content-type": "application/json" }, body });
      assert.deepEqual({ status: res.status, channel: seen[0] ?? null }, want);
      if (res.status === 400) assert.deepEqual(await res.json(), { error: "this web surface serves channel public only" });
    } finally {
      s.close();
    }
  }
});

async function insertRun(events: readonly RunEvent[], startMs: number): Promise<string> {
  const runId = (await db.query<{ id: string }>("insert into jobs (kind, key, payload) values ('run', $1, '{}') returning id", [`k:web:list:${startMs}`])).rows[0]!.id as RunId;
  for (const e of chain(events, startMs, runId)) await db.query("insert into run_events (run_id, seq, at, cls, prev_hash, hash, event) values ($1, $2, $3, $4, $5, $6, $7)", [e.runId, e.seq, e.at, e.cls, e.prevHash, e.hash, e.event]);
  return runId;
}

test("the runs page lists the newest runs, counts each filter on its tab, and shows only those with a refusal or only the failed ones when asked", async () => {
  const finished = (outcome: "answered" | "refused" | "failed"): RunEvent => ({ t: "run.finished", outcome, answer: null, reason: null, flags: [] });
  const withheld: RunEvent = { t: "tool.withheld", callId: "c1", cls: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } };
  const answered = await insertRun([started(), finished("answered")], Date.parse("2026-02-01T10:00:00Z"));
  const refused = await insertRun([started(), withheld, finished("refused")], Date.parse("2026-02-01T11:00:00Z"));
  const failed = await insertRun([started(), finished("failed")], Date.parse("2026-02-01T12:00:00Z"));
  const ids = async (path: string) => [...(await (await fetch(`${base}${path}`)).text()).matchAll(/href="\/runs\/([0-9a-f-]{36})"/g)].map((m) => m[1]);
  assert.deepEqual(await ids("/runs"), [failed, refused, answered]);
  assert.deepEqual(await ids("/runs?show=refusals"), [refused]);
  assert.deepEqual(await ids("/runs?show=failed"), [failed]);
  assert.deepEqual(await ids("/runs?show=anything-else"), [failed, refused, answered]);
  const html = await (await fetch(`${base}/runs`)).text();
  for (const [tab, n] of [["All", 3], ["With a refusal", 1], ["Failed", 1]] as const) assert.ok(html.includes(`${tab} <span class="count">${n}</span>`), tab);
  assert.match(html, /<tr class="refused">.*?refused<\/td><td class="num"><span class="mark" aria-hidden="true">▲<\/span>1<\/td><td class="num">3<\/td>/);
});

test("the record page carries its view in the page, and no string in it can close the script element", () => {
  const view = recordView(RUN, chain([started(), { t: "tool.requested", callId: "c1", attempt: 1, tool: "</script><b>x", hash: "b".repeat(64) as ToolHash, input: ref("a") }]));
  const html = recordPage(view);
  const json = /<script type="application\/json" id="view">(.*?)<\/script>/s.exec(html)![1]!;
  assert.ok(!json.includes("<"), "every < in the JSON is escaped");
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(view)));
});

test("a page is gzipped for a browser that accepts it, and plain for one that does not or when it is under a kilobyte", async () => {
  const get = (path: string, encoding: string) => new Promise<{ encoding: string | undefined; vary: string | undefined; body: string }>((resolve, reject) => {
    request(`${base}${path}`, { headers: { "accept-encoding": encoding } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ encoding: res.headers["content-encoding"], vary: res.headers.vary, body: (res.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8") });
      });
    }).on("error", reject).end();
  });
  const zipped = await get("/", "gzip, deflate, br");
  const plain = await get("/", "identity");
  assert.equal(zipped.encoding, "gzip");
  assert.equal(plain.encoding, undefined);
  assert.equal(zipped.vary, "accept-encoding");
  assert.equal(zipped.body, plain.body);
  assert.equal((await get(`/runs/${UUID}/view`, "gzip")).encoding, undefined, "under a kilobyte goes out plain");
});
