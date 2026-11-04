/**
 * Aliquot as a Model Context Protocol server (modelcontextprotocol.io) on stdio:
 * JSON-RPC 2.0, one message per line on stdin and stdout. A member's own Claude
 * Code, Codex or Cursor runs it, on the member's own subscription, and calls its
 * one tool, ask. Every question goes to the web door through door-client.ts, so
 * the gate, the data-class checks and the record are the door's, unchanged.
 *
 * The door answers up to its surface's ceiling and posts the record link only
 * above it. Then the tool result carries the link and nothing of the answer,
 * because whatever it returns lands in the member's tool and its vendor's logs.
 */

import { randomUUID } from "node:crypto";
import { ALIQUOT_VERSION } from "./acp.ts";
import type { DataClass } from "./dataclass.ts";
import { DoorError, type AskInput, type AskOptions, type DoorEvent } from "./door-client.ts";

/** Newest first. initialize answers with the client's version when it is one of these, else the newest. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface McpDeps {
  readonly ask: (input: AskInput, opts: AskOptions) => AsyncIterable<DoorEvent>;
  readonly stop: (runId: string) => Promise<void>;
  readonly write: (line: string) => void;
  readonly user: string;
  readonly ceiling?: DataClass;
}

const ASK_TOOL = {
  name: "ask",
  title: "Ask the lab",
  description:
    "Ask the lab's Aliquot a question about its handbook, protocols, literature or data. Use when the answer should come from the lab's own sources, with a record of what was read. Not for general questions the model can answer itself. Pass thread to continue an earlier question; the result names the thread. An answer above what this client may keep comes back as the record link only: open it in the browser.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, in the member's words." },
      thread: { type: "string", description: "The thread of an earlier ask, to continue it. Omit to start a new one." },
    },
    required: ["question"],
  },
  outputSchema: {
    type: "object",
    properties: {
      thread: { type: "string" },
      answer: { type: ["string", "null"], description: "Null when the answer was withheld or refused." },
      withheld: { type: "boolean" },
      refused: { type: ["string", "null"] },
      recordUrl: { type: ["string", "null"], description: "The run's record; null when the gate refused before any run." },
    },
    required: ["thread", "answer", "withheld", "refused", "recordUrl"],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
} as const;

type Id = string | number;
interface Rpc {
  readonly id?: Id;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const ERR = { parse: -32700, method: -32601, params: -32602, internal: -32603 } as const;

/** Returns handle(line): each line is one JSON-RPC message from the client. A call's result is written when its run finishes. */
export function mcpServer(deps: McpDeps): (line: string) => Promise<void> {
  const running = new Map<Id, { runId: string | null; abort: AbortController }>();
  const send = (msg: object) => deps.write(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  const reply = (id: Id, result: unknown) => send({ id, result });
  const fail = (id: Id | null, code: number, message: string) => send({ id, error: { code, message } });

  async function call(id: Id, params: Record<string, unknown>): Promise<void> {
    if (params.name !== "ask") return fail(id, ERR.params, `Aliquot has one tool, ask, not ${String(params.name)}`);
    const args = (params.arguments ?? {}) as { question?: unknown; thread?: unknown };
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question) return fail(id, ERR.params, "ask needs a question");
    if (args.thread !== undefined && (typeof args.thread !== "string" || !/^[\w.-]{1,128}$/.test(args.thread))) return fail(id, ERR.params, "thread is the thread an earlier ask returned");
    const thread = (args.thread as string | undefined) ?? `mcp-${randomUUID()}`;
    const abort = new AbortController();
    const run = { runId: null as string | null, abort };
    running.set(id, run);
    const result = (text: string, out: { answer: string | null; withheld: boolean; refused: string | null; recordUrl: string | null }) =>
      reply(id, { content: [{ type: "text", text }], structuredContent: { thread, ...out }, isError: false });
    try {
      const input = { thread, message: `${thread}-${randomUUID().slice(0, 8)}`, text: question, user: deps.user };
      for await (const e of deps.ask(input, { signal: abort.signal, ...(deps.ceiling ? { ceiling: deps.ceiling } : {}) })) {
        if (e.t === "started") run.runId = e.runId;
        else if (e.t === "refused") return result(e.message, { answer: null, withheld: false, refused: e.message, recordUrl: null });
        else if (e.t === "finished") {
          if (e.refusal) return result(`${e.refusal}\n\nRecord: ${e.recordUrl}`, { answer: null, withheld: false, refused: e.refusal, recordUrl: e.recordUrl });
          if (e.withheld) return result(`The answer is above what this client may keep. Read it in the record: ${e.recordUrl}`, { answer: null, withheld: true, refused: null, recordUrl: e.recordUrl });
          const answer = e.answer ?? `(no answer; the run ended ${e.outcome})`;
          return result(`${answer}\n\nRecord: ${e.recordUrl}\nThread: ${thread}`, { answer: e.answer, withheld: false, refused: null, recordUrl: e.recordUrl });
        }
      }
      // Cancelled: the client has stopped waiting, and MCP sends no response to a cancelled request.
      if (!abort.signal.aborted) fail(id, ERR.internal, "the door's events ended before the run finished");
    } catch (err) {
      // The door could not be reached or refused the token: a tool error the model can read and say.
      if (err instanceof DoorError) reply(id, { content: [{ type: "text", text: err.message }], isError: true });
      else fail(id, ERR.internal, err instanceof Error ? err.message : String(err));
    } finally {
      running.delete(id);
    }
  }

  return async (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      return fail(null, ERR.parse, "not JSON");
    }
    const { id, method, params = {} } = msg;
    if (method === "notifications/cancelled") {
      const run = running.get(params.requestId as Id);
      if (run) {
        run.abort.abort();
        if (run.runId) await deps.stop(run.runId).catch(() => {});
      }
      return;
    }
    if (id === undefined) return;
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion = MCP_PROTOCOL_VERSIONS.find((v) => v === asked) ?? MCP_PROTOCOL_VERSIONS[0];
        return reply(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "aliquot", title: "Aliquot", version: ALIQUOT_VERSION } });
      }
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: [ASK_TOOL] });
      case "tools/call":
        return call(id, params);
      default:
        return fail(id, ERR.method, `Aliquot does not implement ${method}`);
    }
  };
}
