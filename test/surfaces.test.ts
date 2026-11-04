import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvents, type RunId } from "../packages/core/src/record.ts";
import { processes, waitFor } from "../scripts/procs.ts";
import { freshDatabase } from "./db.ts";
import { startFakeModel } from "./fake-model.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "labh-surfaces-"));
const { db, url } = await freshDatabase("labh_test_surfaces");
const model = await startFakeModel("scripted-1", "answer");

const hex = () => randomBytes(32).toString("hex");
const ACP = hex();
const SLACK = hex();
/** The token a phone bridge would hold; the door's environment has none for it. */
const PHONE = hex();
const BRIDGE = hex();
const SHORT = "only-twenty-two-chars!";
/** The fake model answers "Scripted answer to: <question>", so either string in a body is the answer leaking. */
const QUESTION = "Which freezer holds batch quokka-5531?";
const LEAKS = ["Scripted answer", "quokka-5531"];

const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: url, LABH_PAYLOAD_KEY: hex(), LAB_ACP_TOKEN: ACP, LAB_SLACK_TOKEN: SLACK, LAB_KIOSK_TOKEN: SHORT, LAB_BRIDGE_TOKEN: BRIDGE };

const base = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
const agentPath = join(work, "agent.json");
writeFileSync(agentPath, JSON.stringify({ ...base, agentId: "surfaces", knowledgeBases: [], tools: [], model: { endpointId: "local", modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 256 } } }));

function labToml(surfaces: string): string {
  const path = join(work, `lab-${randomBytes(4).toString("hex")}.toml`);
  writeFileSync(
    path,
    `[endpoints.local]\nbase_url = "${model.url}"\nplacement = "lab"\n[surfaces.web]\nplacement = "lab"\nport = 0\n${surfaces}[channel_floors]\n"acp:lab" = "D2"\n[agents]\nfixtures = ["${agentPath}"]\n`,
  );
  return path;
}

const cfg = labToml(
  [
    '[surfaces.acp]\nkind = "acp"\nplacement = "zdr"\ntoken_env = "LAB_ACP_TOKEN"\n',
    '[surfaces.slack]\nkind = "slack"\nplacement = "approved"\ntoken_env = "LAB_SLACK_TOKEN"\n',
    '[surfaces.phone]\nkind = "phone"\nplacement = "zdr"\ntoken_env = "LAB_PHONE_TOKEN"\n',
    '[surfaces.kiosk]\nkind = "phone"\nplacement = "zdr"\ntoken_env = "LAB_KIOSK_TOKEN"\n',
    '[surfaces.bridge]\nkind = "phone"\nplacement = "zdr"\ntoken_env = "LAB_BRIDGE_TOKEN"\n',
  ].join(""),
);

const ps = processes(root, work, env);
const web = await ps.startWeb(cfg);
ps.startWorker(cfg, "S1");
after(async () => {
  await ps.stopAll();
  await model.close();
  await db.end();
  rmSync(work, { recursive: true, force: true });
});

