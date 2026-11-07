/**
 * Reviewer export and replay, over one bundle directory.
 *
 *   exportBundle(core, scope, clearance)  Postgres and the payload key in, a directory out. One decideEgress
 *                                         (export, clearance) per body; a body above clearance is in the index
 *                                         as its hash and class only.
 *   audit(dir)                            the directory alone: every chain recomputed, the audit view.
 *   reexecute(dir, endpoint)              the directory and one model endpoint: each run driven again by drive(),
 *                                         every tool call answered from the recorded outputs, so only the model
 *                                         can disagree.
 *
 * The chains verify without withheld bodies because events hold refs, not bodies. Payload, snapshot and entry
 * names are keyed addresses: a reviewer can match them but not recompute them. Event hashes and agent version
 * hashes are plain sha256 and recompute anywhere.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { z } from "zod";
import { AgentUnavailable, instructionsOf, LOOP_CONTRACT, versionHash, type ResolvedAgent } from "./agent.ts";
import { cardFor, outlineOf, type AgentCard, type CardCore } from "./card.ts";
import { DATA_CLASSES, decideEgress, DEFAULT_POLICY, describeRefusal, join, Labelled, type DataClass, type EgressRefusal, type Placement, type SurfaceId } from "./dataclass.ts";
import type { Surface } from "./frontdoor.ts";
import { createGateway } from "./gateway.ts";
import { canonicalJson, sha256, type AgentVersionHash, type EntryHash, type PayloadHash, type Sha256, type SnapshotId, type ToolHash } from "./hash.ts";
import { createKbReader, firstOf, memorySnapshots, storedSnapshots, type HashedEntry, type KbReader, type KbSnapshot } from "./kb.ts";
import { drive, type LoopDeps } from "./loop.ts";
import { loadVersion } from "./publish.ts";
import { formatRecordView, recordView, type RecordView } from "./record-view.ts";
import {
  describeFailure,
  eventClass,
  eventHash,
  loadEvents,
  PayloadUnavailable,
  refsOf,
  studyRunIds,
  verifyChain,
  type CallFailure,
  type PayloadRef,
  type RunEvent,
  type RunId,
  type RunJournal,
  type RunOutcome,
  type StoredEvent,
} from "./record.ts";
import { activeFreezes, deviations, getStudy, type Deviation, type Freeze, type Study } from "./study.ts";
import { builtinTools, createToolRunner, registryOf, type HttpEgress, type ToolRunner } from "./tools.ts";

export const BUNDLE_FORMAT = "labh-bundle-v1";

/** Whether a body is in the bundle, and if not, why. */
export type Disclosure =
  | { readonly t: "included" }
  | { readonly t: "withheld"; readonly refusal: EgressRefusal; readonly why: string }
  | { readonly t: "unavailable"; readonly why: string };

export interface PayloadEntry {
  readonly hash: PayloadHash;
  readonly cls: DataClass;
  readonly bytes: number;
  readonly disclosure: Disclosure;
}

export interface BundleRun {
  readonly runId: RunId;
  readonly agent: AgentVersionHash;
  readonly events: number;
  /** The last event's hash, as the lab's database anchors it. A truncated events file fails against it. */
  readonly head: Sha256;
}

export interface BundleIndex {
  readonly format: typeof BUNDLE_FORMAT;
  readonly createdAt: string;
  readonly clearance: DataClass;
  readonly layout: readonly string[];
  readonly runs: readonly BundleRun[];
  readonly agents: readonly { readonly hash: AgentVersionHash; readonly body: Disclosure }[];
  readonly snapshots: readonly { readonly id: SnapshotId; readonly cls: DataClass; readonly manifest: Disclosure; readonly entries: number }[];
  /** Tool name to spec hash, from the agent cards. */
  readonly tools: Readonly<Record<string, ToolHash>>;
  /** Present when the export was study-scoped. Deviations are protocol deviations a reviewer must see. */
  readonly study: { readonly study: Study; readonly freezes: readonly Freeze[]; readonly deviations: readonly Deviation[] } | null;
  readonly payloads: readonly PayloadEntry[];
}

const LAYOUT = [
  "bundle.json: this index. clearance is the most restricted class a body in this bundle may have. payloads lists every body the events name, with whether it is included and why not.",
  "events/<run>.jsonl: the run record, one stored event per line. An event's hash is sha256 of the RFC 8785 canonical JSON of {runId, seq, at, cls, prev, event}, and prev is the previous event's hash. runs[].head is the last hash.",
  "payloads/<hash>.json: {cls, body} for each body at or below clearance. The hash is a keyed address (HMAC under the lab's key): it names the body but cannot be recomputed from it.",
  "agents/<hash>.json: the resolved agent. sha256 of its canonical JSON is the hash every run names. Withheld when its instructions are above clearance.",
  "cards/<hash>.json: the agent card (schemas/agent-card.schema.json): model and placement, tools and their spec hashes, knowledge bases, data ceilings, the system prompt's hash.",
  "snapshots/<id>.json: a pinned knowledge base snapshot's manifest and the entries the runs retrieved. Withheld above clearance. Snapshot ids and entry hashes are keyed addresses.",
  "prov.json: W3C PROV-JSON derived from this bundle. Each run is an activity, the agent version a software agent, the member a person, the bodies and snapshots entities.",
  "To verify: aliquot replay <dir> recomputes every chain and prints the audit view. --reexecute --endpoint <url> runs each run again against a model, with tools answered from this record.",
];

export type ExportScope = { readonly runs: readonly RunId[] } | { readonly study: string };

