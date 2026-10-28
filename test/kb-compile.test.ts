import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { loadAudit } from "../packages/core/src/audit.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import { createGateway } from "../packages/core/src/gateway.ts";
import { createKbReader, storedSnapshots } from "../packages/core/src/kb.ts";
import { attachedFiles, compileClass, compileResult, filesIn, kbPublishClass, loadOverrides, parseEntries, parseKbDefinition, parseVerdict, publishSnapshot, readSources, renderCoverage, requestCompile, runCompileJob, type KbDefinition } from "../packages/core/src/kb-compile.ts";
import { createQueue } from "../packages/core/src/queue.ts";
import { createHttpEgress, EgressRefused } from "../packages/core/src/tools.ts";
import { createPayloadStore } from "../packages/core/src/record.ts";
import { freshDatabase } from "./db.ts";
import { startFakeModel } from "./fake-model.ts";

const dir = fileURLToPath(new URL("../fixtures/kb-lab/", import.meta.url));
const { db } = await freshDatabase("labh_test_kb_compile");
const compiler = await startFakeModel("scripted-1", "compile");
const hosted = await startFakeModel("hosted-2", "compile");
after(async () => {
  await compiler.close();
  await hosted.close();
  await db.end();
});
// A lab wiki page as a URL source. 127.0.0.1 is not in any [hosts] table here, so it is public.
let wikiRequests = 0;
let followedRedirects = 0;
const wiki = createServer(async (req, res) => {
  if (req.url === "/moved") {
    res.writeHead(302, { location: "/elsewhere" });
    return res.end();
  }
  if (req.url === "/elsewhere") followedRedirects += 1;
  wikiRequests += 1;
  res.writeHead(200, { "content-type": "text/markdown" });
  res.end(await readFile(`${dir}onboarding-note.md`, "utf8"));
});
wiki.listen(0, "127.0.0.1");
await once(wiki, "listening");
after(() => wiki.close());
const wikiUrl = `http://127.0.0.1:${(wiki.address() as { port: number }).port}/onboarding-note.md`;
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: randomBytes(32), keyId: "k1" });
const queue = createQueue(db);
const sourceDeps = { http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl: fetch }), address: store.address, db, actor: "test", labPatterns: [] as RegExp[] };
const gateway = createGateway(
  [
    { id: "local", baseUrl: compiler.url, placement: "lab", supportsLogprobs: false },
    { id: "hosted", baseUrl: hosted.url, placement: "zdr", supportsLogprobs: false },
  ],
  DEFAULT_POLICY,
  fetch,
);
const definition = async (file: string, edit: (d: Record<string, unknown>) => void = () => {}): Promise<KbDefinition> => {
  const json = JSON.parse(await readFile(`${dir}${file}`, "utf8")) as Record<string, unknown>;
  edit(json);
  return parseKbDefinition(json);
};

async function compile(def: KbDefinition) {
  const r = await requestCompile({ queue, store }, def, await readSources(def, filesIn(dir), sourceDeps), new Date("2026-10-01T00:00:00.000Z"));
  const job = await db.query<{ payload: unknown }>("select payload from jobs where id = $1", [r.jobId]);
  const outcome = await runCompileJob(job.rows[0]!.payload, { db, store, gateway, actor: "test", jobId: r.jobId, signal: new AbortController().signal, log: () => {}, labPatterns: [] });
  return { ...r, outcome };
}

