#!/usr/bin/env node
// aliquot: node --permission --allow-fs-read=* --allow-net packages/core/bin/aliquot.ts [--config lab.toml] [--json] <record <run-id> | runs [--limit n] | keys ... | retention ...>
// aliquot init also needs --allow-fs-write for the two files it writes, and for nothing else (pnpm aliquot:init).
// aliquot export also needs --allow-fs-write for the bundle directory (pnpm aliquot:export allows bundles/* only).
// aliquot replay needs no lab.toml, database or key: it reads one bundle directory.
// aliquot ask, acp, mcp, slack and teams need no lab.toml or database: they reach the web door named by --door, and only it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { configProblem, databaseUrlFromEnv, loadConfig, type LabConfig } from "../src/config.ts";
import { connect, type Db } from "../src/db.ts";
import { askAnswers, defaultAnswers, InitAborted, OFFERED_CAMPUSES, parseCampus, renderEnv, renderLabToml, surfaceTokenHints, type Prompt } from "../src/init.ts";
import { loadEvents, recentRunIds, verifyChain, type RunId } from "../src/record.ts";
import { ANCHOR_KEY_ENV, AnchorRefused, newAnchorKeyPem, describeAnchorProblem, loadAnchorKey, loadAnchorVerifyKey, verifyAnchors, writeAnchor } from "../src/anchor.ts";
import { loadAudit, verifyAudit } from "../src/audit.ts";
import { formatRecordView, formatRunList, recordView, recordViewOf } from "../src/record-view.ts";
import { brokenChains, heldKeyIds, keyStatus, openPayloadStore, pastRetention, recordRotation, reencryptAll, retentionWindows, sweepRetention } from "../src/steward.ts";
import { DEFAULT_ALLOWANCE, PERMISSION_FLAGS, requireProcessPermission, sealNetwork } from "../src/seal.ts";
import { acpAgent } from "../src/acp.ts";
import { mcpServer } from "../src/mcp.ts";
import { slackDoor } from "../src/surfaces/slack.ts";
import { checkApiBase, runSocketMode, slackApi, SLACK_API } from "../src/surfaces/slack-wire.ts";
import { teamsDoor } from "../src/surfaces/teams.ts";
import { BOT_OPENID, botConnector, botVerifier, checkBase, LOGIN, serveMessages } from "../src/surfaces/teams-wire.ts";
import { ask, DoorError, isDataClass, stop, SURFACE_TOKEN_ENV, type Door, type DoorEvent } from "../src/door-client.ts";
import { rank } from "../src/dataclass.ts";
import { STUDY_USAGE, studyCommands } from "./study-cli.ts";
import { exportCommand, REPLAY_USAGE, replayCommand } from "./replay-cli.ts";

