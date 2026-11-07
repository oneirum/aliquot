import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { questionText, threadOf } from "../packages/core/src/surfaces/teams.ts";
import { checkServiceUrl } from "../packages/core/src/surfaces/teams-wire.ts";
import { APP_ID, APP_SECRET, startFakeTeams, TENANT, type FakeTeams } from "../scripts/fake-teams.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SURFACE_TOKEN = "t".repeat(64);

/** A door that answers by the question: "withhold" is above the teams surface, "refuse" fails the gate, "slow" runs until stopped. */
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

let teams: FakeTeams;
let child: ChildProcess;
let stderr = "";
let endpoint = "";

function run(env: Record<string, string>): Promise<{ status: number | null; stderr: string }> {
  const c = spawn(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/aliquot.ts", "teams", "--door", door, "--listen", "127.0.0.1:0"], { cwd: root, env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", ...env } });
  let err = "";
  c.stderr.on("data", (d) => (err += d));
  const timer = setTimeout(() => c.kill("SIGTERM"), 15_000);
  return new Promise((resolve) => c.on("close", (status) => (clearTimeout(timer), resolve({ status, stderr: err }))));
}

const goodEnv = () => ({ ALIQUOT_SURFACE_TOKEN: SURFACE_TOKEN, MICROSOFT_APP_ID: APP_ID, MICROSOFT_APP_PASSWORD: APP_SECRET, MICROSOFT_APP_TENANT_ID: TENANT, ALIQUOT_TEAMS_OPENID: teams.openid, ALIQUOT_TEAMS_LOGIN: teams.login });

before(async () => {
  teams = await startFakeTeams();
  child = spawn(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/aliquot.ts", "teams", "--door", door, "--links", "https://lab.example.edu/aliquot", "--listen", "127.0.0.1:0"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", ...goodEnv() },
  });
  child.stderr!.on("data", (d) => (stderr += d));
  endpoint = await teams.waitFor("the listening line", () => /listening on (http:\/\/\S+\/api\/messages)/.exec(stderr)?.[1]);
});
after(async () => {
  const closed = child.exitCode === null ? once(child, "close") : null;
  child.kill("SIGTERM");
  await closed;
  await teams.close();
  doorServer.closeAllConnections();
  doorServer.close();
});

/** Delivers a channel mention (or another kind) and returns the activity. */
async function say(text: string, opts: Parameters<FakeTeams["activity"]>[1] = {}): Promise<Record<string, any>> {
  const a = teams.activity(text, opts);
  assert.equal(await teams.deliver(endpoint, a), 200);
  return a;
}

test("a channel mention asks the door as the teams surface and the thread gets the cited answer with its record link", async () => {
  const a = await say("Where do samples go?");
  const text = await teams.answerTo(a.id);
  const q = asked.at(-1)!;
  assert.deepEqual(q, { channel: "19:lab0general@thread.tacv2", thread: a.id, message: a.id, text: "Where do samples go?", user: "aad-member-0001" });
  assert.ok(auths.every((x) => x === `Bearer ${SURFACE_TOKEN}`), "every door request carries the teams surface's token");
  assert.match(text, /^Samples go in freezer B &lt;-80 C&gt; &amp; stay there\. \[sop-freezer\.md\]\n\n\[Record of this answer\]\(https:\/\/lab\.example\.edu\/aliquot\/runs\/[0-9a-f-]+\)$/);
  const looking = teams.calls.find((c) => c.method === "POST" && c.activityId === a.id)!;
  assert.equal(looking.body.text, "Looking in the lab's sources.");
  assert.equal(looking.conversationId, a.conversation.id, "the reply goes to the channel thread's conversation");
  const connector = teams.calls.filter((c) => c.method !== "TOKEN");
  assert.ok(connector.every((c) => c.auth?.startsWith("Bearer fake-connector-token-")), "every connector call carries the app's token");
  const token = teams.calls.find((c) => c.method === "TOKEN")!;
  assert.deepEqual(token.body, { tenant: TENANT, client_id: APP_ID, scope: "https://api.botframework.com/.default", grant_type: "client_credentials" });
});