/** The export cannot be written as asked: no such run or study, or the directory is not empty. */
export class ExportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportRefused";
  }
}

const INCLUDED: Disclosure = { t: "included" };
const withheld = (refusal: EgressRefusal): Disclosure => ({ t: "withheld", refusal, why: describeRefusal(refusal) });

export async function exportBundle(core: CardCore, scope: ExportScope, opts: { readonly clearance: DataClass; readonly out: string }): Promise<BundleIndex> {
  const to = { kind: "export", clearance: opts.clearance } as const;
  const study = "study" in scope ? await studyBlock(core, scope.study) : null;
  const ids = "runs" in scope ? scope.runs : await studyRunIds(core.db, scope.study);
  const runs: { readonly run: BundleRun; readonly events: readonly StoredEvent[] }[] = [];
  for (const runId of ids) {
    const events = await loadEvents(core.db, runId);
    const first = events[0]?.event;
    if (first?.t !== "run.started") throw new ExportRefused(`no run ${runId} in this database`);
    runs.push({ run: { runId, agent: first.agent, events: events.length, head: events.at(-1)!.hash }, events });
  }

  await mkdir(opts.out, { recursive: true });
  if ((await readdir(opts.out)).length) throw new ExportRefused(`${opts.out} is not empty`);
  for (const dir of ["events", "payloads", "agents", "cards", "snapshots"]) await mkdir(joinPath(opts.out, dir));
  const write = (path: string, value: unknown) => writeFile(joinPath(opts.out, path), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

  const payloads = new Map<string, PayloadEntry>();
  for (const ref of runs.flatMap((r) => r.events.flatMap((e) => refsOf(e.event)))) {
    if (payloads.has(ref.hash)) continue;
    let disclosure: Disclosure;
    try {
      const body = await core.store.get(ref);
      if ("redacted" in body) disclosure = { t: "unavailable", why: "redacted by the lab's retention" };
      else {
        const decision = decideEgress(body, to, core.config.policy);
        disclosure = decision.allow ? INCLUDED : withheld(decision.refusal);
        if (decision.allow) await write(`payloads/${ref.hash}.json`, { cls: ref.cls, body: body.value });
      }
    } catch (err) {
      if (!(err instanceof PayloadUnavailable)) throw err;
      disclosure = { t: "unavailable", why: err.message };
    }
    payloads.set(ref.hash, { hash: ref.hash, cls: ref.cls, bytes: ref.bytes, disclosure });
  }

  const agents: { hash: AgentVersionHash; body: Disclosure }[] = [];
  const cards = new Map<string, AgentCard>();
  const tools: Record<string, ToolHash> = {};
  const pinned = new Map<SnapshotId, DataClass>();
  for (const hash of new Set(runs.map((r) => r.run.agent))) {
    let agent: ResolvedAgent;
    try {
      agent = await loadVersion(core.db, hash);
    } catch (err) {
      if (!(err instanceof AgentUnavailable)) throw err;
      agents.push({ hash, body: { t: "unavailable", why: err.message } });
      continue;
    }
    const decision = decideEgress(instructionsOf(agent), to, core.config.policy);
    agents.push({ hash, body: decision.allow ? INCLUDED : withheld(decision.refusal) });
    if (decision.allow) await write(`agents/${hash}.json`, agent);
    const card = await cardFor(core, hash);
    cards.set(hash, card);
    await write(`cards/${hash}.json`, card);
    for (const t of card.tools) tools[t.name] = t.specHash as ToolHash;
    for (const kb of agent.knowledgeBases) pinned.set(kb.snapshot, kb.cls);
  }

  const retrieved = new Map<SnapshotId, Set<EntryHash>>();
  for (const { event: e } of runs.flatMap((r) => r.events)) {
    if (e.t !== "tool.completed") continue;
    for (const r of e.retrieved ?? []) retrieved.set(r.snapshot, new Set([...(retrieved.get(r.snapshot) ?? []), ...r.entries]));
  }
  const source = firstOf(memorySnapshots(core.fixtureSnapshots), storedSnapshots(core.db, core.store));
  const snapshots: BundleIndex["snapshots"][number][] = [];
  for (const [id, cls] of pinned) {
    const loaded = await source.load(id);
    if (!loaded) {
      snapshots.push({ id, cls, manifest: { t: "unavailable", why: "this deployment does not hold the snapshot" }, entries: 0 });
      continue;
    }
    // The outline, the manifest and every entry are at the snapshot's class, so one decision covers the file.
    const decision = decideEgress(await createKbReader(memorySnapshots([loaded])).outline(id), to, core.config.policy);
    const wanted = retrieved.get(id) ?? new Set();
    const entries = loaded.entries.filter((e) => wanted.has(e.hash));
    if (decision.allow) await write(`snapshots/${id}.json`, { manifest: loaded.snapshot, entries });
    snapshots.push({ id, cls: loaded.snapshot.cls, manifest: decision.allow ? INCLUDED : withheld(decision.refusal), entries: decision.allow ? entries.length : 0 });
  }

  for (const { run, events } of runs) await writeFile(joinPath(opts.out, "events", `${run.runId}.jsonl`), events.map((e) => `${JSON.stringify(e)}\n`).join(""), { flag: "wx" });
  const index: BundleIndex = { format: BUNDLE_FORMAT, createdAt: new Date().toISOString(), clearance: opts.clearance, layout: LAYOUT, runs: runs.map((r) => r.run), agents, snapshots, tools, study, payloads: [...payloads.values()] };
  await write("bundle.json", index);
  await write("prov.json", provOf(index, runs, cards));
  return index;
}

async function studyBlock(core: CardCore, studyId: string): Promise<NonNullable<BundleIndex["study"]>> {
  const study = await getStudy(core.db, studyId);
  if (!study) throw new ExportRefused(`no study ${studyId}`);
  return { study, freezes: await activeFreezes(core.db, studyId), deviations: await deviations(core.db, studyId) };
}

type ProvSection = "activity" | "agent" | "entity" | "used" | "wasGeneratedBy" | "wasAssociatedWith" | "wasAttributedTo" | "actedOnBehalfOf";

/**
 * Pure. W3C PROV-JSON of the bundle: each run a prov:Activity, its agent version a prov:SoftwareAgent, the member
 * who asked a prov:Person the software acted for, and every body and snapshot a prov:Entity with its class. The run
 * used its input, history, tool outputs and snapshots, and generated its prompts, model outputs, tool inputs and
 * answer. Ids use the labh: prefix (urn:labh:).
 */
export function provOf(index: BundleIndex, runs: readonly { readonly run: BundleRun; readonly events: readonly StoredEvent[] }[], cards: ReadonlyMap<string, AgentCard>): unknown {
  const qn = (name: string) => ({ $: name, type: "prov:QUALIFIED_NAME" });
  const doc: Record<ProvSection, Record<string, unknown>> = { activity: {}, agent: {}, entity: {}, used: {}, wasGeneratedBy: {}, wasAssociatedWith: {}, wasAttributedTo: {}, actedOnBehalfOf: {} };
  const seen = new Set<string>();
  const relate = (kind: ProvSection, body: Record<string, unknown>) => {
    const key = canonicalJson([kind, body]);
    if (seen.has(key)) return;
    seen.add(key);
    doc[kind][`_:${kind}${seen.size}`] = body;
  };
  const payloads = new Map(index.payloads.map((p) => [p.hash as string, p]));
  const payload = (ref: PayloadRef, role: string): string => {
    const id = `labh:payload-${ref.hash}`;
    const entity = (doc.entity[id] ??= { "prov:type": qn("labh:Payload"), "labh:class": ref.cls, "labh:bytes": ref.bytes, "labh:included": payloads.get(ref.hash)?.disclosure.t === "included", "labh:role": [] }) as { "labh:role": string[] };
    if (!entity["labh:role"].includes(role)) entity["labh:role"].push(role);
    return id;
  };
  const snapshots = new Map(index.snapshots.map((s) => [s.id as string, s]));
  const snapshot = (id: string): string => {
    const key = `labh:snapshot-${id}`;
    doc.entity[key] ??= { "prov:type": qn("labh:KnowledgeBaseSnapshot"), "labh:class": snapshots.get(id)?.cls ?? null, "labh:included": snapshots.get(id)?.manifest.t === "included" };
    return key;
  };
  for (const { run, events } of runs) {
    const started = events[0]!.event as Extract<RunEvent, { t: "run.started" }>;
    const finished = events.findLast((e) => e.event.t === "run.finished")?.event as Extract<RunEvent, { t: "run.finished" }> | undefined;
    const activity = `labh:run-${run.runId}`;
    doc.activity[activity] = { "prov:startTime": events[0]!.at, "prov:endTime": events.at(-1)!.at, "prov:type": qn("labh:Run"), "labh:trigger": started.trigger.t, "labh:outcome": finished?.outcome ?? "unfinished", "labh:studyId": started.studyId };
    const card = cards.get(run.agent);
    const software = `labh:agent-${run.agent}`;
    doc.agent[software] ??= { "prov:type": qn("prov:SoftwareAgent"), "labh:versionHash": run.agent, "labh:agentId": card?.agentId ?? null, "labh:model": card?.model.modelId ?? null, "labh:endpoint": card?.model.endpointId ?? null, "labh:placement": card?.model.placement ?? null };
    relate("wasAssociatedWith", { "prov:activity": activity, "prov:agent": software });
    const member = "memberId" in started.trigger ? started.trigger.memberId : null;
    if (member !== null) {
      const person = `labh:member-${encodeURIComponent(member)}`;
      doc.agent[person] ??= { "prov:type": qn("prov:Person"), "labh:memberId": member };
      relate("wasAssociatedWith", { "prov:activity": activity, "prov:agent": person });
      relate("actedOnBehalfOf", { "prov:delegate": software, "prov:responsible": person, "prov:activity": activity });
    }
    for (const kb of card?.knowledgeBases ?? []) relate("used", { "prov:activity": activity, "prov:entity": snapshot(kb.snapshot), "prov:time": events[0]!.at });
    const used = (ref: PayloadRef, role: string, at: string) => relate("used", { "prov:activity": activity, "prov:entity": payload(ref, role), "prov:time": at });
    const generated = (ref: PayloadRef, role: string, at: string) => relate("wasGeneratedBy", { "prov:entity": payload(ref, role), "prov:activity": activity, "prov:time": at });
    for (const { event: e, at } of events) {
      if (e.t === "run.started") {
        used(e.input, "input", at);
        for (const h of e.history) used(h, "history", at);
      } else if (e.t === "model.requested") generated(e.prompt, "prompt", at);
      else if (e.t === "model.completed") {
        generated(e.output, "model-output", at);
        for (const c of e.toolCalls) generated(c.args, "tool-input", at);
      } else if (e.t === "tool.completed") {
        used(e.output, "tool-output", at);
        for (const r of e.retrieved ?? []) relate("used", { "prov:activity": activity, "prov:entity": snapshot(r.snapshot), "prov:time": at });
      } else if (e.t === "inbox.consumed" && e.item.t === "steer") used(e.item.text, "steer", at);
      else if (e.t === "run.finished" && e.answer) {
        generated(e.answer, "answer", at);
        relate("wasAttributedTo", { "prov:entity": payload(e.answer, "answer"), "prov:agent": software });
      } else for (const ref of refsOf(e)) generated(ref, "error-detail", at);
    }
  }
  return { prefix: { labh: "urn:labh:", prov: "http://www.w3.org/ns/prov#" }, ...doc };
}

// Reading a bundle: everything from here reads only the directory, and treats it as untrusted input.

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const disclosureSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("included") }),
  z.object({ t: z.literal("withheld"), refusal: z.custom<EgressRefusal>((v) => typeof v === "object" && v !== null), why: z.string() }),
  z.object({ t: z.literal("unavailable"), why: z.string() }),
]);
const cls = z.enum(DATA_CLASSES);
// Every id that becomes part of a file path is checked here, so a bundle.json cannot name a path outside the bundle.
const indexSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  createdAt: z.string(),
  clearance: cls,
  layout: z.array(z.string()),
  runs: z.array(z.object({ runId: z.string().regex(/^[0-9a-f-]{36}$/), agent: hex64, events: z.number().int(), head: hex64 })),
  agents: z.array(z.object({ hash: hex64, body: disclosureSchema })),
  snapshots: z.array(z.object({ id: hex64, cls, manifest: disclosureSchema, entries: z.number().int() })),
  tools: z.record(z.string(), hex64),
  study: z
    .object({
      study: z.looseObject({ id: z.string(), title: z.string() }),
      freezes: z.array(z.looseObject({ agentId: z.string(), hash: z.string(), frozenBy: z.string(), at: z.string(), note: z.string() })),
      deviations: z.array(z.looseObject({ agentId: z.string(), hash: z.string(), frozenBy: z.string(), frozenAt: z.string(), note: z.string(), by: z.string(), reason: z.string(), at: z.string() })),
    })
    .nullable(),
  payloads: z.array(z.object({ hash: hex64, cls, bytes: z.number().int(), disclosure: disclosureSchema })),
});

