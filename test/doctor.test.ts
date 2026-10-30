import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { diagnose, formatLines, type Facts } from "../scripts/doctor.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const ready: Facts = {
  node: "26.10.0",
  platform: "darwin",
  pnpm: "10.20.0",
  installed: true,
  docker: { cli: true, server: "29.8.2" },
  postgres: { port: 5432, open: true },
  freePorts: { 3000: true, 3001: true },
  sandboxImage: true,
  agentClis: { claude: null, codex: null },
  labToml: { present: false, problem: null },
};
const levels = (f: Facts) => diagnose(f).filter((l) => l.level !== "PASS").map((l) => `${l.level} ${l.what}`);

test("a ready machine passes every line and says it is ready", () => {
  assert.deepEqual(levels(ready), []);
  assert.match(formatLines(diagnose(ready)), /\nready for pnpm demo$/);
});

test("what pnpm demo cannot run without is FAIL, with the fix", () => {
  const broken: Facts = { ...ready, node: "22.11.0", pnpm: null, installed: false, docker: { cli: true, server: null } };
  const lines = diagnose(broken).filter((l) => l.level === "FAIL");
  assert.deepEqual(
    lines.map((l) => l.what),
    ["Node 22.11.0 is older than 26", "pnpm not found", "dependencies not installed", "Docker is installed but its daemon is not running"],
  );
  assert.ok(lines.every((l) => l.fix));
  assert.match(formatLines(diagnose(broken)), /\n4 problems to fix before pnpm demo$/);
});

test("optional parts are WARN: no Postgres yet, a taken port, no sandbox image, agent CLIs off macOS", () => {
  const f: Facts = { ...ready, platform: "linux", postgres: { port: 55433, open: false }, freePorts: { 3000: false, 3001: true }, sandboxImage: false, agentClis: { claude: "2.1.303", codex: null } };
  assert.deepEqual(levels(f), [
    "WARN nothing on Postgres port 55433 yet",
    "WARN port 3000 is taken, which the web door uses",
    "WARN aliquot-sandbox image not built; run_code and --research need it",
    "WARN agent CLIs are confined on macOS only; on linux an agent backend refuses to run",
  ]);
  assert.match(formatLines(diagnose(f)), /\nready for pnpm demo \(4 warnings for optional parts\)$/);
});

test("a lab.toml that does not load is FAIL with the loader's own message", () => {
  assert.deepEqual(levels({ ...ready, labToml: { present: true, problem: "lab.toml has a [tools] table" } }), ["FAIL lab.toml does not load: lab.toml has a [tools] table"]);
});

test("pnpm doctor runs on this machine and its exit code matches its lines", () => {
  const r = spawnSync(process.execPath, ["scripts/doctor.ts", "--json"], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const lines = JSON.parse(r.stdout) as { level: string }[];
  assert.equal(r.status, lines.some((l) => l.level === "FAIL") ? 1 : 0);
  assert.ok(lines.some((l) => l.level === "PASS"));
});