const denied = requireProcessPermission();
if (denied) {
  process.stderr.write(`${denied}\n`);
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
// The door client reaches the web door over HTTP, and the Slack and Teams doors' wires reach Slack and Microsoft; this binary adds those three files to the seal.
sealNetwork({ ...DEFAULT_ALLOWANCE, files: [...DEFAULT_ALLOWANCE.files, ...["door-client.ts", "surfaces/slack-wire.ts", "surfaces/teams-wire.ts"].map((f) => join(here, "..", "src", f))] });

const USAGE = `usage: aliquot [--config lab.toml] [--json] <command>

  record <run-id>     print one run's record and check its hash chain
  runs [--limit n]    list the newest runs (default 20), each with its outcome and chain check
  verify [--anchors] [--public-key file]
                      recompute the audit stream's chain and every run's chain. --anchors also checks each line
                      of the [anchor] log: its signature, its place in the log, and that the database still holds
                      the hash it signed at that seq, and names the first seq that changed. The key is the file
                      $LABH_ANCHOR_KEY_FILE names, or --public-key, a PEM holding only the public half.
  anchor              sign the audit stream's head and every run closed since the last anchor with the key in
                      $LABH_ANCHOR_KEY_FILE, append one line to the [anchor] path, and print that line, for a
                      shipper to forward to WORM storage or the SIEM. Needs --allow-fs-write=<that path>.
                      The worker writes one every [anchor] every_minutes.
  keys status         each payload key id, its env var, whether this process holds it, what it writes, how many
                      bodies it holds and how many wait to move; then what is past the retention window
  keys rotate         after [store] current names a new key: keep the lab's address key under it too and record
                      the rotation, so the old key can go once it holds no bodies
  keys reencrypt [--batch n]
                      move every body to its class's key, in batches (default 500); safe to stop and run again
  keys env            one line per key id: id, env var, bodies (scripts/backup.sh reads it)
  retention --dry-run [--as-of YYYY-MM-DD] | --apply
                      list, or redact, the run bodies past [policy.retention] purge_payload_after_days. A redacted body keeps its
                      hash, class and size, so every chain still verifies; --apply checks them after. --as-of previews a later date
  ask [--door url] [--user id] [--thread id] [--ceiling D0..D3] [--timeout s] <question... | ->
                      ask a question through the web door, as the chat page does; - reads it from stdin.
                      --json prints one JSON line per event: started, tool, finished, refused
  acp [--door url] [--user id] [--ceiling D0..D3]
                      speak the Agent Client Protocol on stdin and stdout, for T3 Code, Zed and other ACP clients
  mcp [--door url] [--user id] [--ceiling D0..D3]
                      serve one MCP tool, ask, on stdin and stdout, for a member's Claude Code, Codex or Cursor
                      --door defaults to $ALIQUOT_DOOR, else http://127.0.0.1:3000; --user to $ALIQUOT_USER
                      $ALIQUOT_SURFACE_TOKEN names the surface ask, acp and mcp speak as, such as [surfaces.acp];
                      without it they speak as the web surface. The door withholds any answer above that
                      surface's placement. --ceiling is a stricter promise on this side, for a client that keeps a copy.
  slack [--door url] [--links url]
                      the Slack door: answer mentions and direct messages in Slack over Socket Mode, through the web
                      door as the [surfaces.slack] surface. Needs $SLACK_APP_TOKEN (xapp-, connections:write),
                      $SLACK_BOT_TOKEN (xoxb-) and $ALIQUOT_SURFACE_TOKEN set to the slack surface's token; it will not
                      speak as the web surface. --links is the door's address members open record links at, when
                      --door is internal (default: the --door address). docs/slack.md has the app manifest.
  teams [--door url] [--links url] [--listen host:port]
                      the Teams door: answer mentions and personal chats in Microsoft Teams, through the web door as
                      the [surfaces.teams] surface. It listens for the Bot Framework on --listen (default
                      127.0.0.1:3978) at /api/messages, behind the lab's TLS proxy, and accepts only activities the
                      Bot Framework signed for this app. Needs $MICROSOFT_APP_ID, $MICROSOFT_APP_PASSWORD,
                      $MICROSOFT_APP_TENANT_ID and $ALIQUOT_SURFACE_TOKEN set to the teams surface's token.
                      docs/teams.md has the app manifest and the tenant admin's steps.
  init [--config config/lab.toml] [--env .env] [--force] [--yes --sample <id>... [--pattern <regex>...]]
       [--campus uw-madison|umich|harvard|none] [--anchor-key <file> [--anchor-log <file>]]
                      write lab.toml from a few questions, testing the participant id patterns against
                      sample ids, and write .env with new secrets when it does not exist yet. --force
                      replaces lab.toml, never .env. --yes takes every default and needs --sample.
                      The last question (--campus with --yes) names the campus preset whose tiers each
                      data class shows (presets/<campus>.toml, a starting point for the data steward).
                      Run it as pnpm aliquot:init, which allows writes to config/lab.toml and .env only.
                      --anchor-key also writes a new Ed25519 anchor key there (mode 600, never over an existing
                      file) and an [anchor] table whose log is --anchor-log (default anchors.log beside lab.toml);
                      it needs write access to the key file too. Keep the key off the database host if you can.

${STUDY_USAGE}
${REPLAY_USAGE}

Exit codes: 0 ok, 1 no such run, init found no pattern that passes, ask was refused or got no answer, or export
was refused (no such run or study, --out not empty), 2 usage or setup problem (ask: the door could not be
reached; replay: no readable bundle), 3 a hash chain or a body hash is broken or an anchor does not hold, 4 a
re-executed run did not agree exactly with its record, 5 a run could not be re-executed (its bodies are above the
bundle's clearance or the endpoint's placement, it took a steer mid-run, or its tools are not in this build).
`;

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      limit: { type: "string", default: "20" },
      env: { type: "string", default: ".env" },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      pattern: { type: "string", multiple: true, default: [] },
      sample: { type: "string", multiple: true, default: [] },
      campus: { type: "string" },
      door: { type: "string" },
      links: { type: "string" },
      listen: { type: "string", default: "127.0.0.1:3978" },
      user: { type: "string" },
      thread: { type: "string" },
      ceiling: { type: "string" },
      timeout: { type: "string", default: "180" },
      anchors: { type: "boolean", default: false },
      "anchor-key": { type: "string" },
      "anchor-log": { type: "string" },
      "public-key": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "as-of": { type: "string" },
      batch: { type: "string", default: "500" },
      as: { type: "string" },
      title: { type: "string" },
      floor: { type: "string" },
      irb: { type: "string" },
      prereg: { type: "string" },
      note: { type: "string" },
      reason: { type: "string" },
      runs: { type: "string" },
      study: { type: "string" },
      clearance: { type: "string" },
      out: { type: "string" },
      reexecute: { type: "boolean", default: false },
      endpoint: { type: "string" },
      "endpoint-placement": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
} catch {
  usage();
}
const { values, positionals } = parsed;
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const [command, runId, ...extra] = positionals;
if (command === "init") {
  if (runId !== undefined || values.json || (values["anchor-log"] !== undefined && values["anchor-key"] === undefined) || (!values.yes && (values.pattern.length || values.sample.length)) || (values.yes && !values.sample.length)) usage();
  process.exit(await init());
}
if (command === "replay") process.exit(await replayCommand(positionals.slice(1), { json: values.json, reexecute: values.reexecute, endpoint: values.endpoint, endpointPlacement: values["endpoint-placement"] }));
if (command === "export") {
  const { runs, study, clearance, out } = values;
  process.exit(await exportCommand(positionals.slice(1), { config: values.config ?? "lab.toml", json: values.json, runs, study, clearance, out, as: values.as }));
}
if (command === "ask" || command === "acp" || command === "mcp") process.exit(await viaDoor(command, positionals.slice(1)));
if (command === "slack") process.exit(await slack(positionals.slice(1)));
if (command === "teams") process.exit(await teams(positionals.slice(1)));
if (command === "study" || command === "card" || command === "sheet") {
  const { as, title, floor, irb, prereg, note, reason } = values;
  process.exit(await studyCommands(command, positionals.slice(1), { config: values.config ?? "lab.toml", json: values.json, as, title, floor, irb, prereg, note, reason }));
}
const limit = Number(values.limit);
const initOnly = values.force || values.yes || values.pattern.length > 0 || values.sample.length > 0 || values.campus !== undefined || values["anchor-key"] !== undefined || values["anchor-log"] !== undefined;
const verifyOnly = values.anchors || values["public-key"] !== undefined;
const stewardOnly = values["dry-run"] || values.apply || values["as-of"] !== undefined;
const valid =
  extra.length === 0 &&
  !initOnly &&
  (command === "verify" || !verifyOnly) &&
  ((!stewardOnly && command === "record" && !!runId && /^[0-9a-f-]{36}$/i.test(runId)) ||
    (!stewardOnly && command === "runs" && !runId && Number.isInteger(limit) && limit > 0 && limit <= 1000) ||
    (!stewardOnly && (command === "verify" || command === "anchor") && !runId && !values.json) ||
    (command === "keys" && ["status", "rotate", "reencrypt", "env"].includes(runId ?? "") && !values["dry-run"] && !values.apply && (values["as-of"] === undefined || runId === "status")) ||
    (command === "retention" && !runId && values["dry-run"] !== values.apply));
