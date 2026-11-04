import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../packages/core/src/config.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const DIGEST = `sha256:${"ab".repeat(32)}`;

function lab() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aliquot-init-")));
  mkdirSync(join(dir, "config"));
  return { dir, cfg: join(dir, "config", "lab.toml"), env: join(dir, ".env") };
}

function init(l: ReturnType<typeof lab>, input: string, args: readonly string[] = [], write = [l.cfg, l.env]) {
  return spawnSync(process.execPath, [...PERMISSION_FLAGS, ...write.map((w) => `--allow-fs-write=${w}`), "packages/core/bin/aliquot.ts", "init", "--config", l.cfg, "--env", l.env, ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
    timeout: 30_000,
  });
}

const answers = (...lines: string[]) => `${lines.join("\n")}\n`;
const PATTERN_PROMPT = "Participant id patterns, one regular expression per line, then an empty line [\\bP-\\d{5}\\b]:";

test("init on defaults writes a lab.toml that loads and a .env with four fresh secrets, mode 600", async () => {
  const l = lab();
  const r = init(l, answers("Mettu Lab", "", "", "8080", "", "P-00123", "P-54321", "", "y", DIGEST));
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.split("\n");
  for (const line of [PATTERN_PROMPT, "PASS  P-00123  matched by pattern 1", "PASS  P-54321  matched by pattern 1", "Verdict: PASS, all 2 sample ids matched.", `Wrote ${l.cfg}`])
    assert.ok(out.includes(line), `missing line: ${line}\n${r.stdout}`);

  const c = await loadConfig(l.cfg);
  assert.deepEqual(
    { patterns: c.participantIdPatterns.map(String), endpoints: c.endpoints.map((e) => [e.id, e.baseUrl, e.placement]), port: c.web.port, sandbox: c.sandbox?.image, key: c.store.keyEnv, db: c.databaseUrlEnv, surfaces: c.surfaces },
    {
      patterns: ["/\\bP-\\d{5}\\b/"],
      endpoints: [["local", "http://ollama:11434/v1", "lab"]],
      port: 8080,
      sandbox: DIGEST,
      key: "LABH_PAYLOAD_KEY",
      db: "DATABASE_URL",
      surfaces: [c.web, { id: "acp", kind: "acp", placement: "zdr", tokenEnv: "ALIQUOT_ACP_TOKEN" }],
    },
  );
  assert.ok(readFileSync(l.cfg, "utf8").startsWith("# lab.toml for Mettu Lab, written by aliquot init.\n"));

  const secrets = readFileSync(l.env, "utf8").split("\n").filter((s) => s && !s.startsWith("#"));
  // The sandbox is on in this lab.toml, so the env also gives the worker the Docker socket.
  assert.deepEqual(secrets.map((s) => s.split("=")[0]), ["POSTGRES_PASSWORD", "LABH_PAYLOAD_KEY", "PAYLOAD_SECRET", "ALIQUOT_ACP_TOKEN", "COMPOSE_FILE", "DOCKER_GID"]);
  assert.equal(secrets[4], "COMPOSE_FILE=compose.yaml:compose.sandbox.yaml");
  assert.match(secrets[0]!, /^POSTGRES_PASSWORD=[0-9a-f]{48}$/);
  assert.match(secrets[1]!, /^LABH_PAYLOAD_KEY=[0-9a-f]{64}$/);
  assert.match(secrets[2]!, /^PAYLOAD_SECRET=[0-9a-f]{64}$/);
  assert.match(secrets[3]!, /^ALIQUOT_ACP_TOKEN=[0-9a-f]{64}$/);
  assert.equal(statSync(l.env).mode & 0o777, 0o600);
});

test("a sample the pattern misses fails per line, and a corrected pattern then passes", async () => {
  const l = lab();
  const r = init(l, answers("", "", "", "", "\\bP-\\d{5}\\b", "", "P-00123", "LAB-0042", "", "\\bP-\\d{5}\\b", "\\bLAB-\\d{4}\\b", "", "n"));
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.split("\n");
  const at = out.indexOf("FAIL  LAB-0042  no pattern matches");
  assert.ok(at > 0, r.stdout);
  assert.deepEqual(out.slice(at - 1, at + 8), [
    "PASS  P-00123   matched by pattern 1",
    "FAIL  LAB-0042  no pattern matches",
    "Verdict: FAIL, 1 of 2 sample ids matched no pattern.",
    "Some ids would not be marked D3. Enter the patterns again.",
    PATTERN_PROMPT,
    "PASS  P-00123   matched by pattern 1",
    "PASS  LAB-0042  matched by pattern 2",
    "Verdict: PASS, all 2 sample ids matched.",
    "Turn on run_code and PDF reading in the sandbox container? (y/n) [n]:",
  ]);
  assert.deepEqual((await loadConfig(l.cfg)).participantIdPatterns.map(String), ["/\\bP-\\d{5}\\b/", "/\\bLAB-\\d{4}\\b/"]);
});

