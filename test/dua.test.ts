/**
 * DUAs in process: lab.toml's [duas] refusals, and what each member's run can read through the tools. The wire half
 * (no entry text in any model request) is test/dua-wire.test.ts.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../packages/core/src/config.ts";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import { duaAccess, duaRefusal, runKb, type Dua } from "../packages/core/src/dua.ts";
import { citedEntry } from "../packages/core/src/surfaces/web-source.ts";
import { keyedAddresser } from "../packages/core/src/hash.ts";
import { createKbReader, memorySnapshots, snapshotFromFixture } from "../packages/core/src/kb.ts";
import type { RunEvent, RunId, Trigger } from "../packages/core/src/record.ts";
import { builtinTools, createHttpEgress, createToolRunner, registryOf, type ToolEnv } from "../packages/core/src/tools.ts";
import { memoryJournal } from "./recorder.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "dua-")));
after(() => rm(root, { recursive: true, force: true }));
const visits = join(root, "cohort-visits");
await mkdir(visits);
await writeFile(join(visits, "visits.csv"), "visit,hours\nbaseline,7\n");
const fixture = (name: string) => readFile(new URL(`../fixtures/dua/${name}`, import.meta.url), "utf8");
const DUAS = await fixture("duas.toml");
const base = `[endpoints.lab]\nbase_url = "http://127.0.0.1:1"\nplacement = "lab"\n[datasets.cohort-visits]\npath = "${visits}"\nclass = "D3"\ndescription = "Cohort visit hours"\n`;
const load = (extra: string) => parseConfig(base + extra, join(root, "lab.toml"));

test("lab.toml's [duas] parse to members, the last day, the class and what each covers", () => {
  const c = load(DUAS);
  assert.deepEqual(
    c.duas.map((d) => [d.id, d.members, d.expires, d.classId, d.level, d.knowledgeBases, d.entries, d.datasets]),
    [
      ["sleep-release", ["ana@lab0.example", "raj@lab0.example"], "2027-06-30", "restricted", "D3", [], [{ kbId: "lab0-release", path: "release/consent-groups.md" }], []],
      ["sleep-linkage-2025", ["ana@lab0.example"], "2026-01-31", "restricted", "D3", [], [{ kbId: "lab0-release", path: "release/linkage-keys.md" }], []],
      ["sleep-cohort", ["ana@lab0.example"], "2027-06-30", "restricted", "D3", ["lab0-cohort"], [], ["cohort-visits"]],
    ],
  );
  assert.deepEqual(load("").duas, [], "no [duas] table, no DUA");
});

test("a DUA in a class a hosted model reads, and every other malformed DUA, is refused at load naming the table", () => {
  const dua = (body: string) => () => load(`[duas.x]\nmembers = ["ana"]\nexpires = 2027-01-01\n${body}`);
  assert.throws(dua('class = "internal"\nknowledge_bases = ["k"]'), /\[duas\.x\] class = "internal" is one a hosted model may read \(model_tier = "hosted"\), and a DUA's data goes to no hosted model \(NIH NOT-OD-25-081\)/);
  assert.throws(dua('class = "nope"\nknowledge_bases = ["k"]'), /\[duas\.x\] class = "nope" is not a data class/);
  assert.throws(dua('class = "restricted"'), /\[duas\.x\] covers nothing/);
  assert.throws(dua('class = "restricted"\ndatasets = ["ghost"]'), /\[duas\.x\] datasets names ghost, which is not a \[datasets\] id/);
  assert.throws(() => load('[duas.x]\nmembers = []\nexpires = 2027-01-01\nclass = "restricted"\nknowledge_bases = ["k"]'), /\[duas\.x\] members names no member/);
  assert.throws(() => load('[duas.x]\nmembers = ["a"]\nexpires = "next june"\nclass = "restricted"\nknowledge_bases = ["k"]'), /\[duas\.x\] expires/);
  assert.throws(dua('class = "restricted"\nknowledge_bases = ["k"]\n[duas.y]\nmembers = ["b"]\nexpires = 2027-01-01\nclass = "restricted"\nknowledge_bases = ["k"]'), /\[duas\.y\] covers knowledge base k, which \[duas\.x\] already covers/);
  assert.throws(dua('class = "restricted"\nknowledge_bases = ["k"]\nentries = ["k/a.md"]'), /entries names k\/a\.md, whose whole knowledge base a DUA already covers/);
});

test("a dataset declared below its DUA's class level is refused, so dataset_list never shows it lower than the DUA", () => {
  assert.throws(
    () => parseConfig(`[endpoints.lab]\nbase_url = "http://127.0.0.1:1"\nplacement = "lab"\n[datasets.v]\npath = "${visits}"\nclass = "D1"\ndescription = "v"\n[duas.x]\nmembers = ["a"]\nexpires = 2027-01-01\nclass = "restricted"\ndatasets = ["v"]`, join(root, "lab.toml")),
    /\[duas\.x\] binds dataset v at D1, under its class restricted at D3; declare \[datasets\.v\] class = "D3"/,
  );
});

test("expiry refuses everyone, named or not, from the day after expires; a class with model_tier none refuses every member", () => {
  const d: Dua = { id: "x", members: ["ana"], expires: "2026-11-06", classId: "restricted", level: "D3", noModel: false, knowledgeBases: ["k"], entries: [], datasets: [] };
  assert.equal(duaRefusal(d, "ana", "2026-11-06"), null, "the last day still holds");
  assert.equal(duaRefusal(d, "ana", "2026-11-07")?.rule, "expired");
  assert.equal(duaRefusal(d, "ben", "2026-11-07")?.rule, "expired");
  assert.equal(duaRefusal(d, "ben", "2026-11-06")?.rule, "not-named");
  assert.equal(duaRefusal(d, null, "2026-11-06")?.rule, "no-member");
  assert.equal(duaRefusal({ ...d, classId: "controlled_access", noModel: true }, "ana", "2026-11-06")?.rule, "no-model");
  for (const r of [duaRefusal(d, "ben", "2026-11-07"), duaRefusal(d, "ben", "2026-11-06")]) {
    assert.match(r!.reason, /^DUA x /, "every refusal names the DUA");
    assert.match(r!.reason, /; rule: /, "and the rule");
    assert.doesNotMatch(r!.reason, /ben/, "and never the member");
  }
  assert.deepEqual(duaAccess([d], "ana", "2026-11-06").entry("other", "a.md"), { t: "open" });
});

const address = keyedAddresser(randomBytes(32));
const release = snapshotFromFixture(JSON.parse(await fixture("kb-release.json")), address);
const cohort = snapshotFromFixture(JSON.parse(await fixture("kb-cohort.json")), address);
const config = load(DUAS);
const runner = createToolRunner(registryOf(builtinTools()), { http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {} }), kb: createKbReader(memorySnapshots([release, cohort])), datasets: config.datasets, sandbox: { run: async (job: { mounts: readonly { id: string }[] }) => ({ mounted: job.mounts.map((m) => m.id) }) } as never, duas: config.duas, clock: { now: () => Date.parse("2026-11-07T05:00:00Z") } });
const env: ToolEnv = {
  knowledgeBases: [
    { kbId: "lab0-release", snapshot: release.snapshot.id, cls: "D1" },
    { kbId: "lab0-cohort", snapshot: cohort.snapshot.id, cls: "D1" },
  ],
  retrieval: { algorithm: "bm25-v1", readCapTokens: 15_000 },
  sandbox: { mountCeiling: "D3", mounts: ["cohort-visits"] },
};
const signal = new AbortController().signal;

/** A journal whose run.started names this trigger, as the door writes it. */
async function runFor(trigger: Trigger) {
  const j = memoryJournal("00000000-0000-4000-8000-0000000000d1" as RunId);
  const input = await j.put(Labelled.stamp("question", "D0", "test"));
  await j.append({ t: "run.started", trigger, input, history: [] } as unknown as RunEvent);
  return j;
}
const member = (id: string): Trigger => ({ t: "message", surface: "web", messageId: "m1", memberId: id });

