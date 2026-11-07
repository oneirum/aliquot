#!/usr/bin/env node
/**
 * pnpm walk:router: a member asks in a shared channel and the right agent answers.
 *
 * lab0's handbook agent and a methods agent are published on one channel. The walk asks the web door what a member
 * would type on the chat page and prints what they would see: which agent the router picked and how sure it was, the
 * cited answer, the record link and the routing line on the record; then a question that fits both agents, the
 * choices offered, the pick, the picked agent's answer, and a follow-up that stays with it. Last, it drives the real
 * chat page in headless Chromium through the same ask and pick, and saves stills (light and dark, 1440 and 390 wide).
 * Real Postgres, web and worker processes; scripted local fakes for the compiler and the agent model; no network.
 *
 *   node scripts/walk-router.ts [--stills <dir>] [--no-stills]
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPayloadStore, oneKey, loadEvents, verifyChain, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { ensurePostgres, get, processes, waitFor } from "./procs.ts";
import { askShared, publishRoutedAgents, SHARED, type Sent } from "./routed-lab.ts";

const { values } = parseArgs({ options: { stills: { type: "string" }, "no-stills": { type: "boolean", default: false } } });
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".walk-router");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const kbDir = join(work, "kb");
cpSync(join(root, "fixtures/lab0"), kbDir, { recursive: true });
const stillsDir = resolve(values.stills ?? join(work, "stills"));

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_walk_router");
const compiler = await startFakeModel("scripted-1", "compile");
const agentModel = await startFakeModel("scripted-1", "search-then-answer");
const payloadKey = randomBytes(32).toString("hex");
const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: payloadKey };
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, keyring: oneKey(Buffer.from(payloadKey, "hex")) });

const agentPath = join(work, "agent.json");
writeFileSync(agentPath, JSON.stringify({ ...JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")), knowledgeBases: ["lab0-handbook"], model: { endpointId: "agentlab", modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 256 } } }));
const cfg = join(work, "lab.toml");
writeFileSync(cfg, [
  "[lab]", 'name = "Lab0"',
  "[database]", 'url_env = "DATABASE_URL"',
  "[store]", 'placement = "lab"', 'key_env = "LABH_PAYLOAD_KEY"',
  "[endpoints.local]", `base_url = "${compiler.url}"`, 'placement = "lab"',
  "[endpoints.agentlab]", `base_url = "${agentModel.url}"`, 'placement = "lab"',
  "[surfaces.web]", 'placement = "lab"', "port = 0",
  "[agents]", `fixtures = ["${agentPath}"]`, "",
].join("\n"));

const ps = processes(root, work, env);
const results: { name: string; ok: boolean }[] = [];
const say = (line = "") => console.log(line);
const quote = (text: string) => text.split("\n").map((l) => `    | ${l}`).join("\n");
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  say(`\n== ${name}`);
  try {
    await fn();
    results.push({ name, ok: true });
    say(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    say(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function kb(args: string[]): Promise<string> {
  const proc = ps.start(`kb-${args[0]}-${Date.now()}`, "kb.ts", ["--config", cfg, ...args]);
  await proc.exit;
  const line = proc.out.join("").split("\n").findLast((l) => l.startsWith("{"));
  assert.ok(line, proc.out.join(""));
  return line;
}
async function compileAndPublish(def: string): Promise<string> {
  const out = JSON.parse(await kb(["compile", "--definition", join(kbDir, def), "--wait", "--timeout-ms", "60000"])) as { result: { t: string; snapshot: string } };
  assert.equal(out.result.t, "compiled", JSON.stringify(out));
  assert.deepEqual(JSON.parse(await kb(["publish", "--snapshot", out.result.snapshot])), { ok: true });
  return out.result.snapshot;
}
async function finished(runId: string): Promise<StoredEvent[]> {
  return waitFor(`run ${runId}`, async () => {
    const es = await loadEvents(db, runId as RunId);
    return es.some((e) => e.event.t === "run.finished") ? es : null;
  }, 20_000);
}
async function answerOf(events: StoredEvent[]): Promise<string> {
  const f = events.find((e) => e.event.t === "run.finished")?.event;
  if (f?.t !== "run.finished" || !f.answer) return "";
  const body = await store.get(f.answer);
  return "redacted" in body ? "" : String(body.value);
}
/** What the member sees once the run ends: who answered, the answer, the record link, and the record's routing line. */
async function showAnswer(base: string, sent: Sent): Promise<{ answer: string; routed: string | null }> {
  const runId = sent.json.runId!;
  const events = await finished(runId);
  assert.equal(verifyChain(events), null, "the record's chain verifies");
  const answer = await answerOf(events);
  const view = JSON.parse((await get(`${base}/runs/${runId}/view`)).text) as { route: string | null };
  say(`  ${sent.json.answeredBy?.name} answered:`);
  say(quote(answer.length > 400 ? `${answer.slice(0, 400)}...` : answer));
  say(`  record: ${base}/runs/${runId}`);
  say(`  the record says: routed to ${view.route}`);
  return { answer, routed: view.route };
}
function routed(sent: Sent, agentId: string, basis: string): void {
  assert.equal(sent.status, 202, JSON.stringify(sent.json));
  const r = sent.json.route;
  assert.ok(r?.t === "agent", JSON.stringify(sent.json));
  const others = Object.entries(r.probs).filter(([id]) => id !== r.agentId).map(([id, p]) => `${id} ${p}`).join(", ");
  say(`  the router picked ${sent.json.answeredBy?.name} (${r.agentId}), basis ${r.basis}, confidence ${r.confidence}${others ? `; ${others}` : ""}`);
  assert.equal(sent.json.answeredBy?.agentId, agentId);
  assert.equal(r.basis, basis);
}

