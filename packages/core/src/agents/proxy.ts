/**
 * The egress proxy an agent CLI reaches the vendor through. HTTP CONNECT on
 * loopback, tunnels only to the kind's vendor hosts on port 443, and only for a
 * TLS ClientHello whose SNI is that host; 403 for anything else. The seatbelt
 * profile lets the CLI connect to this port and the bridge's port only, so the
 * host list is enforced by the OS, not by the CLI. Names are resolved here,
 * outside the sandbox, which is why the CLI needs no DNS.
 */

import { createHash } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";

export interface ProxyHandle {
  readonly port: number;
  /** Hosts a tunnel was opened to, in first-seen order. */
  tunneled(): readonly string[];
  /** Every refused request, counted, and the first MAX_REFUSED_TARGETS distinct targets in fixed form (see fixedTarget). */
  refused(): { readonly count: number; readonly targets: readonly string[] };
  close(): Promise<void>;
}

const MAX_HEAD_BYTES = 8 * 1024;
export const MAX_REFUSED_TARGETS = 20;

/**
 * A refused target is written by the CLI, which has seen the session's data, so it is never kept as written: a
 * host:port that is a plain lowercase hostname stays, anything else becomes a short hash of its bytes.
 */
export function fixedTarget(raw: string): string {
  return /^[a-z0-9.-]{1,253}:\d{1,5}$/.test(raw) ? raw : `sha256:${createHash("sha256").update(raw, "latin1").digest("hex").slice(0, 16)}`;
}

/** The CONNECT target of a request head, or null for anything that is not `CONNECT host:port HTTP/1.x`. */
export function connectTarget(head: string): { readonly host: string; readonly port: number } | null {
  const m = /^CONNECT ([^\s:]+):(\d{1,5}) HTTP\/1\.[01]\r\n/.exec(head);
  return m ? { host: m[1]!.toLowerCase(), port: Number(m[2]) } : null;
}

/** A TLS record's payload is at most 16 KiB; a ClientHello is one record. */
const MAX_HELLO_BYTES = 5 + 16 * 1024;

/**
 * The server name a TLS ClientHello asks for, lowercased: null when the bytes are a ClientHello without one or not a
 * ClientHello at all, "incomplete" while its first record has not all arrived.
 */
export function clientHelloSni(buf: Buffer): string | null | "incomplete" {
  if (buf.length < 5) return "incomplete";
  if (buf[0] !== 0x16) return null;
  const end = 5 + buf.readUInt16BE(3);
  if (buf.length < end) return "incomplete";
  const rec = buf.subarray(5, end);
  let i = 4 + 2 + 32;
  if (rec[0] !== 0x01 || rec.length < i + 1) return null;
  i += 1 + rec[i]!;
  if (rec.length < i + 2) return null;
  i += 2 + rec.readUInt16BE(i);
  if (rec.length < i + 1) return null;
  i += 1 + rec[i]!;
  if (rec.length < i + 2) return null;
  const extEnd = Math.min(rec.length, i + 2 + rec.readUInt16BE(i));
  for (i += 2; i + 4 <= extEnd; ) {
    const type = rec.readUInt16BE(i);
    const len = rec.readUInt16BE(i + 2);
    const body = rec.subarray(i + 4, i + 4 + len);
    if (type === 0 && body.length >= 5 && body[2] === 0) {
      const nameLen = body.readUInt16BE(3);
      return body.length >= 5 + nameLen ? body.subarray(5, 5 + nameLen).toString("latin1").toLowerCase() : null;
    }
    i += 4 + len;
  }
  return null;
}

/** upstreamPort is 443 in every session; a test moves it to reach a local stand-in for a vendor host. */
export async function startProxy(vendorHosts: readonly string[], upstreamPort = 443): Promise<ProxyHandle> {
  const allow = new Set(vendorHosts.map((h) => h.toLowerCase()));
  const tunneled = new Set<string>();
  const refused = new Set<string>();
  let refusedCount = 0;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEAD_BYTES) refuse("oversized-request");
        return;
      }
      client.off("data", onData);
      const text = head.subarray(0, end + 4).toString("latin1");
      const target = connectTarget(text);
      if (!target || target.port !== upstreamPort || !allow.has(target.host)) {
        refuse(target ? `${target.host}:${target.port}` : text.split("\r\n")[0]!);
        return;
      }
      // Nothing goes upstream until the ClientHello names the host the CONNECT did: a shared edge routes by SNI.
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let hello = head.subarray(end + 4);
      const onHello = (chunk?: Buffer) => {
        if (chunk) hello = Buffer.concat([hello, chunk]);
        const sni = clientHelloSni(hello);
        if (sni === "incomplete" && hello.length <= MAX_HELLO_BYTES) return;
        client.off("data", onHello);
        client.pause();
        if (sni !== target.host) {
          count(`${sni === "incomplete" || sni === null ? "no-sni" : sni}:${target.port}`);
          client.destroy();
          return;
        }
        const upstream = connect(target.port, target.host);
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        upstream.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
        upstream.once("connect", () => {
          tunneled.add(target.host);
          upstream.write(hello);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        client.on("close", () => upstream.destroy());
      };
      client.on("data", onHello);
      onHello();
    };
    const count = (what: string) => {
      refusedCount += 1;
      if (refused.size < MAX_REFUSED_TARGETS) refused.add(fixedTarget(what));
    };
    const refuse = (what: string) => {
      count(what);
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the egress proxy has no TCP address");
  return {
    port: address.port,
    tunneled: () => [...tunneled],
    refused: () => ({ count: refusedCount, targets: [...refused] }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
