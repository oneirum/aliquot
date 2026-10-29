/**
 * The boundary scanner: the static half of "one egress choke point". It
 * builds a TypeScript program over every .ts, .js, .mjs and .cjs file under
 * packages, scripts and bin, and reports each node that reaches the
 * network, loads code, decides egress, brands by cast or stamps a class
 * outside the file allowed to, by the file's path from the repository root.
 *
 * It reads bound symbols, not text: `fetch` is a violation when the
 * identifier resolves to the global (or to nothing), wherever it appears
 * and whatever it is called through; `ctx.fetch` resolves to ToolContext
 * and is fine. What cannot be resolved statically is banned outright: a
 * computed module specifier, a computed or aliased use of the global
 * object, eval and Function.
 *
 * The runtime half is packages/core/src/seal.ts. test/boundaries.test.ts
 * proves every PLANTS entry is reported by this scanner; test/seal.test.ts
 * and slice check 12 prove the same routes fail at runtime.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import ts from "typescript";
import { NETWORK_GLOBALS, networkModule } from "../packages/core/src/seal.ts";

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

/**
 * What a file may do. A file not listed here may do none of these. A key is
 * the path from the repository root, so a file named gateway.ts anywhere
 * else has no allowance.
 */
type Capability = "network-globals" | "global-object" | "platform-fetch" | "node:module" | "computed-specifier" | "egress-decision" | "brand-cast" | "stamp" | `module:${string}`;

const ALLOWED: Readonly<Record<string, readonly Capability[]>> = {
  "packages/core/src/seal.ts": ["network-globals", "global-object", "node:module"],
  "packages/core/src/gateway.ts": ["platform-fetch", "egress-decision"],
  "packages/core/src/tools.ts": ["platform-fetch", "egress-decision", "computed-specifier", "stamp"],
  "packages/core/src/surfaces/web.ts": ["module:http"],
  // run_code's Docker Engine client, over the daemon's unix socket.
  "packages/core/src/sandbox.ts": ["module:http"],
  // The agent worker: the one spawn in core, the loopback MCP server, and the CONNECT proxy.
  "packages/core/src/agents/spawn.ts": ["module:child_process"],
  "packages/core/src/agents/bridge.ts": ["module:http"],
  "packages/core/src/agents/proxy.ts": ["module:net"],
  "packages/core/src/agents/session.ts": ["stamp"],
  "packages/core/src/db.ts": ["module:pg"],
  "packages/core/src/dataclass.ts": ["egress-decision", "brand-cast"],
  "packages/core/src/frontdoor.ts": ["egress-decision"],
  "packages/core/src/record.ts": ["egress-decision", "stamp"],
  "packages/core/src/replay.ts": ["egress-decision"],
  "packages/core/src/gate.ts": ["stamp"],
  "packages/core/src/kb.ts": ["stamp"],
  "packages/core/src/kb-compile.ts": ["stamp"],
  "packages/core/src/agent.ts": ["stamp"],
  "packages/core/src/loop.ts": ["stamp"],
  // The slice harness spawns the binaries and drives them over HTTP. It is not deployed.
  "scripts/slice1.ts": ["network-globals", "module:child_process"],
  "scripts/procs.ts": ["network-globals", "module:child_process"],
  "scripts/unit3.ts": ["module:http"],
  "scripts/record-demo.ts": ["module:child_process"],
  "scripts/agent-demo.ts": ["module:child_process"],
  "scripts/unit2.ts": ["network-globals", "module:child_process", "module:net"],
  // One booted core per studio server, kept across Next's dev reloads of this module.
  "packages/studio/core.ts": ["global-object"],
  // Browser code: these run in the author's browser and call the studio's own API.
  "packages/studio/components/PublishPanel.tsx": ["network-globals"],
  "packages/studio/components/TestThread.tsx": ["network-globals"],
  "packages/studio/components/KbPanel.tsx": ["network-globals"],
};

/**
 * The studio runs in Next, outside the permission model and the seal, so it
 * reaches core through one entry that holds no model gateway and no tool
 * runner. Every other path into core is a violation there. A studio
 * specifier is resolved the way the bundler resolves it, through
 * node_modules symlinks to the real file, so no spelling of a core path
 * gets past this.
 */
const STUDIO_ROOT = "packages/studio/";
const STUDIO_CORE_ENTRY = "@labh/core/studio";
const STUDIO_CORE_FILE = "packages/core/src/studio.ts";

