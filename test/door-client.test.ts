import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const RUN = "00000000-0000-4000-8000-0000000000a1";

/** One scripted run per test: what the door answers to /message, the run's events, and its replies. */
interface Script {
  message: { status: number; body: unknown };
  events: unknown[];
  replies: unknown[];
  /** The door does not know the presented token: every route answers 401. */
  unauthorized?: boolean;
}
let script: Script;
const posted: { path: string; body: any }[] = [];
/** The Authorization header of every request the door saw, in order. */
const authorized: { path: string; auth: string | undefined }[] = [];

function answered(cls: string, text: string, extra: unknown[] = []): Script {
  return {
    message: { status: 202, body: { t: "enqueued", runId: RUN, agent: "a", duplicate: false } },
    events: [
      { seq: 0, event: { t: "run.started" } },
      { seq: 1, event: { t: "tool.requested", tool: "kb_search" } },
      ...extra,
      { seq: 9, event: { t: "run.finished", outcome: extra.length ? "refused" : "answered", answer: extra.length ? null : { hash: "h", cls, bytes: 1 } } },
    ],
    replies: [{ kind: "reply", text, at: "2026-11-03T00:00:00.000Z" }],
  };
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, b: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  };
  authorized.push({ path: url.pathname, auth: req.headers.authorization });
  if (script.unauthorized) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
    return res.end(JSON.stringify({ error: "unknown surface token" }));
  }
  if (req.method === "POST") {
    const b = await body(req);
    posted.push({ path: url.pathname, body: b });
    if (url.pathname === "/message") return json(script.message.status, script.message.body);
    if (url.pathname === "/stop") return json(202, { inboxId: "1" });
  }
  if (url.pathname === `/runs/${RUN}/events`) return json(200, script.events);
  if (url.pathname === "/replies") return json(200, script.replies);
  json(404, { error: "not found" });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const door = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

