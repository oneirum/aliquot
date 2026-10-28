import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "../packages/core/src/tool-kit.ts";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import { createKbReader, memorySnapshots, snapshotFromFixture } from "../packages/core/src/kb.ts";
import { builtinTools, createHttpEgress, createToolRunner, defineTool, kbSearch, registryOf, type ToolManifest } from "../packages/core/src/tools.ts";
import type { RunId } from "../packages/core/src/record.ts";
import { contentHash, keyedAddresser, type ToolHash } from "../packages/core/src/hash.ts";
import { startFakeModel } from "./fake-model.ts";
import { memoryJournal } from "./recorder.ts";

const loaded = snapshotFromFixture(JSON.parse(await readFile(new URL("../fixtures/kb.json", import.meta.url), "utf8")), keyedAddresser(randomBytes(32)));
const server = await startFakeModel("scripted-1", "answer");
after(() => server.close());
const host = new URL(server.url).hostname;

const fetcher = defineTool({
  name: "fetcher",
  description: "Fetches a URL. Use for tests. Not for anything else.",
  input: z.object({ url: z.string() }),
  reads: "D0",
  effects: "read",
  egress: [host],
  idempotent: true,
  async run({ url }, ctx) {
    const res = await ctx.fetch(url);
    return { status: res.status };
  },
});
const sender = defineTool({ name: "send_email", description: "Sends. Use never. Not for tests.", input: z.object({}), reads: "D0", effects: "external-send", egress: [], idempotent: false, run: async () => ({}) });
const flaky = defineTool({ name: "flaky", description: "Throws. Use never. Not for anything.", input: z.object({}), reads: "D0", effects: "read", egress: [], idempotent: true, run: async () => { throw new Error("upstream 503"); } });
const touchy = defineTool({ name: "touchy", description: "Reads D1, touches D2, then throws quoting what it saw. Use never. Not for anything.", input: z.object({}), reads: "D1", effects: "read", egress: [], idempotent: true, async run(_input, ctx) { ctx.touched("D2"); throw new Error("record for participant 7 not found"); } });

const registry = registryOf([
  ...builtinTools(),
  { manifest: fetcher as ToolManifest<unknown, unknown>, hash: "f".repeat(64) as ToolHash, owner: "test" },
  { manifest: sender as ToolManifest<unknown, unknown>, hash: "s".repeat(64) as ToolHash, owner: "test" },
  { manifest: flaky as ToolManifest<unknown, unknown>, hash: "x".repeat(64) as ToolHash, owner: "test" },
  { manifest: touchy as ToolManifest<unknown, unknown>, hash: "y".repeat(64) as ToolHash, owner: "test" },
]);
const runner = createToolRunner(registry, { http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: { [host]: "lab" }, fetchImpl: fetch }), kb: createKbReader(memorySnapshots([loaded])) });
const env = { knowledgeBases: [{ kbId: "handbook", snapshot: loaded.snapshot.id, cls: loaded.snapshot.cls }], retrieval: { algorithm: "bm25-v1" as const, readCapTokens: 15_000 } };
const RUN = "00000000-0000-4000-8000-000000000002" as RunId;
const signal = new AbortController().signal;

test("a builtin tool's version is the hash of its spec, so editing the description moves every agent that uses it", () => {
  const spec = (m: typeof kbSearch) => ({ name: m.name, description: m.description, inputSchema: z.toJSONSchema(m.input, { io: "input" }), reads: m.reads, effects: m.effects, egress: m.egress, idempotent: m.idempotent });
  assert.equal(builtinTools()[0]!.hash, contentHash(spec(kbSearch)));
  assert.notEqual(contentHash(spec({ ...kbSearch, description: `${kbSearch.description} Also for web search.` })), builtinTools()[0]!.hash);
});