interface Bundle {
  readonly dir: string;
  readonly index: BundleIndex;
  readonly payloads: ReadonlyMap<string, PayloadEntry>;
}

/** The bundle is not one: no bundle.json, or one this build does not read. */
export class BundleUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleUnreadable";
  }
}

/** Typed by the caller, as loadVersion types a row: each caller checks what it trusts (a hash, a class). */
async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function openBundle(dir: string): Promise<Bundle> {
  let raw: unknown;
  try {
    raw = await readJson<unknown>(joinPath(dir, "bundle.json"));
  } catch (err) {
    throw new BundleUnreadable(`${dir} has no readable bundle.json (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = indexSchema.safeParse(raw);
  if (!parsed.success) throw new BundleUnreadable(`${dir}/bundle.json is not a ${BUNDLE_FORMAT} index: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const index = parsed.data as unknown as BundleIndex;
  return { dir, index, payloads: new Map(index.payloads.map((p) => [p.hash, p])) };
}

/** The run's events as the file holds them, and the first seq that does not verify, end at the head, or belong to the run. */
async function runEvents(b: Bundle, run: BundleRun): Promise<{ readonly events: readonly StoredEvent[]; readonly firstBad: number | null }> {
  const events: StoredEvent[] = [];
  let file: string;
  try {
    file = await readFile(joinPath(b.dir, "events", `${run.runId}.jsonl`), "utf8");
  } catch {
    return { events, firstBad: 0 };
  }
  const lines = file.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as StoredEvent);
    } catch {
      return { events, firstBad: events.length };
    }
  }
  const foreign = events.findIndex((e) => e?.runId !== run.runId);
  const chain = verifyChain(events);
  const bad = [chain, foreign < 0 ? null : foreign].filter((n): n is number => n !== null);
  if (bad.length) return { events, firstBad: Math.min(...bad) };
  return { events, firstBad: events.length === run.events && events.at(-1)?.hash === run.head ? null : Math.min(events.length, run.events) };
}