const UNSURE = "Do skipped diary items count as missing data?";
const FOLLOW_UP = "What about the diary nights?";
try {
  let base = "";
  await step("setup: the lab publishes two agents on one shared channel", async () => {
    ps.startWorker(cfg, "walk");
    say(`  handbook KB ${(await compileAndPublish("kb.json")).slice(0, 12)}, methods KB ${(await compileAndPublish("kb-methods.json")).slice(0, 12)} published`);
    const docs = await publishRoutedAgents(root, cfg, env, "agentlab", [`web:${SHARED}`]);
    for (const d of docs) say(`  ${d.name} (${d.agentId}) on web:${SHARED}: ${d.sampleQuestions.length} sample questions`);
    base = (await ps.startWeb(cfg)).base;
    say(`  chat page: ${base}/?channel=${SHARED}`);
  });

  await step("a handbook question goes to the handbook agent, with a cited answer and the decision in the record", async () => {
    const q = "Who do I call when the freezer alarm sounds?";
    say(`  member asks: ${q}`);
    const sent = await askShared(base, "walk-1", "walk-1a", q);
    routed(sent, "lab0-desk", "score");
    const { answer, routed: line } = await showAnswer(base, sent);
    assert.ok(answer.includes("sop/freezer-alarm.md"), "the answer cites sop/freezer-alarm.md");
    assert.match(line ?? "", /^lab0-desk: the router's top score/);
  });

  await step("a statistics question in the same channel goes to the methods agent", async () => {
    const q = "How many participants per group for a two-group comparison?";
    say(`  member asks: ${q}`);
    const sent = await askShared(base, "walk-2", "walk-2a", q);
    routed(sent, "lab0-methods", "score");
    const { answer } = await showAnswer(base, sent);
    assert.ok(answer.includes("methods/sample-size.md"), "the answer cites methods/sample-size.md");
  });

  await step("a question that fits both: the member is shown the choices, the pick answers, a follow-up stays with it", async () => {
    say(`  member asks: ${UNSURE}`);
    const asked = await askShared(base, "walk-3", "walk-3a", UNSURE);
    assert.equal(asked.json.t, "asked-user", JSON.stringify(asked.json));
    const r = asked.json.route as { confidence: number; probs: Record<string, number> };
    say(`  the router is unsure (top confidence ${r.confidence}, below 0.75: ${JSON.stringify(r.probs)}), so the page shows:`);
    asked.json.choices!.forEach((c, i) => say(`    ${i + 1}. ${c.name}: ${c.line}`));
    assert.deepEqual(asked.json.choices!.map((c) => c.agentId).sort(), ["lab0-desk", "lab0-methods"]);
    say("  member picks: Methods desk");
    const picked = await askShared(base, "walk-3", "walk-3a", UNSURE, "lab0-methods");
    routed(picked, "lab0-methods", "picked");
    assert.ok((await showAnswer(base, picked)).answer.includes("methods/missing-data.md"), "the picked agent cites methods/missing-data.md");
    say(`  member follows up in the same thread: ${FOLLOW_UP}`);
    const followUp = await askShared(base, "walk-3", "walk-3b", FOLLOW_UP);
    routed(followUp, "lab0-methods", "thread");
    await showAnswer(base, followUp);
    const fresh = await askShared(base, "walk-4", "walk-4a", FOLLOW_UP);
    say(`  (the same words in a new thread go to ${fresh.json.answeredBy?.name}: the thread is what held it)`);
    assert.equal(fresh.json.answeredBy?.agentId, "lab0-desk");
    await finished(fresh.json.runId!);
  });

  if (!values["no-stills"]) {
    await step("the chat page: the choices, then the picked agent's answer with its name (stills, light and dark, 1440 and 390)", async () => {
      const { chromium } = await import("playwright");
      mkdirSync(stillsDir, { recursive: true });
      const browser = await chromium.launch(process.env.LABH_CHROMIUM ? { executablePath: process.env.LABH_CHROMIUM } : { channel: "chromium" });
      try {
        const sizes = [
          { name: "1440", options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } },
          { name: "390", options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
        ];
        for (const size of sizes) {
          for (const colorScheme of ["light", "dark"] as const) {
            const context = await browser.newContext({ ...size.options, colorScheme });
            const page = await context.newPage();
            await page.goto(`${base}/?channel=${SHARED}`);
            await page.fill("#text", UNSURE);
            await page.keyboard.press("Enter");
            await page.locator(".choose button.choice").first().waitFor();
            const names = await page.locator(".choose .name").allTextContents();
            assert.deepEqual([...names].sort(), ["Lab handbook", "Methods desk"]);
            const choices = join(stillsDir, `choices-${size.name}-${colorScheme}.png`);
            await page.screenshot({ path: choices });
            // The keyboard path on the wide page, a tap on the phone.
            if (size.name === "1440") await page.keyboard.press(String(names.indexOf("Methods desk") + 1));
            else await page.locator(".choose button.choice", { hasText: "Methods desk" }).tap();
            await page.locator(".entry[data-entry-done]").waitFor({ timeout: 20_000 });
            assert.equal(await page.locator(".entry .meta .agent").textContent(), "Methods desk");
            const answer = join(stillsDir, `answer-${size.name}-${colorScheme}.png`);
            await page.screenshot({ path: answer });
            say(`  ${choices}\n  ${answer}`);
            await context.close();
          }
        }
      } finally {
        await browser.close();
      }
    });
  }
} finally {
  await ps.stopAll();
  await compiler.close();
  await agentModel.close();
  await db.end();
}

say("");
for (const r of results) say(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
say(`${results.length - failed}/${results.length} steps passed`);
process.exit(failed ? 1 : 0);
