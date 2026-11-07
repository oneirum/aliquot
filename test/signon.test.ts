import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDocument } from "../packages/core/src/agent.ts";
import { parseConfig, type SignOnConfig } from "../packages/core/src/config.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import type { IntakeDeps } from "../packages/core/src/frontdoor.ts";
import { createKbReader, memorySnapshots, snapshotFromFixture } from "../packages/core/src/kb.ts";
import { createPayloadStore, type RunEvent, type RunId } from "../packages/core/src/record.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { createSignOn, verifyIdToken } from "../packages/core/src/surfaces/signon.ts";
import { providerWire } from "../packages/core/src/surfaces/signon-wire.ts";
import { createWebHandler, doorTokens, listenWeb } from "../packages/core/src/surfaces/web.ts";
import { freshDatabase } from "./db.ts";
import { chain, ref, started } from "./events.ts";
import { Browser, seedStudioAccounts, startFakeOidc } from "./fake-oidc.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const ALICE = "alice@lab.edu";
const BOB = "bob@lab.edu";
const PI = "pi@lab.edu";
const STRANGER = "someone@campus.edu";

const { db } = await freshDatabase("labh_test_signon");
await seedStudioAccounts(db, [
  { email: ALICE, role: "member" },
  { email: BOB, role: "member" },
  { email: PI, role: "pi" },
]);
const idp = await startFakeOidc({ clientId: "aliquot-door", clientSecret: "provider-secret", people: [{ email: ALICE, name: "Alice" }, { email: BOB }, { email: PI }, { email: STRANGER }, { email: "unverified@lab.edu", emailVerified: false }] });
await seedStudioAccounts(db, [{ email: "unverified@lab.edu", role: "member" }]);

const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: randomBytes(32), keyId: "k1" });
const handbookJson = JSON.parse(readFileSync(join(root, "fixtures/kb.json"), "utf8")) as Record<string, unknown>;
const handbook = snapshotFromFixture(handbookJson, store.address);
const visits = snapshotFromFixture({ ...handbookJson, kbId: "visits", title: "Visit log", cls: "D3" }, store.address);
const kb = createKbReader(memorySnapshots([handbook, visits]));

// What intake saw as the member, so a test can tell whose id the door passed on.
const asked: string[] = [];
const probe = {
  agentFor: async () => ({}) as AgentDocument,
  gate: { members: async (user: string) => (asked.push(user), null), channelFloor: async () => "D1", labPatterns: [], policy: DEFAULT_POLICY },
} as unknown as IntakeDeps;

const acpToken = "a".repeat(40);
const tokens = doorTokens([{ id: "acp" as never, kind: "acp", placement: "lab", tokenEnv: "ACP" }], { ACP: acpToken }, () => {});
const auth: SignOnConfig = { issuer: idp.issuer, clientId: "aliquot-door", clientSecretEnv: "SECRET", sessionSecretEnv: "SESSION", emailClaim: "email" };
let handler: ReturnType<typeof createWebHandler> = async () => {};
const { server, port } = await listenWeb((req, res) => handler(req, res), 0);
const door = `http://127.0.0.1:${port}`;
const signOn = createSignOn({ config: auth, wire: providerWire, db, sessionSecret: randomBytes(32).toString("hex"), clientSecret: "provider-secret", baseUrl: door });
handler = createWebHandler(db, probe, () => {}, null, "Test Lab", tokens, null, { signOn, kb });
const open = await listenWeb(createWebHandler(db, probe, () => {}, null, "", tokens, null, { kb }), 0);
after(async () => {
  server.close();
  open.server.close();
  await idp.stop();
  await db.end();
});

