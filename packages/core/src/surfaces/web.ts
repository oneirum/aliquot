/**
 * The lab-hosted web surface: a Surface over the web_messages table, plus the
 * HTTP handler the app serves. Both sides share Postgres, so the worker posts
 * replies here and the page reads them, with no second channel.
 *
 * Routes:
 *   POST /message  {channel?, thread, message, text, user}  -> intake as the caller's surface; a bound web surface serves only its own channel
 *   POST /stop     {runId, user, confirmed?}                -> run_inbox stop (+ NOTIFY); confirmed is the second click
 *   GET  /replies?runId=                                     -> the run's reply and notices
 *   GET  /runs/:id/events                                    -> the run record (events, no bodies)
 *   GET  /runs/:id/view                                      -> the record as the record page shows it, chain recomputed
 *   GET  /                                                   -> the member chat page
 *   GET  /runs?show=refusals|failed                          -> the newest runs, optionally only those with a refusal or that failed
 *   GET  /runs/:id                                           -> the read-only record page
 *   POST /studio/<op>  {actor, ...}                          -> the studio's reads and writes of core (studio-door.ts), studio token only
 *
 * Pages and JSON go out gzipped when the browser accepts it.
 *
 * "Bearer <token>" names a surface the door serves (DOOR_KINDS), and a bearer
 * the door does not accept is a 401 that never falls back to web. Any other
 * request is the web surface, as before tokens. The studio's token reaches
 * /studio routes only, and only the studio's token reaches them. /stop and /replies serve only
 * the caller's surface's runs. That keeps each client on its own surface, but
 * it is not access control while web has no sign-in: anyone who reaches the
 * door can ask as web.
 *
 * Bodies are capped at MAX_BODY_BYTES, ids are validated before any query,
 * and an unexpected error is logged here and answered as "internal error".
 * Not yet done, recorded in DESIGN.md: sign-on for the web surface, and
 * per-member authorization on /stop, /replies and /runs/:id/events. The
 * identity unit owns both.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import type { SurfaceId } from "../dataclass.ts";
import type { Db } from "../db.ts";
import { intake, type IntakeDeps, type Surface } from "../frontdoor.ts";
import { loadEvents, sendToInbox, type RunId } from "../record.ts";
import { recordView } from "../record-view.ts";
import type { LabConfig, SurfaceConfig, SurfaceKind, TokenSurfaceConfig } from "../config.ts";
import { chatPage, recordPage, runsPage, type RunFilter, type RunListRow } from "./web-pages.ts";

export const WEB_SURFACE = "web" as SurfaceId;

/** A surface over web_messages: the web page's, or one that reaches the door with a token. Its link is the record page. */
export function createWebSurface(db: Db, config: LabConfig, surface: Pick<SurfaceConfig, "id" | "placement"> = config.web): Surface {
  return {
    id: surface.id,
    placement: surface.placement,
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
    linkTo: (runId) => `${config.web.baseUrl}/runs/${runId}`,
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

/** Kinds the door serves over HTTP. The Slack door (aliquot slack) is a client too, with its surface's token, never a Slack token. */
export const DOOR_KINDS: readonly SurfaceKind[] = ["acp", "mcp", "phone", "studio", "slack"];
/** Shorter than this, a token could be guessed, so its surface accepts nothing. */
const MIN_TOKEN_LENGTH = 32;

/** sha256 hex of a token to its surface. The door keeps no token. */
export type DoorTokens = ReadonlyMap<string, TokenSurfaceConfig>;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Built once when the door starts. A surface whose env var is unset or short accepts nothing, and the door says so in one
 * line. Two surfaces with one token could not be told apart, so that refuses to start.
 */
export function doorTokens(surfaces: readonly SurfaceConfig[], env: NodeJS.ProcessEnv, log: (line: string) => void): DoorTokens {
  const tokens = new Map<string, TokenSurfaceConfig>();
  for (const s of surfaces) {
    if (s.kind === "web" || !DOOR_KINDS.includes(s.kind)) continue;
    const token = env[s.tokenEnv] ?? "";
    if (token.length < MIN_TOKEN_LENGTH) {
      log(`[web] [surfaces.${s.id}] accepts no token: ${s.tokenEnv} is ${token ? `shorter than ${MIN_TOKEN_LENGTH} characters` : "not set"}`);
      continue;
    }
    // Looked up by hash, so how long a lookup takes does not depend on how much of a real token a guess matches.
    const hash = sha256(token);
    const other = tokens.get(hash);
    if (other) throw new Error(`${other.tokenEnv} and ${s.tokenEnv} hold the same token; [surfaces.${other.id}] and [surfaces.${s.id}] each need their own`);
    tokens.set(hash, s);
  }
  return tokens;
}

/** A message is at most the router's 8,000 characters plus ids; anything near this is not a chat message. */
export const MAX_BODY_BYTES = 64 * 1024;
/** A studio compile carries its source files, base64 in JSON. */
export const STUDIO_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Serves POST /studio/<op> for the studio's surface: studioRoute in studio-door.ts, bound to the door's core. */
export type StudioHandler = (surface: SurfaceId, op: string, json: unknown) => Promise<{ readonly status: number; readonly body: unknown }>;

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

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of req) {
    bytes += (c as Buffer).length;
    if (bytes > limit) throw new HttpError(413, `body exceeds ${limit} bytes`);
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

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  respond(req, res, status, { "content-type": "application/json", ...headers }, JSON.stringify(body));
}

/**
 * The surface a request speaks as. A bearer the door does not accept is never web. Any other request is web, including
 * one carrying a reverse proxy's Basic credentials, which nginx and Traefik forward upstream by default.
 */
function surfaceOf(req: IncomingMessage, tokens: DoorTokens): { readonly id: SurfaceId; readonly kind: SurfaceKind } {
  const header = req.headers.authorization ?? "";
  if (!/^bearer\b/i.test(header)) return { id: WEB_SURFACE, kind: "web" };
  const token = /^Bearer (\S+)$/i.exec(header)?.[1];
  if (!token) throw new HttpError(401, "Authorization must be Bearer <surface token>");
  const surface = tokens.get(sha256(token));
  if (!surface) throw new HttpError(401, "unknown surface token");
  return surface;
}

async function requireOwnRun(db: Db, runId: string, surface: SurfaceId): Promise<void> {
  const run = await db.query("select 1 from jobs where id = $1 and kind = 'run' and payload->>'surface' = $2", [runId, surface]);
  if (!run.rowCount) throw new HttpError(404, "no such run");
}

/**
 * bound is lab.toml's [surfaces.web] channel: when set, every message is in that channel and the body may not name another.
 * where is what the pages show as the lab: its [lab] name, else the machine's hostname.
 * tokens is doorTokens(): without it, only the web surface is served.
 * studio serves the /studio routes (studio-door.ts); without it, they answer 404.
 */
export function createWebHandler(
  db: Db,
  deps: IntakeDeps,
  log: (line: string) => void = (line) => console.error(line),
  bound: string | null = null,
  where = "",
  tokens: DoorTokens = new Map(),
  studio: StudioHandler | null = null,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const caller = surfaceOf(req, tokens);
      const surface = caller.id;
      const studioPath = /^\/studio\/([a-z-]+)$/.exec(url.pathname);
      if (studioPath || url.pathname.startsWith("/studio")) {
        if (caller.kind !== "studio") throw new HttpError(401, "the /studio routes take the [surfaces.studio] token");
        if (!studio || !studioPath || req.method !== "POST") throw new HttpError(404, "not found");
        const reply = await studio(surface, studioPath[1]!, await readJson(req, STUDIO_MAX_BODY_BYTES));
        return send(req, res, reply.status, reply.body);
      }
      if (caller.kind === "studio") throw new HttpError(403, "the studio's token reaches the /studio routes only");
      const boundHere = surface === WEB_SURFACE ? bound : null;
      if (req.method === "POST" && url.pathname === "/message") {
        const m = messageSchema.parse(await readJson(req));
        if (boundHere !== null && m.channel !== undefined && m.channel !== boundHere) throw new HttpError(400, `this web surface serves channel ${boundHere} only`);
        const result = await intake(
          { channel: { surface, channelId: boundHere ?? m.channel ?? "lab" }, threadId: m.thread, messageId: m.message, platformUserId: m.user, text: m.text, attachments: [], addressed: true, at: new Date().toISOString() },
          deps,
        );
        return send(req, res, result.t === "refused" ? 403 : 202, result);
      }
      if (req.method === "POST" && url.pathname === "/stop") {
        const s = stopSchema.parse(await readJson(req));
        await requireOwnRun(db, s.runId, surface);
        const inboxId = await sendToInbox(db, s.runId as RunId, { t: "stop", confirmed: s.confirmed, by: s.user });
        return send(req, res, 202, { inboxId });
      }
      if (req.method === "GET" && url.pathname === "/replies") {
        const runId = uuid.safeParse(url.searchParams.get(`runId`));
        if (!runId.success) throw new HttpError(400, "runId must be a uuid");
        await requireOwnRun(db, runId.data, surface);
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
      if (err instanceof HttpError) return send(req, res, err.status, { error: err.message }, err.status === 401 ? { "www-authenticate": "Bearer" } : {});
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
