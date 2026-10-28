/**
 * Tools: the manifest a contributor writes, the context a tool runs in, and
 * the registry the harness discovers.
 *
 * Adding a tool = adding tools/<name>/tool.ts (default export defineTool(...))
 * and tools/<name>/tool.test.ts. There is no list to edit: loadRegistry()
 * discovers folders. A tool folder may import only "@labh/core/tool-kit" and
 * npm packages; test/boundaries.test.ts bans node:http, node:net and global
 * fetch outside this file and the gateway, so the folder hash covers the
 * tool's code and ctx.fetch is the only way out.
 *
 * Built-in tools (kb_search and kb_read here; skill_read and run_code in
 * later units) are defined with the same defineTool in core, so the loop has one
 * dispatch path. Their hash is the hash of their spec (toolSpecHash): what
 * the model sees plus the manifest's policy fields. The glue code around
 * them is core, which the loop contract version pins.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { decideEgress, describeRefusal, join, Labelled, placementOfHost, type DataClass, type EgressPolicy, type EgressRefusal, type Placement } from "./dataclass.ts";
import { contentHash, type EntryHash, type SnapshotId, type ToolHash } from "./hash.ts";
import type { ToolSpec } from "./gateway.ts";
import type { KbReader } from "./kb.ts";
import type { CallFailure, PayloadRef, RunEvent, RunJournal } from "./record.ts";
import { platformFetch } from "./seal.ts";

export type Effect = "read" | "lab-write" | "external-send";

export interface ToolManifest<I, O> {
  /** snake_case, equals the folder name. */
  readonly name: string;
  /** What the model reads. "Use for ..." and "Not for ..." like agent descriptions. */
  readonly description: string;
  readonly input: z.ZodType<I>;
  /** Class of what this tool returns from its source. Output class = join(reads, conversation class, anything touched). */
  readonly reads: DataClass;
  /** external-send always needs a human confirmation in the thread (loop step 3). */
  readonly effects: Effect;
  /** Hosts ctx.fetch may reach. Anything else is refused before decideEgress is even asked. */
  readonly egress: readonly string[];
  /** Safe to repeat with the same callKey. Read-only tools are treated as idempotent. */
  readonly idempotent: boolean;
  run(input: I, ctx: ToolContext): Promise<O>;
}

export interface AttachedKb {
  readonly kbId: string;
  readonly snapshot: SnapshotId;
  readonly cls: DataClass;
}

/** The part of the resolved agent the built-in tools read. Hashed, so a frozen version reads the same amount forever. */
export interface RetrievalSettings {
  readonly algorithm: "bm25-v1";
  readonly readCapTokens: number;
}

export interface ToolContext {
  readonly runId: string;
  /** `${runId}:${callId}`. Pass it to any downstream API that accepts an idempotency key. */
  readonly callKey: string;
  /** Class of the conversation that produced the input. Arguments are as sensitive as the context that wrote them. */
  readonly inputClass: DataClass;
  /** The run's knowledge bases, for the retrieval built-ins. */
  readonly knowledgeBases: readonly AttachedKb[];
  readonly retrieval: RetrievalSettings;
  readonly kb: KbReader;
  /**
   * fetch with two checks, in order: host is in manifest.egress, then
   * decideEgress(inputClass, {kind:"http", host, placementOfHost(host)}).
   * A refusal throws EgressRefused and is journaled as egress.refused.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Raises the output class: a tool that read a D2 snapshot returns D2 even for a D0 question. */
  touched(cls: DataClass): void;
  /** Journals every entry a retrieval returned, cited or not. */
  retrieved(snapshot: SnapshotId, entries: readonly EntryHash[], truncated: boolean): void;
  /** Lab storage under the data steward's allowlist. Absent unless effects is lab-write. */
  readonly labStorage?: { write(path: string, bytes: Uint8Array): Promise<void> };
  readonly signal: AbortSignal;
}

export class EgressRefused extends Error {
  readonly refusal: EgressRefusal | { readonly code: "host-not-declared"; readonly host: string };
  constructor(refusal: EgressRefused["refusal"]) {
    super(refusal.code === "host-not-declared" ? `host ${refusal.host} is not in the tool's egress list` : `egress refused: ${describeRefusal(refusal)}`);
    this.name = "EgressRefused";
    this.refusal = refusal;
  }
}

