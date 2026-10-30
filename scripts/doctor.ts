#!/usr/bin/env node
/**
 * pnpm doctor: checks this machine before a first `pnpm demo`, and says the
 * fix for each problem. It changes nothing: it starts no container, writes
 * no file and calls no model.
 *
 * FAIL is something `pnpm demo` or the checks cannot run without. WARN is
 * something only part of Aliquot needs (the research tools, the agent CLIs,
 * the studio). The exit code is 1 when any line is FAIL.
 *
 *   node scripts/doctor.ts [--json]
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configProblem } from "../packages/core/src/config.ts";

export interface Facts {
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly pnpm: string | null;
  readonly installed: boolean;
  readonly docker: { readonly cli: boolean; readonly server: string | null };
  readonly postgres: { readonly port: number; readonly open: boolean };
  readonly freePorts: Readonly<Record<number, boolean>>;
  readonly sandboxImage: boolean;
  readonly agentClis: Readonly<Record<"claude" | "codex", string | null>>;
  readonly labToml: { readonly present: boolean; readonly problem: string | null };
}

export interface Line {
  readonly level: "PASS" | "WARN" | "FAIL";
  readonly what: string;
  readonly fix?: string;
}

/** The verdict for each fact. Pure, so the tests can feed it any machine. */
export function diagnose(f: Facts): Line[] {
  const lines: Line[] = [];
  const major = Number(f.node.split(".")[0]);
  lines.push(major >= 26 ? { level: "PASS", what: `Node ${f.node}` } : { level: "FAIL", what: `Node ${f.node} is older than 26`, fix: "install Node 26 or later; Aliquot runs TypeScript directly and uses Node's permission model" });
  lines.push(f.pnpm ? { level: "PASS", what: `pnpm ${f.pnpm}` } : { level: "FAIL", what: "pnpm not found", fix: "corepack enable, or npm install -g pnpm@10" });
  lines.push(f.installed ? { level: "PASS", what: "dependencies installed" } : { level: "FAIL", what: "dependencies not installed", fix: "pnpm install" });
  if (!f.docker.cli) lines.push({ level: "FAIL", what: "docker not found", fix: "install Docker; the demo runs Postgres in it, and run_code runs R and Python in a container" });
  else if (!f.docker.server) lines.push({ level: "FAIL", what: "Docker is installed but its daemon is not running", fix: "start Docker Desktop, or the docker service" });
  else lines.push({ level: "PASS", what: `Docker ${f.docker.server}` });
  lines.push(
    f.postgres.open
      ? { level: "PASS", what: `something is listening on Postgres port ${f.postgres.port}` }
      : { level: "WARN", what: `nothing on Postgres port ${f.postgres.port} yet`, fix: "pnpm demo starts it; for the checks run docker compose up -d postgres (set LABH_PG_PORT if the port is taken)" },
  );
  for (const [port, free] of Object.entries(f.freePorts)) {
    const role = port === "3000" ? "the web door" : "the studio";
    lines.push(free ? { level: "PASS", what: `port ${port} is free for ${role}` } : { level: "WARN", what: `port ${port} is taken, which ${role} uses`, fix: port === "3000" ? "pnpm demo --port <n>, or set LABH_DEMO_PORT" : "stop what holds it before pnpm demo --studio" });
  }
  lines.push(f.sandboxImage ? { level: "PASS", what: "aliquot-sandbox image built" } : { level: "WARN", what: "aliquot-sandbox image not built; run_code and --research need it", fix: "docker build -t aliquot-sandbox sandbox" });
  for (const [name, version] of Object.entries(f.agentClis)) {
    if (version) lines.push({ level: "PASS", what: `${name} ${version} found, for pnpm demo:agent --backend ${name === "claude" ? "claude-code" : "codex"}` });
  }
  if (f.platform !== "darwin" && (f.agentClis.claude || f.agentClis.codex)) lines.push({ level: "WARN", what: `agent CLIs are confined on macOS only; on ${f.platform} an agent backend refuses to run` });
  if (f.labToml.present) lines.push(f.labToml.problem ? { level: "FAIL", what: `lab.toml does not load: ${f.labToml.problem}` } : { level: "PASS", what: "lab.toml loads" });
  return lines;
}

function version(cmd: string, args: readonly string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return null;
  return r.stdout.trim().split("\n")[0]!.replace(/^[^\d]*/, "").split(/\s/)[0] || r.stdout.trim();
}

function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = new Socket();
    s.setTimeout(1000);
    s.once("connect", () => (s.destroy(), done(true)));
    s.once("timeout", () => (s.destroy(), done(false)));
    s.once("error", () => done(false));
    s.connect(port, "127.0.0.1");
  });
}

function free(port: number): Promise<boolean> {
  return new Promise((done) => {
    const srv = createServer();
    srv.once("error", () => done(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => done(true)));
  });
}

export async function gatherFacts(root: string, env: NodeJS.ProcessEnv = process.env): Promise<Facts> {
  const pgPort = Number(env.LABH_PG_PORT ?? "5432");
  const dockerCli = spawnSync("docker", ["--version"], { timeout: 10_000 }).status === 0;
  const server = dockerCli ? spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15_000 }) : null;
  const labToml = env.LABH_CONFIG ?? join(root, "lab.toml");
  const present = existsSync(labToml);
  return {
    node: process.versions.node,
    platform: process.platform,
    pnpm: version("pnpm", ["--version"]),
    installed: existsSync(join(root, "node_modules/.pnpm")),
    docker: { cli: dockerCli, server: server?.status === 0 ? server.stdout.trim() : null },
    postgres: { port: pgPort, open: await listening(pgPort) },
    freePorts: { 3000: await free(3000), 3001: await free(3001) },
    sandboxImage: dockerCli && spawnSync("docker", ["image", "inspect", "aliquot-sandbox"], { timeout: 15_000 }).status === 0,
    agentClis: { claude: version("claude", ["--version"]), codex: version("codex", ["--version"]) },
    labToml: { present, problem: present ? await configProblem(labToml) : null },
  };
}

export function formatLines(lines: readonly Line[]): string {
  const out = lines.map((l) => `${l.level}  ${l.what}${l.fix ? `\n      fix: ${l.fix}` : ""}`);
  const count = (lvl: Line["level"]) => lines.filter((l) => l.level === lvl).length;
  const fails = count("FAIL");
  out.push("", fails ? `${fails} problem${fails === 1 ? "" : "s"} to fix before pnpm demo` : `ready for pnpm demo${count("WARN") ? ` (${count("WARN")} warning${count("WARN") === 1 ? "" : "s"} for optional parts)` : ""}`);
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { json: { type: "boolean", default: false } } });
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const lines = diagnose(await gatherFacts(root));
  console.log(values.json ? JSON.stringify(lines, null, 2) : `\nAliquot doctor\n\n${formatLines(lines)}\n`);
  if (lines.some((l) => l.level === "FAIL")) process.exitCode = 1;
}
