/**
 * KB compile: a definition (purpose, sources, coverage questions, compiler)
 * becomes an immutable snapshot, through the model gateway.
 *
 *   readSources        files and URLs -> text + SourceRef (content hash, class, licence)
 *   requestCompile     source texts into the payload store, one kb-compile job keyed by content
 *   compileKb          per source: cached result, or one compiler call -> entries with facts
 *                      merge entries by path, then coverage: bm25 candidates + one judge call per question
 *                      manifest -> saveSnapshot
 *   publishSnapshot    kb_heads moves when every coverage question has a supporting entry, or
 *                      when a publisher overrides the gaps with a note
 *
 * Invariants:
 * - Idempotent by content. The job key is the hash of everything the output
 *   depends on. Each source result and each coverage verdict is cached under
 *   a key over its own inputs, so a restart redoes only unfinished work and
 *   two workers compiling the same key write the same rows.
 * - snapshot.cls = join(source classes), computed before the first call, and
 *   every compile and coverage prompt carries it as its floor. A compiler that
 *   may not see the snapshot's class therefore sees none of its sources: the
 *   gateway refuses the first call, the audit stream records it, and the
 *   compile ends there. Nothing here checks placements.
 * - Each entry is hashed and stored at the snapshot class, because the payload
 *   address commits to a class and the manifest names only the snapshot's.
 *   The coverage judge still sees each candidate at its sources' join.
 */

import { readFile } from "node:fs/promises";
import { extname, join as joinPath } from "node:path";
import { z } from "zod";
import { parseExactModelId } from "./agent.ts";
import { appendAudit, auditRecorder, type AuditEvent, type CallContext } from "./audit.ts";
import { DATA_CLASSES, join, Labelled, type DataClass, type EgressRefusal } from "./dataclass.ts";
import type { Db } from "./db.ts";
import { classifyText } from "./gate.ts";
import { describeOutcome, Prompt, type ExactModelId, type ModelGateway, type ModelResult, type ModelTarget } from "./gateway.ts";
import { contentHash, type Addresser, type PayloadHash, type Sha256, type SnapshotId } from "./hash.ts";
import { buildBm25, hashEntry, LICENCES, loadManifest, saveSnapshot, searchBm25, snapshotId, SOURCE_KINDS, type CoverageResult, type HashedEntry, type KbEntry, type KbSnapshot, type LoadedSnapshot, type SourceRef } from "./kb.ts";
import type { Queue } from "./queue.ts";
import type { HttpEgress } from "./tools.ts";
import { MAX_ATTEMPTS, type PayloadRef, type PayloadStore } from "./record.ts";

/** Class of the definition's own text (title, purpose, questions), as instructions default to D1. */
export const DEFINITION_CLASS: DataClass = "D1";

export type SourceSpec = Omit<SourceRef, "contentHash">;

export interface KbDefinition {
  readonly kbId: string;
  readonly title: string;
  readonly purpose: string;
  /** 5 to 10 questions the KB must answer before it can be published. */
  readonly coverageQuestions: readonly string[];
  readonly sources: readonly SourceSpec[];
  readonly compiler: ModelTarget;
  readonly irbProtocol: string | null;
  readonly consentScope: string | null;
  /** Absent means DEFINITION_CLASS; kept absent rather than defaulted so existing compile keys do not move. */
  readonly definitionClass?: DataClass;
}

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

/** Label and help text. The studio's KB form shows exactly these, so they are written for lab members. */
const says = (title: string, description?: string) => (description ? { title, description } : { title });

