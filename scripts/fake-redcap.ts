#!/usr/bin/env node
/**
 * A fake REDCap API for the checks and the data walk: one project and the
 * exports data_query reads. REDCap's API is one URL taking a POST form with
 * the project's token:
 *   content=metadata  the data dictionary as JSON (identifier "y" flags an identifier)
 *   content=user      the project's users with their export rights and Data Access Group
 *   content=dag       the project's Data Access Groups
 *   content=record    the records as flat CSV, only the fields asked for (fields[0], fields[1], ...),
 *                     with redcap_data_access_group after the record id when exportDataAccessGroups=true
 * Any other request is answered the way REDCap answers it: 403 for a wrong
 * token, 400 for a content, format or field this fake does not serve. A live
 * REDCap takes the same requests with a real token named in lab.toml. The
 * records fixture has no quoted cells, so this fake splits on commas.
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

export interface RedcapUser {
  readonly username: string;
  readonly expiration: string;
  readonly data_access_group: string;
  readonly data_export: string;
  readonly forms_export?: Readonly<Record<string, number>>;
}

export interface RedcapProject {
  readonly token: string;
  /** Every record as REDCap holds it: a flat CSV whose second column is redcap_data_access_group. */
  readonly recordsCsv: string;
  readonly metadata: readonly { readonly field_name: string; readonly identifier?: string }[];
  readonly users: readonly RedcapUser[];
  readonly dags: readonly { readonly data_access_group_name: string; readonly unique_group_name: string; readonly data_access_group_id: number }[];
}

const DATA = new URL("../fixtures/lab0/data/", import.meta.url);

/** lab0's dosing project, from fixtures/lab0/data: 30 records in two DAGs and four users. */
export async function lab0Dosing(token: string): Promise<RedcapProject> {
  return {
    token,
    recordsCsv: await readFile(new URL("redcap-dosing-records.csv", DATA), "utf8"),
    metadata: JSON.parse(await readFile(new URL("redcap-dosing-metadata.json", DATA), "utf8")),
    users: JSON.parse(await readFile(new URL("redcap-dosing-users.json", DATA), "utf8")),
    dags: [
      { data_access_group_name: "Madison", unique_group_name: "madison", data_access_group_id: 1 },
      { data_access_group_name: "Milwaukee", unique_group_name: "milwaukee", data_access_group_id: 2 },
    ],
  };
}

async function form(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

const DAG = "redcap_data_access_group";

/** The flat records export: the asked-for fields in dictionary order (all of them when none is asked for), the DAG column on request. */
function records(project: RedcapProject, f: Record<string, string>): { ok: true; csv: string } | { ok: false; error: string } {
  const [head, ...lines] = project.recordsCsv.trimEnd().split("\n");
  const header = head!.split(",");
  const asked = Object.entries(f).filter(([k]) => /^fields\[\d+\]$/.test(k)).map(([, v]) => v);
  const known = new Set(project.metadata.map((m) => m.field_name));
  const unknown = asked.filter((a) => !known.has(a));
  if (unknown.length) return { ok: false, error: `The following values in the parameter "fields" are not valid: ${unknown.join(", ")}` };
  const recordId = project.metadata[0]!.field_name;
  const fields = asked.length ? project.metadata.map((m) => m.field_name).filter((n) => asked.includes(n)) : project.metadata.map((m) => m.field_name);
  const lead = fields.includes(recordId) ? [recordId] : [];
  const out = [...lead, ...(f.exportDataAccessGroups === "true" ? [DAG] : []), ...fields.filter((n) => n !== recordId)];
  const at = out.map((c) => header.indexOf(c));
  return { ok: true, csv: [out.join(","), ...lines.map((l) => ((cells) => at.map((i) => cells[i] ?? "").join(","))(l.split(",")))].join("\n") + "\n" };
}

export async function startFakeRedcap(project: RedcapProject, at: { readonly port: number; readonly host: string } = { port: 0, host: "127.0.0.1" }): Promise<FakeRedcap> {
  const requests: Record<string, string>[] = [];
  const server = createServer(async (req, res) => {
    const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
    const json = (status: number, body: unknown) => send(status, "application/json", JSON.stringify(body));
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://x").pathname !== "/api/") return send(404, "text/plain", "not found");
    const f = await form(req);
    const { token, ...rest } = f;
    requests.push({ ...rest, token: token === project.token ? "valid" : "invalid" });
    if (token !== project.token) return json(403, { error: "You do not have permissions to use the API" });
    if (f.content === "metadata" && f.format === "json") return json(200, project.metadata);
    if (f.content === "user" && f.format === "json") return json(200, project.users);
    if (f.content === "dag" && f.format === "json") return json(200, project.dags);
    if (f.content === "record" && f.format === "csv" && (f.type ?? "flat") === "flat") {
      const r = records(project, f);
      return r.ok ? send(200, "text/csv; charset=utf-8", r.csv) : json(400, { error: r.error });
    }
    return json(400, { error: `this fake serves content=metadata, user and dag as json and content=record as csv, not content=${f.content} format=${f.format}` });
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