test("an answer above the teams surface's placement posts the record link and nothing of the answer", async () => {
  const from = teams.calls.length;
  const a = await say("withhold: who enrolled P-0042?");
  const text = await teams.answerTo(a.id);
  assert.match(text, /^This answer holds data above what Teams may keep, so it stays in the lab\. Read it in the record: \[(https:\/\/lab\.example\.edu\/aliquot\/runs\/[0-9a-f-]+)\]\(\1\)$/);
  assert.ok(!teams.calls.slice(from).some((c) => JSON.stringify(c.body).includes("freezer B")), "no answer text reached Teams for this run");
});

test("a gate refusal posts the door's message and no record link", async () => {
  const a = await say("refuse me");
  assert.equal(await teams.answerTo(a.id), "You are not a member of this lab's harness.");
});

test("a reply in a channel thread continues it, and stop in the thread stops the run in it", async () => {
  const first = await say("slow question");
  await teams.waitFor("the slow run to start", () => asked.some((x) => x.text === "slow question"));
  await new Promise((r) => setTimeout(r, 400));
  const stop = await say("stop", { inThread: first.id });
  await teams.waitFor("the stop", () => stops.length > 0);
  assert.equal(stops[0]!.user, "aad-member-0001");
  assert.equal(stops[0]!.confirmed, true);
  assert.match(await teams.answerTo(first.id), /No answer; the run ended stopped\./);
  const said = await teams.waitFor("the stopping reply", () => teams.calls.find((c) => c.method === "POST" && c.activityId === stop.id));
  assert.equal(said.body.text, "Stopping. The run ends at its next step.");
  const follow = await say("And the -20?", { inThread: first.id });
  await teams.waitFor("the follow-up", () => asked.find((x) => x.text === "And the -20?"));
  const q = asked.find((x) => x.text === "And the -20?")!;
  assert.equal(q.thread, first.id);
  assert.equal(q.message, follow.id);
});

test("a personal chat is one thread: a question in it is answered, and stop reaches its run", async () => {
  const a = await say("Where is the codebook?", { kind: "personal" });
  assert.match(await teams.answerTo(a.id), /Record of this answer/);
  const q = asked.find((x) => x.text === "Where is the codebook?")!;
  assert.equal(q.thread, a.conversation.id);
  assert.equal(q.channel, a.conversation.id);
  const slow = await say("slow personal question", { kind: "personal" });
  await teams.waitFor("the personal slow run", () => asked.some((x) => x.text === "slow personal question"));
  await new Promise((r) => setTimeout(r, 400));
  const before = stops.length;
  await say("stop", { kind: "personal" });
  await teams.waitFor("the personal stop", () => stops.length > before);
  assert.match(await teams.answerTo(slow.id), /No answer; the run ended stopped\./);
});

test("bots, other activity types, other tenants and a resent activity ask nothing", async () => {
  const before = asked.length;
  await say("hi from a bot", { fromBot: true });
  await say("an edit", { type: "messageUpdate" });
  await say("a guest from elsewhere", { tenant: "ffffffff-0000-4000-8000-000000000000" });
  const dup = teams.activity("Where are the gloves?", { kind: "groupChat" });
  assert.equal(await teams.deliver(endpoint, dup), 200);
  assert.equal(await teams.deliver(endpoint, dup), 200);
  assert.match(await teams.answerTo(dup.id), /Record of this answer/);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(asked.slice(before).map((x) => x.text), ["Where are the gloves?"]);
  assert.match(stderr, /ignored a message from outside the tenant in 19:lab0general@thread\.tacv2/);
});

