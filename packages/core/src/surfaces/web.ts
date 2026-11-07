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
 *   GET  /manifest.webmanifest, /sw.js, /icons/:name, /fonts/:name -> what installs the chat page as an app, and its typefaces (web-app.ts)
 *   GET  /runs?show=refusals|failed                          -> the newest runs, optionally only those with a refusal or that failed
 *   GET  /runs/:id                                           -> the read-only record page
 *   GET  /runs/:id/source?path=, /runs/:id/source.json?path= -> the entry the answer cites, read-only (web-source.ts)
 *   GET  /login?next=, /callback, /logout                    -> sign-on, when lab.toml has [auth] (signon.ts)
 *   POST /studio/<op>  {actor, ...}                          -> the studio's reads and writes of core (studio-door.ts), studio token only
 *
 * Pages and JSON go out gzipped when the browser accepts it. Answers, the runs list and records go out no-store, so no
 * browser cache keeps them on the device.
 *
 * "Bearer <token>" names a surface the door serves (DOOR_KINDS), and a bearer
 * the door does not accept is a 401 that never falls back to web. Any other
 * request is the web surface. The studio's token reaches /studio routes only,
 * and only the studio's token reaches them. /stop and /replies serve only the
 * caller's surface's runs.
 *
 * Who is asking (Viewer). Without [auth], the web surface trusts the user in
 * the body and every record is open, which is why the door then listens on
 * loopback only. With [auth], a web request is the member its session cookie
 * names and nobody else: a body user is ignored, the runs list and every
 * record route show only the member's own runs (the steward and the PI see
 * all), another member's run is a 404 so its id says nothing, and a browser
 * without a session gets the sign-in page. A token surface then reads only its
 * own surface's runs.
 *
 * Bodies are capped at MAX_BODY_BYTES, ids are validated before any query,
 * and an unexpected error is logged here and answered as "internal error".
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import type { MemberId } from "../agent.ts";
import type { SurfaceId } from "../dataclass.ts";
import type { Db } from "../db.ts";
import { intake, type IntakeDeps, type Surface } from "../frontdoor.ts";
import type { KbReader } from "../kb.ts";
import { loadEvents, sendToInbox, type RunId } from "../record.ts";
import { recordView } from "../record-view.ts";
import { seesAllRuns, type Role } from "../roles.ts";
import type { LabConfig, SurfaceConfig, SurfaceKind, TokenSurfaceConfig } from "../config.ts";
import { SignOnRefused, type SignOn } from "./signon.ts";
import { chatPage } from "./web-chat.ts";
import { recordPage, runsPage, signInPage, type RunFilter, type RunListRow } from "./web-pages.ts";
import { citedEntry, sourceChip, sourcePage, sourceStatus } from "./web-source.ts";
import { appAsset, appManifest, SERVICE_WORKER, type AssetDir } from "./web-app.ts";

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

/**
 * The newest runs, from their events alone: no bodies, and no chain check (each record page verifies its own chain).
 * member narrows them to the runs that member asked; null lists everyone's.
 */
/** Which runs a list shows: all (null), one surface's, or one member's on one surface. */
export interface RunScope {
  readonly surface: string;
  readonly member: MemberId | null;
}

