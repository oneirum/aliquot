import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LOOP_CONTRACT, modelFor, parseAgentDocument, resolveAgent, verifyRunnable, versionHash, type AgentId, type Catalog, type ResolvedAgent } from "../packages/core/src/agent.ts";
import { parseConfig } from "../packages/core/src/config.ts";
import { DEFAULT_POLICY, Labelled, type DataClass } from "../packages/core/src/dataclass.ts";
import type { Surface } from "../packages/core/src/frontdoor.ts";
import { createGateway, type ExactModelId } from "../packages/core/src/gateway.ts";
import type { SnapshotId, ToolHash } from "../packages/core/src/hash.ts";
import { createKbReader, memorySnapshots } from "../packages/core/src/kb.ts";
import { drive, type LoopDeps } from "../packages/core/src/loop.ts";
import type { LeasedJob } from "../packages/core/src/queue.ts";
import type { RunEvent, ThreadKey } from "../packages/core/src/record.ts";
import { z } from "zod";
import { builtinTools, createHttpEgress, createToolRunner, defineTool, registryOf, type ToolManifest } from "../packages/core/src/tools.ts";
import { startFakeModel } from "./fake-model.ts";
import { startFakeProvider } from "./fake-provider.ts";
import { RUN } from "./events.ts";
import { memoryJournal } from "./recorder.ts";
import * as A from "./provider-fixtures/anthropic-messages.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/agent.json", import.meta.url), "utf8")) as Record<string, unknown>;

const catalog: Catalog = {
  latestSkill: () => undefined,
  dataset: () => undefined,
  latestSnapshot: (kbId) => (kbId === "handbook" ? { id: "s".repeat(64) as SnapshotId, cls: "D1" } : undefined),
  tool: (name) => (name === "kb_search" || name === "kb_read" ? { hash: name.padEnd(64, "t") as ToolHash, reads: "D0", effects: "read" } : undefined),
  endpoint: (id) => (id === "local" ? { placement: "lab" } : id === "hosted" ? { placement: "zdr" } : id === "claude-cli" ? { placement: "public", agentCli: { kind: "claude-code", cliVersion: "2.1.303" } } : undefined),
  sandboxImage: () => undefined,
};
const params = { temperature: 0, maxOutputTokens: 1024 };
const band = (upTo: DataClass, endpointId: string, modelId: string) => ({ upTo, model: { endpointId, modelId, params } });
const resolve = (overrides: Record<string, unknown>) => {
  const parsed = parseAgentDocument({ ...fixture, ...overrides });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return resolveAgent(parsed.doc, catalog);
};
const errors = (overrides: Record<string, unknown>) => {
  const r = resolve(overrides);
  return r.ok ? [] : r.issues.map((i) => `${i.field}: ${i.message}`);
};

test("the fixture's version hash is the one it had before bands and native providers existed", () => {
  const r = resolve({});
  assert.ok(r.ok);
  assert.equal("modelsByClass" in r.agent, false);
  assert.equal(versionHash(r.agent), "d1d1b21ce2857a7052283160d26f2c99bd9252f9b3e742079ffc1ac0efeda970");
  const empty = resolve({ modelsByClass: [] });
  assert.ok(empty.ok);
  assert.equal(versionHash(empty.agent), versionHash(r.agent), "an empty band list is the same version");
});