const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "global", "self", "window"]);
const DYNAMIC_CODE: ReadonlySet<string> = new Set(["eval", "Function"]);
const PROCESS_ESCAPES: ReadonlySet<string> = new Set(["binding", "_linkedBinding", "dlopen"]);
const BRANDS: ReadonlySet<string> = new Set(["ResolvedAgent", "AuthorizedRoute", "Authorized", "Labelled", "Prompt"]);

const SCAN_ROOTS = ["packages", "scripts", "bin"];
const SCANNED = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SCANNED.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const posix = (p: string): string => p.split(sep).join("/");

/**
 * Scans the repository at root. overlay adds or replaces files by their
 * repository-relative path without touching disk, which is how the tests
 * plant a route and prove it is reported.
 */
export function scanBoundaries(root: string, overlay: ReadonlyMap<string, string> = new Map()): Violation[] {
  const rel = (file: string): string => posix(relative(root, file));
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options: ts.CompilerOptions = { ...parsed.options, allowJs: true, checkJs: false, noEmit: true, strict: false };
  const onDisk = SCAN_ROOTS.flatMap((d) => walk(join(root, d))).filter((f) => !overlay.has(rel(f)));
  const files = [...onDisk, ...[...overlay.keys()].map((k) => join(root, k))].sort();
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile;
  const fileExists = host.fileExists;
  host.readFile = (f) => overlay.get(rel(f)) ?? readFile(f);
  host.fileExists = (f) => overlay.has(rel(f)) || fileExists(f);
  host.getCurrentDirectory = () => root;
  const program = ts.createProgram(files, options, host);
  const checker = program.getTypeChecker();
  const out: Violation[] = [];
  /** Where a specifier in a file lands on disk, from the repository root, after symlinks; null when it does not resolve to a file. */
  const resolveSpec = (spec: string, fromFile: string): string | null => {
    const found = ts.resolveModuleName(spec, fromFile, options, host).resolvedModule?.resolvedFileName ?? (isAbsolute(spec) ? spec : null);
    if (found === null) return null;
    try {
      return rel(realpathSync(found));
    } catch {
      return rel(found);
    }
  };
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !files.includes(sf.fileName)) continue;
    scanFile(sf, rel(sf.fileName), checker, out, resolveSpec);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

