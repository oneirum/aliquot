/**
 * Agent CLI backends: what lab.toml may declare, and per kind the code that
 * lab.toml cannot change: the argv that switches off every built-in tool,
 * the vendor hosts the proxy may tunnel to, and the parser and self-check
 * for the CLI's output. The flags are pinned to the CLI versions the smoke
 * test ran; a different installed version is unrunnable (agent-cli-version).
 */

import type { Placement } from "../dataclass.ts";
import type { ExactModelId } from "../gateway.ts";
import type { ConfinementCheck } from "../record.ts";

export const AGENT_CLI_KINDS = ["claude-code", "codex"] as const;
export type AgentCliKind = (typeof AGENT_CLI_KINDS)[number];

/** An agent CLI is a hosted model with its own loop, so lab and institution are not placements it can have. */
export const HOSTED_PLACEMENTS = ["approved", "zdr", "public"] as const;
export type HostedPlacement = Extract<Placement, (typeof HOSTED_PLACEMENTS)[number]>;

/** How the session hands the CLI its login. Never the operator's own state directory. */
export type AgentAuth =
  | { readonly t: "env"; readonly env: string }
  | { readonly t: "file"; readonly path: string }
  /** Development only, public placement only: the operator's own logged-in state directory, never written. */
  | { readonly t: "dev-shared"; readonly dir: string };

export interface AgentBackend {
  readonly id: string;
  readonly kind: AgentCliKind;
  readonly placement: HostedPlacement;
  /** A path, a bare name looked up on PATH, or null for the kind's usual name on PATH. The agent worker resolves it to a real path at boot. */
  readonly binary: string | null;
  readonly auth: AgentAuth;
}

/** What the CLI needs to reach the run: its bridge, its state directory and its working root. */
export interface SessionPaths {
  readonly bridgeUrl: string;
  readonly workspace: string;
  readonly configDir: string;
}

/** One parsed line of CLI output. Anything the parser does not know is `other`, which the self-check judges per kind. */
export type CliLine =
  | { readonly t: "init"; readonly tools: readonly string[]; readonly model: string; readonly version: string; readonly mcp: readonly { readonly name: string; readonly status: string }[] }
  | { readonly t: "text"; readonly text: string }
  | { readonly t: "tool-use"; readonly name: string; readonly server: string | null }
  /** models: every model the CLI says served the session; empty when it does not say. */
  | { readonly t: "result"; readonly text: string | null; readonly error: boolean; readonly usage: { readonly input: number; readonly output: number } | null; readonly models: readonly string[] }
  | { readonly t: "foreign-item"; readonly type: string }
  | { readonly t: "other" };

/** Why a session is not the confined session the version promised. Ends the run as agent-not-confined. */
export type SelfCheck = { readonly ok: true } | { readonly ok: false; readonly check: ConfinementCheck; readonly why: string };

export interface KindSpec {
  /** The CLI's own state directory variable. Each session sets it to a fresh directory inside its workspace. */
  readonly configDirEnv: "CLAUDE_CONFIG_DIR" | "CODEX_HOME";
  /** Hosts the egress proxy may open a tunnel to, on port 443. Fixed here, not in lab.toml. */
  readonly vendorHosts: readonly string[];
  /** Extra environment, fixed per kind. Names only; no value comes from the worker's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Whether the bridge must wait for an init line that passed the self-check before it serves a call. */
  readonly initGated: boolean;
  argv(model: ExactModelId, paths: SessionPaths): string[];
  parse(line: string): CliLine;
  /** The tokens one model turn used, keyed by its message id, when the kind reports them before the session ends. */
  turnTokens(line: string): { readonly id: string; readonly tokens: number } | null;
  /** Judges one parsed line against what the version pinned. */
  check(line: CliLine, pinned: { readonly model: ExactModelId; readonly cliVersion: string }): SelfCheck;
  /** The version printed by `<binary> --version`, or null when the output is not this kind's. */
  version(stdout: string): string | null;
}

/** The bridge's MCP server name. Claude Code prefixes its tools with mcp__<name>__. */
export const BRIDGE_SERVER = "aliquot";
export const BRIDGE_TOKEN_ENV = "ALIQUOT_BRIDGE_TOKEN";

const SYSTEM_TEXT =
  "You are a research agent running inside Aliquot. Your only tools are the aliquot tools listed for this session. Work on the task you are given, then answer in plain text. A tool result that starts with withheld: was not shown to you because of the lab's data rules; do not try to obtain it another way.";

