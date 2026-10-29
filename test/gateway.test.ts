import { test, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_POLICY, Labelled, Unlabelled } from "../packages/core/src/dataclass.ts";
import { createGateway, Prompt, type ExactModelId, type ModelEndpoint, type ModelTarget } from "../packages/core/src/gateway.ts";
import { ERROR_BODY_MARKER, startFakeModel } from "./fake-model.ts";
import { memoryRecorder } from "./recorder.ts";

const lab = await startFakeModel("scripted-1", "answer");
const hosted = await startFakeModel("hosted-2", "answer");
after(async () => {
  await lab.close();
  await hosted.close();
});

const endpoints: ModelEndpoint[] = [
  { id: "local", baseUrl: lab.url, placement: "lab", supportsLogprobs: false },
  { id: "hosted", baseUrl: hosted.url, placement: "zdr", supportsLogprobs: false },
];
const gateway = createGateway(endpoints, DEFAULT_POLICY, fetch);
const target = (endpointId: string, modelId: string): ModelTarget => ({ endpointId, modelId: modelId as ExactModelId, params: { temperature: 0, maxOutputTokens: 64 } });
const opts = { signal: new AbortController().signal, step: 1, attempt: 1, final: false };
const KB_TOOL = { name: "kb_search", description: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } } };

test("Prompt.of takes the join of its parts' classes", () => {
  const p = Prompt.of([{ role: "system", content: Labelled.stamp("s", "D1", "t") }, { role: "user", content: Labelled.stamp("u", "D2", "t") }], []);
  assert.equal(p.cls, "D2");
  assert.deepEqual(p.toRecord(), { parts: [{ role: "system", content: "s" }, { role: "user", content: "u" }], tools: [] });
});

test("a lab call records requested and completed with bodies in the store, and sends the OpenAI shape", async () => {
  const rec = memoryRecorder();
  const prompt = Prompt.of(
    [
      { role: "system", content: Labelled.stamp("Be brief.", "D1", "t") },
      { role: "user", content: Labelled.stamp("What are the office hours?", "D2", "t") },
    ],
    [KB_TOOL],
  );
  const out = await gateway.complete(target("local", "scripted-1"), prompt, rec, opts);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value.text, "Scripted answer to: What are the office hours?");
  assert.equal(out.value.providerModelId, "scripted-1");
  assert.deepEqual(out.value.usage, { input: 10, output: 5 });
  assert.deepEqual(
    rec.events.map((e) => e.t),
    ["model.requested", "model.completed"],
  );
  const requested = rec.events[0]!;
  assert.equal(requested.t === "model.requested" && requested.prompt.cls, "D2");
  assert.deepEqual(requested.t === "model.requested" ? rec.body(requested.prompt) : null, {
    parts: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "What are the office hours?" },
    ],
    tools: ["kb_search"],
  });
  const completed = rec.events[1]!;
  assert.equal(completed.t === "model.completed" && completed.output.cls, "D2", "the output takes the prompt's class");
  const sent = lab.bodies.at(-1) as { model: string; messages: unknown[]; tools: unknown[]; stream: boolean };
  assert.equal(sent.model, "scripted-1");
  assert.deepEqual(sent.messages, [
    { role: "system", content: "Be brief." },
    { role: "user", content: "What are the office hours?" },
  ]);
  assert.deepEqual(sent.tools, [{ type: "function", function: { name: "kb_search", description: "search", parameters: KB_TOOL.inputSchema } }]);
  assert.equal(sent.stream, false);
});

