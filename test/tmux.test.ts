import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { freshDatabase } from "./db.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
// A private tmux server, never the default one a person may be attached to.
const socket = `aliquot-test-${process.pid}`;
const tmux = (...args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });

const dir = realpathSync(mkdtempSync(join(tmpdir(), "aliquot-tmux-")));
const cfg = join(dir, "lab.toml");
writeFileSync(cfg, '[endpoints.local]\nbase_url = "http://127.0.0.1:11434/v1"\nplacement = "lab"\n');

after(() => {
  if (hasTmux) tmux("kill-server");
});

function up(args: readonly string[], env: Record<string, string>) {
  return spawnSync(join(root, "scripts/tmux.sh"), args, { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ALIQUOT_TMUX_SOCKET: socket, ...env }, timeout: 30_000 });
}

test("scripts/tmux.sh lays out worker, web and ask windows, the door answers in its pane, and a second start is refused", { skip: !hasTmux && "tmux is not installed" }, async () => {
  const { db, url } = await freshDatabase("labh_tmux");
  await db.end();
  const env = { DATABASE_URL: url, LABH_PAYLOAD_KEY: "11".repeat(32) };
  const r = up(["--config", "lab.toml", "--session", "lab", "--port", "0"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tmux session lab: windows worker, web, ask/);

  const windows = tmux("list-windows", "-t", "lab", "-F", "#{window_name}").stdout.trim().split("\n");
  assert.deepEqual(windows, ["worker", "web", "ask"]);
  let web = "";
  for (let i = 0; i < 100 && !/listening on http:\/\/127\.0\.0\.1:\d+/.test(web); i++) {
    await sleep(100);
    web = tmux("capture-pane", "-p", "-t", "lab:web").stdout;
  }
  assert.match(web, /\[web\] listening on http:\/\/127\.0\.0\.1:\d+/);
  const dead = tmux("list-panes", "-s", "-t", "lab", "-F", "#{window_name} #{pane_dead}").stdout.trim().split("\n");
  assert.deepEqual(dead, ["worker 0", "web 0", "ask 0"]);
  assert.match(tmux("show-environment", "-t", "lab", "LABH_CONFIG").stdout, new RegExp(`LABH_CONFIG=${cfg}`));

  const again = up(["--config", "lab.toml", "--session", "lab"], env);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already running\. Attach with: tmux attach -t lab/);

  assert.match(up(["--stop", "--session", "lab"], env).stdout, /stopped tmux session lab/);
  assert.notEqual(tmux("has-session", "-t", "=lab").status, 0);
});

test("a window whose process exits stays open with its last lines", { skip: !hasTmux && "tmux is not installed" }, async () => {
  // No such database: the worker fails at start, and its pane keeps the reason.
  const r = up(["--config", "lab.toml", "--session", "dead", "--port", "0"], { DATABASE_URL: "postgres://postgres:labh@127.0.0.1:9/none", LABH_PAYLOAD_KEY: "11".repeat(32) });
  assert.equal(r.status, 0, r.stderr);
  let state = "";
  for (let i = 0; i < 100 && !state.startsWith("worker 1"); i++) {
    await sleep(100);
    state = tmux("list-panes", "-s", "-t", "dead", "-F", "#{window_name} #{pane_dead}").stdout;
  }
  assert.match(state, /^worker 1$/m);
  assert.notEqual(tmux("capture-pane", "-p", "-t", "dead:worker").stdout.trim(), "");
  up(["--stop", "--session", "dead"], {});
});

test("scripts/tmux.sh refuses a missing lab.toml and an unset DATABASE_URL before starting anything", { skip: !hasTmux && "tmux is not installed" }, () => {
  const missing = up(["--config", "nope.toml", "--session", "x"], { DATABASE_URL: "postgres://x" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /nope\.toml does not exist\. Write one with pnpm aliquot:init\./);
  const unset = up(["--config", "lab.toml", "--session", "x"], {});
  assert.notEqual(unset.status, 0);
  assert.match(unset.stderr, /DATABASE_URL is not set/);
  assert.notEqual(tmux("has-session", "-t", "=x").status, 0);
});
