/**
 * The lab-hosted web surface: a Surface over the web_messages table, plus the
 * HTTP handler the app serves. Both sides share Postgres, so the worker posts
 * replies here and the page reads them, with no second channel.
 *
 * Routes:
 *   POST /message  {channel?, thread, message, text, user}  -> intake; a bound surface serves only its own channel
 *   POST /stop     {runId, user, confirmed?}                -> run_inbox stop (+ NOTIFY); confirmed is the second click
 *   GET  /replies?runId=                                     -> the run's reply and notices
 *   GET  /runs/:id/events                                    -> the run record (events, no bodies)
 *   GET  /runs/:id/view                                      -> the record as the record page shows it, chain recomputed
 *   GET  /                                                   -> the member chat page
 *   GET  /runs?show=refusals|failed                          -> the newest runs, optionally only those with a refusal or that failed
 *   GET  /runs/:id                                           -> the read-only record page
 *
 * Pages and JSON go out gzipped when the browser accepts it.
 *
 * Bodies are capped at MAX_BODY_BYTES, ids are validated before any query,
 * and an unexpected error is logged here and answered as "internal error".
 * Not yet done, recorded in DESIGN.md: authentication, and per-run
 * authorization on /stop, /replies and /runs/:id/events. The identity unit
 * owns both.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import type { SurfaceId } from "../dataclass.ts";
import type { Db } from "../db.ts";
import type { AgentDocument } from "../agent.ts";
import { intake, intakeTest, type IntakeDeps, type IntakeResult, type Surface } from "../frontdoor.ts";
import { loadEvents, sendToInbox, type RunId } from "../record.ts";
import { recordView } from "../record-view.ts";
import type { LabConfig } from "../config.ts";
import { chatPage, recordPage, runsPage, type RunFilter, type RunListRow } from "./web-pages.ts";

export const WEB_SURFACE = "web" as SurfaceId;

export function createWebSurface(db: Db, config: LabConfig): Surface {
  return {
    id: WEB_SURFACE,
    placement: config.web.placement,
    async startStream() {
      // No streaming on the web page in this build: close() reports the stream unconfirmed, so finalize posts the answer.
      return { push() {}, close: async () => false };
    },
    async finalize(runId, threadId, text) {
      await db.query("insert into web_finalize_attempts (run_id) values ($1)", [runId]);
      const inserted = await db.query<{ id: string }>(
        "insert into web_messages (run_id, thread_id, kind, text) values ($1, $2, 'reply', $3) on conflict (run_id) where kind = 'reply' do nothing returning id",
        [runId, threadId, text],
      );
      const id = inserted.rows[0]?.id ?? (await db.query<{ id: string }>("select id from web_messages where run_id = $1 and kind = 'reply'", [runId])).rows[0]!.id;
      return { mode: "final-post", messageId: String(id) };
    },
    async askConfirm(runId, threadId, prompt, callId) {
      await db.query("insert into web_messages (run_id, thread_id, kind, key, text) values ($1, $2, 'notice', $3, $4) on conflict (run_id, key) where kind = 'notice' do nothing", [runId, threadId, callId, prompt]);
    },
    linkTo: (runId) => `${config.web.baseUrl}/chat/runs/${runId}`,
  };
}

export interface WebReply {
  readonly kind: "reply" | "notice";
  readonly text: string;
  readonly at: string;
}

export async function readReplies(db: Db, runId: RunId): Promise<WebReply[]> {
  const rows = await db.query<{ kind: WebReply["kind"]; text: string; at: Date }>("select kind, text, at from web_messages where run_id = $1 order by id", [runId]);
  return rows.rows.map((r) => ({ kind: r.kind, text: r.text, at: r.at.toISOString() }));
}

/** Did this member start this run from the studio's test thread? Only they read its replies there. */
export async function isTestRunOf(db: Db, runId: RunId, member: string): Promise<boolean> {
  const row = await db.query("select 1 from jobs where id::text = $1 and kind = 'run' and payload->'trigger'->>'t' = 'test' and payload->'trigger'->>'memberId' = $2", [runId, member]);
  return row.rowCount === 1;
}

/** The studio's test thread is a web thread in channel "studio": replies land in web_messages like any web answer. */
export function testDraft(draft: AgentDocument, m: { readonly member: string; readonly thread: string; readonly message: string; readonly text: string }, deps: IntakeDeps): Promise<IntakeResult> {
  return intakeTest(
    { channel: { surface: WEB_SURFACE, channelId: "studio" }, threadId: m.thread, messageId: m.message, platformUserId: m.member, text: m.text, attachments: [], addressed: true, at: new Date().toISOString() },
    draft,
    deps,
  );
}

/** How many runs the runs page lists. */
export const RUNS_LISTED = 100;

