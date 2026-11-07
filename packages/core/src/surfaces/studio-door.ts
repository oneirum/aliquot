/**
 * The web door's routes for the studio. The studio holds no payload key and
 * core gives it no database handle, so every read and write it makes of
 * core's state comes here: POST /studio/<op> with the [surfaces.studio] token, and a
 * JSON body of the signed-in actor and the op's own fields. The studio's
 * accounts are the lab's roles until sign-on, so its token is the one
 * credential the door takes an actor and a role from. Every role and class
 * check on these routes is made here.
 *
 *   kb-compile         {definition, files}            reads and stores the sources and enqueues the compile; authors and above
 *   kb-compile-result  {jobId}                        the outcome, and the snapshot manifest's coverage; mayPreview at the sources' class
 *   kb-publish         {kbId, snapshot, note?}        moves kb_heads; roleRefusal at the publish class
 *   kb-entry           {snapshot, path}               one entry's text; authors and above, below D3 only
 *   agent-check        {draft}                        the publish checks
 *   agent-publish      {draft, draftHash, changelog}  confirmPublish
 *   agent-test         {draft, thread, text}          a test message through intake on the studio surface; mayPreview at the ceiling
 *   test-run           {runId}                        the actor's own test run: agent, outcome, replies
 *   data-classes       {}                             the lab's data classes, and which published KB sources and entries carry each; any role.
 *                                                     Class names, paths and detector ids only: no source or entry text leaves the door
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseAgentDocument, type AgentDocument, type MemberId } from "../agent.ts";
import type { LabConfig } from "../config.ts";
import { rank, type SurfaceId } from "../dataclass.ts";
import type { StudioOpName } from "../door-client.ts";
import type { Db } from "../db.ts";
import { intakeTest, type IntakeDeps, type IntakeResult } from "../frontdoor.ts";
import type { PayloadHash, Sha256, SnapshotId } from "../hash.ts";
import { loadManifest, publishedSnapshots, storedSnapshots } from "../kb.ts";
import { classify, classOfLevel, strictestClass } from "../policy.ts";
import { attachedFiles, compileClass, compileResult, kbPublishClass, loadOverrides, parseKbDefinition, publishSnapshot, readSources, renderCoverage, requestCompile, type KbDefinition } from "../kb-compile.ts";
import { confirmPublish, describePublishRefusal, PublishRefused, requestPublish } from "../publish.ts";
import { loadEvents, type RunId } from "../record.ts";
import { describeRoleRefusal, mayEdit, mayPreview, roleRefusal, ROLES, type Actor } from "../roles.ts";
import type { HttpEgress } from "../tools.ts";
import { readReplies } from "./web.ts";

export interface StudioDeps {
  readonly config: LabConfig;
  readonly http: HttpEgress;
  readonly intake: IntakeDeps;
}

export interface StudioReply {
  readonly status: number;
  readonly body: unknown;
}

type Op = (deps: StudioDeps, actor: Actor, json: unknown, surface: SurfaceId) => Promise<StudioReply>;

/** The op's fields are parsed here, at the door; a ZodError is the handler's 400. */
const op =
  <S extends z.ZodType>(fields: S, run: (deps: StudioDeps, actor: Actor, body: z.output<S>, surface: SurfaceId) => Promise<StudioReply>): Op =>
  (deps, actor, json, surface) =>
    run(deps, actor, fields.parse(json), surface);

const ok = (body: unknown): StudioReply => ({ status: 200, body });
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): StudioReply => ({ status, body: { error, ...extra } });
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

const file = z.union([z.object({ name: z.string(), base64: z.string() }), z.object({ name: z.string(), text: z.string() })]);
const RESTRICTED = "D3" as const;

