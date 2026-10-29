/**
 * The runtime half of the egress choke point. The static half,
 * scripts/boundaries.ts, reads the sources; this module makes a route the
 * analysis missed fail when it runs.
 *
 * At load this module takes the platform fetch. The gateway and the tool
 * runner are the only importers of that value (the boundary scanner refuses
 * any other). sealNetwork(), called by each binary before it boots, then
 * leaves the process with no other way to a socket:
 *   - the network globals (fetch, WebSocket, EventSource, XMLHttpRequest)
 *     become non-configurable throwing stubs, so an alias taken later, a
 *     computed lookup, eval or Function all land on the stub;
 *   - the module loader refuses the network builtins and the network
 *     packages for every importer except the files and packages listed in
 *     DEFAULT_ALLOWANCE, through module.registerHooks, which covers import,
 *     import(), require and createRequire;
 *   - process.getBuiltinModule, which bypasses the loader, refuses the same
 *     names; process.binding, _linkedBinding and dlopen are stubbed.
 * A harness plant (--plant-tool) is imported after the seal, so a tool that
 * captures fetch at its own top level captures the stub.
 *
 * Node's permission model closes what JavaScript cannot: run under
 * `node --permission --allow-fs-read=* --allow-net` it denies child_process,
 * worker_threads, native addons and process.binding. It cannot deny the
 * network selectively (--allow-net is all or nothing, and the worker needs
 * Postgres and the model endpoints), which is why this module exists.
 * requireProcessPermission() is how a binary insists on those flags.
 */

import { realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Builtins and packages that open sockets or processes. Specifiers are matched with and without the node: prefix. */
export const NETWORK_MODULES: ReadonlySet<string> = new Set(["http", "https", "http2", "net", "tls", "dns", "dns/promises", "dgram", "cluster", "child_process", "worker_threads", "undici", "ws"]);

/** npm packages that open sockets. The static scanner and the runtime hook both read this one list. */
export const NETWORK_PACKAGES: ReadonlySet<string> = new Set(["pg", "undici", "ws", "axios", "node-fetch", "got", "superagent", "cross-fetch", "openai", "ollama", "ai", "chat"]);
export const NETWORK_PACKAGE_SCOPES: readonly string[] = ["@slack/", "@microsoft/", "@chat-adapter/", "@anthropic-ai/", "@ai-sdk/"];

/** The network module a specifier names (builtin or package, any subpath), or null. */
export function networkModule(specifier: string): string | null {
  const name = bare(specifier);
  if (NETWORK_MODULES.has(name)) return name;
  const pkg = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]!;
  if (NETWORK_PACKAGES.has(pkg) || NETWORK_PACKAGE_SCOPES.some((s) => pkg.startsWith(s))) return pkg;
  return null;
}

/** Judged by where an import lands, so a file path or another package's resolver into node_modules/pg is still pg. */
function networkModuleAt(url: string): string | null {
  if (url.startsWith("node:")) return networkModule(url);
  // Lowercased because a case-insensitive filesystem resolves node_modules/PG to the same files as node_modules/pg.
  const dirs = [...url.toLowerCase().matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)];
  return dirs.length ? networkModule(dirs.at(-1)![1]!) : null;
}

export const NETWORK_GLOBALS = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"] as const;

/** The process's one real fetch, taken when this module loads, before sealNetwork() replaces the global. */
export const platformFetch: typeof fetch = globalThis.fetch;

export class NetworkSealed extends Error {
  constructor(route: string, from?: string) {
    super(`network is sealed in this process: ${route}${from ? ` from ${from}` : ""}. Tools reach the network through ctx.fetch and models through the gateway.`);
    this.name = "NetworkSealed";
  }
}

export interface SealAllowance {
  /** Absolute paths of source files that may load a network module (the HTTP server that listens). */
  readonly files: readonly string[];
  /** npm packages under node_modules that may load a network module (the Postgres client). */
  readonly packages: readonly string[];
}

const here = dirname(fileURLToPath(import.meta.url));

/** Paths, not new URL("./db.ts", import.meta.url): Next's bundler, which the studio runs core inside, rewrites that form into an asset URL. */
export const DEFAULT_ALLOWANCE: SealAllowance = {
  files: [join(here, "surfaces", "web.ts"), join(here, "db.ts"), join(here, "agents", "spawn.ts"), join(here, "agents", "bridge.ts"), join(here, "agents", "proxy.ts"), join(here, "sandbox.ts")],
  packages: ["pg"],
};

/** Core's agent modules. Only core itself may import them: an npm package or a planted tool that reached spawn.ts could start an unconfined child. */
const AGENTS_DIR = `${pathToFileURL(join(here, "agents")).href}/`;
const CORE_ROOT = `${pathToFileURL(dirname(here)).href}/`;

export class CoreInternal extends Error {
  constructor(specifier: string, from: string | undefined) {
    super(`${specifier} is core's agent code and may be imported only from core${from ? `, not from ${from}` : ""}`);
    this.name = "CoreInternal";
  }
}

