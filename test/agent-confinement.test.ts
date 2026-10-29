import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHandle } from "../packages/core/src/agents/bridge.ts";
import { startProxy, type ProxyHandle } from "../packages/core/src/agents/proxy.ts";
import { confine, spawnConfined, type InstalledCli } from "../packages/core/src/agents/spawn.ts";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import { createGateway, type ExactModelId } from "../packages/core/src/gateway.ts";
import type { Sha256 } from "../packages/core/src/hash.ts";

const darwin = process.platform === "darwin";
const repo = fileURLToPath(new URL("..", import.meta.url));
const gateway = createGateway([], DEFAULT_POLICY, fetch, [{ id: "b", placement: "public" }]);
const admit = (text: string) => {
  const content = Labelled.stamp(text, "D0", "test");
  const d = gateway.admit(content, "b");
  assert.ok(d.allow);
  return { to: d.to, content };
};

const CANARY = `ALIQUOT_CANARY_${randomBytes(8).toString("hex")}`;
const pgData = existsSync("/opt/homebrew/var") ? "/opt/homebrew/var" : null;
const cleanup: string[] = [];
let bridge: BridgeHandle;
let proxy: ProxyHandle;
let parent: ChildProcess;
let profile = "";
let got: Record<string, { value?: unknown; code?: string }> = {};
let exit: { code: number | null; signal: string | null };

const temp = (prefix: string, under = tmpdir()) => {
  const dir = realpathSync(mkdtempSync(join(under, prefix)));
  cleanup.push(dir);
  return dir;
};

before(async () => {
  if (!darwin) return;
  const root = temp("aliquot-confine-");
  const install = join(root, "install");
  mkdirSync(install);
  writeFileSync(join(install, "package.json"), '{"name":"probe","type":"module"}\n');
  copyFileSync(join(repo, "test/confine-probe.ts"), join(install, "cli.ts"));
  const workspace = join(root, "ws");
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(root, "auth.json"), '{"OPENAI_API_KEY":"sk-not-a-key"}\n');
  const outsider = temp("aliquot-outsider-");
  writeFileSync(join(outsider, "secret.txt"), "outside the session\n");
  const pgStandIn = pgData ?? temp("aliquot-pgdata-");
  const home = temp(".aliquot-confine-", homedir());
  writeFileSync(join(home, "canary.txt"), `${CANARY}\n`);

  bridge = await startBridge("t".repeat(64), {
    tools: [{ name: "probe", description: "Probe.", inputSchema: { type: "object" } }],
    call: async () => ({ ...admit("admitted reply"), isError: false }),
  });
  proxy = await startProxy(["api.openai.com"]);
  parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { env: { PATH: "/usr/bin:/bin", [CANARY]: "1" }, stdio: "ignore" });

  const node = realpathSync(process.execPath);
  const binary = join(install, "cli.ts");
  const cli: InstalledCli = {
    backend: { id: "b", kind: "codex", placement: "public", binary, auth: { t: "file", path: join(root, "auth.json") } },
    binary,
    node,
    cliVersion: "0.155.1",
    sha256: "0".repeat(64) as Sha256,
  };
  const request = {
    workspace,
    reads: {
      volumes: "/Volumes",
      folders: join(outsider, "secret.txt"),
      pgdata: pgStandIn,
      dataclass: join(repo, "packages/core/src/dataclass.ts"),
      agents: join(repo, "AGENTS.md"),
      home: join(home, "canary.txt"),
      homeDir: homedir(),
    },
    stats: { srv: "/srv", volumes: "/Volumes" },
    parentPid: parent.pid,
    canary: CANARY,
    pgPort: Number(process.env.LABH_PG_PORT ?? 5432),
    bridge: { port: bridge.port, token: "t".repeat(64) },
    proxyPort: proxy.port,
    proxyTargets: { outsider: "example.org:443", wrongPort: "api.openai.com:80" },
  };
  const prompt = admit(JSON.stringify(request));
  const confined = confine(prompt.to, prompt.content, {
    cli,
    model: "gpt-5" as ExactModelId,
    workspace,
    bridge: { port: bridge.port, url: `http://127.0.0.1:${bridge.port}/mcp` },
    proxyPort: proxy.port,
    token: "t".repeat(64),
    env: { USER: "aliquot", [CANARY]: "1" },
    maxWallMs: 60_000,
  });
  profile = confined.profile;
  const running = spawnConfined(confined);
  const lines: string[] = [];
  running.onLine((l) => lines.push(l));
  exit = await running.exit;
  got = JSON.parse(lines.at(-1) ?? "{}");
});

