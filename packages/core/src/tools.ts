/**
 * Tools: the manifest a tool declares, the context it runs in, the registry,
 * and the built-ins. Every tool Aliquot runs is in core: kb_search, kb_read,
 * dataset_list, run_code, openalex_search, pubmed_search and arxiv_search
 * here, and the v0.3 literature tools in literature.ts. A lab cannot add its
 * own; lab.toml refuses a [tools] table (config.ts).
 *
 * A built-in's hash is the hash of its spec (toolSpecHash): what the model
 * sees plus the manifest's policy fields. It does not cover the tool's code,
 * so a change to a tool's code alone moves no agent version.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { decideEgress, describeRefusal, join, Labelled, placementOfHost, type DataClass, type EgressPolicy, type EgressRefusal, type Placement } from "./dataclass.ts";
import { contentHash, type EntryHash, type SnapshotId, type ToolHash } from "./hash.ts";
import type { Dataset } from "./config.ts";
import { checkMount, listFiles, mountable, type MountPolicy } from "./datasets.ts";
import type { Sandbox } from "./sandbox.ts";
import type { ToolSpec } from "./gateway.ts";
import type { KbReader } from "./kb.ts";
import type { CallFailure, PayloadRef, RunEvent, RunJournal } from "./record.ts";
import { parseAtom } from "./atom.ts";
import { platformFetch } from "./seal.ts";
import { citationWalk, doiLookup, europepmcFulltext, europepmcSearch } from "./literature.ts";

export type Effect = "read" | "lab-write" | "external-send";

export interface ToolManifest<I, O> {
  /** snake_case. */
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
  /** The lab's polite-pool contact email from lab.toml [research], or null. Lab config, not run content. */
  readonly contact: string | null;
  /**
   * fetch with two checks, in order, on the URL and again on each redirect hop: host is in manifest.egress, then
   * decideEgress(the join of the input and everything the tool has read or touched so far, {kind:"http", host, placementOfHost(host)}).
   * A refusal throws EgressRefused and is journaled as egress.refused; a hop followed is journaled as egress.redirected.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Raises the output class: a tool that read a D2 snapshot returns D2 even for a D0 question. */
  touched(cls: DataClass): void;
  /** Journals every entry a retrieval returned, cited or not. Only for a snapshot attached to the agent. */
  retrieved(snapshot: SnapshotId, entries: readonly EntryHash[], truncated: boolean): void;
  /** Lab storage under the data steward's allowlist. Absent unless effects is lab-write. */
  readonly labStorage?: { write(path: string, bytes: Uint8Array): Promise<void> };
  readonly signal: AbortSignal;
}

