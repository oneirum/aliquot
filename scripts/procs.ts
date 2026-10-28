/**
 * Shared by the check scripts (slice1.ts, unit3.ts, lab0.ts, unit2.ts):
 * Postgres bring-up, child processes with their output captured, and polling.
 *
 * No child outlives its script. A command that starts processes of its own
 * (next dev) runs in its own process group, and stopping it stops the group.
 * If the script exits on an uncaught error, or is sent SIGINT, SIGTERM or
 * SIGHUP, every child still running is killed first: every group started
 * here, and every other direct child of the script, such as the browser
 * Playwright launches.
 */

import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connect } from "../packages/core/src/db.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { ADMIN_URL } from "../test/db.ts";

/** Uses what is running, or brings the compose service up (honouring COMPOSE_PROJECT_NAME and LABH_PG_PORT). */
export async function ensurePostgres(root: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const probe = connect(ADMIN_URL);
    try {
      await probe.query("select 1");
      return;
    } catch {
      if (i === 0) {
        console.log("postgres not reachable, running docker compose up -d postgres");
        execSync("docker compose up -d postgres", { cwd: root, stdio: "inherit" });
      }
      await sleep(1000);
    } finally {
      await probe.end();
    }
  }
  throw new Error(`postgres at ${ADMIN_URL} did not come up`);
}

export interface Proc {
  readonly name: string;
  readonly child: ChildProcess;
  /** True when the child leads its own process group, which stop() and the exit handler signal as a whole. */
  readonly group: boolean;
  readonly out: string[];
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface Processes {
  start(name: string, bin: string, args: string[]): Proc;
  /** Any command, in its own process group. */
  startGroup(name: string, command: string, args: string[], cwd: string): Proc;
  stop(proc: Proc): Promise<void>;
  stopAll(): Promise<void>;
  startWeb(cfg: string): Promise<{ proc: Proc; base: string }>;
  startWorker(cfg: string, id: string, extra?: string[]): Proc;
}

/** Every Proc not yet stopped, across every processes() call in this script. */
const live = new Set<Proc>();

function signal(proc: Proc, sig: NodeJS.Signals): void {
  try {
    if (proc.group) process.kill(-proc.child.pid!, sig);
    else proc.child.kill(sig);
  } catch {
    // ESRCH: nothing left to signal
  }
}

function killEverything(): void {
  for (const p of live) signal(p, "SIGKILL");
  const children = spawnSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
  for (const pid of children) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ESRCH: already gone
    }
  }
}

process.on("exit", killEverything);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(sig, () => {
    killEverything();
    process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const)[sig]);
  });
}

/** Every child gets exactly `env` and logs to `<work>/<name>.log`. Core binaries run from `root` under the permission model. */
export function processes(root: string, work: string, env: Record<string, string>): Processes {
  const mine = new Set<Proc>();
  let webs = 0;
  const track = (name: string, child: ChildProcess, group: boolean): Proc => {
    const out: string[] = [];
    const logPath = join(work, `${name}.log`);
    const sink = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      out.push(text);
      appendFileSync(logPath, text);
    };
    child.stdout!.on("data", sink);
    child.stderr!.on("data", sink);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on("exit", (code, signal) => res({ code, signal })));
    const proc = { name, child, group, out, exit };
    live.add(proc);
    mine.add(proc);
    return proc;
  };
  const start = (name: string, bin: string, args: string[]): Proc =>
    track(name, spawn(process.execPath, [...PERMISSION_FLAGS, join(root, "packages/core/bin", bin), ...args], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] }), false);
  const startGroup = (name: string, command: string, args: string[], cwd: string): Proc => track(name, spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: true }), true);
  const stop = async (proc: Proc): Promise<void> => {
    if (proc.child.exitCode === null && proc.child.signalCode === null) {
      signal(proc, "SIGTERM");
      const result = await Promise.race([proc.exit, sleep(5000).then(() => null)]);
      if (!result) signal(proc, "SIGKILL");
      await proc.exit;
    }
    // The leader can exit before the processes it started; the group goes too.
    if (proc.group) signal(proc, "SIGKILL");
    live.delete(proc);
    mine.delete(proc);
  };
  return {
    start,
    startGroup,
    stop,
    async stopAll() {
      for (const p of [...mine]) await stop(p);
    },
    async startWeb(cfg) {
      const proc = start(`web-${webs++}`, "web.ts", ["--config", cfg, "--port", "0"]);
      const line = await waitLine(proc, /listening on (http:\/\/127\.0\.0\.1:\d+)/, 15000);
      return { proc, base: line.replace("listening on ", "") };
    },
    startWorker: (cfg, id, extra = []) => start(`worker-${id}`, "worker.ts", ["--config", cfg, "--worker-id", id, "--poll-ms", "100", ...extra]),
  };
}

export async function waitLine(proc: Proc, re: RegExp, timeoutMs: number): Promise<string> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const m = re.exec(proc.out.join(""));
    if (m) return m[0];
    await sleep(50);
  }
  throw new Error(`${proc.name}: no line matching ${re} within ${timeoutMs}ms; output:\n${proc.out.join("").slice(-2000)}`);
}

export async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await probe();
    if (v !== null) return v;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

export async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** How far `counter` moved during the check: the hosted fake's request count. */
  readonly hostedRequests: number;
}

/** Runs one check unless `only` excludes it, prints its PASS or FAIL line, then stops every child it started. */
export function checker(ps: Processes, opts: { only?: RegExp | null; counter?: () => number } = {}): { check(name: string, fn: () => Promise<string>): Promise<void>; readonly results: CheckResult[] } {
  const results: CheckResult[] = [];
  const counter = opts.counter ?? (() => 0);
  return {
    results,
    async check(name, fn) {
      if (opts.only && !opts.only.test(name)) return;
      const startedAt = Date.now();
      const before = counter();
      try {
        const detail = await fn();
        results.push({ name, ok: true, detail, hostedRequests: counter() - before });
        console.log(`PASS ${name} (${Date.now() - startedAt}ms): ${detail}`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        results.push({ name, ok: false, detail, hostedRequests: counter() - before });
        console.log(`FAIL ${name} (${Date.now() - startedAt}ms):\n${detail}`);
      }
      await ps.stopAll();
    },
  };
}