let runs = 0;
async function insertRun(member: string, events: readonly RunEvent[], surface = "web"): Promise<string> {
  const payload = { surface, trigger: { t: "message", surface, messageId: `m${runs}`, memberId: member } };
  const runId = (await db.query<{ id: string }>("insert into jobs (kind, key, payload) values ('run', $1, $2) returning id", [`k:signon:${runs++}`, payload])).rows[0]!.id as RunId;
  const first = started();
  const withMember: RunEvent = first.t === "run.started" ? { ...first, surface, trigger: { t: "message", surface, messageId: "m", memberId: member } } : first;
  for (const e of chain([withMember, ...events], Date.parse("2026-11-06T12:00:00.000Z") + runs * 60_000, runId))
    await db.query("insert into run_events (run_id, seq, at, cls, prev_hash, hash, event) values ($1, $2, $3, $4, $5, $6, $7)", [e.runId, e.seq, e.at, e.cls, e.prevHash, e.hash, e.event]);
  return runId;
}
const read = (snapshot: typeof handbook, path: string): RunEvent => ({
  t: "tool.completed",
  callId: "c1",
  attempt: 0,
  output: ref("out"),
  retrieved: [{ snapshot: snapshot.snapshot.id, entries: [snapshot.entries.find((e) => e.path === path)!.hash], truncated: false }],
  ms: 3,
});
const finished: RunEvent = { t: "run.finished", outcome: "answered", answer: null, reason: null, flags: [] };

const aliceRun = await insertRun(ALICE, [read(handbook, "office-hours.md"), finished]);
const aliceRestricted = await insertRun(ALICE, [read(visits, "office-hours.md"), finished]);
const bobRun = await insertRun(BOB, [finished]);
const acpRun = await insertRun(ALICE, [finished], "acp");

async function signedIn(email: string): Promise<Browser> {
  const b = new Browser();
  const { res } = await b.signIn(door, email);
  assert.equal(res.status, 200, `${email} lands on the chat page`);
  return b;
}

test("a member signs in through the provider with PKCE, lands on the page they asked for, and the page asks as them", async () => {
  const b = new Browser();
  const { res, hops } = await b.signIn(door, ALICE, "/runs?show=failed");
  assert.equal(res.status, 200);
  assert.equal(hops.at(-1), `${door}/runs?show=failed`);
  assert.ok(hops.some((h) => h.startsWith(`${door}/callback?code=`)), "came back through /callback");
  assert.ok(idp.log.includes(`token for ${ALICE}`), "the door exchanged the code at the token endpoint");
  const chat = await (await b.fetch(`${door}/`)).text();
  assert.ok(chat.includes(`const user = "${ALICE}";`), "the chat page names the signed-in member");
  assert.ok(chat.includes('action="/logout"'), "and offers sign out");
});

test("without a session a page is the sign-in page and a JSON route is a 401", async () => {
  const page = await fetch(`${door}/runs/${aliceRun}`);
  assert.equal(page.status, 401);
  const html = await page.text();
  assert.ok(html.includes("Sign in to ask the lab"));
  assert.ok(html.includes(`/login?next=${encodeURIComponent(`/runs/${aliceRun}`)}`), "signing in comes back to the record");
  assert.ok(html.includes(new URL(idp.issuer).host), "names the provider");
  assert.equal((await fetch(`${door}/runs/${aliceRun}/events`)).status, 401);
  assert.equal((await fetch(`${door}/message`, { method: "POST", body: JSON.stringify({ thread: "t", message: "m", text: "hi", user: ALICE }) })).status, 401);
});

test("once sign-on is on, a body user is ignored: intake gets the session's member", async () => {
  const b = await signedIn(ALICE);
  asked.length = 0;
  const res = await b.fetch(`${door}/message`, { method: "POST", headers: { "content-type": "application/json", origin: door }, body: JSON.stringify({ thread: "t", message: "m1", text: "hi", user: "mallory@lab.edu" }) });
  assert.equal(res.status, 403, "the probe's gate refuses every member");
  assert.deepEqual(asked, [ALICE]);
  asked.length = 0;
  await fetch(`http://127.0.0.1:${open.port}/message`, { method: "POST", body: JSON.stringify({ thread: "t", message: "m2", text: "hi", user: "mallory@lab.edu" }) });
  assert.deepEqual(asked, ["mallory@lab.edu"], "without sign-on the door still trusts the body, on loopback");
});

test("a signed-in POST from another origin is refused", async () => {
  const b = await signedIn(ALICE);
  const res = await b.fetch(`${door}/message`, { method: "POST", headers: { origin: "https://elsewhere.example" }, body: JSON.stringify({ thread: "t", message: "m3", text: "hi" }) });
  assert.deepEqual({ status: res.status, body: await res.json() }, { status: 403, body: { error: `a signed-in POST must come from ${door}` } });
});

