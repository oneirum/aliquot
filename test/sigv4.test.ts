import { test } from "node:test";
import assert from "node:assert/strict";
import { signV4 } from "../packages/core/src/sigv4.ts";

// AWS's SigV4 test suite (aws-sig-v4-test-suite): the example key, us-east-1, service "service", 2015-08-30T12:36:00Z.
const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const at = { region: "us-east-1", service: "service", credentials, now: new Date("2015-08-30T12:36:00Z"), headers: {}, body: "" };

test("get-vanilla matches AWS's published signature", () => {
  const h = signV4({ ...at, method: "GET", url: new URL("https://example.amazonaws.com/") });
  assert.equal(h.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(h["x-amz-date"], "20150830T123600Z");
});

test("post-vanilla matches AWS's published signature", () => {
  const h = signV4({ ...at, method: "POST", url: new URL("https://example.amazonaws.com/") });
  assert.match(h.authorization!, /Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b$/);
});

test("get-vanilla-query-order-key-case sorts the query", () => {
  const h = signV4({ ...at, method: "GET", url: new URL("https://example.amazonaws.com/?Param2=value2&Param1=value1") });
  assert.match(h.authorization!, /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);
});

test("a session token is sent and signed", () => {
  const h = signV4({ ...at, credentials: { ...credentials, sessionToken: "tok" }, method: "POST", url: new URL("https://example.amazonaws.com/") });
  assert.equal(h["x-amz-security-token"], "tok");
  assert.match(h.authorization!, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);
});
