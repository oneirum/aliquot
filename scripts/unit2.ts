#!/usr/bin/env node
/**
 * pnpm unit2: the studio against real Postgres, the real studio (next dev) in
 * a headless browser, core's worker and web processes under the permission
 * model, and scripted models.
 *
 *   1. A publisher with no repository access builds an agent in the form. A
 *      vague description and the model "latest" do not block the save; the
 *      publish checks list both and publish is refused. Fixed, tested in the
 *      test thread, and published with a changelog note.
 *   2. The next web message runs the new published version hash.
 *   3. An edit republished makes a new hash and leaves the old version row
 *      as it was; the revision diff shows the edit, and restoring the older
 *      revision brings back the first version's hash.
 *   4. Roles: a member and an author cannot publish, a publisher cannot
 *      publish at D3 (panel and direct POST) or take the steward's D3 head
 *      by lowering the ceiling, a data steward can. A member cannot test a
 *      D3 draft, read someone else's test run, or change their own email.
 *   5. An author writes the synthetic lab's KB definition in the KB form and
 *      compiles it from the three documents with the scripted compiler. A
 *      source location that is a path is refused. The
 *      coverage report names the one question no document answers, publish
 *      is refused naming it, and a publisher publishes over it with a note.
 *      A question through the web door retrieves and cites its entry.
 *   6. A data steward compiles and publishes the D3 roster KB through the
 *      form; an author cannot read that compile and a publisher cannot
 *      publish it. An agent on the hosted endpoint with the roster attached
 *      saves, its checks and its test thread refuse it with the KB-class
 *      message. A D1 hosted agent's test runs reach the worker: a roster id
 *      is refused there and the hosted model receives nothing, while a
 *      control message does reach it.
 *
 *   node scripts/unit2.ts [--headed] [--shots <dir>] [--proof <dir>]
 *
 * Postgres comes from LABH_TEST_PG (default localhost:5432). The browser is
 * Playwright's Chromium: `pnpm exec playwright install chromium` once, or
 * LABH_CHROMIUM naming a Chromium executable already on disk.
 * Screenshots and logs land in .unit2/. --shots also saves light and dark
 * viewport screenshots of three moments, the README images, into <dir>. --proof saves the agent and knowledge base
 * pages in both themes, whole at 1440 wide and panel by panel at 390 wide, into <dir>. No process outlives the script
 * (scripts/procs.ts); the last line counts what is left.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import type { SnapshotId } from "../packages/core/src/hash.ts";
import { loadManifest } from "../packages/core/src/kb.ts";
import { createPayloadStore, loadEvents, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { freshDatabase } from "../test/db.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { ensurePostgres, processes, waitFor, type Proc } from "./procs.ts";

const { values: flags } = parseArgs({ options: { headed: { type: "boolean", default: false }, shots: { type: "string" }, proof: { type: "string" } } });

type Clip = { x: number; y: number; width: number; height: number };

// clip is the part of the 1440 by 1080 viewport the README shows: one panel, so its text stays legible on a phone.
// The page is captured at device scale 2, so the file has twice the pixels of the width the README shows it at.
async function readmeShot(page: Page, name: string, clip: Clip): Promise<void> {
  if (flags.shots === undefined) return;
  mkdirSync(flags.shots, { recursive: true });
  const size = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 1200 });
  const hide = await page.addStyleTag({ content: "nextjs-portal, .payload-toast-container { display: none !important; }" });
  await page.mouse.wheel(0, -100_000);
  // Payload picks its theme on the server and marks <html>; the attribute is what its styles read. The README shows
  // the light theme only: GitHub's app does not resolve a <picture> srcset, so a per-theme pair breaks there.
  await page.evaluate(`document.documentElement.setAttribute("data-theme", "light")`);
  await sleep(500);
  await page.screenshot({ path: join(flags.shots, `${name}.png`), clip });
  await hide.evaluate("(el) => el.remove()");
  if (size !== null) await page.setViewportSize(size);
}

// Both themes at a desktop and a phone width. On a phone Payload stacks the sidebar under the form, so each panel is
// captured on its own there. Payload reads the theme from <html data-theme>, as readmeShot does.
async function proofShots(page: Page, name: string, panels: readonly string[]): Promise<void> {
  if (flags.proof === undefined) return;
  mkdirSync(flags.proof, { recursive: true });
  const size = page.viewportSize();
  const hide = await page.addStyleTag({ content: "nextjs-portal, .payload-toast-container { display: none !important; }" });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`);
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.mouse.wheel(0, -100_000);
    await sleep(400);
    await page.screenshot({ path: join(flags.proof, `${name}-desktop-${theme}.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(400);
    // Payload's sticky document bar would cover the top of a panel scrolled into view; the panel shot is of the panel.
    const unstick = await page.addStyleTag({ content: ".doc-controls, .app-header { position: static !important; }" });
    for (const id of panels) {
      const panel = page.getByTestId(id);
      if (!(await panel.count())) continue;
      await panel.scrollIntoViewIfNeeded();
      await panel.screenshot({ path: join(flags.proof, `${name}-phone-${id}-${theme}.png`) });
    }
    await unstick.evaluate("(el) => el.remove()");
  }
  await hide.evaluate("(el) => el.remove()");
  if (size !== null) await page.setViewportSize(size);
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".unit2");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const lab0 = join(root, "fixtures/lab0");
const prereg = JSON.parse(readFileSync(join(lab0, "questions.json"), "utf8")) as {
  inDocument: { id: string; question: string; expected: string }[];
  outsideDocuments: { id: string; question: string }[];
  restricted: { pattern: string; message: string; control: string };
};

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_unit2");
const agentModel = await startFakeModel("scripted-1", "search-then-answer");
const compiler = await startFakeModel("scripted-1", "compile");
const hosted = await startFakeModel("hosted-2", "answer");
const payloadKey = randomBytes(32).toString("hex");
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: Buffer.from(payloadKey, "hex"), keyId: "k1" });

const configPath = join(work, "lab.toml");
writeFileSync(
  configPath,
  [
    "[database]",
    'url_env = "DATABASE_URL"',
    "[store]",
    'placement = "lab"',
    'key_env = "LABH_PAYLOAD_KEY"',
    "[endpoints.local]",
    `base_url = "${agentModel.url}"`,
    'placement = "lab"',
    "[endpoints.compiler]",
    `base_url = "${compiler.url}"`,
    'placement = "lab"',
    "[endpoints.hosted]",
    `base_url = "${hosted.url}"`,
    'placement = "zdr"',
    "[surfaces.web]",
    'placement = "lab"',
    "port = 0",
    "[policy]",
    'review_confidential = "refuse"',
    `participant_id_patterns = ['\\bP-\\d{5}\\b', '${prereg.restricted.pattern}']`,
    "[knowledge_bases]",
    `fixtures = ["${join(root, "fixtures/kb.json")}"]`,
    "",
  ].join("\n"),
);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  await new Promise<void>((res) => server.close(() => res()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  DATABASE_URL: dbUrl,
  LABH_PAYLOAD_KEY: payloadKey,
  LABH_CONFIG: configPath,
  PAYLOAD_SECRET: randomBytes(24).toString("hex"),
  NEXT_TELEMETRY_DISABLED: "1",
  LABH_STUDIO_DIST_DIR: ".next-unit2",
};

const ps = processes(root, work, env);
const started: Proc[] = [];
let browser: Browser | null = null;
const results: { name: string; ok: boolean }[] = [];

/** Processes still running in a group this script started, or a core child that has not exited. */
function leftovers(): number {
  let n = 0;
  for (const p of started) {
    if (p.group) n += spawnSync("pgrep", ["-g", String(p.child.pid)], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
    else if (p.child.exitCode === null && p.child.signalCode === null) n += 1;
  }
  return n;
}

try {
  started.push(ps.startWorker(configPath, "W"));
  const web = await ps.startWeb(configPath);
  started.push(web.proc);
  const webBase = web.base;
  const studioPort = Number(process.env.LABH_STUDIO_PORT ?? (await freePort()));
  const studioBase = `http://127.0.0.1:${studioPort}`;
  started.push(ps.startGroup("studio", join(root, "packages/studio/node_modules/.bin/next"), ["dev", "-H", "127.0.0.1", "-p", String(studioPort)], join(root, "packages/studio")));

  // Studio accounts. Seeding is the PI's one-time setup, done over the
  // studio's own REST API; everything after it happens in the browser.

  async function api(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}): Promise<{ status: number; json: Record<string, unknown>; cookie: string }> {
    const res = await fetch(`${studioBase}/api${path}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return { status: res.status, json: (await res.json()) as Record<string, unknown>, cookie };
  }

  const people = {
    pi: { email: "pia@lab.example", password: "pi-pass-1" },
    steward: { email: "sam@lab.example", password: "steward-pass-1" },
    publisher: { email: "pat@lab.example", password: "publisher-pass-1" },
    author: { email: "ana@lab.example", password: "author-pass-1" },
    member: { email: "mo@lab.example", password: "member-pass-1" },
  } as const;

  await waitFor("the studio to answer", async () => ((await fetch(`${studioBase}/api/users/me`).catch(() => null))?.ok ? true : null), 180000);
  const first = await api("/users/first-register", { method: "POST", body: people.pi });
  assert.equal((first.json.user as { role?: string } | undefined)?.role, "pi", `the first account is the PI: ${JSON.stringify(first.json)}`);
  for (const role of ["steward", "publisher", "author", "member"] as const) {
    const made = await api("/users", { method: "POST", cookie: first.cookie, body: { ...people[role], role } });
    assert.equal(made.status, 201, JSON.stringify(made.json));
  }
  const notPi = await api("/users", { method: "POST", cookie: (await api("/users/login", { method: "POST", body: people.publisher })).cookie, body: { email: "x@lab.example", password: "x-pass-1", role: "pi" } });
  assert.equal(notPi.status, 403, `only the PI creates accounts: ${JSON.stringify(notPi.json)}`);

  // Browser helpers ----------------------------------------------------------

  // LABH_CHROMIUM points at a Chromium already on disk when Playwright's own build is not installed.
  browser = await chromium.launch({ headless: !flags.headed, ...(process.env.LABH_CHROMIUM ? { executablePath: process.env.LABH_CHROMIUM } : {}) });
  const b = browser;

  async function signIn(who: keyof typeof people): Promise<Page> {
    const page = await (await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })).newPage();
    page.setDefaultTimeout(60000);
    await page.goto(`${studioBase}/admin/login`);
    await page.fill("#field-email", people[who].email);
    await page.fill("#field-password", people[who].password);
    await page.click("button[type=submit]");
    await page.waitForURL(/\/admin$/);
    return page;
  }

  async function addTag(page: Page, field: string, value: string): Promise<void> {
    const input = page.locator(`.field-${field} input.rs__input`);
    await input.fill(value);
    await input.press("Enter");
    await page.locator(`.field-${field} .rs__multi-value`, { hasText: value }).first().waitFor();
  }

  async function choose(page: Page, field: string, option: string): Promise<void> {
    await page.click(`#field-${field.replace(/\./g, "__")} .rs__control`);
    await page.locator(".rs__option", { hasText: new RegExp(`^${option}$`) }).click();
  }

  /** Payload rebuilds form state on the server a moment after each edit; a reply landing after Save would wipe Save's field errors. */
  async function save(page: Page): Promise<void> {
    await page.waitForLoadState("networkidle");
    await sleep(750);
    await page.waitForLoadState("networkidle");
    await page.click("#action-save");
  }

  /** Saves an existing document and waits for the server to accept it. A toast from an earlier save can still be on screen, so the toast proves nothing. */
  async function saveExisting(page: Page): Promise<void> {
    const accepted = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/api\/(agents|knowledge-bases)\/\d+/.test(r.url()) && r.ok());
    await save(page);
    await accepted;
  }

  async function saveNew(page: Page, collection: string): Promise<string> {
    await save(page);
    await page.waitForURL(new RegExp(`/admin/collections/${collection}/\\d+`));
    return page.url().replace(/\?.*$/, "");
  }

  interface AgentForm {
    agentId: string;
    name: string;
    description: string;
    instructions: string;
    endpoint: string;
    model: string;
    knowledgeBases: string[];
    channels: string[];
    ceiling: string;
  }

  async function fillAgent(page: Page, a: AgentForm): Promise<void> {
    await page.goto(`${studioBase}/admin/collections/agents/create`);
    await page.getByRole("button", { name: "Add Tool" }).click();
    await page.fill("#field-tools__0__name", "kb_search");
    await page.waitForLoadState("networkidle");
    await page.fill("#field-agentId", a.agentId);
    await page.fill("#field-name", a.name);
    await page.fill("#field-description", a.description);
    await page.fill("#field-owner", "pia@lab.example");
    await page.fill("#field-instructions", a.instructions);
    await page.fill("#field-model__endpointId", a.endpoint);
    await page.fill("#field-model__modelId", a.model);
    for (const kb of a.knowledgeBases) await addTag(page, "knowledgeBases", kb);
    for (const ch of a.channels) await addTag(page, "channels", ch);
    await choose(page, "ceiling", a.ceiling);
    await page.waitForLoadState("networkidle");
  }

  async function runChecks(page: Page): Promise<string> {
    const panel = page.getByTestId("publish-panel");
    await panel.getByRole("button", { name: "Run checks" }).click();
    return panel.getByTestId("check-result").innerText();
  }

  /** Clicks through the publish panel and returns the version the outcome names. */
  async function publishInPanel(page: Page, changelog: string): Promise<string> {
    const panel = page.getByTestId("publish-panel");
    await panel.getByRole("button", { name: "Run checks" }).click();
    await panel.getByText("All checks pass").waitFor();
    await panel.locator("#changelog").fill(changelog);
    await panel.getByRole("button", { name: "Publish" }).click();
    const outcome = await panel.getByTestId("publish-outcome").innerText();
    const m = /version ([0-9a-f]{12})/.exec(outcome);
    assert.ok(m, `publish outcome: ${outcome}`);
    return m[1]!;
  }

  async function head(agentId: string): Promise<{ version: string; published_by: string; changelog: string } | undefined> {
    return (await db.query<{ version: string; published_by: string; changelog: string }>("select version, published_by, changelog from agent_heads where agent_id = $1", [agentId])).rows[0];
  }

  const kbHead = async (kbId: string) => (await db.query<{ snapshot: SnapshotId }>("select snapshot from kb_heads where kb_id = $1", [kbId])).rows[0]?.snapshot ?? null;

  const cookieOf = async (page: Page) => (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");

  interface KbForm {
    kbId: string;
    title: string;
    purpose: string;
    questions: string[];
    sources: { sourceId: string; location: string; cls: string }[];
  }

  async function fillKb(page: Page, k: KbForm): Promise<void> {
    await page.goto(`${studioBase}/admin/collections/knowledge-bases/create`);
    await page.fill("#field-kbId", k.kbId);
    await page.fill("#field-title", k.title);
    await page.fill("#field-purpose", k.purpose);
    for (const q of k.questions) await addTag(page, "coverageQuestions", q);
    for (const [i, s] of k.sources.entries()) {
      await page.getByRole("button", { name: "Add Source" }).click();
      await page.fill(`#field-sources__${i}__sourceId`, s.sourceId);
      await choose(page, `sources.${i}.kind`, "file");
      await page.fill(`#field-sources__${i}__location`, s.location);
      await choose(page, `sources.${i}.cls`, s.cls);
      await choose(page, `sources.${i}.licence`, "internal-only");
    }
    await page.fill("#field-compiler__endpointId", "compiler");
    await page.fill("#field-compiler__modelId", "scripted-1");
    await page.waitForLoadState("networkidle");
  }

  /** Attaches the files, compiles, and returns what the panel shows. */
  async function compileInPanel(page: Page, files: string[]): Promise<{ snapshot: string; gaps: string[]; coverage: string }> {
    const panel = page.getByTestId("kb-panel");
    await panel.getByTestId("kb-files").setInputFiles(files.map((f) => join(lab0, f)));
    await panel.getByRole("button", { name: "Compile" }).click();
    const compiled = panel.getByTestId("kb-compiled");
    await compiled.waitFor({ timeout: 120000 });
    const text = await compiled.innerText();
    const snapshot = /Snapshot ([0-9a-f]{12})/.exec(text)?.[1];
    assert.ok(snapshot, `compile panel: ${text}`);
    const gaps = (await panel.getByTestId("kb-gaps").count()) ? await panel.getByTestId("kb-gaps").locator("li").allInnerTexts() : [];
    await panel.locator("summary", { hasText: "Coverage report" }).click();
    return { snapshot, gaps, coverage: await panel.getByTestId("kb-coverage").innerText() };
  }

  async function finished(runId: RunId): Promise<StoredEvent[]> {
    return waitFor(
      "run.finished",
      async () => {
        const es = await loadEvents(db, runId);
        return es.some((e) => e.event.t === "run.finished") ? es : null;
      },
      30000,
    );
  }

  // Checks -------------------------------------------------------------------

  async function check(name: string, fn: () => Promise<string>): Promise<void> {
    const startedAt = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true });
      console.log(`PASS ${name} (${Date.now() - startedAt}ms): ${detail}`);
    } catch (err) {
      results.push({ name, ok: false });
      const pages = b.contexts().flatMap((c) => c.pages());
      for (const [i, page] of pages.entries()) await page.screenshot({ path: join(work, `failed-${results.length}-${i}.png`), fullPage: true }).catch(() => undefined);
      console.log(`FAIL ${name} (${Date.now() - startedAt}ms):\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
    for (const page of b.contexts().flatMap((c) => c.pages())) await page.close().catch(() => undefined);
  }

  const agentId = "handbook-helper";
  const instructions = "You answer questions about the lab handbook. Always call kb_search first with the question, then answer from the results only.";
  const goodDescription = "Answers questions about the lab handbook. Use when a lab member asks how something in the lab works. Not for literature search or statistics.";
  let docUrl = "";
  let firstVersion = "";
  let publisherTestRun = "";

  await check("check 1: a non-developer builds, tests and publishes an agent in the studio; lab-rule errors block publish, not save", async () => {
    const page = await signIn("publisher");
    await fillAgent(page, { agentId, name: "Handbook helper", description: "Answers questions about the lab.", instructions, endpoint: "local", model: "latest", knowledgeBases: ["handbook"], channels: ["web:handbook"], ceiling: "D1" });
    assert.deepEqual(
      [await page.inputValue("#field-tools__0__name"), await page.locator(".field-channels .rs__multi-value").innerText(), await page.locator("#field-ceiling .rs__single-value").innerText()],
      ["kb_search", "web:handbook", "D1"],
      "the form holds what was typed before Save",
    );
    docUrl = await saveNew(page, "agents");
    assert.equal(await db.query("select 1 from studio.agents").then((r) => r.rowCount), 1, "the draft saved with lab-rule errors");
    const listed = await runChecks(page);
    assert.match(listed, /Use when/);
    assert.match(listed, /Not for/);
    assert.match(listed, /"latest" floats to the latest version/);
    const panel = page.getByTestId("publish-panel");
    assert.equal(await panel.getByRole("button", { name: "Publish" }).count(), 0, "no publish button while checks fail");
    const docId = docUrl.split("/").pop();
    const cookie = await cookieOf(page);
    const checked = await api(`/agents/${docId}/check`, { method: "POST", cookie });
    const forced = await api(`/agents/${docId}/publish`, { method: "POST", cookie, body: { draftHash: (checked.json.check as { draftHash: string }).draftHash, changelog: "try anyway" } });
    assert.equal(forced.status, 409, JSON.stringify(forced.json));
    assert.match(String(forced.json.error), /Fix these \d+ errors first: .*latest/);
    assert.equal(await head(agentId), undefined, "nothing published");
    await readmeShot(page, "studio-agent-checks", { x: 980, y: 262, width: 420, height: 300 });

    await page.fill("#field-description", goodDescription);
    await page.fill("#field-model__modelId", "scripted-1");
    await saveExisting(page);
    await page.screenshot({ path: join(work, "studio-form.png"), fullPage: true });

    const thread = page.getByTestId("test-thread");
    await thread.getByLabel("Test message").fill("What are the PI office hours?");
    await thread.getByRole("button", { name: "Send" }).click();
    const answer = await thread.getByTestId("test-answer").innerText({ timeout: 60000 });
    assert.match(answer, /Scripted answer from 1 search result/);
    const tested = await thread.getByTestId("test-version").getAttribute("data-version");
    assert.match(tested ?? "", /^[0-9a-f]{64}$/);
    if (flags.proof !== undefined) {
      await page.getByTestId("publish-panel").getByRole("button", { name: "Run checks" }).click();
      await page.getByTestId("publish-panel").getByTestId("check-result").waitFor();
      await proofShots(page, "agent", ["publish-panel", "test-thread", "tools-panel"]);
    }
    const testJob = await db.query<{ id: string; payload: { trigger: { t: string } } }>("select id, payload from jobs where key like 'test:%'");
    assert.deepEqual(testJob.rows.map((r) => r.payload.trigger.t), ["test"]);
    publisherTestRun = testJob.rows[0]!.id;
    assert.equal(await head(agentId), undefined, "testing published nothing");

    const shown = await publishInPanel(page, "First version: answers handbook questions from the handbook KB.");
    const live = await head(agentId);
    assert.ok(live);
    assert.equal(live.version, tested, "the published version is the hash the test thread ran");
    assert.equal(shown, live.version.slice(0, 12));
    assert.equal(live.published_by, people.publisher.email);
    const audit = await db.query<{ actor: string; event: { t: string; version: string } }>("select actor, event from audit_events order by seq");
    assert.deepEqual(audit.rows.map((r) => [r.actor, r.event.t, r.event.version]), [[people.publisher.email, "agent.published", live.version]]);
    firstVersion = live.version;
    return `saved with 3 lab-rule errors, checks listed them, no publish button, direct publish 409; fixed, test thread answered on ${tested!.slice(0, 12)} (trigger test, nothing published); published ${live.version.slice(0, 12)} with a note, one audit row`;
  });

  await check("check 2: the next web message runs the new published version", async () => {
    const res = await fetch(`${webBase}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "handbook", thread: "w1", message: "w1m1", text: "What are the PI office hours?", user: "lab-member-7" }),
    });
    const body = (await res.json()) as { t: string; runId: RunId };
    assert.equal(res.status, 202, JSON.stringify(body));
    const events = await finished(body.runId);
    const startedEvent = events.find((e) => e.event.t === "run.started")!.event;
    assert.equal(startedEvent.t === "run.started" ? startedEvent.agent : null, (await head(agentId))!.version);
    const reply = (await db.query<{ text: string }>("select text from web_messages where run_id = $1 and kind = 'reply'", [body.runId])).rows[0];
    assert.ok(reply);
    return `web message in channel handbook -> run ${body.runId.slice(0, 8)}: run.started.agent = ${firstVersion.slice(0, 12)} = agent_heads.version; reply "${reply.text.slice(0, 50)}..."`;
  });

  await check("check 3: republishing an edit makes a new hash, the old row stays, and an older revision diffs and restores", async () => {
    const before = await db.query("select hash, agent_id, body, created_at from agent_versions where hash = $1", [firstVersion]);
    const page = await signIn("publisher");
    await page.goto(docUrl);
    await page.fill("#field-instructions", `${instructions} Name the handbook section you used.`);
    await saveExisting(page);
    const secondShort = await publishInPanel(page, "Cite the handbook section in every answer.");
    const second = (await head(agentId))!.version;
    assert.notEqual(second, firstVersion);
    assert.equal(secondShort, second.slice(0, 12));
    assert.deepEqual((await db.query("select hash, agent_id, body, created_at from agent_versions where hash = $1", [firstVersion])).rows, before.rows, "the first version row is unchanged");

    await page.goto(`${docUrl}/versions`);
    const revisions = page.locator("table tbody tr a");
    await revisions.first().waitFor();
    const newest = await revisions.first().getAttribute("href");
    const restoreTo = await revisions.nth(1).getAttribute("href");
    await page.goto(`${studioBase}${newest}`);
    await page.locator(".field-diff, [class*=diff]").filter({ hasText: "Name the handbook section you used." }).first().waitFor();
    const diffText = await page.locator("main, .template-default").first().innerText();
    assert.ok(diffText.includes(instructions) && diffText.includes("Name the handbook section you used."), "the diff shows the old and the new instructions");
    await page.screenshot({ path: join(work, "revision-diff.png"), fullPage: true });

    await page.goto(`${studioBase}${restoreTo}`);
    await page.getByRole("button", { name: "Restore this version" }).click();
    await page.locator(".confirmation-modal, [role=dialog]").getByRole("button", { name: /confirm|restore/i }).click();
    await page.waitForURL((u) => !u.pathname.includes("/versions/"));
    await page.goto(docUrl);
    assert.equal(await page.inputValue("#field-instructions"), instructions, "the form shows the restored instructions");
    const restoredShort = await publishInPanel(page, "Back to the first version.");
    const restored = (await head(agentId))!.version;
    assert.equal(restored, firstVersion, "the restored revision resolves to the first version's hash");
    assert.equal(restoredShort, firstVersion.slice(0, 12));
    const versionRows = await db.query("select hash from agent_versions where agent_id = $1", [agentId]);
    const revisionsNow = await db.query("select count(*)::int as n from studio._agents_v");
    return `edit -> ${second.slice(0, 12)} != ${firstVersion.slice(0, 12)}; first agent_versions row identical before and after; Payload's compare view showed the instructions diff; restoring the revision before the edit and publishing gave ${restored.slice(0, 12)} again; ${versionRows.rowCount} version rows, ${(revisionsNow.rows[0] as { n: number }).n} studio revisions`;
  });

  await check("check 4: a member and an author cannot publish, a publisher cannot publish at D3, a data steward can", async () => {
    const docId = docUrl.split("/").pop();
    const refusals: string[] = [];
    for (const who of ["member", "author"] as const) {
      const page = await signIn(who);
      await page.goto(docUrl);
      const panel = page.getByTestId("publish-panel");
      await panel.getByRole("button", { name: "Run checks" }).click();
      const refusal = await panel.getByTestId("publish-refusal").innerText();
      assert.match(refusal, who === "member" ? /Members cannot publish/ : /Authors cannot publish/);
      assert.equal(await panel.getByRole("button", { name: "Publish" }).count(), 0, `no publish button for ${who}`);
      const cookie = await cookieOf(page);
      const checked = await api(`/agents/${docId}/check`, { method: "POST", cookie });
      const direct = await api(`/agents/${docId}/publish`, { method: "POST", cookie, body: { draftHash: (checked.json.check as { draftHash: string }).draftHash, changelog: `${who} try` } });
      assert.equal(direct.status, 403, JSON.stringify(direct.json));
      refusals.push(`${who}: "${refusal}", direct POST 403`);
    }
    assert.equal((await head(agentId))!.version, firstVersion, "the head did not move");

    const publisher = await signIn("publisher");
    await publisher.goto(docUrl);
    await choose(publisher, "ceiling", "D3");
    await saveExisting(publisher);
    const panel = publisher.getByTestId("publish-panel");
    await panel.getByRole("button", { name: "Run checks" }).click();
    const d3 = await panel.getByTestId("publish-refusal").innerText();
    assert.match(d3, /Publishing at D3 needs the data steward or the PI/);
    const publisherCookie = await cookieOf(publisher);
    const d3Check = await api(`/agents/${docId}/check`, { method: "POST", cookie: publisherCookie });
    const d3Direct = await api(`/agents/${docId}/publish`, { method: "POST", cookie: publisherCookie, body: { draftHash: (d3Check.json.check as { draftHash: string }).draftHash, changelog: "publisher at D3" } });
    assert.equal(d3Direct.status, 403, JSON.stringify(d3Direct.json));
    assert.equal((await head(agentId))!.version, firstVersion, "the publisher did not move a D3 head");

    const member = await api("/users/login", { method: "POST", body: people.member });
    const memberTest = await api(`/agents/${docId}/test`, { method: "POST", cookie: member.cookie, body: { text: "Who is enrolled?" } });
    assert.equal(memberTest.status, 403, `a member cannot test a D3 draft: ${JSON.stringify(memberTest.json)}`);
    assert.match(String(memberTest.json.error), /Testing an agent at D3 needs the data steward or the PI/);
    assert.equal((await db.query("select 1 from jobs where key like 'test:%'")).rowCount, 1, "the refused test queued nothing");
    const othersRun = await api(`/agents/test-runs/${publisherTestRun}`, { cookie: member.cookie });
    assert.equal(othersRun.status, 404, `a member cannot read the publisher's test run: ${JSON.stringify(othersRun.json)}`);
    const ownRun = await api(`/agents/test-runs/${publisherTestRun}`, { cookie: publisherCookie });
    assert.equal(ownRun.status, 200, "the publisher reads their own test run");
    const memberId = (member.json.user as { id: number }).id;
    const renamed = await api(`/users/${memberId}`, { method: "PATCH", cookie: member.cookie, body: { email: "irb@lab.example" } });
    assert.equal(renamed.status, 403, `a member cannot change their own email: ${JSON.stringify(renamed.json)}`);
    assert.equal(((await api("/users/me", { cookie: member.cookie })).json.user as { email: string }).email, people.member.email, "the email did not change");

    const steward = await signIn("steward");
    await steward.goto(docUrl);
    const shown = await publishInPanel(steward, "Raise the ceiling to D3 for the consent-form questions.");
    const live = (await head(agentId))!;
    assert.equal(live.published_by, people.steward.email);
    assert.equal(shown, live.version.slice(0, 12));

    const lowered = await api(`/agents/${docId}`, { method: "PATCH", cookie: publisherCookie, body: { ceiling: "D1" } });
    assert.equal(lowered.status, 200, JSON.stringify(lowered.json));
    const takeover = await api(`/agents/${docId}/check`, { method: "POST", cookie: publisherCookie });
    assert.match(String(takeover.json.refusal), /Publishing at D3 needs the data steward or the PI/);
    const takeoverPost = await api(`/agents/${docId}/publish`, { method: "POST", cookie: publisherCookie, body: { draftHash: (takeover.json.check as { draftHash: string }).draftHash, changelog: "lower it back" } });
    assert.equal(takeoverPost.status, 403, JSON.stringify(takeoverPost.json));
    assert.equal((await head(agentId))!.version, live.version, "the publisher did not take the steward's D3 head by lowering the ceiling");
    return `${refusals.join("; ")}; head unchanged; publisher at D3: "${d3}", direct POST 403; member test of the D3 draft 403, member read of the publisher's test run 404, member email change 403; steward published D3 version ${live.version.slice(0, 12)}; publisher lowering it to D1: check names D3, direct POST 403, head unchanged`;
  });

  const outside = prereg.outsideDocuments[0]!;
  const asked = prereg.inDocument[0]!;

  await check("check 5: the lab0 KB is authored, compiled, published over its one gap and cited, all in the studio", async () => {
    const def = JSON.parse(readFileSync(join(lab0, "kb.json"), "utf8")) as { kbId: string; title: string; purpose: string; coverageQuestions: string[]; sources: { sourceId: string; location: string; cls: string }[] };
    const author = await signIn("author");
    await fillKb(author, { kbId: def.kbId, title: def.title, purpose: def.purpose, questions: [...def.coverageQuestions, outside.question], sources: def.sources });
    const kbUrl = await saveNew(author, "knowledge-bases");
    const authorCookie = await cookieOf(author);
    for (const location of ["/etc/hosts.md", "../roster.md", "sop/receiving.md"]) {
      const moved = await api(`/knowledge-bases/${kbUrl.split("/").pop()}`, { method: "PATCH", cookie: authorCookie, body: { sources: def.sources.map((s, i) => ({ ...s, kind: "file", licence: "internal-only", location: i === 0 ? location : s.location })) } });
      assert.equal(moved.status, 400, `${location}: ${JSON.stringify(moved.json)}`);
      assert.match(JSON.stringify(moved.json), /file name with no folder/);
    }
    const compiledRequests = compiler.requests;
    const out = await compileInPanel(author, def.sources.map((s) => s.location));
    assert.deepEqual(out.gaps, [outside.question], "the coverage report names exactly the question no document answers");
    assert.ok(out.coverage.includes(outside.question), "the full coverage report lists it too");
    const snapshotRow = await db.query<{ id: SnapshotId }>("select id from kb_snapshots where id like $1", [`${out.snapshot}%`]);
    const snapshotId = snapshotRow.rows[0]!.id;
    const manifest = (await loadManifest(db, store.address, snapshotId))!;
    assert.equal(manifest.cls, "D1");
    const authorPanel = author.getByTestId("kb-panel");
    await authorPanel.getByRole("button", { name: "Publish" }).click();
    assert.match(await authorPanel.getByTestId("kb-error").innerText(), /Authors cannot publish/);

    const publisher = await signIn("publisher");
    await publisher.goto(kbUrl);
    const again = await compileInPanel(publisher, def.sources.map((s) => s.location));
    assert.equal(again.snapshot, out.snapshot, "compiling the same definition and files again gives the same snapshot");
    const panel = publisher.getByTestId("kb-panel");
    await panel.getByRole("button", { name: "Publish" }).click();
    const refused = await panel.getByTestId("kb-error").innerText();
    assert.ok(refused.includes(outside.question), `publish without a note is refused naming the gap: ${refused}`);
    assert.equal(await kbHead(def.kbId), null, "nothing published");
    const note = "The parking question is outside the lab's documents; the agent says so.";
    await panel.locator("#kb-note").fill(note);
    await panel.getByRole("button", { name: "Publish over the gaps" }).click();
    assert.match(await panel.getByTestId("kb-outcome").innerText(), /over 1 gap, with your note/);
    assert.equal(await kbHead(def.kbId), snapshotId);
    const audit = await db.query<{ actor: string; event: { override?: { note: string; gaps: string[] } } }>("select actor, event from audit_events where event->>'t' = 'kb.published' and event->>'kbId' = $1", [def.kbId]);
    assert.deepEqual(audit.rows, [{ actor: people.publisher.email, event: { ...audit.rows[0]!.event, override: { note, gaps: [outside.question] } } }]);
    await publisher.screenshot({ path: join(work, "kb-form.png"), fullPage: true });
    await proofShots(publisher, "kb", ["kb-panel"]);
    await readmeShot(publisher, "studio-kb-coverage", { x: 980, y: 262, width: 420, height: 880 });

    await fillAgent(publisher, {
      agentId: "lab0-helper",
      name: "Lab0 helper",
      description: "Answers practical questions from the lab0 handbook. Use when a lab member asks how the lab handles samples, codes data or trains assistants. Not for anything outside those documents.",
      instructions: "You answer lab members' practical questions from the lab0 handbook. Call kb_search with the member's question and answer from those entries only.",
      endpoint: "local",
      model: "scripted-1",
      knowledgeBases: [def.kbId],
      channels: ["web:lab0"],
      ceiling: "D1",
    });
    await saveNew(publisher, "agents");
    await publishInPanel(publisher, "Lab0 helper on the lab0 handbook KB.");

    const sent = await fetch(`${webBase}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "lab0", thread: "k1", message: "k1m1", text: asked.question, user: "lab-member-7" }) });
    const body = (await sent.json()) as { runId: RunId };
    assert.equal(sent.status, 202, JSON.stringify(body));
    const events = await finished(body.runId);
    const want = manifest.entries[asked.expected];
    assert.ok(want, `${asked.expected} is an entry of the snapshot`);
    const retrieved = events.flatMap((e) => (e.event.t === "tool.completed" ? (e.event.retrieved ?? []) : [])).flatMap((r) => r.entries);
    assert.ok(retrieved.includes(want), `the run retrieved ${asked.expected}`);
    const reply = (await db.query<{ text: string }>("select text from web_messages where run_id = $1 and kind = 'reply'", [body.runId])).rows[0];
    assert.ok(reply?.text.includes(asked.expected), `the answer cites ${asked.expected}: ${reply?.text}`);
    return `author saved the definition (${def.coverageQuestions.length + 1} questions; an absolute, a parent and a folder location each refused 400, ${def.sources.length} attached files) and compiled ${out.snapshot} (${Object.keys(manifest.entries).length} entries, D1, ${compiler.requests - compiledRequests} compiler requests); gap named: "${outside.question}"; author refused; publish without a note refused naming it; publisher published over it with a note (audit kb.published with the override); ${asked.id} through the web door retrieved and cited ${asked.expected}`;
  });

  await check("check 6: a D3 roster KB attached to a hosted agent through the form is refused, and the hosted model receives nothing", async () => {
    const start = hosted.requests;
    const def = JSON.parse(readFileSync(join(lab0, "kb-roster-local.json"), "utf8")) as { kbId: string; title: string; purpose: string; coverageQuestions: string[]; sources: { sourceId: string; location: string; cls: string }[] };
    const steward = await signIn("steward");
    await fillKb(steward, { kbId: def.kbId, title: def.title, purpose: def.purpose, questions: def.coverageQuestions, sources: def.sources });
    const rosterDoc = (await saveNew(steward, "knowledge-bases")).split("/").pop();
    const out = await compileInPanel(steward, def.sources.map((s) => s.location));
    const panel = steward.getByTestId("kb-panel");
    if (out.gaps.length) await panel.locator("#kb-note").fill("The roster KB is attached only to show the class refusal.");
    await panel.getByRole("button", { name: /^Publish/ }).click();
    await panel.getByTestId("kb-outcome").waitFor();
    const rosterHead = await kbHead(def.kbId);
    assert.ok(rosterHead, "the steward published the roster");
    const rosterJob = (await db.query<{ id: string }>("select id from jobs where kind = 'kb-compile' and key like $1", [`kb-compile:${def.kbId}:%`])).rows[0]!.id;
    const authorLogin = await api("/users/login", { method: "POST", body: people.author });
    const authorRead = await api(`/knowledge-bases/compiles/${rosterJob}`, { cookie: authorLogin.cookie });
    assert.equal(authorRead.status, 403, `an author cannot read a D3 compile: ${JSON.stringify(authorRead.json)}`);
    const missing = await api(`/knowledge-bases/compiles/00000000-0000-0000-0000-000000000000`, { cookie: authorLogin.cookie });
    assert.equal(missing.status, 404);
    const publisherLogin = await api("/users/login", { method: "POST", body: people.publisher });
    const publisherKb = await api(`/knowledge-bases/${rosterDoc}/publish`, { method: "POST", cookie: publisherLogin.cookie, body: { snapshot: rosterHead, note: "publisher try" } });
    assert.equal(publisherKb.status, 403, `a publisher cannot publish a D3 snapshot: ${JSON.stringify(publisherKb.json)}`);
    assert.match(String(publisherKb.json.error), /Publishing at D3 needs the data steward or the PI/);
    assert.equal((await loadManifest(db, store.address, rosterHead))!.cls, "D3");

    const author = await signIn("author");
    await fillAgent(author, {
      agentId: "roster-hosted",
      name: "Roster helper",
      description: "Answers the study coordinator's roster questions. Use when the coordinator asks who is enrolled. Not for lab members.",
      instructions: "You answer the study coordinator's questions from the roster. Call kb_search first.",
      endpoint: "hosted",
      model: "hosted-2",
      knowledgeBases: [def.kbId],
      channels: ["web:roster"],
      ceiling: "D1",
    });
    await saveNew(author, "agents");
    const listed = await runChecks(author);
    assert.match(listed, /knowledge base lab0-roster is D3, above the agent ceiling D1/);
    const thread = author.getByTestId("test-thread");
    await thread.getByLabel("Test message").fill("Which participants completed wave 1?");
    await thread.getByRole("button", { name: "Send" }).click();
    const refusal = await thread.getByTestId("test-turn").getByRole("alert").innerText();
    assert.match(refusal, /knowledge base lab0-roster is D3, above the agent ceiling D1/);
    assert.equal(await head("roster-hosted"), undefined);
    assert.equal(hosted.requests, start, "the hosted model received nothing");

    await fillAgent(author, {
      agentId: "hosted-helper",
      name: "Hosted helper",
      description: "Answers short questions about lab routine. Use when a lab member asks about meetings or schedules. Not for participant data.",
      instructions: "You answer short questions about lab routine.",
      endpoint: "hosted",
      model: "hosted-2",
      knowledgeBases: ["lab0-handbook"],
      channels: [],
      ceiling: "D1",
    });
    const hostedDoc = (await saveNew(author, "agents")).split("/").pop();
    const authorCookie = await cookieOf(author);
    async function testRun(text: string): Promise<{ outcome: string; modelRequested: boolean }> {
      const sent = await api(`/agents/${hostedDoc}/test`, { method: "POST", cookie: authorCookie, body: { text } });
      assert.equal(sent.json.t, "enqueued", JSON.stringify(sent.json));
      const events = await finished(sent.json.runId as RunId);
      const end = events.find((e) => e.event.t === "run.finished")!.event;
      return { outcome: end.t === "run.finished" ? end.outcome : "", modelRequested: events.some((e) => e.event.t === "model.requested") };
    }
    const leak = await testRun(prereg.restricted.message);
    assert.deepEqual(leak, { outcome: "refused", modelRequested: false }, "the roster-id message reached the worker and was refused there");
    assert.equal(hosted.requests, start, "the hosted model received nothing from the roster-id test");
    const control = await testRun(prereg.restricted.control);
    assert.equal(control.outcome, "answered");
    assert.ok(hosted.requests > start, "a D1 test message to the same endpoint does reach it, so the counter can move");
    return `steward compiled and published the roster (D3${out.gaps.length ? `, over ${out.gaps.length} gaps with a note` : ""}); author read of that compile 403, missing compile 404, publisher publish of the D3 snapshot 403; hosted agent saved, checks and test thread refused: "${refusal.slice(0, 90)}"; D1 hosted agent: roster-id test run refused in the worker with no model.requested, hosted requests ${start} -> ${start}; control answered, hosted requests -> ${hosted.requests}`;
  });
} finally {
  await browser?.close();
  await ps.stopAll();
  await Promise.all([agentModel.close(), compiler.close(), hosted.close()]);
  await db.end();
}

const failed = results.filter((r) => !r.ok);
const left = leftovers();
console.log(`\n${results.length - failed.length}/${results.length} checks passed; processes left after stop: ${left}`);
process.exit(failed.length || left || results.length !== 6 ? 1 : 0);
