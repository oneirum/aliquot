#!/usr/bin/env node
// aliquot: node --permission --allow-fs-read=* --allow-net packages/core/bin/aliquot.ts [--config lab.toml] [--json] <record <run-id> | runs [--limit n]>
import { parseArgs } from "node:util";
import { configProblem, databaseUrlFromEnv, loadConfig } from "../src/config.ts";
import { connect } from "../src/db.ts";
import { loadEvents, recentRunIds, type RunId } from "../src/record.ts";
import { formatRecordView, formatRunList, recordView } from "../src/record-view.ts";
import { requireProcessPermission, sealNetwork } from "../src/seal.ts";

const denied = requireProcessPermission();
if (denied) {
  process.stderr.write(`${denied}\n`);
  process.exit(2);
}
sealNetwork();

const USAGE = `usage: aliquot [--config lab.toml] [--json] <command>

  record <run-id>     print one run's record and check its hash chain
  runs [--limit n]    list the newest runs (default 20), each with its outcome and chain check

Exit codes: 0 ok, 1 no such run, 2 usage or setup problem, 3 a hash chain is broken.
`;

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      config: { type: "string", default: "lab.toml" },
      json: { type: "boolean", default: false },
      limit: { type: "string", default: "20" },
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
const limit = Number(values.limit);
const valid =
  extra.length === 0 &&
  ((command === "record" && !!runId && /^[0-9a-f-]{36}$/i.test(runId)) || (command === "runs" && !runId && Number.isInteger(limit) && limit > 0 && limit <= 1000));
if (!valid) usage();

const configRefused = await configProblem(values.config);
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
  url = databaseUrlFromEnv(await loadConfig(values.config));
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
