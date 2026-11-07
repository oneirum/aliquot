/**
 * University sign-on for the web door: OpenID Connect, authorization code with PKCE (RFC 7636 S256), which Entra ID,
 * Okta, Keycloak, CILogon and most campus providers speak. A SAML-only campus puts Keycloak or CILogon in front.
 *
 *   /login     a state, a nonce and a PKCE verifier go in a short-lived signed cookie; the member goes to the provider
 *   /callback  the code and verifier are exchanged at the token endpoint; the ID token is verified here with
 *              node:crypto against the provider's published keys (RS256, RS384, RS512, ES256, ES384); its email is
 *              matched to a studio account
 *   /logout    the session ends on the server, in every browser holding its cookie
 *
 * The member id is the provider's stable id for the person ([auth] id_claim: sub, or eppn on an InCommon campus), so
 * every run's record names who asked by an id that outlives a changed email. The role comes from a group or
 * entitlement claim when [auth] roles_claim maps one, fixed for at most [auth] claim_role_max_minutes, after which the
 * member signs in again and the provider names the groups afresh; otherwise it is read from the studio account with
 * the member's email on every request, so a role change takes effect at once, and a removed account ends every one of
 * the member's sessions. Someone with neither is refused: a university provider vouches for the whole campus, and the
 * lab is a few people.
 *
 * A session is a door_sessions row; the signed cookie carries only its random id, and the row keeps only the id's
 * sha256. It lasts 12 hours from sign-in, and ends sooner when nobody uses it for [auth] idle_timeout_minutes (HIPAA
 * automatic logoff, NIST SP 800-171 03.01.10 and 03.01.11). last_seen_at is written at most once a minute, so a session
 * may end up to a minute before its idle timeout, never after.
 *
 * The provider is reached only through signon-wire.ts.
 */