/** The body a ref names, when the bundle includes it at the ref's class. Paths come from the validated index only. */
async function bodyOf(b: Bundle, ref: PayloadRef): Promise<{ readonly body: unknown } | null> {
  const entry = b.payloads.get(ref.hash);
  if (entry?.disclosure.t !== "included" || entry.cls !== ref.cls) return null;
  const file = await readJson<{ cls?: unknown; body?: unknown }>(joinPath(b.dir, "payloads", `${entry.hash}.json`));
  return file.cls === ref.cls ? { body: file.body } : null;
}

function whyNot(b: Bundle, ref: PayloadRef): string {
  const d = b.payloads.get(ref.hash)?.disclosure;
  if (!d) return "not in the bundle's payload index";
  return d.t === "included" ? "the payload file does not match the event's class" : d.why;
}

type AgentBody = { readonly t: "verified"; readonly agent: ResolvedAgent } | { readonly t: "mismatch" | "withheld" | "absent"; readonly why: string };

async function agentOf(b: Bundle, hash: string): Promise<AgentBody> {
  const entry = b.index.agents.find((a) => a.hash === hash);
  if (!entry) return { t: "absent", why: "not in the bundle" };
  if (entry.body.t !== "included") return { t: entry.body.t === "withheld" ? "withheld" : "absent", why: entry.body.why };
  const agent = await readJson<ResolvedAgent>(joinPath(b.dir, "agents", `${entry.hash}.json`));
  if (versionHash(agent) !== hash) return { t: "mismatch", why: "the agents file does not hash to its version" };
  return agent.schema === 2 ? { t: "verified", agent } : { t: "mismatch", why: `schema ${String(agent.schema)} is not one this build runs` };
}

