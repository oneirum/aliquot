import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LOOP_CONTRACT, type AgentId, type ResolvedAgent } from "../packages/core/src/agent.ts";
import { loadAudit } from "../packages/core/src/audit.ts";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import type { Surface } from "../packages/core/src/frontdoor.ts";
import { createGateway, type ExactModelId } from "../packages/core/src/gateway.ts";
import { buildBm25, createKbReader, memorySnapshots, NO_MEMBER, searchBm25, type Viewer } from "../packages/core/src/kb.ts";
import { drive, type LoopDeps } from "../packages/core/src/loop.ts";
import { directoryFromConfig, viewerFor } from "../packages/core/src/members.ts";
import type { LeasedJob } from "../packages/core/src/queue.ts";
import { createPayloadStore, type RunEvent, type ThreadKey } from "../packages/core/src/record.ts";
import { buildSynced, driveSource, entryPathOf, folderSource, scopeFromPermissions, syncKb, watchSources, type DocumentSource } from "../packages/core/src/sources.ts";
import { builtinTools, createHttpEgress, createToolRunner, registryOf } from "../packages/core/src/tools.ts";
import { FOLDER, GOOGLE_DOC, startFakeDrive } from "../scripts/fake-drive.ts";
import { freshDatabase } from "./db.ts";
import { startFakeModel } from "./fake-model.ts";
import { RUN } from "./events.ts";
import { memoryJournal } from "./recorder.ts";

const { db } = await freshDatabase("labh_test_sources");
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: randomBytes(32), keyId: "k1" });
const root = mkdtempSync(join(tmpdir(), "aliquot-sources-"));
after(async () => {
  await db.end();
  rmSync(root, { recursive: true, force: true });
});

const directory = directoryFromConfig({
  groups: { cryo: ["alice"], admin: ["carol"] },
  emails: { "alice@lab0.example": "alice", "bob@lab0.example": "bob", "cryo@lab0.example": "group:cryo" },
});
const alice = viewerFor({ t: "message", surface: "web", messageId: "m", memberId: "alice" }, directory);
const bob = viewerFor({ t: "message", surface: "web", messageId: "m", memberId: "bob" }, directory);

