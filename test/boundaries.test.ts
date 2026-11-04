import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CONTROLS, describe, PLANTS, plantedOverlay, scanBoundaries } from "../scripts/boundaries.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the checked-out sources reach the network, load code, decide egress, brand and stamp only where allowed", () => {
  assert.deepEqual(scanBoundaries(root).map(describe), []);
});

test("every planted route is reported on its line under its rule, and the controls are clean", () => {
  const { overlay, at } = plantedOverlay(root);
  const violations = scanBoundaries(root, overlay);
  for (const plant of PLANTS) {
    const where = at.get(plant.name)!;
    const hit = violations.filter((v) => v.file === where.file && v.line === where.line);
    assert.ok(hit.some((v) => v.rule === plant.rule), `${plant.name}: expected "${plant.rule}" at ${where.file}:${where.line}, got ${hit.length ? hit.map(describe).join(" | ") : "nothing"}`);
  }
  const plantedLines = new Set([...PLANTS].map((p) => `${at.get(p.name)!.file}:${at.get(p.name)!.line}`));
  const stray = violations.filter((v) => !plantedLines.has(`${v.file}:${v.line}`));
  assert.deepEqual(stray.map(describe), [], "only planted lines are reported");
  for (const control of CONTROLS) assert.equal(violations.some((v) => v.file === control.file), false, `${control.name} is not a route`);
});

/** Every core file the studio's entry loads, with overlay replacing a file's text by its path from the repository root. */
function studioEntryFiles(overlay: ReadonlyMap<string, string> = new Map()): ts.SourceFile[] {
  const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true, noEmit: true, types: ["node"] };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile;
  host.readFile = (f) => overlay.get(relative(root, f)) ?? readFile(f);
  const program = ts.createProgram([join(root, "packages/core/src/studio.ts")], options, host);
  return program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/"));
}

/** Calls, function declarations or property reads of the names given in these files, as "file: name", each once. */
function namedIn(files: readonly ts.SourceFile[], names: readonly string[], kinds: { readonly calls?: boolean; readonly declarations?: boolean; readonly reads?: boolean }): string[] {
  const found: string[] = [];
  for (const sf of files) {
    const visit = (n: ts.Node): void => {
      const callee = ts.isCallExpression(n) ? (ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null) : null;
      if (kinds.calls && callee !== null && names.includes(callee)) found.push(`${relative(root, sf.fileName)}: ${callee}`);
      if (kinds.declarations && ts.isFunctionDeclaration(n) && n.name && names.includes(n.name.text)) found.push(`${relative(root, sf.fileName)}: declares ${n.name.text}`);
      if (kinds.reads && ts.isPropertyAccessExpression(n) && names.includes(n.name.text) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) found.push(`${relative(root, sf.fileName)}: reads .${n.name.text}`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...new Set(found)];
}

test("nothing the studio's entry into core loads constructs a model gateway or a tool runner", () => {
  const loaded = studioEntryFiles();
  assert.ok(loaded.some((sf) => sf.fileName.endsWith("/kb-compile.ts")), "the entry loads the KB definition schema the form is built from");
  assert.deepEqual(namedIn(loaded, ["createGateway", "createToolRunner"], { calls: true }), []);
});

/**
 * The key enters a process only through payloadKeyFromEnv, which reads the env var lab.toml's [store] key_env names
 * (config.store.keyEnv), and the boots and the store built from it. createPayloadStore's own module may load for its
 * types; a call is what holds a key.
 */
const KEY_READERS = ["payloadKeyFromEnv", "createPayloadStore", "bootShared", "boot"];

test("the studio reads no payload key: nothing its entry loads calls or declares a key reader, and no studio file names the key", async () => {
  const loaded = studioEntryFiles();
  assert.deepEqual(namedIn(loaded, KEY_READERS, { calls: true }), []);
  assert.deepEqual(namedIn(loaded, ["payloadKeyFromEnv"], { declarations: true }), [], "the env reader is not even loaded");
  assert.deepEqual(namedIn(loaded, ["keyEnv"], { reads: true }), [], "nothing loaded looks up the key's env var");
  const planted = new Map([["packages/core/src/studio.ts", `${await readFile(join(root, "packages/core/src/studio.ts"), "utf8")}\nexport { bootShared } from "./boot-shared.ts";\n`]]);
  assert.deepEqual(namedIn(studioEntryFiles(planted), ["payloadKeyFromEnv", "keyEnv"], { calls: true, reads: true }).sort(), ["packages/core/src/boot-shared.ts: payloadKeyFromEnv", "packages/core/src/boot-shared.ts: reads .keyEnv"], "a re-export of the shared boot is caught");
  const studioFiles = execFileSync("git", ["ls-files", "packages/studio"], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(studioFiles.length > 10, "the studio's files are listed");
  const naming: string[] = [];
  for (const f of studioFiles) if (/LABH_PAYLOAD_KEY|\bkeyEnv\b|key_env/.test(await readFile(join(root, f), "utf8"))) naming.push(f);
  assert.deepEqual(naming, []);
});

test("the wire adapters may not reach the network: a module import or a fetch in gateway-wire.ts is reported", async () => {
  const source = `${await readFile(join(root, "packages/core/src/gateway-wire.ts"), "utf8")}\nimport { request } from "node:http";\nvoid request;\nvoid fetch("http://example.org");\n`;
  const found = scanBoundaries(root, new Map([["packages/core/src/gateway-wire.ts", source]])).filter((v) => v.file === "packages/core/src/gateway-wire.ts");
  assert.deepEqual(found.map((v) => v.rule).sort(), ["global fetch reference", "network module node:http"]);
});
