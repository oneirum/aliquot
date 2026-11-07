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

test("a Bedrock Converse request with a colon in the model id and a session token matches AWS's own signer", () => {
  // Produced once by @smithy/signature-v4 5.3.5 (the AWS SDK's signer) for this exact request and pinned here; the
  // signer is not a dependency. It sends x-amz-content-sha256, so this request carries it too. The path's %3A is
  // encoded again in the canonical URI (%253A), which a root-path vector cannot show.
  const body = JSON.stringify({ messages: [{ role: "user", content: [{ text: "What are the office hours?" }] }], inferenceConfig: { maxTokens: 64 } });
  const h = signV4({
    method: "POST",
    url: new URL("https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-5-5-v1%3A0/converse"),
    headers: { "content-type": "application/json", "x-amz-content-sha256": "6cd2d99f09870a7830b4ace5028dff58a582059a9d833be3c4c640eb93bb2918" },
    body,
    region: "us-east-1",
    service: "bedrock",
    credentials: { ...credentials, sessionToken: "session-token-example" },
    now: new Date("2026-11-07T04:00:00Z"),
  });
  assert.equal(h.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261107/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=730560242e6599b81f0a90f210dbd22a00b31791ff57c90a68e4ecf839a02e12");
});