function folder(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const SOP = "# Freezer SOP\n\nThe -80 freezer alarm is answered within 15 minutes by the on-call member.\n";
const CRYO = "# Cryostat restricted protocol\n\nThe cryostat is defrosted every Friday by the cryo group only.\n";

test("a synced folder becomes one entry per document, each with source, location, version, modifiedAt and scope; lock files and unknown types are left out", async () => {
  const dir = folder("scan", { "sop/Freezer SOP.md": SOP, "notes.txt": "plain notes", "~$Freezer SOP.docx": "lock", ".DS_Store": "x", "photo.jpg": "x" });
  const src = folderSource({ id: "box-sops", kind: "folder", kb: "sops", cls: "D1", licence: "internal-only", path: dir, scope: ["lab"] });
  const scan = await src.scan();
  assert.deepEqual(scan.docs.map((d) => d.location), ["notes.txt", "sop/Freezer SOP.md"]);
  assert.deepEqual(scan.skipped.map((s) => s.location), ["photo.jpg"]);
  const built = buildSynced("sops", [{ source: src, result: scan }], null, store.address, []);
  const p = built.loaded.snapshot.provenance!;
  assert.deepEqual(Object.keys(p), ["box-sops/notes.md", "box-sops/sop/freezer-sop.md"]);
  const sop = p["box-sops/sop/freezer-sop.md"]!;
  assert.equal(sop.source, "box-sops");
  assert.equal(sop.location, "sop/Freezer SOP.md");
  assert.equal(sop.version, store.address("D1", SOP));
  assert.deepEqual(sop.scope, ["lab"]);
  assert.equal(built.loaded.entries.find((e) => e.path === "box-sops/sop/freezer-sop.md")!.title, "Freezer SOP");
  assert.equal(entryPathOf("s", "A Dir/Some File (v2).docx"), "s/a-dir/some-file-v2.md");
});

test("change detection: an edit publishes a new head with the changed entry; a touch with the same text and a second sync of nothing new write nothing", async () => {
  const dir = folder("change", { "sop.md": SOP });
  const src = folderSource({ id: "box", kind: "folder", kb: "change-kb", cls: "D1", licence: "internal-only", path: dir, scope: ["lab"] });
  const deps = { db, store, labPatterns: [], actor: "source-sync" };
  const first = await syncKb(deps, "change-kb", [src]);
  assert.equal(first.t, "published");
  utimesSync(join(dir, "sop.md"), new Date(), new Date(Date.now() + 60_000));
  const touched = await syncKb(deps, "change-kb", [src]);
  assert.deepEqual([touched.t, touched.snapshot], ["unchanged", first.snapshot], "a touch changes no version, so the snapshot id holds");
  writeFileSync(join(dir, "sop.md"), SOP.replace("15 minutes", "10 minutes"));
  const edited = await syncKb(deps, "change-kb", [src]);
  assert.ok(edited.t === "published" && edited.previous === first.snapshot);
  assert.deepEqual(edited.diff && [edited.diff.added, edited.diff.changed, edited.diff.removed], [[], ["box/sop.md"], []]);
  const head = await db.query<{ snapshot: string }>("select snapshot from kb_heads where kb_id = 'change-kb'");
  assert.equal(head.rows[0]!.snapshot, edited.snapshot);
  const audit = (await loadAudit(db)).map((r) => r.event).filter((e) => e.t === "kb.synced" && e.kbId === "change-kb");
  assert.deepEqual(audit.map((e) => e.t === "kb.synced" && [e.added, e.changed, e.removed]), [[1, 0, 0], [0, 1, 0]]);
});

test("watchSources re-ingests a folder on change, without anyone running a command", async () => {
  const dir = folder("watch", { "sop.md": SOP });
  const src = folderSource({ id: "od", kind: "folder", kb: "watch-kb", cls: "D1", licence: "internal-only", path: dir, scope: ["lab"] });
  const lines: string[] = [];
  const w = watchSources({ db, store, labPatterns: [], actor: "source-sync" }, [src], new Map([["od", dir]]), new Map(), (l) => lines.push(l));
  try {
    await w.ready;
    const before = (await db.query<{ snapshot: string }>("select snapshot from kb_heads where kb_id = 'watch-kb'")).rows[0]!.snapshot;
    writeFileSync(join(dir, "sop.md"), SOP.replace("15 minutes", "5 minutes"));
    let after = before;
    for (let i = 0; i < 50 && after === before; i++) {
      await sleep(100);
      after = (await db.query<{ snapshot: string }>("select snapshot from kb_heads where kb_id = 'watch-kb'")).rows[0]!.snapshot;
    }
    assert.notEqual(after, before, `the head moved after the edit; log: ${lines.join(" / ")}`);
    assert.ok(lines.some((l) => l.includes("changed od/sop.md")), lines.join("\n"));
  } finally {
    w.close();
  }
});

test("Drive permissions become entry scope: anyone and domain are the lab, users and groups map through the directory, unknown emails add no one", () => {
  assert.deepEqual(scopeFromPermissions([{ type: "anyone", role: "reader" }], directory), ["lab"]);
  assert.deepEqual(scopeFromPermissions([{ type: "domain", role: "reader", domain: "lab0.example" }], directory), ["lab"]);
  assert.deepEqual(
    scopeFromPermissions([{ type: "user", role: "owner", emailAddress: "Alice@lab0.example" }, { type: "group", role: "reader", emailAddress: "cryo@lab0.example" }, { type: "user", role: "reader", emailAddress: "stranger@gmail.com" }], directory),
    ["group:cryo", "member:alice"],
  );
  assert.deepEqual(scopeFromPermissions([{ type: "user", role: "reader", emailAddress: "stranger@gmail.com" }], directory), []);
});

const driveCfg = (url: string, id = "lab-drive") => ({ id, kind: "gdrive" as const, kb: "drive-kb", cls: "D1" as const, licence: "internal-only" as const, folderId: "root-folder", tokenEnv: "X", baseUrl: url, pollSeconds: 60 });

test("a Drive source lists folders page by page, exports Google Docs, downloads Markdown, skips files no lab member can see, and downloads only what changed", async () => {
  const fd = await startFakeDrive();
  try {
    fd.put({ id: "f-sop", name: "Freezer SOP", mimeType: GOOGLE_DOC, parent: "root-folder", content: SOP, permissions: [{ type: "domain", role: "reader", domain: "lab0.example" }], modifiedTime: "2026-11-06T20:00:00.000Z" });
    fd.put({ id: "f-sub", name: "Cryo", mimeType: FOLDER, parent: "root-folder", content: "", permissions: [] });
    fd.put({ id: "f-cryo", name: "cryostat.md", mimeType: "text/markdown", parent: "f-sub", content: CRYO, permissions: [{ type: "group", role: "reader", emailAddress: "cryo@lab0.example" }] });
    fd.put({ id: "f-private", name: "personal.md", mimeType: "text/markdown", parent: "root-folder", content: "nobody here", permissions: [{ type: "user", role: "owner", emailAddress: "stranger@gmail.com" }] });
    fd.put({ id: "f-sheet", name: "Inventory", mimeType: "application/vnd.google-apps.spreadsheet", parent: "root-folder", content: "", permissions: [{ type: "anyone", role: "reader" }] });
    const http = createHttpEgress({ policy: DEFAULT_POLICY, hosts: { "127.0.0.1": "lab" }, fetchImpl: fetch });
    const src = driveSource(driveCfg(fd.url), { http, db, token: fd.token, directory, labPatterns: [] });
    const scan = await src.scan();
    assert.deepEqual(scan.docs.map((d) => [d.location, d.scope]), [["Cryo/cryostat.md", ["group:cryo"]], ["Freezer SOP", ["lab"]]].sort());
    assert.deepEqual(scan.skipped.map((s) => s.location).sort(), ["Inventory", "personal.md"]);
    assert.equal(scan.docs.find((d) => d.location === "Freezer SOP")!.text, SOP);
    assert.ok(fd.requests.some((r) => r.includes("pageToken=")), "the root folder has more files than one page");
    const downloads = () => fd.requests.filter((r) => r.includes("/export?") || r.includes("alt=media")).length;
    const n = downloads();
    await src.scan();
    assert.equal(downloads(), n, "nothing changed, so nothing is downloaded again");
    fd.edit("f-sop", SOP.replace("15", "20"));
    await src.scan();
    assert.equal(downloads(), n + 1, "only the edited Doc is exported again");
  } finally {
    await fd.close();
  }
});

test("a Drive host lab.toml does not place is public, so the D1 request is refused, audited, and the sync leaves the head alone", async () => {
  const fd = await startFakeDrive();
  try {
    fd.put({ id: "f1", name: "a.md", mimeType: "text/markdown", parent: "root-folder", content: SOP, permissions: [{ type: "anyone", role: "reader" }] });
    const http = createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl: fetch });
    const src = driveSource({ ...driveCfg(fd.url, "public-drive"), kb: "refused-kb" }, { http, db, token: fd.token, directory, labPatterns: [] });
    await assert.rejects(syncKb({ db, store, labPatterns: [], actor: "source-sync" }, "refused-kb", [src]), /egress refused/);
    assert.equal(fd.requests.length, 0, "nothing reached the host");
    const head = await db.query("select 1 from kb_heads where kb_id = 'refused-kb'");
    assert.equal(head.rowCount, 0);
    const refused = (await loadAudit(db)).filter((r) => r.actor === "source:public-drive" && r.event.t === "call");
    assert.equal(refused.length, 1);
  } finally {
    await fd.close();
  }
});

