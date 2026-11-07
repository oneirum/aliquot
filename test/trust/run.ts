/**
 * The deterministic half of the trust harness. Every lab1 question goes through Aliquot's own path in one process:
 * the gate's classifier stamps the message, drive() runs the real loop with the real gateway, tool runner, BM25 reader
 * and egress decisions, and the reply is what the surface would post. Only the model (test/trust/model.ts) and the
 * outside network (a recording fetch that never leaves the process) are fakes. No Postgres: the journal is in memory.
 *
 * The knowledge base is compiled from fixtures/lab1 the way the scripted compiler does (one entry per "## " section;
 * a PDF is one entry titled by its first line), after readSources has classified every source.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { LOOP_CONTRACT, type AgentId, type Deployed, type ResolvedAgent } from "../../packages/core/src/agent.ts";
import { DEFAULT_POLICY, join, Labelled, type DataClass } from "../../packages/core/src/dataclass.ts";
import type { Surface } from "../../packages/core/src/frontdoor.ts";
import { classifyText } from "../../packages/core/src/gate.ts";
import { createGateway, type ExactModelId } from "../../packages/core/src/gateway.ts";
import { keyedAddresser } from "../../packages/core/src/hash.ts";
import { createKbReader, memorySnapshots, snapshotFromFixture, type LoadedSnapshot } from "../../packages/core/src/kb.ts";
import { filesIn, parseKbDefinition, readSources, type KbDefinition } from "../../packages/core/src/kb-compile.ts";
import { drive, type LoopDeps } from "../../packages/core/src/loop.ts";
import type { LeasedJob } from "../../packages/core/src/queue.ts";
import type { RunId, ThreadKey } from "../../packages/core/src/record.ts";
import { builtinTools, createHttpEgress, createToolRunner, registryOf } from "../../packages/core/src/tools.ts";
import { memoryJournal } from "../recorder.ts";
import type { Lab1Injection, Lab1Question } from "./lab1.ts";
import { slug } from "./lab1.ts";
import { startTrustModel } from "./model.ts";

export interface Lab1Fixture {
  readonly dir: string;
  readonly definition: KbDefinition;
  readonly pattern: RegExp;
  readonly questions: readonly Lab1Question[];
  readonly injections: readonly Lab1Injection[];
  readonly pdfText: Readonly<Record<string, string>>;
}

export function loadLab1(dir: string): Lab1Fixture {
  const read = (name: string) => JSON.parse(readFileSync(joinPath(dir, name), "utf8"));
  const q = read("questions.json") as { pattern: string; questions: Lab1Question[] };
  return { dir, definition: parseKbDefinition(read("kb.json")), pattern: new RegExp(q.pattern), questions: q.questions, injections: (read("injections.json") as { injections: Lab1Injection[] }).injections, pdfText: read("pdf-text.json") };
}

export type PdfReader = (bytes: Uint8Array, name: string) => Promise<string>;

/** The PDF reader when no sandbox is asked for: the text the generator drew into each PDF's content stream. */
export const textLayer = (lab: Lab1Fixture): PdfReader => async (_bytes, name) => {
  const text = lab.pdfText[name];
  if (text === undefined) throw new Error(`${name}: no text layer recorded`);
  return text;
};

