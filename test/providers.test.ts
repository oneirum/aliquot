import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import { createGateway, Prompt, type ChatPart, type ExactModelId, type ModelEndpoint, type ModelTarget } from "../packages/core/src/gateway.ts";
import { startFakeProvider } from "./fake-provider.ts";
import { memoryRecorder } from "./recorder.ts";
import * as A from "./provider-fixtures/anthropic-messages.ts";
import * as R from "./provider-fixtures/openai-responses.ts";

const claude = await startFakeProvider();
const openai = await startFakeProvider();
after(async () => {
  await claude.close();
  await openai.close();
});

process.env.LABH_TEST_ANTHROPIC_KEY = "test-key-a";
process.env.LABH_TEST_OPENAI_KEY = "test-key-o";
const endpoints: ModelEndpoint[] = [
  { id: "claude", baseUrl: claude.url, placement: "zdr", supportsLogprobs: false, protocol: "anthropic-messages", apiKeyEnv: "LABH_TEST_ANTHROPIC_KEY" },
  { id: "claude-s", baseUrl: claude.url, placement: "zdr", supportsLogprobs: false, protocol: "anthropic-messages", sampling: true },
  { id: "openai", baseUrl: `${openai.url}/v1`, placement: "zdr", supportsLogprobs: false, protocol: "openai-responses", apiKeyEnv: "LABH_TEST_OPENAI_KEY" },
  { id: "chat", baseUrl: `${openai.url}/v1`, placement: "zdr", supportsLogprobs: false },
  { id: "openai-s", baseUrl: `${openai.url}/v1`, placement: "zdr", supportsLogprobs: false, protocol: "openai-responses", sampling: true },
];
const gateway = createGateway(endpoints, DEFAULT_POLICY, fetch);
const target = (endpointId: string, modelId: string, params: Partial<ModelTarget["params"]> = {}): ModelTarget => ({ endpointId, modelId: modelId as ExactModelId, params: { temperature: 0, maxOutputTokens: 64, ...params } });
const opts = { signal: new AbortController().signal, step: 1, attempt: 1, final: false };
const KB_TOOL = { name: "kb_search", description: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } } };
const d1 = <T>(v: T) => Labelled.stamp(v, "D1", "t");
const system: ChatPart = { role: "system", content: d1("Be brief.") };
const user: ChatPart = { role: "user", content: d1("office hours") };
const call = (id: string): ChatPart => ({ role: "assistant", toolCalls: d1([{ id, name: "kb_search", args: { query: "office hours", k: 3 } }]) });
const result = (id: string, text: string): ChatPart => ({ role: "tool", callId: id, content: d1(text) });
const lastBody = (p: { sent: readonly { body: unknown }[] }) => p.sent.at(-1)!.body as Record<string, unknown>;