test("a tool call comes back with its arguments stored as a payload and the transcript round-trips to the wire", async () => {
  lab.script = "search-then-answer";
  const rec = memoryRecorder();
  const prompt = Prompt.of([{ role: "user", content: Labelled.stamp("office hours", "D1", "t") }], [KB_TOOL]);
  const out = await gateway.complete(target("local", "scripted-1"), prompt, rec, opts);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value.finish, "tool_calls");
  assert.equal(out.value.toolCalls[0]?.name, "kb_search");
  assert.deepEqual(rec.body(out.value.toolCalls[0]!.args), { query: "office hours", k: 3 });
  const followUp = Prompt.of(
    [
      { role: "user", content: Labelled.stamp("office hours", "D1", "t") },
      { role: "assistant", toolCalls: Labelled.stamp([{ id: out.value.toolCalls[0]!.id, name: "kb_search", args: { query: "office hours", k: 3 } }], "D1", "t") },
      { role: "tool", callId: out.value.toolCalls[0]!.id, content: Labelled.stamp("9 to 5", "D1", "t") },
    ],
    [KB_TOOL],
  );
  const second = await gateway.complete(target("local", "scripted-1"), followUp, rec, { ...opts, step: 2 });
  assert.equal(second.ok && second.value.text, "Scripted answer from 1 search result(s): 9 to 5");
  const sent = lab.bodies.at(-1) as { messages: unknown[] };
  assert.deepEqual(sent.messages[1], { role: "assistant", content: null, tool_calls: [{ id: out.value.toolCalls[0]!.id, type: "function", function: { name: "kb_search", arguments: '{"query":"office hours","k":3}' } }] });
  assert.deepEqual(sent.messages[2], { role: "tool", tool_call_id: out.value.toolCalls[0]!.id, content: "9 to 5" });
  lab.script = "answer";
});

test("D3 to a zdr endpoint is refused before any request leaves", async () => {
  const rec = memoryRecorder();
  const before = hosted.requests;
  const prompt = Prompt.of([{ role: "user", content: Labelled.stamp("participant P-12345", "D3", "gate") }], []);
  const out = await gateway.complete(target("hosted", "hosted-2"), prompt, rec, opts);
  assert.deepEqual(out, { ok: false, t: "refused-egress", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } });
  assert.deepEqual(rec.events, [{ t: "egress.refused", destination: "model:hosted", payload: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } }]);
  assert.equal(hosted.requests, before);
  const allowed = await gateway.complete(target("hosted", "hosted-2"), Prompt.of([{ role: "user", content: Labelled.stamp("hello", "D1", "gate") }], []), rec, opts);
  assert.equal(allowed.ok, true);
  assert.equal(hosted.requests, before + 1);
});

test("a provider that serves a different model is refused, not swapped", async () => {
  hosted.script = "wrong-model";
  const rec = memoryRecorder();
  const out = await gateway.complete(target("hosted", "hosted-2"), Prompt.of([{ role: "user", content: Labelled.stamp("hi", "D0", "t") }], []), rec, opts);
  assert.deepEqual(out, { ok: false, t: "refused-model-mismatch", requested: "hosted-2", returned: "other-model-9" });
  const mismatch = rec.events.at(-1)!;
  assert.deepEqual(mismatch.t === "model.failed" && [mismatch.step, mismatch.attempt, mismatch.failure.code, mismatch.retryable, rec.body(mismatch.failure.detail!)], [1, 1, "model-mismatch", false, "asked for hosted-2, provider served other-model-9"]);
  hosted.script = "answer";
});

test("an aborted call is recorded as a retryable failure", async () => {
  lab.delayMs = 500;
  const rec = memoryRecorder();
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  const out = await gateway.complete(target("local", "scripted-1"), Prompt.of([{ role: "user", content: Labelled.stamp("hi", "D0", "t") }], []), rec, { ...opts, signal: ctl.signal });
  assert.deepEqual(out, { ok: false, t: "failed", failure: { code: "aborted", detail: null }, retryable: true });
  assert.deepEqual(rec.events.at(-1), { t: "model.failed", step: 1, attempt: 1, failure: { code: "aborted", detail: null }, retryable: true });
  lab.delayMs = 0;
});