async function cardOf(b: Bundle, hash: string): Promise<AgentCard | null> {
  const entry = b.index.agents.find((a) => a.hash === hash);
  if (!entry) return null;
  try {
    return await readJson<AgentCard>(joinPath(b.dir, "cards", `${entry.hash}.json`));
  } catch {
    return null;
  }
}

async function snapshotOf(b: Bundle, id: string): Promise<{ readonly manifest: KbSnapshot; readonly entries: readonly HashedEntry[] } | null> {
  const entry = b.index.snapshots.find((s) => s.id === id);
  if (entry?.manifest.t !== "included") return null;
  return readJson<{ manifest: KbSnapshot; entries: HashedEntry[] }>(joinPath(b.dir, "snapshots", `${entry.id}.json`));
}


export type Shown = { readonly t: "body"; readonly body: unknown } | { readonly t: "withheld"; readonly cls: DataClass; readonly why: string };

export interface AuditToolCall {
  readonly callId: string;
  readonly tool: string;
  readonly specHash: string;
  readonly input: Shown;
  readonly output: Shown | null;
  readonly failure: string | null;
  readonly retrieved: readonly { readonly snapshot: string; readonly truncated: boolean; readonly entries: readonly { readonly hash: string; readonly path: string | null; readonly title: string | null }[] }[];
}

export interface AuditRun extends RecordView {
  readonly version: { readonly hash: string; readonly body: AgentBody["t"]; readonly why: string | null; readonly model: string | null; readonly endpoint: string | null; readonly placement: string | null };
  /** In call order, latest attempt of each. Only from the verified part of the chain. */
  readonly toolCalls: readonly AuditToolCall[];
  readonly answer: Shown | null;
  readonly withheld: readonly { readonly hash: string; readonly cls: DataClass; readonly why: string }[];
}

export interface AuditView {
  readonly format: string;
  readonly clearance: DataClass;
  readonly createdAt: string;
  readonly study: BundleIndex["study"];
  readonly runs: readonly AuditRun[];
}

/** Always works: no database, no key, no model. */
export async function audit(dir: string): Promise<AuditView> {
  const b = await openBundle(dir);
  const runs: AuditRun[] = [];
  for (const run of b.index.runs) runs.push(await auditRun(b, run));
  return { format: b.index.format, clearance: b.index.clearance, createdAt: b.index.createdAt, study: b.index.study, runs };
}

async function auditRun(b: Bundle, run: BundleRun): Promise<AuditRun> {
  const { events, firstBad } = await runEvents(b, run);
  // A reader is shown only what verifies: rows, calls and bodies stop at the first bad event.
  const trusted = firstBad === null ? events : events.slice(0, firstBad);
  const shown = async (ref: PayloadRef): Promise<Shown> => {
    const found = await bodyOf(b, ref);
    return found ? { t: "body", body: found.body } : { t: "withheld", cls: ref.cls, why: whyNot(b, ref) };
  };
  const agent = await agentOf(b, run.agent);
  const card = await cardOf(b, run.agent);
  const entryNames = new Map<string, { path: string; title: string }>();
  const calls = new Map<string, AuditToolCall>();
  let answer: Shown | null = null;
  for (const { event: e } of trusted) {
    if (e.t === "tool.requested") calls.set(e.callId, { callId: e.callId, tool: e.tool, specHash: e.hash, input: await shown(e.input), output: null, failure: null, retrieved: [] });
    else if (e.t === "tool.completed" || e.t === "tool.failed") {
      const call = calls.get(e.callId);
      if (!call) continue;
      if (e.t === "tool.failed") {
        calls.set(e.callId, { ...call, failure: describeFailure(e.failure) });
        continue;
      }
      const retrieved = [];
      for (const r of e.retrieved ?? []) {
        for (const entry of (await snapshotOf(b, r.snapshot))?.entries ?? []) entryNames.set(entry.hash, { path: entry.path, title: entry.title });
        retrieved.push({ snapshot: r.snapshot, truncated: r.truncated, entries: r.entries.map((h) => ({ hash: h, path: entryNames.get(h)?.path ?? null, title: entryNames.get(h)?.title ?? null })) });
      }
      calls.set(e.callId, { ...call, output: await shown(e.output), retrieved });
    } else if (e.t === "run.finished" && e.answer) answer = await shown(e.answer);
  }
  const refs = new Map(trusted.flatMap((e) => refsOf(e.event)).map((r) => [r.hash as string, r]));
  const withheldRefs = [...refs.values()].filter((r) => b.payloads.get(r.hash)?.disclosure.t !== "included").map((r) => ({ hash: r.hash, cls: r.cls, why: whyNot(b, r) }));
  return {
    ...recordView(run.runId, trusted),
    chain: { events: events.length, firstBad },
    version: { hash: run.agent, body: agent.t, why: agent.t === "verified" ? null : agent.why, model: card?.model.modelId ?? null, endpoint: card?.model.endpointId ?? null, placement: card?.model.placement ?? null },
    toolCalls: [...calls.values()],
    answer,
    withheld: withheldRefs,
  };
}