/** The one definition of a KB definition's shape. The kb command parses files with it; the studio generates its KB form from it. */
export const kbDefinitionSchema = z.object({
  kbId: slug.meta(says("Knowledge base id", "Short id agents use to attach it, for example handbook. Lowercase letters, digits and hyphens.")),
  title: z.string().min(1).meta(says("Title")),
  purpose: z.string().min(1).meta(says("Purpose", "What this knowledge base is for. The compiler keeps only what serves it.")),
  coverageQuestions: z
    .array(z.string().min(1))
    .min(5)
    .max(10)
    .meta(says("Coverage questions", "5 to 10 questions it must answer. Publish names every question no entry supports.")),
  sources: z
    .array(
      z.object({
        sourceId: slug.meta(says("Source id", "Short id for this document, for example sop-freezer.")),
        kind: z.enum(SOURCE_KINDS).meta(says("Kind", "file: a .md or .txt file you attach when you compile. url: a page on a host lab.toml allows.")),
        location: z.string().min(1).meta(says("Location", "The file name you will attach, with no folder, or the URL.")),
        cls: z.enum(DATA_CLASSES).meta(says("Data class", "The class you declare. A participant id in the text raises it to D3.")),
        licence: z.enum(LICENCES).meta(says("Licence")),
      })
      .refine((s) => s.kind !== "file" || isBareFileName(s.location), { path: ["location"], message: "a file source's location is a file name with no folder" }),
    )
    .min(1)
    .refine((s) => new Set(s.map((x) => x.sourceId)).size === s.length, "source ids must be unique")
    .refine((s) => {
      const names = s.filter((x) => x.kind === "file").map((x) => x.location);
      return new Set(names).size === names.length;
    }, "two file sources cannot share a file name")
    .meta(says("Sources")),
  compiler: z
    .object({
      endpointId: z.string().min(1).meta(says("Endpoint", "The model server from lab.toml that compiles it, for example local.")),
      modelId: z.string().min(1).meta(says("Model id", "The exact model version, for example qwen3:8b.")),
      params: z
        .object({
          temperature: z.number().min(0).max(2).default(0).meta(says("Temperature")),
          maxOutputTokens: z.number().int().positive().default(8192).meta(says("Max output tokens")),
          seed: z.number().int().optional().meta(says("Seed", "Optional.")),
        })
        .default({ temperature: 0, maxOutputTokens: 8192 })
        .meta(says("Parameters")),
    })
    .meta(says("Compiler")),
  irbProtocol: z.string().optional().meta(says("IRB protocol", "Optional. The protocol that covers these sources.")),
  consentScope: z.string().optional().meta(says("Consent scope", "Optional. What participants consented to.")),
  definitionClass: z
    .enum(DATA_CLASSES)
    .optional()
    .meta(says("Definition data class", "Optional. The class of the title, purpose and questions themselves. D1 when empty; D0 only for a knowledge base built from public material.")),
});

/** Boundary: a definition file's JSON in, a typed definition out. */
export function parseKbDefinition(json: unknown): KbDefinition {
  const d = kbDefinitionSchema.parse(json);
  const modelId = parseExactModelId(d.compiler.modelId);
  if (typeof modelId !== "string") throw new Error(`compiler: ${modelId.message}`);
  const params = { temperature: d.compiler.params.temperature, maxOutputTokens: d.compiler.params.maxOutputTokens, ...(d.compiler.params.seed !== undefined ? { seed: d.compiler.params.seed } : {}) };
  return { ...d, compiler: { endpointId: d.compiler.endpointId, modelId, params }, irbProtocol: d.irbProtocol ?? null, consentScope: d.consentScope ?? null };
}

export interface LoadedSource {
  readonly ref: SourceRef;
  readonly text: string;
}

const TEXT_FILES = new Set([".md", ".markdown", ".txt"]);

/** A file source names one file beside the definition, never a path: no folder, no parent, nothing absolute. */
export function isBareFileName(name: string): boolean {
  return name !== "." && name !== ".." && !/[/\\:\0]/.test(name);
}

/** Where file sources' text comes from, by file name. */
export type SourceFiles = (name: string) => Promise<string>;

/** The kb command's sources: files in the definition's directory. */
export function filesIn(dir: string): SourceFiles {
  return (name) => {
    if (!isBareFileName(name)) return Promise.reject(new Error(`${name}: a file source's location is a file name with no folder`));
    return readFile(joinPath(dir, name), "utf8");
  };
}

/** The studio's sources: files the author attached, held in memory. Nothing is read from or written to disk. */
export function attachedFiles(files: readonly { readonly name: string; readonly text: string }[]): SourceFiles {
  const byName = new Map<string, string>();
  for (const f of files) {
    if (byName.has(f.name)) throw new Error(`${f.name} is attached twice`);
    byName.set(f.name, f.text);
  }
  return async (name) => {
    const text = byName.get(name);
    if (text === undefined) throw new Error(`Attach ${name} to compile.`);
    return text;
  };
}

export interface SourceDeps {
  readonly http: HttpEgress;
  readonly address: Addresser;
  readonly db: Db;
  /** Who the audit stream names for a refused URL source. */
  readonly actor: string;
  /** lab.toml's participant-id patterns. A source whose text matches one is D3 whatever its declared class. */
  readonly labPatterns: readonly RegExp[];
}

