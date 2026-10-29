import { test } from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentDocument, resolveAgent, verifyRunnable, versionHash, LOOP_CONTRACT, type Catalog, type ResolvedAgent } from "../packages/core/src/agent.ts";
import { KINDS } from "../packages/core/src/agents/backends.ts";
import { installRoots } from "../packages/core/src/agents/confine.ts";
import { confine, copyCodexDevLogin, installedCli, killRecorded, refuseManagedCodexConfig, processStart, recordProcess } from "../packages/core/src/agents/spawn.ts";
import { parseConfig } from "../packages/core/src/config.ts";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import { createGateway, type ExactModelId } from "../packages/core/src/gateway.ts";
import type { Sha256, SnapshotId, ToolHash } from "../packages/core/src/hash.ts";
import { eventClass, fold } from "../packages/core/src/record.ts";
import { describeEvent } from "../packages/core/src/record-view.ts";
import { fixedTarget } from "../packages/core/src/agents/proxy.ts";
import { chain, started } from "./events.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/agent.json", import.meta.url), "utf8")) as Record<string, unknown>;
const doc = (patch: Record<string, unknown> = {}) => {
  const p = parseAgentDocument({ ...fixture, ...patch });
  assert.ok(p.ok);
  return p.doc;
};
const catalog = (over: Partial<Catalog> = {}): Catalog => ({
  latestSkill: () => undefined,
  latestSnapshot: () => ({ id: "s".repeat(64) as SnapshotId, cls: "D1" }),
  tool: (name) => ({ hash: name.padEnd(64, "0") as ToolHash, reads: "D0", effects: name === "notes_write" ? "lab-write" : "read" }),
  endpoint: (id) => (id === "claude" ? { placement: "public", agentCli: { kind: "claude-code", cliVersion: "2.1.303" } } : id === "unseen" ? { placement: "public", agentCli: { kind: "codex", cliVersion: null } } : { placement: "lab" }),
  sandboxImage: () => undefined,
  dataset: () => undefined,
  ...over,
});

const toml = (backends: string) => `[endpoints.local]\nbase_url = "http://127.0.0.1:1"\nplacement = "lab"\n${backends}`;

test("lab.toml declares agent backends by kind, with the binary and the dedicated login each kind needs", () => {
  const c = parseConfig(
    toml(`[agent_backends.claude]\nkind = "claude-code"\nplacement = "public"\nauth_env = "LAB_CLAUDE_TOKEN"\n[agent_backends.codex]\nkind = "codex"\nplacement = "zdr"\nbinary = "bin/codex.js"\nauth_file = "secrets/codex-auth.json"\n`),
    "/srv/lab/lab.toml",
  );
  assert.deepEqual(c.agentBackends, [
    { id: "claude", kind: "claude-code", placement: "public", binary: null, auth: { t: "env", env: "LAB_CLAUDE_TOKEN" } },
    { id: "codex", kind: "codex", placement: "zdr", binary: "/srv/lab/bin/codex.js", auth: { t: "file", path: "/srv/lab/secrets/codex-auth.json" } },
  ]);
});

test("the parser refuses lab and institution placements for an agent backend, a login of the wrong kind, and an id an endpoint already has", () => {
  for (const placement of ["lab", "institution"]) {
    assert.throws(() => parseConfig(toml(`[agent_backends.c]\nkind = "claude-code"\nplacement = "${placement}"\nauth_env = "T"\n`), "/l/lab.toml"), /placement/);
  }
  assert.throws(() => parseConfig(toml(`[agent_backends.c]\nkind = "claude-code"\nplacement = "public"\nauth_file = "a.json"\n`), "/l/lab.toml"), /auth_env|auth_file/);
  assert.throws(() => parseConfig(toml(`[agent_backends.local]\nkind = "codex"\nplacement = "public"\nauth_file = "a.json"\n`), "/l/lab.toml"), /local is both an endpoint and an agent backend/);
});

test("an existing agent version keeps the hash it had before agent backends existed", () => {
  const r = resolveAgent(doc(), catalog());
  assert.ok(r.ok);
  assert.equal("agentCli" in r.agent, false);
  assert.equal(versionHash(r.agent), "782a9a0ed9cb43c6bb14a1027dd70873ee402f2d2d8dfc9f8634318df24d6d1e");
});

