/**
 * A small OpenID Connect provider for the tests and the sign-on walk: the stand-in a stranger runs instead of the
 * university's. It serves discovery, its keys (RS256), an authorize page that lists the test people to sign in as, and
 * a token endpoint that checks the client secret, the redirect URI and the PKCE verifier, and hands back a signed ID
 * token once per code. Never deploy it: anyone who reaches it signs in as anyone it lists.
 *
 *   const idp = await startFakeOidc({ clientId: "aliquot", clientSecret: "s3cret", people: [{ email: "a@lab.edu" }] });
 *   ... [auth] issuer = idp.issuer ...
 *   await idp.stop();
 */

import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface FakePerson {
  readonly email: string;
  readonly name?: string;
  /** false makes the ID token say the provider has not verified the email. */
  readonly emailVerified?: boolean;
}

export interface FakeOidcOptions {
  readonly clientId: string;
  /** Null: a public client, which sends no secret. */
  readonly clientSecret: string | null;
  readonly people: readonly FakePerson[];
}

export interface FakeOidc {
  readonly issuer: string;
  /** Codes exchanged at the token endpoint, and why any was refused. */
  readonly log: string[];
  /** Changes the claims of the next ID token only, for a test of a bad token. */
  tamperNext(change: (claims: Record<string, unknown>) => Record<string, unknown>): void;
  /** Signs a JWT with the provider's key, or with a key it does not publish. */
  sign(claims: Record<string, unknown>, opts?: { readonly foreignKey?: boolean; readonly kid?: string; readonly alg?: string }): string;
  stop(): Promise<void>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Grant {
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string;
  readonly person: FakePerson;
}

export async function startFakeOidc(opts: FakeOidcOptions): Promise<FakeOidc> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const kid = b64url(randomBytes(8));
  const grants = new Map<string, Grant>();
  const log: string[] = [];
  let tamper: ((c: Record<string, unknown>) => Record<string, unknown>) | null = null;
  let issuer = "";

