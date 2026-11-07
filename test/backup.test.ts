import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * backup.sh and restore.sh against a stand-in docker: it answers `aliquot keys env` in the worker with the lines the
 * test gives, pg_dump with fixed bytes, and records every other compose call. What is checked is the scripts' own
 * key handling, which is the part no compose run is needed for.
 */
function lab(keysEnv: string, env: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aliquot-backup-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls"
case "$*" in
  *"exec -T worker aliquot keys env"*) printf '%s' "$FAKE_KEYS_ENV" ;;
  *"pg_dump"*) printf 'DUMP' ;;
  *"pg_restore"*) cat > /dev/null ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const envFile = join(dir, ".env");
  writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(""));
  const run = (script: "backup.sh" | "restore.sh", args: string[], envPath = envFile) =>
    spawnSync("bash", [join(root, "scripts", script), ...args], { env: { PATH: `${bin}:${process.env.PATH}`, ALIQUOT_ENV: envPath, FAKE_KEYS_ENV: keysEnv }, encoding: "utf8" });
  return { dir, envFile, run, calls: () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "") };
}

const hex = () => randomBytes(32).toString("hex");

test("backup.sh carries every key the lab names that .env holds, and restore.sh names the key id a restore is missing", () => {
  const keys = { LABH_PAYLOAD_KEY_2: hex(), LABH_PAYLOAD_KEY_3: hex() };
  const { dir, run, calls } = lab("k1 LABH_PAYLOAD_KEY 0\nk2 LABH_PAYLOAD_KEY_2 12\nk3 LABH_PAYLOAD_KEY_3 1\n", keys);
  const backup = run("backup.sh", [join(dir, "b")]);
  assert.equal(backup.status, 0, backup.stderr);
  assert.match(backup.stdout, /keys k2 k3\)/);
  assert.equal(readFileSync(join(dir, "b/payload-key"), "utf8"), `LABH_PAYLOAD_KEY_2=${keys.LABH_PAYLOAD_KEY_2}\nLABH_PAYLOAD_KEY_3=${keys.LABH_PAYLOAD_KEY_3}\n`, "k1 holds no bodies and .env no longer has it, so it is not carried");
  assert.equal(readFileSync(join(dir, "b/key-ids"), "utf8"), "k2 LABH_PAYLOAD_KEY_2\nk3 LABH_PAYLOAD_KEY_3\n");
  assert.equal(readFileSync(join(dir, "b/labh.dump"), "utf8"), "DUMP");

  const partial = join(dir, "partial.env");
  writeFileSync(partial, `LABH_PAYLOAD_KEY_2=${keys.LABH_PAYLOAD_KEY_2}\n`);
  const refused = run("restore.sh", [join(dir, "b")], partial);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^restore: key k3 is not supplied: .*LABH_PAYLOAD_KEY_3 is not the key this backup was made with\./m);
  assert.doesNotMatch(calls(), /pg_restore/, "nothing was replaced");

  const restored = run("restore.sh", [join(dir, "b")]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(calls(), /exec -T postgres pg_restore -U postgres -d labh --exit-on-error\n.*up -d --wait worker web studio\n.*exec -T worker aliquot runs --limit 1000/);
});

test("backup.sh refuses when a key that still holds bodies is missing from .env, naming it", () => {
  const { dir, run } = lab("k2 LABH_PAYLOAD_KEY_2 3\nk3 LABH_PAYLOAD_KEY_3 1\n", { LABH_PAYLOAD_KEY_2: hex() });
  const out = run("backup.sh", [join(dir, "b")]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /^backup: key k3 holds 1 bodies, but .*\.env has no LABH_PAYLOAD_KEY_3 of 64 hex characters$/m);
  assert.equal(existsSync(join(dir, "b")), false);
  const gone = lab("k0 - 4\nk2 LABH_PAYLOAD_KEY_2 3\n", { LABH_PAYLOAD_KEY_2: hex() }).run("backup.sh", [join(dir, "c")]);
  assert.match(gone.stderr, /^backup: key k0 holds 4 bodies, but lab.toml no longer names it$/m);
});

test("restore.sh reads a backup from before key ids as LABH_PAYLOAD_KEY alone", () => {
  const key = hex();
  const { dir, run } = lab("", { LABH_PAYLOAD_KEY: key });
  mkdirSync(join(dir, "old"));
  writeFileSync(join(dir, "old/labh.dump"), "DUMP");
  writeFileSync(join(dir, "old/payload-key"), `LABH_PAYLOAD_KEY=${hex()}\n`);
  const wrong = run("restore.sh", [join(dir, "old")]);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /^restore: key k1 is not supplied/m);
  writeFileSync(join(dir, "old/payload-key"), `LABH_PAYLOAD_KEY=${key}\n`);
  assert.equal(run("restore.sh", [join(dir, "old")]).status, 0);
});
