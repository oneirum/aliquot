import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../packages/core/src/config.ts";
import { assessAll, CONTROLS, type ReviewConfig, type TestId } from "../packages/core/src/review/controls.ts";
import { writeReviewPack } from "../scripts/review-pack.ts";

const root = resolve(import.meta.dirname, "..");
const CHECK = join(root, "deploy/check/lab.toml");
const checkText = await readFile(CHECK, "utf8");
const exampleText = await readFile(join(root, "lab.example.toml"), "utf8");

const parse = (text: string, path = CHECK): ReviewConfig => parseConfig(text, path);
const statuses = (c: ReviewConfig) => new Map(assessAll(c).map((r) => [r.control.id, r.assessment.status]));

/** The ids whose status differs between two configs. */
function moved(before: ReviewConfig, after: ReviewConfig): readonly string[] {
  const a = statuses(before);
  const b = statuses(after);
  return [...a.keys()].filter((id) => a.get(id) !== b.get(id)).sort();
}

// What sign-on, a second payload key and a purge window look like once lab.toml declares them.
const signOn = (c: ReviewConfig): ReviewConfig => ({ ...c, signOn: { issuer: "https://idp.example.edu", clientId: "aliquot", clientSecretEnv: "S", sessionSecretEnv: "T", emailClaim: "email", trustUnverifiedEmail: false, idClaim: "sub", idleMinutes: 30, rolesClaim: null, roleValues: {}, scopes: ["openid"] } });
const twoKeys = (c: ReviewConfig): ReviewConfig => ({ ...c, store: { ...c.store, keyEnvs: { k1: "LABH_PAYLOAD_KEY", k2: "LABH_PAYLOAD_KEY_2" }, current: "k2" } });
const purge = (c: ReviewConfig): ReviewConfig => ({ ...c, retention: { purgeDays: { D3: 365 }, keepMinDays: {} } });
const TRUST_LAYER: ReviewConfig = purge(twoKeys(signOn(parse(checkText))));

test("control ids are unique and every HIPAA section, 800-171r3 family and HECVAT area the brief names has a row", () => {
  const ids = CONTROLS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of ["164.308(a)(1)", "164.308(a)(5)", "164.310(d)", "164.312(a)", "164.312(b)", "164.312(c)", "164.312(d)", "164.312(e)", "164.316(b)(2)"])
    assert.ok(ids.some((id) => id.startsWith(`hipaa-${s}`)), s);
  for (let f = 1; f <= 17; f++) assert.ok(ids.some((id) => id.startsWith(`800-171r3-03.${String(f).padStart(2, "0")}`)), `family 03.${f}`);
  for (const area of ["data", "appsec", "auth", "ai", "privacy", "accessibility", "incident"]) assert.ok(ids.some((id) => id.startsWith(`hecvat-${area}`)), area);
});

test("no row reads met without naming a test, for the check lab, lab.example.toml and a lab with the whole trust layer declared", () => {
  for (const [name, c] of [["check", parse(checkText)], ["example", parse(exampleText, join(root, "lab.example.toml"))], ["trust layer", TRUST_LAYER]] as const)
    for (const r of assessAll(c)) if (r.assessment.status === "met") assert.ok(r.control.tests.length > 0, `${name}: ${r.control.id} is met with no test`);
});

test("sign-on, key rotation and retention read not met today", () => {
  const s = statuses(parse(checkText));
  for (const id of ["hipaa-164.312(a)(2)(i)", "800-171r3-03.05.01", "hecvat-auth-sso", "800-171r3-03.13.10", "800-171r3-03.14.08", "hecvat-data-retention"]) assert.equal(s.get(id), "not-met", id);
});