if (!valid) usage();
if (command === "retention" && values.apply && values["as-of"] !== undefined) {
  // A sweep judged at a later date would redact bodies before their floor; only a preview may look ahead.
  process.stderr.write("aliquot retention: --as-of previews with --dry-run only; --apply always judges the window as of today.\n");
  process.exit(2);
}

async function slack(words: readonly string[]): Promise<number> {
  if (words.length || values.json || values.user || values.ceiling || values.thread) usage();
  const fail = (line: string) => (process.stderr.write(`[slack] ${line}\n`), 2);
  const token = process.env[SURFACE_TOKEN_ENV];
  // Without a token the door would take Slack for the web surface, whose placement is the lab's own.
  if (!token) return fail(`${SURFACE_TOKEN_ENV} is not set. Set it to the value of [surfaces.slack] token_env, so the door holds Slack to that surface's placement.`);
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!appToken?.startsWith("xapp-")) return fail("SLACK_APP_TOKEN must be the app-level token (xapp-...) with connections:write, from the app's Basic Information page.");
  if (!botToken?.startsWith("xoxb-")) return fail("SLACK_BOT_TOKEN must be the bot token (xoxb-...) from the app's OAuth & Permissions page.");
  let base: URL;
  try {
    base = checkApiBase(process.env.ALIQUOT_SLACK_API ?? SLACK_API);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const door: Door = { url: values.door ?? process.env.ALIQUOT_DOOR ?? "http://127.0.0.1:3000", token };
  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) usage();
  const doorBase = door.url.endsWith("/") ? door.url : `${door.url}/`;
  const links = values.links ? (values.links.endsWith("/") ? values.links : `${values.links}/`) : doorBase;
  const log = (line: string) => void process.stderr.write(`${line}\n`);
  const handle = slackDoor({
    ask: (input, opts) => ask(door, input, { ...opts, timeoutMs: timeout * 1000 }),
    stop: (runId, user) => stop(door, runId, user),
    api: slackApi(base, botToken),
    log,
    recordLink: (url) => (url.startsWith(doorBase) ? links + url.slice(doorBase.length) : url),
  });
  const abort = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => abort.abort());
  log(`[slack] answering through the door at ${door.url}`);
  await runSocketMode(slackApi(base, appToken), (msg, reply) => void handle(msg, reply), log, abort.signal);
  return 0;
}