/**
 * Boundary: reads every source. A file comes from `files` by name; a URL is one
 * GET through the HTTP choke point. The request carries only the URL, which is
 * definition text, so it goes out at DEFINITION_CLASS to the host's placement;
 * a refusal is in the audit stream and throws EgressRefused.
 */
export async function readSources(def: KbDefinition, files: SourceFiles, deps: SourceDeps): Promise<LoadedSource[]> {
  return Promise.all(
    def.sources.map(async (s) => {
      const text = s.kind === "file" ? await readFileSource(s.location, files) : await readUrlSource(def.kbId, s.sourceId, s.location, deps);
      // The declared class is a floor: the gate's detectors and the lab's id patterns can only raise it.
      const cls = classifyText(text, s.cls, deps.labPatterns).cls;
      return { ref: { ...s, cls, contentHash: deps.address(cls, text) }, text };
    }),
  );
}

async function readFileSource(name: string, files: SourceFiles): Promise<string> {
  const ext = extname(name).toLowerCase();
  if (!TEXT_FILES.has(ext)) throw new Error(`${name}: only ${[...TEXT_FILES].join(", ")} files are supported as sources in this build`);
  return files(name);
}

async function readUrlSource(kbId: string, sourceId: string, url: string, deps: SourceDeps): Promise<string> {
  // A redirect is not followed: its target was never put through the egress decision.
  const res = await deps.http.request(
    url,
    Labelled.stamp(url, classifyText(url, DEFINITION_CLASS, deps.labPatterns).cls, `kb-def:${kbId}`),
    async (refused) => {
      await appendAudit(deps.db, deps.actor, { t: "call", context: { t: "kb-source", kbId, sourceId }, event: refused });
    },
    { redirect: "manual" },
  );
  if (res.status >= 300 && res.status < 400) throw new Error(`${url}: HTTP ${res.status} redirects to ${res.headers.get("location") ?? "an unnamed location"}; name the final URL as the source`);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const body = await res.text();
  if (type === "text/html") return htmlToText(body);
  if (type === "text/plain" || type === "text/markdown" || type === "") return body;
  throw new Error(`${url}: content type ${type} is not supported as a source in this build`);
}

/** Enough to read a plain article. Not a sanitizer: the text only goes to the compiler. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const COMPILE_SYSTEM = [
  "You compile one source document into entries for a knowledge base wiki.",
  "Write one entry per topic the source covers that serves the knowledge base's purpose.",
  "Each entry body restates what the source says about its topic, self-contained, in markdown. Add nothing the source does not say.",
  "Each fact is one claim from the source, with a locator naming where in the source it appears (a section heading or line).",
  'Reply with JSON only, in this shape: {"entries":[{"path":"topic/name.md","title":"Title","body":"...","facts":[{"text":"...","locator":"..."}]}]}',
  "Paths are lowercase, slash separated, and end in .md.",
].join("\n");

const COVERAGE_SYSTEM = [
  "You check whether knowledge base entries answer a question.",
  "Say answerable only if the entries state the answer, not if they only mention the topic.",
  'Reply with JSON only, in this shape: {"answerable":true,"paths":["entries/that/support.md"]}',
].join("\n");

/** Recorded in every snapshot, and part of every cache key: a prompt edit recompiles everything. */
export const COMPILER_PROMPT_HASH: Sha256 = contentHash({ format: "kb-compile-v1", compile: COMPILE_SYSTEM, coverage: COVERAGE_SYSTEM });

/** How many bm25 candidates the coverage judge sees per question. */
const COVERAGE_CANDIDATES = 3;

/** What a kb-compile job carries. Source bodies are refs into the payload store, so the job compiles exactly what was hashed. */
export interface CompileJob {
  readonly definition: KbDefinition;
  readonly sources: readonly (SourceRef & { readonly text: PayloadRef })[];
  /** Becomes the snapshot's createdAt, so recompiling one job always yields the same snapshot id. */
  readonly requestedAt: string;
}

/** The job's content key: everything the snapshot depends on, and nothing it does not. */
export function compileKey(def: KbDefinition, sources: readonly SourceRef[]): Sha256 {
  return contentHash({ definition: { ...def, sources: undefined }, sources, promptHash: COMPILER_PROMPT_HASH });
}

