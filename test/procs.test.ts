import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processes, waitLine } from "../scripts/procs.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = { PATH: process.env.PATH ?? "" };
// A leader that starts a grandchild and prints its pid, as next dev starts its own workers.
const forker = ["-c", "sleep 300 & echo grandchild=$!; wait"];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

test("stopping a group command stops the processes it started", async () => {
  const work = mkdtempSync(join(tmpdir(), "labh-procs-"));
  try {
    const ps = processes(root, work, env);
    const proc = ps.startGroup("forker", "/bin/sh", forker, work);
    const pid = Number(/grandchild=(\d+)/.exec(await waitLine(proc, /grandchild=\d+/, 5000))![1]);
    assert.equal(alive(pid), true);
    await ps.stopAll();
    assert.equal(await gone(pid), true, "the grandchild is gone after stopAll");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a check script that dies on an uncaught error leaves no process behind", async () => {
  const work = mkdtempSync(join(tmpdir(), "labh-procs-"));
  try {
    const script = join(work, "dies.ts");
    writeFileSync(
      script,
      [
        `import { processes, waitLine } from ${JSON.stringify(join(root, "scripts/procs.ts"))};`,
        `const ps = processes(${JSON.stringify(root)}, ${JSON.stringify(work)}, { PATH: process.env.PATH ?? "" });`,
        `const proc = ps.startGroup("forker", "/bin/sh", ${JSON.stringify(forker)}, ${JSON.stringify(work)});`,
        `console.log(await waitLine(proc, /grandchild=\\d+/, 5000));`,
        `throw new Error("a check script failed before its finally block");`,
      ].join("\n"),
    );
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20000 });
    assert.notEqual(run.status, 0, "the script failed");
    const pid = Number(/grandchild=(\d+)/.exec(run.stdout)?.[1]);
    assert.ok(pid > 0, run.stdout + run.stderr);
    assert.equal(await gone(pid), true, "the grandchild did not outlive the script");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("process handlers are registered once, however many process sets a script makes", () => {
  const before = ["exit", "SIGINT", "SIGTERM", "SIGHUP"].map((e) => process.listenerCount(e));
  for (let i = 0; i < 20; i++) processes(root, tmpdir(), env);
  assert.deepEqual(["exit", "SIGINT", "SIGTERM", "SIGHUP"].map((e) => process.listenerCount(e)), before);
});

test("a check script sent SIGINT kills a child it did not start through procs, as Playwright starts the browser", async () => {
  const work = mkdtempSync(join(tmpdir(), "labh-procs-"));
  try {
    const script = join(work, "interrupted.ts");
    writeFileSync(
      script,
      [
        `import { spawn } from "node:child_process";`,
        `import { processes } from ${JSON.stringify(join(root, "scripts/procs.ts"))};`,
        `processes(${JSON.stringify(root)}, ${JSON.stringify(work)}, { PATH: process.env.PATH ?? "" });`,
        `const browser = spawn("/bin/sleep", ["300"], { stdio: "ignore" });`,
        `console.log("browser=" + browser.pid);`,
        `await new Promise((r) => setTimeout(r, 60000));`,
      ].join("\n"),
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    for (let i = 0; i < 100 && !/browser=\d+/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    const pid = Number(/browser=(\d+)/.exec(out)?.[1]);
    assert.ok(pid > 0, out);
    assert.equal(alive(pid), true);
    child.kill("SIGINT");
    await new Promise((r) => child.on("exit", r));
    assert.equal(await gone(pid), true, "the untracked child did not outlive the interrupted script");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
