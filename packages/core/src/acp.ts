/**
 * Aliquot as an Agent Client Protocol agent (agentclientprotocol.com, v1):
 * JSON-RPC 2.0, one message per line on stdin and stdout. T3 Code runs it as
 * a "Local ACP command" provider; Zed, JetBrains and other ACP clients run it
 * the same way. Every prompt goes to the web door through door-client.ts, so
 * the gate, the data-class checks and the record are the door's, unchanged.
 *
 * One ACP session is one Aliquot thread, so a follow-up in the same T3 thread
 * carries the earlier turns. A turn streams the tools the run asked for as
 * tool_call updates, then the answer (or the refusal) as one message chunk
 * ending with the record link.
 */

import { randomUUID } from "node:crypto";
import type { DataClass } from "./dataclass.ts";
import type { AskInput, AskOptions, DoorEvent } from "./door-client.ts";

export const ACP_PROTOCOL_VERSION = 1;

/** T3 Code wraps a thread's first prompt in its own instructions; only the person's words go to the door. */
function personText(text: string): string {
  const wrapped = /<user_request>\n([\s\S]*)\n<\/user_request>/.exec(text);
  return wrapped ? wrapped[1]!.trim() : text;
}

export interface AcpDeps {
  readonly ask: (input: AskInput, opts: AskOptions) => AsyncIterable<DoorEvent>;
  readonly stop: (runId: string) => Promise<void>;
  readonly write: (line: string) => void;
  readonly user: string;
  readonly ceiling?: DataClass;
}

interface Session {
  turns: number;
  running: { runId: string | null; abort: AbortController } | null;
}

type Id = string | number;
interface Rpc {
  readonly jsonrpc?: "2.0";
  readonly id?: Id;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const ERR = { parse: -32700, invalid: -32600, method: -32601, params: -32602, internal: -32603 } as const;

/** Returns handle(line): each line is one JSON-RPC message from the client. A prompt's answer is written when its run finishes. */
export function acpAgent(deps: AcpDeps): (line: string) => Promise<void> {
  const sessions = new Map<string, Session>();
  const send = (msg: object) => deps.write(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  const reply = (id: Id, result: unknown) => send({ id, result });
  const fail = (id: Id | null, code: number, message: string) => send({ id, error: { code, message } });
  const update = (sessionId: string, u: object) => send({ method: "session/update", params: { sessionId, update: u } });

  async function prompt(id: Id, params: Record<string, unknown>): Promise<void> {
    const sessionId = String(params.sessionId ?? "");
    const session = sessions.get(sessionId);
    if (!session) return fail(id, ERR.params, `no session ${sessionId}`);
    if (session.running) return fail(id, ERR.invalid, "this session already has a prompt running");
    const blocks = Array.isArray(params.prompt) ? (params.prompt as { type?: string; text?: string }[]) : [];
    const text = personText(
      blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim(),
    );
    if (!text) return fail(id, ERR.params, "Aliquot takes a text prompt; this one has no text block");

    const abort = new AbortController();
    session.running = { runId: null, abort };
    session.turns += 1;
    const say = (t: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
    try {
      let stopReason = "end_turn";
      for await (const e of deps.ask({ thread: sessionId, message: `${sessionId}-${session.turns}`, text, user: deps.user }, { signal: abort.signal, ...(deps.ceiling ? { ceiling: deps.ceiling } : {}) })) {
        if (e.t === "started") session.running.runId = e.runId;
        else if (e.t === "tool") {
          const toolCallId = `${e.runId}-${randomUUID().slice(0, 8)}`;
          update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: e.tool, kind: e.tool.startsWith("kb_") ? "read" : "search", status: "completed" });
        } else if (e.t === "refused") {
          say(e.message);
          stopReason = "refusal";
        } else if (e.t === "finished") {
          if (e.refusal) {
            say(`${e.refusal}\n\nRecord: ${e.recordUrl}`);
            stopReason = "refusal";
          } else if (e.withheld) {
            say(`The answer is ${e.cls ?? "unclassed"}, above what this client may keep${deps.ceiling ? ` (${deps.ceiling})` : ""}. Read it in the record: ${e.recordUrl}`);
          } else {
            say(`${e.answer ?? `(no answer; the run ended ${e.outcome})`}\n\nRecord: ${e.recordUrl}`);
          }
          if (e.outcome === "stopped") stopReason = "cancelled";
        }
      }
      if (abort.signal.aborted) stopReason = "cancelled";
      reply(id, { stopReason });
    } catch (err) {
      fail(id, ERR.internal, err instanceof Error ? err.message : String(err));
    } finally {
      session.running = null;
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
    if (method === "session/cancel") {
      const running = sessions.get(String(params.sessionId ?? ""))?.running;
      if (running) {
        running.abort.abort();
        if (running.runId) await deps.stop(running.runId).catch(() => {});
      }
      return;
    }
    if (id === undefined) return;
    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
          agentInfo: { name: "aliquot", title: "Aliquot", version: "0.5.0" },
          authMethods: [],
        });
      case "authenticate":
        return reply(id, {});
      case "session/new": {
        const sessionId = `acp-${randomUUID()}`;
        sessions.set(sessionId, { turns: 0, running: null });
        return reply(id, { sessionId });
      }
      case "session/prompt":
        return prompt(id, params);
      default:
        return fail(id, ERR.method, `Aliquot does not implement ${method}`);
    }
  };
}