test("bands resolve lowest first, each target pinned, and are in the hash", () => {
  const r = resolve({ modelsByClass: [band("D0", "hosted", "hosted-1"), band("D1", "hosted", "hosted-2")] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.agent.modelsByClass, [
    { upTo: "D0", target: { endpointId: "hosted", modelId: "hosted-1", params } },
    { upTo: "D1", target: { endpointId: "hosted", modelId: "hosted-2", params } },
  ]);
  assert.notEqual(versionHash(r.agent), versionHash((resolve({}) as { agent: ResolvedAgent }).agent));
});

test("bands out of order, a band above its endpoint's ceiling, an alias, and an agent CLI are publish errors", () => {
  assert.deepEqual(errors({ modelsByClass: [band("D2", "local", "scripted-1"), band("D1", "hosted", "hosted-2")] }), ["modelsByClass: band 2 is up to D1, which does not climb above band 1 (D2); list bands from the least restricted class up"]);
  assert.deepEqual(errors({ modelsByClass: [band("D1", "hosted", "hosted-2"), band("D1", "local", "scripted-1")] }), ["modelsByClass: band 2 is up to D1, which does not climb above band 1 (D1); list bands from the least restricted class up"]);
  assert.deepEqual(errors({ modelsByClass: [band("D2", "hosted", "hosted-2")] }), ["modelsByClass: band 1 is up to D2, but hosted is placement zdr (up to D1)"]);
  assert.deepEqual(errors({ modelsByClass: [band("D1", "hosted", "hosted:latest")] }), ['modelsByClass: band 1: "hosted:latest" floats to the latest version; name an exact version']);
  assert.deepEqual(errors({ modelsByClass: [band("D1", "claude-cli", "claude-opus-5-5")] }), ["modelsByClass: band 1: claude-cli is an agent CLI; a band needs a model endpoint"]);
});

test("model is the top band: a band that reaches the ceiling is a publish error, and model serves every class past the last band", () => {
  assert.deepEqual(errors({ modelsByClass: [band("D1", "hosted", "hosted-2"), band("D3", "local", "scripted-1")] }), [
    "modelsByClass: band 2 is up to D3, which reaches the ceiling D3; the model above answers every class past the last band, so a band stops below the ceiling",
  ]);
  const r = resolve({ modelsByClass: [band("D1", "hosted", "hosted-2")] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(
    (["D0", "D1", "D2", "D3"] as const).map((cls) => modelFor(r.agent, cls).endpointId),
    ["hosted", "hosted", "local", "local"],
  );
});

test("modelsByClass and agentCli are mutually exclusive", () => {
  const cli = { model: { endpointId: "claude-cli", modelId: "claude-opus-5-5", params }, ceiling: "D0", knowledgeBases: [], tools: [] };
  const plain = resolve(cli);
  assert.ok(plain.ok, JSON.stringify(plain));
  assert.equal("agentCli" in plain.agent && !("modelsByClass" in plain.agent), true);
  assert.deepEqual(errors({ ...cli, modelsByClass: [band("D1", "hosted", "hosted-2")] }), ["modelsByClass: claude-cli is an agent CLI, which runs every class itself; remove the bands or pick a model endpoint"]);
});

test("verifyRunnable checks every band's target and model against what their endpoints serve", () => {
  const r = resolve({ modelsByClass: [band("D1", "hosted", "hosted-2")] });
  assert.ok(r.ok);
  const deployed = { tools: new Map([["kb_search", "kb_search".padEnd(64, "t") as ToolHash], ["kb_read", "kb_read".padEnd(64, "t") as ToolHash]]), snapshots: new Set(["s".repeat(64) as SnapshotId]), sandboxImages: new Set<never>(), loopContract: LOOP_CONTRACT, retrieval: new Set(["bm25-v1"]) };
  assert.deepEqual(verifyRunnable(r.agent, { ...deployed, served: new Map([["hosted", new Set(["hosted-2"])], ["local", new Set(["scripted-1"])]]) }), []);
  assert.deepEqual(verifyRunnable(r.agent, { ...deployed, served: new Map([["hosted", new Set<string>()], ["local", new Set(["scripted-1"])]]) }), [{ t: "model-unavailable", modelId: "hosted-2" }]);
  assert.deepEqual(verifyRunnable(r.agent, { ...deployed, served: new Map([["hosted", new Set(["hosted-2"])], ["local", new Set<string>()]]) }), [{ t: "model-unavailable", modelId: "scripted-1" }]);
});

test("lab.toml reads protocol and sampling, and defaults to openai-chat with sampling unset", () => {
  const c = parseConfig(
    `[endpoints.anthropic]
base_url = "https://api.anthropic.com"
placement = "approved"
protocol = "anthropic-messages"
sampling = true
api_key_env = "ANTHROPIC_API_KEY"

[endpoints.local]
base_url = "http://localhost:11434/v1"
placement = "lab"
`,
    "/lab/lab.toml",
  );
  assert.deepEqual(
    c.endpoints.map((e) => [e.id, e.protocol, e.sampling ?? "unset"]),
    [
      ["anthropic", "anthropic-messages", true],
      ["local", "openai-chat", "unset"],
    ],
  );
  assert.throws(() => parseConfig(`[endpoints.x]\nbase_url = "http://x"\nplacement = "lab"\nprotocol = "gemini"\n`, "/lab/lab.toml"));
});

// The loop: a hosted Anthropic band for D0 and D1; model, on the lab OpenAI-compatible endpoint, serves D2 and D3.
const lab = await startFakeModel("scripted-1", "answer");
const claude = await startFakeProvider();
after(async () => {
  await lab.close();
  await claude.close();
});
const gateway = createGateway(
  [
    { id: "local", baseUrl: lab.url, placement: "lab", supportsLogprobs: false },
    { id: "hosted", baseUrl: claude.url, placement: "zdr", supportsLogprobs: false, protocol: "anthropic-messages" },
  ],
  DEFAULT_POLICY,
  fetch,
);
const target = (endpointId: string, modelId: string) => ({ endpointId, modelId: modelId as ExactModelId, params: { temperature: 0, maxOutputTokens: 64 } });
const banded = (bands: ResolvedAgent["modelsByClass"]): ResolvedAgent => ({
  schema: 2,
  agentId: "handbook" as AgentId,
  loopContract: LOOP_CONTRACT,
  instructions: "answer",
  instructionsClass: "D0",
  model: target("local", "scripted-1"),
  knowledgeBases: [],
  tools: [],
  sandbox: null,
  retrieval: { algorithm: "bm25-v1", readCapTokens: 15_000 },
  limits: { maxSteps: 40, maxTokens: 1_000_000, maxWallMs: 600_000 },
  modelsByClass: bands,
});
const twoBands = banded([{ upTo: "D1", target: target("hosted", A.MODEL) }]);

async function run(agent: ResolvedAgent, cls: DataClass, registry = registryOf(builtinTools())): Promise<{ outcome: unknown; events: RunEvent[]; posts: string[] }> {
  const journal = memoryJournal(RUN);
  const input = await journal.put(Labelled.stamp("What are the office hours?", cls, "gate:floor"));
  const posts: string[] = [];
  const surface: Surface = {
    id: "web" as Surface["id"],
    placement: "lab",
    startStream: async () => ({ push() {}, close: async () => false }),
    finalize: async (_runId, _threadId, text) => {
      posts.push(text);
      return { mode: "final-post", messageId: String(posts.length) };
    },
    askConfirm: async () => {},
    linkTo: () => "http://localhost/run",
  };
  const job: LeasedJob = {
    id: RUN,
    kind: "run",
    key: "msg:web:lab:t:m",
    thread: "web:lab:t" as ThreadKey,
    owner: "A",
    epoch: 1,
    attempts: 0,
    payload: { agent: "a".repeat(64), kind: "interactive", trigger: { t: "message", surface: "web", messageId: "m", memberId: "alice" }, thread: "web:lab:t", surface: "web", threadId: "t", input, history: [], studyId: null },
  };
  const kb = createKbReader(memorySnapshots([]));
  const deps: LoopDeps = {
    gateway,
    tools: createToolRunner(registry, { http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl: fetch }), kb }),
    kb,
    surfaces: () => surface,
    policy: DEFAULT_POLICY,
    loadAgent: async () => agent,
    deployed: async () => ({ tools: registry.deployed(), snapshots: new Set(), sandboxImages: new Set(), loopContract: LOOP_CONTRACT, retrieval: new Set(["bm25-v1"]) }),
    clock: { now: () => Date.now() },
    callSignal: () => ({ signal: new AbortController().signal, release() {} }),
    log: () => {},
  };
  const outcome = await drive(job, journal, deps);
  return { outcome, events: journal.log, posts };
}

const requested = (events: RunEvent[]) => events.flatMap((e) => (e.t === "model.requested" ? [`${e.target.endpointId}/${e.target.modelId}`] : []));

test("a D0 question goes to the first band, the hosted Anthropic model", async () => {
  claude.reply("POST /v1/messages", { body: A.answer });
  const labBefore = lab.requests;
  const r = await run(twoBands, "D0");
  assert.deepEqual([r.outcome, requested(r.events), r.posts], [{ t: "finished", outcome: "answered" }, [`hosted/${A.MODEL}`], ["The office is open 9 to 5."]]);
  assert.equal(lab.requests, labBefore);
});

test("a D3 question skips the hosted band and goes to model on the lab endpoint", async () => {
  const hostedBefore = claude.sent.length;
  const r = await run(twoBands, "D3");
  assert.deepEqual([r.outcome, requested(r.events)], [{ t: "finished", outcome: "answered" }, ["local/scripted-1"]]);
  assert.equal(claude.sent.length, hostedBefore, "no request reached the hosted band");
});

test("a class model's endpoint may not receive is refused before any network call", async () => {
  const hostedModel: ResolvedAgent = { ...banded([{ upTo: "D0", target: target("hosted", A.MODEL) }]), model: target("hosted", A.MODEL) };
  const hostedBefore = claude.sent.length;
  const labBefore = lab.requests;
  const r = await run(hostedModel, "D2");
  assert.deepEqual(r.outcome, { t: "finished", outcome: "refused" });
  assert.deepEqual(r.events.filter((e) => e.t === "egress.refused").map((e) => e.t === "egress.refused" && [e.destination, e.payload]), [["model:hosted", "D2"]]);
  assert.deepEqual(requested(r.events), []);
  assert.deepEqual([claude.sent.length, lab.requests], [hostedBefore, labBefore]);
});

test("a refused turn ends the run failed and never posts the partial text", async () => {
  claude.reply("POST /v1/messages", { body: A.refusal });
  const before = claude.sent.length;
  const r = await run(twoBands, "D0");
  assert.deepEqual([r.outcome, r.posts, claude.sent.length - before], [{ t: "finished", outcome: "failed" }, ["The run failed after repeated errors. Please try again."], 1]);
  const finished = r.events.find((e) => e.t === "run.finished");
  assert.deepEqual(finished?.t === "run.finished" && [finished.answer, finished.reason], [null, { t: "model-exhausted", attempts: 1 }]);
});

test("the loop stores the provider's whole tool turn and sends it back unchanged on the next call", async () => {
  claude.reply("POST /v1/messages", { body: A.interleaved }, { body: A.answer });
  const withTool: ResolvedAgent = { ...twoBands, tools: [{ name: "kb_search", hash: builtinTools()[0]!.hash }] };
  const before = claude.sent.length;
  const r = await run(withTool, "D0");
  assert.deepEqual(r.outcome, { t: "finished", outcome: "answered" });
  const second = claude.sent[before + 1]!.body as { messages: { role: string; content: { type: string }[] }[] };
  assert.deepEqual(second.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(second.messages[1]!.content, [
    { type: "thinking", thinking: "", signature: "sig-opaque-s1" },
    { type: "text", text: "First. " },
    { type: "tool_use", id: "toolu_1", name: "kb_search", input: { query: "office hours" } },
    { type: "thinking", thinking: "", signature: "sig-opaque-s2" },
    { type: "text", text: "Second." },
    { type: "tool_use", id: "toolu_2", name: "kb_search", input: { query: "holidays" } },
  ]);
  assert.deepEqual(second.messages[2]!.content.map((b) => b.type), ["tool_result", "tool_result"]);
  const completed = r.events.find((e) => e.t === "model.completed");
  assert.equal(completed?.t === "model.completed" && completed.providerState?.cls, "D0");
});

test("a class that rises mid-run moves the next call to model on the lab endpoint, and nothing restricted reaches the hosted band", async () => {
  const SECRET = "P-00042 missed visit 3";
  const cohort = defineTool({ name: "cohort_lookup", description: "Reads the cohort. Use for visits. Not for anything else.", input: z.object({ id: z.string() }), reads: "D3", effects: "read", egress: [], idempotent: true, run: async () => SECRET });
  const hash = "c".repeat(64) as ToolHash;
  const registry = registryOf([...builtinTools(), { manifest: cohort as ToolManifest<unknown, unknown>, hash, owner: "test" }]);
  const asksCohort = { ...A.toolUse, content: [{ type: "thinking", thinking: "", signature: "sig-hosted-only" }, { type: "tool_use", id: "toolu_C", name: "cohort_lookup", input: { id: "42" } }] };
  claude.reply("POST /v1/messages", { body: asksCohort });
  const hostedBefore = claude.sent.length;
  const labBodies = lab.bodies.length;
  const r = await run({ ...twoBands, tools: [{ name: "cohort_lookup", hash }] }, "D0", registry);
  assert.deepEqual([r.outcome, requested(r.events)], [{ t: "finished", outcome: "answered" }, [`hosted/${A.MODEL}`, "local/scripted-1"]]);
  assert.equal(claude.sent.length - hostedBefore, 1, "the hosted band saw only the D0 call");
  assert.equal(claude.sent.at(-1)!.raw.includes("P-00042"), false);
  const toLab = JSON.stringify(lab.bodies.slice(labBodies));
  assert.deepEqual([toLab.includes(SECRET), toLab.includes("sig-hosted-only"), toLab.includes("thinking")], [true, false, false]);
});

test("a 400 from a native provider ends the run after one attempt", async () => {
  claude.reply("POST /v1/messages", { status: 400, body: A.invalidRequest });
  const before = claude.sent.length;
  const r = await run(twoBands, "D0");
  assert.deepEqual([r.outcome, claude.sent.length - before, r.events.filter((e) => e.t === "model.failed").length], [{ t: "finished", outcome: "failed" }, 1, 1]);
});

test("a failed tool call goes back to Claude as a tool_result with is_error", async () => {
  const badInput = { ...A.toolUse, content: [{ type: "tool_use", id: "toolu_B", name: "kb_search", input: { k: "three" } }] };
  claude.reply("POST /v1/messages", { body: badInput }, { body: A.answer });
  const before = claude.sent.length;
  const r = await run({ ...twoBands, tools: [{ name: "kb_search", hash: builtinTools()[0]!.hash }] }, "D0");
  assert.deepEqual(r.outcome, { t: "finished", outcome: "answered" });
  const second = claude.sent[before + 1]!.body as { messages: { content: { type: string; is_error?: boolean }[] }[] };
  assert.deepEqual(second.messages[2]!.content.map((b) => [b.type, b.is_error ?? false]), [["tool_result", true]]);
});

test("a run at its limit keeps the system prompt the replayed thinking was signed over, and asks for the answer as user text", async () => {
  claude.reply("POST /v1/messages", { body: A.interleaved }, { body: A.answer });
  const atLimit: ResolvedAgent = { ...twoBands, tools: [{ name: "kb_search", hash: builtinTools()[0]!.hash }], limits: { ...twoBands.limits, maxSteps: 1 } };
  const before = claude.sent.length;
  const r = await run(atLimit, "D0");
  assert.deepEqual(r.outcome, { t: "finished", outcome: "limit" });
  const [first, last] = [claude.sent[before]!.body, claude.sent[before + 1]!.body] as { system: string; tool_choice: unknown; messages: { role: string; content: { type: string; text?: string }[] }[] }[];
  assert.equal(last!.system, first!.system);
  assert.deepEqual(last!.tool_choice, { type: "none" });
  assert.deepEqual(last!.messages.at(-1)!.content.at(-1), { type: "text", text: "You have reached this run's limit. Answer now with what you have, without calling tools." });
});