function aliquot(args: readonly string[], input = "", env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/aliquot.ts", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(input);
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

const lines = (s: string) => s.trim().split("\n").map((l) => JSON.parse(l));

test("aliquot ask --json prints started, each tool and the finished answer with its record link, and exits 0", async () => {
  script = answered("D0", "Store samples at -80 C.\nSource: sop-freezer.md");
  const r = await aliquot(["ask", "--door", door, "--user", "member-1", "--json", "Where", "do", "samples", "go?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), [
    { t: "started", runId: RUN, recordUrl: `${door}/runs/${RUN}` },
    { t: "tool", runId: RUN, tool: "kb_search" },
    { t: "finished", runId: RUN, outcome: "answered", answer: "Store samples at -80 C.\nSource: sop-freezer.md", cls: "D0", withheld: false, refusal: null, recordUrl: `${door}/runs/${RUN}` },
  ]);
  const sent = posted.at(-1)!;
  assert.equal(sent.path, "/message");
  assert.equal(sent.body.text, "Where do samples go?");
  assert.equal(sent.body.user, "member-1");
});

test("aliquot ask reads the question from stdin with -, and prints the answer and the record for a person", async () => {
  script = answered("D0", "At -80 C.");
  const r = await aliquot(["ask", "--door", door, "--user", "member-1", "-"], "Where do samples go?\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `At -80 C.\n\nrecord  ${door}/runs/${RUN}\n`);
  assert.equal(posted.at(-1)!.body.text, "Where do samples go?");
});

test("a gate refusal prints the door's message, starts no run and exits 1", async () => {
  script = { message: { status: 403, body: { t: "refused", userFacing: "You are not a member of this lab's harness." } }, events: [], replies: [] };
  const r = await aliquot(["ask", "--door", door, "--user", "stranger", "--json", "hello"]);
  assert.equal(r.status, 1);
  assert.deepEqual(lines(r.stdout), [{ t: "refused", runId: null, message: "You are not a member of this lab's harness." }]);
});

test("an answer above --ceiling comes back withheld: no text, the record link only", async () => {
  script = answered("D2", "Participant P-0042 was enrolled on ...");
  const r = await aliquot(["ask", "--door", door, "--user", "member-1", "--ceiling", "D1", "--json", "who enrolled"]);
  assert.equal(r.status, 0, r.stderr);
  const finished = lines(r.stdout).at(-1);
  assert.equal(finished.withheld, true);
  assert.equal(finished.answer, null);
  assert.equal(finished.cls, "D2");
  assert.ok(!r.stdout.includes("P-0042"));
});

test("an egress refusal reports the refusal, not the reply, and exits 1", async () => {
  script = answered("D0", "unused", [{ seq: 5, event: { t: "egress.refused", refusal: { code: "class-above-ceiling" } } }]);
  const r = await aliquot(["ask", "--door", door, "--user", "member-1", "--json", "q"]);
  assert.equal(r.status, 1);
  const finished = lines(r.stdout).at(-1);
  assert.equal(finished.answer, null);
  assert.match(finished.refusal, /class-above-ceiling\). Nothing was sent/);
});

test("a door that is not running is one line and exit 2", async () => {
  const r = await aliquot(["ask", "--door", "http://127.0.0.1:9", "--user", "member-1", "q"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^cannot reach the door at http:\/\/127\.0\.0\.1:9\. Is the web door running\?\n$/);
});

test("ask without a user, or with a ceiling that is not a class, is a usage error", async () => {
  assert.equal((await aliquot(["ask", "--door", door, "q"])).status, 2);
  assert.equal((await aliquot(["ask", "--door", door, "--user", "m", "--ceiling", "D9", "q"])).status, 2);
});

const TOKEN = "f".repeat(64);
const linkOnly = (cls: string): Script => ({
  message: { status: 202, body: { t: "enqueued", runId: RUN, agent: "a", duplicate: false } },
  events: [
    { seq: 0, event: { t: "run.started", surface: "acp" } },
    { seq: 1, event: { t: "reply.posted", mode: "link-only", surfaceMessageId: "1" } },
    { seq: 2, event: { t: "run.finished", outcome: "answered", answer: { hash: "h", cls, bytes: 1 } } },
  ],
  replies: [{ kind: "reply", text: `This answer contains restricted data. Open it here: ${door}/runs/${RUN}`, at: "2026-11-03T00:00:00.000Z" }],
});

test("ask sends ALIQUOT_SURFACE_TOKEN as a Bearer header on every request, and no header without it", async () => {
  script = answered("D0", "At -80 C.");
  const from = authorized.length;
  assert.equal((await aliquot(["ask", "--door", door, "--user", "member-1", "q"], "", { ALIQUOT_SURFACE_TOKEN: TOKEN })).status, 0);
  const tokened = authorized.slice(from);
  assert.deepEqual([...new Set(tokened.map((a) => a.path))], ["/message", `/runs/${RUN}/events`, "/replies"]);
  assert.deepEqual([...new Set(tokened.map((a) => a.auth))], [`Bearer ${TOKEN}`]);
  const plain = authorized.length;
  assert.equal((await aliquot(["ask", "--door", door, "--user", "member-1", "q"])).status, 0);
  assert.deepEqual([...new Set(authorized.slice(plain).map((a) => a.auth))], [undefined]);
});

test("a door that refuses the token is one line naming ALIQUOT_SURFACE_TOKEN and exit 2", async () => {
  script = { ...answered("D0", "unused"), unauthorized: true };
  const r = await aliquot(["ask", "--door", door, "--user", "member-1", "--json", "q"], "", { ALIQUOT_SURFACE_TOKEN: TOKEN });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "the door refused ALIQUOT_SURFACE_TOKEN (401: unknown surface token). Set it to the token of a surface the door serves, or unset it to ask as the web surface.\n");
  assert.equal(r.stderr.includes(TOKEN), false);
});

test("a reply the door posted link-only comes back withheld, with the record link and no notice text", async () => {
  script = linkOnly("D2");
  const r = await aliquot(["ask", "--door", door, "--user", "member-1", "--json", "who enrolled"], "", { ALIQUOT_SURFACE_TOKEN: TOKEN });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout).at(-1), { t: "finished", runId: RUN, outcome: "answered", answer: null, cls: "D2", withheld: true, refusal: null, recordUrl: `${door}/runs/${RUN}` });
  const person = await aliquot(["ask", "--door", door, "--user", "member-1", "who enrolled"], "", { ALIQUOT_SURFACE_TOKEN: TOKEN });
  assert.equal(person.stdout, `The answer is D2, above what this surface may show. Read it in the record.\nrecord  ${door}/runs/${RUN}\n`);
});

/** aliquot acp as an ACP client drives it: one JSON-RPC message per line each way. */
function acp(args: readonly string[] = [], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/aliquot.ts", "acp", "--door", door, "--user", "member-1", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", ...env } });
  const msgs: any[] = [];
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      msgs.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  let nextId = 1;
  return {
    msgs,
    notify: (method: string, params: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
    /** Sends a request and resolves with its response. */
    async request(method: string, params: object): Promise<any> {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      for (;;) {
        const m = msgs.find((x) => x.id === id);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async close(): Promise<void> {
      child.stdin.end();
      await once(child, "close");
    },
  };
}

const updates = (msgs: any[], kind: string) => msgs.filter((m) => m.method === "session/update" && m.params.update.sessionUpdate === kind).map((m) => m.params.update);

test("aliquot acp answers initialize as an ACP v1 agent with no sign-in step", async () => {
  const a = acp();
  const r = await a.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await a.close();
  assert.equal(r.result.protocolVersion, 1);
  assert.deepEqual(r.result.authMethods, []);
  assert.equal(r.result.agentCapabilities.loadSession, false);
  assert.equal(r.result.agentInfo.name, "aliquot");
  assert.match(r.result.agentInfo.version, /^\d+\.\d+\.\d+$/);
});

test("a prompt T3 Code wrapped in its own instructions reaches the door as the person's words only", async () => {
  script = answered("D0", "At -80 C.");
  const before = posted.length;
  const a = acp();
  const sessionId = (await a.request("session/new", {})).result.sessionId;
  const wrapped = "<t3_code_instructions>\nUse the T3 tools when asked.\n</t3_code_instructions>\n\n<user_request>\nWhere do samples go?\n</user_request>";
  await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: wrapped }] });
  await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "And after a week?" }] });
  await a.close();
  assert.deepEqual(
    posted.slice(before).filter((p) => p.path === "/message").map((p) => p.body.text),
    ["Where do samples go?", "And after a week?"],
  );
});

