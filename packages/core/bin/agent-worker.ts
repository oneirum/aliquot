#!/usr/bin/env node
// labh agent worker: node --permission --allow-fs-read=* --allow-fs-write=<workspaces> --allow-net --allow-child-process
//   packages/core/bin/agent-worker.ts --config lab.toml --workspaces <dir> [--worker-id W] [--lease-ms 5000] [--poll-ms 200]
//   harness only (LABH_FAULTS=1): [--fault kill-after:tool.requested] [--plant-tool path/to/tool.ts ...]
//   development only, never with NODE_ENV=production: [--dev-shared-login] lets dev_shared_login backends run
import { parseArgs } from "node:util";
import { hostname } from "node:os";
import { realpathSync, writeSync } from "node:fs";
import { configProblem } from "../src/config.ts";
import { requireAgentProcessPermission, sealNetwork } from "../src/seal.ts";
import { importTool } from "../src/tools.ts";
import { faultsAllowed, parseFault } from "../src/worker.ts";
import { startAgentWorker } from "../src/agents/worker.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string", default: "lab.toml" },
    workspaces: { type: "string" },
    "worker-id": { type: "string", default: `${hostname()}:${process.pid}` },
    "lease-ms": { type: "string", default: "5000" },
    "poll-ms": { type: "string", default: "200" },
    "inbox-poll-ms": { type: "string", default: "1000" },
    fault: { type: "string" },
    "plant-tool": { type: "string", multiple: true, default: [] },
    "dev-shared-login": { type: "boolean", default: false },
  },
});

if (!values.workspaces) {
  process.stderr.write("--workspaces <dir> is required: the directory session workspaces are created under\n");
  process.exit(2);
}
let workspaces: string;
try {
  workspaces = realpathSync(values.workspaces);
} catch {
  process.stderr.write(`--workspaces ${values.workspaces} does not exist\n`);
  process.exit(2);
}
const denied = requireAgentProcessPermission(workspaces);
if (denied) {
  process.stderr.write(`${denied}\n`);
  process.exit(2);
}

if ((values.fault || values["plant-tool"].length) && !faultsAllowed(process.env)) {
  process.stderr.write(process.env.NODE_ENV === "production" ? "--fault and --plant-tool are never in production\n" : "--fault and --plant-tool need LABH_FAULTS=1, which only a test harness sets\n");
  process.exit(2);
}

if (values["dev-shared-login"] && process.env.NODE_ENV === "production") {
  process.stderr.write("--dev-shared-login is never in production: it runs agent CLIs on the operator's own login\n");
  process.exit(2);
}

const configRefused = await configProblem(values.config);
if (configRefused) {
  process.stderr.write(`${configRefused}\n`);
  process.exit(2);
}

sealNetwork();
const tools = await Promise.all(values["plant-tool"].map(importTool));

const stop = new AbortController();
process.on("SIGTERM", () => stop.abort());
process.on("SIGINT", () => stop.abort());
const log = (line: string) => writeSync(1, `[agent-worker ${values["worker-id"]}] ${line}\n`);

await startAgentWorker(values.config, {
  workerId: values["worker-id"],
  leaseMs: Number(values["lease-ms"]),
  pollMs: Number(values["poll-ms"]),
  inboxPollMs: Number(values["inbox-poll-ms"]),
  workspaces,
  devSharedLogin: values["dev-shared-login"],
  ...(values.fault ? { fault: parseFault(values.fault) } : {}),
  tools,
  signal: stop.signal,
  log,
});