const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const showLine = (s: Shown): string => (s.t === "body" ? text(s.body) : `withheld (${s.cls}): ${s.why}`);

export function formatAudit(v: AuditView): string {
  const out = [`bundle   ${v.format}, clearance ${v.clearance}, exported ${v.createdAt}`];
  if (v.study) {
    const s = v.study;
    out.push(`study    ${s.study.id}: ${s.study.title}`);
    for (const f of s.freezes) out.push(`  frozen: ${f.agentId} at ${f.hash} by ${f.frozenBy} (${f.at}): ${f.note}`);
    for (const d of s.deviations) out.push(`  deviation: ${d.agentId} at ${d.hash.slice(0, 12)}, frozen by ${d.frozenBy} (${d.frozenAt}): ${d.note}; unfrozen by ${d.by} (${d.at}): ${d.reason}`);
    if (!s.deviations.length) out.push("  deviations: none");
  }
  for (const r of v.runs) {
    const ver = r.version;
    out.push("", formatRecordView(r));
    out.push(`version  body ${ver.body}${ver.why ? ` (${ver.why})` : ""}; model ${ver.model ?? "unknown"} at ${ver.endpoint ?? "unknown"}, placement ${ver.placement ?? "unknown"}`);
    r.toolCalls.forEach((c, i) => {
      out.push(`tool ${i + 1}   ${c.tool} (spec ${c.specHash.slice(0, 12) || "none"}) ${showLine(c.input)}${c.failure ? `; failed: ${c.failure}` : ""}`);
      for (const ret of c.retrieved) out.push(`           retrieved from ${ret.snapshot.slice(0, 12)}${ret.truncated ? " (truncated)" : ""}: ${ret.entries.map((e) => (e.path ? `${e.path} "${e.title}"` : e.hash.slice(0, 12))).join(", ") || "nothing"}`);
    });
    out.push(`answer   ${r.answer ? showLine(r.answer) : "none"}`);
    for (const w of r.withheld) out.push(`withheld ${w.hash.slice(0, 12)} ${w.cls}: ${w.why}`);
  }
  return out.join("\n");
}


export type ToolStep = readonly [tool: string, args: unknown];
const NO_FURTHER_CALL = "no further tool call";

export type ReplayReport =
  | { readonly t: "skipped"; readonly original: RunId; readonly why: string }
  | {
      readonly t: "replayed";
      readonly original: RunId;
      readonly replay: RunId;
      readonly agreement: { readonly exact: boolean; readonly sameTools: boolean; readonly sameAnswer: boolean };
      readonly tools: { readonly recorded: readonly ToolStep[]; readonly replay: readonly ToolStep[] };
      readonly answer: { readonly recorded: unknown; readonly replay: unknown };
      readonly outcome: { readonly recorded: RunOutcome | null; readonly replay: RunOutcome | null };
      /** The first model step whose tool call differs from the record, what the replay asked, and what the record had there. */
      readonly divergence: { readonly step: number; readonly asked: ToolStep | typeof NO_FURTHER_CALL; readonly expected: ToolStep | typeof NO_FURTHER_CALL } | null;
      /** Why the replay stopped before finishing: a call not in the record, or an error. Null when it finished. */
      readonly unfinished: string | null;
    };

/** Thrown by the replay tool runner to end the run at a call the record cannot answer. */
class NotInRecord extends Error {
  constructor(tool: string) {
    super(`the model asked for a ${tool} call the record does not have`);
    this.name = "NotInRecord";
  }
}

type RecordedOutcome =
  | { readonly t: "output"; readonly output: PayloadRef; readonly retrieved: Extract<RunEvent, { t: "tool.completed" }>["retrieved"] }
  | { readonly t: "failed"; readonly failure: CallFailure }
  | { readonly t: "unknown" };

const NO_HTTP: HttpEgress = {
  request: async () => {
    throw new Error("re-execution sends no tool requests");
  },
};

export async function reexecute(dir: string, opts: { readonly endpoint: string; readonly log?: (line: string) => void }): Promise<ReplayReport[]> {
  const b = await openBundle(dir);
  const out: ReplayReport[] = [];
  for (const run of b.index.runs) out.push(await reexecuteRun(b, run, opts.endpoint, opts.log ?? (() => {})));
  return out;
}

