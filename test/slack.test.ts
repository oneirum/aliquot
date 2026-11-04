import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { questionText } from "../packages/core/src/surfaces/slack.ts";
import { startFakeSlack, type FakeSlack } from "./fake-slack.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SURFACE_TOKEN = "s".repeat(64);
const APP_TOKEN = "xapp-1-A0-fake";
const BOT_TOKEN = "xoxb-fake";

/** A door that answers by the question: "withhold" is above the slack surface, "refuse" fails the gate, "slow" runs until stopped. */
const asked: Record<string, any>[] = [];
const auths: (string | undefined)[] = [];
const stops: Record<string, any>[] = [];
const runs = new Map<string, string>();

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const doorServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, b: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  };
  auths.push(req.headers.authorization);
  if (req.method === "POST" && url.pathname === "/message") {
    const b = await body(req);
    asked.push(b);
    if (b.text.includes("refuse")) return json(403, { t: "refused", userFacing: "You are not a member of this lab's harness." });
    const runId = `00000000-0000-4000-8000-${String(asked.length).padStart(12, "0")}`;
    runs.set(runId, b.text);
    return json(202, { t: "enqueued", runId, agent: "a", duplicate: false });
  }
  if (req.method === "POST" && url.pathname === "/stop") {
    stops.push(await body(req));
    return json(202, { inboxId: "1" });
  }
  const m = /^\/runs\/([0-9a-f-]+)\/events$/.exec(url.pathname);
  if (m) {
    const text = runs.get(m[1]!) ?? "";
    const stopped = stops.some((s) => s.runId === m[1]);
    if (text.includes("slow") && !stopped) return json(200, [{ seq: 0, event: { t: "run.started" } }]);
    const cls = text.includes("withhold") ? "D3" : "D1";
    return json(200, [
      { seq: 0, event: { t: "run.started" } },
      ...(text.includes("withhold") ? [{ seq: 2, event: { t: "reply.posted", mode: "link-only" } }] : []),
      { seq: 3, event: { t: "run.finished", outcome: stopped ? "stopped" : "answered", answer: stopped ? null : { hash: "h", cls, bytes: 1 } } },
    ]);
  }
  if (url.pathname === "/replies") {
    const runId = url.searchParams.get("runId") ?? "";
    const text = runs.get(runId) ?? "";
    if (stops.some((s) => s.runId === runId)) return json(200, []);
    if (text.includes("withhold")) return json(200, [{ kind: "reply", text: `This answer contains restricted data. Open it here: ${door}/runs/x` }]);
    return json(200, [{ kind: "reply", text: `Samples go in freezer B <-80 C> & stay there. [sop-freezer.md]` }]);
  }
  json(404, { error: "not found" });
});
doorServer.listen(0, "127.0.0.1");
await once(doorServer, "listening");
const door = `http://127.0.0.1:${(doorServer.address() as { port: number }).port}`;

let slack: FakeSlack;
let child: ChildProcess;
let stderr = "";

function run(env: Record<string, string>, args: string[] = []): Promise<{ status: number | null; stderr: string }> {
  const c = spawn(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/aliquot.ts", "slack", "--door", door, ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", ...env } });
  let err = "";
  c.stderr.on("data", (d) => (err += d));
  return new Promise((resolve) => c.on("close", (status) => resolve({ status, stderr: err })));
}

const goodEnv = () => ({ ALIQUOT_SURFACE_TOKEN: SURFACE_TOKEN, SLACK_APP_TOKEN: APP_TOKEN, SLACK_BOT_TOKEN: BOT_TOKEN, ALIQUOT_SLACK_API: slack.api });

before(async () => {
  slack = await startFakeSlack();
  child = spawn(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/aliquot.ts", "slack", "--door", door, "--links", "https://lab.example.edu/aliquot"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", ...goodEnv() },
  });
  child.stderr!.on("data", (d) => (stderr += d));
  await slack.connected();
});
after(async () => {
  const closed = child.exitCode === null ? once(child, "close") : null;
  child.kill("SIGTERM");
  await closed;
  await slack.close();
  doorServer.closeAllConnections();
  doorServer.close();
});