/** The newest runs, from their events alone: no bodies, and no chain check (each record page verifies its own chain). */
export async function listRuns(db: Db, limit = RUNS_LISTED): Promise<RunListRow[]> {
  const rows = await db.query<{ run_id: string; at: Date; agent: string | null; outcome: string; events: number; refusals: number }>(
    `select s.run_id, s.at, s.event->>'agent' as agent,
         coalesce((select f.event->>'outcome' from run_events f where f.run_id = s.run_id and f.event->>'t' = 'run.finished' limit 1), 'running') as outcome,
         (select count(*) from run_events e where e.run_id = s.run_id)::int as events,
         (select count(*) from run_events e where e.run_id = s.run_id and e.event->>'t' in ('egress.refused', 'tool.withheld'))::int as refusals
     from run_events s where s.seq = 0 order by s.at desc, s.run_id limit $1`,
    [limit],
  );
  return rows.rows.map((r) => ({ runId: r.run_id, startedAt: r.at.toISOString(), agent: r.agent, outcome: r.outcome, events: r.events, refusals: r.refusals }));
}

/** A message is at most the router's 8,000 characters plus ids; anything near this is not a chat message. */
export const MAX_BODY_BYTES = 64 * 1024;

const messageSchema = z.object({ channel: z.string().optional(), thread: z.string().min(1), message: z.string().min(1), text: z.string().min(1), user: z.string().min(1) });
const stopSchema = z.object({ runId: z.string().uuid(), user: z.string().min(1), confirmed: z.boolean().default(false) });
const uuid = z.string().uuid();

/** A response the handler chose. Anything else that is thrown is an internal error: logged in full, answered without its text. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of req) {
    bytes += (c as Buffer).length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, `body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

/** Gzip anything over a kilobyte when the browser accepts it: a page then fits in the first round trip. */
function respond(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string>, text: string): void {
  const gzip = text.length > 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  res.writeHead(status, { ...headers, vary: "accept-encoding", ...(gzip ? { "content-encoding": "gzip" } : {}) });
  res.end(gzip ? gzipSync(text) : text);
}

function sendHtml(req: IncomingMessage, res: ServerResponse, html: string): void {
  respond(req, res, 200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'", "x-content-type-options": "nosniff" }, html);
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  respond(req, res, status, { "content-type": "application/json" }, JSON.stringify(body));
}

/**
 * bound is lab.toml's [surfaces.web] channel: when set, every message is in that channel and the body may not name another.
 * where is what the pages show as the lab: its [lab] name, else the machine's hostname.
 */
export function createWebHandler(db: Db, deps: IntakeDeps, log: (line: string) => void = (line) => console.error(line), bound: string | null = null, where = ""): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST" && url.pathname === "/message") {
        const m = messageSchema.parse(await readJson(req));
        if (bound !== null && m.channel !== undefined && m.channel !== bound) throw new HttpError(400, `this web surface serves channel ${bound} only`);
        const result = await intake(
          { channel: { surface: WEB_SURFACE, channelId: bound ?? m.channel ?? "lab" }, threadId: m.thread, messageId: m.message, platformUserId: m.user, text: m.text, attachments: [], addressed: true, at: new Date().toISOString() },
          deps,
        );
        return send(req, res, result.t === "refused" ? 403 : 202, result);
      }
      if (req.method === "POST" && url.pathname === "/stop") {
        const s = stopSchema.parse(await readJson(req));
        const run = await db.query("select 1 from jobs where id = $1 and kind = 'run'", [s.runId]);
        if (!run.rowCount) throw new HttpError(404, "no such run");
        const inboxId = await sendToInbox(db, s.runId as RunId, { t: "stop", confirmed: s.confirmed, by: s.user });
        return send(req, res, 202, { inboxId });
      }
      if (req.method === "GET" && url.pathname === "/replies") {
        const runId = uuid.safeParse(url.searchParams.get(`runId`));
        if (!runId.success) throw new HttpError(400, "runId must be a uuid");
        return send(req, res, 200, await readReplies(db, runId.data as RunId));
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/chat")) return sendHtml(req, res, chatPage(where));
      if (req.method === "GET" && url.pathname === "/runs") {
        const show = url.searchParams.get("show");
        const filter: RunFilter = show === "refusals" || show === "failed" ? show : "all";
        return sendHtml(req, res, runsPage(await listRuns(db), filter, RUNS_LISTED, where));
      }
      const runPath = /^\/runs\/([^/]+)(?:\/(events|view))?$/.exec(url.pathname);
      if (req.method === "GET" && runPath) {
        const runId = uuid.safeParse(runPath[1]);
        if (!runId.success) throw new HttpError(404, "not found");
        const events = await loadEvents(db, runId.data as RunId);
        if (!runPath[2]) return sendHtml(req, res, recordPage(recordView(runId.data, events), where));
        return send(req, res, 200, runPath[2] === "events" ? events : recordView(runId.data, events));
      }
      send(req, res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) return send(req, res, err.status, { error: err.message });
      if (err instanceof z.ZodError) return send(req, res, 400, { error: "invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      log(`[web] ${req.method} ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      send(req, res, 500, { error: "internal error" });
    }
  };
}

/** Loopback unless the caller names another address, as the compose stack does inside its container. */
export async function listenWeb(handler: ReturnType<typeof createWebHandler>, port: number, host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => void handler(req, res));
  server.listen(port, host);
  await once(server, "listening");
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : port };
}