async function call(j: Awaited<ReturnType<typeof runFor>>, tool: string, input: unknown) {
  const ref = await j.put(Labelled.stamp(input, "D0", "test"));
  const callId = `c${j.log.length}`;
  await runner.invoke(j, { callId, tool, attempt: 1, input: ref }, env, signal);
  const done = j.log.findLast((e) => (e.t === "tool.completed" || e.t === "tool.failed") && e.callId === callId)!;
  if (done.t === "tool.completed") return { cls: done.output.cls, body: j.body(done.output) as Record<string, unknown>, retrieved: done.retrieved ?? [], failed: null };
  if (done.t !== "tool.failed") throw new Error("no outcome");
  return { cls: null, body: {} as Record<string, unknown>, retrieved: [], failed: done.failure.detail ? String((await j.get(done.failure.detail)).value) : done.failure.code };
}

test("a member the DUA does not name gets nothing of its entries: not in search, not in a read, not in the outline", async () => {
  const j = await runFor(member("ben@lab0.example"));
  const search = await call(j, "kb_search", { query: "consent groups linkage keys release", k: 5, kb: "lab0-release" });
  const text = JSON.stringify(search.body);
  assert.doesNotMatch(text, /consent-groups|linkage-keys|SENTINEL/, "no refused path, title or text in the output");
  assert.deepEqual((search.body.withheld as { dua: string }[]).map((w) => w.dua).sort(), ["sleep-linkage-2025", "sleep-release"]);
  assert.match(text, /DUA sleep-release does not name the member who asked; rule: only the members \[duas\.sleep-release\] members names read its data/);
  assert.match(text, /DUA sleep-linkage-2025 expired on 2026-01-31; rule: no one reads its data after/);
  assert.equal(search.cls, "D1", "nothing admitted, so nothing raised");
  const hashes = search.retrieved.flatMap((r) => r.entries);
  const bound = release.entries.filter((e) => e.path.startsWith("release/")).map((e) => e.hash);
  assert.ok(hashes.every((h) => !bound.includes(h)), "the record does not show a refused entry as retrieved");

  const read = await call(j, "kb_read", { paths: ["release/consent-groups.md", "methods/actigraphy.md"], kb: "lab0-release" });
  assert.deepEqual((read.body.entries as { path: string }[]).map((e) => e.path), ["methods/actigraphy.md"]);
  assert.deepEqual((read.body.refused as { path: string }[]).map((e) => e.path), ["release/consent-groups.md"]);
  assert.doesNotMatch(JSON.stringify(read.body), /SENTINEL/);

  const outline = await runner.kbFor(j, env.knowledgeBases).outline(release.snapshot.id);
  assert.deepEqual(outline.value.paths, ["methods/actigraphy.md"]);
  assert.deepEqual((await runner.kbFor(j, env.knowledgeBases).outline(cohort.snapshot.id)).value.paths, [], "a whole-KB DUA leaves its outline empty");
});