const OPS: Record<StudioOpName, Op> = {
  "kb-compile": op(z.object({ definition: z.unknown(), files: z.array(file) }), async ({ config, http, intake }, actor, b) => {
    if (!mayEdit(actor.role)) return refuse(403, "Authors and above compile knowledge bases.");
    let def: KbDefinition;
    try {
      def = parseKbDefinition(b.definition);
    } catch (err) {
      return refuse(409, `The saved definition cannot compile: ${reason(err)}`);
    }
    const attached = new Set(b.files.map((f) => f.name));
    const missing = def.sources.filter((s) => s.kind === "file" && !attached.has(s.location)).map((s) => s.location);
    if (missing.length) return refuse(400, `Attach ${missing.join(", ")} to compile.`);
    let sources;
    try {
      sources = attachedFiles(b.files);
    } catch (err) {
      return refuse(400, reason(err));
    }
    try {
      const loaded = await readSources(def, sources, { http, address: intake.store.address, db: intake.db, actor: actor.id, labPatterns: config.participantIdPatterns, classes: config.classes, endpointRegion: (id) => config.endpoints.find((e) => e.id === id)?.region ?? null });
      return ok(await requestCompile(intake, def, loaded, new Date()));
    } catch (err) {
      return refuse(409, reason(err));
    }
  }),

  "kb-compile-result": op(z.object({ jobId: z.string() }), async ({ intake: { db, store } }, actor, b) => {
    const cls = await compileClass(db, b.jobId);
    if (!cls) return refuse(404, "No compile has that id.");
    if (!mayPreview(actor.role, cls)) return refuse(403, `Reading a ${cls} compile needs the data steward or the PI.`);
    const result = await compileResult(db, b.jobId);
    if (result?.t !== "compiled") return ok({ result });
    const snapshot = await loadManifest(db, store.address, result.snapshot);
    if (!snapshot) return refuse(404, "That compile's snapshot is gone.");
    return ok({ result, cls: snapshot.cls, coverage: renderCoverage(snapshot, await loadOverrides(db, snapshot.id)) });
  }),

  "kb-publish": op(z.object({ kbId: z.string(), snapshot: z.string(), note: z.string().optional() }), async ({ intake: { db, store } }, actor, b) => {
    const snapshot = await loadManifest(db, store.address, b.snapshot as SnapshotId);
    if (!snapshot || snapshot.kbId !== b.kbId) return refuse(404, `That snapshot is not a compile of ${b.kbId}.`);
    const refusal = roleRefusal(actor, await kbPublishClass(db, snapshot));
    if (refusal) return refuse(403, describeRoleRefusal(refusal));
    const note = b.note?.trim() ? { note: b.note } : null;
    try {
      const result = await publishSnapshot(db, store.address, snapshot.id, actor.id, note);
      if (!result.ok)
        return refuse(
          409,
          `Not published. No entry supports ${result.gaps.length === 1 ? "this coverage question" : `these ${result.gaps.length} coverage questions`}: ${result.gaps.join("; ")}. Add a source that answers it, or publish over the gaps with a note.`,
          { gaps: result.gaps },
        );
      return ok(result);
    } catch (err) {
      return refuse(409, reason(err));
    }
  }),

  "kb-entry": op(z.object({ snapshot: z.string(), path: z.string() }), async ({ intake: { db, store } }, actor, b) => {
    if (!mayEdit(actor.role)) return refuse(403, "Authors and above read knowledge base entries in the studio.");
    const manifest = await loadManifest(db, store.address, b.snapshot as SnapshotId);
    if (!manifest) return refuse(404, "No snapshot has that id.");
    // No D3 entry text reaches the studio's process, which runs outside the seal.
    if (rank(manifest.cls) >= rank(RESTRICTED)) return refuse(403, `The studio does not show ${manifest.cls} entries.`);
    const entry = (await storedSnapshots(db, store).load(manifest.id))?.entries.find((e) => e.path === b.path);
    if (!entry) return refuse(404, `Snapshot ${manifest.id.slice(0, 12)} has no entry ${b.path}.`);
    return ok({ cls: manifest.cls, path: entry.path, title: entry.title, body: entry.body });
  }),

  "agent-check": op(z.object({ draft: z.unknown() }), async ({ intake: { db, catalog } }, actor, b) => {
    const draft = parseAgentDocument(b.draft);
    if (!draft.ok) return ok({ check: null, issues: draft.issues });
    const check = await requestPublish({ db, catalog }, draft.doc, actor);
    return ok({ check, refusal: check.refusal ? describePublishRefusal(check.refusal) : null });
  }),

  "agent-publish": op(z.object({ draft: z.unknown(), draftHash: z.string(), changelog: z.string() }), async ({ intake: { db, catalog } }, actor, b) => {
    const draft = parseAgentDocument(b.draft);
    if (!draft.ok) return refuse(409, describePublishRefusal({ t: "invalid", issues: draft.issues }));
    try {
      return ok(await confirmPublish({ db, catalog }, draft.doc, b.draftHash as Sha256, actor, b.changelog));
    } catch (err) {
      if (err instanceof PublishRefused) return refuse(err.refusal.t === "role" ? 403 : 409, err.message, { refusal: err.refusal });
      throw err;
    }
  }),

  "agent-test": op(z.object({ draft: z.unknown(), thread: z.string().min(1), text: z.string() }), async ({ intake }, actor, b, surface) => {
    const text = b.text.trim();
    if (!text) return refuse(400, "Write a message to test with.");
    const draft = parseAgentDocument(b.draft);
    if (!draft.ok) return refuse(409, describePublishRefusal({ t: "invalid", issues: draft.issues }));
    if (!mayPreview(actor.role, draft.doc.ceiling)) return refuse(403, `Testing an agent at ${draft.doc.ceiling} needs the data steward or the PI.`);
    return ok(await testDraft(draft.doc, { member: actor.id, thread: b.thread, message: randomUUID(), text }, intake, surface));
  }),

  "data-classes": op(z.object({}), async ({ config, intake: { db, store } }) => {
    const policy = config.classes;
    const knowledgeBases = [];
    for (const snapshot of await publishedSnapshots(db, store.address)) {
      const sources = await Promise.all(
        snapshot.sources.map(async (s) => {
          const body = await store.get({ hash: s.contentHash as string as PayloadHash, cls: s.cls, bytes: 0 });
          const c = "redacted" in body ? null : classify(policy, { t: "entry", text: String(body.value), declared: s.cls });
          return { sourceId: s.sourceId, level: s.cls, class: c?.class ?? classOfLevel(policy, s.cls).id, rule: c?.rule ?? "redacted", detectors: [...new Set(c?.spans.map((x) => x.detector) ?? [])] };
        }),
      );
      const bySource = new Map(sources.map((s) => [s.sourceId, s.class]));
      const loaded = await storedSnapshots(db, store).load(snapshot.id);
      const entries = (loaded?.entries ?? []).map((e) => ({ path: e.path, class: strictestClass(policy, [...new Set(e.facts.flatMap((f) => f.sources.flatMap((x) => (bySource.has(x.sourceId) ? [bySource.get(x.sourceId)!] : []))))]).id }));
      knowledgeBases.push({ kbId: snapshot.kbId, title: snapshot.title, snapshot: snapshot.id, level: snapshot.cls, sources, entries });
    }
    const preset = config.preset && { id: config.preset.id, campus: config.preset.campus, scheme: config.preset.scheme, source: config.preset.source, note: config.preset.note };
    return ok({ classes: policy.classes, knowledgeBases, preset });
  }),

  "test-run": op(z.object({ runId: z.string() }), async ({ intake: { db } }, actor, b) => {
    if (!/^[0-9a-f-]{36}$/.test(b.runId)) return refuse(400, "Not a run id.");
    const runId = b.runId as RunId;
    if (!(await isTestRunOf(db, runId, actor.id))) return refuse(404, "No test run of yours has that id.");
    const events = await loadEvents(db, runId);
    const started = events.find((e) => e.event.t === "run.started")?.event;
    const finished = events.find((e) => e.event.t === "run.finished")?.event;
    return ok({
      agent: started?.t === "run.started" ? started.agent : null,
      outcome: finished?.t === "run.finished" ? finished.outcome : null,
      replies: await readReplies(db, runId),
    });
  }),
};