test("an agent on a CLI backend pins the kind and the CLI version the agent worker reported", () => {
  const r = resolveAgent(doc({ model: { endpointId: "claude", modelId: "claude-sonnet-4-5-20250929", params: {} }, ceiling: "D0", knowledgeBases: [] }), catalog());
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
  assert.deepEqual(r.agent.agentCli, { kind: "claude-code", cliVersion: "2.1.303" });
});

test("publish refuses a CLI agent with a tool that writes, and a backend no agent worker has reported", () => {
  const writes = resolveAgent(doc({ model: { endpointId: "claude", modelId: "claude-sonnet-4-5-20250929", params: {} }, ceiling: "D0", knowledgeBases: [], tools: [{ name: "notes_write" }] }), catalog());
  assert.equal(writes.ok, false);
  assert.deepEqual(!writes.ok && writes.issues.map((i) => i.message), ["tool notes_write has effects lab-write; an agent CLI may hold only read tools"]);
  const unseen = resolveAgent(doc({ model: { endpointId: "unseen", modelId: "gpt-5.1-codex", params: {} }, ceiling: "D0", knowledgeBases: [] }), catalog());
  assert.deepEqual(!unseen.ok && unseen.issues.map((i) => i.message), ["no agent worker has reported the codex version for unseen; start one before publishing"]);
  const hosted = resolveAgent(doc({ model: { endpointId: "claude", modelId: "claude-sonnet-4-5-20250929", params: {} } }), catalog());
  assert.equal(hosted.ok, false, "the fixture's D3 ceiling is above what a public CLI backend may receive");
});

test("a CLI version is unrunnable where the installed CLI differs, where none is installed, and without confinement", () => {
  const agent: ResolvedAgent = {
    schema: 2,
    agentId: "lit" as ResolvedAgent["agentId"],
    loopContract: LOOP_CONTRACT,
    instructions: "x",
    instructionsClass: "D0",
    model: { endpointId: "claude", modelId: "claude-sonnet-4-5-20250929" as ExactModelId, params: { temperature: 0, maxOutputTokens: 64 } },
    knowledgeBases: [],
    tools: [],
    sandbox: null,
    retrieval: { algorithm: "bm25-v1", readCapTokens: 100 },
    limits: { maxSteps: 4, maxTokens: 100, maxWallMs: 1000 },
    agentCli: { kind: "claude-code", cliVersion: "2.1.303" },
  };
  const base = { tools: new Map(), snapshots: new Set<SnapshotId>(), sandboxImages: new Set<never>(), loopContract: LOOP_CONTRACT, retrieval: new Set(["bm25-v1"]) };
  assert.deepEqual(verifyRunnable(agent, { ...base, agentClis: new Map([["claude", "2.1.303"]]), confinement: { available: true, platform: "darwin" } }), []);
  assert.deepEqual(verifyRunnable(agent, { ...base, agentClis: new Map([["claude", "2.1.304"]]), confinement: { available: true, platform: "darwin" } }), [{ t: "agent-cli-version", backend: "claude", pinned: "2.1.303", installed: "2.1.304" }]);
  assert.deepEqual(verifyRunnable(agent, base), [
    { t: "agent-cli-version", backend: "claude", pinned: "2.1.303", installed: null },
    { t: "agent-confinement-missing", platform: "unknown" },
  ]);
  assert.deepEqual(verifyRunnable(agent, { ...base, agentClis: new Map([["claude", "2.1.303"]]), confinement: { available: false, platform: "linux" } }), [{ t: "agent-confinement-missing", platform: "linux" }]);
});

test("gateway.admit routes what a hosted CLI backend may receive and refuses the rest", () => {
  const gateway = createGateway([], DEFAULT_POLICY, fetch, [{ id: "claude", placement: "public" }]);
  const ok = gateway.admit(Labelled.stamp("a public question", "D0", "test"), "claude");
  assert.deepEqual(ok.allow && { ...ok.to }, { kind: "model", endpointId: "claude", placement: "public" });
  assert.deepEqual(gateway.admit(Labelled.stamp("a roster", "D1", "test"), "claude"), { allow: false, refusal: { code: "class-above-ceiling", payload: "D1", ceiling: "D0" } });
  assert.throws(() => gateway.admit(Labelled.stamp("x", "D0", "test"), "nope"), /agent backend nope is not configured/);
  assert.equal(gateway.placementOf("claude"), "public");
});

