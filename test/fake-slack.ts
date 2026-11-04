/**
 * A stand-in for Slack: the Web API methods the Slack door calls, and a
 * Socket Mode WebSocket that delivers scripted envelopes and records the
 * door's acks. Every Web API call is recorded with its bearer token.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

export interface ApiCall {
  readonly method: string;
  readonly auth: string | undefined;
  readonly body: Record<string, any>;
}

export interface FakeSlack {
  /** The Web API base, for ALIQUOT_SLACK_API. */
  readonly api: string;
  readonly calls: ApiCall[];
  readonly acks: string[];
  /** Resolves when a door has connected over Socket Mode (again, after a disconnect). */
  connected(): Promise<void>;
  /** Sends one events_api envelope on the open socket; the id is its envelope_id. */
  deliver(id: string, event: Record<string, unknown>, extra?: Record<string, unknown>): void;
  /** Sends a Socket Mode disconnect, as Slack does before it rotates a connection. */
  disconnect(): void;
  waitFor<T>(what: string, probe: () => T | undefined | null | false, ms?: number): Promise<T>;
  close(): Promise<void>;
}

export const TEAM = "T0LAB0";

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, any>) : {};
}

/** An unmasked server frame. */
function frame(op: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, len]) : Buffer.from([0x80 | op, 126, len >> 8, len & 0xff]);
  return Buffer.concat([head, payload]);
}

/** The text of every complete masked client frame in buf, and what is left over. */
function readFrames(buf: Buffer): { texts: { op: number; text: string }[]; rest: Buffer } {
  const texts: { op: number; text: string }[] = [];
  for (;;) {
    if (buf.length < 2) break;
    const op = buf[0]! & 0x0f;
    let len = buf[1]! & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      off = 4;
    }
    if (buf.length < off + 4 + len) break;
    const mask = buf.subarray(off, off + 4);
    const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i]! ^= mask[i % 4]!;
    texts.push({ op, text: payload.toString("utf8") });
    buf = buf.subarray(off + 4 + len);
  }
  return { texts, rest: buf };
}

export async function startFakeSlack(): Promise<FakeSlack> {
  const calls: ApiCall[] = [];
  const acks: string[] = [];
  let socket: Duplex | null = null;
  const sockets = new Set<Duplex>();
  let connections = 0;
  let ts = 1_730_000_000;
  const server = createServer(async (req, res) => {
    const method = (req.url ?? "/").replace(/^\/api\//, "");
    const b = await body(req);
    calls.push({ method, auth: req.headers.authorization, body: b });
    const json = (o: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (method === "apps.connections.open") return json({ ok: true, url: `ws://127.0.0.1:${port}/socket` });
    if (method === "chat.postMessage") return json({ ok: true, channel: b.channel, ts: `${ts++}.000100` });
    if (method === "chat.update") return json({ ok: true, channel: b.channel, ts: b.ts });
    json({ ok: false, error: "unknown_method" });
  });
  server.on("upgrade", (req, s: Duplex) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    s.write(frame(0x1, JSON.stringify({ type: "hello", num_connections: 1 })));
    socket = s;
    sockets.add(s);
    connections++;
    s.on("end", () => s.destroy());
    s.on("close", () => {
      sockets.delete(s);
      if (socket === s) socket = null;
    });
    let buf: Buffer = Buffer.alloc(0);
    s.on("data", (c: Buffer) => {
      const read = readFrames(Buffer.concat([buf, c]));
      buf = read.rest;
      for (const f of read.texts) if (f.op === 0x1) acks.push((JSON.parse(f.text) as { envelope_id: string }).envelope_id);
    });
    s.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const waitFor = async <T>(what: string, probe: () => T | undefined | null | false, ms = 20_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = probe();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`fake Slack: timed out waiting for ${what}`);
      await sleep(25);
    }
  };

  return {
    api: `http://127.0.0.1:${port}/api/`,
    calls,
    acks,
    async connected() {
      const at = connections;
      if (socket && at > 0) return;
      await waitFor("a Socket Mode connection", () => connections > at);
    },
    deliver(id, event, extra = {}) {
      if (!socket) throw new Error("fake Slack: no Socket Mode connection");
      socket.write(frame(0x1, JSON.stringify({ envelope_id: id, type: "events_api", accepts_response_payload: false, payload: { team_id: TEAM, event: { team: TEAM, ...event }, ...extra } })));
    },
    disconnect() {
      const s = socket;
      socket = null;
      s?.write(frame(0x1, JSON.stringify({ type: "disconnect", reason: "refresh_requested" })));
    },
    waitFor,
    async close() {
      for (const s of sockets) s.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
