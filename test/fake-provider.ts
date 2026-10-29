/**
 * A fake provider for the native adapters: it answers each request with the next queued fixture body for its
 * method and path, and records what it was sent. No live provider is ever called.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";

export interface Reply {
  readonly status?: number;
  readonly body: unknown;
}

export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
  /** The body as it came over the wire, for byte-level checks. */
  readonly raw: string;
}

export interface FakeProvider {
  readonly url: string;
  readonly sent: readonly SentRequest[];
  /** Queue the replies for "METHOD /path" (the path with its query string), served in order. */
  reply(route: string, ...replies: Reply[]): void;
  close(): Promise<void>;
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const queues = new Map<string, Reply[]>();
  const sent: SentRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const route = `${req.method} ${req.url}`;
    sent.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: text ? JSON.parse(text) : null, raw: text });
    const next = queues.get(route)?.shift();
    res.writeHead(next?.status ?? (next ? 200 : 404), { "content-type": "application/json" });
    res.end(JSON.stringify(next?.body ?? { error: `no reply queued for ${route}` }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    reply(route, ...replies) {
      queues.set(route, [...(queues.get(route) ?? []), ...replies]);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