type Json = Record<string, unknown>;

function json(line: string): Json | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const claudeCode: KindSpec = {
  configDirEnv: "CLAUDE_CONFIG_DIR",
  vendorHosts: ["api.anthropic.com", "console.anthropic.com", "platform.claude.com"],
  env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
  initGated: true,
  argv(model, paths) {
    // ${ALIQUOT_BRIDGE_TOKEN} is expanded by the CLI from its environment, so the token never appears in argv or ps.
    const mcp = { mcpServers: { [BRIDGE_SERVER]: { type: "http", url: paths.bridgeUrl, headers: { Authorization: `Bearer \${${BRIDGE_TOKEN_ENV}}` } } } };
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(mcp),
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--allowedTools",
      `mcp__${BRIDGE_SERVER}`,
      "--system-prompt",
      SYSTEM_TEXT,
    ];
  },
  parse(line) {
    const o = json(line);
    if (!o) return { t: "other" };
    if (o.type === "system" && o.subtype === "init") {
      const tools = Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === "string") : [];
      const mcp = Array.isArray(o.mcp_servers) ? o.mcp_servers.flatMap((s) => (typeof s === "object" && s !== null ? [{ name: str((s as Json).name) ?? "", status: str((s as Json).status) ?? "" }] : [])) : [];
      return { t: "init", tools, model: str(o.model) ?? "", version: str(o.claude_code_version) ?? "", mcp };
    }
    if (o.type === "assistant" && typeof o.message === "object" && o.message !== null) {
      const content = (o.message as Json).content;
      if (!Array.isArray(content)) return { t: "other" };
      // Every block is judged: a server_tool_use (a vendor-side web search) or a second, foreign tool_use is the CLI's own.
      let call: string | null = null;
      let text = "";
      for (const c of content as Json[]) {
        if (c.type === "text") text += str(c.text) ?? "";
        else if (c.type === "tool_use") {
          const name = str(c.name) ?? "";
          if (!name.startsWith(`mcp__${BRIDGE_SERVER}__`)) return { t: "tool-use", name, server: null };
          call ??= name;
        } else if (c.type !== "thinking" && c.type !== "redacted_thinking") return { t: "foreign-item", type: str(c.type) ?? "untyped" };
      }
      if (call !== null) return { t: "tool-use", name: call, server: null };
      return text ? { t: "text", text } : { t: "other" };
    }
    if (o.type === "result") {
      const byModel = typeof o.modelUsage === "object" && o.modelUsage !== null ? (o.modelUsage as Record<string, Json>) : {};
      const models = Object.keys(byModel);
      const sum = (f: (u: Json) => number) => Object.values(byModel).reduce((n, u) => n + f(u), 0);
      const usage = models.length ? { input: sum((u) => num(u.inputTokens) + num(u.cacheReadInputTokens) + num(u.cacheCreationInputTokens)), output: sum((u) => num(u.outputTokens)) } : null;
      return { t: "result", text: str(o.result), error: o.is_error === true || o.subtype !== "success", usage, models };
    }
    return { t: "other" };
  },
  turnTokens(line) {
    const o = json(line);
    const m = o?.type === "assistant" && typeof o.message === "object" && o.message !== null ? (o.message as Json) : null;
    const u = m && typeof m.usage === "object" && m.usage !== null ? (m.usage as Json) : null;
    const id = m ? str(m.id) : null;
    return id && u ? { id, tokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens) } : null;
  },
  check(line, pinned) {
    if (line.t === "init") {
      const foreign = line.tools.filter((t) => !t.startsWith(`mcp__${BRIDGE_SERVER}__`));
      if (foreign.length) return { ok: false, check: "own-tool", why: `the CLI loaded tools of its own: ${foreign.join(", ")}` };
      const servers = line.mcp.filter((s) => s.name !== BRIDGE_SERVER);
      if (servers.length) return { ok: false, check: "own-server", why: `the CLI loaded MCP servers of its own: ${servers.map((s) => s.name).join(", ")}` };
      if (line.model !== pinned.model) return { ok: false, check: "model", why: `the CLI runs model ${line.model}, not ${pinned.model}` };
      if (line.version !== pinned.cliVersion) return { ok: false, check: "version", why: `the CLI is version ${line.version}, not ${pinned.cliVersion}` };
    }
    if (line.t === "tool-use" && !line.name.startsWith(`mcp__${BRIDGE_SERVER}__`)) return { ok: false, check: "own-call", why: `the CLI called a tool of its own: ${line.name}` };
    if (line.t === "foreign-item") return { ok: false, check: "own-item", why: `the CLI produced a ${line.type} block, which is not an aliquot tool` };
    const served = line.t === "result" ? line.models.filter((m) => m !== pinned.model) : [];
    if (served.length) return { ok: false, check: "model", why: `the CLI reports model ${served.join(", ")} served the session, not ${pinned.model}` };
    return { ok: true };
  },
  version: (stdout) => /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(stdout.trim())?.[1] ?? null,
};