/** One KB with a lab-wide SOP, a cryo-group protocol and a page only carol may see. */
function scopedKb() {
  const docs = (scope: string[], files: [string, string][]): DocumentSource => ({
    id: scope[0]!.replace(/[^a-z]/g, ""),
    kind: "folder",
    kb: "scoped",
    cls: "D1",
    scan: async () => ({ docs: files.map(([location, text]) => ({ location, text, modifiedAt: "2026-11-06T21:00:00.000Z", scope })), skipped: [] }),
  });
  const sources = [docs(["lab"], [["freezer.md", SOP]]), docs(["group:cryo"], [["cryostat.md", CRYO]]), docs(["member:carol"], [["budget.md", "# Budget\n\nThe freezer budget is 9000 dollars.\n"]])];
  return Promise.all(sources.map(async (source) => ({ source, result: await source.scan() })));
}

test("scope at retrieval: outline, search and read return only what the viewer may see; a hidden path reads as missing; a hidden entry moves no score", async () => {
  const built = buildSynced("scoped", await scopedKb(), null, store.address, []);
  const id = built.loaded.snapshot.id;
  const kb = createKbReader(memorySnapshots([built.loaded]));
  const paths = async (v: Viewer) => (await kb.outline(id, v)).value.paths;
  assert.deepEqual(await paths("all"), ["groupcryo/cryostat.md", "lab/freezer.md", "membercarol/budget.md"]);
  assert.deepEqual(await paths(alice), ["groupcryo/cryostat.md", "lab/freezer.md"]);
  assert.deepEqual(await paths(bob), ["lab/freezer.md"]);
  assert.deepEqual(await paths(NO_MEMBER), ["lab/freezer.md"]);
  assert.deepEqual(await paths(viewerFor({ t: "message", surface: "web", messageId: "m", memberId: "carol" }, directory)), ["lab/freezer.md", "membercarol/budget.md"]);

  const bobHits = (await kb.search(id, "freezer cryostat budget", 10, bob)).value;
  assert.deepEqual(bobHits.map((h) => h.path), ["lab/freezer.md"]);
  const alone = searchBm25(buildBm25(built.loaded.entries.filter((e) => e.path === "lab/freezer.md")), "freezer cryostat budget", 10);
  assert.equal(bobHits[0]!.score, alone[0]!.score, "bob's score is what a KB without the hidden entries gives, so no hidden term frequency leaks");
  assert.equal(bobHits[0]!.source?.version, built.loaded.snapshot.provenance!["lab/freezer.md"]!.version);

  const read = (await kb.read(id, ["groupcryo/cryostat.md", "lab/freezer.md"], 15_000, bob)).value;
  assert.deepEqual(read.entries.map((e) => e.path), ["lab/freezer.md"]);
  assert.deepEqual(read.missing, ["groupcryo/cryostat.md"], "hidden and absent read the same, so bob learns nothing about the path");
  assert.deepEqual((await kb.read(id, ["groupcryo/cryostat.md"], 15_000, alice)).value.entries.map((e) => e.path), ["groupcryo/cryostat.md"]);
});