export class EgressRefused extends Error {
  readonly refusal: EgressRefusal;
  constructor(refusal: EgressRefusal) {
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

/** What the model sees plus the policy fields, hashed: the version of a tool. */
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
  if (byName.size !== tools.length) {
    const dupes = [...new Set(tools.map((t) => t.manifest.name).filter((n, i, all) => all.indexOf(n) !== i))];
    throw new Error(`duplicate tool names in registry: ${dupes.map((n) => `${n} (${tools.filter((t) => t.manifest.name === n).map((t) => t.owner).join(", ")})`).join("; ")}`);
  }
  return {
    get: (name) => byName.get(name),
    list: () => tools,
    deployed: () => new Map(tools.map((t) => [t.manifest.name, t.hash])),
  };
}

/**
 * Imports one tool module by path, for the test harnesses' --plant-tool only.
 * Called after the process is sealed, so a module that takes fetch at its top
 * level takes the stub. The hash is the spec hash.
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

/** What a run gives its tools: the agent's knowledge bases, retrieval settings and sandbox mounts. */
export interface ToolEnv {
  readonly knowledgeBases: readonly AttachedKb[];
  readonly retrieval: RetrievalSettings;
  readonly sandbox: MountPolicy | null;
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
export type HttpRedirected = Extract<RunEvent, { t: "egress.redirected" }>;

/** How many redirects one request may follow. */
export const MAX_REDIRECTS = 5;
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Every HTTP request the harness makes outside the gateway: tool calls through ctx.fetch, and KB URL sources. */
export interface HttpEgress {
  /**
   * For the URL and for each redirect hop: the host must be in `declared`, when given, then
   * decideEgress(payload, {kind: "http", host, placementOfHost(host)}), then the request. A refusal is recorded
   * through `record` (the run journal, or the audit stream outside a run) and thrown as EgressRefused; nothing is
   * sent. Each hop followed is recorded before it is sent. With `redirect: "manual"` the caller gets the 3xx instead.
   */
  request(url: string, payload: Labelled<unknown>, record: (event: HttpRefused | HttpRedirected) => Promise<void>, init?: RequestInit, declared?: readonly string[]): Promise<Response>;
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
    async request(url, payload, record, init = {}, declared) {
      const mode = init.redirect ?? "follow";
      let target = new URL(url);
      let hopInit: RequestInit = { ...init, redirect: "manual" };
      let followed: HttpRedirected | null = null;
      for (let hop = 0; ; hop++) {
        const host = target.hostname.toLowerCase();
        const refusal: EgressRefusal | null = declared && !declared.some((h) => h.toLowerCase() === host) ? { code: "host-not-declared", host } : null;
        const decision = refusal ? { allow: false as const, refusal } : decideEgress(payload, { kind: "http", host, placement: placementOfHost(host, deps) }, deps.policy);
        if (!decision.allow) {
          await record({ t: "egress.refused", destination: `http:${host}`, payload: payload.cls, refusal: decision.refusal });
          throw new EgressRefused(decision.refusal);
        }
        if (followed) await record(followed);
        const res = await fetchImpl(target.href, hopInit);
        const location = res.headers.get("location");
        if (mode === "manual" || !REDIRECTS.has(res.status) || location === null) return res;
        await res.body?.cancel();
        if (mode === "error") throw new TypeError(`${url}: HTTP ${res.status} redirects, and the request does not follow redirects`);
        if (hop === MAX_REDIRECTS) throw new Error(`${url}: more than ${MAX_REDIRECTS} redirects`);
        const next = new URL(location, target);
        if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error(`${url}: a redirect to ${next.protocol} is not followed`);
        hopInit = nextHop(hopInit, res.status, target, next);
        followed = { t: "egress.redirected", from: `http:${host}`, to: `http:${next.hostname.toLowerCase()}`, status: res.status };
        target = next;
      }
    },
  };
}

/** The fetch standard's rules for the next hop: 303, and 301 or 302 after a POST, become a bodiless GET, and credentials stay with their origin. */
function nextHop(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const toGet = (status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST");
  const headers = new Headers(init.headers);
  if (toGet) for (const h of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(h);
  if (from.origin !== to.origin) for (const h of ["authorization", "cookie", "proxy-authorization"]) headers.delete(h);
  const { body: _body, ...rest } = init;
  return { ...rest, headers, ...(toGet ? { method: "GET" } : init.body !== undefined ? { body: init.body } : {}) };
}

export interface ToolRunnerDeps {
  readonly http: HttpEgress;
  readonly kb: KbReader;
  readonly contact?: string | null;
  readonly datasets?: readonly Dataset[];
  readonly sandbox?: Sandbox | null;
}

/** What only core's own tools reach: the agent's mountable datasets and the container runner. */
interface CoreScope {
  readonly datasets: readonly Dataset[];
  readonly sandbox: Sandbox | null;
}

/** Keyed by the context the runner built for a core tool, so any other tool, whose context is never a key, cannot reach the sandbox. */
const coreScopes = new WeakMap<ToolContext, CoreScope>();

function coreScope(ctx: ToolContext): CoreScope {
  const scope = coreScopes.get(ctx);
  if (!scope) throw new Error("only core's own tools may use the sandbox");
  return scope;
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
      // A tool sees only its agent's snapshots, and whatever it reads counts toward its output and its requests without the tool saying so.
      const attached = new Set(env.knowledgeBases.map((b) => b.snapshot));
      const own = (snapshot: SnapshotId): void => {
        if (!attached.has(snapshot)) throw new ToolInputError(`snapshot ${snapshot} is not attached to this agent`);
      };
      const seen = async <T>(read: Promise<Labelled<T>>): Promise<Labelled<T>> => {
        const r = await read;
        touched.push(r.cls);
        return r;
      };
      const kb: KbReader = {
        has: async (snapshot) => attached.has(snapshot) && deps.kb.has(snapshot),
        outline: (snapshot) => (own(snapshot), seen(deps.kb.outline(snapshot))),
        read: (snapshot, paths, cap) => (own(snapshot), seen(deps.kb.read(snapshot, paths, cap))),
        search: (snapshot, query, k) => (own(snapshot), seen(deps.kb.search(snapshot, query, k))),
      };
      const ctx: ToolContext = {
        runId: journal.runId,
        callKey: `${journal.runId}:${call.callId}`,
        inputClass: body.cls,
        knowledgeBases: env.knowledgeBases,
        retrieval: env.retrieval,
        kb,
        contact: deps.contact ?? null,
        signal,
        touched: (cls) => touched.push(cls),
        retrieved: (snapshot, entries, truncated) => (own(snapshot), retrieved.push({ snapshot, entries, truncated })),
        fetch: async (url, init) => {
          // A request can carry anything the tool has read so far, not only its input.
          const payload = Labelled.derive(body.value, [body], `tool:${tool.manifest.name}`, join(...touched));
          return deps.http.request(url, payload, (event) => journal.record(event), { ...init, signal: init?.signal ?? signal }, tool.manifest.egress);
        },
      };
      if (tool.owner === "core") coreScopes.set(ctx, { datasets: mountable(env.sandbox, deps.datasets ?? []), sandbox: deps.sandbox ?? null });
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

export const DATASET_FILES_LISTED = 100;

export const datasetList = defineTool({
  name: "dataset_list",
  description: "List the lab datasets this agent may mount in run_code: id, data class, description and file names. Use before run_code to find the dataset and file to read. Not for reading data.",
  input: z.object({}),
  reads: "D0",
  effects: "read",
  egress: [],
  idempotent: true,
  async run(_input, ctx) {
    const datasets = await Promise.all(
      coreScope(ctx).datasets.map(async (d) => {
        // File names and descriptions are the dataset's content: lab exports often carry participant ids in them.
        ctx.touched(d.cls);
        const { files, more } = await listFiles(d, DATASET_FILES_LISTED);
        return { id: d.id, class: d.cls, description: d.description, files, ...(more ? { note: `Only the first ${DATASET_FILES_LISTED} files are listed.` } : {}) };
      }),
    );
    return { datasets };
  },
});

export const runCode = defineTool({
  name: "run_code",
  description:
    "Run R or Python in a container with no network. Each named dataset is mounted read-only at /data/<id>; write result files to /out to get them back. Use for computing over lab datasets. Not for installing packages or reaching the internet.",
  input: z.object({
    language: z.enum(["r", "python"]),
    code: z.string().min(1).max(64 * 1024),
    datasets: z.array(z.string()).max(10).default([]).describe("Dataset ids from dataset_list"),
  }),
  reads: "D0",
  effects: "read",
  egress: [],
  idempotent: true,
  async run({ language, code, datasets }, ctx) {
    const scope = coreScope(ctx);
    if (!scope.sandbox) throw new ToolInputError("this agent has no code sandbox");
    const mounts: { id: string; hostPath: string }[] = [];
    for (const id of new Set(datasets)) {
      const d = scope.datasets.find((x) => x.id === id);
      if (!d) throw new ToolInputError(`dataset ${id} is not one this agent may mount; dataset_list names those it may`);
      ctx.touched(d.cls);
      const check = await checkMount(d);
      if (!check.ok) throw new ToolInputError(check.reason);
      mounts.push({ id, hostPath: check.hostPath });
    }
    return scope.sandbox.run({ language, code, mounts }, ctx.signal);
  },
});


export const openalexSearch = defineTool({
  name: "openalex_search",
  description:
    "Search OpenAlex for scholarly works by keywords. Use for finding papers on a topic. Not for full text or for looking up a known DOI.",
  input: z.object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  reads: "D0",
  effects: "read",
  egress: ["api.openalex.org"],
  idempotent: true,
  async run({ query, limit }, ctx) {
    // ctx.fetch refuses if this run's conversation is above D0 (api.openalex.org is placement "public").
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}${ctx.contact ? `&mailto=${encodeURIComponent(ctx.contact)}` : ""}`;
    const res = await ctx.fetch(url, { signal: ctx.signal });
    if (!res.ok) throw new Error(`OpenAlex returned ${res.status}`);
    const body = (await res.json()) as { results: { id: string; title: string; publication_year: number; doi: string | null }[] };
    return body.results.map((w) => ({ id: w.id, title: w.title, year: w.publication_year, doi: w.doi }));
  },
});

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

interface Summary {
  readonly uid: string;
  readonly title: string;
  readonly source: string;
  readonly pubdate: string;
  readonly authors?: readonly { readonly name: string }[];
  readonly elocationid?: string;
  readonly articleids?: readonly { readonly idtype: string; readonly value: string }[];
}

export const pubmedSearch = defineTool({
  name: "pubmed_search",
  description:
    "Search PubMed for biomedical articles by keywords or a PubMed query. Returns PMID, title, journal, year, the first three authors and the DOI. Use for clinical, biomedical and health research. Not for full text or for preprints (use arxiv_search).",
  input: z.object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  reads: "D0",
  effects: "read",
  egress: ["eutils.ncbi.nlm.nih.gov"],
  idempotent: true,
  async run({ query, limit }, ctx) {
    // NCBI's polite pool asks callers to name their tool and a contact.
    const polite = ctx.contact ? `&tool=aliquot&email=${encodeURIComponent(ctx.contact)}` : "";
    const get = async (path: string) => {
      const res = await ctx.fetch(`${EUTILS}/${path}&retmode=json${polite}`, { signal: ctx.signal });
      if (!res.ok) throw new Error(`PubMed returned ${res.status}`);
      return res.json();
    };
    // eutils can answer 200 with an ERROR field in place of the list. Retrying the same query gets the same answer.
    const refused = (body: { error?: string; esearchresult?: { ERROR?: string } } | null, what: string) => new ToolInputError(`PubMed refused the ${what}: ${body?.esearchresult?.ERROR ?? body?.error ?? "no result list in the answer"}`);
    const found = (await get(`esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}`)) as { esearchresult?: { idlist?: string[]; ERROR?: string }; error?: string } | null;
    const ids = found?.esearchresult?.idlist;
    if (!Array.isArray(ids)) throw refused(found, "search");
    if (!ids.length) return [];
    const summaries = (await get(`esummary.fcgi?db=pubmed&id=${ids.join(",")}`)) as { result?: Record<string, Summary> & { uids: string[] }; error?: string } | null;
    if (!Array.isArray(summaries?.result?.uids)) throw refused(summaries, "summary");
    const result = summaries.result!;
    return result.uids.map((uid) => {
      const s = result[uid] as Summary;
      const doi = s.articleids?.find((a) => a.idtype === "doi")?.value ?? /doi:\s*(\S+)/.exec(s.elocationid ?? "")?.[1] ?? null;
      const year = /^\d{4}/.exec(s.pubdate)?.[0];
      return {
        pmid: s.uid,
        title: s.title,
        journal: s.source,
        year: year ? Number(year) : null,
        authors: (s.authors ?? []).slice(0, 3).map((a) => a.name),
        ...(doi ? { doi } : {}),
      };
    });
  },
});

export const ABSTRACT_CHARS = 600;

export const arxivSearch = defineTool({
  name: "arxiv_search",
  description:
    "Search arXiv preprints by keywords. Returns the arXiv id, title, authors, published date, primary category and the start of the abstract. Use for preprints in computer science, statistics, physics and quantitative biology. Not for peer-reviewed biomedical literature (use pubmed_search).",
  input: z.object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  reads: "D0",
  effects: "read",
  egress: ["export.arxiv.org"],
  idempotent: true,
  async run({ query, limit }, ctx) {
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${query}`)}&start=0&max_results=${limit}`;
    const res = await ctx.fetch(url, { signal: ctx.signal });
    if (!res.ok) throw new Error(`arXiv returned ${res.status}`);
    return parseAtom(await res.text()).map((e) => ({
      id: e.id.replace(/^https?:\/\/arxiv\.org\/abs\//, ""),
      title: e.title,
      authors: e.authors,
      published: e.published,
      primaryCategory: e.primaryCategory,
      abstract: e.summary.length > ABSTRACT_CHARS ? `${e.summary.slice(0, ABSTRACT_CHARS - 1)}…` : e.summary,
    }));
  },
});

export function builtinTools(): RegisteredTool[] {
  return [kbSearch, kbRead, datasetList, runCode, openalexSearch, pubmedSearch, arxivSearch, europepmcSearch, europepmcFulltext, doiLookup, citationWalk].map((t) => {
    const manifest = t as ToolManifest<unknown, unknown>;
    return { manifest, hash: toolSpecHash(manifest), owner: "core" };
  });
}