/** Codex item types a confined session may produce. Anything else (command_execution, file_change, web_search, ...) is a tool of its own. */
const CODEX_ITEMS: ReadonlySet<string> = new Set(["agent_message", "reasoning", "mcp_tool_call", "todo_list", "error"]);
/**
 * Codex's own MCP resource tools, which no feature flag turns off. They reach only the configured MCP servers, which
 * under --ignore-user-config is the bridge alone, and the bridge serves no resources method.
 */
const CODEX_RESOURCE_TOOLS: ReadonlySet<string> = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

const codex: KindSpec = {
  configDirEnv: "CODEX_HOME",
  vendorHosts: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  // Without a CA bundle codex asks trustd, which the seatbelt denies: trustd fetches OCSP and AIA URLs itself, a route around the proxy.
  env: { SSL_CERT_FILE: "/etc/ssl/cert.pem" },
  initGated: false,
  argv(model, paths) {
    const disabled = ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "browser_use", "computer_use", "image_generation", "in_app_browser", "view_image", "multi_agent", "sleep_tool", "tool_suggest", "skill_search", "goals"];
    return [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-C",
      paths.workspace,
      "-m",
      model,
      "-s",
      "read-only",
      ...disabled.flatMap((f) => ["--disable", f]),
      "-c",
      'web_search="disabled"',
      "-c",
      'approval_policy="never"',
      "-c",
      `mcp_servers.${BRIDGE_SERVER}.url=${JSON.stringify(paths.bridgeUrl)}`,
      "-c",
      `mcp_servers.${BRIDGE_SERVER}.bearer_token_env_var=${JSON.stringify(BRIDGE_TOKEN_ENV)}`,
      // under approval_policy never codex rejects any MCP call that would ask; the bridge is the gate for these
      "-c",
      `mcp_servers.${BRIDGE_SERVER}.default_tools_approval_mode="approve"`,
      "-",
    ];
  },
  parse(line) {
    const o = json(line);
    if (!o) return { t: "other" };
    if ((o.type === "item.started" || o.type === "item.updated" || o.type === "item.completed") && typeof o.item === "object" && o.item !== null) {
      const item = o.item as Json;
      const type = str(item.type) ?? "";
      if (!CODEX_ITEMS.has(type)) return { t: "foreign-item", type };
      if (type === "mcp_tool_call") return { t: "tool-use", name: str(item.tool) ?? "", server: str(item.server) };
      if (type === "agent_message" && o.type === "item.completed") return { t: "text", text: str(item.text) ?? "" };
      return { t: "other" };
    }
    if (o.type === "turn.completed") {
      const u = o.usage as Json | undefined;
      return { t: "result", text: null, error: false, usage: u ? { input: num(u.input_tokens), output: num(u.output_tokens) } : null, models: [] };
    }
    if (o.type === "turn.failed" || o.type === "error") return { t: "result", text: null, error: true, usage: null, models: [] };
    return { t: "other" };
  },
  // codex exec reports usage once, on turn.completed at the end
  turnTokens: () => null,
  check(line) {
    if (line.t === "foreign-item") return { ok: false, check: "own-item", why: `the CLI produced a ${line.type} item, which is not an aliquot tool` };
    if (line.t === "tool-use" && line.server !== BRIDGE_SERVER && !(line.server === "codex" && CODEX_RESOURCE_TOOLS.has(line.name))) return { ok: false, check: "own-call", why: `the CLI called ${line.name} on server ${line.server ?? "none"}` };
    return { ok: true };
  },
  version: (stdout) => /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(stdout.trim())?.[1] ?? null,
};

export const KINDS: Readonly<Record<AgentCliKind, KindSpec>> = { "claude-code": claudeCode, codex };

/** Codex prints no model id. The record says so instead of claiming the requested one was served. */
export const UNREPORTED_MODEL = "unreported";
