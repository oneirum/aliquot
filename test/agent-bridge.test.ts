import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer as createTcpServer, connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { startBridge } from "../packages/core/src/agents/bridge.ts";
import { startProxy } from "../packages/core/src/agents/proxy.ts";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import { createGateway } from "../packages/core/src/gateway.ts";
import { createQueue } from "../packages/core/src/queue.ts";
import { agentPermissionFlags, PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { freshDatabase } from "./db.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const gateway = createGateway([], DEFAULT_POLICY, fetch, [{ id: "claude", placement: "public" }]);
const admitted = (text: string) => {
  const content = Labelled.stamp(text, "D0", "test");
  const d = gateway.admit(content, "claude");
  assert.ok(d.allow);
  return { to: d.to, content, isError: false };
};

const TOKEN = "t".repeat(64);
const calls: { name: string; args: unknown }[] = [];
const bridge = await startBridge(TOKEN, {
  tools: [{ name: "kb_search", description: "Search.", inputSchema: { type: "object" } }],
  async call(name, args) {
    calls.push({ name, args });
    if (name === "boom") throw new Error("participant 4417 broke the tool");
    return admitted(`results for ${JSON.stringify(args)}`);
  },
});
after(() => bridge.close());

const post = (body: unknown, auth = `Bearer ${TOKEN}`, path = "/mcp") =>
  fetch(`http://127.0.0.1:${bridge.port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("the bridge answers the MCP subset with JSON: initialize, ping, tools/list and tools/call", async () => {
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
  assert.equal(init.headers.get("content-type"), "application/json");
  assert.deepEqual(await init.json(), { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "aliquot", version: "0.2.0" } } });
  const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);
  assert.deepEqual(await (await post({ jsonrpc: "2.0", id: 2, method: "ping" })).json(), { jsonrpc: "2.0", id: 2, result: {} });
  assert.deepEqual(await (await post({ jsonrpc: "2.0", id: 3, method: "tools/list" })).json(), { jsonrpc: "2.0", id: 3, result: { tools: [{ name: "kb_search", description: "Search.", inputSchema: { type: "object" } }] } });
  const call = await post({ jsonrpc: "2.0", id: "c4", method: "tools/call", params: { name: "kb_search", arguments: { query: "sleep" } } });
  assert.deepEqual(await call.json(), { jsonrpc: "2.0", id: "c4", result: { content: [{ type: "text", text: 'results for {"query":"sleep"}' }], isError: false } });
  assert.deepEqual(calls.at(-1), { name: "kb_search", args: { query: "sleep" } });
});

test("the bridge refuses a missing or wrong token, another path, GET, and malformed messages", async () => {
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "")).status, 401);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, `Bearer ${"x".repeat(64)}`)).status, 401);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, `Bearer ${TOKEN}`, "/other")).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
  assert.equal((await post("{not json")).status, 400);
  assert.deepEqual(await (await post([{ jsonrpc: "2.0", id: 1, method: "ping" }])).json(), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "one JSON-RPC 2.0 message per request" } });
  assert.deepEqual(await (await post({ jsonrpc: "2.0", id: 9, method: "resources/list" })).json(), { jsonrpc: "2.0", id: 9, error: { code: -32601, message: "method resources/list is not served" } });
});

test("a call that throws inside aliquot reaches the CLI as a fixed message, never the error's text", async () => {
  const res = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom", arguments: {} } });
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 5, error: { code: -32603, message: "the call failed inside aliquot" } });
});

/** Writes one request head to the proxy and returns the first line of its answer, then what the tunnel echoes back. */
async function viaProxy(port: number, head: string, payload?: string): Promise<{ status: string; echoed: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    let got = "";
    s.on("data", (b) => {
      got += b.toString("latin1");
      const end = got.indexOf("\r\n\r\n");
      if (end >= 0 && payload !== undefined && got.length === end + 4) s.write(payload);
      if (end >= 0 && (payload === undefined || got.length >= end + 4 + payload.length)) {
        s.destroy();
        resolve({ status: got.split("\r\n")[0]!, echoed: got.slice(end + 4) });
      }
    });
    s.on("error", reject);
    s.on("close", () => resolve({ status: got.split("\r\n")[0] ?? "", echoed: "" }));
    s.write(head);
  });
}

/** Opens a tunnel and starts TLS in it with the given SNI. reached: whether any byte got past the proxy to the upstream. */
async function tlsViaProxy(port: number, target: string, upstream: { readonly got: Buffer[] }, servername: string | null): Promise<{ status: string; reached: boolean }> {
  const before = upstream.got.length;
  const status = await new Promise<string>((resolve) => {
    const s = connect(port, "127.0.0.1");
    let got = "";
    s.on("error", () => undefined);
    s.on("data", function onData(b: Buffer) {
      got += b.toString("latin1");
      if (!got.includes("\r\n\r\n")) return;
      s.off("data", onData);
      if (servername === null) s.write("hello");
      else tlsConnect({ socket: s, servername, rejectUnauthorized: false }).on("error", () => undefined);
      setTimeout(() => {
        s.destroy();
        resolve(got.split("\r\n")[0]!);
      }, 300);
    });
    s.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
  });
  return { status, reached: upstream.got.length > before };
}

test("the proxy tunnels to a vendor host only for a ClientHello naming that host, and refuses every other request with 403", async () => {
  const upstream = { got: [] as Buffer[] };
  const echo = createTcpServer((c) => c.once("data", (b: Buffer) => (upstream.got.push(b), c.destroy())));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as { port: number }).port;
  const proxy = await startProxy(["localhost"], echoPort);
  try {
    assert.deepEqual(await tlsViaProxy(proxy.port, `localhost:${echoPort}`, upstream, "localhost"), { status: "HTTP/1.1 200 Connection Established", reached: true });
    assert.equal(upstream.got[0]![0], 0x16, "the upstream got the ClientHello");
    assert.deepEqual(await tlsViaProxy(proxy.port, `localhost:${echoPort}`, upstream, "other.example"), { status: "HTTP/1.1 200 Connection Established", reached: false });
    assert.deepEqual(await tlsViaProxy(proxy.port, `localhost:${echoPort}`, upstream, null), { status: "HTTP/1.1 200 Connection Established", reached: false });
    assert.equal((await viaProxy(proxy.port, `CONNECT example.org:${echoPort} HTTP/1.1\r\n\r\n`)).status, "HTTP/1.1 403 Forbidden");
    assert.equal((await viaProxy(proxy.port, "CONNECT localhost:5432 HTTP/1.1\r\n\r\n")).status, "HTTP/1.1 403 Forbidden");
    assert.equal((await viaProxy(proxy.port, "GET http://statsig.example/v1 HTTP/1.1\r\nHost: statsig.example\r\n\r\n")).status, "HTTP/1.1 403 Forbidden");
    assert.deepEqual(proxy.tunneled(), ["localhost"]);
    assert.deepEqual(proxy.refused(), { count: 5, targets: [`other.example:${echoPort}`, `no-sni:${echoPort}`, `example.org:${echoPort}`, "localhost:5432", "sha256:76073146c1864506"] });
    for (let i = 0; i < 25; i++) await viaProxy(proxy.port, `CONNECT h${i}.example:443 HTTP/1.1\r\n\r\n`);
    const capped = proxy.refused();
    assert.deepEqual({ count: capped.count, kept: capped.targets.length, last: capped.targets.at(-1) }, { count: 30, kept: 20, last: "h14.example:443" });
  } finally {
    await proxy.close();
    echo.close();
  }
});

test("a chat worker never claims an agent-cli run, and the agent worker claims nothing else", async () => {
  const { db } = await freshDatabase("labh_agent_claim");
  try {
    const queue = createQueue(db);
    await queue.enqueue({ kind: "run", key: "agent-run" }, null, { engine: "agent-cli" });
    await queue.enqueue({ kind: "run", key: "old-chat-run" }, null, { agent: "x" });
    await queue.enqueue({ kind: "kb-compile", key: "compile" }, null, {});
    const chat = await queue.claim("chat", ["run"], 60_000);
    assert.equal(chat?.key, "old-chat-run");
    assert.equal(await queue.claim("chat", ["run"], 60_000), null);
    assert.equal((await queue.claim("agent", ["run"], 60_000, "agent-cli"))?.key, "agent-run");
    assert.equal(await queue.claim("agent", ["run"], 60_000, "agent-cli"), null);
  } finally {
    await db.end();
  }
});

test("the agent worker binary starts only under its own permission flags", () => {
  const ws = fileURLToPath(new URL("../packages", import.meta.url)).replace(/\/$/, "");
  const run = (flags: readonly string[]) => spawnSync(process.execPath, [...flags, "packages/core/bin/agent-worker.ts", "--config", "does-not-exist.toml", "--workspaces", ws], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  const chat = run(PERMISSION_FLAGS);
  assert.equal(chat.status, 2);
  assert.match(chat.stderr, /child processes must be allowed; writes under .* must be allowed/);
  const wide = run(["--permission", "--allow-fs-read=*", "--allow-fs-write=*", "--allow-net", "--allow-child-process"]);
  assert.equal(wide.status, 2);
  assert.match(wide.stderr, /writes outside the workspaces root must be denied/);
  const workers = run([...agentPermissionFlags(ws), "--allow-worker"]);
  assert.match(workers.stderr, /worker must be denied/);
  const right = run(agentPermissionFlags(ws));
  assert.doesNotMatch(right.stderr, /must be (allowed|denied)/, "the exact flags pass the check and the binary goes on to read its config");
});

test("after the seal, a tool module that imports core's agent code is refused at load", () => {
  const plant = fileURLToPath(new URL("./plants/agent-import-tool.ts", import.meta.url));
  const script = `import { sealNetwork } from ${JSON.stringify(`${root}packages/core/src/seal.ts`)}; sealNetwork(); try { await import(${JSON.stringify(plant)}); console.log("loaded"); } catch (e) { console.log(e.name + ": " + e.message); }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" });
  assert.match(r.stdout, /^CoreInternal: \.\.\/\.\.\/packages\/core\/src\/agents\/spawn\.ts is core's agent code and may be imported only from core, not from file:.*agent-import-tool\.ts\n$/);
});