async function teams(words: readonly string[]): Promise<number> {
  if (words.length || values.json || values.user || values.ceiling || values.thread) usage();
  const fail = (line: string) => (process.stderr.write(`[teams] ${line}\n`), 2);
  const token = process.env[SURFACE_TOKEN_ENV];
  // Without a token the door would take Teams for the web surface, whose placement is the lab's own.
  if (!token) return fail(`${SURFACE_TOKEN_ENV} is not set. Set it to the value of [surfaces.teams] token_env, so the door holds Teams to that surface's placement.`);
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const appId = process.env.MICROSOFT_APP_ID ?? "";
  const secret = process.env.MICROSOFT_APP_PASSWORD ?? "";
  const tenant = process.env.MICROSOFT_APP_TENANT_ID ?? "";
  if (!guid.test(appId)) return fail("MICROSOFT_APP_ID must be the app registration's Application (client) ID, a GUID.");
  if (!secret) return fail("MICROSOFT_APP_PASSWORD must be a client secret of that app registration.");
  if (!guid.test(tenant)) return fail("MICROSOFT_APP_TENANT_ID must be the lab's Directory (tenant) ID, a GUID; the bot is single tenant.");
  const listen = /^(.+):(\d+)$/.exec(values.listen);
  if (!listen) usage();
  let openid: URL;
  let login: URL;
  try {
    openid = checkBase(process.env.ALIQUOT_TEAMS_OPENID ?? BOT_OPENID, "the Bot Framework OpenID configuration");
    login = checkBase(process.env.ALIQUOT_TEAMS_LOGIN ?? LOGIN, "the Microsoft login endpoint");
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!login.pathname.endsWith("/")) login = new URL(`${login.href}/`);
  const door: Door = { url: values.door ?? process.env.ALIQUOT_DOOR ?? "http://127.0.0.1:3000", token };
  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) usage();
  const doorBase = door.url.endsWith("/") ? door.url : `${door.url}/`;
  const links = values.links ? (values.links.endsWith("/") ? values.links : `${values.links}/`) : doorBase;
  const log = (line: string) => void process.stderr.write(`${line}\n`);
  const handle = teamsDoor({
    ask: (input, opts) => ask(door, input, { ...opts, timeoutMs: timeout * 1000 }),
    stop: (runId, user) => stop(door, runId, user),
    connector: botConnector(login, tenant, appId, secret),
    tenant,
    log,
    recordLink: (url) => (url.startsWith(doorBase) ? links + url.slice(doorBase.length) : url),
  });
  const server = serveMessages({ verify: botVerifier(openid, appId), onActivity: (a) => void handle(a), log });
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(listen[2]), listen[1]!.replace(/^\[|\]$/g, ""), () => resolve());
  });
  try {
    await listening;
  } catch (err) {
    return fail(`cannot listen on ${values.listen}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const port = (server.address() as { port: number }).port;
  log(`[teams] answering through the door at ${door.url}`);
  log(`[teams] listening on http://${listen[1]}:${port}/api/messages`);
  await new Promise<void>((resolve) => {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => server.close(() => resolve()));
  });
  return 0;
}

