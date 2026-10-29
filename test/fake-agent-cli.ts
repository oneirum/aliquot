// A stand-in for Claude Code and Codex in -p / exec mode. It speaks to the bridge with the MCP subset the real CLIs
// use and prints their output format. Self-contained (node: builtins only), because the tests copy it into a temp
// install dir outside the repository, which the sandbox keeps unreadable.
//
// It reads fake.json beside itself: { kind: "claude-code" | "codex", version, extraTool?, wrongModel?, foreignItem? }.
// The task prompt on stdin carries directives, one per line:
//   @call <tool> <json args>   call a bridged tool; its text goes into the answer
//   @read <path>               try to read a file; the answer gets its content or the error code
//   @connect <host> <port>     try a direct TCP connection; the answer gets "connected" or the error code
//   @proxy <request line>      send one request head to the egress proxy; the answer gets its status line
//   @env                       put the environment's names into the answer
//   @getenv <name>             put one variable's value into the answer
//   @say <text>                print an assistant text turn
//   @tokens <n>                print an assistant turn that reports n input tokens
//   @grandchild                start a child process, as codex starts its native binary, and write its pid to child.pid
//   @hang                      wait until killed
//   @fail                      exit 3 without a result
//   @answer <text>             the start of the final answer
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Fake {
  readonly kind: "claude-code" | "codex";
  readonly version: string;
  readonly extraTool?: string;
  readonly wrongModel?: string;
  readonly foreignItem?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const fake = JSON.parse(readFileSync(join(here, "fake.json"), "utf8")) as Fake;
const argv = process.argv.slice(2);

if (argv[0] === "--version") {
  process.stdout.write(fake.kind === "codex" ? `codex-cli ${fake.version}\n` : `${fake.version} (Claude Code)\n`);
  process.exit(0);
}

const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function bridge(): { readonly url: string; readonly auth: string } {
  if (fake.kind === "claude-code") {
    const server = (JSON.parse(flag("--mcp-config")!) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }).mcpServers.aliquot!;
    return { url: server.url, auth: server.headers.Authorization!.replace(/\$\{(\w+)\}/g, (_m, name: string) => process.env[name] ?? "") };
  }
  const configs = argv.flatMap((a, i) => (argv[i - 1] === "-c" ? [a] : []));
  const value = (key: string) => JSON.parse(configs.find((c) => c.startsWith(`${key}=`))!.slice(key.length + 1)) as string;
  return { url: value("mcp_servers.aliquot.url"), auth: `Bearer ${process.env[value("mcp_servers.aliquot.bearer_token_env_var")] ?? ""}` };
}

const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const model = fake.wrongModel ?? (fake.kind === "codex" ? flag("-m")! : flag("--model")!);
const { url, auth } = bridge();
let rpcId = 0;
async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: auth }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result!;
}

const prompt = readFileSync(0, "utf8");
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: fake.version } });
await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
const listed = ((await rpc("tools/list", {})).tools as { name: string }[]).map((t) => t.name);

if (fake.kind === "claude-code") {
  const tools = [...listed.map((n) => `mcp__aliquot__${n}`), ...(fake.extraTool ? [fake.extraTool] : [])];
  out({ type: "system", subtype: "init", tools, mcp_servers: [{ name: "aliquot", status: "connected" }], model, claude_code_version: fake.version, apiKeySource: "none" });
} else {
  out({ type: "thread.started", thread_id: "fake" });
  out({ type: "turn.started" });
  if (fake.foreignItem) out({ type: "item.completed", item: { id: "item_0", type: fake.foreignItem } });
}

writeFileSync(join(process.cwd(), "scratch.txt"), "the workspace is writable");
const parts: string[] = [];
let answer = "";
let n = 0;
for (const line of prompt.split("\n")) {
  const [directive, ...rest] = line.trim().split(" ");
  const arg = rest.join(" ");
  if (directive === "@call") {
    const [tool, ...json] = rest;
    if (fake.kind === "claude-code") out({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${n}`, name: `mcp__aliquot__${tool}`, input: {} }] } });
    else out({ type: "item.started", item: { id: `item_${++n}`, type: "mcp_tool_call", server: "aliquot", tool, status: "in_progress" } });
    try {
      const r = await rpc("tools/call", { name: tool, arguments: JSON.parse(json.join(" ") || "{}") });
      parts.push(`${tool}${r.isError ? " (error)" : ""}: ${(r.content as { text: string }[]).map((c) => c.text).join("")}`);
    } catch (err) {
      parts.push(`${tool} (rpc error): ${(err as Error).message}`);
    }
  } else if (directive === "@read") {
    try {
      parts.push(`read ${arg}: ${readFileSync(arg, "utf8")}`);
    } catch (err) {
      parts.push(`read ${arg}: ${(err as NodeJS.ErrnoException).code}`);
    }
  } else if (directive === "@connect") {
    const [host, port] = rest;
    parts.push(
      `connect ${host}:${port}: ${await new Promise<string>((resolve) => {
        const s = connect(Number(port), host!);
        s.once("connect", () => {
          s.destroy();
          resolve("connected");
        });
        s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
      })}`,
    );
  } else if (directive === "@proxy") {
    const port = Number(new URL(process.env.HTTPS_PROXY!).port);
    parts.push(
      `proxy: ${await new Promise<string>((resolve) => {
        const s = connect(port, "127.0.0.1", () => s.write(`${arg}\r\n\r\n`));
        let got = "";
        s.on("data", (b) => (got += b.toString("latin1")));
        s.on("close", () => resolve(got.split("\r\n")[0]!));
        s.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
      })}`,
    );
  } else if (directive === "@env") parts.push(`env: ${Object.keys(process.env).sort().join(",")}; config: ${readdirSync(process.env.CLAUDE_CONFIG_DIR ?? process.env.CODEX_HOME!).join(",")}`);
  else if (directive === "@getenv") parts.push(`${arg}=${process.env[arg] ?? "(unset)"}`);
  else if (directive === "@say") out({ type: "assistant", message: { id: `msg_${++n}`, content: [{ type: "text", text: arg }] } });
  else if (directive === "@tokens") out({ type: "assistant", message: { id: `msg_${++n}`, content: [{ type: "text", text: "" }], usage: { input_tokens: Number(arg), output_tokens: 0 } } });
  else if (directive === "@grandchild") writeFileSync(join(process.cwd(), "child.pid"), String(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid));
  else if (directive === "@hang") await new Promise(() => setInterval(() => undefined, 1_000));
  else if (directive === "@fail") process.exit(3);
  else if (directive === "@answer") answer = arg;
}

const text = [answer, ...parts].join("\n");
if (fake.kind === "claude-code") {
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text, num_turns: parts.length + 1, usage: { input_tokens: prompt.length, output_tokens: text.length }, modelUsage: { [model]: { inputTokens: prompt.length, outputTokens: text.length } } });
} else {
  out({ type: "item.completed", item: { id: `item_${++n}`, type: "agent_message", text } });
  out({ type: "turn.completed", usage: { input_tokens: prompt.length, cached_input_tokens: 0, output_tokens: text.length } });
}
