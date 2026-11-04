import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../packages/core/src/boot.ts";
import { saveSnapshot, snapshotFromFixture } from "../packages/core/src/kb.ts";
import { bootStudio, type Actor, type MemberId, type Role } from "../packages/core/src/studio.ts";
import { studioRoute } from "../packages/core/src/surfaces/studio-door.ts";
import { createWebHandler, doorTokens, listenWeb } from "../packages/core/src/surfaces/web.ts";
import { freshDatabase } from "./db.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "labh-studio-door-"));
const { db, url } = await freshDatabase("labh_test_studio_door");
const hex = () => randomBytes(32).toString("hex");
const STUDIO = hex();
const ACP = hex();
const env = { DATABASE_URL: url, LABH_PAYLOAD_KEY: hex(), LAB_STUDIO_TOKEN: STUDIO, LAB_ACP_TOKEN: ACP };

const configPath = join(work, "lab.toml");
const surfaces = ["[surfaces.web]", 'placement = "lab"', "port = 0", "[surfaces.studio]", 'kind = "studio"', 'placement = "lab"', 'token_env = "LAB_STUDIO_TOKEN"', "[surfaces.acp]", 'kind = "acp"', 'placement = "zdr"', 'token_env = "LAB_ACP_TOKEN"'];
const lab = (extra: readonly string[]) =>
  [
    "[database]",
    'url_env = "DATABASE_URL"',
    "[store]",
    'placement = "lab"',
    'key_env = "LABH_PAYLOAD_KEY"',
    "[endpoints.local]",
    'base_url = "http://127.0.0.1:9/v1"',
    'placement = "lab"',
    ...extra,
    "[policy]",
    "participant_id_patterns = ['\\bP-\\d{5}\\b']",
    "[knowledge_bases]",
    `fixtures = ["${join(root, "fixtures/kb.json")}"]`,
    "",
  ].join("\n");
writeFileSync(configPath, lab(surfaces));

const core = await boot(configPath, env);
const tokens = doorTokens(core.config.surfaces, env, () => {});
const { server, port } = await listenWeb(createWebHandler(core.db, core.intake, () => {}, null, "", tokens, (surface, op, json) => studioRoute(core, surface, op, json)), 0);
const base = `http://127.0.0.1:${port}`;
const studio = await bootStudio(configPath, { LAB_STUDIO_TOKEN: STUDIO, LABH_DOOR_URL: base });
after(async () => {
  server.close();
  await core.close();
  await db.end();
  rmSync(work, { recursive: true, force: true });
});

const as = (role: Role, id = `${role}@lab.example`): Actor => ({ id: id as MemberId, role });
const fixture = (name: string) => JSON.parse(readFileSync(join(root, "fixtures", name), "utf8")) as Record<string, unknown>;
const lab0Files = ["sop-freezer.md", "codebook-sleep-diary.md", "onboarding-ra.md"].map((name) => ({ name, text: readFileSync(join(root, "fixtures/lab0", name), "utf8") }));

async function raw(path: string, token: string | null, body: unknown): Promise<{ status: number; body: { error?: string } }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

test("only the studio's token reaches the /studio routes, and it reaches nothing else", async () => {
  const body = { actor: as("pi"), runId: "00000000-0000-4000-8000-000000000001" };
  assert.deepEqual(await raw("/studio/test-run", null, body), { status: 401, body: { error: "the /studio routes take the [surfaces.studio] token" } });
  assert.deepEqual(await raw("/studio/test-run", ACP, body), { status: 401, body: { error: "the /studio routes take the [surfaces.studio] token" } });
  assert.deepEqual(await raw("/studio/test-run", STUDIO, body), { status: 404, body: { error: "No test run of yours has that id." } });
  assert.deepEqual(await raw("/message", STUDIO, { thread: "t", message: "m", text: "hi", user: "u" }), { status: 403, body: { error: "the studio's token reaches the /studio routes only" } });
  assert.deepEqual(await raw("/studio/no-such-op", STUDIO, body), { status: 404, body: { error: "no studio route no-such-op" } });
  assert.equal((await raw("/studio/test-run", STUDIO, { actor: { id: "x", role: "owner" }, runId: body.runId })).status, 400, "a role the studio does not have is refused");
});