/** A tool error the agent should see as final rather than retry. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function defineTool<I, O>(manifest: ToolManifest<I, O>): ToolManifest<I, O> {
  return manifest;
}

/** What the model sees plus the policy fields, hashed. The version of a built-in; a contributed tool hashes its folder instead. */
export function toolSpecHash(m: ToolManifest<unknown, unknown>): ToolHash {
  return contentHash({ name: m.name, description: m.description, inputSchema: z.toJSONSchema(m.input, { io: "input" }), reads: m.reads, effects: m.effects, egress: m.egress, idempotent: m.idempotent }) as string as ToolHash;
}

export interface RegisteredTool {
  readonly manifest: ToolManifest<unknown, unknown>;
  readonly hash: ToolHash;
  readonly owner: string;
}

export interface ToolRegistry {
  get(name: string): RegisteredTool | undefined;
  list(): readonly RegisteredTool[];
  /** name -> hash for verifyRunnable. */
  deployed(): ReadonlyMap<string, ToolHash>;
}

export function registryOf(tools: readonly RegisteredTool[]): ToolRegistry {
  const byName = new Map(tools.map((t) => [t.manifest.name, t]));
  if (byName.size !== tools.length) throw new Error("duplicate tool names in registry");
  return {
    get: (name) => byName.get(name),
    list: () => tools,
    deployed: () => new Map(tools.map((t) => [t.manifest.name, t.hash])),
  };
}

/** Discovers tools/<name>/tool.ts, hashes each folder (sorted file paths + bytes + tool-kit version). Fails startup on duplicate names or name != folder. */
export async function loadRegistry(_toolsDir: string): Promise<ToolRegistry> {
  throw new Error("folder discovery arrives with the tools unit");
}

/**
 * Imports one tool module by path. The only computed import in core: the
 * folder loader above will use it, and the slice harness uses it to plant a
 * tool in a worker. Called after the process is sealed, so a module that
 * takes fetch at its top level takes the stub. The hash is the spec hash
 * until the folder loader hashes files.
 */
export async function importTool(path: string): Promise<RegisteredTool> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as { readonly default?: unknown };
  const m = mod.default as Partial<ToolManifest<unknown, unknown>> | undefined;
  if (!m || typeof m.name !== "string" || typeof m.run !== "function" || !m.input) throw new Error(`${path} does not default-export defineTool(...)`);
  const manifest = m as ToolManifest<unknown, unknown>;
  return { manifest, hash: toolSpecHash(manifest), owner: path };
}

export interface ToolCall {
  readonly callId: string;
  readonly tool: string;
  readonly attempt: number;
  readonly input: PayloadRef;
}

/** What a run gives its tools: the agent's knowledge bases and retrieval settings. */
export interface ToolEnv {
  readonly knowledgeBases: readonly AttachedKb[];
  readonly retrieval: RetrievalSettings;
}

/** What the loop calls. Validates input with the zod schema, builds ToolContext, journals requested/completed/failed, classifies output. */
export interface ToolRunner {
  invoke(journal: RunJournal, call: ToolCall, env: ToolEnv, signal: AbortSignal): Promise<void>;
  isRepeatable(tool: string): boolean;
  needsConfirm(tool: string): boolean;
  /** Specs for the model, in the order asked. Unknown names are left out. */
  specs(names: readonly string[]): ToolSpec[];
  readonly registry: ToolRegistry;
}

export type HttpRefused = Extract<RunEvent, { t: "egress.refused" }>;

/** Every HTTP request the harness makes outside the gateway: tool calls through ctx.fetch, and KB URL sources. */
export interface HttpEgress {
  /**
   * decideEgress(payload, {kind: "http", host, placementOfHost(host)}), then
   * the request. A refusal is recorded through `record` (the run journal, or
   * the audit stream outside a run) and thrown as EgressRefused; nothing is sent.
   */
  request(url: string, payload: Labelled<unknown>, record: (refused: HttpRefused) => Promise<void>, init?: RequestInit): Promise<Response>;
}

