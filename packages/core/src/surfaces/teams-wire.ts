/**
 * The Teams door's only reach to the network. Teams has no Socket Mode: the
 * Bot Framework posts each activity to the bot's messaging endpoint, so the
 * door listens on /api/messages behind the lab's TLS proxy and answers
 * through the Bot Framework connector at the activity's serviceUrl.
 *
 * Every activity in must carry a token the Bot Framework signed: RS256 by a
 * key from its published OpenID configuration, for this app id, unexpired,
 * naming the same serviceUrl as the activity, by a key endorsed for the
 * activity's channel. Without that check anyone who finds the endpoint could
 * ask as any member, and could name a serviceUrl that collects the door's
 * connector token.
 *
 * Nothing here decides what Teams may hold. The door does, by the teams
 * surface's placement; teams.ts only relays what the door returns.
 */

import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";

export const BOT_OPENID = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const LOGIN = "https://login.microsoftonline.com/";
export const BOT_ISSUER = "https://api.botframework.com";
const CONNECTOR_SCOPE = "https://api.botframework.com/.default";
/** The Bot Framework's own allowance for clock skew. */
const SKEW_S = 300;
const BODY_LIMIT = 256 * 1024;
/** The hosts the Teams connector answers from: commercial, GCC and GCC High clouds. */
const SERVICE_HOSTS = [".trafficmanager.net", ".botframework.com", ".teams.microsoft.com", ".teams.microsoft.us"];

export class TeamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamsError";
  }
}

const isLoopback = (url: URL) => url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";

/** https, or http to a loopback host only, so a test can stand in for Microsoft and a secret never crosses a network in clear. */
export function checkBase(base: string, what: string): URL {
  const url = new URL(base);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) throw new TeamsError(`${what} must be https (or http on loopback for a test), not ${url.href}`);
  return url;
}

/** A serviceUrl the door may send its connector token to: a Teams connector host over https, or loopback for a test. */
export function checkServiceUrl(serviceUrl: string): URL {
  let url: URL;
  try {
    url = new URL(serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`);
  } catch {
    throw new TeamsError(`serviceUrl ${JSON.stringify(serviceUrl)} is not a URL`);
  }
  if (isLoopback(url) && (url.protocol === "http:" || url.protocol === "https:")) return url;
  if (url.protocol !== "https:" || !SERVICE_HOSTS.some((h) => url.hostname.endsWith(h))) throw new TeamsError(`serviceUrl ${url.origin} is not a Teams connector host`);
  return url;
}

interface Reply {
  readonly status: number;
  readonly text: string;
}

function send(url: URL, method: string, headers: Record<string, string | number>, body?: Buffer): Promise<Reply> {
  const go = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = go(url, { method, headers: body ? { ...headers, "content-length": body.length } : headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(30_000, () => req.destroy(new Error("timed out")));
    req.on("error", (err) => reject(new TeamsError(`${method} ${url.origin}${url.pathname}: ${err.message}`)));
    req.end(body);
  });
}

async function json(url: URL, method: string, headers: Record<string, string | number>, body?: Buffer): Promise<Record<string, unknown>> {
  const res = await send(url, method, headers, body);
  if (res.status < 200 || res.status >= 300) throw new TeamsError(`${method} ${url.origin}${url.pathname} answered ${res.status}`);
  if (!res.text) return {};
  try {
    return JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    throw new TeamsError(`${method} ${url.origin}${url.pathname} answered with a body that is not JSON`);
  }
}

const b64url = (s: string) => Buffer.from(s, "base64url");

interface SigningKey {
  readonly key: KeyObject;
  readonly endorsements: readonly string[] | null;
}

/** Checks one inbound request's Authorization header against the activity it carries. Throws TeamsError when it is not the Bot Framework's. */
export type Verifier = (authorization: string | undefined, activity: { readonly serviceUrl?: unknown; readonly channelId?: unknown }) => Promise<void>;

/**
 * The Bot Framework's signing keys, read from its OpenID configuration and kept a day. A token signed by a key
 * not in the set reloads it, at most once in five minutes, because Microsoft rotates keys without notice.
 */
export function botVerifier(openid: URL, appId: string, now: () => number = Date.now): Verifier {
  let keys = new Map<string, SigningKey>();
  let loadedAt = 0;
  let loading: Promise<void> | null = null;

  async function load(): Promise<void> {
    const config = await json(openid, "GET", { accept: "application/json" });
    if (typeof config.jwks_uri !== "string") throw new TeamsError("the Bot Framework OpenID configuration names no jwks_uri");
    const jwks = await json(checkBase(config.jwks_uri, "jwks_uri"), "GET", { accept: "application/json" });
    const next = new Map<string, SigningKey>();
    for (const jwk of Array.isArray(jwks.keys) ? (jwks.keys as Record<string, unknown>[]) : []) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      try {
        const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e } as JsonWebKey, format: "jwk" });
        next.set(jwk.kid, { key, endorsements: Array.isArray(jwk.endorsements) ? (jwk.endorsements as string[]) : null });
      } catch {
        // A key Node cannot read signs nothing this door accepts.
      }
    }
    keys = next;
    loadedAt = now();
  }

  async function keyFor(kid: string): Promise<SigningKey | undefined> {
    const stale = now() - loadedAt > 24 * 3600_000;
    const unknownMayReload = !keys.has(kid) && now() - loadedAt > 5 * 60_000;
    if (stale || unknownMayReload) {
      loading ??= load().finally(() => (loading = null));
      await loading;
    }
    return keys.get(kid);
  }

  return async (authorization, activity) => {
    const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
    if (!m) throw new TeamsError("no Bot Framework token");
    const [, h, p, s] = m as unknown as [string, string, string, string];
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(b64url(h).toString("utf8")) as Record<string, unknown>;
      claims = JSON.parse(b64url(p).toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new TeamsError("the token is not a JWT");
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new TeamsError("the token is not signed RS256 with a key id");
    const signer = await keyFor(header.kid);
    if (!signer) throw new TeamsError(`the token's key ${header.kid} is not one the Bot Framework publishes`);
    if (!verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), signer.key, b64url(s))) throw new TeamsError("the token's signature does not verify");
    if (claims.iss !== BOT_ISSUER) throw new TeamsError("the token was not issued by the Bot Framework");
    if (claims.aud !== appId) throw new TeamsError("the token is for another app");
    const t = now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp + SKEW_S < t) throw new TeamsError("the token has expired");
    if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > t) throw new TeamsError("the token is not valid yet");
    if (typeof activity.serviceUrl !== "string" || claims.serviceurl !== activity.serviceUrl) throw new TeamsError("the token names another serviceUrl than the activity");
    if (signer.endorsements && !signer.endorsements.includes(String(activity.channelId))) throw new TeamsError(`the token's key is not endorsed for channel ${String(activity.channelId)}`);
    checkServiceUrl(activity.serviceUrl);
  };
}