function sourceKey(job: CompileJob, s: SourceRef): Sha256 {
  return contentHash({ t: "source", contentHash: s.contentHash, sourceId: s.sourceId, purpose: job.definition.purpose, compiler: job.definition.compiler, promptHash: COMPILER_PROMPT_HASH });
}

function coverageKey(job: CompileJob, question: string, candidates: readonly HashedEntry[]): Sha256 {
  return contentHash({ t: "coverage", question, candidates: candidates.map((c) => c.hash), compiler: job.definition.compiler, promptHash: COMPILER_PROMPT_HASH });
}

/**
 * Stores the source texts and enqueues one kb-compile job. Asking twice for
 * the same content returns the same job; a failed job with that key is
 * queued again, since a transient failure should not pin the key forever.
 */
export async function requestCompile(deps: { readonly queue: Queue; readonly store: PayloadStore }, def: KbDefinition, loaded: readonly LoadedSource[], now: Date): Promise<{ readonly jobId: string; readonly key: string; readonly created: boolean }> {
  const sources = await Promise.all(
    loaded.map(async (l) => ({ ...l.ref, text: await deps.store.put(Labelled.stamp(l.text, l.ref.cls, `kb-source:${def.kbId}:${l.ref.sourceId}`)) })),
  );
  const key = `kb-compile:${def.kbId}:${compileKey(def, loaded.map((l) => l.ref))}`;
  const job: CompileJob = { definition: def, sources, requestedAt: now.toISOString() };
  const r = await deps.queue.enqueue({ kind: "kb-compile", key }, null, job);
  if (!r.created) await deps.queue.retryFailed(r.id);
  return { jobId: r.id, key, created: r.created };
}

const refSchema = z.object({ hash: z.string(), cls: z.enum(DATA_CLASSES), bytes: z.number() });
const compileJobSchema = z.object({
  definition: z.object({
    kbId: z.string(),
    title: z.string(),
    purpose: z.string(),
    coverageQuestions: z.array(z.string()),
    sources: z.array(z.object({ sourceId: z.string(), kind: z.enum(SOURCE_KINDS), location: z.string(), cls: z.enum(DATA_CLASSES), licence: z.enum(LICENCES) })),
    compiler: z.object({ endpointId: z.string(), modelId: z.string(), params: z.object({ temperature: z.number(), maxOutputTokens: z.number(), seed: z.number().optional() }) }),
    irbProtocol: z.string().nullable(),
    consentScope: z.string().nullable(),
    definitionClass: z.enum(DATA_CLASSES).optional(),
  }),
  sources: z.array(z.object({ sourceId: z.string(), kind: z.enum(SOURCE_KINDS), location: z.string(), cls: z.enum(DATA_CLASSES), licence: z.enum(LICENCES), contentHash: z.string(), text: refSchema })),
  requestedAt: z.string(),
});

/** Boundary: the jobs row's JSON in, the typed job out. The brands are applied here, once. */
export function parseCompileJob(json: unknown): CompileJob {
  const j = compileJobSchema.parse(json);
  const { seed, ...params } = j.definition.compiler.params;
  const compiler: ModelTarget = { endpointId: j.definition.compiler.endpointId, modelId: j.definition.compiler.modelId as ExactModelId, params: { ...params, ...(seed !== undefined ? { seed } : {}) } };
  return {
    definition: { ...j.definition, compiler },
    sources: j.sources.map((s) => ({ ...s, contentHash: s.contentHash as Sha256, text: { ...s.text, hash: s.text.hash as PayloadHash } })),
    requestedAt: j.requestedAt,
  };
}

export type CompileOutcome =
  | { readonly t: "compiled"; readonly snapshot: LoadedSnapshot }
  /** The compiler may not receive the snapshot's class. No call was sent. */
  | { readonly t: "refused"; readonly cls: DataClass; readonly refusal: EgressRefusal }
  | { readonly t: "failed"; readonly reason: string };

export interface CompileDeps {
  readonly db: Db;
  readonly store: PayloadStore;
  readonly gateway: ModelGateway;
  /** Who the audit stream names for this compile's calls. */
  readonly actor: string;
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  /** lab.toml's participant-id patterns, run over the definition's own text. */
  readonly labPatterns: readonly RegExp[];
}

/** The class of a definition's own text (title, purpose, coverage questions): DEFINITION_CLASS, raised by anything the gate's detectors or the lab's patterns find in it. */
export function definitionClass(def: KbDefinition, labPatterns: readonly RegExp[]): DataClass {
  return classifyText([def.title, def.purpose, ...def.coverageQuestions].join("\n"), def.definitionClass ?? DEFINITION_CLASS, labPatterns).cls;
}