/** Did this member start this run from the studio's test thread? Only they read its replies there. */
export async function isTestRunOf(db: Db, runId: RunId, member: string): Promise<boolean> {
  const row = await db.query("select 1 from jobs where id::text = $1 and kind = 'run' and payload->'trigger'->>'t' = 'test' and payload->'trigger'->>'memberId' = $2", [runId, member]);
  return row.rowCount === 1;
}

/** The studio's test thread is a thread on the studio's surface, in channel "studio": replies land in web_messages like any door answer. */
export function testDraft(draft: AgentDocument, m: { readonly member: string; readonly thread: string; readonly message: string; readonly text: string }, deps: IntakeDeps, surface: SurfaceId): Promise<IntakeResult> {
  return intakeTest(
    { channel: { surface, channelId: "studio" }, threadId: m.thread, messageId: m.message, platformUserId: m.member, text: m.text, attachments: [], addressed: true, at: new Date().toISOString() },
    draft,
    deps,
  );
}

const actorSchema = z.object({ id: z.string().min(1), role: z.enum(ROLES) });

/** One studio request: the op by name, the actor the studio signed in, and the op's fields from the same body. */
export function studioRoute(deps: StudioDeps, surface: SurfaceId, name: string, json: unknown): Promise<StudioReply> {
  const run = Object.hasOwn(OPS, name) ? OPS[name as StudioOpName] : undefined;
  if (!run) return Promise.resolve(refuse(404, `no studio route ${name}`));
  const { actor } = z.object({ actor: actorSchema }).parse(json);
  return run(deps, { id: actor.id as MemberId, role: actor.role }, json, surface);
}
