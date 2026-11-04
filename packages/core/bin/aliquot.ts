#!/usr/bin/env node
// aliquot: node --permission --allow-fs-read=* --allow-net packages/core/bin/aliquot.ts [--config lab.toml] [--json] <record <run-id> | runs [--limit n]>
// aliquot init also needs --allow-fs-write for the two files it writes, and for nothing else (pnpm aliquot:init).
// aliquot ask and aliquot acp need no lab.toml or database: they reach the web door named by --door, and only it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { configProblem, databaseUrlFromEnv, loadConfig } from "../src/config.ts";
import { connect } from "../src/db.ts";
import { acpTokenHint, askAnswers, defaultAnswers, InitAborted, renderEnv, renderLabToml, type Prompt } from "../src/init.ts";
import { loadEvents, recentRunIds, type RunId } from "../src/record.ts";
import { formatRecordView, formatRunList, recordView } from "../src/record-view.ts";
import { DEFAULT_ALLOWANCE, PERMISSION_FLAGS, requireProcessPermission, sealNetwork } from "../src/seal.ts";
import { acpAgent } from "../src/acp.ts";
import { ask, DoorError, isDataClass, stop, SURFACE_TOKEN_ENV, type Door, type DoorEvent } from "../src/door-client.ts";
import { rank } from "../src/dataclass.ts";

