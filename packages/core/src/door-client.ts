/**
 * A client of the web door's HTTP routes (surfaces/web.ts), for callers that
 * are not a browser: `aliquot ask` and `aliquot acp`, and through them a
 * terminal, tmux, T3 Code or a lab's own orchestrator. It asks exactly what
 * the chat page asks, so the door's intake, gate and record apply unchanged;
 * nothing here decides egress.
 *
 * ask() yields one event per step, the same shape `aliquot ask --json` prints:
 *   started   {runId, recordUrl}                      the door enqueued a run
 *   tool      {runId, tool}                           the run asked for a tool
 *   finished  {runId, outcome, answer, cls, withheld, refusal, recordUrl}
 *   refused   {runId: null, message}                  the gate refused before any run
 *
 * A Door's token names the surface the caller speaks as; without one the
 * door takes the caller for the web surface. The door withholds an answer
 * above its surface's placement and posts the record link only, and finished
 * then says withheld. ceiling is the caller's own, stricter promise: an
 * answer whose class ranks above it is withheld here too, for a caller that
 * keeps a copy, such as T3 Code's thread store.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { DATA_CLASSES, rank, type DataClass } from "./dataclass.ts";

export type DoorEvent =
  | { readonly t: "started"; readonly runId: string; readonly recordUrl: string }
  | { readonly t: "tool"; readonly runId: string; readonly tool: string }
  | {
      readonly t: "finished";
      readonly runId: string;
      readonly outcome: string;
      readonly answer: string | null;
      readonly cls: DataClass | null;
      readonly withheld: boolean;
      readonly refusal: string | null;
      readonly recordUrl: string;
    }
  | { readonly t: "refused"; readonly runId: null; readonly message: string };

export interface AskInput {
  readonly thread: string;
  readonly message: string;
  readonly text: string;
  readonly user: string;
  readonly channel?: string;
}

export interface AskOptions {
  readonly ceiling?: DataClass;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
}

/** Where the caller reads its surface token, so the token stays out of argv and ps. */
export const SURFACE_TOKEN_ENV = "ALIQUOT_SURFACE_TOKEN";

export interface Door {
  readonly url: string;
  /** The surface's bearer token, or null to speak as the web surface. */
  readonly token: string | null;
}

export class DoorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoorError";
  }
}

export function isDataClass(s: string): s is DataClass {
  return (DATA_CLASSES as readonly string[]).includes(s);
}

const base = (door: Door) => (door.url.endsWith("/") ? door.url : `${door.url}/`);

/** The door's JSON over http or https, by the URL's scheme. Any other scheme is refused before a socket opens. */
function call(door: Door, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const url = new URL(path, base(door));
  const send = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
  if (!send) return Promise.reject(new DoorError(`the door URL must be http or https, not ${url.protocol}`));
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers = { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...(door.token ? { authorization: `Bearer ${door.token}` } : {}) };
  return new Promise((resolve, reject) => {
    const req = send(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = undefined;
        }
        if (res.statusCode === 401) {
          const why = (json as { error?: unknown } | null | undefined)?.error;
          return reject(new DoorError(`the door refused ${SURFACE_TOKEN_ENV} (401${typeof why === "string" ? `: ${why}` : ""}). It must hold the token of a surface the door serves, and the door must start with that surface's token variable set.`));
        }
        if (json === undefined) return reject(new DoorError(`${method} ${url.pathname} answered ${res.statusCode} with a body that is not JSON`));
        resolve({ status: res.statusCode ?? 0, json });
      });
      res.on("error", reject);
    });
    req.on("error", (err: NodeJS.ErrnoException) => reject(new DoorError(err.code === "ECONNREFUSED" ? `cannot reach the door at ${url.origin}. Is the web door running?` : `${url.origin}: ${err.message}`)));
    req.end(payload);
  });
}

interface StoredEventJson {
  readonly seq: number;
  readonly event: { readonly t: string; readonly tool?: string; readonly outcome?: string; readonly mode?: string; readonly answer?: { readonly cls: string } | null; readonly refusal?: { readonly code: string } };
}

export async function* ask(door: Door, input: AskInput, opts: AskOptions = {}): AsyncGenerator<DoorEvent> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 300;
  const sent = await call(door, "POST", "message", input);
  const body = sent.json as { t?: string; runId?: string; userFacing?: string; error?: string } | null;
  if (body?.t === "refused") {
    yield { t: "refused", runId: null, message: body.userFacing ?? "The door refused the message." };
    return;
  }
  if (sent.status !== 202 || body?.t !== "enqueued" || !body.runId) throw new DoorError(`the door did not take the message (${sent.status}): ${body?.error ?? JSON.stringify(body)}`);
  const runId = body.runId;
  const recordUrl = new URL(`runs/${runId}`, base(door)).href;
  yield { t: "started", runId, recordUrl };

  const seen = new Set<number>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return;
    const events = (await call(door, "GET", `runs/${runId}/events`)).json as StoredEventJson[];
    for (const e of events) {
      if (e.event.t === "tool.requested" && e.event.tool && !seen.has(e.seq)) {
        seen.add(e.seq);
        yield { t: "tool", runId, tool: e.event.tool };
      }
    }
    const finished = events.find((e) => e.event.t === "run.finished")?.event;
    if (finished) {
      const refused = events.find((e) => e.event.t === "egress.refused")?.event;
      const raw = finished.answer?.cls ?? null;
      const cls = raw !== null && isDataClass(raw) ? raw : null;
      const replies = (await call(door, "GET", `replies?runId=${runId}`)).json as { kind: string; text: string }[];
      const reply = replies.find((r) => r.kind === "reply")?.text ?? null;
      const linkOnly = events.some((e) => e.event.t === "reply.posted" && e.event.mode === "link-only");
      const withheld = linkOnly || (reply !== null && opts.ceiling !== undefined && (cls === null || rank(cls) > rank(opts.ceiling)));
      yield {
        t: "finished",
        runId,
        outcome: finished.outcome ?? "unknown",
        answer: refused || withheld ? null : reply,
        cls,
        withheld,
        refusal: refused ? `The egress check refused it (${refused.refusal?.code ?? "refused"}). Nothing was sent.` : null,
        recordUrl,
      };
      return;
    }
    await sleep(pollMs);
  }
  throw new DoorError(`run ${runId} did not finish within ${Math.round(timeoutMs / 1000)} s. Is the worker running? Its record: ${recordUrl}`);
}

/** The second click of the chat page's stop: the run stops at its next step. */
export async function stop(door: Door, runId: string, user: string): Promise<void> {
  const r = await call(door, "POST", "stop", { runId, user, confirmed: true });
  if (r.status !== 202) throw new DoorError(`the door did not stop run ${runId} (${r.status})`);
}
