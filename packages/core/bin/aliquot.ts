#!/usr/bin/env node
// aliquot: node --permission --allow-fs-read=* --allow-net packages/core/bin/aliquot.ts [--config lab.toml] record <run-id>
import { parseArgs } from "node:util";
import { configProblem, databaseUrlFromEnv, loadConfig } from "../src/config.ts";
import { connect } from "../src/db.ts";
import { loadEvents, type RunId } from "../src/record.ts";
import { formatRecordView, recordView } from "../src/record-view.ts";
import { requireProcessPermission, sealNetwork } from "../src/seal.ts";

const denied = requireProcessPermission();
if (denied) {
  process.stderr.write(`${denied}\n`);
  process.exit(2);
}
sealNetwork();

const USAGE = "usage: aliquot [--config lab.toml] record <run-id>\n";
const { values, positionals } = parseArgs({ options: { config: { type: "string", default: "lab.toml" }, help: { type: "boolean", short: "h", default: false } }, allowPositionals: true });
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const [command, runId] = positionals;
if (command !== "record" || !runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
  process.stderr.write(USAGE);
  process.exit(2);
}
const configRefused = await configProblem(values.config);
if (configRefused) {
  process.stderr.write(`${configRefused}\n`);
  process.exit(2);
}

const db = connect(databaseUrlFromEnv(await loadConfig(values.config)));
try {
  const events = await loadEvents(db, runId as RunId);
  if (!events.length) {
    process.stderr.write(`no run ${runId} in this database\n`);
    process.exitCode = 1;
  } else {
    const view = recordView(runId, events);
    process.stdout.write(`${formatRecordView(view)}\n`);
    if (view.chain.firstBad !== null) process.exitCode = 3;
  }
} finally {
  await db.end();
}