  const sign = (claims: Record<string, unknown>, o: { foreignKey?: boolean; kid?: string; alg?: string } = {}) => {
    const head = b64url(JSON.stringify({ alg: o.alg ?? "RS256", typ: "JWT", kid: o.kid ?? kid }));
    const body = b64url(JSON.stringify(claims));
    const key: KeyObject = o.foreignKey ? foreign : privateKey;
    return `${head}.${body}.${b64url(createSign("sha256").update(`${head}.${body}`).sign(key))}`;
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const form = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", issuer);
      if (url.pathname === "/.well-known/openid-configuration")
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [opts.clientSecret === null ? "none" : "client_secret_basic"],
        });
      if (url.pathname === "/jwks") return json(res, 200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] });
      if (url.pathname === "/authorize" || url.pathname === "/authorize/pick") {
        const q = url.searchParams;
        const problem =
          q.get("client_id") !== opts.clientId ? "unknown client_id"
          : q.get("response_type") !== "code" ? "response_type must be code"
          : q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") ? "PKCE with S256 is required"
          : !q.get("redirect_uri") || !q.get("state") || !q.get("nonce") ? "redirect_uri, state and nonce are required"
          : null;
        if (problem) return json(res, 400, { error: "invalid_request", error_description: problem });
        const person = opts.people.find((p) => p.email === q.get("login_hint"));
        if (url.pathname === "/authorize" && !person) {
          const pick = (p: FakePerson) => {
            const to = new URL(url);
            to.pathname = "/authorize/pick";
            to.searchParams.set("login_hint", p.email);
            return `<li><a class="person" href="${escapeHtml(to.pathname + to.search)}"><b>${escapeHtml(p.name ?? p.email)}</b><span>${escapeHtml(p.email)}</span></a></li>`;
          };
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test sign-on provider</title>
<style>:root{color-scheme:light dark}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f4f3f0;color:#1c1b19;display:grid;place-items:center;min-height:100dvh;padding:24px 16px;box-sizing:border-box}
@media (prefers-color-scheme:dark){body{background:#10100f;color:#ecebe6}.person{background:#1c1c1a!important;border-color:#2f2e2b!important}}
main{width:100%;max-width:400px}h1{font-size:22px;margin:0 0 6px}p{margin:0 0 20px;opacity:.75;font-size:14.5px}ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.person{display:grid;padding:12px 14px;border:1px solid #e3e0d9;border-radius:10px;background:#fff;color:inherit;text-decoration:none}.person span{font-size:13.5px;opacity:.7}</style></head>
<body><main><h1>Test sign-on provider</h1><p>A stand-in for the university's sign-on, for tests and the walk only. Choose who to sign in as.</p><ul>${opts.people.map(pick).join("")}</ul></main></body></html>`);
        }
        if (!person) return json(res, 400, { error: "access_denied", error_description: "no such test person" });
        const code = b64url(randomBytes(24));
        grants.set(code, { redirectUri: q.get("redirect_uri")!, challenge: q.get("code_challenge")!, nonce: q.get("nonce")!, person });
        const back = new URL(q.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state")!);
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const f = await form(req);
        const refuse = (error: string, why: string) => {
          log.push(`refused: ${why}`);
          return json(res, 400, { error, error_description: why });
        };
        if (opts.clientSecret !== null) {
          const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1];
          const [id, secret] = basic ? Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent) : [];
          if (id !== opts.clientId || secret !== opts.clientSecret) return refuse("invalid_client", "client authentication failed");
        }
        const code = f.get("code") ?? "";
        const grant = grants.get(code);
        grants.delete(code);
        if (f.get("grant_type") !== "authorization_code" || !grant) return refuse("invalid_grant", "unknown or used code");
        if (f.get("redirect_uri") !== grant.redirectUri) return refuse("invalid_grant", "redirect_uri does not match");
        if (b64url(createHash("sha256").update(f.get("code_verifier") ?? "").digest()) !== grant.challenge) return refuse("invalid_grant", "PKCE verifier does not match");
        const now = Math.floor(Date.now() / 1000);
        let claims: Record<string, unknown> = {
          iss: issuer,
          sub: `sub-${createHash("sha256").update(grant.person.email).digest("hex").slice(0, 12)}`,
          aud: opts.clientId,
          iat: now,
          exp: now + 300,
          nonce: grant.nonce,
          email: grant.person.email,
          email_verified: grant.person.emailVerified ?? true,
          name: grant.person.name ?? grant.person.email,
        };
        if (tamper) {
          claims = tamper(claims);
          tamper = null;
        }
        log.push(`token for ${grant.person.email}`);
        return json(res, 200, { access_token: b64url(randomBytes(16)), token_type: "Bearer", expires_in: 300, id_token: sign(claims) });
      }
      json(res, 404, { error: "not found" });
    })().catch((err: unknown) => json(res, 500, { error: String(err) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    issuer,
    log,
    tamperNext: (change) => void (tamper = change),
    sign,
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** A browser's cookie jar and redirects, over fetch: enough to walk the door, the provider and back. */
export class Browser {
  readonly cookies = new Map<string, string>();

  private take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim();
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.cookies.delete(name);
      else this.cookies.set(name, pair!.slice(at + 1).trim());
    }
  }

  async fetch(url: string, init: { readonly method?: string; readonly body?: string; readonly headers?: Record<string, string> } = {}): Promise<Response> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url, { method: init.method ?? "GET", redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) }, ...(init.body === undefined ? {} : { body: init.body }) });
    this.take(res);
    return res;
  }

  /** Follows redirects as a browser does, and returns the last response with the URLs it passed through. */
  async open(url: string): Promise<{ readonly res: Response; readonly hops: readonly string[] }> {
    const hops = [url];
    let res = await this.fetch(url);
    while (res.status >= 300 && res.status < 400 && hops.length < 10) {
      const next = new URL(res.headers.get("location")!, hops.at(-1)).href;
      hops.push(next);
      res = await this.fetch(next);
    }
    return { res, hops };
  }

  /** The door's /login, the provider's picker answered for this person, the door's /callback, then the page asked for. */
  async signIn(door: string, email: string, next = "/"): Promise<{ readonly res: Response; readonly hops: readonly string[] }> {
    const login = await this.fetch(`${door}/login?next=${encodeURIComponent(next)}`);
    const authorize = new URL(login.headers.get("location") ?? `${door}/no-redirect`);
    authorize.searchParams.set("login_hint", email);
    authorize.pathname = "/authorize/pick";
    const opened = await this.open(authorize.href);
    return { res: opened.res, hops: [`${door}/login`, ...opened.hops] };
  }
}

/**
 * The studio's accounts, as the door reads them (signon.ts studioRole): email and role in studio.users. A test or walk
 * without a running studio seeds them here; a lab's PI adds them in the studio.
 */
export async function seedStudioAccounts(db: { query(sql: string, params?: unknown[]): Promise<unknown> }, accounts: readonly { readonly email: string; readonly role: string }[]): Promise<void> {
  await db.query("create schema if not exists studio");
  await db.query("create table if not exists studio.users (id serial primary key, email varchar not null, role text not null)");
  for (const a of accounts) await db.query("insert into studio.users (email, role) values ($1, $2)", [a.email, a.role]);
}