async function viaDoor(command: "ask" | "acp" | "mcp", words: readonly string[]): Promise<number> {
  // From the environment only, never a flag, so the token stays out of argv and ps.
  const door: Door = { url: values.door ?? process.env.ALIQUOT_DOOR ?? "http://127.0.0.1:3000", token: process.env[SURFACE_TOKEN_ENV] || null };
  const user = values.user ?? process.env.ALIQUOT_USER;
  const ceiling = values.ceiling;
  const timeout = Number(values.timeout);
  if (!user || (ceiling !== undefined && !isDataClass(ceiling)) || !Number.isFinite(timeout) || timeout <= 0) usage();
  if (command === "acp" || command === "mcp") {
    if (words.length || values.json) usage();
    const serve = command === "acp" ? acpAgent : mcpServer;
    const handle = serve({
      ask: (input, opts) => ask(door, input, { ...opts, timeoutMs: timeout * 1000 }),
      stop: (runId) => stop(door, runId, user),
      write: (line) => process.stdout.write(`${line}\n`),
      user,
      ...(ceiling && isDataClass(ceiling) ? { ceiling } : {}),
    });
    // Not awaited per line, so a cancel is read while its prompt runs. When the client closes stdin, calls in flight
    // still answer before the process exits; a client that will not wait sends SIGTERM.
    const inFlight = new Set<Promise<void>>();
    for await (const line of createInterface({ input: process.stdin })) {
      const p = handle(line).catch((err) => void process.stderr.write(`[${command}] ${err instanceof Error ? err.message : String(err)}\n`));
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    }
    await Promise.all(inFlight);
    return 0;
  }
  const text = words.length === 1 && words[0] === "-" ? readFileSync(0, "utf8").trim() : words.join(" ").trim();
  if (!text) usage();
  const thread = values.thread ?? `cli-${process.pid}-${Date.now()}`;
  const out = (e: DoorEvent) => {
    if (values.json) return process.stdout.write(`${JSON.stringify(e)}\n`);
    if (e.t === "started") process.stderr.write(`run ${e.runId}\n`);
    else if (e.t === "tool") process.stderr.write(`  ${e.tool}\n`);
    else if (e.t === "refused") process.stdout.write(`Not sent: ${e.message}\n`);
    else if (e.t === "choose") process.stdout.write(`${e.message}\nAsk again in the chat page or in Slack to pick one, or name the topic more plainly.\n`);
    else if (e.refusal) process.stdout.write(`${e.refusal}\nrecord  ${e.recordUrl}\n`);
    else if (e.withheld) {
      const byCeiling = ceiling !== undefined && isDataClass(ceiling) && (e.cls === null || rank(e.cls) > rank(ceiling));
      process.stdout.write(`The answer is ${e.cls ?? "unclassed"}, above ${byCeiling ? `--ceiling ${ceiling}` : "what this surface may show"}. Read it in the record.\nrecord  ${e.recordUrl}\n`);
    } else process.stdout.write(`${e.answer ?? `(no answer; the run ended ${e.outcome})`}\n\nrecord  ${e.recordUrl}\n`);
  };
  let last: DoorEvent | undefined;
  try {
    for await (const e of ask(door, { thread, message: `${thread}-${Date.now()}`, text, user }, { ...(ceiling && isDataClass(ceiling) ? { ceiling } : {}), timeoutMs: timeout * 1000 })) {
      out(e);
      last = e;
    }
  } catch (err) {
    if (!(err instanceof DoorError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  return last?.t === "finished" && !last.refusal && last.outcome === "answered" ? 0 : 1;
}

async function init(): Promise<number> {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  const fail = (line: string) => process.stderr.write(`${line}\n`);
  const labPath = resolve(values.config ?? "config/lab.toml");
  const envPath = resolve(values.env);
  if (existsSync(labPath) && !values.force) {
    fail(`${labPath} already exists. Pass --force to replace it.`);
    return 2;
  }
  if (!existsSync(dirname(labPath))) {
    fail(`${dirname(labPath)} does not exist. Create it first (mkdir -p ${dirname(labPath)}).`);
    return 2;
  }
  const writeEnv = !existsSync(envPath);
  const keyPath = values["anchor-key"] === undefined ? null : resolve(values["anchor-key"]);
  if (keyPath && existsSync(keyPath)) {
    fail(`${keyPath} already exists. init never replaces an anchor key: the anchors it signed verify only against it.`);
    return 2;
  }
  const targets = [labPath, ...(writeEnv ? [envPath] : []), ...(keyPath ? [keyPath] : [])];
  if (!targets.every((t) => process.permission!.has("fs.write", t))) {
    fail(`init writes ${targets.slice(0, -1).join(", ")}${targets.length > 1 ? " and " : ""}${targets.at(-1)}, and this process may not. Run it with write access to exactly those paths:`);
    fail(`  node ${PERMISSION_FLAGS.join(" ")} ${targets.map((t) => `--allow-fs-write=${t}`).join(" ")} packages/core/bin/aliquot.ts init${process.argv.slice(2).filter((a) => a !== "init").map((a) => ` ${a}`).join("")}`);
    return 2;
  }

  let answers;
  if (values.yes) {
    const campus = values.campus === undefined ? null : parseCampus(values.campus);
    if (campus === undefined) {
      fail(`--campus ${values.campus} is not a campus; the campuses are ${Object.keys(OFFERED_CAMPUSES).join(", ")} or none.`);
      return 2;
    }
    const r = defaultAnswers(values.pattern, values.sample, campus);
    r.lines.forEach(say);
    if (!r.answers) {
      fail("The patterns did not pass. Nothing was written.");
      return 1;
    }
    answers = r.answers;
  } else {
    const rl = createInterface({ input: process.stdin });
    const lines = rl[Symbol.asyncIterator]();
    const tty = process.stdin.isTTY;
    const ask: Prompt = async (question) => {
      if (question) process.stdout.write(tty ? question : `${question.trimEnd()}\n`);
      const next = await lines.next();
      return next.done ? null : next.value;
    };
    try {
      answers = await askAnswers(ask, say);
    } catch (err) {
      if (!(err instanceof InitAborted)) throw err;
      fail(`init stopped: ${err.message}`);
      return 1;
    } finally {
      rl.close();
    }
  }

  if (keyPath) {
    writeFileSync(keyPath, newAnchorKeyPem(), { flag: "wx", mode: 0o600 });
    say(`Wrote ${keyPath}, the anchor key (mode 600). Set ${ANCHOR_KEY_ENV}=${keyPath} for the worker and aliquot anchor, and keep a copy offline.`);
  }
  writeFileSync(labPath, renderLabToml(answers, keyPath ? (values["anchor-log"] ?? "anchors.log") : null), { flag: values.force ? "w" : "wx" });
  say(`Wrote ${labPath}`);
  if (writeEnv) {
    writeFileSync(envPath, renderEnv(answers.sandboxImage !== null), { flag: "wx", mode: 0o600 });
    say(`Wrote ${envPath} with new POSTGRES_PASSWORD, LABH_PAYLOAD_KEY, PAYLOAD_SECRET, ALIQUOT_ACP_TOKEN and ALIQUOT_STUDIO_TOKEN (mode 600). Keep a copy of LABH_PAYLOAD_KEY offline.`);
  } else {
    say(`Left ${envPath} as it is. It holds LABH_PAYLOAD_KEY, and a new key would make every stored payload unreadable.`);
    for (const hint of surfaceTokenHints(readFileSync(envPath, "utf8"), envPath)) say(hint);
  }
  return 0;
}

const configPath = values.config ?? "lab.toml";
const configRefused = await configProblem(configPath);
if (configRefused) {
  process.stderr.write(`${configRefused}\n`);
  process.exit(2);
}

/** One line in place of a pg stack trace, naming the database without its password. */
function databaseProblem(err: unknown, url: string): string {
  let where = "the database";
  try {
    const u = new URL(url);
    where = `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {}
  const code = (err as { code?: string }).code;
  if (code === "ECONNREFUSED") return `cannot reach Postgres at ${where}. Is it running? (docker compose up -d postgres)`;
  if (code === "3D000") return `Postgres at ${where} has no such database`;
  if (code === "28P01") return `Postgres at ${where} refused the password`;
  return `database error at ${where}: ${err instanceof Error ? err.message : String(err)}`;
}

let url: string;
let config: LabConfig;
try {
  config = await loadConfig(configPath);
  url = databaseUrlFromEnv(config);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

if (command === "anchor" || command === "verify") process.exit(await anchors(command, config));

/** aliquot anchor and aliquot verify. Exit 0 ok, 2 setup, 3 a chain or an anchor does not hold. */
async function anchors(command: "anchor" | "verify", config: LabConfig): Promise<number> {
  const fail = (line: string) => (process.stderr.write(`${line}\n`), 2);
  const say = (line: string) => void process.stdout.write(`${line}\n`);
  const anchor = config.anchor;
  if ((command === "anchor" || values.anchors) && !anchor) return fail(`${configPath} has no [anchor] table. Add [anchor] path = "anchors.log" to say where the anchor log lives.`);
  const keyFile = process.env[ANCHOR_KEY_ENV];
  if (command === "anchor" || (values.anchors && !values["public-key"])) {
    if (!keyFile) return fail(`${ANCHOR_KEY_ENV} is not set. It names the file holding the anchor key, which aliquot init --anchor-key writes${command === "verify" ? "; or pass --public-key" : ""}.`);
  }
  if (command === "anchor" && !process.permission!.has("fs.write", anchor!.path)) {
    fail(`aliquot anchor appends to ${anchor!.path}, and this process may not. Run it with write access to that file only:`);
    return fail(`  node ${PERMISSION_FLAGS.join(" ")} --allow-fs-write=${anchor!.path} packages/core/bin/aliquot.ts${process.argv.slice(2).map((a) => ` ${a}`).join("")}`);
  }
  let key;
  try {
    key = command === "anchor" ? loadAnchorKey(keyFile!) : values.anchors ? loadAnchorVerifyKey(values["public-key"] ?? keyFile!) : null;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const db = connect(url);
  try {
    if (command === "anchor") {
      const out = await writeAnchor(db, { path: anchor!.path, key: key! });
      say(out.line);
      for (const s of out.skipped) process.stderr.write(`run ${s.run} left out: its chain does not verify at seq ${s.seq}\n`);
      return out.skipped.length ? 3 : 0;
    }
    let broken = false;
    const rows = await loadAudit(db);
    const auditBad = verifyAudit(rows);
    say(auditBad === null ? `audit: ${rows.length} rows, chain intact` : `audit: chain broken at seq ${auditBad}`);
    broken ||= auditBad !== null;
    const runIds = (await db.query<{ run_id: RunId }>("select distinct run_id from run_events order by run_id")).rows.map((r) => r.run_id);
    const badRuns: string[] = [];
    for (const id of runIds) {
      const bad = verifyChain(await loadEvents(db, id));
      if (bad !== null) badRuns.push(`run ${id}: chain broken at seq ${bad}`);
    }
    say(badRuns.length ? badRuns.join("\n") : `runs: ${runIds.length}, every chain intact`);
    broken ||= badRuns.length > 0;
    if (values.anchors) {
      const text = existsSync(anchor!.path) ? readFileSync(anchor!.path, "utf8") : "";
      if (!text.trim()) return fail(`${anchor!.path} holds no anchors yet. Run aliquot anchor, or start the worker with [anchor] set.`);
      const report = await verifyAnchors(db, text, key!);
      const n = `${report.lines} line${report.lines === 1 ? "" : "s"}`;
      if (!report.problems.length) say(`anchors: ${n}, every signature valid, the database matches through audit seq ${report.auditThrough ?? "none"} and ${report.runsChecked} anchored runs`);
      else {
        say(`anchors: ${n}, ${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}, oldest first:`);
        for (const p of report.problems) say(`  ${describeAnchorProblem(p)}`);
        broken = true;
      }
    }
    return broken ? 3 : 0;
  } catch (err) {
    if (err instanceof AnchorRefused) return (process.stderr.write(`${err.message}\n`), 3);
    return fail(databaseProblem(err, url));
  } finally {
    await db.end().catch(() => {});
  }
}

/** Thrown for a setup problem the steward commands report in one line, such as a key that is not set. */
class Setup extends Error {}

async function steward(db: Db): Promise<number> {
  const say = (line = "") => void process.stdout.write(`${line}\n`);
  const actor = `cli:${process.env.USER ?? "operator"}`;
  const open = async () => {
    try {
      return await openPayloadStore(db, config);
    } catch (err) {
      if ((err as { code?: string }).code) throw err;
      throw new Setup(err instanceof Error ? err.message : String(err));
    }
  };
  const asOf = values["as-of"] ? new Date(values["as-of"]) : new Date();
  if (Number.isNaN(asOf.getTime())) throw new Setup(`--as-of ${values["as-of"]} is not a date (use YYYY-MM-DD)`);
  const retention = config.retention;
  const windows = retentionWindows(retention);
  const windowLine = () => {
    const per = (m: Readonly<Partial<Record<string, number>>>) => {
      const set = Object.entries(m);
      return set.length === 5 && new Set(set.map(([, d]) => d)).size === 1 ? `${set[0]![1]} days for every class` : set.map(([cls, d]) => `${cls} ${d} days`).join(", ");
    };
    const floor = Object.keys(retention.keepMinDays).length ? `; floor (keep_min_days) ${per(retention.keepMinDays)}, and events and chains are never deleted` : "";
    if (!Object.keys(windows).length) return `retention: no purge is set ([policy.retention] purge_payload_after_days), so every body is kept${floor}`;
    return `retention: bodies purge ${per(windows)} after the last run that names them${floor}${values["as-of"] ? `; judged as of ${asOf.toISOString().slice(0, 10)}` : ""}`;
  };
  const held = heldKeyIds(config);
  if (command === "keys" && runId === "env") {
    for (const k of await keyStatus(db, config, held)) say(`${k.id} ${k.env ?? "-"} ${k.stored}`);
    return 0;
  }
  if (command === "keys" && runId === "status") {
    const keys = await keyStatus(db, config, held);
    const past = await pastRetention(db, retention, asOf);
    if (values.json) return say(JSON.stringify({ keys, retention: { ...retention, past: past.length, runs: new Set(past.flatMap((p) => p.runs)).size } }, null, 2)), 0;
    const w = Math.max(3, ...keys.map((k) => k.id.length));
    const e = Math.max(3, ...keys.map((k) => (k.env ?? "(not in lab.toml)").length));
    say(`${"key".padEnd(w)}  ${"env".padEnd(e)}  held  ${"writes".padEnd(10)}  bodies  to move`);
    for (const k of keys) say(`${k.id.padEnd(w)}  ${(k.env ?? "(not in lab.toml)").padEnd(e)}  ${(k.held ? "yes" : "no").padEnd(4)}  ${(k.writes.join(", ") || "-").padEnd(10)}  ${String(k.stored).padStart(6)}  ${String(k.toMove).padStart(7)}`);
    const toMove = keys.reduce((n, k) => n + k.toMove, 0);
    say();
    say(toMove ? `${toMove} ${toMove === 1 ? "body waits" : "bodies wait"} for aliquot keys reencrypt, which moves each to its class's key.` : "Every body is under its class's key.");
    for (const k of keys.filter((k) => !k.held && k.stored)) say(`${k.id} holds ${k.stored} ${k.stored === 1 ? "body" : "bodies"} this process cannot read: ${k.env ? `${k.env} is not set here` : "lab.toml no longer names it"}.`);
    say(windowLine());
    if (Object.keys(windows).length) say(past.length ? `${past.length} ${past.length === 1 ? "body" : "bodies"} from ${new Set(past.flatMap((p) => p.runs)).size} runs ${past.length === 1 ? "is" : "are"} past the window; aliquot retention --dry-run lists them.` : "Nothing is past the window.");
    return 0;
  }
  if (command === "keys" && runId === "rotate") {
    const { keyring } = await open();
    await recordRotation(db, keyring, actor);
    const keys = await keyStatus(db, config, held);
    const kept = (await db.query<{ key_id: string }>("select key_id from payload_keys order by key_id")).rows.map((r) => r.key_id);
    say(`${keyring.current} is current: new payloads go under it once the worker and the web door restart.`);
    say(`The lab's address key is kept under ${kept.join(", ")}, so an old key can be removed once it holds no bodies. Payload hashes do not change.`);
    say("A rotation does not re-key the address key, which keeps a guessed body from being confirmed against its hash: anyone who held an old key can still compute addresses.");
    say("Old ciphertext stays in Postgres dead rows until VACUUM reclaims them, in WAL segments until they are recycled, and in every backup taken before the re-encrypt.");
    const toMove = keys.reduce((n, k) => n + k.toMove, 0);
    say(toMove ? `${toMove} ${toMove === 1 ? "body is" : "bodies are"} under another key and stay readable while that key is set. Next: aliquot keys reencrypt.` : "Every body is already under its class's key.");
    return 0;
  }
  if (command === "keys" && runId === "reencrypt") {
    const batch = Number(values.batch);
    if (!Number.isInteger(batch) || batch < 1 || batch > 10_000) usage();
    const { store, keyring } = await open();
    const moved = await reencryptAll(db, store, keyring, actor, batch, (n) => say(`  re-encrypted ${n}`));
    const keys = await keyStatus(db, config, held);
    say(`Re-encrypted ${moved} ${moved === 1 ? "body" : "bodies"}. Hashes, classes and sizes are unchanged.`);
    for (const k of keys) say(`  ${k.id}: ${k.stored} ${k.stored === 1 ? "body" : "bodies"}${k.writes.length ? ` (writes ${k.writes.join(", ")})` : ""}`);
    const stuck = keys.filter((k) => k.toMove > 0);
    for (const k of stuck) say(`${k.id} still holds ${k.toMove} ${k.toMove === 1 ? "body" : "bodies"} this process cannot move: it needs both ${k.id} and the target key.`);
    for (const k of keys.filter((k) => k.stored === 0 && k.writes.length === 0)) say(`${k.id} holds no bodies. Remove it from [store.keys] and unset ${k.env ?? "its env var"} when every process has restarted.`);
    return stuck.length ? 1 : 0;
  }
  if (command === "retention") {
    say(windowLine());
    if (values.apply) {
      const { redacted, replies, audit } = await sweepRetention(db, retention, asOf, actor);
      const runs = [...new Set(redacted.flatMap((c) => c.runs))] as RunId[];
      say(`Redacted ${redacted.length} ${redacted.length === 1 ? "body" : "bodies"} (${redacted.reduce((n, c) => n + c.bytes, 0)} bytes) from ${runs.length} runs, and cleared ${replies} door ${replies === 1 ? "reply" : "replies"}. Each body keeps its hash, class and size; audit event ${audit.seq}.`);
      const broken = await brokenChains(db, runs);
      say(broken.length ? `CHAIN BROKEN in ${broken.join(", ")}` : `Every chain still verifies: ${runs.length} runs checked.`);
      return broken.length ? 3 : 0;
    }
    const past = await pastRetention(db, retention, asOf);
    if (!past.length) return say("Nothing is past the window."), 0;
    const byRun = new Map<string, typeof past>();
    for (const c of past) for (const r of c.runs) byRun.set(r, [...(byRun.get(r) ?? []), c]);
    say(`Would redact ${past.length} ${past.length === 1 ? "body" : "bodies"} (${past.reduce((n, c) => n + c.bytes, 0)} bytes) from ${byRun.size} runs:`);
    for (const [run, cs] of byRun) say(`  run ${run}  last used ${cs.reduce((a, c) => (c.lastUsed > a ? c.lastUsed : a), "").slice(0, 10)}  ${cs.length} ${cs.length === 1 ? "body" : "bodies"} (${[...new Set(cs.map((c) => c.cls))].join(", ")})`);
    say("Nothing was changed. aliquot retention --apply redacts them.");
    return 0;
  }
  return usage();
}

const db = connect(url);
try {
  if (command === "keys" || command === "retention") process.exitCode = await steward(db);
  else await records();
} catch (err) {
  process.stderr.write(`${err instanceof Setup ? err.message : databaseProblem(err, url)}\n`);
  process.exitCode = 2;
} finally {
  await db.end().catch(() => {});
}

async function records(): Promise<void> {
  const ids = command === "record" ? [runId as RunId] : await recentRunIds(db, limit);
  const held = heldKeyIds(config);
  const views = [];
  for (const id of ids) {
    const events = await loadEvents(db, id);
    if (events.length) views.push(command === "record" ? await recordViewOf(db, id, events, held) : recordView(id, events));
  }
  if (command === "record" && !views.length) {
    process.stderr.write(`no run ${runId} in this database\n`);
    process.exitCode = 1;
  } else {
    const out = values.json ? JSON.stringify(command === "record" ? views[0] : views, null, 2) : command === "record" ? formatRecordView(views[0]!) : formatRunList(views);
    process.stdout.write(`${out}\n`);
    if (views.some((v) => v.chain.firstBad !== null)) process.exitCode = 3;
  }
}