function scanFile(sf: ts.SourceFile, file: string, checker: ts.TypeChecker, out: Violation[], resolveSpec: (spec: string, fromFile: string) => string | null): void {
  const allowed = ALLOWED[file] ?? [];
  const report = (node: ts.Node, rule: string, needs: Capability | null) => {
    if (needs !== null && allowed.includes(needs)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const text = sf.text.split("\n")[line]?.trim() ?? "";
    out.push({ file, line: line + 1, rule, text });
  };
  const commonJs = file.endsWith(".cjs");

  /** True for a value reference to something declared only in lib or @types (or to nothing). A local declaration of the same name is not the global. */
  const isGlobalRef = (id: ts.Identifier): boolean => {
    const sym = ts.isShorthandPropertyAssignment(id.parent) ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
    if (!sym) return true;
    const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const decls = target.declarations ?? [];
    return decls.length === 0 || decls.every((d) => d.getSourceFile().isDeclarationFile);
  };
  const inType = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isTypeNode(p) || ts.isTypeQueryNode(p)) return true;
    return false;
  };
  /** The identifier is used as a value, not as the name of a property, member, parameter or import it declares. */
  const isValueUse = (id: ts.Identifier): boolean => {
    const p = id.parent;
    if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
    if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isEnumMember(p)) && p.name === id) return false;
    if (ts.isBindingElement(p) && p.propertyName === id) return false;
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
    if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name === id) return false;
    return !inType(id);
  };
  const literal = (n: ts.Expression | undefined): string | null => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
  const specifier = (spec: string | null, node: ts.Node) => {
    if (spec === null) return;
    if (file.startsWith(STUDIO_ROOT) && spec !== STUDIO_CORE_ENTRY) {
      const target = resolveSpec(spec, sf.fileName);
      const named = spec === "@labh/core" || spec.startsWith("@labh/core/") || (spec.startsWith(".") && posix(join(file, "..", spec)).startsWith("packages/core/"));
      if (named || (target !== null && target.startsWith("packages/core/") && target !== STUDIO_CORE_FILE)) report(node, `studio import of core outside ${STUDIO_CORE_ENTRY}`, null);
    }
    if (spec === "module" || spec === "node:module") return report(node, "node:module import", "node:module");
    const name = networkModule(spec);
    if (name !== null) report(node, `network module ${spec}`, `module:${name}`);
  };
  const calleeName = (callee: ts.Expression): string | null => (ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null);
  /** The declared name behind a callee, through import aliases and local variables. */
  const calleeDeclaredName = (callee: ts.Expression): string | null => checker.getTypeAtLocation(callee).symbol?.name ?? null;

  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      specifier(literal(n.moduleSpecifier), n);
      if (ts.isImportDeclaration(n) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
        for (const el of n.importClause.namedBindings.elements) {
          if ((el.propertyName ?? el.name).text === "platformFetch") report(el, "platformFetch import", "platform-fetch");
          if ((el.propertyName ?? el.name).text === "createRequire") report(el, "createRequire import", "node:module");
        }
      }
    }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) specifier(literal(n.moduleReference.expression), n);
    if (ts.isCallExpression(n)) {
      const loader = n.expression.kind === ts.SyntaxKind.ImportKeyword || ["require", "getBuiltinModule"].includes(calleeName(n.expression) ?? "");
      const first = n.arguments[0];
      const spec = literal(first);
      if (loader && spec === null) report(n, "computed module specifier", "computed-specifier");
      // Any call whose first argument names a network module is a load, whatever the callee is named: createRequire(...)(x), r(x).
      else if (spec !== null && (loader || networkModule(spec) !== null)) specifier(spec, n);
    }
    if (ts.isIdentifier(n) && isValueUse(n) && isGlobalRef(n)) {
      const name = n.text;
      if ((NETWORK_GLOBALS as readonly string[]).includes(name)) report(n, `global ${name} reference`, "network-globals");
      if (DYNAMIC_CODE.has(name)) report(n, `${name} reference`, null);
      if (name === "createRequire") report(n, "createRequire reference", "node:module");
      if (GLOBAL_OBJECTS.has(name)) {
        const p = n.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === n) {
          if ((NETWORK_GLOBALS as readonly string[]).includes(p.name.text)) report(p, `global ${p.name.text} through ${name}`, "network-globals");
          else if (DYNAMIC_CODE.has(p.name.text)) report(p, `${p.name.text} through ${name}`, null);
        } else report(n, `${name} used as a value`, "global-object");
      }
      if (name === "process" && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && PROCESS_ESCAPES.has(n.parent.name.text)) report(n.parent, `process.${n.parent.name.text}`, null);
    }
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && GLOBAL_OBJECTS.has(n.expression.text) && isGlobalRef(n.expression)) report(n, `computed access on ${n.expression.text}`, "global-object");
    if (ts.isCallExpression(n) && (calleeName(n.expression) === "decideEgress" || calleeDeclaredName(n.expression) === "decideEgress")) report(n, "decideEgress call outside its call sites", "egress-decision");
    if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && ts.isTypeReferenceNode(n.type) && ts.isIdentifier(n.type.typeName) && BRANDS.has(n.type.typeName.text)) report(n, `brand by cast to ${n.type.typeName.text}`, "brand-cast");
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "stamp") {
      const receiver = checker.getTypeAtLocation(n.expression.expression);
      if (receiver.symbol?.name === "Labelled") report(n, "Labelled.stamp outside an origin", "stamp");
    }
    if (commonJs && n.kind === ts.SyntaxKind.ThisKeyword && !insideClassMember(n)) report(n, "this in a CommonJS file reaches the global object", null);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function insideClassMember(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isClassLike(p)) return true;
  return false;
}

/** One planted route per way around the choke point. Each must be reported in its file under this rule, and nothing else may be. */
export interface Plant {
  readonly name: string;
  readonly file: string;
  readonly code: string;
  readonly rule: string;
}