import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature, type JsonWebKey } from "node:crypto";
import type { MemberId } from "../agent.ts";
import type { SignOnConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { ROLES, type Role } from "../roles.ts";
import { SignOnWireError, type ProviderWire } from "./signon-wire.ts";

export const SESSION_COOKIE = "aliquot_session";
const LOGIN_COOKIE = "aliquot_login";
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;
/** Clocks on the door and the provider may disagree by this much. */
const SKEW_SECONDS = 60;
/** A shorter secret could be guessed, and with it any session forged, so the door refuses to start. */
export const MIN_SESSION_SECRET = 32;
/** A key id the door has not seen refetches the provider's keys, at most this often. */
const KEYS_REFRESH_MS = 60_000;

export interface Member {
  readonly id: MemberId;
  /** For people to read: the chat names the member by it. */
  readonly email: string;
  readonly role: Role;
}

/**
 * What a request's session cookie says: a member; a session that just ended on a timer (why, for the person: "ended
 * after 30 minutes unused"), with the cookie that clears it; or none.
 */
export type Session =
  | { readonly t: "member"; readonly member: Member }
  | { readonly t: "ended"; readonly why: string; readonly setCookie: string }
  | { readonly t: "none" };

type EndedReason = "signed_out" | "idle" | "time_limit" | "claim_role_limit" | "no_account";

interface SessionRow {
  readonly member_id: string;
  readonly email: string;
  readonly claim_role: string | null;
  /** Seconds since the epoch, on the door's clock. */
  readonly created: number;
  readonly seen: number;
  readonly ended: boolean;
}

/** last_seen_at is written at most this often. */
const SEEN_WRITE_SECONDS = 60;

/** A sign-in that did not finish. The message is written for the person signing in. */
export class SignOnRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignOnRefused";
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const random = () => b64url(randomBytes(32));
const idHash = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex");
const at = (seconds: number) => new Date(seconds * 1000);

export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

type Purpose = "session" | "login";

/** A value only this door can have written: purpose and expiry inside, HMAC-SHA256 outside. */
function signValue(secret: string, purpose: Purpose, value: unknown, expiresAt: number): string {
  const body = b64url(JSON.stringify({ p: purpose, exp: expiresAt, v: value }));
  return `${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;
}

function openValue(secret: string, purpose: Purpose, token: string | undefined, nowSeconds: number): { readonly v: unknown; readonly exp: number } | null {
  const [body, mac, extra] = (token ?? "").split(".");
  if (!body || !mac || extra !== undefined) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { p?: unknown; exp?: unknown; v?: unknown };
    return p.p === purpose && typeof p.exp === "number" && p.exp > nowSeconds ? { v: p.v, exp: p.exp } : null;
  } catch {
    return null;
  }
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Only a path on this door, so a crafted /login?next= cannot send a member elsewhere after they sign in. A browser
 * drops tabs and newlines from a URL and reads a backslash as a slash, so "/\t/evil" is "//evil": any control character
 * is refused, and what remains must resolve to this origin.
 */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || /[\x00-\x1f\x7f]/.test(next)) return "/";
  const here = "http://door.invalid";
  const url = URL.parse(next, here);
  return url && url.origin === here ? `${url.pathname}${url.search}` : "/";
}

interface Jwk extends JsonWebKey {
  readonly kid?: string;
  readonly use?: string;
}

const ALGS: Readonly<Record<string, { readonly hash: string; readonly type: "rsa" | "ec" }>> = {
  RS256: { hash: "sha256", type: "rsa" },
  RS384: { hash: "sha384", type: "rsa" },
  RS512: { hash: "sha512", type: "rsa" },
  ES256: { hash: "sha256", type: "ec" },
  ES384: { hash: "sha384", type: "ec" },
};

/** The token names a key the door has not fetched: the provider rotated its keys. */
class UnknownKey extends Error {}

function jsonPart(part: string, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new SignOnRefused(`The provider's ID token has a ${what} that is not JSON.`);
}

export interface IdTokenCheck {
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  readonly nowSeconds: number;
}

/** OpenID Connect Core 3.1.3.7: signature, issuer, audience, expiry and nonce. Returns the claims. */
export function verifyIdToken(token: string, keys: readonly Jwk[], check: IdTokenCheck): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new SignOnRefused("The provider's ID token is not a signed JWT.");
  const header = jsonPart(parts[0]!, "header");
  const alg = typeof header.alg === "string" ? ALGS[header.alg] : undefined;
  if (!alg) throw new SignOnRefused(`The provider signed its ID token with ${String(header.alg)}, which Aliquot does not accept. Use RS256 or ES256.`);
  const candidates = keys.filter((k) => (header.kid === undefined || k.kid === header.kid) && (k.use === undefined || k.use === "sig"));
  if (!candidates.length) throw new UnknownKey();
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2]!, "base64url");
  const verified = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      if (key.asymmetricKeyType !== alg.type) return false;
      return verifySignature(alg.hash, data, alg.type === "ec" ? { key, dsaEncoding: "ieee-p1363" } : key, signature);
    } catch {
      return false;
    }
  });
  if (!verified) throw new SignOnRefused("The ID token's signature does not verify against the provider's published keys.");
  const claims = jsonPart(parts[1]!, "body");
  if (claims.iss !== check.issuer) throw new SignOnRefused(`The ID token was issued by ${String(claims.iss)}, not ${check.issuer}.`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(check.clientId) || (aud.length > 1 && claims.azp !== check.clientId)) throw new SignOnRefused("The ID token was issued to another application.");
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < check.nowSeconds) throw new SignOnRefused("The ID token has expired. Sign in again.");
  if (typeof claims.iat === "number" && claims.iat - SKEW_SECONDS > check.nowSeconds) throw new SignOnRefused("The ID token was issued in the future. Check the door's clock.");
  if (claims.nonce !== check.nonce) throw new SignOnRefused("The ID token does not answer this sign-in. Sign in again.");
  return claims;
}

/** The highest role any of the claim's values maps to, or null. A claim may be one string or a list of them. */
export function claimRole(claims: Record<string, unknown>, claim: string, values: Readonly<Record<string, Role>>): Role | null {
  const raw = claims[claim];
  const list = Array.isArray(raw) ? raw : [raw];
  let best: Role | null = null;
  for (const v of list) {
    const role = typeof v === "string" && Object.hasOwn(values, v) ? values[v]! : null;
    if (role && (best === null || ROLES.indexOf(role) > ROLES.indexOf(best))) best = role;
  }
  return best;
}