export interface HttpEgressDeps {
  readonly policy: EgressPolicy;
  /** Host placements from lab.toml. Unlisted hosts are public. */
  readonly hosts: Readonly<Record<string, Placement>>;
  /** The platform fetch the seal captured, unless a test injects one. Only this module and the gateway may import it. */
  readonly fetchImpl?: typeof fetch;
}

export function createHttpEgress(deps: HttpEgressDeps): HttpEgress {
  const fetchImpl = deps.fetchImpl ?? platformFetch;
  return {
    async request(url, payload, record, init) {
      const host = new URL(url).hostname.toLowerCase();
      const decision = decideEgress(payload, { kind: "http", host, placement: placementOfHost(host, deps) }, deps.policy);
      if (!decision.allow) {
        await record({ t: "egress.refused", destination: `http:${host}`, payload: payload.cls, refusal: decision.refusal });
        throw new EgressRefused(decision.refusal);
      }
      return fetchImpl(url, init);
    },
  };
}

export interface ToolRunnerDeps {
  readonly http: HttpEgress;
  readonly kb: KbReader;
}

export function createToolRunner(registry: ToolRegistry, deps: ToolRunnerDeps): ToolRunner {
  return {
    registry,
    isRepeatable: (name) => {
      const t = registry.get(name);
      return !!t && (t.manifest.idempotent || t.manifest.effects === "read");
    },
    needsConfirm: (name) => registry.get(name)?.manifest.effects === "external-send",
    specs: (names) =>
      names.flatMap((name) => {
        const t = registry.get(name);
        return t ? [{ name, description: t.manifest.description, inputSchema: z.toJSONSchema(t.manifest.input, { io: "input" }) }] : [];
      }),
    async invoke(journal, call, env, signal) {
      // Error text can quote the input, so it is a payload at the input's class; the event carries the code.
      const fail = async (code: CallFailure["code"], detail: string | null, retryable: boolean, cls: DataClass = call.input.cls) => {
        const failure: CallFailure = { code, detail: detail === null ? null : await journal.put(Labelled.stamp(detail, cls, `tool:${call.tool}:error`)) };
        await journal.record({ t: "tool.failed", callId: call.callId, attempt: call.attempt, failure, retryable });
      };
      const tool = registry.get(call.tool);
      if (!tool) {
        await journal.record({ t: "tool.requested", callId: call.callId, attempt: call.attempt, tool: call.tool, hash: "" as ToolHash, input: call.input });
        return fail("unknown-tool", null, false);
      }
      await journal.record({ t: "tool.requested", callId: call.callId, attempt: call.attempt, tool: call.tool, hash: tool.hash, input: call.input });
      const body = await journal.get(call.input);
      const parsed = tool.manifest.input.safeParse(body.value);
      if (!parsed.success) return fail("invalid-input", parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "), false, body.cls);
      const touched: DataClass[] = [tool.manifest.reads, body.cls];
      const retrieved: { snapshot: SnapshotId; entries: readonly EntryHash[]; truncated: boolean }[] = [];
      const ctx: ToolContext = {
        runId: journal.runId,
        callKey: `${journal.runId}:${call.callId}`,
        inputClass: body.cls,
        knowledgeBases: env.knowledgeBases,
        retrieval: env.retrieval,
        kb: deps.kb,
        signal,
        touched: (cls) => touched.push(cls),
        retrieved: (snapshot, entries, truncated) => retrieved.push({ snapshot, entries, truncated }),
        fetch: async (url, init) => {
          const host = new URL(url).hostname.toLowerCase();
          if (!tool.manifest.egress.some((h) => h.toLowerCase() === host)) throw new EgressRefused({ code: "host-not-declared", host });
          return deps.http.request(url, body, (refused) => journal.record(refused), { ...init, signal: init?.signal ?? signal });
        },
      };
      const startedAt = Date.now();
      let result: unknown;
      try {
        result = await tool.manifest.run(parsed.data, ctx);
      } catch (err) {
        // Once run() has started, its message can quote what the tool reads and anything it touched, like its output would.
        const seen = join(...touched);
        if (err instanceof EgressRefused) return fail("egress-refused", err.message, false, seen);
        if (err instanceof ToolInputError) return fail("invalid-input", err.message, false, seen);
        if (signal.aborted || (err as { name?: string }).name === "AbortError") return fail("aborted", null, true);
        return fail("thrown", err instanceof Error ? err.message : String(err), true, seen);
      }
      const output = Labelled.derive(result, [body], `tool:${tool.manifest.name}`, join(...touched));
      const ref = await journal.put(output);
      await journal.record({ t: "tool.completed", callId: call.callId, attempt: call.attempt, output: ref, ...(retrieved.length ? { retrieved } : {}), ms: Date.now() - startedAt });
    },
  };
}

function attachedFor(ctx: ToolContext, kb: string | undefined): AttachedKb[] {
  const attached = ctx.knowledgeBases.filter((b) => !kb || b.kbId === kb);
  if (!attached.length) throw new ToolInputError(kb ? `knowledge base ${kb} is not attached to this agent` : "this agent has no knowledge base");
  return attached;
}

export const kbSearch = defineTool({
  name: "kb_search",
  description: "Search the agent's knowledge bases and return the best matching entries by path and title. Use for any question the knowledge base might answer, then read the entries with kb_read. Not for web search.",
  input: z.object({
    query: z.string().min(1).max(500),
    k: z.number().int().min(1).max(10).default(5),
    kb: z.string().optional().describe("Limit to one knowledge base id"),
  }),
  reads: "D0",
  effects: "read",
  egress: [],
  idempotent: true,
  async run({ query, k, kb }, ctx) {
    const results: { kb: string; path: string; title: string; score: number }[] = [];
    for (const b of attachedFor(ctx, kb)) {
      const hits = await ctx.kb.search(b.snapshot, query, k);
      ctx.touched(hits.cls);
      ctx.retrieved(b.snapshot, hits.value.map((h) => h.hash), false);
      for (const h of hits.value) results.push({ kb: b.kbId, path: h.path, title: h.title, score: h.score });
    }
    results.sort((a, b) => b.score - a.score || (a.kb < b.kb ? -1 : a.kb > b.kb ? 1 : 0));
    return { results: results.slice(0, k) };
  },
});

export const kbRead = defineTool({
  name: "kb_read",
  description: "Read whole knowledge base entries by path, as listed in the outline or returned by kb_search. Use to read an entry before answering from it. Not for searching.",
  input: z.object({
    paths: z.array(z.string().min(1)).min(1).max(20),
    kb: z.string().optional().describe("The knowledge base id. Required when the agent has more than one"),
  }),
  reads: "D0",
  effects: "read",
  egress: [],
  idempotent: true,
  async run({ paths, kb }, ctx) {
    const attached = attachedFor(ctx, kb);
    if (attached.length > 1) throw new ToolInputError(`this agent has ${attached.length} knowledge bases; name one with kb`);
    const b = attached[0]!;
    const read = await ctx.kb.read(b.snapshot, paths, ctx.retrieval.readCapTokens);
    ctx.touched(read.cls);
    ctx.retrieved(b.snapshot, read.value.entries.map((e) => e.hash), read.value.truncated);
    return {
      kb: b.kbId,
      entries: read.value.entries.map((e) => ({ path: e.path, title: e.title, body: e.body, facts: e.facts })),
      ...(read.value.truncated ? { omitted: read.value.omitted, note: `The read cap is ${ctx.retrieval.readCapTokens} tokens. The omitted paths were not read; read them in a separate call.` } : {}),
      ...(read.value.missing.length ? { missing: read.value.missing } : {}),
    };
  },
});

export function builtinTools(): RegisteredTool[] {
  return [kbSearch, kbRead].map((t) => {
    const manifest = t as ToolManifest<unknown, unknown>;
    return { manifest, hash: toolSpecHash(manifest), owner: "core" };
  });
}

/**
 * run_code sandbox (built-in, later unit). One container per call via the
 * Docker Engine API over its unix socket (node:http, no client library):
 * image pinned by digest (R + Python), --network none, read-only mounts from
 * the steward's allowlist with cls <= agent.sandbox.mountCeiling, a per-thread
 * workspace volume so a thread keeps "its own computer", CPU/memory/time caps.
 * Output class = join(mount classes, inputClass).
 */
export interface SandboxRequest {
  readonly language: "r" | "python";
  readonly code: string;
  readonly mounts: readonly string[];
  readonly timeoutMs: number;
}
