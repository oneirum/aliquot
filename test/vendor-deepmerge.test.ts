import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const deepmerge = createRequire(import.meta.url)("../vendor/deepmerge") as (a: object, b: object) => Record<string, unknown>;

test("the vendored deepmerge never takes a prototype from an own __proto__ key (GHSA-gcqx-w48m-w2h4)", () => {
  const target = JSON.parse('{"__proto__":{"polluted":"yes"},"x":1}');
  const source = JSON.parse('{"__proto__":{"polluted2":"yes"},"y":2}');
  for (const merged of [deepmerge(target, { z: 3 }), deepmerge({}, source), deepmerge(target, source)]) {
    assert.equal(Object.getPrototypeOf(merged), Object.prototype);
    assert.equal(merged.polluted, undefined);
    assert.equal(merged.polluted2, undefined);
  }
  assert.deepEqual(deepmerge(target, source), { x: 1, y: 2 });
  assert.deepEqual(deepmerge({ a: { b: 1 } }, { a: { c: 2 } }), { a: { b: 1, c: 2 } });
});
