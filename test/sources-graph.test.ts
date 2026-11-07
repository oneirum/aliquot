import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { loadAudit } from "../packages/core/src/audit.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import { createKbReader, NO_MEMBER, storedSnapshots, type Viewer } from "../packages/core/src/kb.ts";
import { directoryFromConfig, viewerFor } from "../packages/core/src/members.ts";
import { createPayloadStore, oneKey } from "../packages/core/src/record.ts";
import { graphSource, scopeFromGraphPermissions, type GraphPermission, type GraphSourceConfig } from "../packages/core/src/sources-graph.ts";
import { syncKb } from "../packages/core/src/sources.ts";
import type { SnapshotId } from "../packages/core/src/hash.ts";
import { createHttpEgress } from "../packages/core/src/tools.ts";
import { DOCX, PDF, startFakeGraph, type FakeGraph } from "../scripts/fake-graph.ts";
import { freshDatabase } from "./db.ts";
import { FREEZER_SOP_MARKDOWN, freezerSop } from "./docx-fixture.ts";

const { db } = await freshDatabase("labh_test_sources_graph");
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, keyring: oneKey(randomBytes(32)) });
after(() => db.end());

const directory = directoryFromConfig({
  groups: { cryo: ["alice"] },
  emails: { "alice@lab0.example": "alice", "bob@lab0.example": "bob", "cryo@lab0.example": "group:cryo" },
});
const alice = viewerFor({ t: "message", surface: "web", messageId: "m", memberId: "alice" }, directory);
const bob = viewerFor({ t: "message", surface: "web", messageId: "m", memberId: "bob" }, directory);
const SITE_GROUPS = { "Lab SOPs Members": "lab", "Cryo Owners": "group:cryo" };

const ONBOARDING = "# Onboarding\n\nNew members get a key card from the lab manager on their first day.\n";
const CRYO = "# Cryostat protocol\n\nThe cryostat zephyrine wash runs every Friday at 4 pm, cryo group only.\n";

const cfg = (g: FakeGraph, kb: string, extra: Partial<GraphSourceConfig> = {}): GraphSourceConfig => ({ id: "lab-sp", kind: "graph", kb, cls: "D1", licence: "internal-only", driveId: g.driveId, folder: null, tokenEnv: "X", baseUrl: g.url, pollSeconds: 60, siteGroups: SITE_GROUPS, ...extra });
const http = createHttpEgress({ policy: DEFAULT_POLICY, hosts: { "127.0.0.1": "lab" }, fetchImpl: fetch });
const deps = (g: FakeGraph) => ({ http, db, token: g.token, directory, labPatterns: [] });
const sync = { db, store, labPatterns: [], actor: "source-sync" };

/** A SharePoint library as a lab keeps one: shared with the site's members group, one folder only the cryo group may open. */
function library(g: FakeGraph): void {
  g.put({ id: "root", name: "root", folder: true, grants: [{ kind: "siteGroup", name: "Lab SOPs Members" }] });
  g.put({ id: "f-sops", name: "Lab SOPs", folder: true });
  g.put({ id: "i-freezer", name: "Freezer storage.docx", parent: "f-sops", mimeType: DOCX, content: freezerSop(), modified: "2026-11-06T20:00:00Z" });
  g.put({ id: "i-onboard", name: "Onboarding.md", parent: "f-sops", content: ONBOARDING });
  g.put({ id: "f-cryo", name: "Cryo", parent: "f-sops", folder: true, inherits: false, grants: [{ kind: "group", email: "cryo@lab0.example" }] });
  g.put({ id: "i-cryo", name: "Cryostat protocol.md", parent: "f-cryo", content: CRYO });
  g.put({ id: "i-scan", name: "Scanned form.pdf", parent: "f-sops", mimeType: PDF, content: "%PDF-1.4" });
  g.put({ id: "i-private", name: "Personal notes.md", parent: "f-sops", inherits: false, grants: [{ kind: "user", email: "stranger@contoso.example" }], content: "private" });
}

const contentRequests = (g: FakeGraph) => g.requests.filter((r) => r.endsWith("/content")).length;
const permissionRequests = (g: FakeGraph) => g.requests.filter((r) => r.endsWith("/permissions")).length;

