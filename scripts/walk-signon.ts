#!/usr/bin/env node
/**
 * pnpm walk:signon: two members and a PI sign in to the web door through a local OpenID Connect provider and use it
 * the way a lab would. Member A signs in, asks, gets a cited answer, opens the cited entry, opens the record and sees
 * its chain verified. Member B signs in and sees only B's runs, and A's record is a 404 to B. A user named in the
 * message body is ignored. The PI sees every run. A D3 entry's Source chip tells member A who can open it.
 *
 * The provider is shaped like CILogon: each run records the member's eppn (id_claim), and the PI's role comes from
 * the provider's lab0:pi group (roles_claim), with no studio account; the two members have studio accounts.
 *
 * Everything runs here: Postgres (LABH_TEST_DB_SUFFIX keeps it apart), the sealed web door and worker, the scripted
 * model (test/fake-model.ts) and the provider (test/fake-oidc.ts). No API key, nothing beyond loopback. The knowledge
 * bases are lab0's documents, one entry per section, the handbook at D1, and the roster at D3 with one entry per participant.
 *
 *   node scripts/walk-signon.ts [--stills <dir>]
 *
 * --stills saves the sign-in page, the provider's picker, the chat with an answer, the opened entry and one member's
 * runs, light and dark, 1440 and 390 wide, with Playwright's headless Chromium (or LABH_CHROMIUM).
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { StoredEvent } from "../packages/core/src/record.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { freshDatabase } from "../test/db.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { Browser, seedStudioAccounts, startFakeOidc } from "../test/fake-oidc.ts";
import { ensurePostgres, processes, waitFor, waitLine } from "./procs.ts";

const { values } = parseArgs({ options: { stills: { type: "string" } } });
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".walk-signon");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const A = "ada@lab0.example.edu";
const B = "ben@lab0.example.edu";
const PI = "pat.pi@lab0.example.edu";
// eduPersonPrincipalName: what each run records as the member, an id that outlives a changed email.
const EPPN = { [A]: "ada7@campus.example.edu", [B]: "ben2@campus.example.edu", [PI]: "pat1@campus.example.edu" } as const;

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * lab0's documents as fixture snapshots: one entry per "## " section, the way lab0's compile fake splits them, or for
 * the roster one entry per participant, so each participant is found on their own.
 */