test("a compile produces entries with per-fact sources, the joined class, and a coverage report naming the gap", async () => {
  const { jobId, outcome } = await compile(await definition("kb.json"));
  assert.equal(outcome.t, "compiled");
  if (outcome.t !== "compiled") return;
  const s = outcome.snapshot.snapshot;
  assert.equal(s.cls, "D2", "the codebook source is D2");
  assert.deepEqual(Object.keys(s.entries).sort(), [
    "codebook/variable-mood-score.md",
    "codebook/variable-sleep-hours.md",
    "onboarding/data-handling.md",
    "onboarding/first-week.md",
    "onboarding/who-to-ask.md",
    "sop/discarding-samples.md",
    "sop/receiving-samples.md",
    "sop/storage.md",
  ]);
  const storage = outcome.snapshot.entries.find((e) => e.path === "sop/storage.md")!;
  assert.deepEqual(storage.facts, [{ text: "Intake samples are kept in the minus 80 freezer in room 214 for at most 24 months.", sources: [{ sourceId: "sop", locator: "## Storage" }] }]);
  assert.deepEqual(s.compiler?.target.modelId, "scripted-1");
  assert.deepEqual(
    s.coverage.filter((c) => !c.answerable).map((c) => c.question),
    ["What is the parking reimbursement rate for visitors?"],
  );
  assert.deepEqual(s.coverage[0], { question: "How long are intake samples kept in the freezer?", answerable: true, entries: ["sop/storage.md"] });
  assert.match(renderCoverage(s), /5 of 6 questions have a supporting entry\n[\s\S]*  GAP  What is the parking reimbursement rate for visitors\?/);
  assert.deepEqual(await compileResult(db, jobId), { t: "compiled", snapshot: s.id, gaps: ["What is the parking reimbursement rate for visitors?"] });
  assert.equal(compiler.requests, 3 + 6, "three sources and six coverage judgments, one call each");

  const reader = createKbReader(storedSnapshots(db, store));
  assert.deepEqual((await reader.search(s.id, "freezer", 1)).value.map((h) => h.path), ["sop/storage.md"]);

  assert.deepEqual(await publishSnapshot(db, store.address, s.id, "test"), { ok: false, gaps: ["What is the parking reimbursement rate for visitors?"] });
  assert.equal((await db.query("select 1 from kb_heads")).rowCount, 0);
});

test("dropping the gap question recompiles from cache with no model call, and that snapshot publishes", async () => {
  const before = compiler.requests;
  const { outcome } = await compile(await definition("kb.json", (d) => (d.coverageQuestions = (d.coverageQuestions as string[]).slice(0, 5))));
  assert.equal(outcome.t, "compiled");
  if (outcome.t !== "compiled") return;
  assert.equal(compiler.requests, before, "every source result and verdict came from the cache");
  assert.deepEqual(await publishSnapshot(db, store.address, outcome.snapshot.snapshot.id, "test"), { ok: true });
  const head = await db.query<{ snapshot: string }>("select snapshot from kb_heads where kb_id = 'lab-handbook'");
  assert.equal(head.rows[0]?.snapshot, outcome.snapshot.snapshot.id);
});

test("a publisher can publish over coverage gaps only with a note, kept in the audit stream, on the snapshot and in the coverage report", async () => {
  const { outcome } = await compile(await definition("kb.json"));
  assert.equal(outcome.t, "compiled");
  if (outcome.t !== "compiled") return;
  const id = outcome.snapshot.snapshot.id;
  const gap = "What is the parking reimbursement rate for visitors?";
  const note = "Parking is out of scope for this handbook; visitors ask the front desk.";
  assert.deepEqual(await publishSnapshot(db, store.address, id, "pi-1", { note }), { ok: true, overridden: [gap] });
  const head = await db.query<{ snapshot: string }>("select snapshot from kb_heads where kb_id = 'lab-handbook'");
  assert.equal(head.rows[0]?.snapshot, id);
  const last = (await loadAudit(db)).at(-1)!;
  assert.deepEqual({ actor: last.actor, event: last.event }, { actor: "pi-1", event: { t: "kb.published", kbId: "lab-handbook", snapshot: id, override: { note, gaps: [gap] } } });
  const overrides = await loadOverrides(db, id);
  assert.deepEqual(overrides.map((o) => ({ publisher: o.publisher, note: o.note, gaps: o.gaps, auditSeq: o.auditSeq })), [{ publisher: "pi-1", note, gaps: [gap], auditSeq: last.seq }]);
  assert.match(renderCoverage(outcome.snapshot.snapshot, overrides), new RegExp(`  GAP  What is the parking reimbursement rate for visitors\\?\n  OVERRIDE by pi-1 at \\S+: ${note}`));
  await assert.rejects(publishSnapshot(db, store.address, id, "pi-1", { note: "   " }), /a coverage override needs a note/);
  await assert.rejects(db.query("update kb_coverage_overrides set note = 'edited'"), /kb_coverage_overrides is insert-only/);
});