test("Graph permissions become entry scope: org and anyone links are the lab, users and groups map through the directory, site groups through site_groups, the rest adds no one", () => {
  const p = (x: Omit<GraphPermission, "id" | "roles">): GraphPermission => ({ id: "p", roles: ["read"], ...x });
  assert.deepEqual(scopeFromGraphPermissions([p({ link: { scope: "organization", type: "view" } })], directory, SITE_GROUPS), ["lab"]);
  assert.deepEqual(scopeFromGraphPermissions([p({ link: { scope: "anonymous", type: "view" } })], directory, SITE_GROUPS), ["lab"]);
  assert.deepEqual(
    scopeFromGraphPermissions(
      [
        p({ grantedToV2: { user: { email: "Alice@lab0.example" } } }),
        p({ grantedToV2: { siteUser: { loginName: "i:0#.f|membership|bob@lab0.example" } } }),
        p({ grantedToV2: { group: { email: "cryo@lab0.example" } } }),
        p({ link: { scope: "users", type: "edit" }, grantedToIdentitiesV2: [{ user: { email: "stranger@contoso.example" } }] }),
        p({ grantedToV2: { siteGroup: { displayName: "Visitors" } } }),
      ],
      directory,
      SITE_GROUPS,
    ),
    ["group:cryo", "member:alice", "member:bob"],
  );
  assert.deepEqual(scopeFromGraphPermissions([p({ grantedToV2: { siteGroup: { displayName: "Cryo Owners" } } })], directory, SITE_GROUPS), ["group:cryo"]);
  assert.deepEqual(scopeFromGraphPermissions([p({ link: { scope: "users", type: "view" }, grantedToIdentitiesV2: [{ user: { email: "stranger@contoso.example" } }] })], directory, SITE_GROUPS), []);
});

test("a SharePoint library through Graph: delta pages, docx through the Word reader, effective permissions to scope, nothing downloaded that no member may see, and no token on the download host", async () => {
  const g = await startFakeGraph();
  try {
    library(g);
    const src = graphSource(cfg(g, "graph-scan"), deps(g));
    const scan = await src.scan();
    assert.deepEqual(scan.docs.map((d) => [d.location, d.scope]), [
      ["Lab SOPs/Cryo/Cryostat protocol.md", ["group:cryo"]],
      ["Lab SOPs/Freezer storage.docx", ["lab"]],
      ["Lab SOPs/Onboarding.md", ["lab"]],
    ]);
    assert.equal(scan.docs.find((d) => d.location.endsWith(".docx"))!.text, FREEZER_SOP_MARKDOWN);
    assert.deepEqual(scan.skipped.map((s) => [s.location, /sandbox/.test(s.why) ? "pdf" : /permissions/.test(s.why) ? "nobody" : s.why]), [["Lab SOPs/Personal notes.md", "nobody"], ["Lab SOPs/Scanned form.pdf", "pdf"]]);
    assert.ok(g.requests.some((r) => r.includes("round=")), "the first delta came in more than one page");
    assert.ok(!g.requests.some((r) => r.includes("i-private/content") || r.includes("i-scan/content")), "the private file and the PDF were never downloaded");
    assert.equal(g.downloadAuth.length, 3);
    assert.ok(g.downloadAuth.every((a) => a === undefined), "the bearer token never reached the download host");
    assert.equal(scan.docs.find((d) => d.location === "Lab SOPs/Freezer storage.docx")!.modifiedAt, "2026-11-06T20:00:00.000Z");

    const inFolder = await graphSource(cfg(g, "graph-scan", { folder: "Lab SOPs/Cryo" }), deps(g)).scan();
    assert.deepEqual(inFolder.docs.map((d) => d.location), ["Cryostat protocol.md"], "folder = narrows the library and roots locations there");
  } finally {
    await g.close();
  }
});