test("a provider error body goes to the payload store at the prompt's class, never into the event", async () => {
  lab.script = "http-500";
  try {
    const rec = memoryRecorder();
    const prompt = Prompt.of([{ role: "user", content: Labelled.stamp("participant P-12345", "D3", "gate") }], []);
    const out = await gateway.complete(target("local", "scripted-1"), prompt, rec, opts);
    const failed = rec.events.at(-1)!;
    assert.equal(failed.t, "model.failed");
    if (failed.t !== "model.failed") return;
    assert.equal(JSON.stringify(failed).includes(ERROR_BODY_MARKER), false, "the event holds no provider text");
    assert.deepEqual(out.ok === false && out.t === "failed" && [out.failure.code, out.failure.status, out.retryable], ["http", 500, true]);
    assert.equal(failed.failure.detail?.cls, "D3", "the error text is a payload at the prompt's class");
    assert.match(String(rec.body(failed.failure.detail!)), /provider-echo P-12345/);
  } finally {
    lab.script = "answer";
  }
});

test("serves asks the endpoint for its model list", async () => {
  assert.equal(await gateway.serves(target("local", "scripted-1")), true);
  assert.equal(await gateway.serves(target("local", "scripted-9")), false);
  assert.equal(gateway.placementOf("hosted"), "zdr");
});

test("a forged prompt is refused at the gateway with no request, and Prompt.of refuses a forged part", async () => {
  const real = Prompt.of([{ role: "user", content: Labelled.stamp("participant P-12345", "D3", "gate") }], []);
  const parsed = JSON.parse(JSON.stringify({ cls: "D0", parts: real.parts, tools: [] })) as Prompt;
  const created = Object.assign(Object.create(Prompt.prototype), { cls: "D0", parts: real.parts, tools: [] }) as Prompt;
  const before = hosted.requests;
  for (const forged of [parsed, created]) {
    assert.equal(Prompt.is(forged), false);
    const rec = memoryRecorder();
    assert.deepEqual(await gateway.complete(target("hosted", "hosted-2"), forged, rec, opts), { ok: false, t: "refused-egress", refusal: { code: "unlabelled" } });
    assert.deepEqual(rec.events, [{ t: "egress.refused", destination: "model:hosted", payload: "unverified", refusal: { code: "unlabelled" } }]);
  }
  assert.equal(hosted.requests, before);
  const forgedPart = JSON.parse(JSON.stringify(Labelled.stamp("x", "D3", "gate"))) as Labelled<string>;
  assert.throws(() => Prompt.of([{ role: "user", content: forgedPart }], []), Unlabelled);
});

// F7 from REREVIEW-ISOLATION-2.md: Node's fetch replays the body and x-api-key across a 307 to another origin.
test("a provider request refuses a redirect, so neither the prompt nor the key reaches the other origin", async () => {
  const reached: { method: string | undefined; url: string | undefined; key: string | string[] | undefined }[] = [];
  const other = createServer((req, res) => (reached.push({ method: req.method, url: req.url, key: req.headers["x-api-key"] }), res.writeHead(500).end())).listen(0, "127.0.0.1");
  await once(other, "listening");
  const otherPort = (other.address() as AddressInfo).port;
  const redirecting = createServer((req, res) => res.writeHead(307, { location: `http://127.0.0.1:${otherPort}${req.url}` }).end()).listen(0, "127.0.0.1");
  await once(redirecting, "listening");
  process.env.LABH_TEST_REDIRECT_KEY = "test-key-redirect";
  try {
    const g = createGateway([{ id: "redirecting", baseUrl: `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`, placement: "lab", supportsLogprobs: false, protocol: "anthropic-messages", apiKeyEnv: "LABH_TEST_REDIRECT_KEY" }], DEFAULT_POLICY, fetch);
    const rec = memoryRecorder();
    const prompt = Prompt.of([{ role: "user", content: Labelled.stamp("What are the office hours?", "D2", "t") }], []);
    const out = await g.complete(target("redirecting", "claude-x"), prompt, rec, opts);
    assert.deepEqual(out.ok === false && out.t === "failed" && [out.failure.code, out.failure.status, out.retryable, rec.body(out.failure.detail!)], ["http", 307, false, "the endpoint answered 307, and the gateway does not follow redirects"]);
    assert.equal(await g.serves(target("redirecting", "claude-x")), false);
    assert.deepEqual(reached, []);
  } finally {
    delete process.env.LABH_TEST_REDIRECT_KEY;
    other.close();
    redirecting.close();
  }
});
