import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LOOP_CONTRACT, type AgentId, type ResolvedAgent } from "../packages/core/src/agent.ts";
import { keyedAddresser } from "../packages/core/src/hash.ts";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import type { Surface } from "../packages/core/src/frontdoor.ts";
import { createGateway, type ExactModelId } from "../packages/core/src/gateway.ts";
import { createKbReader, memorySnapshots, snapshotFromFixture } from "../packages/core/src/kb.ts";
import { drive, type LoopDeps } from "../packages/core/src/loop.ts";
import type { LeasedJob } from "../packages/core/src/queue.ts";
import { StoreRefused, type RunEvent, type RunJournal, type ThreadKey } from "../packages/core/src/record.ts";
import { builtinTools, createHttpEgress, createToolRunner, registryOf } from "../packages/core/src/tools.ts";
import { startFakeModel } from "./fake-model.ts";
import { RUN } from "./events.ts";
import { memoryJournal } from "./recorder.ts";

const model = await startFakeModel("scripted-1", "answer");
after(() => model.close());
const loaded = snapshotFromFixture(JSON.parse(await readFile(new URL("../fixtures/kb.json", import.meta.url), "utf8")), keyedAddresser(randomBytes(32)));
const kb = createKbReader(memorySnapshots([loaded]));
const tools = createToolRunner(registryOf(builtinTools()), { http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl: fetch }), kb });
const gateway = createGateway([{ id: "local", baseUrl: model.url, placement: "lab", supportsLogprobs: false }], DEFAULT_POLICY, fetch);

const agent: ResolvedAgent = {
  schema: 2,
  agentId: "handbook" as AgentId,
  loopContract: LOOP_CONTRACT,
  instructions: "answer",
  instructionsClass: "D1",
  model: { endpointId: "local", modelId: "scripted-1" as ExactModelId, params: { temperature: 0, maxOutputTokens: 64 } },
  knowledgeBases: [{ kbId: "handbook", snapshot: loaded.snapshot.id, cls: loaded.snapshot.cls }],
  tools: [{ name: "kb_search", hash: builtinTools()[0]!.hash }],
  sandbox: null,
  retrieval: { algorithm: "bm25-v1", readCapTokens: 15_000 },
  limits: { maxSteps: 40, maxTokens: 1_000_000, maxWallMs: 600_000 },
};
const deployed = { tools: new Map([["kb_search", builtinTools()[0]!.hash]]), snapshots: new Set([loaded.snapshot.id]), sandboxImages: new Set<never>(), loopContract: LOOP_CONTRACT, retrieval: new Set(["bm25-v1"]) };

interface Harness {
  readonly journal: RunJournal & { readonly log: RunEvent[] };
  readonly job: LeasedJob;
  readonly deps: LoopDeps;
  readonly posts: string[];
}

async function harness(options: { readonly attempts?: number; readonly agent?: ResolvedAgent; readonly journal?: (j: ReturnType<typeof memoryJournal>) => RunJournal & { readonly log: RunEvent[] } } = {}): Promise<Harness> {
  const base = memoryJournal(RUN);
  const journal = options.journal ? options.journal(base) : base;
  const input = await base.put(Labelled.stamp("What are the office hours?", "D1", "gate:floor"));
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
    attempts: options.attempts ?? 0,
    payload: { agent: "a".repeat(64), kind: "interactive", trigger: { t: "message", surface: "web", messageId: "m", memberId: "alice" }, thread: "web:lab:t", surface: "web", threadId: "t", input, history: [], studyId: null },
  };
  const deps: LoopDeps = {
    gateway,
    tools,
    kb,
    surfaces: () => surface,
    policy: DEFAULT_POLICY,
    loadAgent: async () => options.agent ?? agent,
    deployed: async () => deployed,
    clock: { now: () => Date.now() },
    callSignal: () => ({ signal: new AbortController().signal, release() {} }),
    log: () => {},
  };
  return { journal, job, deps, posts };
}

const pgBlip = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
const startedEvent = (job: LeasedJob): RunEvent => ({ t: "run.started", agent: "a".repeat(64) as never, kind: "interactive", trigger: { t: "message", surface: "web", messageId: "m", memberId: "alice" }, thread: "web:lab:t" as ThreadKey, surface: "web", threadId: "t", input: (job.payload as { input: never }).input, history: [], route: { t: "direct" }, studyId: null });