test("asking again for the same compile gives the same job", async () => {
  const def = await definition("kb.json");
  const sources = await readSources(def, filesIn(dir), sourceDeps);
  const a = await requestCompile({ queue, store }, def, sources, new Date());
  const b = await requestCompile({ queue, store }, def, sources, new Date());
  assert.equal(a.jobId, b.jobId);
  assert.equal(b.created, false);
  const jobs = await db.query("select 1 from jobs where key = $1", [a.key]);
  assert.equal(jobs.rowCount, 1);
});

test("a D3 source aimed at a hosted compiler is refused at the gateway, recorded in the audit stream, and never sent", async () => {
  const { jobId, outcome } = await compile(await definition("kb-restricted.json"));
  assert.deepEqual(outcome, { t: "refused", cls: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } });
  assert.equal(hosted.requests, 0);
  const rows = (await loadAudit(db)).filter((r) => "job" in r.event && r.event.job === jobId || (r.event.t === "call" && "job" in r.event.context && r.event.context.job === jobId));
  assert.deepEqual(
    rows.map((r) => (r.event.t === "call" ? `call ${r.event.event.t}` : r.event.t)),
    ["call egress.refused", "kb.compile-failed"],
  );
  assert.deepEqual(await compileResult(db, jobId), { t: "failed", reason: "snapshot class D3 refused by egress", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } });
});

test("a KB mixing D1 and D3 sources on a hosted compiler is refused whole, before any model call", async () => {
  const before = hosted.requests;
  const def = await definition("kb.json", (d) => {
    (d.sources as unknown[]).push({ sourceId: "visits", kind: "file", location: "visit-log.md", cls: "D3", licence: "internal-only" });
    d.compiler = { endpointId: "hosted", modelId: "hosted-2" };
  });
  const { outcome } = await compile(def);
  assert.equal(hosted.requests - before, 0, "not even the D1 sources were sent");
  assert.deepEqual(outcome, { t: "refused", cls: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } });
});

test("a URL source goes through the HTTP choke point: refused on a public host before any request, read on a lab host", async () => {
  const def = await definition("kb.json", (d) => {
    const onboarding = (d.sources as { sourceId: string; kind: string; location: string }[]).find((x) => x.sourceId === "onboarding")!;
    onboarding.kind = "url";
    onboarding.location = wikiUrl;
  });
  const refusal = { code: "class-above-ceiling", payload: "D1", ceiling: "D0" };
  await assert.rejects(readSources(def, filesIn(dir), sourceDeps), (err: unknown) => err instanceof EgressRefused && JSON.stringify(err.refusal) === JSON.stringify(refusal));
  assert.equal(wikiRequests, 0, "the wiki received nothing");
  const last = (await loadAudit(db)).at(-1)!;
  assert.deepEqual(last.event, { t: "call", context: { t: "kb-source", kbId: "lab-handbook", sourceId: "onboarding" }, event: { t: "egress.refused", destination: "http:127.0.0.1", payload: "D1", refusal } });

  const labWiki = { ...sourceDeps, http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: { "127.0.0.1": "lab" }, fetchImpl: fetch }) };
  const read = await readSources(def, filesIn(dir), labWiki);
  assert.equal(wikiRequests, 1, "listed as a lab host, the wiki is read once");
  assert.equal(read.find((s) => s.ref.sourceId === "onboarding")?.text, await readFile(`${dir}onboarding-note.md`, "utf8"));
});

