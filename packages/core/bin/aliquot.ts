#!/usr/bin/env node
// aliquot: node --permission --allow-fs-read=* --allow-net packages/core/bin/aliquot.ts [--config lab.toml] [--json] <record <run-id> | runs [--limit n]>
// aliquot init also needs --allow-fs-write for the two files it writes, and for nothing else (pnpm aliquot:init).
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { configProblem, databaseUrlFromEnv, loadConfig } from "../src/config.ts";
import { connect } from "../src/db.ts";
import { askAnswers, defaultAnswers, InitAborted, renderEnv, renderLabToml, type Prompt } from "../src/init.ts";
import { loadEvents, recentRunIds, type RunId } from "../src/record.ts";
import { formatRecordView, formatRunList, recordView } from "../src/record-view.ts";
import { PERMISSION_FLAGS, requireProcessPermission, sealNetwork } from "../src/seal.ts";

const denied = requireProcessPermission();
if (denied) {
  process.stderr.write(`${denied}\n`);
  process.exit(2);
}
sealNetwork();

const USAGE = `usage: aliquot [--config lab.toml] [--json] <command>

  record <run-id>     print one run's record and check its hash chain
  runs [--limit n]    list the newest runs (default 20), each with its outcome and chain check
  init [--config config/lab.toml] [--env .env] [--force] [--yes --sample <id>... [--pattern <regex>...]]
                      write lab.toml from a few questions, testing the participant id patterns against
                      sample ids, and write .env with new secrets when it does not exist yet. --force
                      replaces lab.toml, never .env. --yes takes every default and needs --sample.
                      Run it as pnpm aliquot:init, which allows writes to config/lab.toml and .env only.

Exit codes: 0 ok, 1 no such run, or init found no pattern that passes, 2 usage or setup problem, 3 a hash chain is broken.
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
const limit = Number(values.limit);
const initOnly = values.force || values.yes || values.pattern.length > 0 || values.sample.length > 0;
const valid =
  extra.length === 0 &&
  !initOnly &&
  ((command === "record" && !!runId && /^[0-9a-f-]{36}$/i.test(runId)) || (command === "runs" && !runId && Number.isInteger(limit) && limit > 0 && limit <= 1000));
if (!valid) usage();

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
    say(`Wrote ${envPath} with new POSTGRES_PASSWORD, LABH_PAYLOAD_KEY and PAYLOAD_SECRET (mode 600). Keep a copy of LABH_PAYLOAD_KEY offline.`);
  } else {
    say(`Left ${envPath} as it is. It holds LABH_PAYLOAD_KEY, and a new key would make every stored payload unreadable.`);
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
