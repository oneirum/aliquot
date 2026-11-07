#!/usr/bin/env node
// labh web: node --permission --allow-fs-read=* --allow-net packages/core/bin/web.ts --config lab.toml [--port 3000] [--host <[surfaces.web] bind>] [--published <address>]
// --published is where members reach the door when that differs from where it listens: inside a container the door
// listens on 0.0.0.0 and compose publishes it on LABH_BIND, so compose passes that address here.
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { boot } from "../src/boot.ts";
import { bindRefusal, configProblem, loadConfig } from "../src/config.ts";

import { setStudioPassword, STUDIO_DB_PASSWORD_ENV, STUDIO_ROLE } from "../src/db.ts";
import { requireProcessPermission, sealNetwork } from "../src/seal.ts";
import { createSignOn, studioAccountsExist, type SignOn } from "../src/surfaces/signon.ts";
import { providerWire } from "../src/surfaces/signon-wire.ts";
import { studioRoute } from "../src/surfaces/studio-door.ts";
import { createWebHandler, doorTokens, listenWeb, type DoorTokens } from "../src/surfaces/web.ts";

const denied = requireProcessPermission();
if (denied) {
  process.stderr.write(`${denied}\n`);
  process.exit(2);
}
sealNetwork();

const { values } = parseArgs({ options: { config: { type: "string", default: "lab.toml" }, port: { type: "string" }, host: { type: "string" }, published: { type: "string" } } });

const configRefused = await configProblem(values.config);
if (configRefused) {
  process.stderr.write(`${configRefused}\n`);
  process.exit(2);
}
const config = await loadConfig(values.config);
const host = values.host ?? config.web.bind;
const reachRefused = bindRefusal(values.published ?? host, config.signOn !== null);
if (reachRefused) {
  process.stderr.write(`the web door refuses to start: ${reachRefused}\n`);
  process.exit(2);
}

const core = await boot(values.config);
const log = (line: string) => console.error(line);
// The studio signs in to Postgres as its own role; the door, which starts before it, sets that role's password.
const studioPassword = process.env[STUDIO_DB_PASSWORD_ENV];
if (core.config.surfaces.some((s) => s.kind === "studio")) {
  try {
    if (!studioPassword) log(`[web] ${STUDIO_DB_PASSWORD_ENV} is not set, so the studio cannot sign in to Postgres as ${STUDIO_ROLE}. Add one: echo "${STUDIO_DB_PASSWORD_ENV}=$(openssl rand -hex 24)" >> .env`);
    else if (!(await setStudioPassword(core.db, studioPassword))) log(`[web] Postgres has no ${STUDIO_ROLE} role (the migrator was not a superuser): docs/install.md, "Least privilege"`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    await core.close();
    process.exit(2);
  }
}
let tokens: DoorTokens;
let signOn: SignOn | undefined;
try {
  tokens = doorTokens(core.config.surfaces, process.env, log);
  const s = core.config.signOn;
  if (s) {
    const secret = s.clientSecretEnv === null ? null : (process.env[s.clientSecretEnv] ?? "");
    if (secret === "") throw new Error(`[auth] names client_secret_env ${s.clientSecretEnv}, which is not set`);
    signOn = createSignOn({ config: s, wire: providerWire, db: core.db, sessionSecret: process.env[s.sessionSecretEnv] ?? "", clientSecret: secret, baseUrl: core.config.web.baseUrl });
    if (s.rolesClaim === null && !(await studioAccountsExist(core.db))) log("[web] sign-on is on, but the studio has no accounts yet, so nobody can sign in until the studio has started once and its PI has added members");
  }
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  await core.close();
  process.exit(2);
}
const handler = createWebHandler(core.db, core.intake, log, core.config.web.channel, core.config.labName ?? hostname(), tokens, (surface, op, json) => studioRoute(core, surface, op, json), { ...(signOn ? { signOn } : {}), kb: core.kb, directory: core.directory }, core.config.prices);
const { server, port } = await listenWeb(handler, values.port ? Number(values.port) : core.config.web.port, host);
console.log(`[web] listening on http://${host}:${port}${signOn ? `, members sign in at ${new URL(core.config.signOn!.issuer).host}` : ""}`);

const shutdown = () => {
  server.close(() => void core.close().then(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