test("anthropic: a tool round trip sends x-api-key and the version, keeps the thinking block, and sends it back with the call", async () => {
  claude.reply("POST /v1/messages", { body: A.toolUse }, { body: A.answer });
  const rec = memoryRecorder();
  const first = await gateway.complete(target("claude", A.MODEL), Prompt.of([system, user], [KB_TOOL]), rec, opts);
  assert.ok(first.ok);
  assert.deepEqual([first.value.text, first.value.finish, first.value.usage, first.value.toolCalls.map((c) => [c.id, c.name, rec.body(c.args)])], ["Let me search the handbook.", "tool_calls", { input: 412, output: 57 }, [["toolu_01A", "kb_search", { query: "office hours", k: 3 }]]]);
  const sent = claude.sent.at(-1)!;
  assert.equal(sent.headers["x-api-key"], "test-key-a");
  assert.equal(sent.headers["anthropic-version"], "2023-06-01");
  assert.equal(sent.headers.authorization, undefined);
  assert.deepEqual(sent.body, {
    model: A.MODEL,
    max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "text", text: "office hours" }] }],
    system: "Be brief.",
    tools: [{ name: "kb_search", description: "search", input_schema: KB_TOOL.inputSchema }],
    tool_choice: { type: "auto" },
  });
  const completed = rec.events.at(-1)!;
  assert.ok(completed.t === "model.completed" && completed.providerState);
  assert.equal(completed.providerState.cls, "D1", "the thinking is stored at the prompt's class");
  const state = Labelled.stamp(rec.body(completed.providerState), completed.providerState.cls, "store");

  const followUp: ChatPart = { role: "assistant", text: d1("Let me search the handbook."), toolCalls: d1([{ id: "toolu_01A", name: "kb_search", args: { query: "office hours", k: 3 } }]), providerState: state };
  const second = await gateway.complete(target("claude", A.MODEL), Prompt.of([system, user, followUp, result("toolu_01A", "9 to 5")], [KB_TOOL]), rec, { ...opts, step: 2 });
  assert.ok(second.ok);
  assert.deepEqual([second.value.text, second.value.finish], ["The office is open 9 to 5.", "stop"]);
  assert.deepEqual(lastBody(claude).messages, [
    { role: "user", content: [{ type: "text", text: "office hours" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-opaque-1" },
        { type: "text", text: "Let me search the handbook." },
        { type: "tool_use", id: "toolu_01A", name: "kb_search", input: { query: "office hours", k: 3 } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01A", content: "9 to 5" }] },
  ]);
});

const twoCallsTurn = (ids: readonly [string, string], text: string, state?: Labelled<unknown>): ChatPart => ({
  role: "assistant",
  text: d1(text),
  toolCalls: d1([
    { id: ids[0], name: "kb_search", args: { query: "office hours" } },
    { id: ids[1], name: "kb_search", args: { query: "holidays" } },
  ]),
  ...(state ? { providerState: state } : {}),
});

/** One model call through the gateway, and the provider state it stored, read back as the loop reads it. */
async function storedState(p: typeof claude, route: string, body: unknown, t: ModelTarget): Promise<Labelled<unknown>> {
  p.reply(route, { body });
  const rec = memoryRecorder();
  const out = await gateway.complete(t, Prompt.of([system, user], [KB_TOOL]), rec, opts);
  assert.ok(out.ok);
  const completed = rec.events.at(-1)!;
  assert.ok(completed.t === "model.completed" && completed.providerState, "a tool turn stores its provider state");
  return Labelled.stamp(JSON.parse(JSON.stringify(rec.body(completed.providerState))), completed.providerState.cls, "store");
}

test("anthropic: interleaved thinking and two parallel calls are replayed byte for byte, in their order", async () => {
  const state = await storedState(claude, "POST /v1/messages", A.interleaved, target("claude", A.MODEL));
  claude.reply("POST /v1/messages", { body: A.answer });
  await gateway.complete(target("claude", A.MODEL), Prompt.of([system, user, twoCallsTurn(["toolu_1", "toolu_2"], "First. Second.", state), result("toolu_1", "9 to 5"), result("toolu_2", "closed on holidays")], [KB_TOOL]), memoryRecorder(), { ...opts, step: 2 });
  const sent = claude.sent.at(-1)!;
  assert.deepEqual(sent.body, {
    model: A.MODEL,
    max_tokens: 64,
    messages: [
      { role: "user", content: [{ type: "text", text: "office hours" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-opaque-s1" },
          { type: "text", text: "First. " },
          { type: "tool_use", id: "toolu_1", name: "kb_search", input: { query: "office hours" } },
          { type: "thinking", thinking: "", signature: "sig-opaque-s2" },
          { type: "text", text: "Second." },
          { type: "tool_use", id: "toolu_2", name: "kb_search", input: { query: "holidays" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "9 to 5" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "closed on holidays" },
        ],
      },
    ],
    system: "Be brief.",
    tools: [{ name: "kb_search", description: "search", input_schema: KB_TOOL.inputSchema }],
    tool_choice: { type: "auto" },
  });
  assert.ok(sent.raw.includes(`{"role":"assistant","content":${JSON.stringify(A.interleaved.content)}}`), "the assistant turn is the provider's content array, byte for byte");
});

test("anthropic: another model's turn is rebuilt from its text and calls, with no thinking", async () => {
  const state = await storedState(claude, "POST /v1/messages", A.interleaved, target("claude", A.MODEL));
  claude.reply("POST /v1/messages", { body: { ...A.answer, model: "claude-sonnet-5-5" } });
  await gateway.complete(target("claude", "claude-sonnet-5-5"), Prompt.of([user, twoCallsTurn(["toolu_1", "toolu_2"], "First. Second.", state), result("toolu_1", "9 to 5"), result("toolu_2", "closed")], [KB_TOOL]), memoryRecorder(), opts);
  assert.deepEqual((lastBody(claude).messages as unknown[])[1], {
    role: "assistant",
    content: [
      { type: "text", text: "First. Second." },
      { type: "tool_use", id: "toolu_1", name: "kb_search", input: { query: "office hours" } },
      { type: "tool_use", id: "toolu_2", name: "kb_search", input: { query: "holidays" } },
    ],
  });
});

test("anthropic: a failed tool's result is sent with is_error", async () => {
  claude.reply("POST /v1/messages", { body: A.answer });
  const failed: ChatPart = { role: "tool", callId: "toolu_01A", content: d1("Error: the tool threw"), failed: true };
  await gateway.complete(target("claude", A.MODEL), Prompt.of([user, call("toolu_01A"), failed], [KB_TOOL]), memoryRecorder(), opts);
  assert.deepEqual((lastBody(claude).messages as unknown[])[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01A", content: "Error: the tool threw", is_error: true }] });
});

test("anthropic: a final call with tool history still sends the tools, with tool_choice none", async () => {
  claude.reply("POST /v1/messages", { body: A.answer });
  const out = await gateway.complete(target("claude", A.MODEL), Prompt.of([system, user, call("toolu_01A"), result("toolu_01A", "Not executed: the run reached its limit.")], [KB_TOOL], "none"), memoryRecorder(), { ...opts, final: true });
  assert.ok(out.ok);
  const body = lastBody(claude);
  assert.deepEqual([body.tools, body.tool_choice], [[{ name: "kb_search", description: "search", input_schema: KB_TOOL.inputSchema }], { type: "none" }]);
});

test("anthropic: every tool result of a turn goes in one user message, results first, then the steering note", async () => {
  claude.reply("POST /v1/messages", { body: A.answer });
  const twoCalls: ChatPart = { role: "assistant", toolCalls: d1([{ id: "toolu_1", name: "kb_search", args: { query: "a" } }, { id: "toolu_2", name: "kb_search", args: { query: "b" } }]) };
  const steer: ChatPart = { role: "user", content: d1("Steering note from the thread: only the main office") };
  await gateway.complete(target("claude", A.MODEL), Prompt.of([system, user, twoCalls, result("toolu_1", "one"), steer, result("toolu_2", "two")], [KB_TOOL]), memoryRecorder(), opts);
  assert.deepEqual(lastBody(claude).messages, [
    { role: "user", content: [{ type: "text", text: "office hours" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "kb_search", input: { query: "a" } },
        { type: "tool_use", id: "toolu_2", name: "kb_search", input: { query: "b" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "one" },
        { type: "tool_result", tool_use_id: "toolu_2", content: "two" },
        { type: "text", text: "Steering note from the thread: only the main office" },
      ],
    },
  ]);
});

test("anthropic: the default sends neither temperature nor top_p; sampling = true sends temperature, or an explicit top_p alone", async () => {
  claude.reply("POST /v1/messages", { body: A.answer }, { body: A.answer }, { body: A.answer });
  const keys = (b: Record<string, unknown>) => Object.fromEntries(["temperature", "top_p"].filter((k) => k in b).map((k) => [k, b[k]]));
  await gateway.complete(target("claude", A.MODEL, { topP: 0.9 }), Prompt.of([user], []), memoryRecorder(), opts);
  const byDefault = keys(lastBody(claude));
  await gateway.complete(target("claude-s", "claude-sonnet-4-6"), Prompt.of([user], []), memoryRecorder(), opts);
  const temperature = keys(lastBody(claude));
  await gateway.complete(target("claude-s", "claude-sonnet-4-6", { topP: 0.9 }), Prompt.of([user], []), memoryRecorder(), opts);
  assert.deepEqual([byDefault, temperature, keys(lastBody(claude))], [{}, { temperature: 0 }, { top_p: 0.9 }]);
});

test("anthropic: stop_reason max_tokens maps to length", async () => {
  claude.reply("POST /v1/messages", { body: A.maxTokens });
  const out = await gateway.complete(target("claude", A.MODEL), Prompt.of([user], []), memoryRecorder(), opts);
  assert.deepEqual(out.ok && [out.value.text, out.value.finish], ["The office is open", "length"]);
});

test("anthropic: a dated snapshot that differs from the pinned id is a mismatch", async () => {
  claude.reply("POST /v1/messages", { body: A.otherModel });
  const out = await gateway.complete(target("claude", A.MODEL), Prompt.of([user], []), memoryRecorder(), opts);
  assert.deepEqual(out, { ok: false, t: "refused-model-mismatch", requested: A.MODEL, returned: "claude-opus-5-5-20261001" });
});

test("anthropic: a 429 is retryable and a 400 is not", async () => {
  claude.reply("POST /v1/messages", { status: 429, body: A.rateLimited }, { status: 400, body: A.invalidRequest });
  const limited = await gateway.complete(target("claude", A.MODEL), Prompt.of([user], []), memoryRecorder(), opts);
  const invalid = await gateway.complete(target("claude", A.MODEL), Prompt.of([user], []), memoryRecorder(), opts);
  assert.deepEqual([limited.ok === false && limited.t === "failed" && [limited.failure.status, limited.retryable], invalid.ok === false && invalid.t === "failed" && [invalid.failure.status, invalid.retryable]], [
    [429, true],
    [400, false],
  ]);
});

test("anthropic: serves walks the paged model list for the exact id", async () => {
  claude.reply("GET /v1/models?limit=1000", { body: A.modelsPage1 }, { body: A.modelsPage1 });
  claude.reply("GET /v1/models?limit=1000&after_id=claude-fable-5-1", { body: A.modelsPage2 }, { body: A.modelsPage2 });
  assert.equal(await gateway.serves(target("claude", A.MODEL)), true);
  assert.equal(await gateway.serves(target("claude", "claude-opus-5")), false);
});

test("responses: a tool round trip sends store false and no include, instructions, and replays the reasoning item beside its call", async () => {
  openai.reply("POST /v1/responses", { body: R.functionCall }, { body: R.answer });
  const rec = memoryRecorder();
  const first = await gateway.complete(target("openai", R.MODEL), Prompt.of([system, user], [KB_TOOL]), rec, opts);
  assert.ok(first.ok);
  assert.deepEqual([first.value.finish, first.value.usage, first.value.toolCalls.map((c) => [c.id, rec.body(c.args)])], ["tool_calls", { input: 300, output: 80 }, [["call_01A", { query: "office hours", k: 3 }]]]);
  const sent = openai.sent.at(-1)!;
  assert.equal(sent.headers.authorization, "Bearer test-key-o");
  assert.deepEqual(sent.body, {
    model: R.MODEL,
    input: [{ role: "user", content: "office hours" }],
    max_output_tokens: 64,
    store: false,
    instructions: "Be brief.",
    tools: [{ type: "function", name: "kb_search", description: "search", parameters: KB_TOOL.inputSchema, strict: false }],
    tool_choice: "auto",
  });
  const completed = rec.events.at(-1)!;
  assert.ok(completed.t === "model.completed" && completed.providerState);
  const state = Labelled.stamp(rec.body(completed.providerState), completed.providerState.cls, "store");

  const replayed: ChatPart = { role: "assistant", toolCalls: d1([{ id: "call_01A", name: "kb_search", args: { query: "office hours", k: 3 } }]), providerState: state };
  const second = await gateway.complete(target("openai", R.MODEL), Prompt.of([system, user, replayed, result("call_01A", "9 to 5")], [KB_TOOL]), rec, { ...opts, step: 2 });
  assert.deepEqual(second.ok && [second.value.text, second.value.finish], ["The office is open 9 to 5.", "stop"]);
  assert.deepEqual(lastBody(openai).input, [
    { role: "user", content: "office hours" },
    R.functionCall.output[0],
    R.functionCall.output[1],
    { type: "function_call_output", call_id: "call_01A", output: "9 to 5" },
  ]);
  assert.equal(lastBody(openai).store, false);
});

test("responses: reasoning, a commentary message with its phase, and two calls are replayed byte for byte, in their order", async () => {
  const state = await storedState(openai, "POST /v1/responses", R.parallelCalls, target("openai", R.MODEL));
  openai.reply("POST /v1/responses", { body: R.answer });
  await gateway.complete(target("openai", R.MODEL), Prompt.of([system, user, twoCallsTurn(["call_1", "call_2"], "Checking both.", state), result("call_1", "9 to 5"), result("call_2", "closed on holidays")], [KB_TOOL]), memoryRecorder(), { ...opts, step: 2 });
  const sent = openai.sent.at(-1)!;
  assert.deepEqual((sent.body as { input: unknown }).input, [
    { role: "user", content: "office hours" },
    { type: "reasoning", id: "rs_01D", summary: [], encrypted_content: "gAAAA-opaque-d" },
    { type: "message", id: "msg_01D", status: "completed", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking both.", annotations: [] }] },
    { type: "function_call", id: "fc_01D", call_id: "call_1", name: "kb_search", arguments: '{"query":"office hours"}', status: "completed" },
    { type: "function_call", id: "fc_02D", call_id: "call_2", name: "kb_search", arguments: '{"query":"holidays"}', status: "completed" },
    { type: "function_call_output", call_id: "call_1", output: "9 to 5" },
    { type: "function_call_output", call_id: "call_2", output: "closed on holidays" },
  ]);
  assert.ok(sent.raw.includes(JSON.stringify(R.parallelCalls.output).slice(1, -1)), "the output items go back byte for byte");
});

test("responses: state from another model is not replayed; the calls are sent plainly", async () => {
  openai.reply("POST /v1/responses", { body: { ...R.answer, model: "gpt-6-astra-2026-10-01" } });
  const state = d1({ protocol: "openai-responses", endpointId: "openai", modelId: R.MODEL, items: R.functionCall.output });
  const replayed: ChatPart = { role: "assistant", toolCalls: d1([{ id: "call_01A", name: "kb_search", args: { query: "office hours", k: 3 } }]), providerState: state };
  await gateway.complete(target("openai", "gpt-6-astra-2026-10-01"), Prompt.of([user, replayed, result("call_01A", "9 to 5")], [KB_TOOL]), memoryRecorder(), opts);
  assert.deepEqual(lastBody(openai).input, [
    { role: "user", content: "office hours" },
    { type: "function_call", call_id: "call_01A", name: "kb_search", arguments: '{"query":"office hours","k":3}' },
    { type: "function_call_output", call_id: "call_01A", output: "9 to 5" },
  ]);
});

test("responses: a final call sends the tools with tool_choice none", async () => {
  openai.reply("POST /v1/responses", { body: R.answer });
  await gateway.complete(target("openai", R.MODEL), Prompt.of([user, call("call_01A"), result("call_01A", "Not executed: the run reached its limit.")], [KB_TOOL], "none"), memoryRecorder(), { ...opts, final: true });
  assert.deepEqual([(lastBody(openai).tools as unknown[]).length, lastBody(openai).tool_choice], [1, "none"]);
});

test("responses: the default sends neither temperature nor top_p; sampling = true sends both", async () => {
  openai.reply("POST /v1/responses", { body: R.answer }, { body: R.answer });
  const keys = (b: Record<string, unknown>) => Object.fromEntries(["temperature", "top_p"].filter((k) => k in b).map((k) => [k, b[k]]));
  await gateway.complete(target("openai", R.MODEL, { topP: 0.5 }), Prompt.of([user], []), memoryRecorder(), opts);
  const byDefault = keys(lastBody(openai));
  await gateway.complete(target("openai-s", R.MODEL, { topP: 0.5 }), Prompt.of([user], []), memoryRecorder(), opts);
  assert.deepEqual([byDefault, keys(lastBody(openai))], [{}, { temperature: 0, top_p: 0.5 }]);
});

test("responses: incomplete with max_output_tokens maps to length", async () => {
  openai.reply("POST /v1/responses", { body: R.incomplete });
  const out = await gateway.complete(target("openai", R.MODEL), Prompt.of([user], []), memoryRecorder(), opts);
  assert.deepEqual(out.ok && [out.value.text, out.value.finish], ["The office is open", "length"]);
});

test("responses: an alias the provider resolves to a dated snapshot is a mismatch", async () => {
  openai.reply("POST /v1/responses", { body: R.answer });
  const out = await gateway.complete(target("openai", R.ALIAS), Prompt.of([user], []), memoryRecorder(), opts);
  assert.deepEqual(out, { ok: false, t: "refused-model-mismatch", requested: R.ALIAS, returned: R.MODEL });
});

test("responses: a 429 is retryable and a 400 is not", async () => {
  openai.reply("POST /v1/responses", { status: 429, body: R.rateLimited }, { status: 400, body: R.invalidRequest });
  const limited = await gateway.complete(target("openai", R.MODEL), Prompt.of([user], []), memoryRecorder(), opts);
  const invalid = await gateway.complete(target("openai", R.MODEL), Prompt.of([user], []), memoryRecorder(), opts);
  assert.deepEqual([limited.ok === false && limited.t === "failed" && [limited.failure.status, limited.retryable], invalid.ok === false && invalid.t === "failed" && [invalid.failure.status, invalid.retryable]], [
    [429, true],
    [400, false],
  ]);
});

test("responses: a key echoed in an error body is redacted before the detail is stored", async () => {
  openai.reply("POST /v1/responses", { status: 401, body: { error: { message: "Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.", type: "invalid_request_error", code: "invalid_api_key" } } });
  const rec = memoryRecorder();
  const out = await gateway.complete(target("openai", R.MODEL), Prompt.of([user], []), rec, opts);
  assert.ok(!out.ok && out.t === "failed" && out.failure.detail);
  assert.equal(rec.body(out.failure.detail), '{"error":{"message":"Incorrect API key provided: sk-[redacted] You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}');
});

test("responses: serves reads GET /models", async () => {
  openai.reply("GET /v1/models", { body: R.models }, { body: R.models });
  assert.equal(await gateway.serves(target("openai", R.MODEL)), true);
  assert.equal(await gateway.serves(target("openai", R.ALIAS)), false);
});

/** A failed call as the run sees it: the failure code, whether it is retried, and the stored detail. */
async function failure(p: typeof claude, route: string, body: unknown, t: ModelTarget): Promise<unknown> {
  p.reply(route, { body });
  const rec = memoryRecorder();
  const out = await gateway.complete(t, Prompt.of([user], [KB_TOOL]), rec, opts);
  if (out.ok || out.t !== "failed") return out;
  return [out.failure.code, out.retryable, out.failure.detail && rec.body(out.failure.detail)];
}

test("a refusal or a content filter fails the call, not retryable, on every protocol", async () => {
  const chatFiltered = { model: "chat-1", choices: [{ message: { content: "half" }, finish_reason: "content_filter" }] };
  const chatRefused = { model: "chat-1", choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: "stop" }] };
  assert.deepEqual(
    [
      await failure(claude, "POST /v1/messages", A.refusal, target("claude", A.MODEL)),
      await failure(openai, "POST /v1/responses", R.refusal, target("openai", R.MODEL)),
      await failure(openai, "POST /v1/responses", R.contentFilter, target("openai", R.MODEL)),
      await failure(openai, "POST /v1/chat/completions", chatFiltered, target("chat", "chat-1")),
      await failure(openai, "POST /v1/chat/completions", chatRefused, target("chat", "chat-1")),
    ],
    [
      ["unparseable", false, "the model refused to answer (stop_reason refusal, category cyber)"],
      ["unparseable", false, "the model refused to answer (a refusal content part)"],
      ["unparseable", false, "the provider's content filter stopped the answer (incomplete, content_filter)"],
      ["unparseable", false, "the provider's content filter stopped the answer (finish_reason content_filter)"],
      ["unparseable", false, "the model refused to answer (message.refusal)"],
    ],
  );
});

test("tool calls cut off by the output cap fail the call instead of running", async () => {
  const chatCut = { model: "chat-1", choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "kb_search", arguments: '{"query":"off' } }] }, finish_reason: "length" }] };
  const responsesCut = { ...R.parallelCalls, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  const cut = "the output cap cut off a turn with tool calls, so their input may be incomplete";
  assert.deepEqual(
    [
      await failure(claude, "POST /v1/messages", A.maxTokensInCall, target("claude", A.MODEL)),
      await failure(openai, "POST /v1/responses", responsesCut, target("openai", R.MODEL)),
      await failure(openai, "POST /v1/chat/completions", chatCut, target("chat", "chat-1")),
    ],
    [
      ["unparseable", false, cut],
      ["unparseable", false, cut],
      ["unparseable", false, cut],
    ],
  );
});

test("anthropic: model_context_window_exceeded maps to length", async () => {
  claude.reply("POST /v1/messages", { body: A.contextExceeded });
  const out = await gateway.complete(target("claude", A.MODEL), Prompt.of([user], []), memoryRecorder(), opts);
  assert.deepEqual(out.ok && [out.value.text, out.value.finish], ["The office", "length"]);
});

test("a prompt's class includes its provider state", () => {
  const state = Labelled.stamp({ protocol: "openai-responses", endpointId: "openai", modelId: R.MODEL, items: [] }, "D3", "store");
  const p = Prompt.of([{ role: "user", content: Labelled.stamp("hi", "D0", "t") }, { role: "assistant", toolCalls: Labelled.stamp([], "D0", "t"), providerState: state }], []);
  assert.equal(p.cls, "D3");
});

test("anthropic: a tool turn with no thinking is still stored and replayed byte for byte", async () => {
  const plain = { ...A.interleaved, content: A.interleaved.content.filter((b) => b.type !== "thinking") };
  const state = await storedState(claude, "POST /v1/messages", plain, target("claude", A.MODEL));
  claude.reply("POST /v1/messages", { body: A.answer });
  await gateway.complete(target("claude", A.MODEL), Prompt.of([system, user, twoCallsTurn(["toolu_1", "toolu_2"], "First. Second.", state), result("toolu_1", "9 to 5"), result("toolu_2", "closed on holidays")], [KB_TOOL]), memoryRecorder(), { ...opts, step: 2 });
  assert.ok(claude.sent.at(-1)!.raw.includes(`{"role":"assistant","content":${JSON.stringify(plain.content)}}`));
});

test("responses: a message and two calls with no reasoning are still stored and replayed byte for byte", async () => {
  const plain = { ...R.parallelCalls, output: R.parallelCalls.output.filter((o) => o.type !== "reasoning") };
  const state = await storedState(openai, "POST /v1/responses", plain, target("openai", R.MODEL));
  openai.reply("POST /v1/responses", { body: R.answer });
  await gateway.complete(target("openai", R.MODEL), Prompt.of([system, user, twoCallsTurn(["call_1", "call_2"], "Checking both.", state), result("call_1", "9 to 5"), result("call_2", "closed on holidays")], [KB_TOOL]), memoryRecorder(), { ...opts, step: 2 });
  assert.ok(openai.sent.at(-1)!.raw.includes(JSON.stringify(plain.output).slice(1, -1)));
});

test("openai-chat still sends the agent's temperature by default", async () => {
  openai.reply("POST /v1/chat/completions", { body: { id: "c1", object: "chat.completion", model: "gpt-chat-1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } } });
  await gateway.complete(target("chat", "gpt-chat-1", { temperature: 0.3 }), Prompt.of([system, user], []), memoryRecorder(), opts);
  assert.equal(lastBody(openai).temperature, 0.3);
});
