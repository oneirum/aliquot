import { test } from "node:test";
import assert from "node:assert/strict";
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

test("nothing the studio's entry into core loads constructs a model gateway or a tool runner", () => {
  const program = ts.createProgram([join(root, "packages/core/src/studio.ts")], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true, noEmit: true, types: ["node"] });
  const loaded = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/"));
  assert.ok(loaded.some((sf) => sf.fileName.endsWith("/boot-shared.ts")), "the entry loads the shared wiring");
  const builds: string[] = [];
  for (const sf of loaded) {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ["createGateway", "createToolRunner"].includes(n.expression.text)) builds.push(`${relative(root, sf.fileName)}: ${n.expression.text}`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(builds, []);
});

test("the wire adapters may not reach the network: a module import or a fetch in gateway-wire.ts is reported", async () => {
  const source = `${await readFile(join(root, "packages/core/src/gateway-wire.ts"), "utf8")}\nimport { request } from "node:http";\nvoid request;\nvoid fetch("http://example.org");\n`;
  const found = scanBoundaries(root, new Map([["packages/core/src/gateway-wire.ts", source]])).filter((v) => v.file === "packages/core/src/gateway-wire.ts");
  assert.deepEqual(found.map((v) => v.rule).sort(), ["global fetch reference", "network module node:http"]);
});
