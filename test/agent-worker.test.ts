// End to end through bin/agent-worker.ts against Postgres: the fake CLI runs confined under the generated seatbelt
// profile, so these run on macOS only, the one platform with a confinement implementation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseAgentDocument } from "../packages/core/src/agent.ts";
import { Labelled } from "../packages/core/src/dataclass.ts";
import { bootShared, type SharedCore } from "../packages/core/src/boot-shared.ts";
import type { Db } from "../packages/core/src/db.ts";
import { intakeTest } from "../packages/core/src/frontdoor.ts";
import { loadEvents, sendToInbox, type PayloadRef, type RunEvent, type RunId } from "../packages/core/src/record.ts";
import { agentPermissionFlags } from "../packages/core/src/seal.ts";
import { recordProcess } from "../packages/core/src/agents/spawn.ts";
import { importTool } from "../packages/core/src/tools.ts";
import { freshDatabase } from "./db.ts";

const skip = process.platform !== "darwin";
const root = fileURLToPath(new URL("..", import.meta.url));
const CANARY = "PELICAN-CANARY-ZETA";
const MODEL = "claude-sonnet-4-5-20250929";

let db: Db;
let core: SharedCore;
let work: string;
let env: Record<string, string>;
let toml: string;
const workers = new Set<{ child: ChildProcess; out: string[] }>();
const lit = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(["Sleep and memory (2019)"])));

