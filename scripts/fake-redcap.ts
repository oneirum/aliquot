#!/usr/bin/env node
/**
 * A fake REDCap API for the checks and the data walk: one project, the two
 * exports data_query reads. REDCap's API is one URL taking a POST form
 * with the project's token; `content=metadata` returns the data dictionary
 * as JSON (a field with identifier "y" is flagged as an identifier), and
 * `content=record&format=csv&type=flat` returns the records as CSV. Any
 * other request is answered the way REDCap answers it: 403 for a wrong
 * token, 400 for a content or format this fake does not serve. A live
 * REDCap takes the same requests with a real token named in lab.toml.
 *
 *   node scripts/fake-redcap.ts [--port 8103]
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";

export interface FakeRedcap {
  /** The API URL, ending in /api/, as lab.toml's redcap_url names it. */
  readonly url: string;
  /** Each request's form fields, the token replaced by whether it matched. */
  readonly requests: readonly Record<string, string>[];
  close(): Promise<void>;
}

export interface RedcapProject {
  readonly token: string;
  /** The flat records export, as REDCap writes it. */
  readonly recordsCsv: string;
  readonly metadata: readonly { readonly field_name: string; readonly identifier?: string }[];
}

const DATA = new URL("../fixtures/lab0/data/", import.meta.url);

/** lab0's dosing project, from fixtures/lab0/data. */
export async function lab0Dosing(token: string): Promise<RedcapProject> {
  return {
    token,
    recordsCsv: await readFile(new URL("redcap-dosing-records.csv", DATA), "utf8"),
    metadata: JSON.parse(await readFile(new URL("redcap-dosing-metadata.json", DATA), "utf8")),
  };
}

async function form(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

export async function startFakeRedcap(project: RedcapProject, at: { readonly port: number; readonly host: string } = { port: 0, host: "127.0.0.1" }): Promise<FakeRedcap> {
  const requests: Record<string, string>[] = [];
  const server = createServer(async (req, res) => {
    const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://x").pathname !== "/api/") return send(404, "text/plain", "not found");
    const f = await form(req);
    const { token, ...rest } = f;
    requests.push({ ...rest, token: token === project.token ? "valid" : "invalid" });
    if (token !== project.token) return send(403, "application/json", JSON.stringify({ error: "You do not have permissions to use the API" }));
    if (f.content === "metadata" && f.format === "json") return send(200, "application/json", JSON.stringify(project.metadata));
    if (f.content === "record" && f.format === "csv" && (f.type ?? "flat") === "flat") return send(200, "text/csv; charset=utf-8", project.recordsCsv);
    return send(400, "application/json", JSON.stringify({ error: `this fake serves content=metadata format=json and content=record format=csv, not content=${f.content} format=${f.format}` }));
  });
  await new Promise<void>((resolve) => server.listen(at.port, at.host, resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://${at.host}:${port}/api/`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const token = process.env.LAB0_REDCAP_TOKEN;
  if (!token) throw new Error("set LAB0_REDCAP_TOKEN to the token the fake should accept");
  const fake = await startFakeRedcap(await lab0Dosing(token), { port: i > 0 ? Number(process.argv[i + 1]) : 8103, host: "127.0.0.1" });
  console.log(`[fake-redcap] lab0 dosing project at ${fake.url}`);
  const stop = () => void fake.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