function kbFixture(kbId: string, title: string, cls: string, files: readonly string[], perLine = false): string {
  const entries = files.flatMap((file) => {
    const text = readFileSync(join(root, "fixtures/lab0", file), "utf8");
    return text
      .split(/^## /m)
      .slice(1)
      .flatMap((section) => {
        const [heading, ...body] = section.split("\n");
        if (!perLine) return [{ path: `${file}#${slug(heading!)}`, title: heading!.trim(), body: body.join("\n").trim() }];
        return body.filter((l) => l.trim()).map((line) => ({ path: `${file}#${slug(line.split(" ")[0]!)}`, title: line.split(" ")[0]!, body: line.trim() }));
      });
  });
  const path = join(work, `kb-${kbId}.json`);
  writeFileSync(path, JSON.stringify({ kbId, title, purpose: `${title} for the sign-on walk`, cls, entries }, null, 2));
  return path;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const results: { name: string; ok: boolean }[] = [];
async function step(name: string, fn: () => Promise<string[]>): Promise<void> {
  console.log(`\n${results.length + 1}. ${name}`);
  try {
    for (const line of await fn()) console.log(`   ${line}`);
    results.push({ name, ok: true });
    console.log(`   PASS`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`   FAIL ${err instanceof Error ? err.message : String(err)}`);
  }
}
function expect(ok: unknown, what: string): void {
  if (!ok) throw new Error(what);
}

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_walk_signon");
await seedStudioAccounts(db, [
  { email: A, role: "member" },
  { email: B, role: "member" },
]);
const clientSecret = randomBytes(24).toString("hex");
const idp = await startFakeOidc({ clientId: "aliquot-lab0", clientSecret, people: [
    { email: A, name: "Ada (member)", eppn: EPPN[A], groups: ["campus:students"] },
    { email: B, name: "Ben (member)", eppn: EPPN[B], groups: ["campus:students"] },
    { email: PI, name: "Pat (PI)", eppn: EPPN[PI], groups: ["campus:faculty", "lab0:pi"] },
  ],
});
const model = await startFakeModel("scripted-1", "cite");

const handbook = kbFixture("lab0-handbook", "Lab0 handbook", "D1", ["sop-freezer.md", "codebook-sleep-diary.md", "onboarding-ra.md"]);
const roster = kbFixture("lab0-roster", "Participant roster", "D3", ["roster.md"], true);
const baseAgent = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
writeFileSync(
  join(work, "agent.json"),
  JSON.stringify({ ...baseAgent, agentId: "lab0-handbook", name: "Lab0 handbook", knowledgeBases: ["lab0-handbook", "lab0-roster"], irbProtocol: "IRB-2026-0000 (synthetic)", sampleQuestions: [] }, null, 2),
);
const port = await freePort();
const door = `http://127.0.0.1:${port}`;
const config = (auth: boolean) => `[database]
url_env = "DATABASE_URL"
[store]
placement = "lab"
key_env = "LABH_PAYLOAD_KEY"
[endpoints.local]
base_url = "${model.url}"
placement = "lab"
[agents]
fixtures = ["agent.json"]
[knowledge_bases]
fixtures = ["${handbook}", "${roster}"]
[lab]
name = "Lab0"
[surfaces.web]
placement = "lab"
port = ${port}
base_url = "${door}"
${auth ? `[auth]\nissuer = "${idp.issuer}"\nclient_id = "aliquot-lab0"\nclient_secret_env = "WALK_OIDC_SECRET"\nsession_secret_env = "LABH_SESSION_SECRET"\nid_claim = "eppn"\nscopes = ["openid", "email", "profile", "org.cilogon.userinfo"]\nidle_timeout_minutes = 30\nroles_claim = "isMemberOf"\n[auth.roles]\n"lab0:pi" = "pi"\n` : ""}`;
writeFileSync(join(work, "lab.toml"), config(true));
writeFileSync(join(work, "lab-no-auth.toml"), config(false));

const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: randomBytes(32).toString("hex"), LABH_SESSION_SECRET: randomBytes(32).toString("hex"), WALK_OIDC_SECRET: clientSecret };
const ps = processes(root, work, env);
const web = ps.start("web", "web.ts", ["--config", join(work, "lab.toml")]);
await waitLine(web, /listening on http:\/\/127\.0\.0\.1:\d+/, 20_000);
ps.startWorker(join(work, "lab.toml"), "walk");

const json = async (b: Browser, path: string) => (await b.fetch(`${door}${path}`)).json() as Promise<unknown>;
let n = 0;
async function ask(b: Browser, text: string, user?: string): Promise<{ runId: string; reply: string; events: StoredEvent[] }> {
  const res = await b.fetch(`${door}/message`, { method: "POST", headers: { "content-type": "application/json", origin: door }, body: JSON.stringify({ thread: `walk-${n}`, message: `walk-${n++}`, text, ...(user ? { user } : {}) }) });
  const body = (await res.json()) as { t: string; runId?: string; userFacing?: string };
  expect(body.t === "enqueued", `the door did not take the question: ${JSON.stringify(body)}`);
  const runId = body.runId!;
  const events = await waitFor(
    "the answer",
    async () => {
      const ev = (await json(b, `/runs/${runId}/events`)) as StoredEvent[];
      return ev.some((e) => e.event.t === "run.finished") ? ev : null;
    },
    30_000,
  );
  const replies = (await json(b, `/replies?runId=${runId}`)) as { kind: string; text: string }[];
  return { runId, reply: replies.find((r) => r.kind === "reply")?.text ?? "", events };
}
const sourceOf = (reply: string) => /\n\s*Source:\s*(.+)\s*$/.exec(reply)?.[1]?.trim() ?? null;

const ada = new Browser();
const ben = new Browser();
const pat = new Browser();
let adaRun = "";
let benRun = "";
let restrictedRun = "";

await step("Member A opens the door and is asked to sign in", async () => {
  const res = await fetch(`${door}/`);
  const html = await res.text();
  expect(res.status === 401 && html.includes("Sign in to ask the lab"), `expected the sign-in page, got ${res.status}`);
  expect(html.includes(new URL(idp.issuer).host), "the page names the provider");
  return [`GET / without a session: ${res.status}, "Sign in to ask the lab", sign in at ${new URL(idp.issuer).host}`];
});

await step("Member A signs in at the provider and lands on the chat as themself", async () => {
  const { res, hops } = await ada.signIn(door, A);
  const page = await res.text();
  expect(res.status === 200 && page.includes(`const user = "${EPPN[A]}";`) && page.includes(`const shown = "${A}";`), `expected the chat page as ${A}, got ${res.status}`);
  expect(ada.cookies.has("aliquot_session"), "a session cookie");
  return [`${hops.map((h) => new URL(h).pathname).join(" -> ")}`, `signed in as ${A} (member id ${EPPN[A]}); the code was exchanged with a PKCE verifier (${idp.log.at(-1)})`];
});

await step("Member A asks and gets a cited answer", async () => {
  const q = "What do I do when the freezer alarm sounds?";
  const r = await ask(ada, q);
  adaRun = r.runId;
  const source = sourceOf(r.reply);
  expect(source === "sop-freezer.md#freezer-alarm", `expected Source: sop-freezer.md#freezer-alarm, got ${source}`);
  return [`Q: ${q}`, `A: ${r.reply.split("\n")[0]}`, `Source: ${source}`, `run ${adaRun}`];
});

await step("Member A clicks Source and reads the entry", async () => {
  const path = encodeURIComponent("sop-freezer.md#freezer-alarm");
  const chip = (await json(ada, `/runs/${adaRun}/source.json?path=${path}`)) as { open: boolean; title: string; cls: string; retrieved: boolean };
  expect(chip.open && chip.retrieved, `the chip opens a retrieved entry: ${JSON.stringify(chip)}`);
  const page = await ada.fetch(`${door}/runs/${adaRun}/source?path=${path}`);
  const html = await page.text();
  expect(page.status === 200 && html.includes(`<h1>${chip.title}</h1>`) && html.includes("Retrieved by this run"), `expected the entry page, got ${page.status}`);
  return [`chip: "${chip.title}" (${chip.cls}), opens`, `entry page: ${page.status}, "${chip.title}", "Retrieved by this run: the record holds this entry's hash"`];
});

await step("Member A opens the record and sees the chain verified", async () => {
  const view = (await json(ada, `/runs/${adaRun}/view`)) as { outcome: string; chain: { events: number; firstBad: number | null }; rows: { t: string; detail: string }[] };
  expect(view.chain.firstBad === null && view.chain.events > 0, `chain: ${JSON.stringify(view.chain)}`);
  const asked = view.rows.find((r) => r.t === "run.started")?.detail ?? "";
  expect(asked.includes(`from ${EPPN[A]}`), `run.started says "${asked}"`);
  const page = await ada.fetch(`${door}/runs/${adaRun}`);
  expect(page.status === 200, `record page ${page.status}`);
  return [`record page ${page.status}; outcome ${view.outcome}; Verified: chain intact over ${view.chain.events} events`, `run.started: "${asked}"`];
});

await step("Member B signs in, asks, and sees only B's runs", async () => {
  await ben.signIn(door, B);
  const r = await ask(ben, "When is the lab meeting?");
  benRun = r.runId;
  const list = await (await ben.fetch(`${door}/runs`)).text();
  expect(list.includes("Your runs") && list.includes(benRun), "B's runs page lists B's run");
  expect(!list.includes(adaRun), "and not A's");
  return [`B asked "When is the lab meeting?", Source: ${sourceOf(r.reply)}`, `B's /runs: "Your runs", lists ${benRun.slice(0, 8)}, not A's ${adaRun.slice(0, 8)}`];
});

await step("A's record id gives member B a 404", async () => {
  const lines: string[] = [];
  for (const path of [`/runs/${adaRun}`, `/runs/${adaRun}/events`, `/runs/${adaRun}/view`, `/runs/${adaRun}/source?path=x`, `/replies?runId=${adaRun}`]) {
    const res = await ben.fetch(`${door}${path}`);
    expect(res.status === 404, `${path} answered ${res.status}`);
    lines.push(`${path.replace(adaRun, "<A's run>")}: 404`);
  }
  return lines;
});

await step("A user named in the message body is ignored", async () => {
  const r = await ask(ben, "How long are samples kept?", A);
  const started = r.events.find((e) => e.event.t === "run.started")!.event as { trigger: { memberId: string } };
  expect(started.trigger.memberId === EPPN[B], `the run is recorded under ${started.trigger.memberId}`);
  const adaList = await (await ada.fetch(`${door}/runs`)).text();
  expect(!adaList.includes(r.runId), "the spoofed run is not in A's list");
  return [`B posted with "user": "${A}"; the record's run.started names ${started.trigger.memberId}`, "A's runs list does not show it"];
});

await step("Member A asks about the roster; the D3 entry's Source chip says who can open it", async () => {
  const r = await ask(ada, "Has LAB0-0004 withdrawn?");
  restrictedRun = r.runId;
  const source = sourceOf(r.reply);
  expect(source === "roster.md#lab0-0004", `expected Source: roster.md#lab0-0004, got ${source}`);
  const path = encodeURIComponent(source!);
  const chip = (await json(ada, `/runs/${restrictedRun}/source.json?path=${path}`)) as { open: boolean; cls: string; who: string };
  expect(!chip.open && chip.cls === "D3" && chip.who === "the data steward or the PI", `chip: ${JSON.stringify(chip)}`);
  const page = await ada.fetch(`${door}/runs/${restrictedRun}/source?path=${path}`);
  const html = await page.text();
  expect(page.status === 403 && html.includes("the data steward or the PI can") && !html.includes("withdrawn 2026-10-01"), `entry page ${page.status}`);
  return [`Source: ${source}`, `chip: "${chip.cls}: The data steward or the PI can open this entry."`, `entry page for A: 403, no roster text`];
});

await step("The PI signs in with the provider's lab0:pi group, sees every member's runs, and may open the D3 entry", async () => {
  await pat.signIn(door, PI);
  const list = await (await pat.fetch(`${door}/runs`)).text();
  expect(list.includes("<h1>Runs</h1>") && list.includes(adaRun) && list.includes(benRun), "the PI's list has A's and B's runs");
  const page = await pat.fetch(`${door}/runs/${restrictedRun}/source?path=${encodeURIComponent("roster.md#lab0-0004")}`);
  expect(page.status === 200 && (await page.text()).includes("withdrawn 2026-10-01"), `PI entry page ${page.status}`);
  const accounts = await db.query("select 1 from studio.users where lower(email) = lower($1)", [PI]);
  expect(accounts.rowCount === 0, "the PI has no studio account: the role came from the group claim");
  return [`PI has no studio account; isMemberOf lab0:pi makes them the PI`, `PI's /runs: "Runs", lists A's ${adaRun.slice(0, 8)} and B's ${benRun.slice(0, 8)}`, "PI opens roster.md#lab0-0004: 200"];
});

await step("Without [auth], the door refuses to listen beyond this machine", async () => {
  const r = spawnSync(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/web.ts", "--config", join(work, "lab-no-auth.toml"), "--host", "0.0.0.0"], { cwd: root, encoding: "utf8", env: { ...env, NODE_NO_WARNINGS: "1" }, timeout: 30_000 });
  expect(r.status === 2 && r.stderr.includes("reaches beyond this machine, which needs [auth]"), `exit ${r.status}: ${r.stderr}`);
  return [`web.ts --host 0.0.0.0 without [auth]: exit ${r.status}, "${r.stderr.trim()}"`];
});

if (values.stills) {
  const dir = resolve(values.stills);
  mkdirSync(dir, { recursive: true });
  await step("Stills: sign-in, provider, chat with answer, the opened entry, one member's runs", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch(process.env.LABH_CHROMIUM ? { executablePath: process.env.LABH_CHROMIUM } : {});
    const saved: string[] = [];
    try {
      for (const [w, h] of [[1440, 900], [390, 844]] as const)
        for (const scheme of ["light", "dark"] as const) {
          const tag = `${w}-${scheme}`;
          const fresh = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 2 });
          const p = await fresh.newPage();
          await p.goto(`${door}/`);
          await p.screenshot({ path: join(dir, `signin-${tag}.png`) });
          await p.click("a.btn.go");
          await p.waitForURL(/\/authorize/);
          await p.screenshot({ path: join(dir, `provider-${tag}.png`) });
          await p.click(`a.person:has-text("${A}")`);
          await p.waitForSelector("#text");
          await p.fill("#text", "What do I do when the freezer alarm sounds?");
          await p.keyboard.press("Enter");
          await p.waitForSelector(".cite a.doc", { timeout: 30_000 });
          await p.waitForTimeout(400);
          await p.screenshot({ path: join(dir, `chat-answer-${tag}.png`) });
          await p.click(".cite a.doc");
          await p.waitForSelector("article.entry");
          await p.screenshot({ path: join(dir, `source-entry-${tag}.png`) });
          await p.goto(`${door}/runs`);
          await p.screenshot({ path: join(dir, `runs-member-${tag}.png`) });
          await fresh.close();
          saved.push(...["signin", "provider", "chat-answer", "source-entry", "runs-member"].map((s) => `${s}-${tag}.png`));
        }
    } finally {
      await browser.close();
    }
    return [`${saved.length} stills in ${dir}`];
  });
}

await ps.stopAll();
await idp.stop();
await model.close();
await db.end();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} steps passed${failed.length ? `; failed: ${failed.map((f) => f.name).join("; ")}` : ""}`);
console.log(failed.length ? "FAIL" : "PASS");
process.exit(failed.length ? 1 : 0);
