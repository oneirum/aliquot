#!/usr/bin/env node
/**
 * pnpm walk:keys: a data steward rotates the payload key, keeps D3 under a key of its own, and redacts bodies past
 * the lab's retention window, and every record still verifies. Real Postgres, web door and worker on lab0's shape,
 * the scripted fake model, and the steward's own commands (aliquot keys, aliquot retention). It prints what the
 * steward sees at each step and a PASS or FAIL line per step; exit 0 only when every step passes.
 *
 *   LABH_TEST_DB_SUFFIX=_k node scripts/walk-keys.ts [--stills <dir>]
 *
 * --stills saves the record page with a redacted body, light and dark, at 1440 and 390 wide, from headless Chromium
 * (Playwright's, or LABH_CHROMIUM).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, devices } from "playwright";
import { loadAudit } from "../packages/core/src/audit.ts";
import { loadEvents, type RunId } from "../packages/core/src/record.ts";
import type { RecordView } from "../packages/core/src/record-view.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { checker, ensurePostgres, post, processes, waitFor, type Processes } from "./procs.ts";

const { values } = parseArgs({ options: { stills: { type: "string" } } });
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".walk-keys");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_walk_keys");
const model = await startFakeModel("scripted-1", "answer");
const K1 = randomBytes(32).toString("hex");
const K2 = randomBytes(32).toString("hex");
const K3 = randomBytes(32).toString("hex");
const base = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, USER: "steward" };

const agentPath = join(work, "agent.json");
writeFileSync(
  agentPath,
  JSON.stringify({
    ...JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")),
    agentId: "freezer-help",
    name: "Freezer help",
    instructions: "You answer short questions about the lab's freezers.",
    knowledgeBases: [],
    tools: [],
    model: { endpointId: "local", modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 256 } },
  }),
);

/** lab.toml as the steward edits it between steps: the [store] lines and the [policy] lines change, nothing else. */
function labToml(name: string, store: string, policy = ""): string {
  const path = join(work, `lab-${name}.toml`);
  writeFileSync(
    path,
    [
      "[database]",
      'url_env = "DATABASE_URL"',
      "[store]",
      'placement = "lab"',
      store,
      "[endpoints.local]",
      `base_url = "${model.url}"`,
      'placement = "lab"',
      "[surfaces.web]",
      'placement = "lab"',
      "port = 0",
      "[policy]",
      "participant_id_patterns = ['\\bP-\\d{5}\\b']",
      policy,
      "[agents]",
      `fixtures = ["${agentPath}"]`,
      "",
    ].join("\n"),
  );
  return path;
}

const oneKey = labToml("k1", 'key_env = "LABH_PAYLOAD_KEY"');
const rotated = labToml("k2", 'current = "k2"\n[store.keys]\nk1 = "LABH_PAYLOAD_KEY"\nk2 = "LABH_PAYLOAD_KEY_2"');
const k2Only = labToml("k2-only", 'current = "k2"\n[store.keys]\nk2 = "LABH_PAYLOAD_KEY_2"');
const withD3 = labToml("d3", 'current = "k2"\n[store.keys]\nk2 = "LABH_PAYLOAD_KEY_2"\nk3 = "LABH_PAYLOAD_KEY_3"\n[store.class_keys]\nD3 = "k3"');
const windowed = labToml("retention", 'current = "k2"\n[store.keys]\nk2 = "LABH_PAYLOAD_KEY_2"\nk3 = "LABH_PAYLOAD_KEY_3"\n[store.class_keys]\nD3 = "k3"', "[policy.retention.D1]\npurge_payload_after_days = 30");

function say(lines: string): void {
  for (const line of lines.trimEnd().split("\n")) console.log(`    ${line}`);
}

/** The steward's command, under the permission model every binary runs under. Prints what they would see. */
function aliquot(cfg: string, env: Record<string, string>, ...args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ...PERMISSION_FLAGS, join(root, "packages/core/bin/aliquot.ts"), "--config", cfg, ...args], { cwd: root, env: { ...base, ...env }, encoding: "utf8" });
  console.log(`  $ aliquot ${args.join(" ")}`);
  const out = `${r.stdout}${r.stderr}`;
  say(out);
  return { code: r.status, out };
}