/**
 * The studio account's role for an email, or null when there is none. The studio's accounts live in its own schema of
 * the same database (Payload, packages/studio/collections/users.ts); before the studio has run there is no table, and
 * nobody has an account yet.
 */
export async function studioRole(db: Db, email: string): Promise<Role | null> {
  try {
    const rows = await db.query<{ role: string }>("select role::text as role from studio.users where lower(email) = lower($1) order by id limit 1", [email]);
    const role = rows.rows[0]?.role;
    return (ROLES as readonly string[]).includes(role ?? "") ? (role as Role) : null;
  } catch (err) {
    // undefined_table, invalid_schema_name
    if (["42P01", "3F000"].includes((err as { code?: string }).code ?? "")) return null;
    throw err;
  }
}

/** Whether the studio's accounts table exists yet. The door says so at start when it does not. */
export async function studioAccountsExist(db: Db): Promise<boolean> {
  const row = await db.query<{ ok: boolean }>("select to_regclass('studio.users') is not null as ok");
  return row.rows[0]?.ok === true;
}

export interface SignOnDeps {
  readonly config: SignOnConfig;
  readonly wire: ProviderWire;
  readonly db: Db;
  readonly sessionSecret: string;
  readonly clientSecret: string | null;
  /** The door's address as members open it ([surfaces.web] base_url). The redirect URI is its /callback. */
  readonly baseUrl: string;
  readonly now?: () => number;
}

export interface SignOn {
  /** The door's public origin, which a signed-in browser's POST must come from. */
  readonly origin: string;
  /** The provider's host, for the sign-in page. */
  readonly provider: string;
  /** The signed-in member; a session that just ended on a timer; or none: no cookie, an altered one, a session ended earlier, or an account the lab has removed. */
  session(cookieHeader: string | undefined): Promise<Session>;
  /** Where /login sends the browser, and the cookie that remembers this sign-in until /callback. */
  begin(next: string | null): Promise<{ readonly location: string; readonly setCookie: string }>;
  /** /callback. Throws SignOnRefused with a message for the person. */
  finish(query: URLSearchParams, cookieHeader: string | undefined): Promise<{ readonly member: Member; readonly next: string; readonly setCookie: readonly string[] }>;
  /** /logout: ends the cookie's session on the server, and returns the cookie that clears it here. */
  signOut(cookieHeader: string | undefined): Promise<readonly string[]>;
}

