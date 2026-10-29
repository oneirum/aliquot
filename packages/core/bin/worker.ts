#!/usr/bin/env node
// labh worker: node --permission --allow-fs-read=* --allow-net packages/core/bin/worker.ts --config lab.toml [--worker-id W] [--lease-ms 5000] [--poll-ms 200]
//   harness only (LABH_FAULTS=1): [--fault kill-after:tool.requested] [--plant-tool path/to/tool.ts ...]
import { parseArgs } from "node:util";
import { configProblem } from "../src/config.ts";
import { hostname } from "node:os";
import { writeSync } from "node:fs";
import { requireProcessPermission, sealNetwork } from "../src/seal.ts";
import { importTool } from "../src/tools.ts";
import { faultsAllowed, parseFault, startWorker } from "../src/worker.ts";

const denied = requireProcessPermission();
if (denied) {
  process.stderr.write(`${denied}\n`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    config: { type: "string", default: "lab.toml" },
    "worker-id": { type: "string", default: `${hostname()}:${process.pid}` },
    "lease-ms": { type: "string", default: "5000" },
    "poll-ms": { type: "string", default: "200" },
    fault: { type: "string" },
    "plant-tool": { type: "string", multiple: true, default: [] },
  },
});

if ((values.fault || values["plant-tool"].length) && !faultsAllowed(process.env)) {
  process.stderr.write(process.env.NODE_ENV === "production" ? "--fault and --plant-tool are never in production\n" : "--fault and --plant-tool need LABH_FAULTS=1, which only a test harness sets\n");
  process.exit(2);
}

const configRefused = await configProblem(values.config);
if (configRefused) {
  process.stderr.write(`${configRefused}\n`);
  process.exit(2);
}
// Sealed before any tool is imported, so a tool that takes fetch at its top level takes the stub.
sealNetwork();
const tools = await Promise.all(values["plant-tool"].map(importTool));

const stop = new AbortController();
process.on("SIGTERM", () => stop.abort());
process.on("SIGINT", () => stop.abort());
// Synchronous so a line written just before a fault-injected SIGSTOP or SIGKILL still reaches the reader.
const log = (line: string) => writeSync(1, `[worker ${values["worker-id"]}] ${line}\n`);

await startWorker(values.config, {
  workerId: values["worker-id"],
  leaseMs: Number(values["lease-ms"]),
  pollMs: Number(values["poll-ms"]),
  ...(values.fault ? { fault: parseFault(values.fault) } : {}),
  tools,
  signal: stop.signal,
  log,
});