/** Each step's processes, given only that step's keys; every one is stopped when the step ends, so no worker holding an old key claims a later step's job. */
const spawned: Processes[] = [];
function procs(env: Record<string, string>): Processes {
  const p = processes(root, work, { ...base, ...env });
  spawned.push(p);
  return p;
}
const stepProcs = { stopAll: async () => { for (const p of spawned.splice(0)) await p.stopAll(); } } as Processes;

/** A worker and a web door on this lab.toml and these keys; resolves with the door's address. */
async function stack(cfg: string, env: Record<string, string>, id: string): Promise<string> {
  const ps = procs(env);
  ps.startWorker(cfg, id);
  return (await ps.startWeb(cfg)).base;
}

/** A member asks through the web door, as the chat page does; resolves with the run once it has finished. */
async function ask(door: string, thread: string, text: string): Promise<RunId> {
  const sent = await post(door, "/message", { thread, message: `${thread}-${randomBytes(4).toString("hex")}`, text, user: "member-1" });
  assert.equal(sent.status, 202, JSON.stringify(sent.json));
  const runId = sent.json.runId as RunId;
  const outcome = await waitFor(`run ${runId} to finish`, async () => {
    const f = (await loadEvents(db, runId)).find((e) => e.event.t === "run.finished")?.event;
    return f?.t === "run.finished" ? f.outcome : null;
  }, 30_000);
  console.log(`  member asks "${text}" in thread ${thread}: run ${runId} ${outcome}`);
  return runId;
}

async function view(door: string, runId: RunId): Promise<RecordView> {
  return (await (await fetch(`${door}/runs/${runId}/view`)).json()) as RecordView;
}

const keysOf = (v: RecordView) => [...new Set(v.bodies.map((b) => (b.state === "stored" || b.state === "unavailable" ? `${b.state} ${b.keyId}` : b.state)))].join(", ");
const counts = (out: string) => Object.fromEntries([...out.matchAll(/^\s*(k\d)\s+\S+\s+(yes|no)\s+.*?\s+(\d+)\s+(\d+)$/gm)].map((m) => [m[1], { held: m[2] === "yes", bodies: Number(m[3]), toMove: Number(m[4]) }]));

const { check, results } = checker(stepProcs);
const runs: RunId[] = [];
const thread = "freezer-3";
let d3Run = "" as RunId;

