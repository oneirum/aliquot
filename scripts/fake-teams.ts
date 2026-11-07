/**
 * A stand-in for Microsoft Teams and the Bot Framework, for the tests, pnpm
 * lab0 and pnpm demo --teams. It serves what the Teams door reaches: an
 * OpenID configuration and its signing keys, a tenant login endpoint, and the
 * connector a reply posts to and an edit PUTs to. It signs every activity it
 * delivers with its own RSA key, as the Bot Framework does, so the door's
 * token check runs for real. Every call to it is recorded with its bearer.
 *
 * Point a door at it with ALIQUOT_TEAMS_OPENID=fake.openid and
 * ALIQUOT_TEAMS_LOGIN=fake.login; activities name fake.serviceUrl.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, request, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

export const TENANT = "0a1b2c3d-0000-4000-8000-00000000a1b0";
export const APP_ID = "5e1f0000-0000-4000-8000-0000000a1100";
export const APP_SECRET = "fake-teams-client-secret";
export const BOT_ID = `28:${APP_ID}`;

export interface ConnectorCall {
  readonly method: "POST" | "PUT" | "TOKEN";
  readonly conversationId: string;
  /** The activity replied to (POST) or replaced (PUT). */
  readonly activityId: string;
  readonly auth: string | undefined;
  readonly body: Record<string, any>;
  /** The id the connector answered with: the new reply's (POST) or the replaced one's (PUT). */
  id?: string;
}

export interface ActivityOptions {
  /** channel (the default), groupChat or personal. */
  readonly kind?: "channel" | "groupChat" | "personal";
  /** The channel post this one replies in, for a reply in a channel thread. */
  readonly inThread?: string;
  readonly user?: string;
  readonly tenant?: string;
  readonly fromBot?: boolean;
  readonly type?: string;
  readonly id?: string;
}

export interface FakeTeams {
  readonly openid: string;
  readonly login: string;
  readonly serviceUrl: string;
  readonly calls: ConnectorCall[];
  /** A message activity as Teams sends it: in a channel a mention of the app, with <at> markup. */
  activity(text: string, opts?: ActivityOptions): Record<string, any>;
  /**
   * POSTs an activity to the door's messaging endpoint and returns the HTTP status. sign: "good" by the published key
   * (the default), "forged" by a key the door was never shown, "none" without a token, or claims to override.
   */
  deliver(endpoint: string, activity: Record<string, any>, sign?: "good" | "forged" | "none" | Record<string, unknown>): Promise<number>;
  /** The text the "looking" reply to activityId was last edited to. */
  answerTo(activityId: string, ms?: number): Promise<string>;
  waitFor<T>(what: string, probe: () => T | undefined | null | false, ms?: number): Promise<T>;
  close(): Promise<void>;
}

