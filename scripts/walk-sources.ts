#!/usr/bin/env node
/**
 * pnpm walk:sources: the source layer, walked end to end on a synthetic lab.
 *
 *   1. A Box sync folder (a plain folder here) holds the freezer SOP; a fake Google Drive holds a lab-wide
 *      onboarding Doc and a cryostat protocol shared only with the cryo group.
 *   2. `kb sync --watch` ingests both into one knowledge base and keeps watching.
 *   3. A member asks about the freezer alarm: the answer quotes the SOP, and the record cites the SOP's version.
 *   4. Someone edits the SOP in the sync folder. The watcher publishes a new snapshot without anyone running a command.
 *   5. The first answer's sources now say "changed since this answer", and the same question gets the new text,
 *      citing the new version.
 *   6. Scope: a member outside the cryo group asks about the cryostat and gets nothing from it; a cryo member gets it.
 *
 * Real Postgres, web door, worker and kb processes; scripted fakes for the model and Drive.
 *
 *   node scripts/walk-sources.ts
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import { createPayloadStore, loadEvents, oneKey, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import type { SourceStatus } from "../packages/core/src/record-view.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { GOOGLE_DOC, startFakeDrive } from "./fake-drive.ts";
import { ensurePostgres, get, post, processes, waitFor, waitLine } from "./procs.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".walk-sources");
rmSync(work, { recursive: true, force: true });
const box = join(work, "Box", "Lab SOPs");
mkdirSync(box, { recursive: true });

const SOP = "# Freezer alarm\n\nWhen the -80 freezer alarm sounds, the on-call member answers it within 15 minutes and moves samples to the backup freezer in room 214.\n";
const SOP_EDITED = SOP.replace("within 15 minutes", "within 10 minutes").replace("room 214", "room 216");
writeFileSync(join(box, "Freezer alarm.md"), SOP);

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_walk_sources");
const model = await startFakeModel("scripted-1", "cite");
const drive = await startFakeDrive();
drive.put({ id: "doc-onboarding", name: "Onboarding", mimeType: GOOGLE_DOC, parent: "lab-folder", content: "# Onboarding\n\nNew members get a key card from the lab manager on their first day.\n", permissions: [{ type: "domain", role: "reader", domain: "lab0.example" }] });
drive.put({ id: "doc-cryostat", name: "Cryostat protocol", mimeType: GOOGLE_DOC, parent: "lab-folder", content: "# Cryostat protocol\n\nThe cryostat is defrosted every Friday at 4 pm by the cryo group only.\n", permissions: [{ type: "group", role: "reader", emailAddress: "cryo@lab0.example" }] });

const payloadKey = randomBytes(32).toString("hex");
const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: payloadKey, LAB_DRIVE_TOKEN: drive.token };
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, keyring: oneKey(Buffer.from(payloadKey, "hex")) });

const base = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
const agentPath = join(work, "agent.json");
writeFileSync(agentPath, JSON.stringify({ ...base, agentId: "lab-docs", name: "Lab documents", knowledgeBases: ["lab-docs"], instructions: "Answer from the lab's documents. Call kb_search, kb_read the best entry, and end with a Source: line naming its path." }, null, 2));
const cfg = join(work, "lab.toml");
writeFileSync(
  cfg,
  [
    "[endpoints.local]",
    `base_url = "${model.url}"`,
    'placement = "lab"',
    "[surfaces.web]",
    'placement = "lab"',
    "port = 0",
    // The fake Drive is on loopback, which this lab places at lab; a real lab places www.googleapis.com.
    "[hosts]",
    '"127.0.0.1" = "lab"',
    "[agents]",
    `fixtures = ["${agentPath}"]`,
    "[sources.box-sops]",
    'kind = "folder"',
    `path = "${box}"`,
    'kb = "lab-docs"',
    'class = "D1"',
    'scope = ["lab"]',
    "[sources.lab-drive]",
    'kind = "gdrive"',
    'folder_id = "lab-folder"',
    'token_env = "LAB_DRIVE_TOKEN"',
    `base_url = "${drive.url}"`,
    'kb = "lab-docs"',
    'class = "D1"',
    "poll_seconds = 5",
    "[directory.groups]",
    'cryo = ["ana"]',
    "[directory.emails]",
    '"cryo@lab0.example" = "group:cryo"',
    "",
  ].join("\n"),
);

const ps = processes(root, work, env);
const say = (line: string) => console.log(line);
const runs: RunId[] = [];
let n = 0;

async function ask(base: string, user: string, text: string): Promise<{ runId: RunId; events: StoredEvent[]; answer: string }> {
  const sent = await post(base, "/message", { thread: `walk-${n}`, message: `walk-${n++}`, text, user });
  assert.equal(sent.status, 202, JSON.stringify(sent.json));
  const runId = sent.json.runId as RunId;
  runs.push(runId);
  const events = await waitFor(`answer to "${text}"`, async () => {
    const es = await loadEvents(db, runId);
    return es.some((e) => e.event.t === "run.finished") ? es : null;
  }, 20_000);
  const f = events.find((e) => e.event.t === "run.finished")!.event;
  const body = f.t === "run.finished" && f.answer ? await store.get(f.answer) : null;
  return { runId, events, answer: body && !("redacted" in body) ? String(body.value) : "" };
}
const sourcesOf = async (base: string, runId: RunId) => JSON.parse((await get(`${base}/runs/${runId}/sources`)).text) as SourceStatus[];
const versionLine = (v: SourceStatus) => `${v.source}:${v.location} version ${v.version.slice(0, 12)} (${v.state})`;

let ok = false;
try {
  say("1. The lab registers a Box sync folder and a Google Drive folder as sources of one knowledge base, lab-docs.");
  const sync = ps.start("sync", "kb.ts", ["sync", "--watch", "--config", cfg]);
  await waitLine(sync, /watching 2 sources/, 20_000);
  say(`   kb sync --watch: ${sync.out.join("").trim().split("\n").filter((l) => l.startsWith("kb ")).join(" | ")}`);
  const { base } = await ps.startWeb(cfg);
  ps.startWorker(cfg, "w1");

  say("\n2. ana asks about the freezer alarm.");
  const first = await ask(base, "ana", "What do I do when the freezer alarm sounds?");
  say(`   answer: ${first.answer.replace(/\s+/g, " ")}`);
  const cited1 = (await sourcesOf(base, first.runId))[0];
  assert.ok(cited1 && cited1.location === "Freezer alarm.md" && cited1.state === "current", JSON.stringify(cited1));
  assert.match(first.answer, /15 minutes/);
  say(`   the record cites ${versionLine(cited1)}, edited ${cited1.modifiedAt}`);

  say("\n3. Someone edits the SOP in the Box folder: 15 minutes becomes 10, room 214 becomes 216. Nobody runs a command.");
  const before = sync.out.join("").length;
  writeFileSync(join(box, "Freezer alarm.md"), SOP_EDITED);
  await waitFor("the watcher to publish the edit", async () => (sync.out.join("").slice(before).match(/kb lab-docs: published .*changed box-sops\/freezer-alarm\.md/) ? true : null), 15_000);
  say(`   watcher: ${sync.out.join("").slice(before).trim().split("\n").at(-1)}`);

  say("\n4. ana's first answer, read again, now says its source changed.");
  const recheck = (await sourcesOf(base, first.runId))[0]!;
  assert.equal(recheck.state, "changed");
  assert.equal(recheck.version, cited1.version, "the record still cites the version the answer read");
  say(`   ${versionLine(recheck)}; now version ${recheck.now!.version.slice(0, 12)}, edited ${recheck.now!.modifiedAt}`);
  say('   the chat shows: "Changed since this answer: Freezer alarm.md was edited ... Ask again to get an answer from the current version."');

  say("\n5. ana asks again and gets the new SOP, cited by its new version.");
  const second = await ask(base, "ana", "What do I do when the freezer alarm sounds?");
  say(`   answer: ${second.answer.replace(/\s+/g, " ")}`);
  assert.match(second.answer, /10 minutes/);
  const cited2 = (await sourcesOf(base, second.runId))[0]!;
  assert.equal(cited2.state, "current");
  assert.notEqual(cited2.version, cited1.version);
  say(`   the record cites ${versionLine(cited2)}`);

  say("\n6. Scope from Drive permissions: the cryostat protocol is shared with cryo@lab0.example only.");
  const outsider = await ask(base, "ben", "When is the cryostat defrosted?");
  const outsiderSources = await sourcesOf(base, outsider.runId);
  assert.ok(!/Friday|cryostat-protocol/i.test(outsider.answer), outsider.answer);
  assert.ok(!outsiderSources.some((s) => s.location === "Cryostat protocol"));
  say(`   ben (not in cryo): ${outsider.answer.replace(/\s+/g, " ")}`);
  const insider = await ask(base, "ana", "When is the cryostat defrosted?");
  assert.match(insider.answer, /every Friday/);
  say(`   ana (cryo): ${insider.answer.replace(/\s+/g, " ")}`);
  say(`   ana's record cites ${versionLine((await sourcesOf(base, insider.runId))[0]!)}`);

  say(`\nrecords: ${runs.map((r) => `${base}/runs/${r}`).join("  ")}`);
  ok = true;
} finally {
  await ps.stopAll();
  await model.close();
  await drive.close();
  await db.end();
}
say(ok ? "\nwalk:sources passed" : "\nwalk:sources FAILED");
if (!ok) process.exitCode = 1;
