/**
 * The only module in core that starts a child process. It starts an agent
 * CLI in one way: confined. confine() needs the AuthorizedRoute that
 * gateway.admit() returned for the task prompt, and spawnConfined() accepts
 * only the Confined value confine() builds, so neither an unchecked prompt
 * nor an unconfined CLI can be started from here.
 *
 * The child's environment is an allowlist. DATABASE_URL, the payload key and
 * every *_API_KEY stay in the worker. Node itself adds NODE_OPTIONS, holding
 * the worker's own permission flags, to every child it starts; it carries no
 * secret and confines a node CLI further.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readdirSync, copyFileSync, chmodSync, createReadStream, mkdirSync, openSync, readFileSync, readSync, closeSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { AuthorizedRoute, Labelled } from "../dataclass.ts";
import type { ExactModelId } from "../gateway.ts";
import { canonicalJson, sha256, type Sha256 } from "../hash.ts";
import { BRIDGE_TOKEN_ENV, KINDS, type AgentBackend, type AgentCliKind, type SessionPaths } from "./backends.ts";
import { installRoots, seatbeltProfile } from "./confine.ts";

/** An agent backend with its binary found: the real path, and the node that runs it when it is a node script. */
export interface InstalledCli {
  readonly backend: AgentBackend;
  readonly binary: string;
  readonly node: string | null;
  readonly cliVersion: string;
  readonly sha256: Sha256;
}

/** The agent worker flag that allows dev_shared_login backends. Refused when NODE_ENV is production. */
export const DEV_SHARED_LOGIN_FLAG = "--dev-shared-login";

const DEFAULT_NAMES: Readonly<Record<AgentCliKind, string>> = { "claude-code": "claude", codex: "codex" };

function onPath(name: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // not in this directory
    }
  }
  return null;
}

/** A script whose first line runs node, or a .js/.mjs/.ts file: it is started as `node <script>`. */
function isNodeScript(path: string): boolean {
  if (/\.(m?js|ts)$/.test(path)) return true;
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(128);
    const n = readSync(fd, head, 0, head.length, 0);
    const first = head.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
    return first.startsWith("#!") && /\bnode\b/.test(first);
  } finally {
    closeSync(fd);
  }
}

async function fileSha256(path: string): Promise<Sha256> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex") as Sha256;
}

/**
 * Finds the backend's binary and asks it for its version, with an empty environment. Throws when either fails, and
 * for a dev_shared_login backend unless the worker was started in dev-login mode, which lab.toml cannot turn on.
 */
export async function installedCli(backend: AgentBackend, env: NodeJS.ProcessEnv, devSharedLogin = false): Promise<InstalledCli> {
  if (backend.auth.t === "dev-shared" && !devSharedLogin) throw new Error(`agent backend ${backend.id}: dev_shared_login runs only under agent-worker ${DEV_SHARED_LOGIN_FLAG}, never in a lab deployment`);
  if (backend.kind === "codex") refuseManagedCodexConfig(backend.id);
  const configured = backend.binary ?? DEFAULT_NAMES[backend.kind];
  const found = configured.includes("/") ? configured : onPath(configured, env.PATH ?? "");
  if (!found) throw new Error(`agent backend ${backend.id}: ${configured} is not on PATH`);
  const binary = realpathSync(found);
  const node = isNodeScript(binary) ? realpathSync(process.execPath) : null;
  const [file, args] = node ? [node, [binary, "--version"]] : [binary, ["--version"]];
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(file, args, { env: { PATH: "/usr/bin:/bin" }, timeout: 15_000 }, (err, out) => (err ? reject(new Error(`agent backend ${backend.id}: ${binary} --version failed: ${err.message}`)) : resolve(out))),
  );
  const cliVersion = KINDS[backend.kind].version(stdout);
  if (!cliVersion) throw new Error(`agent backend ${backend.id}: ${binary} --version printed ${JSON.stringify(stdout.trim().slice(0, 80))}, not a ${backend.kind} version`);
  return { backend, binary, node, cliVersion, sha256: await fileSha256(binary) };
}

/**
 * codex loads managed_config.toml and requirements.toml from /etc/codex, and they can override its flags, so a
 * session there would not be the one its version and argv describe.
 */
export function refuseManagedCodexConfig(backendId: string, dir = "/etc/codex"): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  if (entries.length) throw new Error(`agent backend ${backendId}: ${dir} holds ${entries.join(", ")}, which codex would load over Aliquot's flags; remove it or run this backend on another host`);
}

export interface SessionSpec {
  readonly cli: InstalledCli;
  readonly model: ExactModelId;
  /** Real path, mode 0700, created by the caller and removed with the session. */
  readonly workspace: string;
  readonly bridge: { readonly port: number; readonly url: string };
  readonly proxyPort: number;
  readonly token: string;
  /** The worker's environment, read only for the one variable auth_env names. */
  readonly env: NodeJS.ProcessEnv;
  /** The agent's wall limit: a codex dev login must not need a refresh within it. */
  readonly maxWallMs: number;
}