interface Provider {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

interface LoginState {
  readonly state: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly next: string;
}

export function createSignOn(deps: SignOnDeps): SignOn {
  const { config, wire, db, sessionSecret } = deps;
  if (sessionSecret.length < MIN_SESSION_SECRET) throw new Error(`${config.sessionSecretEnv} must hold at least ${MIN_SESSION_SECRET} characters to sign sessions`);
  const now = deps.now ?? Date.now;
  const seconds = () => Math.floor(now() / 1000);
  const base = new URL(deps.baseUrl);
  const redirectUri = new URL("/callback", base).href;
  const secure = base.protocol === "https:";
  const cookie = (name: string, value: string, path: string, maxAge: number) => `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

  /** A provider that cannot be reached is a sign-in that did not finish, said in words, never a 500. */
  const reach = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (err) {
      if (err instanceof SignOnWireError) throw new SignOnRefused(`The sign-on provider did not answer: ${err.message}. Try again, or tell the lab's research IT.`);
      throw err;
    }
  };

  let provider: Promise<Provider> | null = null;
  const discover = (): Promise<Provider> => {
    provider ??= (async () => {
      const url = `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
      const reply = await wire.getJson(url);
      const d = reply.json as Record<string, unknown>;
      if (reply.status !== 200 || !d || typeof d !== "object") throw new SignOnRefused(`The sign-on provider's discovery document did not load (${url} answered ${reply.status}).`);
      if (d.issuer !== config.issuer) throw new SignOnRefused(`The provider names itself ${String(d.issuer)}, but lab.toml's [auth] issuer is ${config.issuer}.`);
      const endpoints = [d.authorization_endpoint, d.token_endpoint, d.jwks_uri];
      if (!endpoints.every((e) => typeof e === "string")) throw new SignOnRefused("The provider's discovery document lacks an authorization, token or keys endpoint.");
      return { authorizationEndpoint: d.authorization_endpoint as string, tokenEndpoint: d.token_endpoint as string, jwksUri: d.jwks_uri as string };
    })();
    provider.catch(() => (provider = null));
    return provider;
  };

  let keys: { readonly at: number; readonly list: readonly Jwk[] } | null = null;
  const fetchKeys = async (): Promise<readonly Jwk[]> => {
    const reply = await wire.getJson((await discover()).jwksUri);
    const list = (reply.json as { keys?: unknown }).keys;
    if (reply.status !== 200 || !Array.isArray(list)) throw new SignOnRefused("The provider's keys did not load.");
    keys = { at: now(), list: list as Jwk[] };
    return keys.list;
  };
  const verify = async (idToken: string, nonce: string) => {
    const check = { issuer: config.issuer, clientId: config.clientId, nonce, nowSeconds: seconds() };
    try {
      return verifyIdToken(idToken, keys?.list ?? (await fetchKeys()), check);
    } catch (err) {
      if (!(err instanceof UnknownKey)) throw err;
      if (keys && now() - keys.at < KEYS_REFRESH_MS) throw new SignOnRefused("The ID token names a key the provider does not publish.");
      try {
        return verifyIdToken(idToken, await fetchKeys(), check);
      } catch (again) {
        if (again instanceof UnknownKey) throw new SignOnRefused("The ID token names a key the provider does not publish.");
        throw again;
      }
    }
  };

  /** The hash of the session id a cookie carries, when this door signed it. */
  const sessionOf = (cookieHeader: string | undefined): string | null => {
    const sid = (openValue(sessionSecret, "session", cookieValue(cookieHeader, SESSION_COOKIE), seconds())?.v as { sid?: unknown } | undefined)?.sid;
    return typeof sid === "string" ? idHash(sid) : null;
  };
  const end = (where: string, param: string, reason: EndedReason) =>
    db.query(`update door_sessions set ended_at = $2, ended_reason = $3 where ${where} and ended_at is null`, [param, at(seconds()), reason]);
  const cleared = cookie(SESSION_COOKIE, "", "/", 0);

  return {
    origin: base.origin,
    provider: new URL(config.issuer).host,
    async session(cookieHeader) {
      const hash = sessionOf(cookieHeader);
      if (!hash) return { t: "none" };
      const row = (
        await db.query<SessionRow>(
          "select member_id, email, claim_role, extract(epoch from created_at)::float8 as created, extract(epoch from last_seen_at)::float8 as seen, ended_at is not null as ended from door_sessions where id_hash = $1",
          [hash],
        )
      ).rows[0];
      if (!row || row.ended) return { t: "none" };
      const now = seconds();
      const timer: readonly [EndedReason, string] | null =
        now - row.seen >= config.idleMinutes * 60 ? ["idle", `ended after ${config.idleMinutes} minutes unused`]
        : now - row.created >= SESSION_SECONDS ? ["time_limit", `reached its ${SESSION_SECONDS / 3600} hour limit`]
        : row.claim_role !== null && now - row.created >= config.claimRoleMaxMinutes * 60 ? ["claim_role_limit", `reached its ${config.claimRoleMaxMinutes} minute limit for a role from the provider's groups`]
        : null;
      if (timer) {
        await end("id_hash = $1", hash, timer[0]);
        return { t: "ended", why: timer[1], setCookie: cleared };
      }
      const role = (row.claim_role as Role | null) ?? (await studioRole(db, row.email));
      if (!role) {
        await end("member_id = $1 and role_source = 'studio'", row.member_id, "no_account");
        return { t: "none" };
      }
      if (now - row.seen >= SEEN_WRITE_SECONDS) await db.query("update door_sessions set last_seen_at = $2 where id_hash = $1", [hash, at(now)]);
      return { t: "member", member: { id: row.member_id as MemberId, email: row.email, role } };
    },
    begin: (next) => reach(async () => {
      const p = await discover();
      const login: LoginState = { state: random(), verifier: random(), nonce: random(), next: safeNext(next) };
      const url = new URL(p.authorizationEndpoint);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        state: login.state,
        nonce: login.nonce,
        code_challenge: pkceChallenge(login.verifier),
        code_challenge_method: "S256",
      }))
        url.searchParams.set(k, v);
      return { location: url.href, setCookie: cookie(LOGIN_COOKIE, signValue(sessionSecret, "login", login, seconds() + LOGIN_SECONDS), "/callback", LOGIN_SECONDS) };
    }),
    finish: (query, cookieHeader) => reach(async () => {
      const error = query.get("error");
      // A fixed message: the provider's error_description arrives in the URL, so anyone could write it.
      if (error) throw new SignOnRefused("The provider did not sign you in. Try again, or tell the lab's research IT.");
      const login = (openValue(sessionSecret, "login", cookieValue(cookieHeader, LOGIN_COOKIE), seconds())?.v ?? null) as LoginState | null;
      if (!login) throw new SignOnRefused("This sign-in started more than ten minutes ago, or in another browser. Sign in again.");
      const state = query.get("state") ?? "";
      const [got, want] = [Buffer.from(state), Buffer.from(login.state)];
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new SignOnRefused("This sign-in does not match the one this browser started. Sign in again.");
      const code = query.get("code");
      if (!code) throw new SignOnRefused("The provider sent no code. Sign in again.");
      const p = await discover();
      const reply = await wire.postForm(
        p.tokenEndpoint,
        { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: login.verifier, client_id: config.clientId },
        deps.clientSecret === null ? null : { user: config.clientId, password: deps.clientSecret },
      );
      const tokens = reply.json as { id_token?: unknown; error?: unknown; error_description?: unknown };
      if (reply.status !== 200 || typeof tokens.id_token !== "string")
        throw new SignOnRefused(`The provider refused the sign-in code: ${String(tokens.error_description ?? tokens.error ?? `HTTP ${reply.status}`)}.`);
      const claims = await verify(tokens.id_token, login.nonce);
      const email = claims[config.emailClaim];
      if (typeof email !== "string" || !email.includes("@")) throw new SignOnRefused(`The provider's ID token has no email in its ${config.emailClaim} claim, so Aliquot cannot match you to a lab account.`);
      const id = claims[config.idClaim];
      if (typeof id !== "string" || !id.trim()) throw new SignOnRefused(`The provider's ID token has no ${config.idClaim} claim, which lab.toml's [auth] id_claim names as the member's id. Tell the lab's research IT.`);
      const fromClaim = config.rolesClaim === null ? null : claimRole(claims, config.rolesClaim, config.roleValues);
      // The email decides the role only through the studio account, and only an email the provider verified may.
      if (!fromClaim && claims.email_verified !== true && !config.trustUnverifiedEmail)
        throw new SignOnRefused(`The provider has not verified ${email}, so Aliquot cannot match it to a lab account.`);
      const role = fromClaim ?? (await studioRole(db, email));
      if (!role) throw new SignOnRefused(`You signed in as ${email}, but this lab has no account for that address. Ask the PI to add it in the studio.`);
      const sid = random();
      const now = seconds();
      await db.query(
        "insert into door_sessions (id_hash, member_id, email, role_source, claim_role, created_at, last_seen_at) values ($1, $2, $3, $4, $5, $6, $6)",
        [idHash(sid), id, email, fromClaim ? "claim" : "studio", fromClaim, at(now)],
      );
      const session = signValue(sessionSecret, "session", { sid }, now + SESSION_SECONDS);
      return { member: { id: id as MemberId, email, role }, next: login.next, setCookie: [cookie(SESSION_COOKIE, session, "/", SESSION_SECONDS), cookie(LOGIN_COOKIE, "", "/callback", 0)] };
    }),
    async signOut(cookieHeader) {
      const hash = sessionOf(cookieHeader);
      if (hash) await end("id_hash = $1", hash, "signed_out");
      return [cleared];
    },
  };
}