function install(dir: string, fake: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(root, "test/fake-agent-cli.ts"), join(dir, "cli.ts"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-agent-cli", type: "module" }));
  writeFileSync(join(dir, "fake.json"), JSON.stringify(fake));
  return join(dir, "cli.ts");
}

function startWorker(id: string, extra: readonly string[] = []): { child: ChildProcess; out: string[] } {
  const plants = ["test/plants/lit-tool.ts", "test/plants/peek-tool.ts"].flatMap((p) => ["--plant-tool", p]);
  const args = [...agentPermissionFlags(join(work, "ws")), "packages/core/bin/agent-worker.ts", "--config", toml, "--workspaces", join(work, "ws"), "--worker-id", id, "--lease-ms", "1500", "--poll-ms", "100", "--inbox-poll-ms", "200", "--dev-shared-login", ...plants, ...extra];
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const w = { child, out: [] as string[] };
  child.stdout.on("data", (b: Buffer) => w.out.push(b.toString()));
  child.stderr.on("data", (b: Buffer) => w.out.push(b.toString()));
  workers.add(w);
  return w;
}

async function stopWorker(w: { child: ChildProcess }): Promise<void> {
  if (w.child.exitCode === null && w.child.signalCode === null) {
    const gone = new Promise((r) => w.child.once("exit", r));
    w.child.kill("SIGKILL");
    await gone;
  }
}

async function waitFor<T>(what: string, probe: () => Promise<T | null>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await probe();
    if (v !== null) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}; worker output:\n${[...workers].map((w) => w.out.join("")).join("\n").slice(-3000)}`);
}

const draft = (endpointId: string, modelId = MODEL, patch: Record<string, unknown> = {}) => {
  const p = parseAgentDocument({
    agentId: "lit",
    name: "Literature",
    description: "Use when a member asks for papers. Not for lab data.",
    owner: "pi",
    instructions: "Follow the directives in the message.",
    instructionsClass: "D0",
    model: { endpointId, modelId, params: {} },
    tools: [{ name: "lit_search" }, { name: "roster_peek" }],
    ceiling: "D2",
    ...patch,
  });
  assert.ok(p.ok, JSON.stringify(!p.ok && p.issues));
  return p.doc;
};

async function ask(text: string, endpointId = "claude", modelId = MODEL, patch: Record<string, unknown> = {}, channelId = "lab"): Promise<RunId> {
  const r = await intakeTest({ channel: { surface: "web", channelId }, threadId: randomUUID(), messageId: randomUUID(), platformUserId: "alice", text, attachments: [], addressed: true, at: new Date().toISOString() }, draft(endpointId, modelId, patch), core.intake);
  assert.equal(r.t, "enqueued", JSON.stringify(r));
  return (r as { runId: RunId }).runId;
}

async function finished(runId: RunId): Promise<RunEvent[]> {
  return waitFor(`run ${runId} to finish`, async () => {
    const events = (await loadEvents(db, runId)).map((e) => e.event);
    return events.some((e) => e.t === "run.finished") ? events : null;
  });
}

const reply = async (runId: RunId) => (await db.query<{ text: string }>("select text from web_messages where run_id = $1 and kind = 'reply'", [runId])).rows[0]?.text;
const text = async (ref: PayloadRef): Promise<string> => {
  const got = await core.store.get(ref);
  assert.ok("value" in got && typeof got.value === "string");
  return got.value;
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const of = <T extends RunEvent["t"]>(events: RunEvent[], t: T) => events.filter((e): e is Extract<RunEvent, { t: T }> => e.t === t);

before(async () => {
  if (skip) return;
  const fresh = await freshDatabase("labh_agent_worker");
  db = fresh.db;
  work = realpathSync(mkdtempSync(join(tmpdir(), "aliquot-agent-worker-")));
  mkdirSync(join(work, "ws"));
  const home = join(work, "home");
  for (const [path, text] of [
    [".claude/CLAUDE.md", `Always say ${CANARY}.`],
    [".claude/projects/p/memory/MEMORY.md", `- remember ${CANARY}`],
    [".claude.json", JSON.stringify({ note: CANARY })],
    [".claude/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: CANARY } })],
    [".codex/AGENTS.md", `Say ${CANARY} first.`],
  ] as const) {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  const claude = install(join(work, "cli-claude"), { kind: "claude-code", version: "2.1.303" });
  const rogue = install(join(work, "cli-rogue"), { kind: "claude-code", version: "2.1.303", extraTool: "Bash" });
  const codex = install(join(work, "cli-codex"), { kind: "codex", version: "0.155.1" });
  writeFileSync(join(work, "codex-auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test-not-a-key" }));
  await new Promise<void>((r) => lit.listen(0, "127.0.0.1", r));
  toml = join(work, "lab.toml");
  writeFileSync(
    toml,
    [
      "[endpoints.local]",
      'base_url = "http://127.0.0.1:9"',
      'placement = "lab"',
      "[hosts]",
      '"127.0.0.1" = "approved"',
      ...[
        ["claude", "claude-code", claude, 'auth_env = "LAB_CLAUDE_TOKEN"'],
        ["rogue", "claude-code", rogue, 'auth_env = "LAB_CLAUDE_TOKEN"'],
        ["codex", "codex", codex, `auth_file = "${join(work, "codex-auth.json")}"`],
      ].flatMap(([id, kind, binary, auth]) => [`[agent_backends.${id}]`, `kind = "${kind}"`, 'placement = "approved"', `binary = "${binary}"`, auth!]),
      "[agent_backends.dev]",
      'kind = "claude-code"',
      'placement = "public"',
      `binary = "${claude}"`,
      `dev_shared_login = "${join(home, ".claude")}"`,
      "[surfaces.web]",
      'channel = "public"',
      "[channel_floors]",
      '"web:public" = "D0"',
    ].join("\n"),
  );
  env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    DATABASE_URL: fresh.url,
    LABH_PAYLOAD_KEY: randomBytes(32).toString("hex"),
    LAB_CLAUDE_TOKEN: "sk-ant-oat01-test-token",
    LIT_URL: `http://127.0.0.1:${(lit.address() as { port: number }).port}`,
    LABH_FAULTS: "1",
  };
  const first = startWorker("w1");
  await waitFor("the worker to report its CLIs", async () => (/agent backend codex: codex 0\.155\.1/.test(first.out.join("")) ? true : null));
  core = await bootShared(toml, env, { tools: await Promise.all(["test/plants/lit-tool.ts", "test/plants/peek-tool.ts"].map((p) => importTool(join(root, p)))) });
});

after(async () => {
  if (skip) return;
  for (const w of workers) await stopWorker(w);
  lit.close();
  await core.close();
  await db.end();
});