/** Every source read and classified by core's readSources, then split as the scripted compiler splits. */
export async function compileLab1(lab: Lab1Fixture, pdf: PdfReader): Promise<{ readonly snapshot: LoadedSnapshot; readonly sourceClasses: Readonly<Record<string, DataClass>> }> {
  const address = keyedAddresser(randomBytes(32));
  const http = createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl: async () => new Response("", { status: 599 }) });
  // db is only read for a URL source's refusal; lab1 has none.
  const loaded = await readSources(lab.definition, filesIn(lab.dir), { http, address, db: null as never, actor: "trust", labPatterns: [lab.pattern], pdf });
  const entries = loaded.flatMap(({ ref, text }) => {
    const sections = /^## /m.test(text) ? text.split(/^## /m).slice(1) : [text.trim()];
    return sections.map((section) => {
      const [heading = "", ...lines] = section.split("\n");
      const body = lines.join("\n").trim();
      return { path: `${ref.sourceId}/${slug(heading)}.md`, title: heading.trim(), body, facts: [{ text: body.split("\n")[0]!, sources: [{ sourceId: ref.sourceId, locator: `## ${heading.trim()}` }] }] };
    });
  });
  const cls = join(...loaded.map((l) => l.ref.cls));
  const snapshot = snapshotFromFixture({ kbId: lab.definition.kbId, title: lab.definition.title, purpose: lab.definition.purpose, cls, entries }, address);
  return { snapshot, sourceClasses: Object.fromEntries(loaded.map((l) => [l.ref.sourceId, l.ref.cls])) };
}

export type Actual = "answered" | "not-found" | "refused" | "failed";

export interface RunResult {
  readonly id: string;
  readonly actual: Actual;
  /** The gate's class for the question, and what it detected. */
  readonly cls: DataClass;
  readonly detections: readonly string[];
  /** Where the refusal happened: the gate (R content) or the egress decision before the model request. */
  readonly refusedAt: "gate" | "egress" | null;
  readonly reply: string;
  /** Requests that reached the model server during this run. */
  readonly modelRequests: number;
  /** URLs a tool asked the outside network for during this run, after the egress decision allowed them. */
  readonly egressed: readonly string[];
  /** Tool calls the model made, by name, and which were refused by egress. */
  readonly toolCalls: readonly string[];
  readonly egressRefused: number;
  /** Entry paths kb_read returned. */
  readonly read: readonly string[];
  /** The chat messages of this run's last model request, for the live tier, which replays them up to kb_read. */
  readonly answerPrompt: readonly { readonly role: string; readonly content?: string | null; readonly tool_calls?: unknown; readonly tool_call_id?: string }[] | null;
}

export const NOT_FOUND_RE = /could not find|couldn't find|not (?:in|covered by|mentioned in) the knowledge base|does not (?:cover|contain|say|mention)|do not (?:cover|contain|say|mention)|no (?:entry|information)/i;

export interface DeterministicRun {
  readonly snapshot: LoadedSnapshot;
  readonly sourceClasses: Readonly<Record<string, DataClass>>;
  readonly results: readonly RunResult[];
  readonly agentTools: readonly string[];
}