function bare(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

/**
 * The real directory core's copy of a package lives in, as a file URL prefix. Anchored to that one directory,
 * so a tool file under some other path that merely contains node_modules/pg/ is not mistaken for pg.
 */
function packageRoot(name: string): string {
  const main = coreRequire.resolve(name);
  const marker = `${sep}node_modules${sep}${name}${sep}`;
  const at = main.lastIndexOf(marker);
  if (at < 0) throw new Error(`cannot find the package directory of ${name} from ${main}`);
  return `${pathToFileURL(realpathSync(main.slice(0, at + marker.length))).href}/`;
}

const coreRequire = createRequire(import.meta.url);

let sealed = false;

/** Idempotent: a second call changes nothing. */
export function sealNetwork(allow: SealAllowance = DEFAULT_ALLOWANCE): void {
  if (sealed) return;
  sealed = true;
  const files = new Set(allow.files.map((f) => pathToFileURL(f).href));
  const packageRoots = allow.packages.map(packageRoot);
  const importerAllowed = (parentURL: string | undefined): boolean => parentURL !== undefined && (files.has(parentURL) || packageRoots.some((root) => parentURL.startsWith(root)));
  registerHooks({
    resolve(specifier, context, next) {
      const allowed = importerAllowed(context.parentURL);
      if (networkModule(specifier) && !allowed) throw new NetworkSealed(`module ${specifier}`, context.parentURL);
      const resolved = next(specifier, context);
      if (networkModuleAt(resolved.url) && !allowed) throw new NetworkSealed(`module ${specifier}`, context.parentURL);
      if (resolved.url.startsWith(AGENTS_DIR) && !context.parentURL?.startsWith(CORE_ROOT)) throw new CoreInternal(specifier, context.parentURL);
      return resolved;
    },
  });
  // A plain function, so `new WebSocket(...)` reaches the throw too.
  const stub = (route: string) =>
    function sealed() {
      throw new NetworkSealed(route);
    };
  const freeze = (target: object, name: string, value: unknown) => Object.defineProperty(target, name, { value, writable: false, configurable: false, enumerable: false });
  for (const name of NETWORK_GLOBALS) freeze(globalThis, name, stub(`global ${name}`));
  const builtin = process.getBuiltinModule;
  freeze(process, "getBuiltinModule", (id: string) => {
    if (NETWORK_MODULES.has(bare(id))) throw new NetworkSealed(`process.getBuiltinModule(${JSON.stringify(id)})`);
    return builtin(id);
  });
  for (const name of ["binding", "_linkedBinding", "dlopen"]) freeze(process, name, stub(`process.${name}`));
}

/** How the agent worker is started: the chat worker's flags, plus writes to its session workspaces and child processes for the CLIs. */
export function agentPermissionFlags(workspaces: string): readonly string[] {
  return ["--permission", "--allow-fs-read=*", `--allow-fs-write=${workspaces}`, "--allow-net", "--allow-child-process"];
}

/**
 * Null when the process runs under exactly agentPermissionFlags(workspaces): child processes allowed, worker
 * threads and addons denied, and writes allowed under the workspaces root and nowhere else.
 */
export function requireAgentProcessPermission(workspaces: string): string | null {
  const permission = (process as { permission?: { has(scope: string, reference?: string): boolean } }).permission;
  const flags = `node ${agentPermissionFlags(workspaces).join(" ")}`;
  if (!permission) return `this binary runs only under the permission model: ${flags} <bin> ...`;
  const wrong = [
    ...(permission.has("child") ? [] : ["child processes must be allowed"]),
    ...["worker", "addon"].filter((s) => permission.has(s)).map((s) => `${s} must be denied`),
    ...(permission.has("fs.write", join(workspaces, "probe")) ? [] : [`writes under ${workspaces} must be allowed`]),
    ...(permission.has("fs.write", "/") || permission.has("fs.write", join(dirname(workspaces), `${basename(workspaces)}-outside`)) ? ["writes outside the workspaces root must be denied"] : []),
  ];
  return wrong.length ? `${wrong.join("; ")} (${flags})` : null;
}

/** How the binaries are started. The filesystem stays readable and the network open; everything else the model governs is denied. */
export const PERMISSION_FLAGS = ["--permission", "--allow-fs-read=*", "--allow-net"] as const;

/**
 * Null when the process runs under the permission model with child
 * processes, worker threads and addons denied; otherwise the line a binary
 * prints before it exits.
 */
export function requireProcessPermission(): string | null {
  const permission = (process as { permission?: { has(scope: string): boolean } }).permission;
  const flags = `node ${PERMISSION_FLAGS.join(" ")}`;
  if (!permission) return `this binary runs only under the permission model: ${flags} <bin> ...`;
  const open = ["child", "worker", "addon"].filter((scope) => permission.has(scope));
  return open.length ? `the permission model must deny ${open.join(", ")}: drop --allow-child-process, --allow-worker and --allow-addons (${flags})` : null;
}