test("a question is answered by the confined CLI through the bridge, recorded as one model call with its tool calls", { skip }, async () => {
  const runId = await ask('@call lit_search {"q":"sleep"}\n@answer found');
  const events = await finished(runId);
  assert.deepEqual(events.map((e) => e.t), ["run.started", "model.requested", "tool.requested", "tool.completed", "agent.session", "model.completed", "reply.posted", "run.finished"]);
  assert.equal(await reply(runId), 'found\nlit_search: {"titles":["Sleep and memory (2019)"]}');
  const [session] = of(events, "agent.session");
  assert.deepEqual({ ...session, argvHash: "", workspace: "" }, { t: "agent.session", attempt: 1, kind: "claude-code", cliVersion: "2.1.303", argvHash: "", workspace: "", exit: { code: 0, signal: null }, turns: 1, hostsTunneled: [], hostsRefused: 0, refusedTargets: null });
  assert.equal(of(events, "tool.requested")[0]!.callId, "s1-1");
  assert.equal(of(events, "model.completed")[0]!.providerModelId, MODEL);
  assert.equal(of(events, "run.finished")[0]!.outcome, "answered");
  const job = await db.query<{ engine: string }>("select payload->>'engine' as engine from jobs where id = $1", [runId]);
  assert.equal(job.rows[0]!.engine, "agent-cli");
});