test("compiler replies are parsed leniently at the boundary and strictly in shape", () => {
  assert.deepEqual(parseEntries('<think>hm</think>Here: {"entries":[{"path":"Sample Storage","title":" Storage ","body":"Kept 24 months.","facts":[{"text":"Kept 24 months.","locator":"## Storage"}]}]}', "sop"), [
    { path: "sample-storage.md", title: "Storage", body: "Kept 24 months.", facts: [{ text: "Kept 24 months.", sources: [{ sourceId: "sop", locator: "## Storage" }] }] },
  ]);
  assert.match(String(parseEntries('{"entries":[]}', "sop")), /does not match the entry shape/);
  assert.match(String(parseEntries("no json here", "sop")), /holds no JSON object/);
  assert.deepEqual(parseVerdict('{"answerable":true,"paths":["a.md","elsewhere.md"]}', "q", ["a.md", "b.md"]), { question: "q", answerable: true, entries: ["a.md"] });
  assert.deepEqual(parseVerdict('{"answerable":true}', "q", ["a.md", "b.md"]), { question: "q", answerable: true, entries: ["a.md", "b.md"] });
  assert.deepEqual(parseVerdict('{"answerable":false,"paths":["a.md"]}', "q", ["a.md"]), { question: "q", answerable: false, entries: [] });
});

test("a definition needs 5 to 10 coverage questions and an exact compiler model", async () => {
  await assert.rejects(definition("kb.json", (d) => (d.coverageQuestions = ["only one?"])), /too_small|>=5/);
  await assert.rejects(definition("kb.json", (d) => ((d.compiler as { modelId: string }).modelId = "qwen3:latest")), /floats to the latest version/);
});

// The URL and coverage-question parts of the class floor. LAB-\d{4} is a lab pattern
// no gate detector knows, so only the lab's own patterns can raise these to D3.
const labPatterns = [/\bLAB-\d{4}\b/];

test("a URL naming a participant id goes out labelled D3 and is refused on a public host before any request", async () => {
  const before = wikiRequests;
  const def = await definition("kb.json", (d) => {
    const onboarding = (d.sources as { sourceId: string; kind: string; location: string }[]).find((x) => x.sourceId === "onboarding")!;
    onboarding.kind = "url";
    onboarding.location = `${wikiUrl}?participant=LAB-0042`;
  });
  const refusal = { code: "class-above-ceiling", payload: "D3", ceiling: "D0" };
  await assert.rejects(readSources(def, filesIn(dir), { ...sourceDeps, labPatterns }), (err: unknown) => err instanceof EgressRefused && JSON.stringify(err.refusal) === JSON.stringify(refusal));
  assert.equal(wikiRequests, before, "the wiki received nothing");
  const last = (await loadAudit(db)).at(-1)!;
  assert.deepEqual(last.event, { t: "call", context: { t: "kb-source", kbId: "lab-handbook", sourceId: "onboarding" }, event: { t: "egress.refused", destination: "http:127.0.0.1", payload: "D3", refusal } });
});

test("a coverage question naming a participant id floors the snapshot at D3, so a hosted compiler gets nothing", async () => {
  const before = hosted.requests;
  const def = await definition("kb.json", (d) => {
    d.sources = (d.sources as { sourceId: string }[]).filter((s) => s.sourceId !== "codebook");
    (d.coverageQuestions as string[])[0] = "When did LAB-0042 last give an intake sample?";
    d.compiler = { endpointId: "hosted", modelId: "hosted-2" };
  });
  const r = await requestCompile({ queue, store }, def, await readSources(def, filesIn(dir), { ...sourceDeps, labPatterns }), new Date("2026-10-01T00:00:00.000Z"));
  const job = await db.query<{ payload: unknown }>("select payload from jobs where id = $1", [r.jobId]);
  const outcome = await runCompileJob(job.rows[0]!.payload, { db, store, gateway, actor: "test", jobId: r.jobId, signal: new AbortController().signal, log: () => {}, labPatterns });
  assert.deepEqual(outcome, { t: "refused", cls: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } });
  assert.equal(hosted.requests - before, 0, "no source and no coverage question reached the hosted endpoint");
});