let n = 0;
/** One mention in channel C0LAB, as its own thread unless thread_ts is given. */
function mention(text: string, extra: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}): { id: string; ts: string } {
  const id = `env-${++n}`;
  const ts = `1730100000.${String(n).padStart(6, "0")}`;
  slack.deliver(id, { type: "app_mention", user: "U0MEMBER", text: `<@U0ALIQUOT> ${text}`, channel: "C0LAB", ts, ...extra }, envelope);
  return { id, ts };
}

/** The final text in the thread: the edit of the "looking" message posted in reply to ts. */
async function finalIn(thread: string): Promise<string> {
  return slack.waitFor(`the answer in thread ${thread}`, () => {
    const posted = slack.calls.findIndex((c) => c.method === "chat.postMessage" && c.body.thread_ts === thread);
    if (posted < 0) return undefined;
    const update = slack.calls.slice(posted).find((c) => c.method === "chat.update" && c.body.channel === slack.calls[posted]!.body.channel);
    return update?.body.text as string | undefined;
  });
}

test("a mention asks the door as the slack surface and the thread gets the answer with its record link", async () => {
  const { id, ts } = mention("Where do samples go?");
  const text = await finalIn(ts);
  assert.ok(slack.acks.includes(id), "the envelope was acknowledged");
  const q = asked.at(-1)!;
  assert.deepEqual(q, { channel: "C0LAB", thread: ts, message: ts, text: "Where do samples go?", user: "U0MEMBER" });
  assert.ok(auths.every((a) => a === `Bearer ${SURFACE_TOKEN}`), "every door request carries the slack surface's token");
  assert.match(text, /^Samples go in freezer B &lt;-80 C&gt; &amp; stay there\. \[sop-freezer\.md\]\n\n<https:\/\/lab\.example\.edu\/aliquot\/runs\/[0-9a-f-]+\|Record of this answer>$/);
  const looking = slack.calls.find((c) => c.method === "chat.postMessage" && c.body.thread_ts === ts)!;
  assert.equal(looking.body.text, "Looking in the lab's sources.");
  assert.ok(slack.calls.filter((c) => c.method.startsWith("chat.")).every((c) => c.auth === `Bearer ${BOT_TOKEN}`));
  assert.ok(slack.calls.filter((c) => c.method === "apps.connections.open").every((c) => c.auth === `Bearer ${APP_TOKEN}`));
});

test("an answer above the slack surface's placement posts the record link and nothing of the answer", async () => {
  const from = slack.calls.length;
  const { ts } = mention("withhold: who enrolled P-0042?");
  const text = await finalIn(ts);
  assert.match(text, /^This answer holds data above what Slack may keep, so it stays in the lab\. Read it in the record: <https:\/\/lab\.example\.edu\/aliquot\/runs\/[0-9a-f-]+>$/);
  assert.ok(!slack.calls.slice(from).some((c) => JSON.stringify(c.body).includes("freezer B")), "no answer text reached Slack for this run");
});

test("a gate refusal posts the door's message and no record link", async () => {
  const { ts } = mention("refuse me");
  assert.equal(await finalIn(ts), "You are not a member of this lab's harness.");
});

test("a reply in the thread continues it, and stop in the thread stops the run in it", async () => {
  const first = mention("slow question");
  await slack.waitFor("the slow run to start", () => asked.some((a) => a.text === "slow question"));
  await new Promise((r) => setTimeout(r, 400));
  mention("stop", { thread_ts: first.ts });
  await slack.waitFor("the stop", () => stops.length > 0);
  assert.equal(stops[0]!.user, "U0MEMBER");
  assert.equal(stops[0]!.confirmed, true);
  const text = await finalIn(first.ts);
  assert.match(text, /No answer; the run ended stopped\./);
  const replyInThread = mention("And the -20?", { thread_ts: first.ts });
  await slack.waitFor("the follow-up", () => asked.find((a) => a.text === "And the -20?"));
  const follow = asked.find((a) => a.text === "And the -20?")!;
  assert.equal(follow.thread, first.ts);
  assert.equal(follow.message, replyInThread.ts);
});