test("on the wire: a member outside a scope never has the entry's path or text reach the model, the reply or the record; a member inside gets it, cited by version", async () => {
  const built = buildSynced("scoped", await scopedKb(), null, store.address, []);
  const snap = built.loaded.snapshot;
  const kb = createKbReader(memorySnapshots([built.loaded]));
  const model = await startFakeModel("scripted-1", "cite");
  try {
    const tools = createToolRunner(registryOf(builtinTools()), { http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl: fetch }), kb });
    const gateway = createGateway([{ id: "local", baseUrl: model.url, placement: "lab", supportsLogprobs: false }], DEFAULT_POLICY, fetch);
    const hash = (name: string) => builtinTools().find((t) => t.manifest.name === name)!.hash;
    const agent: ResolvedAgent = {
      schema: 2,
      agentId: "scoped" as AgentId,
      loopContract: LOOP_CONTRACT,
      instructions: "answer",
      instructionsClass: "D1",
      model: { endpointId: "local", modelId: "scripted-1" as ExactModelId, params: { temperature: 0, maxOutputTokens: 64 } },
      knowledgeBases: [{ kbId: "scoped", snapshot: snap.id, cls: snap.cls }],
      tools: [{ name: "kb_search", hash: hash("kb_search") }, { name: "kb_read", hash: hash("kb_read") }],
      sandbox: null,
      retrieval: { algorithm: "bm25-v1", readCapTokens: 15_000 },
      limits: { maxSteps: 10, maxTokens: 1_000_000, maxWallMs: 600_000 },
    };
    const deployed = { tools: new Map([["kb_search", hash("kb_search")], ["kb_read", hash("kb_read")]]), snapshots: new Set([snap.id]), sandboxImages: new Set<never>(), loopContract: LOOP_CONTRACT, retrieval: new Set(["bm25-v1"]) };
    const ask = async (memberId: string, question: string) => {
      const journal = memoryJournal(RUN);
      const input = await journal.put(Labelled.stamp(question, "D1", "gate:floor"));
      const posts: string[] = [];
      const surface: Surface = { id: "web" as Surface["id"], placement: "lab", startStream: async () => ({ push() {}, close: async () => false }), finalize: async (_r, _t, text) => (posts.push(text), { mode: "final-post", messageId: "1" }), askConfirm: async () => {}, linkTo: () => "" };
      const job: LeasedJob = { id: RUN, kind: "run", key: `k-${memberId}`, thread: "web:lab:t" as ThreadKey, owner: "A", epoch: 1, attempts: 0, payload: { agent: "a".repeat(64), kind: "interactive", trigger: { t: "message", surface: "web", messageId: "m", memberId }, thread: "web:lab:t", surface: "web", threadId: "t", input, history: [], studyId: null } };
      const deps: LoopDeps = { gateway, tools, kb, surfaces: () => surface, policy: DEFAULT_POLICY, loadAgent: async () => agent, deployed: async () => deployed, clock: { now: () => Date.now() }, callSignal: () => ({ signal: new AbortController().signal, release() {} }), log: () => {}, directory };
      const from = model.bodies.length;
      await drive(job, journal, deps);
      const wire = JSON.stringify(model.bodies.slice(from));
      const record = JSON.stringify(journal.log) + JSON.stringify(journal.log.map((e) => ("output" in e && e.output ? journal.body(e.output) : null)));
      return { wire, posts, record, log: journal.log };
    };
    const outsider = await ask("bob", "cryostat defrosted");
    for (const leak of ["cryostat", "Cryostat", "groupcryo", "defrosted every Friday", "budget", "9000"]) {
      assert.ok(!outsider.wire.replace(/cryostat defrosted/g, "").includes(leak), `bob's model requests hold ${leak}`);
      assert.ok(!outsider.posts.join("").replace(/cryostat defrosted/g, "").includes(leak), `bob's reply holds ${leak}`);
      assert.ok(!outsider.record.replace(/cryostat defrosted/g, "").includes(leak), `bob's record holds ${leak}`);
    }
    const insider = await ask("alice", "cryostat defrosted");
    assert.ok(insider.wire.includes("defrosted every Friday"), "alice's model read the cryo protocol");
    assert.match(insider.posts.join(""), /Source: groupcryo\/cryostat\.md/);
    const versions = insider.log.flatMap((e: RunEvent) => (e.t === "tool.completed" ? (e.retrieved ?? []).flatMap((r) => r.versions ?? []) : []));
    assert.ok(versions.some((v) => v.path === "groupcryo/cryostat.md" && v.version === snap.provenance!["groupcryo/cryostat.md"]!.version && v.location === "cryostat.md"), "the record cites the version alice's answer read");
    assert.ok(insider.wire.includes(snap.provenance!["groupcryo/cryostat.md"]!.version.slice(0, 12)), "the model saw the version, so an answer can cite it");
  } finally {
    await model.close();
  }
});