test("two prompts in one ACP session are one Aliquot thread; each streams its tools and ends with the record link", async () => {
  script = answered("D0", "At -80 C.");
  const before = posted.length;
  const a = acp();
  const sessionId = (await a.request("session/new", { cwd: "/tmp", mcpServers: [] })).result.sessionId;
  assert.match(sessionId, /^acp-/);
  assert.deepEqual((await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Where do samples go?" }] })).result, { stopReason: "end_turn" });
  assert.deepEqual((await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "And after a week?" }] })).result, { stopReason: "end_turn" });
  await a.close();

  assert.deepEqual(
    updates(a.msgs, "agent_message_chunk").map((u) => u.content.text),
    [`At -80 C.\n\nRecord: ${door}/runs/${RUN}`, `At -80 C.\n\nRecord: ${door}/runs/${RUN}`],
  );
  assert.deepEqual(
    updates(a.msgs, "tool_call").map((u) => u.title),
    ["kb_search", "kb_search"],
  );
  const asked = posted.slice(before).filter((p) => p.path === "/message");
  assert.deepEqual(
    asked.map((p) => [p.body.thread, p.body.text]),
    [
      [sessionId, "Where do samples go?"],
      [sessionId, "And after a week?"],
    ],
  );
  assert.notEqual(asked[0]!.body.message, asked[1]!.body.message);
});

test("an ACP gate refusal ends the turn with stopReason refusal and the door's message", async () => {
  script = { message: { status: 403, body: { t: "refused", userFacing: "This message is D3, and this agent's model may receive at most D1." } }, events: [], replies: [] };
  const a = acp();
  const sessionId = (await a.request("session/new", {})).result.sessionId;
  const r = await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "P-0042" }] });
  await a.close();
  assert.deepEqual(r.result, { stopReason: "refusal" });
  assert.deepEqual(
    updates(a.msgs, "agent_message_chunk").map((u) => u.content.text),
    ["This message is D3, and this agent's model may receive at most D1."],
  );
});

test("--ceiling on acp keeps an answer above it out of the client: the chunk carries the record link only", async () => {
  script = answered("D2", "Participant P-0042 was enrolled on ...");
  const a = acp(["--ceiling", "D1"]);
  const sessionId = (await a.request("session/new", {})).result.sessionId;
  await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "who enrolled" }] });
  await a.close();
  const [text] = updates(a.msgs, "agent_message_chunk").map((u) => u.content.text);
  assert.equal(text, `The answer is D2, above what this client may keep (D1). Read it in the record: ${door}/runs/${RUN}`);
});

test("session/cancel stops the running prompt's run through the door, and the turn ends cancelled", async () => {
  script = { ...answered("D0", "never"), events: [{ seq: 0, event: { t: "run.started" } }] };
  const before = posted.length;
  const a = acp();
  const sessionId = (await a.request("session/new", {})).result.sessionId;
  const turn = a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "long one" }] });
  while (!posted.slice(before).some((p) => p.path === "/message")) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
  a.notify("session/cancel", { sessionId });
  assert.deepEqual((await turn).result, { stopReason: "cancelled" });
  await a.close();
  assert.deepEqual(
    posted.slice(before).find((p) => p.path === "/stop")!.body,
    { runId: RUN, user: "member-1", confirmed: true },
  );
});

test("an ACP method Aliquot does not implement is a JSON-RPC method-not-found error", async () => {
  const a = acp();
  const r = await a.request("session/load", {});
  await a.close();
  assert.equal(r.error.code, -32601);
});

test("acp sends ALIQUOT_SURFACE_TOKEN as a Bearer header, and a link-only reply reaches the client as the record link only", async () => {
  script = linkOnly("D2");
  const from = authorized.length;
  const a = acp([], { ALIQUOT_SURFACE_TOKEN: TOKEN });
  const sessionId = (await a.request("session/new", {})).result.sessionId;
  await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "who enrolled" }] });
  await a.close();
  assert.deepEqual([...new Set(authorized.slice(from).map((x) => x.auth))], [`Bearer ${TOKEN}`]);
  assert.deepEqual(updates(a.msgs, "agent_message_chunk").map((u) => u.content.text), [`The answer is D2, above what this client may keep. Read it in the record: ${door}/runs/${RUN}`]);
});
