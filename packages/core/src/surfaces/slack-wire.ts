/**
 * The Slack door's only reach to the network: Slack's Web API over https and
 * a Socket Mode connection, so a lab machine on a private network needs no
 * public URL. The WebSocket client is written here on node:https's upgrade,
 * because the seal turns the WebSocket global into a stub for every binary.
 *
 * Nothing here decides what Slack may hold. The door does, by the slack
 * surface's placement; slack.ts only relays what the door returns.
 */

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

export const SLACK_API = "https://slack.com/api/";

export class SlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackError";
  }
}

/** https, or http to a loopback host only, so a test can stand in for Slack and a token never crosses a network in clear. */
export function checkApiBase(base: string): URL {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new SlackError(`the Slack API must be https (or http on loopback for a test), not ${url.href}`);
  return url;
}

export type SlackApi = (method: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** One Web API method, JSON in and out. A reply with ok false is thrown with Slack's error code. */
export function slackApi(base: URL, token: string): SlackApi {
  return (method, body) => {
    const url = new URL(method, base);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const payload = Buffer.from(JSON.stringify(body));
    const headers = { "content-type": "application/json; charset=utf-8", "content-length": payload.length, authorization: `Bearer ${token}` };
    return new Promise((resolve, reject) => {
      const req = send(url, { method: "POST", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {
            return reject(new SlackError(`${method} answered ${res.statusCode} with a body that is not JSON`));
          }
          if (json.ok !== true) return reject(new SlackError(`${method}: ${typeof json.error === "string" ? json.error : `HTTP ${res.statusCode}`}`));
          resolve(json);
        });
        res.on("error", reject);
      });
      req.on("error", (err) => reject(new SlackError(`${method}: ${err.message}`)));
      req.end(payload);
    });
  };
}

export interface Socket {
  send(text: string): void;
  close(): void;
  /** Resolves when the connection ends, from either side. */
  readonly closed: Promise<void>;
}

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A client frame, masked as RFC 6455 requires of a client. */
function frame(op: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (len >= 126 && len < 65536) {
    head[0] = 0x80 | op;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else if (len >= 65536) {
    head[0] = 0x80 | op;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, body]);
}

/** A WebSocket client for wss: (or ws: on loopback, for a test). Text messages only, which is all Socket Mode sends. */
export function openSocket(href: string, onText: (text: string, socket: Socket) => void): Promise<Socket> {
  const url = new URL(href);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) return Promise.reject(new SlackError(`Socket Mode must be wss, not ${url.protocol}`));
  const send = url.protocol === "wss:" ? httpsRequest : httpRequest;
  const target = new URL(url.href.replace(/^ws/, "http"));
  const key = randomBytes(16).toString("base64");
  const headers = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": key, "sec-websocket-version": "13" };
  return new Promise((resolve, reject) => {
    const req = send(target, { headers });
    req.on("response", (res) => reject(new SlackError(`Socket Mode answered ${res.statusCode} instead of switching protocols`)));
    req.on("error", (err) => reject(new SlackError(`Socket Mode: ${err.message}`)));
    req.on("upgrade", (res, socket: Duplex, head: Buffer) => {
      const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== accept) {
        socket.destroy();
        return reject(new SlackError("Socket Mode answered with the wrong Sec-WebSocket-Accept"));
      }
      let buf = head;
      let parts: Buffer[] = [];
      let ended = false;
      let done!: () => void;
      const closed = new Promise<void>((r) => (done = r));
      const end = () => {
        if (ended) return;
        ended = true;
        socket.destroy();
        done();
      };
      const write = (op: number, payload: Buffer) => {
        if (!ended) socket.write(frame(op, payload));
      };
      const self: Socket = { send: (text) => write(OP.text, Buffer.from(text, "utf8")), close: () => (write(OP.close, Buffer.alloc(0)), end()), closed };
      const read = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const fin = (buf[0]! & 0x80) !== 0;
          const op = buf[0]! & 0x0f;
          if (buf[1]! & 0x80) return end(); // A server never masks.
          let len = buf[1]! & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === OP.ping) write(OP.pong, payload);
          else if (op === OP.close) {
            write(OP.close, Buffer.alloc(0));
            return end();
          } else if (op === OP.text || op === OP.continuation) {
            parts.push(payload);
            if (fin) {
              const text = Buffer.concat(parts).toString("utf8");
              parts = [];
              onText(text, self);
            }
          }
        }
      };
      socket.on("data", read);
      socket.on("close", end);
      socket.on("error", end);
      resolve(self);
      // Frames that arrived with the upgrade response.
      read(Buffer.alloc(0));
    });
    req.end();
  });
}

/**
 * Socket Mode for as long as the signal is not aborted: open a connection with the app-level token, hand every
 * message to onMessage with a way to answer on the same socket, and open a new one when Slack disconnects or the
 * socket drops. A failed open waits and tries again, longer each time up to a minute.
 */
export async function runSocketMode(api: SlackApi, onMessage: (msg: unknown, reply: (obj: object) => void) => void, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  let wait = 1000;
  while (!signal.aborted) {
    try {
      const opened = await api("apps.connections.open", {});
      if (typeof opened.url !== "string") throw new SlackError("apps.connections.open returned no url");
      const socket = await openSocket(opened.url, (text, self) => {
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return log("[slack] a Socket Mode message that is not JSON was dropped");
        }
        if ((msg as { type?: unknown }).type === "disconnect") self.close();
        else onMessage(msg, (obj) => self.send(JSON.stringify(obj)));
      });
      wait = 1000;
      const stop = () => socket.close();
      signal.addEventListener("abort", stop, { once: true });
      await socket.closed;
      signal.removeEventListener("abort", stop);
    } catch (err) {
      if (signal.aborted) return;
      log(`[slack] ${err instanceof Error ? err.message : String(err)}; trying again in ${wait / 1000} s`);
      await sleep(wait, undefined, { signal }).catch(() => {});
      wait = Math.min(wait * 2, 60_000);
    }
  }
}