/** Runs one compile job to a snapshot, reusing every cached source result and coverage verdict. */
export async function compileKb(job: CompileJob, deps: CompileDeps): Promise<CompileOutcome> {
  const def = job.definition;
  const defCls = definitionClass(def, deps.labPatterns);
  // The definition's text is in every prompt and in the manifest, so it floors the snapshot too.
  const cls = join(defCls, ...job.sources.map((s) => s.cls));
  const purpose = Labelled.stamp(def.purpose, defCls, `kb-def:${def.kbId}`);
  const perSource: Labelled<KbEntry[]>[] = [];
  for (const source of job.sources) {
    if (deps.signal.aborted) return { t: "failed", reason: "aborted" };
    const key = sourceKey(job, source);
    const cached = await cacheGet<KbEntry[]>(deps, key);
    if (cached) {
      deps.log(`kb-compile ${deps.jobId}: source ${source.sourceId} cached (${cached.value.length} entries)`);
      perSource.push(cached);
      continue;
    }
    const text = await deps.store.get(source.text);
    if ("redacted" in text) return { t: "failed", reason: `source ${source.sourceId} was redacted from the store` };
    const input = Labelled.derive(`Knowledge base purpose: ${purpose.value}\n\nSource id: ${source.sourceId}\n\n<source>\n${String(text.value)}\n</source>`, [purpose, text], `kb-compile:${def.kbId}:${source.sourceId}`, cls);
    const prompt = Prompt.of([{ role: "system", content: Labelled.stamp(COMPILE_SYSTEM, "D0", "kb-compile:prompt") }, { role: "user", content: input }], []);
    const result = await callUntilParsed(deps, def, { t: "kb-compile", job: deps.jobId, kbId: def.kbId, step: { t: "source", sourceId: source.sourceId } }, prompt, (r) => parseEntries(r.text, source.sourceId));
    if (result.t !== "ok") return result.t === "refused" ? { t: "refused", cls, refusal: result.refusal } : { t: "failed", reason: `source ${source.sourceId}: ${result.reason}` };
    const entries = Labelled.derive(result.value, [purpose, text], `kb-compile:${def.kbId}:${source.sourceId}`);
    await cachePut(deps, key, "source", entries);
    deps.log(`kb-compile ${deps.jobId}: source ${source.sourceId} compiled (${entries.value.length} entries)`);
    perSource.push(entries);
  }

  const merged = mergeEntries(deps.store.address, cls, perSource);
  const index = buildBm25(merged.map((m) => m.entry));
  const coverage: CoverageResult[] = [];
  for (const question of def.coverageQuestions) {
    if (deps.signal.aborted) return { t: "failed", reason: "aborted" };
    const candidates = searchBm25(index, question, COVERAGE_CANDIDATES).map((h) => merged.find((m) => m.entry.hash === h.hash)!);
    if (!candidates.length) {
      coverage.push({ question, answerable: false, entries: [] });
      continue;
    }
    const key = coverageKey(job, question, candidates.map((c) => c.entry));
    let verdict = await cacheGet<CoverageResult>(deps, key);
    if (!verdict) {
      const q = Labelled.stamp(question, defCls, `kb-def:${def.kbId}`);
      const shown = candidates.map((c) => Labelled.stamp(`<entry path="${c.entry.path}">\n# ${c.entry.title}\n${c.entry.body}\n</entry>`, c.cls, `kb-compile:${def.kbId}:entry`));
      const input = Labelled.derive(`Question: ${question}\n\nEntries:\n${shown.map((s) => s.value).join("\n")}`, [q, ...shown], `kb-coverage:${def.kbId}`, cls);
      const prompt = Prompt.of([{ role: "system", content: Labelled.stamp(COVERAGE_SYSTEM, "D0", "kb-compile:prompt") }, { role: "user", content: input }], []);
      const paths = candidates.map((c) => c.entry.path);
      const result = await callUntilParsed(deps, def, { t: "kb-compile", job: deps.jobId, kbId: def.kbId, step: { t: "coverage", question } }, prompt, (r) => parseVerdict(r.text, question, paths));
      if (result.t !== "ok") return result.t === "refused" ? { t: "refused", cls, refusal: result.refusal } : { t: "failed", reason: `coverage "${question}": ${result.reason}` };
      verdict = Labelled.derive(result.value, [q, ...shown], `kb-coverage:${def.kbId}`);
      await cachePut(deps, key, "coverage", verdict);
    }
    coverage.push(verdict.value);
  }

  const manifest: Omit<KbSnapshot, "id"> = {
    kbId: def.kbId,
    title: def.title,
    cls,
    purpose: def.purpose,
    entries: Object.fromEntries(merged.map((m) => [m.entry.path, m.entry.hash])),
    sources: job.sources.map(({ text: _text, ...ref }) => ref),
    compiler: { target: def.compiler, promptHash: COMPILER_PROMPT_HASH },
    coverage,
    irbProtocol: def.irbProtocol,
    consentScope: def.consentScope,
    createdAt: job.requestedAt,
  };
  const snapshot: KbSnapshot = { id: snapshotId(deps.store.address, manifest), ...manifest };
  await saveSnapshot(deps.db, deps.store, snapshot, merged.map((m) => m.entry));
  return { t: "compiled", snapshot: { snapshot, entries: merged.map((m) => m.entry) } };
}