test("kb_search journals requested, completed with every retrieved entry, and classifies output by the snapshot", async () => {
  const j = memoryJournal(RUN);
  const input = await j.put(Labelled.stamp({ query: "office hours in room 312", k: 2 }, "D0", "test"));
  await runner.invoke(j, { callId: "c1", tool: "kb_search", attempt: 1, input }, env, signal);
  assert.deepEqual(
    j.log.map((e) => e.t),
    ["tool.requested", "tool.completed"],
  );
  const completed = j.log[1]!;
  assert.equal(completed.t, "tool.completed");
  if (completed.t !== "tool.completed") return;
  assert.equal(completed.output.cls, "D1", "a D0 question against a D1 snapshot yields a D1 result");
  const hashOf = (path: string) => loaded.entries.find((e) => e.path === path)!.hash;
  assert.deepEqual(completed.retrieved, [{ snapshot: loaded.snapshot.id, entries: [hashOf("office-hours.md"), hashOf("equipment.md")], truncated: false }]);
  const out = j.body(completed.output) as { results: { kb: string; path: string; title: string }[] };
  assert.deepEqual(
    out.results.map((r) => [r.kb, r.path, r.title]),
    [
      ["handbook", "office-hours.md", "Office hours"],
      ["handbook", "equipment.md", "Equipment"],
    ],
  );
});

test("kb_read returns whole entries up to the agent's cap and journals exactly what it returned", async () => {
  const j = memoryJournal(RUN);
  const hashOf = (path: string) => loaded.entries.find((e) => e.path === path)!.hash;
  const input = await j.put(Labelled.stamp({ paths: ["office-hours.md", "data-classes.md", "nope.md"] }, "D0", "test"));
  await runner.invoke(j, { callId: "r1", tool: "kb_read", attempt: 1, input }, env, signal);
  await runner.invoke(j, { callId: "r2", tool: "kb_read", attempt: 1, input }, { ...env, retrieval: { algorithm: "bm25-v1", readCapTokens: 50 } }, signal);
  const [full, capped] = j.log.filter((e) => e.t === "tool.completed");
  assert.ok(full?.t === "tool.completed" && capped?.t === "tool.completed");
  assert.deepEqual(full.retrieved, [{ snapshot: loaded.snapshot.id, entries: [hashOf("office-hours.md"), hashOf("data-classes.md")], truncated: false }]);
  assert.deepEqual(capped.retrieved, [{ snapshot: loaded.snapshot.id, entries: [hashOf("office-hours.md")], truncated: true }]);
  const body = j.body(capped.output) as { entries: { path: string; body: string }[]; omitted: string[]; missing: string[]; note: string };
  assert.deepEqual(
    { paths: body.entries.map((e) => e.path), omitted: body.omitted, missing: body.missing, note: body.note },
    { paths: ["office-hours.md"], omitted: ["data-classes.md"], missing: ["nope.md"], note: "The read cap is 50 tokens. The omitted paths were not read; read them in a separate call." },
  );
  assert.match(body.entries[0]!.body, /Tuesday and Thursday/);
  assert.equal(capped.output.cls, "D1");
});

test("invalid input, an unattached kb and an unknown tool fail without retry", async () => {
  const j = memoryJournal(RUN);
  const bad = await j.put(Labelled.stamp({ query: "" }, "D0", "test"));
  await runner.invoke(j, { callId: "c2", tool: "kb_search", attempt: 1, input: bad }, env, signal);
  const other = await j.put(Labelled.stamp({ query: "x", kb: "nope" }, "D0", "test"));
  await runner.invoke(j, { callId: "c3", tool: "kb_search", attempt: 1, input: other }, env, signal);
  await runner.invoke(j, { callId: "c4", tool: "nonesuch", attempt: 1, input: other }, env, signal);
  const failures = j.log.filter((e) => e.t === "tool.failed");
  assert.deepEqual(
    failures.map((f) => f.t === "tool.failed" && [f.callId, f.retryable, f.failure.code, f.failure.detail && j.body(f.failure.detail)]),
    [
      ["c2", false, "invalid-input", "query Too small: expected string to have >=1 characters"],
      ["c3", false, "invalid-input", "knowledge base nope is not attached to this agent"],
      ["c4", false, "unknown-tool", null],
    ],
  );
});

