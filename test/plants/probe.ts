/**
 * The runtime census: every way JavaScript in a sealed process could reach a
 * socket, tried for real. test/seal.test.ts runs it in a sealed child and
 * slice check 12 runs it inside a planted tool in a sealed worker. A route
 * that resolves is a leak; one that throws is refused.
 *
 * This file is a test fixture outside the boundary scanner's roots, which
 * is why it may name fetch, eval and the network builtins at all.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A tool cannot name pg (it is core's dependency, not the tool's), but it can reach core's copy through a resolver or a path.
const corePackages = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const caseInsensitive = existsSync(fileURLToPath(import.meta.url).replace(/probe\.ts$/, "PROBE.TS"));

export interface ProbeReport {
  readonly refused: readonly { readonly route: string; readonly error: string }[];
  readonly leaked: readonly string[];
  /** How many routes were tried, so a check can assert all of them were refused on any platform. */
  readonly total: number;
  /** What the permission model says about this process, or null when it is off. */
  readonly permission: { readonly child: boolean; readonly worker: boolean; readonly addon: boolean } | null;
}

// Taken when this module loads. A tool module is imported after the seal, so this is the stub.
const fetchAtLoad = globalThis.fetch;

const BODY = JSON.stringify({ model: "hosted-2", messages: [{ role: "user", content: "leak" }] });
const post = (f: typeof fetch, url: string) => f(url, { method: "POST", headers: { "content-type": "application/json" }, body: BODY });

export async function probeRoutes(url: string, pgLookalike?: string): Promise<ProbeReport> {
  const g = globalThis as unknown as Record<string, (...args: unknown[]) => unknown>;
  const proc = process as unknown as Record<string, (...args: unknown[]) => unknown>;
  const routes: Record<string, () => Promise<unknown>> = {
    "fetch at call time": () => post(fetch, url),
    "fetch taken at module load": () => post(fetchAtLoad, url),
    "globalThis by a computed key": () => post(g["fe" + "tch"] as typeof fetch, url),
    "Reflect.get on the global object": () => post(Reflect.get(globalThis, "fetch") as typeof fetch, url),
    "the property descriptor": () => post(Object.getOwnPropertyDescriptor(globalThis, "fetch")!.value as typeof fetch, url),
    "new Function": () => (new Function("u", "b", "return fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b })") as (u: string, b: string) => Promise<unknown>)(url, BODY),
    "indirect eval": () => post((0, eval)("fetch") as typeof fetch, url),
    "new WebSocket": async () => new WebSocket(url.replace(/^http/, "ws")),
    "process.getBuiltinModule(node:net)": async () => process.getBuiltinModule("node:net"),
    "createRequire(node:net)": async () => createRequire(import.meta.url)("node:net"),
    "process.binding(tcp_wrap)": async () => proc.binding!("tcp_wrap"),
    "process.dlopen": async () => proc.dlopen!({}, "none.node"),
    "import(pg) by its file path": () => import(pathToFileURL(corePackages.resolve("pg")).href),
    "require(pg) through core's resolver": async () => corePackages("pg"),
  };
  // On a case-insensitive filesystem node_modules/PG is the same files as node_modules/pg under a different URL.
  if (caseInsensitive) routes["import(pg) through an upper-case path"] = () => import(pathToFileURL(corePackages.resolve("pg").replace(`${sep}node_modules${sep}pg${sep}`, `${sep}node_modules${sep}PG${sep}`)).href);
  // A file outside pg whose path merely contains node_modules/pg/, written by the parent because this process cannot write.
  if (pgLookalike) routes["a file under a path containing node_modules/pg/"] = () => import(pathToFileURL(pgLookalike).href);
  for (const m of ["node:http", "node:https", "node:net", "node:tls", "node:dns", "node:dgram", "node:child_process", "node:worker_threads", "http", "undici", "ws"]) routes[`import(${m})`] = () => import(m);
  const refused: { route: string; error: string }[] = [];
  const leaked: string[] = [];
  for (const [route, attempt] of Object.entries(routes)) {
    try {
      await attempt();
      leaked.push(route);
    } catch (err) {
      refused.push({ route, error: err instanceof Error ? `${err.name}: ${err.message.slice(0, 80)}` : String(err) });
    }
  }
  const permission = (process as { permission?: { has(scope: string): boolean } }).permission;
  return { refused, leaked, total: Object.keys(routes).length, permission: permission ? { child: permission.has("child"), worker: permission.has("worker"), addon: permission.has("addon") } : null };
}
