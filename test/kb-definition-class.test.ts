import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { definitionClass, parseKbDefinition } from "../packages/core/src/kb-compile.ts";

const file = JSON.parse(readFileSync(new URL("../fixtures/lab0/kb.json", import.meta.url), "utf8")) as Record<string, unknown>;

test("a definition's own text is D1 unless the steward declares it, and a participant id in it still raises it", () => {
  assert.equal(definitionClass(parseKbDefinition(file), []), "D1");
  assert.equal(definitionClass(parseKbDefinition({ ...file, definitionClass: "D0" }), []), "D0");
  assert.equal(definitionClass(parseKbDefinition({ ...file, definitionClass: "D0", purpose: "Wave 1 status for LAB0-0003." }), [/\bLAB0-\d{4}\b/]), "D3");
});

test("an undeclared definition class stays absent, so a definition parsed before the field existed is unchanged", () => {
  assert.equal("definitionClass" in parseKbDefinition(file), false);
});