try {
  await check("1. a lab on one key: runs exist under k1", async () => {
    const door = await stack(oneKey, { LABH_PAYLOAD_KEY: K1 }, "w1");
    runs.push(await ask(door, thread, "How cold is freezer 3?"));
    runs.push(await ask(door, "reagents", "Who signs off on new reagents?"));
    const v = await view(door, runs[0]!);
    assert.ok(v.bodies.length > 0 && v.bodies.every((b) => b.state === "stored" && b.keyId === "k1"), keysOf(v));
    return `${runs.length} runs, every body ${keysOf(v)}`;
  });

  await check("2. aliquot keys status shows what k1 holds", async () => {
    const r = aliquot(oneKey, { LABH_PAYLOAD_KEY: K1 }, "keys", "status");
    const c = counts(r.out);
    assert.equal(r.code, 0);
    assert.ok(c.k1 && c.k1.held && c.k1.bodies > 0 && c.k1.toMove === 0, JSON.stringify(c));
    return `k1 holds ${c.k1.bodies} bodies`;
  });

  await check("3. rotate to k2, ask a new question in the old thread, and status shows both keys", async () => {
    console.log("  steward adds LABH_PAYLOAD_KEY_2 (openssl rand -hex 32) and sets [store] current = \"k2\" with k1 and k2 in [store.keys]");
    const env = { LABH_PAYLOAD_KEY: K1, LABH_PAYLOAD_KEY_2: K2 };
    const r = aliquot(rotated, env, "keys", "rotate");
    assert.equal(r.code, 0);
    assert.match(r.out, /k2 is current/);
    const door = await stack(rotated, env, "w2");
    runs.push(await ask(door, thread, "And freezer 4?"));
    const c = counts(aliquot(rotated, env, "keys", "status").out);
    assert.ok(c.k1!.bodies > 0 && c.k2!.bodies > 0, JSON.stringify(c));
    return `k1 holds ${c.k1!.bodies}, k2 holds ${c.k2!.bodies}, ${c.k1!.toMove} wait to move`;
  });

  await check("4. mid-rotation, old and new records both open", async () => {
    const env = { LABH_PAYLOAD_KEY: K1, LABH_PAYLOAD_KEY_2: K2 };
    const door = await stack(rotated, env, "w3");
    const old = await view(door, runs[0]!);
    const fresh = await view(door, runs[2]!);
    console.log(`  record of the first run: ${keysOf(old)}; record of the new run: ${keysOf(fresh)}`);
    assert.ok(old.bodies.some((b) => b.state === "stored" && b.keyId === "k1"));
    assert.ok(fresh.bodies.some((b) => b.state === "stored" && b.keyId === "k2"));
    const followUp = await ask(door, thread, "Is that colder than freezer 3?");
    const f = (await loadEvents(db, followUp)).find((e) => e.event.t === "run.finished")?.event;
    assert.ok(f?.t === "run.finished" && f.outcome === "answered", "the follow-up reads k1 history and k2 history and answers");
    runs.push(followUp);
    return "both records list their bodies, and a follow-up that reads k1 and k2 history is answered";
  });

  await check("5. aliquot keys reencrypt finishes, k1 holds 0, and the lab runs on k2 alone", async () => {
    const env = { LABH_PAYLOAD_KEY: K1, LABH_PAYLOAD_KEY_2: K2 };
    const r = aliquot(rotated, env, "keys", "reencrypt", "--batch", "4");
    assert.equal(r.code, 0);
    const c = counts(aliquot(rotated, env, "keys", "status").out);
    assert.equal(c.k1!.bodies, 0);
    console.log("  steward removes k1 from [store.keys] and unsets LABH_PAYLOAD_KEY, then restarts");
    const only = { LABH_PAYLOAD_KEY_2: K2 };
    const door = await stack(k2Only, only, "w4");
    const again = await ask(door, thread, "Which freezer is coldest?");
    const f = (await loadEvents(db, again)).find((e) => e.event.t === "run.finished")?.event;
    assert.ok(f?.t === "run.finished" && f.outcome === "answered", "the thread's history, first written under k1, opens under k2 alone");
    runs.push(again);
    const runsOut = aliquot(k2Only, only, "runs");
    assert.equal(runsOut.code, 0);
    return `moved every body to k2 (${c.k2!.bodies}); a follow-up on k2 alone reads the whole thread`;
  });

  await check("6. a D3 payload goes under its own key, and a reader without that key sees it as unavailable", async () => {
    const env = { LABH_PAYLOAD_KEY_2: K2, LABH_PAYLOAD_KEY_3: K3 };
    const door = await stack(withD3, env, "w5");
    d3Run = await ask(door, "roster", "Is P-10422 scheduled for a visit this week?");
    const c = counts(aliquot(withD3, env, "keys", "status").out);
    assert.ok(c.k3!.bodies > 0, JSON.stringify(c));
    const readerEnv = { LABH_PAYLOAD_KEY_2: K2 };
    const reader = await procs(readerEnv).startWeb(withD3);
    const v = await view(reader.base, d3Run);
    console.log(`  a second web door holding only k2 opens the D3 run's record: ${keysOf(v)}`);
    assert.ok(v.bodies.some((b) => b.cls === "D3" && b.state === "unavailable" && b.keyId === "k3"), keysOf(v));
    assert.equal(v.chain.firstBad, null);
    const r = aliquot(withD3, readerEnv, "record", d3Run);
    assert.match(r.out, /unavailable here: encrypted under key k3, which this process does not hold/);
    return `k3 holds ${c.k3!.bodies} D3 bodies; without k3 the record page says unavailable and the chain still verifies`;
  });

  let redactedRun = "" as RunId;
  await check("7. set the window: the dry run lists the old runs, apply redacts them, and every chain still verifies", async () => {
    console.log('  steward sets [policy.retention.D1] purge_payload_after_days = 30; D3 has no purge and is kept');
    const env = { LABH_PAYLOAD_KEY_2: K2, LABH_PAYLOAD_KEY_3: K3 };
    const asOf = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10);
    const dry = aliquot(windowed, env, "retention", "--dry-run", "--as-of", asOf);
    assert.equal(dry.code, 0);
    const listed = [...dry.out.matchAll(/run ([0-9a-f-]{36})/g)].map((m) => m[1]);
    assert.deepEqual(listed.sort(), runs.slice().sort(), "every D1 run is listed, and the D3 run is not");
    const before = (await loadAudit(db)).length;
    const applied = aliquot(windowed, env, "retention", "--apply", "--as-of", asOf);
    assert.equal(applied.code, 0);
    assert.match(applied.out, new RegExp(`Every chain still verifies: ${runs.length} runs checked`));
    const audit = (await loadAudit(db)).slice(before);
    assert.deepEqual(audit.map((a) => a.event.t), ["retention.swept"]);
    const kept = await db.query<{ n: number }>("select count(*)::int as n from web_messages where run_id = any($1::uuid[]) and text <> ''", [runs]);
    assert.equal(kept.rows[0]!.n, 0, "the door's copy of each redacted run's reply is cleared too");
    const again = aliquot(windowed, env, "retention", "--dry-run", "--as-of", asOf);
    assert.match(again.out, /Nothing is past the window/);
    const all = aliquot(windowed, env, "runs");
    assert.equal(all.code, 0, "aliquot runs exits 0 only when every chain is intact");
    redactedRun = runs[1]!;
    return `${listed.length} runs listed and redacted, the door's reply copies cleared, audit event written, a second dry run finds nothing, every chain intact`;
  });

  await check("8. the record page shows the redacted body line, with its hash", async () => {
    const env = { LABH_PAYLOAD_KEY_2: K2, LABH_PAYLOAD_KEY_3: K3 };
    const door = (await procs(env).startWeb(windowed)).base;
    const launch = process.env.LABH_CHROMIUM ? { executablePath: process.env.LABH_CHROMIUM } : {};
    const browser = await chromium.launch(launch);
    try {
      const v = await view(door, redactedRun);
      const body = v.bodies.find((b) => b.state === "redacted");
      assert.ok(body, keysOf(v));
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${door}/runs/${redactedRun}`);
      const row = page.locator("#body-rows tr.redacted").first();
      const text = (await row.innerText()).replace(/\s+/g, " ");
      console.log(`  record page, Bodies: ${text}`);
      assert.match(text, /Redacted on .+ by the lab's retention window/);
      assert.ok(text.includes(body.hash), "the hash is still shown");
      assert.match(await page.locator(".chain").innerText(), /Verified: chain intact/);
      if (values.stills) {
        const out = resolve(values.stills);
        mkdirSync(out, { recursive: true });
        for (const [name, options] of [
          ["1440", { viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 }],
          ["390", { ...devices["iPhone 15"] }],
        ] as const)
          for (const colorScheme of ["light", "dark"] as const) {
            const context = await browser.newContext({ ...options, colorScheme });
            const p = await context.newPage();
            await p.goto(`${door}/runs/${redactedRun}`);
            await p.locator("#body-rows tr.redacted").first().waitFor();
            await p.locator("#bodies-h").scrollIntoViewIfNeeded();
            const file = join(out, `record-redacted-${name}-${colorScheme}.png`);
            await p.screenshot({ path: file, fullPage: true });
            console.log(`  still ${file}`);
            await context.close();
          }
      }
      return `"${text.match(/Redacted on .+? by the lab's retention window/)?.[0]}" with hash ${body.hash.slice(0, 12)}...`;
    } finally {
      await browser.close();
    }
  });
} finally {
  await stepProcs.stopAll();
  await model.close();
  await db.end();
}

console.log("");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} steps failed` : `all ${results.length} steps passed`);
process.exit(failed ? 1 : 0);