test("a KB compile reads and stores the sources in the door: an author enqueues it, a member cannot, and the text is stored encrypted", async () => {
  const definition = fixture("lab0/kb.json");
  assert.deepEqual(await studio.call("kb-compile", as("member"), { definition, files: lab0Files }), { status: 403, json: { error: "Authors and above compile knowledge bases." } });
  assert.deepEqual(await studio.call("kb-compile", as("author"), { definition, files: lab0Files.slice(1) }), { status: 400, json: { error: "Attach sop-freezer.md to compile." } });
  const before = Number((await db.query<{ n: string }>("select count(*) as n from payloads")).rows[0]!.n);
  const compiled = await studio.call("kb-compile", as("author"), { definition, files: lab0Files });
  assert.equal(compiled.status, 200);
  const { jobId, created } = compiled.json as { jobId: string; created: boolean };
  assert.equal(created, true);
  assert.equal(Number((await db.query<{ n: string }>("select count(*) as n from payloads")).rows[0]!.n), before + 3, "one payload per source");
  const sealed = await db.query<{ hit: boolean }>("select bool_or(position(convert_to($1, 'UTF8') in ciphertext) > 0) as hit from payloads", [lab0Files[0]!.text.slice(0, 40)]);
  assert.equal(sealed.rows[0]!.hit, false, "no source text is stored in the clear");
  assert.deepEqual(await studio.call("kb-compile-result", as("member"), { jobId }), { status: 200, json: { result: null } }, "a D1 compile is readable by any member while it waits for the worker");

  const roster = await studio.call("kb-compile", as("steward"), { definition: fixture("lab0/kb-roster.json"), files: [{ name: "roster.md", text: readFileSync(join(root, "fixtures/lab0/roster.md"), "utf8") }] });
  assert.equal(roster.status, 200);
  const rosterJob = (roster.json as { jobId: string }).jobId;
  assert.deepEqual(await studio.call("kb-compile-result", as("author"), { jobId: rosterJob }), { status: 403, json: { error: "Reading a D3 compile needs the data steward or the PI." } });
  assert.deepEqual(await studio.call("kb-compile-result", as("steward"), { jobId: rosterJob }), { status: 200, json: { result: null } });
  assert.deepEqual(await studio.call("kb-compile-result", as("pi"), { jobId: "00000000-0000-4000-8000-000000000002" }), { status: 404, json: { error: "No compile has that id." } });
});

