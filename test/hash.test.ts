import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, contentHash, sha256 } from "../packages/core/src/hash.ts";

test("canonicalJson sorts keys, drops whitespace and undefined, keeps nested order rules", () => {
  const s = canonicalJson({ b: [3, { z: 1, a: "x" }], a: undefined, c: null, "é": true });
  assert.equal(s, '{"b":[3,{"a":"x","z":1}],"c":null,"é":true}');
});

test("canonicalJson matches the RFC 8785 number examples", () => {
  assert.equal(canonicalJson([1e21, 1e-7, 0.1, -0, 10, 1.5e300]), "[1e+21,1e-7,0.1,0,10,1.5e+300]");
});

test("canonicalJson refuses values with no canonical form", () => {
  assert.throws(() => canonicalJson({ n: Number.NaN }), /non-finite number at \$\.n/);
  assert.throws(() => canonicalJson({ f: () => 1 }), /unsupported function at \$\.f/);
  assert.throws(() => canonicalJson(10n), /unsupported bigint/);
  assert.throws(() => canonicalJson(new Date(0)), /unsupported Date/);
});

test("sha256 is the standard digest and contentHash is sha256 of canonical JSON", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
  assert.equal(contentHash({ a: 1, b: 2 }), sha256('{"a":1,"b":2}'));
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
});