export async function listRuns(db: Db, limit = RUNS_LISTED, scope: RunScope | null = null): Promise<RunListRow[]> {
  const rows = await db.query<{ run_id: string; at: Date; agent: string | null; outcome: string; events: number; refusals: number }>(
    `select s.run_id, s.at, s.event->>'agent' as agent,
         coalesce((select f.event->>'outcome' from run_events f where f.run_id = s.run_id and f.event->>'t' = 'run.finished' limit 1), 'running') as outcome,
         (select count(*) from run_events e where e.run_id = s.run_id)::int as events,
         (select count(*) from run_events e where e.run_id = s.run_id and e.event->>'t' in ('egress.refused', 'tool.withheld'))::int as refusals
     from run_events s where s.seq = 0 and ($2::text is null or s.event->>'surface' = $2) and ($3::text is null or s.event->'trigger'->>'memberId' = $3)
     order by s.at desc, s.run_id limit $1`,
    [limit, scope?.surface ?? null, scope?.member ?? null],
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

// user is required unless sign-on names the member, and ignored when it does.
const messageSchema = z.object({ channel: z.string().optional(), thread: z.string().min(1), message: z.string().min(1), text: z.string().min(1), user: z.string().min(1).optional() });
const stopSchema = z.object({ runId: z.string().uuid(), user: z.string().min(1).optional(), confirmed: z.boolean().default(false) });
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

const NO_STORE = { "cache-control": "no-store" };

function sendHtml(req: IncomingMessage, res: ServerResponse, html: string, headers: Record<string, string> = {}, status = 200): void {
  respond(req, res, status, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; worker-src 'self'", "x-content-type-options": "nosniff", ...headers }, html);
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

/**
 * Who a request speaks for. open: sign-on is off, so the web surface trusts the body's user and records are open, as
 * before sign-on. member: the session's member. surface: a token surface while sign-on is on, which reads its own runs.
 *
 * A member's own runs are the ones they asked signed in, on the web surface. A token client names whatever member it
 * likes, so a token surface's run is never a member's own: only the data steward and the PI see it.
 */
type Viewer = { readonly t: "open" } | { readonly t: "member"; readonly id: MemberId; readonly email: string; readonly role: Role } | { readonly t: "surface"; readonly id: SurfaceId };

/** The run's surface and the member who asked it, from the job intake wrote, or null when there is no such run. */
async function runOwner(db: Db, runId: string): Promise<{ readonly surface: string; readonly member: string | null } | null> {
  const row = await db.query<{ surface: string; member: string | null }>("select payload->>'surface' as surface, payload->'trigger'->>'memberId' as member from jobs where id = $1 and kind = 'run'", [runId]);
  return row.rows[0] ?? null;
}

/** 404, never 403, for a run the viewer may not see, so a run id says nothing about whether it exists. */
async function requireVisible(db: Db, runId: string, viewer: Viewer): Promise<void> {
  if (viewer.t === "open" || (viewer.t === "member" && seesAllRuns(viewer.role))) return;
  const owner = await runOwner(db, runId);
  const mine = viewer.t === "member" ? owner?.surface === WEB_SURFACE && owner.member === viewer.id : owner?.surface === viewer.id;
  if (!mine) throw new HttpError(404, "no such run");
}

/** /stop and /replies: a run on the caller's surface, and with sign-on, the member's own (the steward and the PI may act on any). */
async function requireOwnRun(db: Db, runId: string, surface: SurfaceId, viewer: Viewer): Promise<void> {
  const owner = await runOwner(db, runId);
  if (!owner || owner.surface !== surface) throw new HttpError(404, "no such run");
  if (viewer.t === "member" && !seesAllRuns(viewer.role) && owner.member !== viewer.id) throw new HttpError(404, "no such run");
}

/** The browser pages, which a browser without a session sees as the sign-in page. Everything else answers 401. */
const PAGE = /^\/(?:chat)?$|^\/runs(?:\/[^/]+(?:\/source)?)?$/;

function redirect(res: ServerResponse, location: string, cookies: readonly string[] = []): void {
  res.writeHead(302, { location, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": [...cookies] } : {}) });
  res.end();
}

/**
 * bound is lab.toml's [surfaces.web] channel: when set, every message is in that channel and the body may not name another.
 * where is what the pages show as the lab: its [lab] name, else the machine's hostname.
 * tokens is doorTokens(): without it, only the web surface is served.
 * studio serves the /studio routes (studio-door.ts); without it, they answer 404.
 * access.signOn is [auth]'s sign-on (createSignOn); without it, the web surface trusts the body's user, as before sign-on.
 * access.kb reads the entries answers cite; without it, the source routes answer 404.
 */
export function createWebHandler(
  db: Db,
  deps: IntakeDeps,
  log: (line: string) => void = (line) => console.error(line),
  bound: string | null = null,
  where = "",
  tokens: DoorTokens = new Map(),
  studio: StudioHandler | null = null,
  access: { readonly signOn?: SignOn; readonly kb?: KbReader } = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { signOn, kb } = access;
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
      if (req.method === "GET" && url.pathname === "/manifest.webmanifest") return respond(req, res, 200, { "content-type": "application/manifest+json", "cache-control": "no-cache" }, JSON.stringify(appManifest(where)));
      if (req.method === "GET" && url.pathname === "/sw.js") return respond(req, res, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }, SERVICE_WORKER);
      const assetPath = /^\/(icons|fonts)\/([^/]+)$/.exec(url.pathname);
      const asset = req.method === "GET" && assetPath ? appAsset(assetPath[1] as AssetDir, assetPath[2]!) : null;
      if (asset) {
        res.writeHead(200, { "content-type": asset.type, "content-length": String(asset.body.length), "cache-control": "public, max-age=86400" });
        return void res.end(asset.body);
      }

      let viewer: Viewer = { t: "open" };
      if (signOn && caller.kind === "web") {
        if (req.method === "GET" && (url.pathname === "/login" || url.pathname === "/callback")) {
          try {
            if (url.pathname === "/login") {
              const login = await signOn.begin(url.searchParams.get("next"));
              return redirect(res, login.location, [login.setCookie]);
            }
            const done = await signOn.finish(url.searchParams, req.headers.cookie);
            return redirect(res, done.next, done.setCookie);
          } catch (err) {
            if (!(err instanceof SignOnRefused)) throw err;
            return sendHtml(req, res, signInPage(where, signOn.provider, "/", err.message), NO_STORE, 403);
          }
        }
        // POST only, as the page's Sign out form sends it, so an image or a link on another page cannot sign anyone out.
        if (req.method === "POST" && url.pathname === "/logout") return redirect(res, "/?signed-out", signOn.signOut());
        const session = await signOn.session(req.headers.cookie);
        const page = req.method === "GET" && PAGE.test(url.pathname);
        if (session.t === "idle") {
          // Automatic logoff: the session ends, and a page goes straight back through the provider to where it was.
          if (page) return redirect(res, `/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, [session.setCookie]);
          res.setHeader("set-cookie", session.setCookie);
          throw new HttpError(401, `your session ended after ${session.minutes} minutes unused: sign in again at /login`);
        }
        if (session.t === "none") {
          if (page) {
            const note = url.searchParams.has("signed-out") ? "You are signed out." : null;
            return sendHtml(req, res, signInPage(where, signOn.provider, url.searchParams.has("signed-out") ? "/" : `${url.pathname}${url.search}`, note), NO_STORE, 401);
          }
          throw new HttpError(401, "sign in first: open /login in a browser");
        }
        // SameSite=Lax keeps the cookie off another site's POST; this also refuses one from an origin the door does not serve.
        const origin = req.headers.origin;
        if (req.method === "POST" && origin && origin !== signOn.origin && URL.parse(origin)?.host !== req.headers.host) throw new HttpError(403, `a signed-in POST must come from ${signOn.origin}`);
        res.setHeader("set-cookie", session.setCookie);
        viewer = { t: "member", id: session.member.id, email: session.member.email, role: session.member.role };
      } else if (signOn) viewer = { t: "surface", id: surface };

      const boundHere = surface === WEB_SURFACE ? bound : null;
      if (req.method === "POST" && url.pathname === "/message") {
        const m = messageSchema.parse(await readJson(req));
        if (boundHere !== null && m.channel !== undefined && m.channel !== boundHere) throw new HttpError(400, `this web surface serves channel ${boundHere} only`);
        const user = viewer.t === "member" ? viewer.id : m.user;
        if (!user) throw new HttpError(400, "user is required: the door has no sign-on to name the member");
        const result = await intake(
          { channel: { surface, channelId: boundHere ?? m.channel ?? "lab" }, threadId: m.thread, messageId: m.message, platformUserId: user, text: m.text, attachments: [], addressed: true, at: new Date().toISOString() },
          deps,
        );
        return send(req, res, result.t === "refused" ? 403 : 202, result);
      }
      if (req.method === "POST" && url.pathname === "/stop") {
        const s = stopSchema.parse(await readJson(req));
        const by = viewer.t === "member" ? viewer.id : s.user;
        if (!by) throw new HttpError(400, "user is required: the door has no sign-on to name the member");
        await requireOwnRun(db, s.runId, surface, viewer);
        const inboxId = await sendToInbox(db, s.runId as RunId, { t: "stop", confirmed: s.confirmed, by });
        return send(req, res, 202, { inboxId });
      }
      if (req.method === "GET" && url.pathname === "/replies") {
        const runId = uuid.safeParse(url.searchParams.get(`runId`));
        if (!runId.success) throw new HttpError(400, "runId must be a uuid");
        await requireOwnRun(db, runId.data, surface, viewer);
        return send(req, res, 200, await readReplies(db, runId.data as RunId), NO_STORE);
      }
      const me = viewer.t === "member" ? { id: viewer.id, name: viewer.email, seesAll: seesAllRuns(viewer.role) } : null;
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/chat")) return sendHtml(req, res, chatPage(where, me), me ? NO_STORE : {});
      if (req.method === "GET" && url.pathname === "/runs") {
        const show = url.searchParams.get("show");
        const filter: RunFilter = show === "refusals" || show === "failed" ? show : "all";
        const mine = me && !me.seesAll ? me.id : null;
        const scope: RunScope | null = mine ? { surface: WEB_SURFACE, member: mine } : viewer.t === "surface" ? { surface: viewer.id, member: null } : null;
        return sendHtml(req, res, runsPage(await listRuns(db, RUNS_LISTED, scope), filter, RUNS_LISTED, where, mine), NO_STORE);
      }
      const runPath = /^\/runs\/([^/]+)(?:\/(events|view|source|source\.json))?$/.exec(url.pathname);
      if (req.method === "GET" && runPath) {
        const runId = uuid.safeParse(runPath[1]);
        if (!runId.success) throw new HttpError(404, "not found");
        await requireVisible(db, runId.data, viewer);
        const events = await loadEvents(db, runId.data as RunId);
        if (!runPath[2]) return sendHtml(req, res, recordPage(recordView(runId.data, events), where), NO_STORE);
        if (runPath[2] === "source" || runPath[2] === "source.json") {
          const path = url.searchParams.get("path");
          if (!kb || !path) throw new HttpError(404, "not found");
          const cited = await citedEntry(events, path, kb);
          // Sign-on off, the door cannot tell who is asking, so it shows what any member may see.
          const role: Role = viewer.t === "member" ? viewer.role : "member";
          if (runPath[2] === "source.json") return send(req, res, 200, sourceChip(cited, role), NO_STORE);
          return sendHtml(req, res, sourcePage(runId.data, cited, role, where), NO_STORE, sourceStatus(cited, role));
        }
        return send(req, res, 200, runPath[2] === "events" ? events : recordView(runId.data, events), NO_STORE);
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