type CallResult<T> = { readonly t: "ok"; readonly value: T } | { readonly t: "refused"; readonly refusal: EgressRefusal } | { readonly t: "failed"; readonly reason: string };

/** Up to MAX_ATTEMPTS gateway calls, each recorded in the audit stream. Output that does not parse counts as a failed attempt. */
async function callUntilParsed<T>(deps: CompileDeps, def: KbDefinition, context: CallContext, prompt: Prompt, parse: (r: ModelResult) => T | Error): Promise<CallResult<T>> {
  const rec = auditRecorder(deps.db, deps.store, deps.actor, context);
  let reason = "no attempt made";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const out = await deps.gateway.complete(def.compiler, prompt, rec, { signal: deps.signal, step: 1, attempt, final: false });
    if (!out.ok) {
      if (out.t === "refused-egress") return { t: "refused", refusal: out.refusal };
      if (deps.signal.aborted) return { t: "failed", reason: "aborted" };
      reason = describeOutcome(out);
      if (out.t === "refused-model-mismatch" || !out.retryable) return { t: "failed", reason };
      continue;
    }
    const parsed = parse(out.value);
    if (!(parsed instanceof Error)) return { t: "ok", value: parsed };
    reason = parsed.message;
    deps.log(`kb-compile ${deps.jobId}: attempt ${attempt} unusable: ${reason}`);
  }
  return { t: "failed", reason: `${reason} (after ${MAX_ATTEMPTS} attempts)` };
}

/** The first JSON object in a reply, ignoring any reasoning a model wraps around it. */
function jsonIn(text: string): unknown | Error {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return new Error("reply holds no JSON object");
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    return new Error(`reply is not JSON: ${(err as Error).message}`);
  }
}

const compiledSchema = z.object({
  entries: z
    .array(z.object({ path: z.string().min(1), title: z.string().min(1), body: z.string().min(1), facts: z.array(z.object({ text: z.string().min(1), locator: z.string().default("") })).default([]) }))
    .min(1),
});

function normalizePath(p: string): string {
  const slugged = p
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9/_.-]/g, "")
    .replace(/^\/+|\/+$/g, "");
  return slugged.endsWith(".md") ? slugged : `${slugged}.md`;
}

export function parseEntries(text: string, sourceId: string): KbEntry[] | Error {
  const json = jsonIn(text);
  if (json instanceof Error) return json;
  const parsed = compiledSchema.safeParse(json);
  if (!parsed.success) return new Error(`compiler reply does not match the entry shape: ${parsed.error.issues[0]?.message}`);
  return parsed.data.entries.map((e) => ({
    path: normalizePath(e.path),
    title: e.title.trim(),
    body: e.body.trim(),
    facts: e.facts.map((f) => ({ text: f.text.trim(), sources: [{ sourceId, locator: f.locator.trim() }] })),
  }));
}

const verdictSchema = z.object({ answerable: z.boolean(), paths: z.array(z.string()).default([]) });

export function parseVerdict(text: string, question: string, candidates: readonly string[]): CoverageResult | Error {
  const json = jsonIn(text);
  if (json instanceof Error) return json;
  const parsed = verdictSchema.safeParse(json);
  if (!parsed.success) return new Error(`judge reply does not match the verdict shape: ${parsed.error.issues[0]?.message}`);
  if (!parsed.data.answerable) return { question, answerable: false, entries: [] };
  const named = parsed.data.paths.map(normalizePath).filter((p) => candidates.includes(p));
  return { question, answerable: true, entries: named.length ? [...new Set(named)] : [...candidates] };
}