test("a tool result above the backend's ceiling is withheld from the CLI and the run still answers", { skip }, async () => {
  const runId = await ask("@call roster_peek {}\n@answer checked");
  const events = await finished(runId);
  assert.deepEqual(of(events, "tool.withheld"), [{ t: "tool.withheld", callId: "s1-1", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D2" }, cls: "D3" }]);
  assert.equal(of(events, "run.finished")[0]!.outcome, "answered");
  assert.equal(await reply(runId), "checked\nroster_peek (error): withheld: D3 exceeds the destination ceiling D2");
});

test("a stop from the thread kills the CLI's process group and the run finishes stopped; a steer sent mid-session is not marked consumed", { skip }, async () => {
  const runId = await ask("@hang");
  await waitFor("the session to start", async () => ((await loadEvents(db, runId)).some((e) => e.event.t === "model.requested") ? true : null));
  await sendToInbox(db, runId, { t: "steer", text: await core.store.put(Labelled.stamp("focus on 2019", "D1", "test")), by: "alice" });
  await sleep(500);
  assert.deepEqual(of((await loadEvents(db, runId)).map((e) => e.event), "inbox.consumed"), []);
  await sendToInbox(db, runId, { t: "stop", confirmed: false, by: "alice" });
  const events = await finished(runId);
  assert.equal(of(events, "run.finished")[0]!.outcome, "stopped");
  assert.deepEqual(of(events, "agent.session")[0]!.exit, { code: null, signal: "SIGTERM" });
  assert.equal(await reply(runId), "Stopped.");
});

test("a stop kills the CLI's own children too, as codex's native binary would be", { skip }, async () => {
  const runId = await ask("@grandchild\n@hang", "codex", "gpt-5.1-codex");
  const pidFile = join(work, "ws", runId, "s1", "child.pid");
  const child = await waitFor("the grandchild", async () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null));
  assert.equal(alive(child), true);
  await sendToInbox(db, runId, { t: "stop", confirmed: false, by: "alice" });
  assert.equal(of(await finished(runId), "run.finished")[0]!.outcome, "stopped");
  await waitFor("the grandchild to die", async () => (alive(child) ? null : true), 10_000);
});

test("a worker that dies mid-session leaves its call unknown, and the next worker starts a fresh attempt that answers", { skip }, async () => {
  for (const w of workers) await stopWorker(w);
  const dying = startWorker("w-dies", ["--fault", "kill-after:tool.requested"]);
  const runId = await ask('@call lit_search {"q":"memory"}\n@answer second try');
  await new Promise((r) => dying.child.once("exit", r));
  startWorker("w2");
  const events = await finished(runId);
  assert.deepEqual(
    events.filter((e) => e.t.startsWith("tool.") || e.t.startsWith("model.") || e.t === "agent.session").map((e) => `${e.t}${"callId" in e ? ` ${e.callId}` : ""}${"attempt" in e && !("callId" in e) ? ` ${e.attempt}` : ""}`),
    ["model.requested 1", "tool.requested s1-1", "tool.outcome-unknown s1-1", "model.requested 2", "tool.requested s2-1", "tool.completed s2-1", "agent.session 2", "model.completed 2"],
  );
  assert.equal(await reply(runId), 'second try\nlit_search: {"titles":["Sleep and memory (2019)"]}');
});

test("the next worker kills a CLI the dead worker left running, by the pid file outside the workspace, and nothing a forged pid file names", { skip }, async () => {
  for (const w of workers) await stopWorker(w);
  const dying = startWorker("w-orphans", ["--fault", "kill-after:tool.requested"]);
  const runId = await ask('@call lit_search {"q":"orphan"}\n@hang');
  await new Promise((r) => dying.child.once("exit", r));
  const runRoot = join(work, "ws", runId);
  const { pid } = JSON.parse(readFileSync(join(runRoot, "s1.pid"), "utf8")) as { pid: number };
  assert.equal(alive(pid), true, "the CLI outlived its worker");
  const bystander = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  writeFileSync(join(runRoot, "s9.pid"), JSON.stringify({ pid: bystander.pid, start: "Thu Jan  1 00:00:00 1970" }));
  writeFileSync(join(runRoot, "s1", "pid"), String(bystander.pid));
  try {
    startWorker("w3");
    await waitFor("the orphan to be killed", async () => (alive(pid) ? null : true));
    assert.equal(alive(bystander.pid!), true);
    await waitFor("attempt 2", async () => ((await loadEvents(db, runId)).some((e) => e.event.t === "model.requested" && e.event.attempt === 2) ? true : null));
    await sendToInbox(db, runId, { t: "stop", confirmed: false, by: "alice" });
    assert.equal(of(await finished(runId), "run.finished")[0]!.outcome, "stopped");
  } finally {
    bystander.kill("SIGKILL");
  }
});

test("a session that loses its lease kills the CLI and removes its workspace before the worker lets go of the run", { skip }, async () => {
  if (![...workers].some((w) => w.child.exitCode === null)) startWorker("w-lease");
  const runId = await ask("@hang");
  const workspace = join(work, "ws", runId, "s1");
  await waitFor("the session to start", async () => (existsSync(`${workspace}.pid`) ? true : null));
  const { pid } = JSON.parse(readFileSync(`${workspace}.pid`, "utf8")) as { pid: number };
  await db.query("update jobs set lease_owner = 'another-host', lease_epoch = lease_epoch + 1, lease_until = now() + interval '1 hour' where id = $1", [runId]);
  await waitFor("the workspace to go", async () => (existsSync(workspace) || existsSync(`${workspace}.pid`) || alive(pid) ? null : true));
  await db.query("update jobs set status = 'failed', lease_owner = null, lease_until = null where id = $1", [runId]);
});

test("at boot the agent worker clears every run workspace no live lease holds, killing its recorded CLI, and keeps a held one", { skip }, async () => {
  for (const w of workers) await stopWorker(w);
  const stale = join(work, "ws", randomUUID());
  mkdirSync(join(stale, "s1", "config"), { recursive: true });
  writeFileSync(join(stale, "s1", "config", "auth.json"), "{}");
  const orphan = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  await recordProcess(join(stale, "s1.pid"), orphan.pid!);
  const heldId = (await db.query<{ id: string }>("insert into jobs (kind, key, payload, status, lease_owner, lease_epoch, lease_until) values ('run', $1, '{}', 'leased', 'another-host', 1, now() + interval '1 hour') returning id", [`k:sweep:${randomUUID()}`])).rows[0]!.id;
  const held = join(work, "ws", heldId);
  mkdirSync(join(held, "s1"), { recursive: true });
  try {
    const w = startWorker("w-sweep");
    await waitFor("the sweep", async () => (/swept \d+ workspaces of runs no live worker holds/.test(w.out.join("")) ? true : null));
    assert.deepEqual({ stale: existsSync(stale), held: existsSync(held), orphan: alive(orphan.pid!) }, { stale: false, held: true, orphan: false });
  } finally {
    orphan.kill("SIGKILL");
    await db.query("delete from jobs where id = $1", [heldId]);
  }
});

test("nothing in the worker's HOME reaches the CLI: the canary codeword is not in its prompt and its reads are denied", { skip }, async () => {
  const home = env.HOME!;
  const runId = await ask(`@read ${home}/.claude/CLAUDE.md\n@read ${home}/.claude/projects/p/memory/MEMORY.md\n@read ${home}/.codex/AGENTS.md\n@read ${home}/.claude.json\n@env\n@answer probed`);
  const events = await finished(runId);
  const text = (await reply(runId))!;
  assert.equal(text.includes(CANARY), false);
  assert.equal(
    text,
    [
      "probed",
      `read ${home}/.claude/CLAUDE.md: EPERM`,
      `read ${home}/.claude/projects/p/memory/MEMORY.md: EPERM`,
      `read ${home}/.codex/AGENTS.md: EPERM`,
      `read ${home}/.claude.json: EPERM`,
      "env: ALIQUOT_BRIDGE_TOKEN,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,CLAUDE_CODE_OAUTH_TOKEN,CLAUDE_CODE_TMPDIR,CLAUDE_CONFIG_DIR,DISABLE_AUTOUPDATER,HOME,HTTPS_PROXY,HTTP_PROXY,LANG,NODE_OPTIONS,NO_PROXY,PATH,TMPDIR,USER; config: ",
    ].join("\n"),
  );
  const prompt = await core.store.get(of(events, "model.requested")[0]!.prompt);
  assert.equal(JSON.stringify(prompt).includes(CANARY), false);
});

test("what the CLI sends the proxy is counted in the session event and kept only as a payload at the session's class", { skip }, async () => {
  const runId = await ask("@proxy CONNECT participant-LAB0-0003.example:443 HTTP/1.1\n@proxy GET http://x/\u001b[2Jsecret-row-42 HTTP/1.1\n@answer probed");
  const events = await finished(runId);
  assert.equal(await reply(runId), "probed\nproxy: HTTP/1.1 403 Forbidden\nproxy: HTTP/1.1 403 Forbidden");
  const [session] = of(events, "agent.session");
  assert.equal(session!.hostsRefused, 2);
  assert.equal(session!.refusedTargets!.cls, "D1");
  assert.deepEqual(JSON.parse(await text(session!.refusedTargets!)), ["participant-lab0-0003.example:443", "sha256:7ff9676f75414e8c"]);
  const stored = JSON.stringify(await loadEvents(db, runId));
  assert.equal(stored.includes("participant-lab0") || stored.includes("secret-row"), false);
});

test("under a dev login the CLI gets a fresh config dir and the operator's keychain name, and reads nothing of the operator's Claude state", { skip }, async () => {
  const home = env.HOME!;
  const reads = [".claude/CLAUDE.md", ".claude/projects/p/memory/MEMORY.md", ".claude/.credentials.json", ".claude.json"].map((p) => `${home}/${p}`);
  const runId = await ask(`${reads.map((p) => `@read ${p}`).join("\n")}\n@getenv CLAUDE_CONFIG_DIR\n@getenv CLAUDE_SECURESTORAGE_CONFIG_DIR\n@env\n@answer probed`, "dev", MODEL, { ceiling: "D0", tools: [] }, "public");
  const events = await finished(runId);
  assert.equal(of(events, "run.finished")[0]!.outcome, "answered");
  const text = (await reply(runId))!;
  assert.equal(text.includes(CANARY), false);
  const workspace = of(events, "agent.session")[0]!.workspace;
  assert.equal(
    text,
    [
      "probed",
      ...reads.map((p) => `read ${p}: EPERM`),
      `CLAUDE_CONFIG_DIR=${join(workspace, "config")}`,
      "CLAUDE_SECURESTORAGE_CONFIG_DIR=",
      "env: ALIQUOT_BRIDGE_TOKEN,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,CLAUDE_CODE_TMPDIR,CLAUDE_CONFIG_DIR,CLAUDE_SECURESTORAGE_CONFIG_DIR,DISABLE_AUTOUPDATER,HOME,HTTPS_PROXY,HTTP_PROXY,LANG,NODE_OPTIONS,NO_PROXY,PATH,TMPDIR,USER; config: ",
    ].join("\n"),
  );
});

test("the agent worker refuses dev-login mode in production before it reads any config", { skip }, async () => {
  const child = spawn(process.execPath, [...agentPermissionFlags(join(work, "ws")), "packages/core/bin/agent-worker.ts", "--config", "/nonexistent.toml", "--workspaces", join(work, "ws"), "--dev-shared-login"], { cwd: root, env: { ...env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
  const code = await new Promise((r) => child.once("exit", r));
  assert.deepEqual({ code, last: stderr.trim().split("\n").at(-1) }, { code: 2, last: "--dev-shared-login is never in production: it runs agent CLIs on the operator's own login" });
});

test("a CLI that loads a tool of its own fails its self-check before any call is served", { skip }, async () => {
  const runId = await ask('@call lit_search {"q":"sleep"}\n@answer leaked', "rogue");
  const events = await finished(runId);
  const reason = of(events, "run.faulted")[0]!.reason;
  assert.ok(reason.t === "agent-not-confined");
  assert.deepEqual({ check: reason.check, cls: reason.why.cls }, { check: "own-tool", cls: "D1" });
  assert.equal(await text(reason.why), "the CLI loaded tools of its own: Bash");
  assert.equal(JSON.stringify(await loadEvents(db, runId)).includes("Bash"), false);
  assert.equal(of(events, "tool.requested").length, 0);
  assert.equal(of(events, "run.finished")[0]!.outcome, "failed");
});

test("a Codex session answers through the same bridge and records that Codex did not report its model", { skip }, async () => {
  const runId = await ask('@call lit_search {"q":"sleep"}\n@answer codex found', "codex", "gpt-5.1-codex");
  const events = await finished(runId);
  assert.equal(of(events, "run.finished")[0]!.outcome, "answered");
  assert.equal(of(events, "model.completed")[0]!.providerModelId, "unreported");
  assert.equal(await reply(runId), 'codex found\nlit_search: {"titles":["Sleep and memory (2019)"]}');
});

test("past limits.maxSteps the bridge tells the CLI to finish instead of running the call", { skip }, async () => {
  const runId = await ask('@call lit_search {"q":"a"}\n@call lit_search {"q":"b"}\n@answer capped', "claude", MODEL, { limits: { maxSteps: 1 } });
  const events = await finished(runId);
  assert.deepEqual(of(events, "tool.requested").map((e) => e.callId), ["s1-1"]);
  assert.equal(await reply(runId), 'capped\nlit_search: {"titles":["Sleep and memory (2019)"]}\nlit_search (error): You have reached this run\'s limit on tool calls. Answer now with what you have, without calling tools.');
  assert.equal(of(events, "agent.session")[0]!.turns, 2);
  assert.deepEqual(of(events, "limit.hit"), [{ t: "limit.hit", which: "steps" }]);
  assert.equal(of(events, "run.finished")[0]!.outcome, "limit");
});

test("past limits.maxTokens, by the usage the CLI reports per turn, the CLI is killed and the run finishes limit with a notice", { skip }, async () => {
  const runId = await ask("@tokens 600\n@tokens 600\n@hang", "claude", MODEL, { limits: { maxTokens: 1000 } });
  const events = await finished(runId);
  assert.deepEqual(of(events, "limit.hit"), [{ t: "limit.hit", which: "tokens" }]);
  assert.equal(of(events, "run.finished")[0]!.outcome, "limit");
  assert.equal(await reply(runId), "The agent session reached its token limit before it finished.");
});

test("at the wall limit the CLI is killed and the run finishes limit with a notice", { skip }, async () => {
  const runId = await ask("@say Let me search PubMed for that.\n@hang", "claude", MODEL, { limits: { maxWallMs: 1500 } });
  const events = await finished(runId);
  assert.deepEqual(of(events, "limit.hit"), [{ t: "limit.hit", which: "wall" }]);
  assert.equal(of(events, "run.finished")[0]!.outcome, "limit");
  assert.equal(await reply(runId), "The agent session reached its time limit before it finished.");
});

test("a task prompt above the backend's ceiling is refused before any process starts", { skip }, async () => {
  const runId = await ask("@answer never", "claude", MODEL, { instructionsClass: "D3" });
  const events = await finished(runId);
  assert.deepEqual(events.map((e) => e.t), ["run.started", "egress.refused", "reply.posted", "run.finished"]);
  assert.equal(of(events, "run.finished")[0]!.outcome, "refused");
});
