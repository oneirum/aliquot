#!/usr/bin/env node
// labh worker: node --permission --allow-fs-read=* --allow-net packages/core/bin/worker.ts --config lab.toml [--worker-id W] [--lease-ms 5000] [--poll-ms 200]
//   harness only (LABH_FAULTS=1): [--fault kill-after:tool.requested] [--plant-tool path/to/tool.ts ...]
import { parseArgs } from "node:util";
import { configProblem, loadConfig } from "../src/config.ts";
import { ANCHOR_KEY_ENV, loadAnchorKey, type AnchorSigner } from "../src/anchor.ts";
import { hostname } from "node:os";
import { writeSync } from "node:fs";
import { PERMISSION_FLAGS, requireProcessPermission, sealNetwork } from "../src/seal.ts";
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
// [anchor] set means the lab relies on anchors, so a worker that cannot write them refuses to start rather than run without.
const anchorConfig = (await loadConfig(values.config)).anchor;
let anchor: { signer: AnchorSigner; everyMs: number } | undefined;
if (anchorConfig) {
  const keyFile = process.env[ANCHOR_KEY_ENV];
  const refuse = (line: string): never => {
    process.stderr.write(`lab.toml [anchor] is set, but ${line}\n`);
    process.exit(2);
  };
  if (!keyFile) refuse(`${ANCHOR_KEY_ENV} is not set; it names the anchor key's file, which aliquot init --anchor-key writes`);
  if (!process.permission!.has("fs.write", anchorConfig.path))
    refuse(`this worker may not append to ${anchorConfig.path}. Start it with: node ${PERMISSION_FLAGS.join(" ")} --allow-fs-write=${anchorConfig.path} packages/core/bin/worker.ts ...`);
  try {
    anchor = { signer: { path: anchorConfig.path, key: loadAnchorKey(keyFile!) }, everyMs: anchorConfig.everyMinutes * 60_000 };
  } catch (err) {
    refuse(err instanceof Error ? err.message : String(err));
  }
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
  ...(anchor ? { anchor } : {}),
  signal: stop.signal,
  log,
});