test("the runs list shows a member only their own runs, another member's run is a 404 on every route, and the PI sees all", async () => {
  const alice = await signedIn(ALICE);
  const list = await (await alice.fetch(`${door}/runs`)).text();
  assert.ok(list.includes("Your runs"));
  assert.ok(list.includes(aliceRun) && list.includes(aliceRestricted) && list.includes(acpRun), "alice's own runs, from any surface");
  assert.ok(!list.includes(bobRun), "not bob's");
  for (const path of [`/runs/${bobRun}`, `/runs/${bobRun}/events`, `/runs/${bobRun}/view`, `/runs/${bobRun}/source.json?path=office-hours.md`, `/replies?runId=${bobRun}`])
    assert.equal((await alice.fetch(`${door}${path}`)).status, 404, path);
  const stop = await alice.fetch(`${door}/stop`, { method: "POST", headers: { origin: door }, body: JSON.stringify({ runId: bobRun }) });
  assert.equal(stop.status, 404, "/stop on bob's run");
  assert.equal((await alice.fetch(`${door}/runs/${aliceRun}/view`)).status, 200);

  const bob = await signedIn(BOB);
  const bobList = await (await bob.fetch(`${door}/runs`)).text();
  assert.ok(bobList.includes(bobRun) && !bobList.includes(aliceRun));
  assert.equal((await bob.fetch(`${door}/runs/${aliceRun}`)).status, 404);

  const pi = await signedIn(PI);
  const piList = await (await pi.fetch(`${door}/runs`)).text();
  assert.ok(piList.includes("<h1>Runs</h1>"));
  assert.ok([aliceRun, aliceRestricted, bobRun, acpRun].every((r) => piList.includes(r)), "the PI sees every member's runs");
  assert.equal((await pi.fetch(`${door}/runs/${bobRun}/events`)).status, 200);
});

test("with sign-on on, a token surface reads only its own surface's runs", async () => {
  const as = (path: string) => fetch(`${door}${path}`, { headers: { authorization: `Bearer ${acpToken}` } });
  assert.equal((await as(`/runs/${acpRun}/events`)).status, 200);
  assert.equal((await as(`/runs/${aliceRun}/events`)).status, 404);
});

test("the Source chip opens an entry below D3 for a member, and for a D3 entry says who can", async () => {
  const alice = await signedIn(ALICE);
  const chip = await (await alice.fetch(`${door}/runs/${aliceRun}/source.json?path=office-hours.md`)).json();
  const entry = handbook.entries.find((e) => e.path === "office-hours.md")!;
  assert.deepEqual(chip, { path: "office-hours.md", found: true, title: entry.title, kb: handbook.snapshot.title, cls: "D1", retrieved: true, open: true, who: "every member" });
  const page = await alice.fetch(`${door}/runs/${aliceRun}/source?path=office-hours.md`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes(`<h1>${entry.title}</h1>`));
  assert.ok(html.includes("Retrieved by this run"), "the page shows the record's check of the entry");
  assert.ok(html.includes(entry.body.split("\n")[0]!.slice(0, 30).replace(/&/g, "&#38;")), "and the entry's text");

  const restricted = await (await alice.fetch(`${door}/runs/${aliceRestricted}/source.json?path=office-hours.md`)).json();
  assert.deepEqual(restricted, { path: "office-hours.md", found: true, title: entry.title, kb: "Visit log", cls: "D3", retrieved: true, open: false, who: "the data steward or the PI" });
  const refused = await alice.fetch(`${door}/runs/${aliceRestricted}/source?path=office-hours.md`);
  assert.equal(refused.status, 403);
  const refusedHtml = await refused.text();
  assert.ok(refusedHtml.includes("the data steward or the PI can"));
  assert.ok(!refusedHtml.includes(entry.body.split("\n")[0]!.slice(0, 30)), "and none of the entry's text");

  const pi = await signedIn(PI);
  assert.equal((await pi.fetch(`${door}/runs/${aliceRestricted}/source?path=office-hours.md`)).status, 200, "the PI may open D3");

  assert.deepEqual(await (await alice.fetch(`${door}/runs/${aliceRun}/source.json?path=made-up.md`)).json(), { path: "made-up.md", found: false });
  assert.equal((await alice.fetch(`${door}/runs/${aliceRun}/source?path=made-up.md`)).status, 404);
});

