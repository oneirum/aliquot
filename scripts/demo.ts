#!/usr/bin/env node
/**
 * pnpm demo: the synthetic lab0 lab, running, in one command. Seeds a fresh
 * database, compiles and publishes the lab0 handbook, starts the worker and
 * the web door, and prints the chat page URL with two questions to try.
 *
 * The agent's model is a scripted fake declared as a hosted, zero-retention
 * endpoint (ceiling D1), so a message with a participant id is refused at the
 * egress check. The fake searches, reads the top entry and quotes it: it
 * shows the harness, not answer quality.
 *
 *   node scripts/demo.ts [--port 3000] [--studio]
 */

import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { ensurePostgres, processes, waitLine } from "./procs.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: process.env.LABH_DEMO_PORT ?? "3000" }, studio: { type: "boolean", default: false } } });
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".demo");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const kbDir = join(work, "kb");
cpSync(join(root, "fixtures/lab0"), kbDir, { recursive: true });
const restricted = (JSON.parse(readFileSync(join(kbDir, "questions.json"), "utf8")) as { restricted: { pattern: string; message: string } }).restricted;

const step = (line: string) => console.log(`  ${line}`);
console.log("\nAliquot demo: the synthetic lab0 lab\n");

await ensurePostgres(root);
const { url: dbUrl } = await freshDatabase("labh_demo");
step("database labh_demo created");

const compiler = await startFakeModel("scripted-1", "compile");
const agentModel = await startFakeModel("hosted-demo-1", "cite");

const baseAgent = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
const agentPath = join(work, "agent.json");
writeFileSync(
  agentPath,
  JSON.stringify(
    {
      ...baseAgent,
      agentId: "lab0-handbook",
      name: "Lab0 handbook",
      instructions: "You answer lab members' practical questions from the lab0 handbook. Search, read the best entry, answer from it and end with 'Source: <path>'.",
      knowledgeBases: ["lab0-handbook"],
      ceiling: "D1",
      model: { endpointId: "hosted", modelId: "hosted-demo-1", params: { temperature: 0, maxOutputTokens: 256 } },
    },
    null,
    2,
  ),
);

const cfg = join(work, "lab.toml");
writeFileSync(
  cfg,
  [
    "[database]",
    'url_env = "DATABASE_URL"',
    "[store]",
    'placement = "lab"',
    'key_env = "LABH_PAYLOAD_KEY"',
    "[endpoints.local]",
    `base_url = "${compiler.url}"`,
    'placement = "lab"',
    "# The demo's agent model: a scripted fake standing in for a hosted, zero-retention vendor (ceiling D1).",
    "[endpoints.hosted]",
    `base_url = "${agentModel.url}"`,
    'placement = "zdr"',
    "[surfaces.web]",
    'placement = "lab"',
    `port = ${Number(values.port)}`,
    "[policy]",
    'review_confidential = "refuse"',
    `participant_id_patterns = ['${restricted.pattern}']`,
    "[agents]",
    `fixtures = ["${agentPath}"]`,
    "",
  ].join("\n"),
);

const payloadKey = randomBytes(32).toString("hex");
const ps = processes(root, work, { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: payloadKey });

ps.startWorker(cfg, "demo");
const kb = async (args: string[]) => {
  const proc = ps.start(`kb-${args[0]}`, "kb.ts", ["--config", cfg, ...args]);
  await proc.exit;
  const line = proc.out.join("").split("\n").findLast((l) => l.startsWith("{"));
  if (!line) throw new Error(`kb ${args[0]} printed no result; see ${join(work, `kb-${args[0]}.log`)}`);
  return JSON.parse(line) as { result?: { t: string; snapshot: string }; ok?: boolean };
};
const compiled = await kb(["compile", "--definition", join(kbDir, "kb.json"), "--wait", "--timeout-ms", "60000"]);
if (compiled.result?.t !== "compiled") throw new Error(`the lab0 knowledge base did not compile: ${JSON.stringify(compiled)}`);
const published = await kb(["publish", "--snapshot", compiled.result.snapshot]);
if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published)}`);
step(`knowledge base lab0-handbook compiled from 3 documents and published (snapshot ${compiled.result.snapshot.slice(0, 12)})`);

const web = ps.start("web", "web.ts", ["--config", cfg]);
const base = (await waitLine(web, /listening on (http:\/\/127\.0\.0\.1:\d+)/, 15000)).replace("listening on ", "");
step("worker and web door running");

let studio: string | null = null;
if (values.studio) {
  const port = Number(values.port) + 1;
  const proc = ps.startGroup("studio", join(root, "packages/studio/node_modules/.bin/next"), ["dev", "-H", "127.0.0.1", "-p", String(port)], join(root, "packages/studio"));
  studio = `http://127.0.0.1:${port}/admin`;
  await waitLine(proc, /Ready in/, 180_000);
  step("studio running");
}

const tries = ["Which freezer rack holds the aliquots?", restricted.message];
const chat = `${base}/?try=${tries.map(encodeURIComponent).join("|")}`;
console.log(`
Open the chat page:

  ${chat}
${studio ? `\nThe studio:\n\n  ${studio}\n` : ""}
Then try:

  1. "${tries[0]}"
     The agent searches the handbook, quotes the entry and names its path.
  2. "${tries[1]}"
     LAB0-0003 matches this lab's participant id format, so the message is D3.
     The agent's model is hosted (ceiling D1), so nothing is sent and the page says why.
  3. Click "Record" under either answer to read the run's hash-chained record.
     In a terminal, the same record:
     DATABASE_URL=${dbUrl} pnpm aliquot --config .demo/lab.toml record <run-id>

Logs are in ${work}. Press Ctrl-C to stop.
`);

await new Promise(() => {});