test("a StoreRefused mid-run ends in exactly one run.finished failed with a typed reason and one failure reply", async () => {
  const h = await harness({
    journal: (j) => ({
      ...j,
      put: async (content) => {
        if (content.origin === "gateway:output") throw new StoreRefused({ code: "class-above-ceiling", payload: "D3", ceiling: "D2" });
        return j.put(content);
      },
    }),
  });
  assert.deepEqual(await drive(h.job, h.journal, h.deps), { t: "finished", outcome: "failed" });
  const finished = h.journal.log.filter((e) => e.t === "run.finished");
  assert.deepEqual(
    finished.map((e) => e.t === "run.finished" && [e.outcome, e.reason]),
    [["failed", { t: "store-refused", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D2" } }]],
  );
  assert.deepEqual(h.posts, ["The run failed after repeated errors. Please try again."]);
  assert.deepEqual(h.journal.log.filter((e) => e.t === "reply.posted").length, 1);
});

test("a transient error hands the job back for a bounded retry, and the exhausted bound finishes failed with the error text as a payload at the run's class", async () => {
  const blipOnce = (j: ReturnType<typeof memoryJournal>) => {
    let blips = 1;
    return {
      ...j,
      pendingInbox: async () => {
        if (blips-- > 0) throw pgBlip();
        return j.pendingInbox();
      },
    };
  };
  const first = await harness({ journal: blipOnce });
  assert.deepEqual(await drive(first.job, first.journal, first.deps), { t: "retry", error: "Connection terminated unexpectedly", progressed: true });
  assert.deepEqual(first.posts, []);
  assert.equal(first.journal.log.some((e) => e.t === "run.finished"), false);

  const last = await harness({ journal: blipOnce, attempts: 2 });
  await last.journal.append(startedEvent(last.job));
  assert.deepEqual(await drive(last.job, last.journal, last.deps), { t: "finished", outcome: "failed" });
  const finished = last.journal.log.find((e) => e.t === "run.finished");
  assert.ok(finished && finished.t === "run.finished" && finished.reason?.t === "retries-exhausted");
  assert.equal(finished.reason.attempts, 3);
  assert.equal(finished.reason.error?.cls, "D1", "the error text is stored at the run's class, not D0");
  assert.equal((await last.journal.get(finished.reason.error!)).value, "Connection terminated unexpectedly");
  assert.ok(!JSON.stringify(finished).includes("Connection terminated"), "the event holds a ref, not the text");
  assert.deepEqual(last.posts, ["The run failed after repeated errors. Please try again."]);
});

test("a blip after the run moved forward hands the job back with a fresh count, however many blips came before", async () => {
  const blipOnThird = (j: ReturnType<typeof memoryJournal>) => {
    let calls = 0;
    return {
      ...j,
      pendingInbox: async () => {
        if (++calls === 3) throw pgBlip();
        return j.pendingInbox();
      },
    };
  };
  const h = await harness({ journal: blipOnThird, attempts: 2 });
  await h.journal.append(startedEvent(h.job));
  const before = h.journal.events().length;
  assert.deepEqual(await drive(h.job, h.journal, h.deps), { t: "retry", error: "Connection terminated unexpectedly", progressed: true });
  assert.ok(h.journal.events().length > before, "a model step was journaled before the blip");
  assert.equal(h.journal.log.some((e) => e.t === "run.finished" || e.t === "run.faulted"), false, "two old blips plus one new one after progress do not end the run");
});

test("a version whose pinned tool is not the deployed one finishes unrunnable at run start, before any model call", async () => {
  const h = await harness({ agent: { ...agent, tools: [{ name: "kb_search", hash: "0".repeat(64) as never }] } });
  assert.deepEqual(await drive(h.job, h.journal, h.deps), { t: "finished", outcome: "unrunnable" });
  assert.deepEqual(
    h.journal.log.map((e) => e.t),
    ["run.started", "run.faulted", "reply.posted", "run.finished"],
  );
  const finished = h.journal.log.at(-1)!;
  assert.deepEqual(finished.t === "run.finished" && finished.reason, { t: "unrunnable", problems: [{ t: "tool-changed", tool: "kb_search", pinned: "0".repeat(64), deployed: builtinTools()[0]!.hash }] });
  assert.deepEqual(h.posts, ["This agent version cannot run on this deployment. Ask the lab manager to check it."]);
});

test("a resumed run that already recorded its fault posts once and finishes once", async () => {
  const h = await harness();
  await h.journal.append(startedEvent(h.job));
  await h.journal.append({ t: "run.faulted", reason: { t: "store-refused", refusal: { code: "review-confidential-refused" } } });
  assert.deepEqual(await drive(h.job, h.journal, h.deps), { t: "finished", outcome: "failed" });
  assert.deepEqual(
    h.journal.log.map((e) => e.t),
    ["run.started", "run.faulted", "reply.posted", "run.finished"],
  );
  assert.equal(h.posts.length, 1);
});