test("without sign-on the Source chip treats everyone as a member: D1 opens, D3 does not", async () => {
  const base = `http://127.0.0.1:${open.port}`;
  assert.equal((await fetch(`${base}/runs/${aliceRun}/source?path=office-hours.md`)).status, 200);
  assert.equal((await fetch(`${base}/runs/${aliceRestricted}/source?path=office-hours.md`)).status, 403);
});

test("a person the provider vouches for but the lab has no account for is refused, and gets no session", async () => {
  const b = new Browser();
  const { res } = await b.signIn(door, STRANGER);
  assert.equal(res.status, 403);
  assert.ok((await res.text()).includes(`You signed in as ${STRANGER}, but this lab has no account for that address. Ask the PI to add it in the studio.`));
  assert.ok(!b.cookies.has("aliquot_session"));
});

test("an ID token with the wrong audience, nonce, issuer or expiry, or an unverified email, signs nobody in", async () => {
  const cases: readonly [string, (c: Record<string, unknown>) => Record<string, unknown>, string][] = [
    ["audience", (c) => ({ ...c, aud: "another-app" }), "issued to another application"],
    ["nonce", (c) => ({ ...c, nonce: "replayed" }), "does not answer this sign-in"],
    ["issuer", (c) => ({ ...c, iss: "https://evil.example" }), "issued by https://evil.example"],
    ["expiry", (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }), "has expired"],
  ];
  for (const [what, change, says] of cases) {
    idp.tamperNext(change);
    const b = new Browser();
    const { res } = await b.signIn(door, ALICE);
    assert.equal(res.status, 403, what);
    assert.ok((await res.text()).includes(says), `${what}: ${says}`);
    assert.ok(!b.cookies.has("aliquot_session"), what);
  }
  const unverified = new Browser();
  const r = await unverified.signIn(door, "unverified@lab.edu");
  assert.equal(r.res.status, 403);
  assert.ok((await r.res.text()).includes("has not verified unverified@lab.edu"));
});

test("an ID token signed by a key the provider does not publish, or with alg none, does not verify", async () => {
  const { keys } = (await (await fetch(`${idp.issuer}/jwks`)).json()) as { keys: never[] };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: idp.issuer, aud: "aliquot-door", sub: "s", exp: now + 60, iat: now, nonce: "n", email: ALICE };
  const check = { issuer: idp.issuer, clientId: "aliquot-door", nonce: "n", nowSeconds: now };
  assert.equal(verifyIdToken(idp.sign(claims), keys, check).email, ALICE);
  assert.throws(() => verifyIdToken(idp.sign(claims, { foreignKey: true }), keys, check), { message: "The ID token's signature does not verify against the provider's published keys." });
  const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
  assert.throws(() => verifyIdToken(none, keys, check), { message: "The provider signed its ID token with none, which Aliquot does not accept. Use RS256 or ES256." });
  assert.throws(() => verifyIdToken(idp.sign(claims, { alg: "ES256" }), keys, check), { message: "The ID token's signature does not verify against the provider's published keys." }, "an RSA key never verifies an ES256 header");
});

test("a callback without the login cookie, or with another browser's state, is refused", async () => {
  const b = new Browser();
  const login = await b.fetch(`${door}/login?next=/`);
  const authorize = new URL(login.headers.get("location")!);
  authorize.pathname = "/authorize/pick";
  authorize.searchParams.set("login_hint", ALICE);
  const back = (await fetch(authorize, { redirect: "manual" })).headers.get("location")!;
  const elsewhere = await new Browser().fetch(back);
  assert.equal(elsewhere.status, 403, "another browser, no login cookie");
  const forged = await b.fetch(back.replace(/state=[^&]+/, "state=forged"));
  assert.equal(forged.status, 403, "state that does not match the login cookie");
});