/** A CLI command that has been confined and handed a prompt the egress decision allowed. Only confine() builds one. */
export class Confined {
  readonly #brand: undefined;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly stdin: string;
  readonly profile: string;
  readonly argvHash: Sha256;
  private constructor(argv: readonly string[], env: Record<string, string>, cwd: string, stdin: string, profile: string, argvHash: Sha256) {
    this.argv = argv;
    this.env = env;
    this.cwd = cwd;
    this.stdin = stdin;
    this.profile = profile;
    this.argvHash = argvHash;
  }
  static is(x: unknown): x is Confined {
    return typeof x === "object" && x !== null && #brand in x;
  }
  /** confine(). Here so that the private constructor has exactly one caller, and that caller takes a route. */
  static of(_route: AuthorizedRoute, prompt: Labelled<string>, s: SessionSpec): Confined {
    const kind = KINDS[s.cli.backend.kind];
    const dirs = sessionDirs(s.workspace);
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
    const paths: SessionPaths = { bridgeUrl: s.bridge.url, workspace: s.workspace, configDir: dirs.config };
    const proxy = `http://127.0.0.1:${s.proxyPort}`;
    const auth = s.cli.backend.auth;
    const claudeDev = auth.t === "dev-shared" && s.cli.backend.kind === "claude-code" ? { home: s.env.HOME ?? null, dir: auth.dir } : null;
    const env: Record<string, string> = {
      PATH: ["/usr/bin", "/bin", ...(s.cli.node ? [dirname(s.cli.node)] : [])].join(":"),
      // security finds the keychain search list through HOME; the profile lets the CLI read only the keychains there
      HOME: claudeDev?.home ?? dirs.home,
      USER: s.env.USER ?? "aliquot",
      LANG: "en_US.UTF-8",
      TMPDIR: dirs.tmp,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      NO_PROXY: "127.0.0.1,localhost",
      [BRIDGE_TOKEN_ENV]: s.token,
      [kind.configDirEnv]: dirs.config,
      ...(claudeDev ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeKeychainDir(claudeDev.dir, claudeDev.home) } : {}),
      ...kind.env,
      // claude otherwise creates /tmp/claude-<uid>, outside the workspace
      ...(s.cli.backend.kind === "claude-code" ? { CLAUDE_CODE_TMPDIR: dirs.tmp } : {}),
    };
    if (auth.t === "dev-shared") {
      // codex cannot start without writing its home, so its login is copied in; claude's is a keychain item
      if (s.cli.backend.kind === "codex") copyCodexDevLogin(join(auth.dir, "auth.json"), join(dirs.config, "auth.json"), Date.now(), s.maxWallMs);
    } else if (auth.t === "env") {
      const secret = s.env[auth.env];
      if (!secret) throw new Error(`agent backend ${s.cli.backend.id}: ${auth.env} is not set`);
      env.CLAUDE_CODE_OAUTH_TOKEN = secret;
    } else {
      copyFileSync(auth.path, join(dirs.config, "auth.json"));
      chmodSync(join(dirs.config, "auth.json"), 0o600);
    }
    const cliArgv = [...(s.cli.node ? [s.cli.node] : []), s.cli.binary, ...kind.argv(s.model, paths)];
    const roots = installRoots(s.cli);
    const keychainDir = claudeDev?.home ? join(claudeDev.home, "Library", "Keychains") : null;
    const profile = seatbeltProfile({ workspace: s.workspace, ...roots, ports: { bridge: s.bridge.port, proxy: s.proxyPort }, ...(keychainDir ? { devLogin: { keychainDir } } : {}) });
    const template = kind.argv(s.model, { bridgeUrl: "<bridge>", workspace: "<workspace>", configDir: "<config>" });
    const argvHash = sha256(canonicalJson({ kind: s.cli.backend.kind, cliVersion: s.cli.cliVersion, argv: template, env: Object.keys(env).sort() }));
    return new Confined(["/usr/bin/sandbox-exec", "-p", profile, ...cliArgv], env, s.workspace, prompt.value, profile, argvHash);
  }
}

/**
 * What claude 2.1.303 names its keychain item after: CLAUDE_SECURESTORAGE_CONFIG_DIR when set, else CLAUDE_CONFIG_DIR.
 * Set to the operator's login dir, the session reads the operator's item while its own config dir stays the fresh one
 * in the workspace. The default ~/.claude login was made with no CLAUDE_CONFIG_DIR, so its item has no suffix, which
 * the empty value selects.
 */
export function claudeKeychainDir(loginDir: string, home: string | null): string {
  return home !== null && loginDir === join(home, ".claude") ? "" : loginDir;
}

/**
 * Copies the operator's codex login into the session. A refresh inside the session would rotate the refresh token in
 * the copy and log the operator's own codex out, so a login that could refresh before the session's wall limit is
 * refused instead: one whose access token expires by then, or whose last refresh is older than CODEX_REFRESH_AGE_MS.
 */
