#!/usr/bin/env node
/**
 * pnpm demo:agent: a real agent CLI (Claude Code or Codex) answering lab
 * members through Aliquot, confined by the macOS seatbelt, the bridge and the
 * egress proxy. Synthetic lab0 data, declared D0 so a public placement may
 * see it. The CLI uses the operator's own login through dev_shared_login,
 * never written, so this is a developer's demo, not a lab deployment.
 *
 *   node scripts/agent-demo.ts --backend claude-code --model claude-haiku-5-5 --login ~/.claude
 *   node scripts/agent-demo.ts --backend codex --model <exact id> --login ~/.codex
 *
 * --research adds the literature tools and run_code over a synthetic sleep-diary dataset. It needs Docker and the
 * sandbox image: docker build -t aliquot-sandbox sandbox.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agentPermissionFlags } from "../packages/core/src/seal.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { ensurePostgres, processes, waitLine } from "./procs.ts";

const { values } = parseArgs({
  options: {
    backend: { type: "string", default: "claude-code" },
    model: { type: "string" },
    login: { type: "string" },
    binary: { type: "string" },
    port: { type: "string", default: process.env.LABH_DEMO_PORT ?? "3000" },
    research: { type: "boolean", default: false },
  },
});
if (process.platform !== "darwin") throw new Error("agent CLIs are confined on macOS only; this demo refuses to run them unconfined");
const kind = values.backend === "codex" ? "codex" : "claude-code";
const model = values.model ?? (kind === "claude-code" ? "claude-haiku-5-5" : "");
if (!model) throw new Error("--model is required for codex: the exact model id your login serves");
const login = realpathSync((values.login ?? (kind === "claude-code" ? (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")) : (process.env.CODEX_HOME ?? join(homedir(), ".codex")))).replace(/^~/, homedir()));

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".demo-agent");
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "ws"), { recursive: true });
const kbDir = join(work, "kb");
cpSync(join(root, "fixtures/lab0"), kbDir, { recursive: true });
const def = JSON.parse(readFileSync(join(kbDir, "kb.json"), "utf8")) as { sources: { cls: string }[]; definitionClass?: string };
// Synthetic documents, declared public so an agent on a personal subscription (placement public, D0) may read them.
for (const s of def.sources) s.cls = "D0";
def.definitionClass = "D0";
writeFileSync(join(kbDir, "kb-public.json"), JSON.stringify(def, null, 2));

const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const research = values.research
  ? {
      image: docker(["image", "inspect", "aliquot-sandbox", "--format", "{{.Id}}"]),
      socket: (process.env.DOCKER_HOST ?? docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])).replace(/^unix:\/\//, ""),
      dataset: join(work, "datasets", "sleep-diary"),
    }
  : null;
if (research) {
  mkdirSync(research.dataset, { recursive: true });
  // Made-up nightly diary rows, the same every run: 40 people, 7 nights, 2 waves.
  let seed = 7;
  const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const rows = ["person,wave,night,total_sleep_min,sleep_onset_latency_min"];
  for (let person = 1; person <= 40; person++) {
    for (const wave of [1, 2]) {
      for (let night = 1; night <= 7; night++) rows.push([person, wave, night, Math.round(400 + (wave === 2 ? 18 : 0) + 50 * (rand() - 0.5)), Math.round(18 - (wave === 2 ? 4 : 0) + 12 * (rand() - 0.5))].join(","));
    }
  }
  writeFileSync(join(research.dataset, "sleep-diary.csv"), `${rows.join("\n")}\n`);
}

const step = (line: string) => console.log(`  ${line}`);
console.log(`\nAliquot agent demo: ${kind} on the synthetic lab0 lab\n`);
await ensurePostgres(root);
const { url: dbUrl } = await freshDatabase("labh_demo_agent");
const compiler = await startFakeModel("scripted-1", "compile");

const backend = kind === "claude-code" ? "claude" : "codex";
const agentPath = join(work, "agent.json");
const baseAgent = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
writeFileSync(
  agentPath,
  JSON.stringify({
    ...baseAgent,
    agentId: "lab0-research",
    name: "Lab0 research assistant",
    instructions: research
      ? "You help lab members with the lab0 handbook and with research questions. For the lab's procedures, search the handbook, read the entries you need, and end with 'Source: <path>'. For data, list the datasets, then compute with run_code in Python and report the numbers it printed. For literature, search OpenAlex or PubMed and cite the title, year and DOI of what you used. Answer in under 150 words."
      : "You answer lab members' questions from the lab0 handbook. Search it, read the entries you need, answer in under 120 words, and end with 'Source: <path>' naming the entry you used.",
    instructionsClass: "D0",
    knowledgeBases: ["lab0-handbook"],
    ceiling: "D0",
    limits: { maxSteps: 12, maxWallMs: 5 * 60_000 },
    model: { endpointId: backend, modelId: model, params: { temperature: 0, maxOutputTokens: 1024 } },
    ...(research
      ? {
          tools: ["kb_search", "kb_read", "dataset_list", "run_code", "openalex_search", "pubmed_search"].map((name) => ({ name, scopes: [] })),
          sandbox: { enabled: true, mountCeiling: "D0", mounts: ["sleep-diary"] },
        }
      : {}),
  }),
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
    `[agent_backends.${backend}]`,
    `kind = "${kind}"`,
    "# A personal login is a public placement: the agent may see D0 only.",
    'placement = "public"',
    ...(values.binary ? [`binary = "${values.binary}"`] : []),
    `dev_shared_login = "${login}"`,
    "[surfaces.web]",
    'placement = "lab"',
    `port = ${Number(values.port)}`,
    "# This web server serves the public channel only, so its D0 floor is the lab's statement, not the sender's choice.",
    'channel = "public"',
    "[policy]",
    'participant_id_patterns = ["\\\\bLAB0-\\\\d{4}\\\\b"]',
    "# Questions in this channel start at D0: anyone may see them. The gate still raises a message that carries an id.",
    "[channel_floors]",
    '"web:public" = "D0"',
    ...(research
      ? [
          "[datasets.sleep-diary]",
          `path = "${realpathSync(research.dataset)}"`,
          'class = "D0"',
          'description = "Synthetic sleep diary: one row per person, wave and night, with total sleep and sleep onset latency in minutes"',
          "[sandbox]",
          `image = "${research.image}"`,
          "memory_mb = 512",
          `socket = "${research.socket}"`,
        ]
      : []),
    "[agents]",
    `fixtures = ["${agentPath}"]`,
    "",
  ].join("\n"),
);

const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: homedir(), USER: process.env.USER ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: randomBytes(32).toString("hex") };
const ps = processes(root, work, env);
ps.startWorker(cfg, "demo");
const kb = async (args: string[]) => {
  const proc = ps.start(`kb-${args[0]}`, "kb.ts", ["--config", cfg, ...args]);
  await proc.exit;
  const line = proc.out.join("").split("\n").findLast((l) => l.startsWith("{"));
  if (!line) throw new Error(`kb ${args[0]} printed no result; see ${work}`);
  return JSON.parse(line) as { result?: { t: string; snapshot: string }; ok?: boolean };
};
const compiled = await kb(["compile", "--definition", join(kbDir, "kb-public.json"), "--wait", "--timeout-ms", "60000"]);
if (compiled.result?.t !== "compiled") throw new Error(`compile failed: ${JSON.stringify(compiled)}`);
if (!(await kb(["publish", "--snapshot", compiled.result.snapshot])).ok) throw new Error("publish failed");
step(`knowledge base lab0-handbook (D0, synthetic) published, snapshot ${compiled.result.snapshot.slice(0, 12)}`);

const agentWorker = ps.startGroup("agent-worker", process.execPath, [...agentPermissionFlags(join(work, "ws")), "packages/core/bin/agent-worker.ts", "--config", cfg, "--workspaces", join(work, "ws"), "--worker-id", "agent-demo", "--dev-shared-login"], root);
step((await waitLine(agentWorker, new RegExp(`agent backend ${backend}: [^\\n]+`), 60_000)).trim());
const web = ps.start("web", "web.ts", ["--config", cfg]);
const base = (await waitLine(web, /listening on (http:\/\/127\.0\.0\.1:\d+)/, 15000)).replace("listening on ", "");

const tries = [
  "How long can an aliquot thaw on wet ice, and who do I call if the freezer alarm sounds?",
  ...(research ? ["In the sleep diary dataset, how did mean total sleep time change from wave 1 to wave 2? Then find one recent paper comparing actigraphy with sleep diaries."] : []),
  "Is LAB0-0003 still pending for wave 1?",
];
console.log(`
Open the chat page:

  ${base}/?try=${tries.map(encodeURIComponent).join("|")}

The agent is ${kind} (${model}), confined: no tools of its own, no file or network access except the Aliquot bridge
and a proxy to its vendor's API. Each answer's Record shows the session, every bridged tool call and every refusal.
The last question carries a participant id (D3); this agent's placement is public (D0), so nothing is sent.

  DATABASE_URL=${dbUrl} pnpm aliquot --config ${cfg} record <run-id>

Logs are in ${work}. Press Ctrl-C to stop.
`);
await new Promise(() => {});