test("delta drives re-ingest: an edit re-downloads one file and publishes its new version; a sharing change re-reads permissions; a rename moves locations; a delete leaves the knowledge base", async () => {
  const g = await startFakeGraph();
  try {
    library(g);
    const src = graphSource(cfg(g, "graph-delta"), deps(g));
    const first = await syncKb(sync, "graph-delta", [src]);
    assert.equal(first.t, "published");

    const n = [contentRequests(g), permissionRequests(g)] as const;
    const quiet = await syncKb(sync, "graph-delta", [src]);
    assert.deepEqual([quiet.t, quiet.snapshot], ["unchanged", first.snapshot]);
    assert.deepEqual([contentRequests(g), permissionRequests(g)], n, "an empty delta fetches nothing");
    assert.deepEqual(src.state(), { fullSyncs: 1, deltaSyncs: 1 });

    g.edit("i-onboard", ONBOARDING.replace("first day", "first morning"), "2026-11-07T09:00:00Z");
    const edited = await syncKb(sync, "graph-delta", [src]);
    assert.ok(edited.t === "published" && edited.diff);
    assert.deepEqual([edited.diff.added, edited.diff.changed, edited.diff.removed], [[], ["lab-sp/lab-sops/onboarding.md"], []]);
    assert.equal(contentRequests(g), n[0] + 1, "only the edited file is downloaded again");
    assert.equal(permissionRequests(g), n[1] + 1, "only the edited file's permissions are read again");

    // The cryo folder is opened to the whole lab: the folder is in the delta, its file is not, and the file's scope follows.
    g.restrict("f-cryo", [{ kind: "link", scope: "organization" }]);
    const opened = await syncKb(sync, "graph-delta", [src]);
    assert.equal(opened.t, "published");
    const kb = createKbReader(storedSnapshots(db, store));
    const paths = async (v: Viewer) => (await kb.outline(opened.snapshot, v)).value.paths;
    assert.ok((await paths(bob)).includes("lab-sp/lab-sops/cryo/cryostat-protocol.md"), "bob now sees the protocol the folder was opened to");
    g.restrict("f-cryo", [{ kind: "group", email: "cryo@lab0.example" }]);
    const closed = await syncKb(sync, "graph-delta", [src]);
    assert.equal(closed.t, "published");
    assert.ok(!(await kb.outline(closed.snapshot, bob)).value.paths.includes("lab-sp/lab-sops/cryo/cryostat-protocol.md"), "and loses it when the folder is closed again");

    g.rename("f-sops", "SOPs");
    const renamed = await syncKb(sync, "graph-delta", [src]);
    assert.ok(renamed.t === "published" && renamed.diff);
    assert.ok(renamed.diff.added.includes("lab-sp/sops/onboarding.md") && renamed.diff.removed.includes("lab-sp/lab-sops/onboarding.md"), "a folder rename moves the files under it");

    g.remove("i-freezer");
    const deleted = await syncKb(sync, "graph-delta", [src]);
    assert.ok(deleted.t === "published" && deleted.diff);
    assert.deepEqual([deleted.diff.added, deleted.diff.changed, deleted.diff.removed], [[], [], ["lab-sp/sops/freezer-storage.md"]]);
    assert.ok(!(await kb.outline(deleted.snapshot, "all")).value.paths.includes("lab-sp/sops/freezer-storage.md"), "the deleted file is out of the knowledge base, for every viewer");
    const hits = (await kb.search(deleted.snapshot, "freezer storage", 10, "all")).value;
    assert.ok(!hits.some((h) => h.path.includes("freezer")), "and search no longer finds it");
    const audit = (await loadAudit(db)).map((r) => r.event).filter((e) => e.t === "kb.synced" && e.kbId === "graph-delta");
    const last = audit.at(-1);
    assert.equal(last?.t === "kb.synced" && last.removed, 1, "the audit stream records the removal");
    assert.equal(src.state().fullSyncs, 1, "every sync after the first came from the deltaLink");

    g.expireDelta();
    g.edit("i-onboard", ONBOARDING, "2026-11-07T10:00:00Z");
    const resync = await syncKb(sync, "graph-delta", [src]);
    assert.equal(src.state().fullSyncs, 2, "a 410 Gone deltaLink starts a full delta");
    assert.ok(resync.t === "published" && resync.diff);
    assert.deepEqual([resync.diff.added, resync.diff.changed, resync.diff.removed], [[], ["lab-sp/sops/onboarding.md"], []], "and the full resync holds exactly the library");
  } finally {
    await g.close();
  }
});