export function copyCodexDevLogin(from: string, to: string, now: number, maxWallMs: number): void {
  const raw = readFileSync(from, "utf8");
  let exp: unknown;
  let lastRefresh: unknown;
  try {
    const login = JSON.parse(raw) as { tokens?: { access_token?: unknown }; last_refresh?: unknown };
    const token = login.tokens?.access_token;
    exp = typeof token === "string" ? (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown }).exp : undefined;
    lastRefresh = typeof login.last_refresh === "string" ? Date.parse(login.last_refresh) : undefined;
  } catch {
    exp = undefined;
  }
  if (typeof exp !== "number") throw new Error(`dev_shared_login: ${from} holds no ChatGPT access token Aliquot can read the expiry of`);
  const until = now + maxWallMs + CODEX_DEV_LOGIN_MARGIN_MS;
  const refresh = "run codex once yourself to refresh it, then retry";
  if (exp * 1000 < until) throw new Error(`dev_shared_login: the codex login in ${from} expires before this session's wall limit; ${refresh}`);
  if (typeof lastRefresh !== "number" || Number.isNaN(lastRefresh) || lastRefresh + CODEX_REFRESH_AGE_MS < until) throw new Error(`dev_shared_login: the codex login in ${from} is due a refresh before this session's wall limit; ${refresh}`);
  writeFileSync(to, raw, { mode: 0o600 });
}
const CODEX_DEV_LOGIN_MARGIN_MS = 10 * 60_000;
/** Inferred, not read from codex 0.155.1: codex-rs refreshes a ChatGPT login whose last_refresh is 8 days old. One day of slack. */
const CODEX_REFRESH_AGE_MS = 7 * 24 * 60 * 60_000;

/** The session's directories inside its workspace: the CLI's own state dir, HOME and TMPDIR. */
export function sessionDirs(workspace: string): { readonly config: string; readonly home: string; readonly tmp: string } {
  return { config: join(workspace, "config"), home: join(workspace, "home"), tmp: join(workspace, "tmp") };
}

export const confine = Confined.of;

export interface RunningCli {
  readonly pid: number;
  /** Every stdout line, in order. Raw CLI output is never logged; the session parses and records what it needs. */
  onLine(fn: (line: string) => void): void;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  /** SIGTERM to the process group, then SIGKILL after graceMs. Idempotent. */
  kill(graceMs?: number): void;
  /** The last bytes of stderr, for a failure record. */
  stderrTail(): string;
}

export const KILL_GRACE_MS = 5_000;

export function spawnConfined(c: Confined): RunningCli {
  if (!Confined.is(c)) throw new Error("spawnConfined takes only what confine() built");
  const [file, ...args] = c.argv;
  const child: ChildProcess = spawn(file!, args, { cwd: c.cwd, env: { ...c.env }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  if (child.pid === undefined) throw new Error("the agent CLI did not start");
  const pid = child.pid;
  child.stdin!.on("error", () => undefined);
  child.stdin!.end(c.stdin);
  const listeners: ((line: string) => void)[] = [];
  createInterface({ input: child.stdout! }).on("line", (line) => {
    for (const l of listeners) l(line);
  });
  let tail = "";
  child.stderr!.on("data", (b: Buffer) => {
    tail = (tail + b.toString("utf8")).slice(-2000);
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  let killing = false;
  return {
    pid,
    onLine: (fn) => listeners.push(fn),
    exit,
    kill(graceMs = KILL_GRACE_MS) {
      if (killing) return;
      killing = true;
      killGroup(pid, "SIGTERM");
      const timer = setTimeout(() => killGroup(pid, "SIGKILL"), graceMs);
      void exit.then(() => {
        clearTimeout(timer);
        killGroup(pid, "SIGKILL");
      });
    },
    stderrTail: () => tail,
  };
}

/** When the process started, as ps prints it, or null when there is no such process. A pid is reused; a pid and its start time are not. */
export function processStart(pid: number): Promise<string | null> {
  return new Promise((resolve) =>
    execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 5_000 }, (err, out) => resolve(err || !out.trim() ? null : out.trim())),
  );
}

/**
 * Writes the CLI's pid and start time to pidFile, which must lie outside the session workspace: the CLI can write
 * anywhere in that, and a pid it chose would be killed by the next worker.
 */
export async function recordProcess(pidFile: string, pid: number): Promise<void> {
  writeFileSync(pidFile, JSON.stringify({ pid, start: await processStart(pid) }), { mode: 0o600 });
}

/** Kills the process group a dead worker's pid file names, only if that pid is still the process Aliquot started. */
export async function killRecorded(pidFile: string): Promise<void> {
  let recorded: { pid?: unknown; start?: unknown };
  try {
    recorded = JSON.parse(readFileSync(pidFile, "utf8")) as typeof recorded;
  } catch {
    return;
  }
  const { pid, start } = recorded;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || typeof start !== "string") return;
  if ((await processStart(pid)) === start) killGroup(pid, "SIGKILL");
}

/** Signals a CLI's whole process group. */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is gone
  }
}