const paths = { bridgeUrl: "http://127.0.0.1:4100/mcp", workspace: "/w/run/s1", configDir: "/w/run/s1/config" };

test("the Claude Code argv switches off its own tools and settings and names only the bridge, with the token left to the environment", () => {
  const argv = KINDS["claude-code"].argv("claude-sonnet-4-5-20250929" as ExactModelId, paths);
  assert.deepEqual(argv.slice(0, 10), ["-p", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-4-5-20250929", "--tools", "", "--strict-mcp-config", "--mcp-config"]);
  assert.deepEqual(JSON.parse(argv[10]!), { mcpServers: { aliquot: { type: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer ${ALIQUOT_BRIDGE_TOKEN}" } } } });
  assert.deepEqual(argv.slice(11, 18), ["--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--allowedTools", "mcp__aliquot", "--system-prompt"]);
  assert.equal(argv.length, 19);
});

test("the Codex argv disables every built-in tool family, pins approvals and points the one MCP server at the bridge", () => {
  const argv = KINDS.codex.argv("gpt-5.1-codex" as ExactModelId, paths);
  assert.deepEqual(argv, [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-C", "/w/run/s1", "-m", "gpt-5.1-codex", "-s", "read-only",
    "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "apps", "--disable", "plugins", "--disable", "hooks", "--disable", "browser_use", "--disable", "computer_use",
    "--disable", "image_generation", "--disable", "in_app_browser", "--disable", "view_image", "--disable", "multi_agent",
    "--disable", "sleep_tool", "--disable", "tool_suggest", "--disable", "skill_search", "--disable", "goals",
    "-c", 'web_search="disabled"', "-c", 'approval_policy="never"', "-c", 'mcp_servers.aliquot.url="http://127.0.0.1:4100/mcp"', "-c", 'mcp_servers.aliquot.bearer_token_env_var="ALIQUOT_BRIDGE_TOKEN"',
    "-c", 'mcp_servers.aliquot.default_tools_approval_mode="approve"', "-",
  ]);
});

// The init line claude 2.1.303 printed under the session profile with an empty config dir (trimmed to the fields read).
const CLAUDE_INIT = '{"type":"system","subtype":"init","cwd":"/private/tmp/ws","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-5-20250929","apiKeySource":"none","claude_code_version":"2.1.303"}';

test("the Claude Code parser reads the init line, tool uses and the result, and its self-check holds the CLI to what the version pinned", () => {
  const k = KINDS["claude-code"];
  const pinned = { model: "claude-sonnet-4-5-20250929" as ExactModelId, cliVersion: "2.1.303" };
  const init = k.parse(CLAUDE_INIT);
  assert.deepEqual(init, { t: "init", tools: [], model: "claude-sonnet-4-5-20250929", version: "2.1.303", mcp: [] });
  assert.deepEqual(k.check(init, pinned), { ok: true });
  assert.deepEqual(k.check(k.parse(CLAUDE_INIT.replace('"tools":[]', '"tools":["mcp__aliquot__kb_search","Bash"]')), pinned), { ok: false, check: "own-tool", why: "the CLI loaded tools of its own: Bash" });
  assert.deepEqual(k.check(k.parse(CLAUDE_INIT.replace('"mcp_servers":[]', '"mcp_servers":[{"name":"github","status":"connected"}]')), pinned), { ok: false, check: "own-server", why: "the CLI loaded MCP servers of its own: github" });
  assert.deepEqual(k.check(init, { ...pinned, model: "claude-opus-4-1-20250805" as ExactModelId }), { ok: false, check: "model", why: "the CLI runs model claude-sonnet-4-5-20250929, not claude-opus-4-1-20250805" });
  assert.deepEqual(k.check(init, { ...pinned, cliVersion: "2.1.301" }), { ok: false, check: "version", why: "the CLI is version 2.1.303, not 2.1.301" });
  assert.deepEqual(k.parse('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebFetch","input":{}}]}}'), { t: "tool-use", name: "WebFetch", server: null });
  assert.deepEqual(k.check({ t: "tool-use", name: "WebFetch", server: null }, pinned), { ok: false, check: "own-call", why: "the CLI called a tool of its own: WebFetch" });
  assert.deepEqual(k.parse('{"type":"result","subtype":"success","is_error":false,"result":"42","usage":{"input_tokens":10,"output_tokens":3},"modelUsage":{"claude-sonnet-4-5-20250929":{"inputTokens":10,"cacheReadInputTokens":2000,"cacheCreationInputTokens":300,"outputTokens":3}}}'), { t: "result", text: "42", error: false, usage: { input: 2310, output: 3 }, models: ["claude-sonnet-4-5-20250929"] });
  assert.equal(k.version("2.1.303 (Claude Code)\n"), "2.1.303");
  assert.equal(k.version("codex-cli 0.155.1\n"), null);
});

test("the Codex parser allows only message, reasoning, plan and aliquot MCP items, and reads usage from turn.completed", () => {
  const k = KINDS.codex;
  const pinned = { model: "gpt-5.1-codex" as ExactModelId, cliVersion: "0.155.1" };
  assert.deepEqual(k.parse('{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"done"}}'), { t: "text", text: "done" });
  assert.deepEqual(k.parse('{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":0,"output_tokens":7}}'), { t: "result", text: null, error: false, usage: { input: 120, output: 7 }, models: [] });
  for (const type of ["command_execution", "file_change", "web_search", "image_view"]) {
    const line = k.parse(`{"type":"item.started","item":{"id":"item_2","type":"${type}"}}`);
    assert.deepEqual(k.check(line, pinned), { ok: false, check: "own-item", why: `the CLI produced a ${type} item, which is not an aliquot tool` });
  }
  assert.deepEqual(k.check(k.parse('{"type":"item.started","item":{"type":"mcp_tool_call","server":"aliquot","tool":"kb_search"}}'), pinned), { ok: true });
  assert.deepEqual(k.check(k.parse('{"type":"item.started","item":{"type":"mcp_tool_call","server":"github","tool":"search"}}'), pinned), { ok: false, check: "own-call", why: "the CLI called search on server github" });
  assert.deepEqual(k.check(k.parse('{"type":"item.started","item":{"type":"mcp_tool_call","server":"codex","tool":"list_mcp_resources"}}'), pinned), { ok: true });
  assert.deepEqual(k.check(k.parse('{"type":"item.started","item":{"type":"mcp_tool_call","server":"codex","tool":"shell"}}'), pinned), { ok: false, check: "own-call", why: "the CLI called shell on server codex" });
  assert.equal(k.version("codex-cli 0.155.1\n"), "0.155.1");
});

test("a withheld tool result and an agent session leave the run unrefused", () => {
  const events = chain([
    started(),
    { t: "tool.withheld", callId: "s1-1", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D0" }, cls: "D3" },
    { t: "agent.session", attempt: 1, kind: "claude-code", cliVersion: "2.1.303", argvHash: "0".repeat(64) as never, workspace: "/w", exit: { code: 0, signal: null }, turns: 1, hostsTunneled: ["api.anthropic.com"], hostsRefused: 0, refusedTargets: null },
  ]);
  const s = fold(events);
  assert.equal(s.refused, null);
  assert.equal(s.cls, "D1");
});

test("dev_shared_login is a public placement only, and parses to the operator's directory", () => {
  const c = parseConfig(toml(`[agent_backends.c]\nkind = "claude-code"\nplacement = "public"\ndev_shared_login = "/Users/me/.claude"\n`), "/l/lab.toml");
  assert.deepEqual(c.agentBackends[0]?.auth, { t: "dev-shared", dir: "/Users/me/.claude" });
  assert.throws(() => parseConfig(toml(`[agent_backends.c]\nkind = "codex"\nplacement = "zdr"\ndev_shared_login = "/Users/me/.codex"\n`), "/l/lab.toml"), /placement|public/);
});

test("a channel floor below D1 is allowed only for the web channel the server binds; any channel may be raised", () => {
  const c = parseConfig(toml(`[surfaces.web]\nchannel = "public"\n[channel_floors]\n"web:public" = "D0"\n"web:lab" = "D2"\n`), "/l/lab.toml");
  assert.deepEqual(c.channelFloors, { "web:public": "D0", "web:lab": "D2" });
  assert.equal(c.web.channel, "public");
  assert.throws(() => parseConfig(toml(`[channel_floors]\n"web:public" = "D0"\n`), "/l/lab.toml"), {
    message: "lab.toml: channel_floors web:public is below D1, which only the channel [surfaces.web] channel binds may be; the sender names any other channel",
  });
  assert.throws(() => parseConfig(toml(`[surfaces.web]\nchannel = "public"\n[channel_floors]\n"web:studio" = "D0"\n`), "/l/lab.toml"), /web:studio is below D1/);
  assert.equal(parseConfig(toml(`[channel_floors]\n"web:lab" = "D2"\n`), "/l/lab.toml").web.channel, null);
  assert.throws(() => parseConfig(toml(`[channel_floors]\npublic = "D0"\n`), "/l/lab.toml"));
});

test("a dev login reads the operator's keychain through security; any other login cannot run it", () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "aliq-dev-")));
  const gateway = createGateway([], DEFAULT_POLICY, fetch, [{ id: "c", placement: "public" }]);
  const session = (auth: { t: "dev-shared"; dir: string } | { t: "env"; env: string }) => {
    const content = Labelled.stamp("hi", "D0", "test");
    const d = gateway.admit(content, "c");
    assert.ok(d.allow);
    return confine(d.to, content, {
      cli: { backend: { id: "c", kind: "claude-code", placement: "public", binary: "/opt/claude", auth }, binary: "/opt/claude", node: null, cliVersion: "2.1.303", sha256: "0".repeat(64) as Sha256 },
      model: "claude-haiku-5-5" as ExactModelId,
      workspace,
      bridge: { port: 1, url: "http://127.0.0.1:1/mcp" },
      proxyPort: 2,
      token: "t".repeat(64),
      env: { USER: "me", HOME: "/Users/me", TOKEN: "x" },
      maxWallMs: 60_000,
    });
  };
  try {
    const dev = session({ t: "dev-shared", dir: "/Users/me/.claude-accounts/a2" });
    assert.equal(dev.env.HOME, "/Users/me");
    assert.equal(dev.env.CLAUDE_CONFIG_DIR, join(workspace, "config"));
    assert.equal(dev.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, "/Users/me/.claude-accounts/a2");
    assert.equal(dev.env.CLAUDE_CODE_TMPDIR, join(workspace, "tmp"));
    assert.match(dev.profile, /process-exec[^\n]*"\/usr\/bin\/security"/);
    assert.match(dev.profile, /file-read\*[^\n]*\(subpath "\/Users\/me\/Library\/Keychains"\)/);
    assert.doesNotMatch(dev.profile, /\(subpath "\/Users\/me\/\.claude/);
    assert.doesNotMatch(dev.profile, /file-write\*[^\n]*\/Users\/me/);
    assert.equal(session({ t: "dev-shared", dir: "/Users/me/.claude" }).env.CLAUDE_SECURESTORAGE_CONFIG_DIR, "");
    const token = session({ t: "env", env: "TOKEN" });
    assert.equal("CLAUDE_SECURESTORAGE_CONFIG_DIR" in token.env, false);
    assert.equal(token.env.HOME, join(workspace, "home"));
    assert.equal(token.env.CLAUDE_CODE_TMPDIR, join(workspace, "tmp"));
    assert.doesNotMatch(token.profile, /\/usr\/bin\/security/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a codex dev login is copied into the session, and refused when it could refresh before the wall limit", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aliq-codex-")));
  const now = Date.UTC(2026, 9, 28, 12);
  const hour = 3600_000;
  const login = (expMs: number, lastRefreshMs: number | null = now - 24 * hour) => {
    const jwt = ["e30", Buffer.from(JSON.stringify({ exp: expMs / 1000 })).toString("base64url"), "sig"].join(".");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt, refresh_token: "r" }, ...(lastRefreshMs === null ? {} : { last_refresh: new Date(lastRefreshMs).toISOString() }) }));
  };
  const copy = (maxWallMs: number) => copyCodexDevLogin(join(dir, "auth.json"), join(dir, "copy.json"), now, maxWallMs);
  try {
    login(now + 3 * hour);
    copy(hour);
    assert.equal(readFileSync(join(dir, "copy.json"), "utf8"), readFileSync(join(dir, "auth.json"), "utf8"));
    rmSync(join(dir, "copy.json"));
    assert.throws(() => copy(3 * hour), { message: `dev_shared_login: the codex login in ${join(dir, "auth.json")} expires before this session's wall limit; run codex once yourself to refresh it, then retry` });
    login(now + 3 * hour, now - 7 * 24 * hour + hour);
    assert.throws(() => copy(hour), /is due a refresh before this session's wall limit/);
    login(now + 3 * hour, null);
    assert.throws(() => copy(hour), /is due a refresh/);
    assert.equal(existsSync(join(dir, "copy.json")), false);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "k" }));
    assert.throws(() => copy(hour), /no ChatGPT access token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the record view names a session's refused requests and a self-check failure by count and code, never by what the CLI wrote", () => {
  const why = { hash: "h".repeat(64), cls: "D2" } as never;
  assert.equal(
    describeEvent({ t: "agent.session", attempt: 1, kind: "claude-code", cliVersion: "2.1.303", argvHash: "0".repeat(64) as never, workspace: "/w", exit: { code: 0, signal: null }, turns: 2, hostsTunneled: ["api.anthropic.com"], hostsRefused: 3, refusedTargets: why }),
    "claude-code 2.1.303, attempt 1, exit 0, 2 tool calls, tunnels to api.anthropic.com, 3 proxy requests refused",
  );
  assert.equal(describeEvent({ t: "run.faulted", reason: { t: "agent-not-confined", check: "own-call", why } }), "agent-not-confined: own-call");
  assert.equal(eventClass({ t: "run.faulted", reason: { t: "agent-not-confined", check: "own-call", why } }), "D2");
});

