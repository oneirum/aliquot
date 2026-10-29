// Runs inside the seatbelt sandbox in place of an agent CLI. Reads one JSON request on stdin, tries each
// operation, and prints one JSON line naming what happened: a value, or the error code the OS gave.
// node: builtins only, because it is copied alone into an install directory outside the repository.

import { execFile } from "node:child_process";
import { lookup, resolve4 } from "node:dns/promises";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";

interface Req {
  readonly workspace: string;
  readonly reads: Readonly<Record<string, string>>;
  readonly stats: Readonly<Record<string, string>>;
  readonly parentPid: number;
  readonly canary: string;
  readonly pgPort: number;
  readonly bridge: { readonly port: number; readonly token: string };
  readonly proxyPort: number;
  readonly proxyTargets: Readonly<Record<string, string>>;
}

type Outcome = { readonly value: unknown } | { readonly code: string };

const codeOf = (e: unknown): string => String((e as { code?: unknown }).code ?? (e as Error).message);

async function attempt(fn: () => unknown): Promise<Outcome> {
  try {
    return { value: await fn() };
  } catch (e) {
    return { code: codeOf(e) };
  }
}

function readPath(path: string): unknown {
  return statSync(path).isDirectory() ? readdirSync(path).length : readFileSync(path, "utf8").length;
}

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((ok, fail) => execFile(file, args, { timeout: 10_000 }, (err, stdout) => (err ? fail(err) : ok(stdout))));
}

function tcp(host: string, port: number): Promise<string> {
  return new Promise((ok, fail) => {
    const s = connect({ host, port, timeout: 5_000 });
    s.once("connect", () => {
      s.destroy();
      ok("connected");
    });
    s.once("timeout", () => {
      s.destroy();
      fail(Object.assign(new Error("timeout"), { code: "TIMEOUT" }));
    });
    s.once("error", fail);
  });
}

function proxyConnect(port: number, target: string): Promise<string> {
  return new Promise((ok, fail) => {
    const s = connect({ host: "127.0.0.1", port });
    let got = "";
    s.once("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on("data", (b) => (got += b.toString("latin1")));
    s.once("end", () => ok(got.split("\r\n")[0] ?? ""));
    s.once("error", fail);
  });
}

function bridgeCall(port: number, token: string): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe", arguments: {} } });
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` } }, (res) => {
      let text = "";
      res.on("data", (b) => (text += b));
      res.on("end", () => ok({ status: res.statusCode, body: JSON.parse(text) }));
    });
    r.once("error", fail);
    r.end(body);
  });
}

const req = JSON.parse(readFileSync(0, "utf8")) as Req;
const out: Record<string, Outcome> = {};
out.workspace = await attempt(() => {
  writeFileSync(`${req.workspace}/tmp/probe.txt`, "inside");
  return readFileSync(`${req.workspace}/tmp/probe.txt`, "utf8");
});
for (const [name, path] of Object.entries(req.reads)) out[`read:${name}`] = await attempt(() => readPath(path));
for (const [name, path] of Object.entries(req.stats)) out[`stat:${name}`] = await attempt(() => statSync(path).isDirectory());
out.ps = await attempt(async () => (await run("/bin/ps", ["-E", "-ww", "-p", String(req.parentPid)])).includes(req.canary));
out.lookup = await attempt(async () => (await lookup("example.org")).address);
out.resolve = await attempt(() => resolve4("example.org"));
out.pg = await attempt(() => tcp("127.0.0.1", req.pgPort));
out.outside = await attempt(() => tcp("1.1.1.1", 443));
out.open = await attempt(() => run("/usr/bin/open", ["https://example.org"]));
out.bridge = await attempt(() => bridgeCall(req.bridge.port, req.bridge.token));
for (const [name, target] of Object.entries(req.proxyTargets)) out[`proxy:${name}`] = await attempt(() => proxyConnect(req.proxyPort, target));
process.stdout.write(`${JSON.stringify(out)}\n`);