const denied = requireProcessPermission();
if (denied) {
  process.stderr.write(`${denied}\n`);
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
// The door client is the one file this binary adds to the seal: it reaches the web door over HTTP.
sealNetwork({ ...DEFAULT_ALLOWANCE, files: [...DEFAULT_ALLOWANCE.files, join(here, "..", "src", "door-client.ts")] });

const USAGE = `usage: aliquot [--config lab.toml] [--json] <command>

  record <run-id>     print one run's record and check its hash chain
  runs [--limit n]    list the newest runs (default 20), each with its outcome and chain check
  ask [--door url] [--user id] [--thread id] [--ceiling D0..D3] [--timeout s] <question... | ->
                      ask a question through the web door, as the chat page does; - reads it from stdin.
                      --json prints one JSON line per event: started, tool, finished, refused
  acp [--door url] [--user id] [--ceiling D0..D3]
                      speak the Agent Client Protocol on stdin and stdout, for T3 Code, Zed and other ACP clients
                      --door defaults to $ALIQUOT_DOOR, else http://127.0.0.1:3000; --user to $ALIQUOT_USER
                      $ALIQUOT_SURFACE_TOKEN names the surface ask and acp speak as, such as [surfaces.acp];
                      without it they speak as the web surface. The door withholds any answer above that
                      surface's placement. --ceiling is a stricter promise on this side, for a client that keeps a copy.
  init [--config config/lab.toml] [--env .env] [--force] [--yes --sample <id>... [--pattern <regex>...]]
                      write lab.toml from a few questions, testing the participant id patterns against
                      sample ids, and write .env with new secrets when it does not exist yet. --force
                      replaces lab.toml, never .env. --yes takes every default and needs --sample.
                      Run it as pnpm aliquot:init, which allows writes to config/lab.toml and .env only.

Exit codes: 0 ok, 1 no such run, init found no pattern that passes, or ask was refused or got no answer,
2 usage or setup problem (ask: the door could not be reached), 3 a hash chain is broken.
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
      door: { type: "string" },
      user: { type: "string" },
      thread: { type: "string" },
      ceiling: { type: "string" },
      timeout: { type: "string", default: "180" },
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
  if (runId !== undefined || values.json || (!values.yes && (values.pattern.length || values.sample.length)) || (values.yes && !values.sample.length)) usage();
  process.exit(await init());
}
if (command === "ask" || command === "acp") process.exit(await viaDoor(command, positionals.slice(1)));
const limit = Number(values.limit);
const initOnly = values.force || values.yes || values.pattern.length > 0 || values.sample.length > 0;
const valid =
  extra.length === 0 &&
  !initOnly &&
  ((command === "record" && !!runId && /^[0-9a-f-]{36}$/i.test(runId)) || (command === "runs" && !runId && Number.isInteger(limit) && limit > 0 && limit <= 1000));
if (!valid) usage();

async function viaDoor(command: "ask" | "acp", words: readonly string[]): Promise<number> {
  // From the environment only, never a flag, so the token stays out of argv and ps.
  const door: Door = { url: values.door ?? process.env.ALIQUOT_DOOR ?? "http://127.0.0.1:3000", token: process.env[SURFACE_TOKEN_ENV] || null };
  const user = values.user ?? process.env.ALIQUOT_USER;
  const ceiling = values.ceiling;
  const timeout = Number(values.timeout);
  if (!user || (ceiling !== undefined && !isDataClass(ceiling)) || !Number.isFinite(timeout) || timeout <= 0) usage();
  if (command === "acp") {
    if (words.length || values.json) usage();
    const handle = acpAgent({
      ask: (input, opts) => ask(door, input, { ...opts, timeoutMs: timeout * 1000 }),
      stop: (runId) => stop(door, runId, user),
      write: (line) => process.stdout.write(`${line}\n`),
      user,
      ...(ceiling && isDataClass(ceiling) ? { ceiling } : {}),
    });
    // Not awaited per line, so a session/cancel is read while its prompt runs.
    for await (const line of createInterface({ input: process.stdin })) void handle(line).catch((err) => process.stderr.write(`[acp] ${err instanceof Error ? err.message : String(err)}\n`));
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
  const targets = writeEnv ? [labPath, envPath] : [labPath];
  if (!targets.every((t) => process.permission!.has("fs.write", t))) {
    fail(`init writes ${targets.join(" and ")}, and this process may not. Run it with write access to exactly those paths:`);
    fail(`  node ${PERMISSION_FLAGS.join(" ")} ${targets.map((t) => `--allow-fs-write=${t}`).join(" ")} packages/core/bin/aliquot.ts init${process.argv.slice(2).filter((a) => a !== "init").map((a) => ` ${a}`).join("")}`);
    return 2;
  }

  let answers;
  if (values.yes) {
    const r = defaultAnswers(values.pattern, values.sample);
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

  writeFileSync(labPath, renderLabToml(answers), { flag: values.force ? "w" : "wx" });
  say(`Wrote ${labPath}`);
  if (writeEnv) {
    writeFileSync(envPath, renderEnv(answers.sandboxImage !== null), { flag: "wx", mode: 0o600 });
    say(`Wrote ${envPath} with new POSTGRES_PASSWORD, LABH_PAYLOAD_KEY, PAYLOAD_SECRET and ALIQUOT_ACP_TOKEN (mode 600). Keep a copy of LABH_PAYLOAD_KEY offline.`);
  } else {
    say(`Left ${envPath} as it is. It holds LABH_PAYLOAD_KEY, and a new key would make every stored payload unreadable.`);
    const hint = acpTokenHint(readFileSync(envPath, "utf8"), envPath);
    if (hint) say(hint);
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
try {
  url = databaseUrlFromEnv(await loadConfig(configPath));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

const db = connect(url);
try {
  const ids = command === "record" ? [runId as RunId] : await recentRunIds(db, limit);
  const views = [];
  for (const id of ids) {
    const events = await loadEvents(db, id);
    if (events.length) views.push(recordView(id, events));
  }
  if (command === "record" && !views.length) {
    process.stderr.write(`no run ${runId} in this database\n`);
    process.exitCode = 1;
  } else {
    const out = values.json ? JSON.stringify(command === "record" ? views[0] : views, null, 2) : command === "record" ? formatRecordView(views[0]!) : formatRunList(views);
    process.stdout.write(`${out}\n`);
    if (views.some((v) => v.chain.firstBad !== null)) process.exitCode = 3;
  }
} catch (err) {
  process.stderr.write(`${databaseProblem(err, url)}\n`);
  process.exitCode = 2;
} finally {
  await db.end().catch(() => {});
}