test("a pattern that matches ordinary text, the empty string or does not compile is refused, and three refusals write nothing", () => {
  const l = lab();
  const r = init(l, answers("", "", "", "", "\\d+", "", "[P-", "", "x*", ""));
  assert.equal(r.status, 1);
  const out = r.stdout.split("\n");
  for (const line of [
    'FAIL  pattern 1 matches ordinary text ("12" in "On Tuesday 12 March the lab met in room 4 at 10:30 and agreed on the next visit."), so it would mark ordinary messages D3',
    "FAIL  pattern 1 does not compile: Invalid regular expression: /[P-/: Unterminated character class",
    "FAIL  pattern 1 matches the empty string, so it would mark every message D3",
  ])
    assert.ok(out.includes(line), `missing line: ${line}\n${r.stdout}`);
  assert.equal(r.stderr, "init stopped: no pattern passed after 3 attempts. Nothing was written.\n");
  assert.deepEqual([existsSync(l.cfg), existsSync(l.env)], [false, false]);
});

test("an existing lab.toml is refused without --force and left as it was", () => {
  const l = lab();
  writeFileSync(l.cfg, "# ours\n");
  const r = init(l, answers());
  assert.deepEqual({ status: r.status, stderr: r.stderr }, { status: 2, stderr: `${l.cfg} already exists. Pass --force to replace it.\n` });
  assert.equal(readFileSync(l.cfg, "utf8"), "# ours\n");
  assert.equal(existsSync(l.env), false);
});

test("an existing .env is never touched, even with --force, and init says why", async () => {
  const l = lab();
  writeFileSync(l.cfg, "# ours\n");
  writeFileSync(l.env, "LABH_PAYLOAD_KEY=keep\n", { mode: 0o640 });
  const r = init(l, "", ["--force", "--yes", "--sample", "P-00123"], [l.cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.split("\n").includes(`Left ${l.env} as it is. It holds LABH_PAYLOAD_KEY, and a new key would make every stored payload unreadable.`), r.stdout);
  assert.deepEqual([readFileSync(l.env, "utf8"), statSync(l.env).mode & 0o777], ["LABH_PAYLOAD_KEY=keep\n", 0o640]);
  assert.equal((await loadConfig(l.cfg)).participantIdPatterns.length, 1);
  assert.ok(r.stdout.split("\n").includes(`${l.env} has no ALIQUOT_ACP_TOKEN, so the door takes no token for [surfaces.acp]. Add one: echo "ALIQUOT_ACP_TOKEN=$(openssl rand -hex 32)" >> ${l.env}`), r.stdout);
});

test("an existing .env that already holds ALIQUOT_ACP_TOKEN gets no line about it", () => {
  const l = lab();
  writeFileSync(l.env, `LABH_PAYLOAD_KEY=keep\nALIQUOT_ACP_TOKEN=${"a".repeat(64)}\n`);
  const r = init(l, "", ["--yes", "--sample", "P-00123"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes("ALIQUOT_ACP_TOKEN"), false, r.stdout);
});

test("--yes takes the defaults with --pattern and --sample, and a failing sample exits 1 writing nothing", () => {
  const l = lab();
  const r = init(l, "", ["--yes", "--pattern", "\\bS\\d{4}\\b", "--sample", "S1234", "--sample", "P-00123"]);
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, {
    status: 1,
    stdout: "PASS  S1234    matched by pattern 1\nFAIL  P-00123  no pattern matches\nVerdict: FAIL, 1 of 2 sample ids matched no pattern.\n",
    stderr: "The patterns did not pass. Nothing was written.\n",
  });
  assert.deepEqual([existsSync(l.cfg), existsSync(l.env)], [false, false]);
});

test("without write access to both files init names the exact grant and writes nothing", () => {
  const l = lab();
  const r = init(l, "", ["--yes", "--sample", "P-00123"], [l.cfg]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.split("\n")[0], `init writes ${l.cfg} and ${l.env}, and this process may not. Run it with write access to exactly those paths:`);
  assert.deepEqual([existsSync(l.cfg), existsSync(l.env)], [false, false]);
});