test("a direct message is a question; bots, edits, other workspaces and a resent envelope ask nothing", async () => {
  const before = asked.length;
  slack.deliver("env-bot", { type: "message", channel_type: "im", user: "U0BOT", bot_id: "B1", text: "hi", channel: "D0", ts: "1.1" });
  slack.deliver("env-edit", { type: "message", channel_type: "im", subtype: "message_changed", user: "U0MEMBER", text: "hi", channel: "D0", ts: "1.2" });
  slack.deliver("env-ext", { type: "app_mention", user: "U0OTHER", user_team: "T0ELSEWHERE", text: "<@U0ALIQUOT> hi", channel: "C0SHARED", ts: "1.3" });
  slack.deliver("env-shared", { type: "app_mention", user: "U0MEMBER", text: "<@U0ALIQUOT> hi", channel: "C0SHARED", ts: "1.4" }, { is_ext_shared_channel: true });
  slack.deliver("env-chan", { type: "message", channel_type: "channel", user: "U0MEMBER", text: "no mention", channel: "C0LAB", ts: "1.5" });
  const dm = { type: "message", channel_type: "im", user: "U0MEMBER", text: "Where is the codebook?", channel: "D0MEMBER", ts: "1.6" };
  slack.deliver("env-dm", dm);
  slack.deliver("env-dm-again", dm);
  const text = await finalIn("1.6");
  assert.match(text, /Record of this answer/);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(asked.slice(before).map((a) => a.text), ["Where is the codebook?"]);
  for (const id of ["env-bot", "env-edit", "env-ext", "env-shared", "env-chan", "env-dm", "env-dm-again"]) assert.ok(slack.acks.includes(id), `${id} acknowledged`);
  assert.match(stderr, /ignored a message from outside the workspace in C0SHARED/);
});

test("after Slack disconnects the socket, the door opens a new one and keeps answering", async () => {
  const opens = slack.calls.filter((c) => c.method === "apps.connections.open").length;
  slack.disconnect();
  await slack.connected();
  assert.equal(slack.calls.filter((c) => c.method === "apps.connections.open").length, opens + 1);
  const { ts } = mention("Where do samples go, again?");
  assert.match(await finalIn(ts), /Record of this answer/);
});

test("without the slack surface's token, or with the wrong kind of Slack token, it does not start", async () => {
  const env = goodEnv();
  const noSurface = await run({ ...env, ALIQUOT_SURFACE_TOKEN: "" });
  assert.equal(noSurface.status, 2);
  assert.match(noSurface.stderr, /ALIQUOT_SURFACE_TOKEN is not set/);
  assert.equal((await run({ ...env, SLACK_APP_TOKEN: BOT_TOKEN })).status, 2);
  assert.equal((await run({ ...env, SLACK_BOT_TOKEN: APP_TOKEN })).status, 2);
  const plain = await run({ ...env, ALIQUOT_SLACK_API: "http://slack.example.com/api/" });
  assert.equal(plain.status, 2);
  assert.match(plain.stderr, /must be https/);
});

test("questionText takes out mentions and Slack's escaping", () => {
  assert.equal(questionText("<@U0ALIQUOT> is &lt;5 mL &amp; ok? see <https://x.org/a|the SOP>"), "is <5 mL & ok? see the SOP (https://x.org/a)");
});

test("the app manifest asks for Socket Mode, the two events the door reads and the three scopes they need, and nothing more", () => {
  const manifest = JSON.parse(readFileSync(join(root, "docs/slack-app-manifest.json"), "utf8"));
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ["app_mention", "message.im"]);
  assert.deepEqual(manifest.oauth_config.scopes, { bot: ["app_mentions:read", "chat:write", "im:history"] });
  assert.equal(manifest.settings.event_subscriptions.request_url, undefined, "no public URL: Socket Mode only");
  assert.equal(manifest.features.app_home.messages_tab_enabled, true, "members can DM the app");
});