const CHANNEL = "19:lab0general@thread.tacv2";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeTeams(): Promise<FakeTeams> {
  const published = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const forged = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "fake-teams-key-1";
  const calls: ConnectorCall[] = [];
  let next = 1;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, o: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    const text = await readBody(req);
    if (req.method === "GET" && url.pathname === "/openid") return json(200, { issuer: "https://api.botframework.com", jwks_uri: `${base}/keys` });
    if (req.method === "GET" && url.pathname === "/keys") return json(200, { keys: [{ ...published.publicKey.export({ format: "jwk" }), kid, use: "sig", endorsements: ["msteams"] }] });
    const login = /^\/login\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(url.pathname);
    if (req.method === "POST" && login) {
      const form = Object.fromEntries(new URLSearchParams(text));
      calls.push({ method: "TOKEN", conversationId: "", activityId: "", auth: undefined, body: { tenant: decodeURIComponent(login[1]!), client_id: form.client_id, scope: form.scope, grant_type: form.grant_type } });
      if (decodeURIComponent(login[1]!) !== TENANT || form.client_id !== APP_ID || form.client_secret !== APP_SECRET) return json(401, { error: "invalid_client" });
      return json(200, { token_type: "Bearer", expires_in: 3599, access_token: `fake-connector-token-${next++}` });
    }
    const conn = /^\/connector\/v3\/conversations\/([^/]+)\/activities\/([^/]+)$/.exec(url.pathname);
    if (conn && (req.method === "POST" || req.method === "PUT")) {
      const body = JSON.parse(text || "{}") as Record<string, any>;
      const call: ConnectorCall = { method: req.method, conversationId: decodeURIComponent(conn[1]!), activityId: decodeURIComponent(conn[2]!), auth: req.headers.authorization, body };
      if (!req.headers.authorization?.startsWith("Bearer fake-connector-token-")) {
        calls.push(call);
        return json(401, { error: { code: "Unauthorized" } });
      }
      call.id = req.method === "POST" ? `1730${String(next++).padStart(9, "0")}` : call.activityId;
      calls.push(call);
      return json(req.method === "POST" ? 201 : 200, { id: call.id });
    }
    json(404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const serviceUrl = `${base}/connector/`;

  const jwt = (claims: Record<string, unknown>, key = published.privateKey) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${enc({ alg: "RS256", typ: "JWT", kid })}.${enc(claims)}`;
    return `${head}.${sign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
  };

  const waitFor = async <T>(what: string, probe: () => T | undefined | null | false, ms = 20_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = probe();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`fake Teams: timed out waiting for ${what}`);
      await sleep(25);
    }
  };

  return {
    openid: `${base}/openid`,
    login: `${base}/login/`,
    serviceUrl,
    calls,
    activity(text, opts = {}) {
      const kind = opts.kind ?? "channel";
      const id = opts.id ?? `1731${String(next++).padStart(9, "0")}`;
      const conversationId = kind === "channel" ? `${CHANNEL};messageid=${opts.inThread ?? id}` : kind === "groupChat" ? "19:lab0groupchat@thread.v2" : `a:1personal-${opts.user ?? "member"}`;
      const user = opts.user ?? "aad-member-0001";
      return {
        type: opts.type ?? "message",
        id,
        timestamp: new Date().toISOString(),
        serviceUrl,
        channelId: "msteams",
        from: opts.fromBot ? { id: "28:other-bot", name: "Other bot", role: "bot" } : { id: `29:${user}`, name: "Lab member", aadObjectId: user },
        conversation: { id: conversationId, conversationType: kind, tenantId: opts.tenant ?? TENANT, ...(kind === "personal" ? {} : { isGroup: true }) },
        recipient: { id: BOT_ID, name: "Aliquot" },
        text: kind === "personal" ? text : `<at>Aliquot</at> ${text}`,
        textFormat: "plain",
        entities: kind === "personal" ? [] : [{ type: "mention", text: "<at>Aliquot</at>", mentioned: { id: BOT_ID, name: "Aliquot" } }],
        channelData: { tenant: { id: opts.tenant ?? TENANT }, ...(kind === "channel" ? { channel: { id: CHANNEL }, team: { id: "19:lab0team@thread.tacv2" } } : {}) },
        locale: "en-US",
      };
    },
    deliver(endpoint, activity, how = "good") {
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: "https://api.botframework.com", aud: APP_ID, exp: now + 3600, nbf: now - 60, serviceurl: activity.serviceUrl, ...(typeof how === "object" ? how : {}) };
      const token = how === "none" ? null : jwt(claims, how === "forged" ? forged.privateKey : published.privateKey);
      const payload = Buffer.from(JSON.stringify(activity));
      const headers = { "content-type": "application/json", "content-length": payload.length, ...(token ? { authorization: `Bearer ${token}` } : {}) };
      return new Promise((resolve, reject) => {
        const req = request(endpoint, { method: "POST", headers }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end(payload);
      });
    },
    async answerTo(activityId, ms = 30_000) {
      const looking = await waitFor(`the reply to ${activityId}`, () => calls.find((c) => c.method === "POST" && c.activityId === activityId && c.id), ms);
      return waitFor(`the answer to ${activityId}`, () => calls.findLast((c) => c.method === "PUT" && c.activityId === looking.id)?.body.text as string | undefined, ms);
    },
    waitFor,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