test("adding a public endpoint moves only the rows about hosted services", () => {
  const added = `${checkText}\n[endpoints.vendor]\nbase_url = "https://api.vendor.example/v1"\nplacement = "public"\n`;
  assert.deepEqual(moved(parse(checkText), parse(added)), ["800-171r3-03.16.03", "hecvat-ai-hosted-models"]);
  const plain = added.replace("https://api.vendor.example", "http://api.vendor.example");
  assert.deepEqual(moved(parse(added), parse(plain)), ["hipaa-164.312(e)(1)"]);
});

test("moving the payload store off lab placement moves only the rows about where bodies are stored", () => {
  const moving = checkText.replace('[store]\nplacement = "lab"', '[store]\nplacement = "institution"');
  assert.notEqual(moving, checkText);
  assert.deepEqual(moved(parse(checkText), parse(moving)), ["800-171r3-03.13.08", "hecvat-data-location"]);
});

test("declaring sign-on, key rotation, retention or an anchor flips exactly the rows that read it, with no prose edit", () => {
  const base = parse(checkText);
  assert.deepEqual(moved(base, signOn(base)), [
    "800-171r3-03.01.01",
    "800-171r3-03.01.08",
    "800-171r3-03.01.11",
    "800-171r3-03.05.01",
    "800-171r3-03.05.03",
    "hecvat-auth-sso",
    "hipaa-164.308(a)(5)(ii)(C)",
    "hipaa-164.312(a)(2)(i)",
    "hipaa-164.312(a)(2)(iii)",
  ]);
  assert.deepEqual(moved(base, twoKeys(base)), ["800-171r3-03.13.10"]);
  const anchored = parse(`${checkText}\n[anchor]\npath = "anchors.jsonl"\n`);
  assert.deepEqual(moved(base, anchored), ["800-171r3-03.03.08"]);
  assert.deepEqual(moved(base, purge(base)), ["800-171r3-03.08.03", "800-171r3-03.14.08", "hecvat-data-retention"]);
});

test("the committed pack for deploy/check/lab.toml is what review-pack writes today", async () => {
  const out = await mkdtemp(join(tmpdir(), "review-pack-"));
  try {
    const { dir, files } = await writeReviewPack(CHECK, out);
    assert.deepEqual([...files].sort(), ["hecvat-answers.md", "hipaa.md", "nist-800-171.md", "summary.md"]);
    const committed = join(root, "docs/review/check");
    assert.deepEqual((await readdir(committed)).sort(), [...files].sort());
    for (const f of files) assert.equal(await readFile(join(committed, f), "utf8"), await readFile(join(dir, f), "utf8"), `${f} is stale: run pnpm review-pack --config deploy/check/lab.toml`);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

/** The test names one file reports when run with these exact names, skipped ones included, from TAP. */
async function reported(file: string, names: readonly string[]): Promise<Set<string>> {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const args = ["--test", "--test-reporter=tap", ...names.map((n) => `--test-name-pattern=^${escape(n)}$`), join("test", file)];
  // NODE_TEST_CONTEXT would make the child report to this runner in its binary protocol instead of printing TAP.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.resume();
  await new Promise((done) => child.on("close", done));
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const m = /^\s*(?:not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/.exec(line);
    if (m) seen.add(m[1]!.replaceAll("\\#", "#").replaceAll("\\\\", "\\"));
  }
  return seen;
}

test("every test a row cites is one node --test reports by that exact name", { timeout: 600_000 }, async () => {
  const byFile = new Map<string, Set<string>>();
  for (const id of CONTROLS.flatMap((c) => c.tests as readonly TestId[])) {
    const at = id.indexOf(".test.ts: ");
    const file = `${id.slice(0, at)}.test.ts`;
    if (!byFile.has(file)) byFile.set(file, new Set());
    byFile.get(file)!.add(id.slice(at + ".test.ts: ".length));
  }
  const missing: string[] = [];
  for (const [file, names] of byFile) {
    const seen = await reported(file, [...names]);
    for (const n of names) if (!seen.has(n)) missing.push(`${file}: ${n}`);
  }
  assert.deepEqual(missing, []);
});