test("a named member reads the DUA's entries at its class level; the expired one stays refused to them too", async () => {
  const j = await runFor(member("ana@lab0.example"));
  const read = await call(j, "kb_read", { paths: ["release/consent-groups.md", "release/linkage-keys.md"], kb: "lab0-release" });
  assert.deepEqual((read.body.entries as { path: string }[]).map((e) => e.path), ["release/consent-groups.md"]);
  assert.match(JSON.stringify(read.body), /SENTINEL-CONSENT-7731/);
  assert.doesNotMatch(JSON.stringify(read.body), /SENTINEL-LINKAGE/);
  assert.match(JSON.stringify(read.body.refused), /DUA sleep-linkage-2025 expired on 2026-01-31/);
  assert.equal(read.cls, "D3", "raised to restricted's level, so no hosted endpoint may receive it");
  const outline = await runner.kbFor(j, env.knowledgeBases).outline(release.snapshot.id);
  assert.deepEqual(outline.value.paths, ["methods/actigraphy.md", "release/consent-groups.md"]);
  assert.equal(outline.cls, "D3", "an outline listing a DUA entry is at the DUA's level");
});

test("a run with no member (a schedule) reads no DUA entry", async () => {
  const j = await runFor({ t: "schedule", scheduleId: "nightly", fireAt: "2026-11-07T05:00:00Z" });
  const read = await call(j, "kb_read", { paths: ["release/consent-groups.md"], kb: "lab0-release" });
  assert.deepEqual(read.body.entries, []);
  assert.match(JSON.stringify(read.body.refused), /this run has no member/);
});

test("dataset_list and run_code follow the DUA: an unnamed member sees why, not the dataset's files", async () => {
  const ben = await runFor(member("ben@lab0.example"));
  const list = await call(ben, "dataset_list", {});
  assert.deepEqual(list.body.datasets, []);
  assert.deepEqual(list.body.withheld, [{ id: "cohort-visits", reason: "DUA sleep-cohort does not name the member who asked; rule: only the members [duas.sleep-cohort] members names read its data" }]);
  assert.doesNotMatch(JSON.stringify(list.body), /visits\.csv/);
  const code = await call(ben, "run_code", { language: "python", code: "print(1)", datasets: ["cohort-visits"] });
  assert.equal(code.failed, "dataset cohort-visits is not mounted: DUA sleep-cohort does not name the member who asked; rule: only the members [duas.sleep-cohort] members names read its data");

  const ana = await runFor(member("ana@lab0.example"));
  const listed = await call(ana, "dataset_list", {});
  assert.deepEqual((listed.body.datasets as { id: string; files: string[] }[]).map((d) => [d.id, d.files]), [["cohort-visits", ["visits.csv"]]]);
  assert.equal(listed.body.withheld, undefined);
  assert.equal(listed.cls, "D3");
  const ran = await call(ana, "run_code", { language: "python", code: "print(1)", datasets: ["cohort-visits"] });
  assert.deepEqual(ran.body, { mounted: ["cohort-visits"] }, "the member the DUA names gets the mount");
  assert.equal(ran.cls, "D3");
});

test("the chat's Source chip reopens a cited DUA entry only while the DUA admits the run's member", async () => {
  const consent = release.entries.find((e) => e.path === "release/consent-groups.md")!;
  const events = [
    { event: { t: "run.started", trigger: member("ana@lab0.example") } },
    { event: { t: "tool.completed", retrieved: [{ snapshot: release.snapshot.id, entries: [consent.hash], truncated: false }] } },
  ] as never;
  const kb = createKbReader(memorySnapshots([release]));
  const open = (today: string, kbs: typeof env.knowledgeBases | null = env.knowledgeBases) => citedEntry(events, "release/consent-groups.md", runKb(kb, kbs, config.duas, events, today));
  assert.equal((await open("2027-06-30")).t, "entry", "on the DUA's last day it opens");
  assert.equal((await open("2027-07-01")).t, "missing", "after it expires it does not, though the run read it");
  assert.equal((await open("2027-06-30", null)).t, "missing", "with the run's agent unknown, nothing opens while DUAs are declared");
  assert.equal((await citedEntry(events, "release/consent-groups.md", runKb(kb, null, [], events, "2030-01-01"))).t, "entry", "a lab with no DUA reads as before");
});