test("an activity without the Bot Framework's signature, for another app, expired, or naming another serviceUrl is refused 401 and asks nothing", async () => {
  const before = asked.length;
  const a = () => teams.activity("Where do samples go? (unsigned)");
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await teams.deliver(endpoint, a(), "none"), 401);
  assert.equal(await teams.deliver(endpoint, a(), "forged"), 401);
  assert.equal(await teams.deliver(endpoint, a(), { aud: "00000000-0000-4000-8000-000000000000" }), 401);
  assert.equal(await teams.deliver(endpoint, a(), { iss: "https://evil.example.com" }), 401);
  assert.equal(await teams.deliver(endpoint, a(), { exp: now - 3600 }), 401);
  assert.equal(await teams.deliver(endpoint, a(), { serviceurl: "https://collector.example.com/" }), 401);
  const elsewhere: Record<string, any> = { ...a(), serviceUrl: "https://collector.example.com/" };
  assert.equal(await teams.deliver(endpoint, elsewhere), 401, "signed for that serviceUrl, but it is not a Teams host");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(asked.length, before, "the door is asked nothing");
  assert.ok(!teams.calls.some((c) => c.activityId === elsewhere.id), "nothing was posted, and no connector token went to a host that is not Teams");
  assert.match(stderr, /is not a Teams connector host/);
  assert.match(stderr, /refused a request to \/api\/messages: no Bot Framework token/);
  assert.match(stderr, /signature does not verify/);
});

test("without the teams surface's token, or with missing Microsoft settings, it does not start", async () => {
  const env = goodEnv();
  const noSurface = await run({ ...env, ALIQUOT_SURFACE_TOKEN: "" });
  assert.equal(noSurface.status, 2);
  assert.match(noSurface.stderr, /ALIQUOT_SURFACE_TOKEN is not set/);
  assert.equal((await run({ ...env, MICROSOFT_APP_ID: "aliquot" })).status, 2);
  assert.equal((await run({ ...env, MICROSOFT_APP_PASSWORD: "" })).status, 2);
  assert.equal((await run({ ...env, MICROSOFT_APP_TENANT_ID: "common" })).status, 2);
  const plain = await run({ ...env, ALIQUOT_TEAMS_OPENID: "http://login.example.com/openid" });
  assert.equal(plain.status, 2);
  assert.match(plain.stderr, /must be https/);
});

test("questionText takes out mentions and Teams' markup", () => {
  assert.equal(questionText("<at>Aliquot</at> is &lt;5&nbsp;mL &amp; ok?<br>see <b>the SOP</b>"), "is <5 mL & ok?\nsee the SOP");
});

test("threadOf: a channel post and its replies share a thread; a chat is one thread", () => {
  assert.deepEqual(threadOf("19:c@thread.tacv2;messageid=111", "222", "channel"), { channel: "19:c@thread.tacv2", thread: "111" });
  assert.deepEqual(threadOf("a:1xyz", "333", "personal"), { channel: "a:1xyz", thread: "a:1xyz" });
});

test("checkServiceUrl allows the Teams connector hosts and loopback only", () => {
  for (const ok of ["https://smba.trafficmanager.net/amer/", "https://smba.infra.gcc.teams.microsoft.com/", "http://127.0.0.1:9/connector/"]) checkServiceUrl(ok);
  for (const bad of ["http://smba.trafficmanager.net/amer/", "https://trafficmanager.net.example.com/", "https://example.com/"]) assert.throws(() => checkServiceUrl(bad), /not a Teams connector host/);
});

test("the app manifest is a bot in team, group chat and personal scopes, with no Graph or resource-specific permissions", () => {
  const manifest = JSON.parse(readFileSync(join(root, "docs/teams-app-manifest.json"), "utf8"));
  assert.equal(manifest.bots.length, 1);
  assert.deepEqual([...manifest.bots[0].scopes].sort(), ["groupChat", "personal", "team"]);
  assert.equal(manifest.bots[0].supportsFiles, false);
  assert.equal(manifest.webApplicationInfo, undefined, "no single sign-on, so no Graph consent");
  assert.equal(manifest.authorization, undefined, "no resource-specific consent, so the bot reads only messages that mention it");
  assert.deepEqual(manifest.permissions, ["identity", "messageTeamMembers"]);
});