async function reexecuteRun(b: Bundle, run: BundleRun, endpoint: string, log: (line: string) => void): Promise<ReplayReport> {
  const skip = (why: string): ReplayReport => ({ t: "skipped", original: run.runId, why });
  const { events, firstBad } = await runEvents(b, run);
  if (firstBad !== null) return skip(`its chain is broken at event ${firstBad}`);
  const started = events[0]?.event;
  if (started?.t !== "run.started") return skip("its record does not start with run.started");
  const found = await agentOf(b, run.agent);
  if (found.t !== "verified") return skip(`the agent version's body is ${found.t}: ${found.why}`);
  const agent = found.agent;
  if (agent.agentCli) return skip("an agent CLI run is not re-executed");
  const registry = registryOf(builtinTools());
  const unknownTool = agent.tools.find((t) => registry.get(t.name)?.hash !== t.hash);
  if (unknownTool) return skip(`tool ${unknownTool.name} at spec ${unknownTool.hash.slice(0, 12)} is not in this build, so the model would not see the same tool list`);

  const manifests = new Map<SnapshotId, KbSnapshot>();
  const short: DataClass[] = [];
  for (const kb of agent.knowledgeBases) {
    const s = await snapshotOf(b, kb.snapshot);
    if (s) manifests.set(kb.snapshot, s.manifest);
    else short.push(kb.cls);
  }
  const needed = events.flatMap(({ event: e }): PayloadRef[] => {
    if (e.t === "run.started") return [e.input];
    if (e.t === "model.completed") return e.toolCalls.map((c) => c.args);
    if (e.t === "tool.completed") return [e.output];
    if (e.t === "tool.failed") return e.failure.detail ? [e.failure.detail] : [];
    if (e.t === "run.finished") return e.answer ? [e.answer] : [];
    return [];
  });
  const bodies = new Map<string, Labelled<unknown>>();
  for (const ref of needed) {
    const body = await bodyOf(b, ref);
    // Stamped at the class the verified event names for it, never at a class the payload file claims.
    if (body) bodies.set(ref.hash, Labelled.stamp(body.body, ref.cls, `bundle:${ref.hash}`));
    else short.push(ref.cls);
  }
  if (short.length) return skip(`re-execution needs clearance ${join(...short)}, and this bundle is ${b.index.clearance}`);

  const recordedBody = (ref: PayloadRef) => bodies.get(ref.hash)!.value;
  const outcomes = new Map<string, RecordedOutcome>();
  for (const { event: e } of events) {
    if (e.t === "tool.completed") outcomes.set(e.callId, { t: "output", output: e.output, retrieved: e.retrieved });
    else if (e.t === "tool.failed") outcomes.set(e.callId, { t: "failed", failure: e.failure });
    else if (e.t === "tool.outcome-unknown") outcomes.set(e.callId, { t: "unknown" });
  }
  const recorded = new Map<string, RecordedOutcome[]>();
  for (const { event: e } of events) {
    if (e.t !== "model.completed") continue;
    for (const c of e.toolCalls) {
      const key = canonicalJson([c.name, recordedBody(c.args)]);
      recorded.set(key, [...(recorded.get(key) ?? []), outcomes.get(c.id) ?? { t: "unknown" }]);
    }
  }

  const replayId = randomUUID() as RunId;
  const journal = memoryJournal(replayId, bodies);
  await journal.append({ ...started, trigger: { t: "replay", of: run.runId, tools: "recorded" } });
  const pins = new Map(agent.tools.map((t) => [t.name, t.hash]));
  const kb: KbReader = {
    has: async (id) => manifests.has(id),
    outline: async (id) => {
      const m = manifests.get(id);
      if (!m) throw new Error(`snapshot ${id} is not in the bundle`);
      return Labelled.stamp(outlineOf(m), m.cls, `bundle:snapshot:${id}`);
    },
    read: async () => {
      throw new Error("re-execution answers kb_read from the record");
    },
    search: async () => {
      throw new Error("re-execution answers kb_search from the record");
    },
  };
  const tools: ToolRunner = {
    registry,
    specs: createToolRunner(registry, { http: NO_HTTP, kb }).specs,
    isRepeatable: () => true,
    needsConfirm: () => false,
    async invoke(j, call) {
      const args = (await j.get(call.input)).value;
      const answer = recorded.get(canonicalJson([call.tool, args]))?.shift();
      if (!answer) throw new NotInRecord(call.tool);
      await j.record({ t: "tool.requested", callId: call.callId, attempt: call.attempt, tool: call.tool, hash: pins.get(call.tool) ?? ("" as ToolHash), input: call.input });
      if (answer.t === "output") await j.record({ t: "tool.completed", callId: call.callId, attempt: call.attempt, output: answer.output, ...(answer.retrieved ? { retrieved: answer.retrieved } : {}), ms: 0 });
      else if (answer.t === "failed") await j.record({ t: "tool.failed", callId: call.callId, attempt: call.attempt, failure: answer.failure, retryable: false });
      else await j.record({ t: "tool.outcome-unknown", callId: call.callId });
    },
  };
  const card = await cardOf(b, run.agent);
  const placements = new Map<string, Placement>();
  for (const m of card ? [card.model, ...card.modelsByClass] : []) if (m.placement) placements.set(m.endpointId, m.placement);
  const endpointIds = new Set([agent.model.endpointId, ...(agent.modelsByClass ?? []).map((m) => m.target.endpointId)]);
  // Each endpoint keeps the placement the card recorded, so the egress decision is the one the lab made. Unknown is public.
  const gateway = createGateway(
    [...endpointIds].map((id) => ({ id, baseUrl: endpoint, placement: placements.get(id) ?? "public", supportsLogprobs: false })),
    DEFAULT_POLICY,
  );
  const surface: Surface = {
    id: started.surface as SurfaceId,
    placement: "lab",
    startStream: async () => ({ push() {}, close: async () => false }),
    finalize: async () => ({ mode: "final-post", messageId: replayId }),
    askConfirm: async () => {},
    linkTo: () => "",
  };
  const deps: LoopDeps = {
    gateway,
    tools,
    kb,
    surfaces: () => surface,
    policy: DEFAULT_POLICY,
    loadAgent: async () => agent,
    // Tools and snapshots are answered from the bundle, so the version's pins are what this replay serves. The loop is this build's.
    deployed: async () => ({ tools: pins, snapshots: new Set(manifests.keys()), sandboxImages: new Set(agent.sandbox ? [agent.sandbox.imageDigest] : []), loopContract: LOOP_CONTRACT, retrieval: new Set([agent.retrieval.algorithm]) }),
    clock: { now: () => Date.now() },
    callSignal: () => ({ signal: new AbortController().signal, release() {} }),
    log,
  };
  const result = await drive({ id: replayId, kind: "run", key: `replay:${run.runId}`, thread: started.thread, owner: "replay", epoch: 1, attempts: 0, payload: null }, journal, deps);

  const replayBody = (ref: PayloadRef) => journal.bodies.get(ref.hash)?.value;
  const original = toolSteps(events, recordedBody);
  const again = toolSteps(journal.events(), replayBody);
  const finishedOf = (es: readonly StoredEvent[]) => es.findLast((e) => e.event.t === "run.finished")?.event as Extract<RunEvent, { t: "run.finished" }> | undefined;
  const before = finishedOf(events);
  const after = finishedOf(journal.events());
  const answers = { recorded: before?.answer ? recordedBody(before.answer) : null, replay: after?.answer ? (replayBody(after.answer) ?? null) : null };
  const sameTools = canonicalJson(original.map((s) => s.call)) === canonicalJson(again.map((s) => s.call));
  const sameAnswer = canonicalJson(answers.recorded) === canonicalJson(answers.replay);
  const lastStep = journal.events().findLast((e) => e.event.t === "model.completed")?.event;
  return {
    t: "replayed",
    original: run.runId,
    replay: replayId,
    agreement: { exact: sameTools && sameAnswer, sameTools, sameAnswer },
    tools: { recorded: original.map((s) => s.call), replay: again.map((s) => s.call) },
    answer: answers,
    outcome: { recorded: before?.outcome ?? null, replay: after?.outcome ?? null },
    divergence: firstDivergence(original.map((s) => s.call), again, lastStep?.t === "model.completed" ? lastStep.step : 0),
    unfinished: result.t === "finished" ? null : result.t === "retry" || result.t === "unstartable" ? result.error : result.t,
  };
}