export interface Connector {
  /** Posts an activity as a reply to replyToId; in a channel thread it lands in that thread. Returns the new activity's id. */
  reply(serviceUrl: string, conversationId: string, replyToId: string, activity: Record<string, unknown>): Promise<string>;
  /** Replaces an activity the bot posted, which is how the "looking" reply becomes the answer. */
  update(serviceUrl: string, conversationId: string, activityId: string, activity: Record<string, unknown>): Promise<void>;
}

/**
 * The Bot Framework connector, with an app token from the tenant's login endpoint (client credentials, single
 * tenant), cached until five minutes before it expires.
 */
export function botConnector(login: URL, tenant: string, appId: string, secret: string, now: () => number = Date.now): Connector {
  let token: { value: string; until: number } | null = null;
  let pending: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: appId, client_secret: secret, scope: CONNECTOR_SCOPE });
    const url = new URL(`${encodeURIComponent(tenant)}/oauth2/v2.0/token`, login);
    const res = await send(url, "POST", { "content-type": "application/x-www-form-urlencoded" }, Buffer.from(form.toString()));
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(res.text) as Record<string, unknown>;
    } catch {
      // Reported below with the status.
    }
    if (res.status !== 200 || typeof body.access_token !== "string") throw new TeamsError(`the tenant's login endpoint refused the app's credentials (${res.status}${typeof body.error === "string" ? ` ${body.error}` : ""})`);
    const life = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in ?? 3600);
    token = { value: body.access_token, until: now() + Math.max(60, life - 300) * 1000 };
    return token.value;
  }

  async function bearer(): Promise<string> {
    if (token && token.until > now()) return token.value;
    pending ??= fetchToken().finally(() => (pending = null));
    return pending;
  }

  async function call(method: "POST" | "PUT", serviceUrl: string, path: string, activity: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = new URL(path, checkServiceUrl(serviceUrl));
    const headers = { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${await bearer()}` };
    return json(url, method, headers, Buffer.from(JSON.stringify(activity)));
  }

  return {
    async reply(serviceUrl, conversationId, replyToId, activity) {
      const res = await call("POST", serviceUrl, `v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyToId)}`, activity);
      if (typeof res.id !== "string") throw new TeamsError("the connector returned no activity id for the reply");
      return res.id;
    },
    async update(serviceUrl, conversationId, activityId, activity) {
      await call("PUT", serviceUrl, `v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`, { ...activity, id: activityId });
    },
  };
}

/**
 * The messaging endpoint: POST /api/messages, each verified before anything reads it, answered 200 at once so the
 * Bot Framework does not resend, then handed to onActivity. GET /healthz is for a container's health check.
 */
export function serveMessages(opts: { readonly verify: Verifier; readonly onActivity: (activity: Record<string, unknown>) => void; readonly log: (line: string) => void }): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    if (path !== "/api/messages") return void res.writeHead(404).end();
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        res.writeHead(413).end();
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      let activity: Record<string, unknown>;
      try {
        activity = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (typeof activity !== "object" || activity === null || Array.isArray(activity)) throw new Error("not an object");
      } catch {
        return void res.writeHead(400).end();
      }
      opts.verify(req.headers.authorization, activity).then(
        () => {
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
          opts.onActivity(activity);
        },
        (err: unknown) => {
          opts.log(`[teams] refused a request to /api/messages: ${err instanceof Error ? err.message : String(err)}`);
          res.writeHead(401).end();
        },
      );
    });
  });
}