test("zero leakage at retrieval: a member outside a SharePoint grant gets neither the path nor the text from outline, search or read; a member inside reads it", async () => {
  const g = await startFakeGraph();
  try {
    library(g);
    const synced = await syncKb(sync, "graph-scope", [graphSource(cfg(g, "graph-scope"), deps(g))]);
    const id = synced.snapshot as SnapshotId;
    const kb = createKbReader(storedSnapshots(db, store));
    const hidden = "lab-sp/lab-sops/cryo/cryostat-protocol.md";
    for (const v of [bob, NO_MEMBER]) {
      const seen = JSON.stringify([
        (await kb.outline(id, v)).value,
        (await kb.search(id, "cryostat zephyrine wash Friday cryo", 10, v)).value,
        (await kb.read(id, [hidden], 15_000, v)).value.entries,
      ]);
      for (const leak of ["cryostat", "Cryostat", "zephyrine", "/cryo/"]) assert.ok(!seen.includes(leak), `${v === NO_MEMBER ? "a run with no member" : "bob"} sees ${leak}`);
      assert.deepEqual((await kb.read(id, [hidden], 15_000, v)).value.missing, [hidden], "a hidden path reads as missing");
    }
    const read = (await kb.read(id, [hidden], 15_000, alice)).value;
    assert.match(read.entries[0]!.body, /zephyrine wash/);
  } finally {
    await g.close();
  }
});

test("a failed fetch fails the sync and keeps the head; a nextLink to another origin is refused and never carries the token", async () => {
  const g = await startFakeGraph();
  try {
    library(g);
    const src = graphSource(cfg(g, "graph-fail"), deps(g));
    const first = await syncKb(sync, "graph-fail", [src]);
    const refused = graphSource(cfg(g, "graph-fail"), { ...deps(g), http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl: fetch }) });
    await assert.rejects(syncKb(sync, "graph-fail", [refused]), /egress refused/);
    const head = await db.query<{ snapshot: string }>("select snapshot from kb_heads where kb_id = 'graph-fail'");
    assert.equal(head.rows[0]!.snapshot, first.snapshot, "a Graph host lab.toml does not place is refused, and the head stays");
  } finally {
    await g.close();
  }
  const seen: (string | undefined)[] = [];
  const other = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.end("{}");
  }).listen(0, "127.0.0.1");
  await once(other, "listening");
  const port = (other.address() as { port: number }).port;
  const evil = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ value: [], "@odata.nextLink": `http://127.0.0.1:${port}/steal` }));
  }).listen(0, "127.0.0.1");
  await once(evil, "listening");
  try {
    const url = `http://127.0.0.1:${(evil.address() as { port: number }).port}`;
    const src = graphSource({ id: "evil", kind: "graph", kb: "graph-evil", cls: "D1", licence: "internal-only", driveId: "d", folder: null, tokenEnv: "X", baseUrl: url, pollSeconds: 60, siteGroups: {} }, { http, db, token: "secret-token", directory, labPatterns: [] });
    await assert.rejects(src.scan(), /not sent there/);
    assert.deepEqual(seen, [], "the other origin got no request at all");
  } finally {
    other.close();
    evil.close();
  }
});

test("lab.toml: a graph source parses with its defaults, and site_groups must name a scope", async () => {
  const { parseConfig } = await import("../packages/core/src/config.ts");
  const base = '[endpoints.local]\nbase_url = "http://127.0.0.1:1/v1"\nplacement = "lab"\n';
  const c = parseConfig(`${base}[sources.sp]\nkind = "graph"\ndrive_id = "b!abc"\nfolder = "Lab SOPs"\ntoken_env = "LAB_GRAPH_TOKEN"\nkb = "docs"\nclass = "D1"\n[sources.sp.site_groups]\n"Lab Members" = "lab"\n`, "/etc/lab.toml");
  const s = c.sources[0]!;
  assert.ok(s.kind === "graph");
  assert.deepEqual([s.driveId, s.folder, s.baseUrl, s.pollSeconds, s.siteGroups], ["b!abc", "Lab SOPs", "https://graph.microsoft.com", 60, { "Lab Members": "lab" }]);
  assert.throws(() => parseConfig(`${base}[sources.sp]\nkind = "graph"\ndrive_id = "b!abc"\ntoken_env = "T"\nkb = "docs"\nclass = "D1"\n[sources.sp.site_groups]\n"Lab Members" = "everyone"\n`, "/etc/lab.toml"), /a scope is/);
});