test("a file source's location is a bare file name: absolute, parent and folder paths are refused, and no two file sources share one", async () => {
  for (const location of ["/srv/lab/raw/interview-07.md", "../interview-07.md", "sop/receiving.md", "..\\interview-07.md", "C:interview-07.md", ".."]) {
    await assert.rejects(
      definition("kb.json", (d) => ((d.sources as { location: string }[])[0]!.location = location)),
      (err: unknown) => err instanceof Error && err.message.includes("a file source's location is a file name with no folder"),
      location,
    );
  }
  await assert.rejects(
    definition("kb.json", (d) => ((d.sources as { location: string }[])[1]!.location = (d.sources as { location: string }[])[0]!.location)),
    /two file sources cannot share a file name/,
  );
  const url = await definition("kb.json", (d) => Object.assign((d.sources as object[])[0]!, { kind: "url", location: "https://wiki.lab.example/sop/receiving" }));
  assert.equal(url.sources[0]!.location, "https://wiki.lab.example/sop/receiving", "a URL keeps its slashes");
});

test("the studio's attached files are read in memory, so a location names no file on disk; the kb command's reader refuses a path", async () => {
  const def = await definition("kb.json");
  const names = def.sources.map((s) => s.location);
  const read = await readSources(def, attachedFiles(names.map((name) => ({ name, text: `# ${name}\n\nAttached text for ${name}.` }))), sourceDeps);
  assert.deepEqual(read.map((r) => r.text), names.map((name) => `# ${name}\n\nAttached text for ${name}.`));
  await assert.rejects(readSources(def, attachedFiles([{ name: names[0]!, text: "only one" }]), sourceDeps), new RegExp(`Attach ${names[1]} to compile`));
  assert.throws(() => attachedFiles([{ name: "a.md", text: "1" }, { name: "a.md", text: "2" }]), /a\.md is attached twice/);
  const smuggled: KbDefinition = { ...def, sources: [{ ...def.sources[0]!, location: "../kb-lab/sop-sample-intake.md" }] };
  await assert.rejects(readSources(smuggled, filesIn(dir), sourceDeps), /a file source's location is a file name with no folder/);
  await assert.rejects(readSources(smuggled, attachedFiles([{ name: "sop-sample-intake.md", text: "x" }]), sourceDeps), /Attach \.\.\/kb-lab\/sop-sample-intake\.md to compile/);
});

test("a KB publish moves the higher of the snapshot's class and the head it replaces; a compile job's class is its sources' join", async () => {
  const d2 = await compile(await definition("kb.json", (d) => (d.coverageQuestions = (d.coverageQuestions as string[]).slice(0, 5))));
  assert.equal(await compileClass(db, d2.jobId), "D2");
  assert.equal(d2.outcome.t, "compiled");
  if (d2.outcome.t !== "compiled") return;
  assert.deepEqual(await publishSnapshot(db, store.address, d2.outcome.snapshot.snapshot.id, "test"), { ok: true });
  const d1 = await compile(await definition("kb.json", (d) => {
    d.coverageQuestions = (d.coverageQuestions as string[]).slice(0, 5);
    for (const s of d.sources as { cls: string }[]) s.cls = "D1";
  }));
  assert.equal(await compileClass(db, d1.jobId), "D1");
  assert.equal(d1.outcome.t, "compiled");
  if (d1.outcome.t !== "compiled") return;
  assert.equal(d1.outcome.snapshot.snapshot.cls, "D1");
  assert.equal(await kbPublishClass(db, d1.outcome.snapshot.snapshot), "D2", "replacing a D2 head moves a D2 head");
  assert.equal(await kbPublishClass(db, { ...d1.outcome.snapshot.snapshot, kbId: "no-head-yet" }), "D1");
  assert.equal(await compileClass(db, "not-a-job"), null);
});

test("a URL source that redirects is refused, and its target is never requested", async () => {
  const def = await definition("kb.json", (d) => Object.assign((d.sources as { sourceId: string }[]).find((x) => x.sourceId === "onboarding")!, { kind: "url", location: wikiUrl.replace("/onboarding-note.md", "/moved") }));
  const labWiki = { ...sourceDeps, http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: { "127.0.0.1": "lab" }, fetchImpl: fetch }) };
  await assert.rejects(readSources(def, filesIn(dir), labWiki), /HTTP 302 redirects to \/elsewhere; name the final URL as the source/);
  assert.equal(followedRedirects, 0);
});