test("a refused proxy target is kept as a plain host:port or a hash, never as the bytes the CLI sent", () => {
  assert.equal(fixedTarget("participant-lab0-0003.example:443"), "participant-lab0-0003.example:443");
  assert.equal(fixedTarget("GET http://x/\u001b[2Jsecret-row-42 HTTP/1.1"), "sha256:7ff9676f75414e8c");
  assert.equal(fixedTarget("Exa mple.org:443"), "sha256:" + createHash("sha256").update("Exa mple.org:443", "latin1").digest("hex").slice(0, 16));
});

test("a recorded pid is killed only while it is still the process that was recorded", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aliq-pid-")));
  const sleeper = () => {
    const c = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const gone = new Promise<string | null>((r) => c.once("exit", (_code, signal) => r(signal)));
    return { pid: c.pid!, gone, kill: () => c.kill("SIGKILL") };
  };
  const ours = sleeper();
  const other = sleeper();
  try {
    await recordProcess(join(dir, "s1.pid"), ours.pid);
    assert.equal(JSON.parse(readFileSync(join(dir, "s1.pid"), "utf8")).start, await processStart(ours.pid));
    writeFileSync(join(dir, "s2.pid"), JSON.stringify({ pid: other.pid, start: "Thu Jan  1 00:00:00 1970" }));
    writeFileSync(join(dir, "s3.pid"), String(other.pid));
    await killRecorded(join(dir, "s1.pid"));
    await killRecorded(join(dir, "s2.pid"));
    await killRecorded(join(dir, "s3.pid"));
    assert.equal(await ours.gone, "SIGKILL");
    assert.notEqual(await processStart(other.pid), null);
  } finally {
    other.kill();
    ours.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dev_shared_login backend is refused unless the agent worker runs in dev-login mode", async () => {
  const backend = { id: "dev", kind: "claude-code", placement: "public", binary: "/nonexistent/claude", auth: { t: "dev-shared", dir: "/Users/me/.claude" } } as const;
  await assert.rejects(installedCli(backend, {}), { message: "agent backend dev: dev_shared_login runs only under agent-worker --dev-shared-login, never in a lab deployment" });
  await assert.rejects(installedCli(backend, {}, true), /ENOENT|no such file/);
});

