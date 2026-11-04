#!/usr/bin/env node
// labh web: node --permission --allow-fs-read=* --allow-net packages/core/bin/web.ts --config lab.toml [--port 3000] [--host 127.0.0.1]
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { boot } from "../src/boot.ts";
import { configProblem } from "../src/config.ts";
import { requireProcessPermission, sealNetwork } from "../src/seal.ts";
import { createWebHandler, listenWeb } from "../src/surfaces/web.ts";

const denied = requireProcessPermission();
if (denied) {
  process.stderr.write(`${denied}\n`);
  process.exit(2);
}
sealNetwork();

const { values } = parseArgs({ options: { config: { type: "string", default: "lab.toml" }, port: { type: "string" }, host: { type: "string", default: "127.0.0.1" } } });

const configRefused = await configProblem(values.config);
if (configRefused) {
  process.stderr.write(`${configRefused}\n`);
  process.exit(2);
}
const core = await boot(values.config);
const { server, port } = await listenWeb(createWebHandler(core.db, core.intake, (line) => console.error(line), core.config.web.channel, core.config.labName ?? hostname()), values.port ? Number(values.port) : core.config.web.port, values.host);
console.log(`[web] listening on http://${values.host}:${port}`);

const shutdown = () => {
  server.close(() => void core.close().then(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