export async function runDeterministic(lab: Lab1Fixture, opts: { readonly pdf?: PdfReader; readonly only?: (q: Lab1Question) => boolean } = {}): Promise<DeterministicRun> {
  const { snapshot, sourceClasses } = await compileLab1(lab, opts.pdf ?? textLayer(lab));
  const model = await startTrustModel(lab.injections);
  const egressed: string[] = [];
  const recordingFetch = async (input: string | URL | Request) => {
    egressed.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const kb = createKbReader(memorySnapshots([snapshot]));
    const all = builtinTools();
    const agentTools = ["kb_search", "kb_read", "pubmed_search"];
    const tools = createToolRunner(registryOf(all), { http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl: recordingFetch as typeof fetch }), kb });
    // The hosted endpoint is approved for confidential data (ceiling D2): restricted (D3) content may not reach it.
    const gateway = createGateway([{ id: "hosted", baseUrl: model.url, placement: "approved", supportsLogprobs: false }], DEFAULT_POLICY, fetch);
    const hash = (name: string) => all.find((t) => t.manifest.name === name)!.hash;
    const agent: ResolvedAgent = {
      schema: 2,
      agentId: "lab1-handbook" as AgentId,
      loopContract: LOOP_CONTRACT,
      instructions: "You answer lab1 members' practical questions from the lab1 handbook.",
      instructionsClass: "D1",
      model: { endpointId: "hosted", modelId: "trust-obedient-1" as ExactModelId, params: { temperature: 0, maxOutputTokens: 1024 } },
      knowledgeBases: [{ kbId: snapshot.snapshot.kbId, snapshot: snapshot.snapshot.id, cls: snapshot.snapshot.cls }],
      tools: agentTools.map((name) => ({ name, hash: hash(name) })),
      sandbox: null,
      retrieval: { algorithm: "bm25-v1", readCapTokens: 15_000 },
      limits: { maxSteps: 8, maxTokens: 1_000_000, maxWallMs: 120_000 },
    };
    const deployed: Deployed = { tools: new Map(agentTools.map((n) => [n, hash(n)])), snapshots: new Set([snapshot.snapshot.id]), sandboxImages: new Set(), loopContract: LOOP_CONTRACT, retrieval: new Set(["bm25-v1"]) };
    const results: RunResult[] = [];
    for (const q of lab.questions) {
      if (opts.only && !opts.only(q)) continue;
      const gated = classifyText(q.question, "D1", [lab.pattern]);
      const detections = gated.detections.map((d) => d.kind);
      const before = { requests: model.requests, egressed: egressed.length };
      if (gated.cls === "R" && DEFAULT_POLICY.reviewConfidential === "refuse") {
        results.push({ id: q.id, actual: "refused", cls: gated.cls, detections, refusedAt: "gate", reply: "", modelRequests: 0, egressed: [], toolCalls: [], egressRefused: 0, read: [], answerPrompt: null });
        continue;
      }
      const runId = randomUUID() as RunId;
      const journal = memoryJournal(runId);
      const input = await journal.put(Labelled.stamp(q.question, gated.cls, detections.length ? `gate:${detections.join(",")}` : "gate:floor"));
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
        id: runId,
        kind: "run",
        key: `msg:web:lab1:${q.id}`,
        thread: `web:lab1:${q.id}` as ThreadKey,
        owner: "trust",
        epoch: 1,
        attempts: 0,
        payload: { agent: "a".repeat(64), kind: "interactive", trigger: { t: "message", surface: "web", messageId: q.id, memberId: "member" }, thread: `web:lab1:${q.id}`, surface: "web", threadId: q.id, input, history: [], studyId: null },
      };
      const deps: LoopDeps = {
        gateway,
        tools,
        kb,
        surfaces: () => surface,
        policy: DEFAULT_POLICY,
        loadAgent: async () => agent,
        deployed: async () => deployed,
        clock: { now: () => Date.now() },
        callSignal: () => ({ signal: new AbortController().signal, release() {} }),
        log: () => {},
      };
      const out = await drive(job, journal, deps);
      const events = journal.log;
      const outcome = out.t === "finished" ? out.outcome : "failed";
      const reply = posts.join("\n");
      const toolCalls = events.flatMap((e) => (e.t === "tool.requested" ? [e.tool] : []));
      const readPaths: string[] = [];
      for (const e of events) {
        if (e.t !== "tool.completed") continue;
        const body = journal.body(e.output) as { entries?: { path: string }[] } | undefined;
        if (body?.entries) readPaths.push(...body.entries.map((x) => x.path));
      }
      const actual: Actual = outcome === "refused" ? "refused" : outcome === "answered" ? (NOT_FOUND_RE.test(reply) && !/Source: /.test(reply) ? "not-found" : "answered") : "failed";
      results.push({
        id: q.id,
        actual,
        cls: gated.cls,
        detections,
        refusedAt: outcome === "refused" ? "egress" : null,
        reply,
        modelRequests: model.requests - before.requests,
        egressed: egressed.slice(before.egressed),
        toolCalls,
        egressRefused: events.filter((e) => e.t === "egress.refused").length,
        read: readPaths,
        answerPrompt: model.requests > before.requests ? (model.last?.messages ?? null) : null,
      });
    }
    return { snapshot, sourceClasses, results, agentTools };
  } finally {
    await model.close();
  }
}