export const PLANTS: readonly Plant[] = [
  { name: "a direct call", file: "packages/core/src/loop.ts", code: 'export const leak1 = () => fetch("http://example.org/");', rule: "global fetch reference" },
  { name: "an alias", file: "packages/core/src/loop.ts", code: "export const leak2 = fetch;", rule: "global fetch reference" },
  { name: "a shorthand property", file: "packages/core/src/loop.ts", code: "export const leak3 = { fetch };", rule: "global fetch reference" },
  { name: "the global object", file: "packages/core/src/loop.ts", code: 'export const leak4 = () => globalThis.fetch("http://example.org/");', rule: "global fetch through globalThis" },
  { name: "the global object by key", file: "packages/core/src/loop.ts", code: 'export const leak5 = () => globalThis["fetch"]("http://example.org/");', rule: "computed access on globalThis" },
  { name: "a computed key", file: "packages/core/src/loop.ts", code: 'export const leak6 = () => globalThis["fe" + "tch"]("http://example.org/");', rule: "computed access on globalThis" },
  { name: "an alias of the global object", file: "packages/core/src/loop.ts", code: "export const leak7 = globalThis;", rule: "globalThis used as a value" },
  { name: "destructuring the global object", file: "packages/core/src/loop.ts", code: "export const { WebSocket: leak8 } = globalThis;", rule: "globalThis used as a value" },
  { name: "global through Reflect", file: "packages/core/src/loop.ts", code: 'export const leak9 = Reflect.get(global, "fetch");', rule: "global used as a value" },
  { name: "WebSocket", file: "packages/core/src/loop.ts", code: 'export const leak10 = () => new WebSocket("ws://example.org/");', rule: "global WebSocket reference" },
  { name: "EventSource", file: "packages/core/src/loop.ts", code: 'export const leak11 = () => new EventSource("http://example.org/");', rule: "global EventSource reference" },
  { name: "XMLHttpRequest, which Node does not even declare", file: "packages/core/src/loop.ts", code: "export const leak12 = () => new XMLHttpRequest();", rule: "global XMLHttpRequest reference" },
  { name: "eval", file: "packages/core/src/loop.ts", code: 'export const leak13 = () => eval("fetch");', rule: "eval reference" },
  { name: "the Function constructor", file: "packages/core/src/loop.ts", code: 'export const leak14 = () => new Function("return fetch")();', rule: "Function reference" },
  { name: "a static import", file: "packages/core/src/loop.ts", code: 'import * as leak15 from "node:http";', rule: "network module node:http" },
  { name: "a static import split over lines", file: "packages/core/src/loop.ts", code: 'import leak16\n  from "node:https";', rule: "network module node:https" },
  { name: "a side-effect import", file: "packages/core/src/loop.ts", code: 'import "node:net";', rule: "network module node:net" },
  { name: "a re-export", file: "packages/core/src/loop.ts", code: 'export * from "node:tls";', rule: "network module node:tls" },
  { name: "a dynamic import", file: "packages/core/src/loop.ts", code: 'export const leak19 = () => import("node:dns");', rule: "network module node:dns" },
  { name: "a dynamic import without the prefix", file: "packages/core/src/loop.ts", code: 'export const leak20 = () => import("dgram");', rule: "network module dgram" },
  { name: "child_process", file: "packages/core/src/loop.ts", code: 'export const leak21 = () => import("node:child_process");', rule: "network module node:child_process" },
  { name: "worker_threads", file: "packages/core/src/loop.ts", code: 'export const leak22 = () => import("node:worker_threads");', rule: "network module node:worker_threads" },
  { name: "undici", file: "packages/core/src/loop.ts", code: 'export const leak23 = () => import("undici");', rule: "network module undici" },
  { name: "ws", file: "packages/core/src/loop.ts", code: 'export const leak24 = () => import("ws");', rule: "network module ws" },
  { name: "a builtin lookup", file: "packages/core/src/loop.ts", code: 'export const leak25 = () => process.getBuiltinModule("node:net");', rule: "network module node:net" },
  { name: "createRequire", file: "packages/core/src/loop.ts", code: 'import { createRequire as leak26 } from "node:module";', rule: "node:module import" },
  { name: "a computed specifier", file: "packages/core/src/loop.ts", code: "export const leak27 = (m: string) => import(`node:${m}`);", rule: "computed module specifier" },
  { name: "process.binding", file: "packages/core/src/loop.ts", code: 'export const leak28 = () => process.binding("tcp_wrap");', rule: "process.binding" },
  { name: "the Postgres client outside db.ts", file: "packages/core/src/loop.ts", code: 'import leak29 from "pg";', rule: "network module pg" },
  { name: "a vendor SDK", file: "packages/core/src/loop.ts", code: 'import leak30 from "openai";', rule: "network module openai" },
  { name: "a scoped vendor SDK", file: "packages/core/src/loop.ts", code: 'import leak31 from "@slack/web-api";', rule: "network module @slack/web-api" },
  { name: "the platform fetch outside the gateway and the tool runner", file: "packages/core/src/loop.ts", code: 'import { platformFetch as leak32 } from "./seal.ts";', rule: "platformFetch import" },
  { name: "a file named gateway.ts in another directory", file: "packages/core/src/surfaces/gateway.ts", code: 'export const leak = () => fetch("http://example.org/");', rule: "global fetch reference" },
  { name: "a plain JavaScript file", file: "packages/core/src/leak.mjs", code: 'export const leak = () => fetch("http://example.org/");', rule: "global fetch reference" },
  { name: "a CommonJS require", file: "packages/core/src/leak.cjs", code: 'module.exports = () => require("node:net");', rule: "network module node:net" },
  { name: "this in CommonJS", file: "packages/core/src/sloppy.cjs", code: "module.exports = function () { return this; };", rule: "this in a CommonJS file reaches the global object" },
  { name: "the worker binary", file: "packages/core/bin/leak.ts", code: 'export const leak = () => import("node:child_process");', rule: "network module node:child_process" },
  { name: "a script", file: "scripts/leak.ts", code: 'export const leak = () => import("node:http");', rule: "network module node:http" },
  { name: "the studio importing core's root", file: "packages/studio/leak.ts", code: 'export { boot as leak44 } from "@labh/core";', rule: "studio import of core outside @labh/core/studio" },
  { name: "the studio importing a core source file", file: "packages/studio/collections/leak.ts", code: 'import { createGateway as leak45 } from "../../core/src/gateway.ts";', rule: "studio import of core outside @labh/core/studio" },
  { name: "a studio component importing core", file: "packages/studio/components/Leak.tsx", code: 'import { boot as leak46 } from "@labh/core";', rule: "studio import of core outside @labh/core/studio" },
  { name: "the studio reaching core through its node_modules symlink", file: "packages/studio/collections/leak2.ts", code: 'export { createGateway as leak47 } from "../node_modules/@labh/core/src/gateway.ts";', rule: "studio import of core outside @labh/core/studio" },
  { name: "the studio importing core by absolute path", file: "packages/studio/collections/leak3.ts", code: 'export { createGateway as leak48 } from "<root>/packages/core/src/gateway.ts";', rule: "studio import of core outside @labh/core/studio" },
  { name: "a brand by cast", file: "packages/core/src/loop.ts", code: 'export const leak41 = { value: "x", cls: "D0", origin: "o" } as unknown as Labelled<string>;', rule: "brand by cast to Labelled" },
  { name: "a stamp through an alias", file: "packages/core/src/gateway.ts", code: 'const L = Labelled; export const leak42 = L.stamp("x", "D0", "o");', rule: "Labelled.stamp outside an origin" },
  { name: "decideEgress elsewhere", file: "packages/core/src/loop.ts", code: 'import { decideEgress as de } from "./dataclass.ts"; export const leak43 = () => de(Labelled.stamp("x", "D0", "o"), { kind: "store", placement: "lab" }, { reviewConfidential: "refuse" });', rule: "decideEgress call outside its call sites" },
];