after(async () => {
  parent?.kill();
  await bridge?.close();
  await proxy?.close();
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const opts = { skip: !darwin };

test("the profile denies by default, and the probe ran to the end under it", opts, () => {
  assert.equal(profile.split("\n")[1], "(deny default)");
  assert.deepEqual(exit, { code: 0, signal: null });
});

test("the CLI can write and read inside its workspace", opts, () => {
  assert.deepEqual(got.workspace, { value: "inside" });
});

test("/Volumes is neither listable nor stat-able", opts, () => {
  assert.deepEqual(got["read:volumes"], { code: "EPERM" });
  assert.deepEqual(got["stat:volumes"], { code: "EPERM" });
});

test("/srv is unreadable (absent on macOS, where the kernel answers ENOENT before the sandbox is asked)", opts, () => {
  assert.deepEqual(got["stat:srv"], existsSync("/srv") ? { code: "EPERM" } : { code: "ENOENT" });
});

test("a file in /private/var/folders outside the session is unreadable", opts, () => {
  assert.deepEqual(got["read:folders"], { code: "EPERM" });
});

test(`the Postgres data directory (${pgData ?? "a temp dir standing in for it"}) is unreadable`, opts, () => {
  assert.deepEqual(got["read:pgdata"], { code: "EPERM" });
});

test("the repository's source and AGENTS.md are unreadable", opts, () => {
  assert.deepEqual(got["read:dataclass"], { code: "EPERM" });
  assert.deepEqual(got["read:agents"], { code: "EPERM" });
});

test("a file under ~ and the listing of ~ are unreadable", opts, () => {
  assert.deepEqual(got["read:home"], { code: "EPERM" });
  assert.deepEqual(got["read:homeDir"], { code: "EPERM" });
});

test("ps cannot run, so the worker's environment cannot be read through it", opts, () => {
  const outside = execFileSync("/bin/ps", ["-E", "-ww", "-p", String(parent.pid)], { encoding: "utf8" });
  assert.equal(outside.includes(CANARY), true, "unconfined, ps shows the canary, so the confined check is not vacuous");
  assert.deepEqual(got.ps, { code: "EPERM" });
});

test("DNS fails: getaddrinfo cannot reach mDNSResponder and a direct resolver query cannot leave", opts, () => {
  assert.deepEqual(got.lookup, { code: "ENOTFOUND" });
  assert.deepEqual(got.resolve, { code: "ECONNREFUSED" });
});

test("direct TCP to the Postgres port and to an outside IP is refused by the OS", opts, () => {
  assert.deepEqual(got.pg, { code: "EPERM" });
  assert.deepEqual(got.outside, { code: "EPERM" });
});

test("open cannot run, so no URL reaches LaunchServices", opts, () => {
  assert.deepEqual(got.open, { code: "EPERM" });
});

test("the bridge is reachable and returns the admitted reply", opts, () => {
  assert.deepEqual(got.bridge, { value: { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "admitted reply" }], isError: false } } } });
});

test("the proxy is reachable and refuses a non-vendor host and a vendor host on another port", opts, () => {
  assert.deepEqual(got["proxy:outsider"], { value: "HTTP/1.1 403 Forbidden" });
  assert.deepEqual(got["proxy:wrongPort"], { value: "HTTP/1.1 403 Forbidden" });
  assert.deepEqual(proxy.refused(), { count: 2, targets: ["example.org:443", "api.openai.com:80"] });
  assert.deepEqual(proxy.tunneled(), []);
});