test("a thrown error is retryable; repeatability and confirmation follow the manifest", async () => {
  const j = memoryJournal(RUN);
  const input = await j.put(Labelled.stamp({}, "D0", "test"));
  await runner.invoke(j, { callId: "c5", tool: "flaky", attempt: 1, input }, env, signal);
  const failed = j.log.at(-1)!;
  assert.equal(failed.t === "tool.failed" && failed.failure.code, "thrown");
  assert.equal(JSON.stringify(failed).includes("upstream 503"), false, "the thrown message is not in the event");
  assert.equal(failed.t === "tool.failed" && failed.failure.detail?.cls, "D0", "the message is a payload at the input's class");
  assert.equal(failed.t === "tool.failed" && failed.failure.detail && j.body(failed.failure.detail), "upstream 503");
  assert.equal(runner.isRepeatable("kb_search"), true);
  assert.equal(runner.isRepeatable("send_email"), false);
  assert.equal(runner.needsConfirm("send_email"), true);
  assert.equal(runner.needsConfirm("kb_search"), false);
});

test("ctx.fetch refuses undeclared hosts and classes above the host placement, and reaches declared lab hosts", async () => {
  const j = memoryJournal(RUN);
  const ok = await j.put(Labelled.stamp({ url: `${server.url}/models` }, "D3", "test"));
  await runner.invoke(j, { callId: "c6", tool: "fetcher", attempt: 1, input: ok }, env, signal);
  const done = j.log.at(-1)!;
  assert.equal(done.t, "tool.completed");
  assert.deepEqual(done.t === "tool.completed" && j.body(done.output), { status: 200 });
  assert.equal(done.t === "tool.completed" && done.output.cls, "D3");

  const undeclared = await j.put(Labelled.stamp({ url: "https://example.org/" }, "D0", "test"));
  await runner.invoke(j, { callId: "c7", tool: "fetcher", attempt: 1, input: undeclared }, env, signal);
  const undeclaredFailure = j.log.at(-1)!;
  assert.deepEqual(undeclaredFailure.t === "tool.failed" && [undeclaredFailure.callId, undeclaredFailure.retryable, undeclaredFailure.failure.code, j.body(undeclaredFailure.failure.detail!)], ["c7", false, "egress-refused", "host example.org is not in the tool's egress list"]);

  const publicRunner = createToolRunner(registry, { http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl: fetch }), kb: createKbReader(memorySnapshots([loaded])) });
  const before = server.requests;
  await publicRunner.invoke(j, { callId: "c8", tool: "fetcher", attempt: 1, input: ok }, env, signal);
  assert.deepEqual(j.log.at(-2), { t: "egress.refused", destination: `http:${host}`, payload: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D0" } });
  const refusedFailure = j.log.at(-1)!;
  assert.deepEqual(refusedFailure.t === "tool.failed" && [refusedFailure.callId, refusedFailure.retryable, refusedFailure.failure.code, refusedFailure.failure.detail?.cls, j.body(refusedFailure.failure.detail!)], ["c8", false, "egress-refused", "D3", "egress refused: D3 exceeds the destination ceiling D0"]);
  assert.equal(server.requests, before, "no request left for an unlisted host");
});

test("specs render the zod input as JSON schema for the model", () => {
  const [spec] = runner.specs(["kb_search", "nonesuch"]);
  assert.equal(runner.specs(["kb_search", "nonesuch"]).length, 1);
  assert.equal(spec?.name, "kb_search");
  const schema = spec?.inputSchema as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(schema.properties), ["query", "k", "kb"]);
  assert.deepEqual(schema.required, ["query"]);
});

test("a thrown message is stored at the join of everything the tool touched, not at the input's class", async () => {
  const j = memoryJournal(RUN);
  const input = await j.put(Labelled.stamp({}, "D0", "test"));
  await runner.invoke(j, { callId: "c9", tool: "touchy", attempt: 1, input }, env, signal);
  const failed = j.log.at(-1)!;
  assert.equal(failed.t === "tool.failed" && failed.failure.code, "thrown");
  assert.equal(failed.t === "tool.failed" && failed.failure.detail?.cls, "D2", "the text can quote what the tool read (D1) and touched (D2)");
  assert.equal(failed.t === "tool.failed" && failed.failure.detail && j.body(failed.failure.detail), "record for participant 7 not found");
});