test("an altered session cookie is no session, and signing out ends it", async () => {
  const b = await signedIn(ALICE);
  const real = b.cookies.get("aliquot_session")!;
  const [body, mac] = real.split(".");
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as { v: { email: string } };
  claims.v.email = PI;
  b.cookies.set("aliquot_session", `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${mac}`);
  assert.equal((await b.fetch(`${door}/runs/${bobRun}/events`)).status, 401, "a session altered to the PI's email");
  b.cookies.set("aliquot_session", real);
  assert.equal((await b.fetch(`${door}/runs/${aliceRun}/events`)).status, 200);
  const out = await b.open(`${door}/logout`);
  assert.equal(out.res.status, 401);
  assert.ok((await out.res.text()).includes("You are signed out."));
  assert.equal((await b.fetch(`${door}/runs/${aliceRun}/events`)).status, 401);
});

test("a removed studio account loses access on its next request", async () => {
  await seedStudioAccounts(db, [{ email: "leaving@lab.edu", role: "member" }]);
  const idp2 = await startFakeOidc({ clientId: "aliquot-door", clientSecret: null, people: [{ email: "leaving@lab.edu" }] });
  try {
    let h2: ReturnType<typeof createWebHandler> = async () => {};
    const s2 = await listenWeb((req, res) => h2(req, res), 0);
    const door2 = `http://127.0.0.1:${s2.port}`;
    const publicClient = createSignOn({ config: { ...auth, issuer: idp2.issuer, clientSecretEnv: null }, wire: providerWire, db, sessionSecret: randomBytes(32).toString("hex"), clientSecret: null, baseUrl: door2 });
    h2 = createWebHandler(db, probe, () => {}, null, "", new Map(), null, { signOn: publicClient, kb });
    const b = new Browser();
    assert.equal((await b.signIn(door2, "leaving@lab.edu")).res.status, 200, "a public client signs in with PKCE alone");
    assert.equal((await b.fetch(`${door2}/runs`)).status, 200);
    await db.query("delete from studio.users where email = 'leaving@lab.edu'");
    assert.equal((await b.fetch(`${door2}/runs`)).status, 401);
    s2.server.close();
  } finally {
    await idp2.stop();
  }
});

test("lab.toml refuses a web bind beyond loopback without [auth], and takes it with [auth]", () => {
  const base = '[endpoints.local]\nbase_url = "http://127.0.0.1:11434/v1"\nplacement = "lab"\n';
  assert.throws(() => parseConfig(`${base}[surfaces.web]\nbind = "0.0.0.0"\n`, "/lab/lab.toml"), {
    message: 'lab.toml: [surfaces.web] bind: 0.0.0.0 reaches beyond this machine, which needs [auth]: without sign-on the door trusts the member id it is given',
  });
  assert.equal(parseConfig(`${base}[surfaces.web]\nbind = "127.0.0.1"\n`, "/lab/lab.toml").web.bind, "127.0.0.1");
  const c = parseConfig(`${base}[surfaces.web]\nbind = "0.0.0.0"\nbase_url = "https://ask.lab.edu"\n[auth]\nissuer = "https://login.lab.edu"\nclient_id = "aliquot"\nclient_secret_env = "OIDC_SECRET"\n`, "/lab/lab.toml");
  assert.deepEqual({ bind: c.web.bind, signOn: c.signOn }, { bind: "0.0.0.0", signOn: { issuer: "https://login.lab.edu", clientId: "aliquot", clientSecretEnv: "OIDC_SECRET", sessionSecretEnv: "LABH_SESSION_SECRET", emailClaim: "email" } });
});

test("the door binary will not listen beyond loopback without [auth], whether asked by --host or --published", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bind-refused-")));
  const cfg = join(dir, "lab.toml");
  writeFileSync(cfg, '[endpoints.local]\nbase_url = "http://127.0.0.1:11434/v1"\nplacement = "lab"\n');
  for (const args of [["--host", "0.0.0.0"], ["--host", "0.0.0.0", "--published", "192.168.1.20"], ["--published", "0.0.0.0"]]) {
    const r = spawnSync(process.execPath, [...PERMISSION_FLAGS, "packages/core/bin/web.ts", "--config", cfg, ...args], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" }, timeout: 30_000 });
    const where = args.includes("--published") ? args[args.indexOf("--published") + 1] : "0.0.0.0";
    assert.deepEqual({ status: r.status, stderr: r.stderr }, { status: 2, stderr: `the web door refuses to start: ${where} reaches beyond this machine, which needs [auth]: without sign-on the door trusts the member id it is given\n` }, args.join(" "));
  }
});