/** The response as bytes on the wire: no accept-encoding, so the door never gzips. */
function raw(method: "GET" | "POST", path: string, opts: { auth?: string; body?: unknown } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
  const headers = { ...(payload ? { "content-type": "application/json" } : {}), ...(opts.auth === undefined ? {} : { authorization: opts.auth }) };
  return new Promise((resolve, reject) => {
    const req = request(`${web.base}${path}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const bearer = (token: string) => `Bearer ${token}`;
let sent = 0;
const message = (text: string) => ({ thread: `t-${sent}`, message: `m-${sent++}`, text, user: "member-1" });

async function ask(text: string, auth?: string): Promise<RunId> {
  const r = await raw("POST", "/message", { auth, body: message(text) });
  assert.equal(r.status, 202, r.text);
  return (JSON.parse(r.text) as { runId: RunId }).runId;
}

interface WireEvent {
  readonly event: { readonly t: string; readonly surface?: string; readonly mode?: string; readonly answer?: { readonly cls: string } | null };
}
async function finished(runId: RunId, auth?: string): Promise<WireEvent[]> {
  return waitFor(
    `run ${runId} to finish`,
    async () => {
      const events = JSON.parse((await raw("GET", `/runs/${runId}/events`, { auth })).text) as WireEvent[];
      return events.some((e) => e.event.t === "run.finished") ? events : null;
    },
    30_000,
  );
}
const eventOf = (events: readonly WireEvent[], t: string) => events.find((e) => e.event.t === t)!.event;

test("an answer above the acp surface's placement leaves the door as the record link only, on the wire and through aliquot ask", async () => {
  const runId = await ask(QUESTION, bearer(ACP));
  const events = await finished(runId, bearer(ACP));
  assert.equal(eventOf(events, "run.started").surface, "acp");
  assert.equal(eventOf(events, "run.finished").answer?.cls, "D2");
  assert.equal(eventOf(events, "reply.posted").mode, "link-only");

  const replies = await raw("GET", `/replies?runId=${runId}`, { auth: bearer(ACP) });
  assert.equal(replies.status, 200);
  for (const leak of LEAKS) assert.equal(replies.text.includes(leak), false, `the replies body holds ${leak}: ${replies.text}`);
  const notices = JSON.parse(replies.text) as { kind: string; text: string }[];
  assert.deepEqual(notices.map((n) => n.kind), ["reply"]);
  const link = new URL(/Open it here: (\S+)$/.exec(notices[0]!.text)![1]!);
  assert.equal(link.pathname, `/runs/${runId}`);
  assert.equal((await raw("GET", link.pathname)).status, 200);
  const view = JSON.parse((await raw("GET", `${link.pathname}/view`)).text) as { rows: { t: string; detail: string }[] };
  assert.match(view.rows.find((r) => r.t === "run.started")!.detail, /^acp thread,/, "the record page names the surface");

  const cli = processes(root, work, { PATH: env.PATH, NODE_NO_WARNINGS: "1", ALIQUOT_SURFACE_TOKEN: ACP }).start("ask-acp", "aliquot.ts", ["ask", "--door", web.base, "--user", "member-1", "--json", QUESTION]);
  const { code } = await cli.exit;
  const out = cli.out.join("");
  assert.equal(code, 0, out);
  for (const leak of LEAKS) assert.equal(out.includes(leak), false, `aliquot ask printed ${leak}: ${out}`);
  const last = JSON.parse(out.trim().split("\n").at(-1)!) as { t: string; runId: RunId; answer: string | null; cls: string; withheld: boolean };
  assert.deepEqual({ t: last.t, answer: last.answer, cls: last.cls, withheld: last.withheld }, { t: "finished", answer: null, cls: "D2", withheld: true });
  const [start] = await loadEvents(db, last.runId);
  assert.equal(start!.event.t === "run.started" ? start!.event.surface : null, "acp");
});

test("the same question with no token is the web surface, which answers in lab with the text", async () => {
  const runId = await ask(QUESTION);
  const events = await finished(runId);
  assert.equal(eventOf(events, "run.started").surface, "web");
  assert.equal(eventOf(events, "reply.posted").mode, "final-post");
  const replies = JSON.parse((await raw("GET", `/replies?runId=${runId}`)).text) as { kind: string; text: string }[];
  assert.deepEqual(replies.map((r) => r.kind), ["reply"]);
  assert.match(replies[0]!.text, /^Scripted answer to: .*quokka-5531/);
});

test("a request that tries to authenticate and fails is a 401 on every route, and never falls back to web", async () => {
  const runId = await ask("a run to aim at", bearer(ACP));
  await finished(runId, bearer(ACP));
  const unknown = "unknown surface token";
  const scheme = "Authorization must be Bearer <surface token>";
  const attempts: [string, string, string][] = [
    ["an unknown token", bearer(hex()), unknown],
    ["Bearer with nothing after it", "Bearer ", scheme],
    ["the token of a surface whose env var is unset on the door", bearer(PHONE), unknown],
    ["a token shorter than 32 characters", bearer(SHORT), unknown],
  ];
  const routes: ["GET" | "POST", string, unknown][] = [
    ["POST", "/message", message("never runs")],
    ["POST", "/stop", { runId, user: "member-1", confirmed: true }],
    ["GET", `/replies?runId=${runId}`, undefined],
    ["GET", `/runs/${runId}/events`, undefined],
  ];
  const jobs = async () => (await db.query<{ n: number }>("select count(*)::int as n from jobs")).rows[0]!.n;
  const inbox = async () => (await db.query<{ n: number }>("select count(*)::int as n from run_inbox")).rows[0]!.n;
  const before = [await jobs(), await inbox()];
  for (const [what, auth, error] of attempts) {
    for (const [method, path, body] of routes) {
      const r = await raw(method, path, { auth, body });
      assert.deepEqual([r.status, JSON.parse(r.text), r.headers["www-authenticate"]], [401, { error }, "Bearer"], `${what} on ${method} ${path}`);
    }
  }
  assert.deepEqual([await jobs(), await inbox()], before, "no refused request enqueued a run or a stop");
});

test("a surface reads and stops only its own runs: an acp token on a web run, or no token on an acp run, is 404", async () => {
  const webRun = await ask("a web run");
  const acpRun = await ask("an acp run", bearer(ACP));
  await finished(webRun);
  await finished(acpRun, bearer(ACP));
  const cases: [string, string | undefined, "GET" | "POST", string, unknown][] = [
    ["acp reads a web run", bearer(ACP), "GET", `/replies?runId=${webRun}`, undefined],
    ["acp stops a web run", bearer(ACP), "POST", "/stop", { runId: webRun, user: "member-1", confirmed: true }],
    ["web reads an acp run", undefined, "GET", `/replies?runId=${acpRun}`, undefined],
  ];
  for (const [what, auth, method, path, body] of cases) {
    const r = await raw(method, path, { auth, body });
    assert.deepEqual([r.status, JSON.parse(r.text)], [404, { error: "no such run" }], what);
  }
  assert.equal((await db.query("select 1 from run_inbox where run_id = $1", [webRun])).rowCount, 0);
  assert.equal((await raw("GET", `/replies?runId=${acpRun}`, { auth: bearer(ACP) })).status, 200);
  const own = await raw("POST", "/stop", { auth: bearer(ACP), body: { runId: acpRun, user: "member-1", confirmed: true } });
  assert.equal(own.status, 202, own.text);
  assert.equal((await db.query("select 1 from run_inbox where run_id = $1", [acpRun])).rowCount, 1);
});

test("a phone surface's token is its own surface, and a reverse proxy's Basic credentials are the web surface", async () => {
  const phoneRun = await ask(QUESTION, bearer(BRIDGE));
  const phone = await finished(phoneRun, bearer(BRIDGE));
  assert.equal(eventOf(phone, "run.started").surface, "bridge");
  assert.equal(eventOf(phone, "reply.posted").mode, "final-post");

  const basic = `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`;
  assert.equal((await raw("GET", "/", { auth: basic })).status, 200);
  const proxied = await ask(QUESTION, basic);
  assert.equal(eventOf(await finished(proxied, basic), "run.started").surface, "web");
});

test("the door names each surface whose token it cannot accept, without printing any token", () => {
  const out = web.proc.out.join("");
  assert.match(out, /LAB_PHONE_TOKEN/);
  assert.match(out, /LAB_KIOSK_TOKEN/);
  for (const token of [ACP, SLACK, SHORT, BRIDGE]) assert.equal(out.includes(token), false);
});

test("two surfaces given the same token value stop the door before it listens", async () => {
  const dup = labToml('[surfaces.acp]\nkind = "acp"\nplacement = "zdr"\ntoken_env = "LAB_ACP_TOKEN"\n[surfaces.ide]\nkind = "acp"\nplacement = "zdr"\ntoken_env = "LAB_IDE_TOKEN"\n');
  const dupPs = processes(root, work, { ...env, LAB_IDE_TOKEN: ACP });
  const door = dupPs.start("web-dup", "web.ts", ["--config", dup, "--port", "0"]);
  const exit = await Promise.race([door.exit, sleep(15_000).then(() => null)]);
  await dupPs.stopAll();
  const out = door.out.join("");
  assert.equal(exit?.code, 2, out);
  assert.match(out, /LAB_ACP_TOKEN and LAB_IDE_TOKEN hold the same token/);
  assert.equal(out.includes("listening"), false);
  assert.equal(out.includes(ACP), false);
});