// What claude 2.1.303 printed for one bridged call and an answer, under a dev login (rate_limit_event and user lines dropped).
const CLAUDE_STREAM = readFileSync(new URL("./claude-2.1.303-stream.jsonl", import.meta.url), "utf8").trim().split("\n");

test("the Claude Code parser reads a real 2.1.303 stream: usage and the served model from modelUsage, tokens per turn", () => {
  const k = KINDS["claude-code"];
  const pinned = { model: "claude-haiku-5-5" as ExactModelId, cliVersion: "2.1.303" };
  const parsed = CLAUDE_STREAM.map((l) => k.parse(l));
  assert.deepEqual(parsed.map((p) => p.t), ["init", "tool-use", "text", "result"]);
  assert.deepEqual(parsed[1], { t: "tool-use", name: "mcp__aliquot__lab_fact", server: null });
  assert.deepEqual({ ...parsed[3], text: null }, { t: "result", text: null, error: false, usage: { input: 2020, output: 63 }, models: ["claude-haiku-5-5"] });
  assert.deepEqual(parsed.map((p) => k.check(p, pinned).ok), [true, true, true, true]);
  assert.deepEqual(k.check(parsed[3]!, { ...pinned, model: "claude-sonnet-4-5-20250929" as ExactModelId }), { ok: false, check: "model", why: "the CLI reports model claude-haiku-5-5 served the session, not claude-sonnet-4-5-20250929" });
  assert.deepEqual(CLAUDE_STREAM.map((l) => k.turnTokens(l)?.tokens ?? null), [null, 1000, 1054, null]);
});

