/**
 * Two fake OpenAI-compatible servers for the checks: a scripted model that
 * follows a fixed script instead of thinking, and a "hosted" one that only
 * counts the requests that reach it. Every request counts, whatever its path
 * or body, because every "hosted requests" claim rests on this counter. The "compile" script is a deterministic
 * KB compiler and coverage judge; see compileReply.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

export type Script = "search-then-answer" | "search-read-answer" | "cite" | "always-search" | "answer" | "wrong-model" | "http-500" | "compile";

/** What the http-500 script puts in its error body. A provider error body can echo the prompt, so the record must not hold it in the clear. */
export const ERROR_BODY_MARKER = "provider-echo P-12345";

export interface FakeModel {
  readonly url: string;
  readonly modelId: string;
  script: Script;
  /** Delay before every response. The stop check uses it to have a call in flight. */
  delayMs: number;
  /** Every request that reached the server, any method, path or body. */
  readonly requests: number;
  /** "METHOD url" of each request, in arrival order. */
  readonly paths: readonly string[];
  readonly bodies: readonly unknown[];
  close(): Promise<void>;
}

interface WireRequest {
  model: string;
  messages: { role: string; content?: string | null; tool_calls?: unknown[] }[];
  tools?: { function: { name: string } }[];
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startFakeModel(modelId: string, script: Script): Promise<FakeModel> {
  const state = { script, delayMs: 0, requests: 0, completions: 0, paths: [] as string[], bodies: [] as unknown[] };
  const server: Server = createServer(async (req, res) => {
    state.requests += 1;
    state.paths.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/v1/models") return respond(res, 200, { data: [{ id: modelId }] });
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return respond(res, 404, { error: "not found" });
    let body: WireRequest;
    try {
      body = (await readJson(req)) as WireRequest;
    } catch {
      return respond(res, 400, { error: "unparseable body" });
    }
    state.completions += 1;
    state.bodies.push(body);
    if (state.delayMs) await sleep(state.delayMs);
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const hasTools = (body.tools?.length ?? 0) > 0;
    const hasToolResult = body.messages.some((m) => m.role === "tool");
    const toolResults = body.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    const answer = (text: string) => ({
      id: `cmpl-${state.completions}`,
      object: "chat.completion",
      model: state.script === "wrong-model" ? "other-model-9" : body.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const search = () => ({
      id: `cmpl-${state.completions}`,
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "", tool_calls: [{ id: `call-${state.completions}`, type: "function", function: { name: "kb_search", arguments: JSON.stringify({ query: lastUser, k: 3 }) } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const call = (name: string, args: unknown) => ({
      id: `cmpl-${state.completions}`,
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ id: `call-${state.completions}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    switch (state.script) {
      case "http-500":
        return respond(res, 500, { error: `upstream failed: ${ERROR_BODY_MARKER}` });
      case "compile":
        return respond(res, 200, answer(compileReply(body.messages)));
      case "cite": {
        // The demo's fake: search, read the top entry, quote its opening and name the path. It reads; it does not think.
        const last = toolResults.at(-1);
        if (last === undefined) return respond(res, 200, hasTools ? call("kb_search", { query: lastUser, k: 3 }) : answer("No knowledge base tools are attached."));
        const parsed = JSON.parse(last) as { results?: { path: string }[]; entries?: { path: string; body: string }[] };
        if (parsed.results) return respond(res, 200, parsed.results.length ? call("kb_read", { paths: [parsed.results[0]!.path] }) : answer("The lab's documents do not cover this question."));
        const entry = parsed.entries?.[0];
        if (!entry) return respond(res, 200, answer("The lab's documents do not cover this question."));
        const opening = entry.body.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/).slice(0, 2).join(" ");
        return respond(res, 200, answer(`${opening}\n\nSource: ${entry.path}`));
      }
      case "search-read-answer": {
        const last = toolResults.at(-1);
        if (last === undefined) return respond(res, 200, call("kb_search", { query: lastUser, k: 3 }));
        const parsed = JSON.parse(last) as { results?: { path: string }[]; entries?: { title: string }[] };
        if (parsed.results) return respond(res, 200, call("kb_read", { paths: parsed.results.map((r) => r.path) }));
        return respond(res, 200, answer(`Scripted answer from ${parsed.entries?.length ?? 0} entries: ${(parsed.entries ?? []).map((e) => e.title).join("; ")}`));
      }
      case "search-then-answer":
        return respond(res, 200, hasTools && !hasToolResult ? search() : answer(`Scripted answer from ${toolResults.length} search result(s): ${toolResults.join(" | ").slice(0, 200)}`));
      case "always-search":
        return respond(res, 200, hasTools ? search() : answer("Scripted final answer with no tools available."));
      case "answer":
      case "wrong-model":
        return respond(res, 200, answer(`Scripted answer to: ${lastUser}`));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    modelId,
    get script() {
      return state.script;
    },
    set script(s) {
      state.script = s;
    },
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(ms) {
      state.delayMs = ms;
    },
    get requests() {
      return state.requests;
    },
    get paths() {
      return state.paths;
    },
    get bodies() {
      return state.bodies;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const STOPWORDS = new Set(["which", "where", "what", "when", "should", "there", "their", "about", "after", "before", "does", "many", "much", "with", "from", "have", "this", "that", "they", "into"]);
const keyTerms = (text: string) => [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOPWORDS.has(t)))];
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Compile: one entry per "## " section of the source, at <sourceId>/<heading>.md,
 * with the section's first line as its one fact. Coverage: answerable when one
 * candidate entry holds at least two thirds of the question's key terms.
 */
function compileReply(messages: WireRequest["messages"]): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  if (system.startsWith("You compile one source document")) {
    const sourceId = /Source id: (\S+)/.exec(user)?.[1] ?? "source";
    const text = /<source>\n([\s\S]*)\n<\/source>/.exec(user)?.[1] ?? "";
    const sections = text.split(/^## /m).slice(1);
    const entries = sections.map((section) => {
      const [heading = "", ...lines] = section.split("\n");
      const body = lines.join("\n").trim();
      return { path: `${sourceId}/${slug(heading)}.md`, title: heading.trim(), body, facts: [{ text: body.split("\n")[0]!, locator: `## ${heading.trim()}` }] };
    });
    return JSON.stringify({ entries });
  }
  const question = /Question: (.*)/.exec(user)?.[1] ?? "";
  const terms = keyTerms(question);
  const supporting = [...user.matchAll(/<entry path="([^"]+)">\n([\s\S]*?)\n<\/entry>/g)]
    .filter(([, , text]) => terms.filter((t) => text!.toLowerCase().includes(t)).length * 3 >= terms.length * 2)
    .map(([, path]) => path!);
  return JSON.stringify({ answerable: supporting.length > 0, paths: supporting });
}
