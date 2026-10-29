/**
 * The bridge: the agent CLI's only tools, served on loopback as the subset of
 * MCP streamable HTTP that Claude Code and Codex use. POST /mcp with one
 * JSON-RPC 2.0 message (initialize, notifications/initialized, ping,
 * tools/list, tools/call), answered with application/json, never SSE.
 *
 * A reply carries the AuthorizedRoute that gateway.admit() returned for its
 * content, so a reply that skipped the egress decision does not compile, and
 * the content must be a genuine Labelled at run time.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Labelled, Unlabelled, type AuthorizedRoute } from "../dataclass.ts";
import type { ToolSpec } from "../gateway.ts";

export interface BridgeReply {
  readonly to: AuthorizedRoute;
  readonly content: Labelled<string>;
  readonly isError: boolean;
}

export interface BridgeHandler {
  readonly tools: readonly ToolSpec[];
  call(name: string, args: unknown): Promise<BridgeReply>;
}

export interface BridgeHandle {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type RpcId = string | number;
type Rpc = { readonly jsonrpc: "2.0"; readonly id?: RpcId; readonly method: string; readonly params?: Record<string, unknown> };

function parseRpc(body: unknown): Rpc | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (o.jsonrpc !== "2.0" || typeof o.method !== "string") return null;
  if (o.id !== undefined && typeof o.id !== "string" && typeof o.id !== "number") return null;
  if (o.params !== undefined && (typeof o.params !== "object" || o.params === null || Array.isArray(o.params))) return null;
  return o as Rpc;
}

export async function startBridge(token: string, handler: BridgeHandler): Promise<BridgeHandle> {
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (req: IncomingMessage): boolean => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
  };
  const result = (id: RpcId, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  const failure = (id: RpcId | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  const answer = async (rpc: Rpc & { id: RpcId }): Promise<unknown> => {
    switch (rpc.method) {
      case "initialize": {
        const asked = rpc.params?.protocolVersion;
        const version = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return result(rpc.id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "aliquot", version: "0.2.0" } });
      }
      case "ping":
        return result(rpc.id, {});
      case "tools/list":
        return result(rpc.id, { tools: handler.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": {
        const name = rpc.params?.name;
        if (typeof name !== "string") return failure(rpc.id, -32602, "tools/call needs a tool name");
        const reply = await handler.call(name, rpc.params?.arguments ?? {});
        if (!Labelled.is(reply.content)) throw new Unlabelled("bridge reply");
        return result(rpc.id, { content: [{ type: "text", text: reply.content.value }], isError: reply.isError });
      }
      default:
        return failure(rpc.id, -32601, `method ${rpc.method} is not served`);
    }
  };

  const server = createServer((req, res) => {
    if (req.url !== "/mcp") return send(res, 404);
    if (!authorized(req)) return send(res, 401);
    if (req.method !== "POST") return send(res, 405);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, failure(null, -32700, "the body is not JSON"));
      }
      const rpc = parseRpc(body);
      if (!rpc) return send(res, 400, failure(null, -32600, "one JSON-RPC 2.0 message per request"));
      if (rpc.id === undefined) return send(res, 202);
      answer(rpc as Rpc & { id: RpcId }).then(
        (out) => send(res, 200, out),
        // The error may quote run content, so the CLI gets a fixed message.
        () => send(res, 200, failure(rpc.id!, -32603, "the call failed inside aliquot")),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the bridge has no TCP address");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