/** Legitimate shapes that resemble a route. Each must produce no violation. */
export const CONTROLS: readonly { readonly name: string; readonly file: string; readonly code: string }[] = [
  { name: "a tool using ctx.fetch", file: "packages/core/src/fine5.ts", code: 'import { z } from "zod";\nimport { defineTool } from "./tools.ts";\nexport const fine = defineTool({ name: "fine", description: "Use when testing. Not for anything.", input: z.object({ url: z.string() }), reads: "D0", effects: "read", egress: ["example.org"], idempotent: true, async run({ url }, ctx) { const { fetch } = ctx; return (await fetch(url)).status; } });' },
  { name: "a type position", file: "packages/core/src/fine.ts", code: "export interface Deps { readonly fetchImpl?: typeof fetch; readonly socket?: WebSocket }" },
  { name: "a property named fetch on a local type", file: "packages/core/src/fine2.ts", code: 'export interface Ctx { fetch(url: string): Promise<Response> }\nexport const run = (ctx: Ctx) => ctx.fetch("http://example.org/");' },
  { name: "a harmless global", file: "packages/core/src/fine3.ts", code: "export const now = () => globalThis.performance.now();" },
  { name: "the studio through its entry", file: "packages/studio/fine.ts", code: 'export { bootStudio } from "@labh/core/studio";' },
  { name: "a string that mentions a module", file: "packages/core/src/fine4.ts", code: 'export const note = "node:http is refused by the loader hook";' },
];

export function describe(v: Violation): string {
  return `${v.file}:${v.line} ${v.rule}: ${v.text}`;
}

/** Every plant and control applied at once, appended to existing files or as new files, with the line each landed on. */
export function plantedOverlay(root: string): { readonly overlay: Map<string, string>; readonly at: Map<string, { readonly file: string; readonly line: number }> } {
  const overlay = new Map<string, string>();
  const at = new Map<string, { file: string; line: number }>();
  for (const p of [...PLANTS, ...CONTROLS]) {
    const before = `${overlay.get(p.file) ?? readCurrent(root, p.file)}\n`;
    at.set(p.name, { file: p.file, line: before.split("\n").length });
    overlay.set(p.file, `${before}${p.code.replace("<root>", posix(root).replace(/\/$/, ""))}\n`);
  }
  return { overlay, at };
}

function readCurrent(root: string, file: string): string {
  try {
    return ts.sys.readFile(join(root, file)) ?? "";
  } catch {
    return "";
  }
}