/** The tool calls the model asked for, in order, with the step that asked. */
function toolSteps(events: readonly StoredEvent[], body: (ref: PayloadRef) => unknown): { readonly step: number; readonly call: ToolStep }[] {
  return events.flatMap(({ event: e }) => (e.t === "model.completed" ? e.toolCalls.map((c) => ({ step: e.step, call: [c.name, body(c.args)] as const })) : []));
}

function firstDivergence(recorded: readonly ToolStep[], replay: readonly { readonly step: number; readonly call: ToolStep }[], lastStep: number): Extract<ReplayReport, { t: "replayed" }>["divergence"] {
  for (let i = 0; i < Math.max(recorded.length, replay.length); i++) {
    const want = recorded[i];
    const got = replay[i];
    if (want && got && canonicalJson(want) === canonicalJson(got.call)) continue;
    return { step: got?.step ?? lastStep, asked: got?.call ?? NO_FURTHER_CALL, expected: want ?? NO_FURTHER_CALL };
  }
  return null;
}

/** A run journal in memory, seeded with the bundle's bodies by their recorded addresses. Nothing it holds is written anywhere. */
function memoryJournal(runId: RunId, seeded: ReadonlyMap<string, Labelled<unknown>>): RunJournal & { readonly bodies: ReadonlyMap<string, Labelled<unknown>> } {
  const events: StoredEvent[] = [];
  const bodies = new Map(seeded);
  const append = async (event: RunEvent): Promise<StoredEvent> => {
    const seq = events.length;
    const prev = events[seq - 1]?.hash ?? null;
    const at = new Date().toISOString();
    const c = eventClass(event);
    const stored: StoredEvent = { runId, seq, at, cls: c, prevHash: prev, hash: eventHash(runId, seq, at, c, prev, event), event };
    events.push(stored);
    return stored;
  };
  return {
    runId,
    epoch: 1,
    bodies,
    append,
    record: async (e) => {
      await append(e);
    },
    events: () => events,
    async put(content) {
      const value = canonicalJson(content.value);
      const hash = sha256(`${content.cls}\n${value}`) as string as PayloadHash;
      bodies.set(hash, content);
      return { hash, cls: content.cls, bytes: Buffer.byteLength(value) };
    },
    async get(ref) {
      const body = bodies.get(ref.hash);
      if (!body) throw new PayloadUnavailable(ref.hash, "missing");
      return body;
    },
    pendingInbox: async () => [],
    consumeInbox: (inboxId, item) => append({ t: "inbox.consumed", inboxId, item }),
  };
}

export function formatReplay(reports: readonly ReplayReport[]): string {
  const step = (s: ToolStep | typeof NO_FURTHER_CALL) => (typeof s === "string" ? s : `${s[0]} ${text(s[1])}`);
  return reports
    .flatMap((r) => {
      if (r.t === "skipped") return [`replay   ${r.original}: skipped, ${r.why}`];
      const verdict = r.agreement.exact ? "agrees exactly" : r.divergence ? `DIVERGED at step ${r.divergence.step}: asked ${step(r.divergence.asked)}, the record has ${step(r.divergence.expected)}` : "same tool calls, DIFFERENT answer";
      return [
        `replay   ${r.original} as ${r.replay}: ${verdict}`,
        `  tools recorded  ${r.tools.recorded.map(step).join("; ") || "none"}`,
        `  tools replayed  ${r.tools.replay.map(step).join("; ") || "none"}`,
        `  outcome         recorded ${r.outcome.recorded ?? "unfinished"}, replayed ${r.outcome.replay ?? "unfinished"}${r.unfinished ? ` (${r.unfinished})` : ""}`,
        ...(r.agreement.sameAnswer ? [] : [`  answer replayed ${r.answer.replay === null ? "none" : text(r.answer.replay)}`]),
      ];
    })
    .join("\n");
}