/** Same path from several sources becomes one entry: bodies and facts in source order, class joined. Hashes are at the snapshot's class `kbCls`. */
function mergeEntries(address: Addresser, kbCls: DataClass, perSource: readonly Labelled<KbEntry[]>[]): { readonly entry: HashedEntry; readonly cls: DataClass }[] {
  const byPath = new Map<string, { title: string; bodies: string[]; facts: KbEntry["facts"][number][]; cls: DataClass }>();
  for (const result of perSource) {
    for (const e of result.value) {
      const m = byPath.get(e.path);
      if (!m) byPath.set(e.path, { title: e.title, bodies: [e.body], facts: [...e.facts], cls: result.cls });
      else {
        m.bodies.push(e.body);
        m.facts.push(...e.facts);
        m.cls = join(m.cls, result.cls);
      }
    }
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, m]) => ({ entry: hashEntry(address, kbCls, { path, title: m.title, body: m.bodies.join("\n\n"), facts: m.facts }), cls: m.cls }));
}

async function cacheGet<T>(deps: CompileDeps, key: Sha256): Promise<Labelled<T> | undefined> {
  const row = await deps.db.query<{ result: PayloadHash; cls: DataClass }>("select result, cls from kb_compile_cache where key = $1", [key]);
  const r = row.rows[0];
  if (!r) return undefined;
  const body = await deps.store.get({ hash: r.result, cls: r.cls, bytes: 0 });
  return "redacted" in body ? undefined : Labelled.derive(body.value as T, [body], body.origin);
}

async function cachePut(deps: CompileDeps, key: Sha256, kind: "source" | "coverage", value: Labelled<unknown>): Promise<void> {
  const ref = await deps.store.put(value);
  await deps.db.query("insert into kb_compile_cache (key, kind, result, cls) values ($1, $2, $3, $4) on conflict (key) do nothing", [key, kind, ref.hash, ref.cls]);
}

/** The kb-compile job handler's body: compile, then record the outcome in the audit stream. */
export async function runCompileJob(payload: unknown, deps: CompileDeps): Promise<CompileOutcome> {
  const job = parseCompileJob(payload);
  const kbId = job.definition.kbId;
  const outcome = await compileKb(job, deps);
  switch (outcome.t) {
    case "compiled":
      await appendAudit(deps.db, deps.actor, { t: "kb.compiled", job: deps.jobId, kbId, snapshot: outcome.snapshot.snapshot.id, cls: outcome.snapshot.snapshot.cls, gaps: gapsOf(outcome.snapshot.snapshot) });
      break;
    case "refused":
      await appendAudit(deps.db, deps.actor, { t: "kb.compile-failed", job: deps.jobId, kbId, reason: `snapshot class ${outcome.cls} refused by egress`, refusal: outcome.refusal });
      break;
    case "failed":
      if (!deps.signal.aborted) await appendAudit(deps.db, deps.actor, { t: "kb.compile-failed", job: deps.jobId, kbId, reason: outcome.reason, refusal: null });
      break;
  }
  return outcome;
}

export function gapsOf(snapshot: KbSnapshot): string[] {
  return snapshot.coverage.filter((c) => !c.answerable).map((c) => c.question);
}

/** A publisher's decision to publish a snapshot over its coverage gaps. Kept beside the snapshot, since the manifest is immutable. */
export interface CoverageOverride {
  readonly publisher: string;
  readonly note: string;
  readonly gaps: readonly string[];
  readonly auditSeq: number;
  readonly at: string;
}

export type PublishResult = { readonly ok: true; readonly overridden?: readonly string[] } | { readonly ok: false; readonly gaps: readonly string[] };

/**
 * Moves kb_heads to the snapshot. A snapshot with coverage gaps publishes only
 * with an override, whose note is recorded in the audit stream and in
 * kb_coverage_overrides in the same transaction as the head move. Every
 * outcome goes to the audit stream.
 */