test("the Claude Code self-check judges every content block, so a foreign call after an aliquot one or a server tool fails it", () => {
  const k = KINDS["claude-code"];
  const pinned = { model: "claude-haiku-5-5" as ExactModelId, cliVersion: "2.1.303" };
  const turn = (content: unknown[]) => k.check(k.parse(JSON.stringify({ type: "assistant", message: { content } })), pinned);
  assert.deepEqual(turn([{ type: "tool_use", name: "mcp__aliquot__kb_search" }, { type: "tool_use", name: "Bash" }]), { ok: false, check: "own-call", why: "the CLI called a tool of its own: Bash" });
  assert.deepEqual(turn([{ type: "text", text: "searching" }, { type: "server_tool_use", name: "web_search" }]), { ok: false, check: "own-item", why: "the CLI produced a server_tool_use block, which is not an aliquot tool" });
  assert.deepEqual(turn([{ type: "thinking", thinking: "" }, { type: "text", text: "a" }, { type: "tool_use", name: "mcp__aliquot__kb_read" }]), { ok: true });
});

test("a node outside Homebrew makes its binary, lib and include readable, never its whole prefix", () => {
  assert.deepEqual(installRoots({ binary: "/nx/local/lib/node_modules/@openai/codex/bin/codex.js", node: "/nx/local/bin/node" }), {
    exec: ["/nx/local/bin/node", "/nx/local/lib/node_modules/@openai/codex/bin/codex.js"],
    execRoots: ["/nx/local/lib/node_modules/@openai/codex/bin"],
    readRoots: ["/nx/local/lib/node_modules/@openai/codex/bin", "/nx/local/bin/node", "/nx/local/lib", "/nx/local/include"],
  });
  assert.deepEqual(installRoots({ binary: "/nx/homebrew/lib/node_modules/x/cli.js", node: "/nx/homebrew/Cellar/node/26.10.0_1/bin/node" }).readRoots.slice(1), ["/nx/homebrew/Cellar", "/nx/homebrew/opt", "/nx/homebrew/etc/openssl@3/openssl.cnf"]);
});

test("a codex backend is refused on a host whose /etc/codex holds managed config", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aliq-etc-codex-")));
  try {
    refuseManagedCodexConfig("codex", join(dir, "missing"));
    refuseManagedCodexConfig("codex", dir);
    writeFileSync(join(dir, "managed_config.toml"), "");
    assert.throws(() => refuseManagedCodexConfig("codex", dir), { message: `agent backend codex: ${dir} holds managed_config.toml, which codex would load over Aliquot's flags; remove it or run this backend on another host` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
