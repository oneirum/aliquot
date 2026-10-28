/**
 * The lab-hosted web surface: a Surface over the web_messages table, plus the
 * HTTP handler the app serves. Both sides share Postgres, so the worker posts
 * replies here and the page reads them, with no second channel.
 *
 * Routes:
 *   POST /message  {channel?, thread, message, text, user}  -> intake
 *   POST /stop     {runId, user, confirmed?}                -> run_inbox stop (+ NOTIFY); confirmed is the second click
 *   GET  /replies?runId=                                     -> the run's reply and notices
 *   GET  /runs/:id/events                                    -> the run record (events, no bodies)
 *
 * Bodies are capped at MAX_BODY_BYTES, ids are validated before any query,
 * and an unexpected error is logged here and answered as "internal error".
 * Not yet done, recorded in DESIGN.md: authentication, and per-run
 * authorization on /stop, /replies and /runs/:id/events. The identity unit
 * owns both.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import type { SurfaceId } from "../dataclass.ts";
import type { Db } from "../db.ts";
import type { AgentDocument } from "../agent.ts";
import { intake, intakeTest, type IntakeDeps, type IntakeResult, type Surface } from "../frontdoor.ts";
import { loadEvents, sendToInbox, type RunId } from "../record.ts";
import type { LabConfig } from "../config.ts";

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

/** A message is at most the router's 8,000 characters plus ids; anything near this is not a chat message. */
export const MAX_BODY_BYTES = 64 * 1024;

const messageSchema = z.object({ channel: z.string().default("lab"), thread: z.string().min(1), message: z.string().min(1), text: z.string().min(1), user: z.string().min(1) });
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

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createWebHandler(db: Db, deps: IntakeDeps, log: (line: string) => void = (line) => console.error(line)): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST" && url.pathname === "/message") {
        const m = messageSchema.parse(await readJson(req));
        const result = await intake(
          { channel: { surface: WEB_SURFACE, channelId: m.channel }, threadId: m.thread, messageId: m.message, platformUserId: m.user, text: m.text, attachments: [], addressed: true, at: new Date().toISOString() },
          deps,
        );
        return send(res, result.t === "refused" ? 403 : 202, result);
      }
      if (req.method === "POST" && url.pathname === "/stop") {
        const s = stopSchema.parse(await readJson(req));
        const run = await db.query("select 1 from jobs where id = $1 and kind = 'run'", [s.runId]);
        if (!run.rowCount) throw new HttpError(404, "no such run");
        const inboxId = await sendToInbox(db, s.runId as RunId, { t: "stop", confirmed: s.confirmed, by: s.user });
        return send(res, 202, { inboxId });
      }
      if (req.method === "GET" && url.pathname === "/replies") {
        const runId = uuid.safeParse(url.searchParams.get(`runId`));
        if (!runId.success) throw new HttpError(400, "runId must be a uuid");
        return send(res, 200, await readReplies(db, runId.data as RunId));
      }
      const events = /^\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (req.method === "GET" && events) {
        const runId = uuid.safeParse(events[1]);
        if (!runId.success) throw new HttpError(404, "not found");
        return send(res, 200, await loadEvents(db, runId.data as RunId));
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof z.ZodError) return send(res, 400, { error: "invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      log(`[web] ${req.method} ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      send(res, 500, { error: "internal error" });
    }
  };
}

export async function listenWeb(handler: ReturnType<typeof createWebHandler>, port: number): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => void handler(req, res));
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : port };
}