test("an entry preview is for authors and above and below D3 only: the studio is never shown a D3 entry", async () => {
  const d1 = snapshotFromFixture(fixture("kb.json"), core.store.address);
  const d3 = snapshotFromFixture({ ...fixture("kb.json"), kbId: "restricted", cls: "D3" }, core.store.address);
  for (const s of [d1, d3]) await saveSnapshot(db, core.store, s.snapshot, s.entries);
  const entry = d1.entries.find((e) => e.path === "office-hours.md")!;
  assert.deepEqual(await studio.call("kb-entry", as("author"), { snapshot: d1.snapshot.id, path: "office-hours.md" }), { status: 200, json: { cls: "D1", path: "office-hours.md", title: entry.title, body: entry.body } });
  assert.deepEqual(await studio.call("kb-entry", as("member"), { snapshot: d1.snapshot.id, path: "office-hours.md" }), { status: 403, json: { error: "Authors and above read knowledge base entries in the studio." } });
  for (const role of ["author", "steward", "pi"] as const)
    assert.deepEqual(await studio.call("kb-entry", as(role), { snapshot: d3.snapshot.id, path: "office-hours.md" }), { status: 403, json: { error: "The studio does not show D3 entries." } }, role);
  assert.deepEqual(await studio.call("kb-entry", as("author"), { snapshot: d1.snapshot.id, path: "nope.md" }), { status: 404, json: { error: `Snapshot ${d1.snapshot.id.slice(0, 12)} has no entry nope.md.` } });

  assert.deepEqual(await studio.call("kb-publish", as("member"), { kbId: "handbook", snapshot: d1.snapshot.id }), { status: 403, json: { error: "Members cannot publish. Ask a publisher." } });
  assert.deepEqual(await studio.call("kb-publish", as("publisher"), { kbId: "other", snapshot: d1.snapshot.id }), { status: 404, json: { error: "That snapshot is not a compile of other." } });
  assert.deepEqual(await studio.call("kb-publish", as("publisher"), { kbId: "restricted", snapshot: d3.snapshot.id }), { status: 403, json: { error: "Publishing at D3 needs the data steward or the PI." } });
  assert.deepEqual(await studio.call("kb-publish", as("publisher"), { kbId: "handbook", snapshot: d1.snapshot.id }), { status: 200, json: { ok: true } });
  assert.equal((await db.query<{ snapshot: string }>("select snapshot from kb_heads where kb_id = 'handbook'")).rows[0]?.snapshot, d1.snapshot.id);
});

test("a test draft runs on the studio surface through the door's intake, and only its sender reads it", async () => {
  const draft = { ...fixture("agent.json"), ceiling: "D1" };
  assert.deepEqual(await studio.call("agent-test", as("member"), { draft: { ...draft, ceiling: "D3" }, thread: "studio-a-default", text: "Office hours?" }), { status: 403, json: { error: "Testing an agent at D3 needs the data steward or the PI." } });
  const sent = await studio.call("agent-test", as("member"), { draft, thread: "studio-a-default", text: "Office hours?" });
  assert.equal(sent.status, 200);
  const run = sent.json as { t: string; runId: string };
  assert.equal(run.t, "enqueued");
  const job = await db.query<{ key: string; surface: string }>("select key, payload->>'surface' as surface from jobs where id = $1", [run.runId]);
  assert.equal(job.rows[0]?.surface, "studio");
  assert.match(job.rows[0]!.key, /^test:studio:studio:studio-a-default:/);
  assert.deepEqual(await studio.call("test-run", as("member"), { runId: run.runId }), { status: 200, json: { agent: null, outcome: null, replies: [] } });
  assert.deepEqual(await studio.call("test-run", as("member", "someone-else@lab.example"), { runId: run.runId }), { status: 404, json: { error: "No test run of yours has that id." } });
  assert.deepEqual(await studio.call("test-run", as("member"), { runId: "../x" }), { status: 400, json: { error: "Not a run id." } });

  const check = await studio.call("agent-check", as("publisher"), { draft });
  assert.equal(check.status, 200);
  assert.ok((check.json as { check: { draftHash?: string } }).check.draftHash, "the publish checks ran in the door");
});

test("the studio boots from lab.toml and its token alone, and says what is missing", async () => {
  const bare = join(work, "no-studio.toml");
  writeFileSync(bare, lab(surfaces.slice(0, 3)));
  await assert.rejects(bootStudio(bare, { LAB_STUDIO_TOKEN: STUDIO }), /has no \[surfaces\.studio\]/);
  await assert.rejects(bootStudio(configPath, {}), /^Error: LAB_STUDIO_TOKEN is not set/);
  const down = await bootStudio(configPath, { LAB_STUDIO_TOKEN: STUDIO, LABH_DOOR_URL: "http://127.0.0.1:9" });
  assert.deepEqual(await down.call("test-run", as("pi"), { runId: "00000000-0000-4000-8000-000000000001" }), { status: 503, json: { error: "cannot reach the door at http://127.0.0.1:9. Is the web door running?" } });
  assert.ok(studio.tools.some((t) => t.name === "kb_search"), "the Tools panel's list needs no door");
});