export async function publishSnapshot(db: Db, address: Addresser, id: SnapshotId, publisher: string, override: { readonly note: string } | null = null): Promise<PublishResult> {
  const snapshot = await loadManifest(db, address, id);
  if (!snapshot) throw new Error(`snapshot ${id} is not in kb_snapshots`);
  const gaps = gapsOf(snapshot);
  if (override && !override.note.trim()) throw new Error("a coverage override needs a note saying why the gaps are acceptable");
  if (override && !gaps.length) throw new Error(`snapshot ${id} has no coverage gaps; publish it without an override`);
  if (gaps.length && !override) {
    await appendAudit(db, publisher, { t: "kb.publish-refused", kbId: snapshot.kbId, snapshot: id, gaps });
    return { ok: false, gaps };
  }
  const note = override?.note.trim();
  await appendAudit(db, publisher, { t: "kb.published", kbId: snapshot.kbId, snapshot: id, ...(note ? { override: { note, gaps } } : {}) }, async (tx, row) => {
    if (note) await tx.query("insert into kb_coverage_overrides (snapshot, publisher, note, gaps, audit_seq, at) values ($1, $2, $3, $4, $5, $6)", [id, publisher, note, JSON.stringify(gaps), row.seq, row.at]);
    await tx.query("insert into kb_heads (kb_id, snapshot) values ($1, $2) on conflict (kb_id) do update set snapshot = excluded.snapshot", [snapshot.kbId, id]);
  });
  return note ? { ok: true, overridden: gaps } : { ok: true };
}

/** The class a publish of this snapshot moves: its own class joined with the class of the head it replaces. */
export async function kbPublishClass(db: Db, snapshot: KbSnapshot): Promise<DataClass> {
  const head = await db.query<{ cls: DataClass }>("select s.cls from kb_heads h join kb_snapshots s on s.id = h.snapshot where h.kb_id = $1", [snapshot.kbId]);
  return join(snapshot.cls, ...head.rows.map((r) => r.cls));
}

/** The class of a compile job's sources, which is its snapshot's class; null when no such job exists. */
export async function compileClass(db: Db, jobId: string): Promise<DataClass | null> {
  const row = await db.query<{ payload: unknown }>("select payload from jobs where id::text = $1 and kind = 'kb-compile'", [jobId]);
  return row.rows[0] ? join(...parseCompileJob(row.rows[0].payload).sources.map((s) => s.cls)) : null;
}

export async function loadOverrides(db: Db, id: SnapshotId): Promise<CoverageOverride[]> {
  const rows = await db.query<{ publisher: string; note: string; gaps: string[]; audit_seq: string; at: Date }>("select publisher, note, gaps, audit_seq, at from kb_coverage_overrides where snapshot = $1 order by id", [id]);
  return rows.rows.map((r) => ({ publisher: r.publisher, note: r.note, gaps: r.gaps, auditSeq: Number(r.audit_seq), at: r.at.toISOString() }));
}

/** The coverage report as text: every question, its supporting entries, the gaps that block publishing, and any override of them. */
export function renderCoverage(snapshot: KbSnapshot, overrides: readonly CoverageOverride[] = []): string {
  const answered = snapshot.coverage.filter((c) => c.answerable).length;
  return [
    `coverage for ${snapshot.kbId} (snapshot ${snapshot.id.slice(0, 12)}, ${snapshot.cls}): ${answered} of ${snapshot.coverage.length} questions have a supporting entry`,
    ...snapshot.coverage.map((c) => (c.answerable ? `  ok   ${c.question} <- ${c.entries.join(", ")}` : `  GAP  ${c.question}`)),
    ...overrides.map((o) => `  OVERRIDE by ${o.publisher} at ${o.at}: ${o.note}`),
  ].join("\n");
}

/** The audit stream's record of how one compile job ended, or null while it has not. */
export async function compileResult(db: Db, jobId: string): Promise<{ readonly t: "compiled"; readonly snapshot: SnapshotId; readonly gaps: readonly string[] } | { readonly t: "failed"; readonly reason: string; readonly refusal: EgressRefusal | null } | null> {
  const row = await db.query<{ event: AuditEvent }>("select event from audit_events where event->>'job' = $1 and event->>'t' in ('kb.compiled', 'kb.compile-failed') order by seq desc limit 1", [jobId]);
  const e = row.rows[0]?.event;
  if (!e) return null;
  if (e.t === "kb.compiled") return { t: "compiled", snapshot: e.snapshot, gaps: e.gaps };
  if (e.t === "kb.compile-failed") return { t: "failed", reason: e.reason, refusal: e.refusal };
  return null;
}
