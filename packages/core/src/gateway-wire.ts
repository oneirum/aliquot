/**
 * Wire adapters: a prompt to a request body, and a response body to one
 * completion, per provider protocol. Pure. This file imports no network
 * module and reads no key; gateway.ts sends every request and holds every key.
 *
 *   openai-chat         POST {base}/chat/completions   GET {base}/models
 *   anthropic-messages  POST {base}/v1/messages        GET {base}/v1/models (paged)
 *   openai-responses    POST {base}/responses          GET {base}/models
 */

import { z } from "zod";
import type { ChatPart, ModelEndpoint, ModelResult, ModelTarget, Prompt } from "./gateway.ts";

export const PROTOCOLS = ["openai-chat", "anthropic-messages", "openai-responses"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/**
 * The provider's whole output for a turn that called tools: the Anthropic content array, the Responses output
 * array. Opaque. Replayed as is, in its order, only to the endpoint and model that produced it, because both
 * providers refuse or degrade a turn whose thinking or reasoning was edited, reordered or detached.
 */
export interface ProviderState {
  readonly protocol: Protocol;
  readonly endpointId: string;
  readonly modelId: string;
  readonly items: readonly unknown[];
}

export interface WireCompletion {
  readonly model: string;
  readonly text: string;
  readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly args: unknown }[];
  readonly usage: ModelResult["usage"];
  readonly finish: ModelResult["finish"];
  readonly providerState: ProviderState | null;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface WireAdapter {
  readonly completionPath: string;
  request(target: ModelTarget, prompt: Prompt, endpoint: ModelEndpoint): Record<string, unknown>;
  parse(json: unknown, target: ModelTarget): Parsed<WireCompletion>;
  /** The models list path for one page; after is the previous page's cursor. */
  modelsPath(after: string | null): string;
  parseModels(json: unknown): Parsed<{ readonly ids: readonly string[]; readonly next: string | null }>;
}

const fail = (error: z.ZodError | string): Parsed<never> => ({ ok: false, error: typeof error === "string" ? error : (error.issues[0]?.message ?? "no body") });

/**
 * temperature and top_p, when the endpoint takes them. Current Claude models (Opus 4.7 and later, Sonnet 5 and later,
 * Fable) and OpenAI reasoning models answer either with a 400, so the native protocols send them only when the
 * endpoint sets sampling = true; openai-chat sends them unless it sets sampling = false.
 */
function sampling(target: ModelTarget, endpoint: ModelEndpoint, byDefault: boolean): Record<string, number> {
  if (!(endpoint.sampling ?? byDefault)) return {};
  const out: Record<string, number> = { temperature: target.params.temperature };
  if (target.params.topP !== undefined) out.top_p = target.params.topP;
  return out;
}

/** How a provider says a turn ended, in the terms the run needs. */
type Ending = { readonly t: "stop" | "length" } | { readonly t: "refused" | "filtered"; readonly why: string };

/**
 * A refusal or a content filter is not an answer, so the call fails instead of posting partial text as one. Calls
 * cut off by the output cap may carry truncated input, so that fails too. The failure is not retryable: the same
 * prompt meets the same classifier and the same cap.
 */
function finishOf(ending: Ending, calls: number): Parsed<ModelResult["finish"]> {
  if (ending.t === "refused") return fail(`the model refused to answer (${ending.why})`);
  if (ending.t === "filtered") return fail(`the provider's content filter stopped the answer (${ending.why})`);
  if (ending.t === "length") return calls ? fail("the output cap cut off a turn with tool calls, so their input may be incomplete") : { ok: true, value: "length" };
  return { ok: true, value: calls ? "tool_calls" : "stop" };
}

function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { _unparsed: text };
  }
}

const providerStateSchema = z.object({ protocol: z.enum(PROTOCOLS), endpointId: z.string(), modelId: z.string(), items: z.array(z.unknown()) });

/**
 * The turn as the provider wrote it, or null when another protocol, endpoint or model wrote it, and then the
 * adapter rebuilds the turn from its text and calls. Parsed here because it is read back from the store.
 */
function stateFor(part: Extract<ChatPart, { toolCalls: unknown }>, protocol: Protocol, target: ModelTarget): readonly unknown[] | null {
  const s = providerStateSchema.safeParse(part.providerState?.value);
  return s.success && s.data.protocol === protocol && s.data.endpointId === target.endpointId && s.data.modelId === target.modelId ? s.data.items : null;
}

const systemText = (parts: readonly ChatPart[]): string =>
  parts
    .filter((p) => p.role === "system" && "content" in p)
    .map((p) => ("content" in p ? p.content.value : ""))
    .join("\n\n");

// openai-chat

const chatCompletion = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number().default(0), completion_tokens: z.number().default(0) }).optional(),
});

const openaiModels = z.object({ data: z.array(z.object({ id: z.string() })) });

function chatMessages(p: ChatPart): unknown[] {
  if ("toolCalls" in p) {
    const calls = { role: "assistant", content: null, tool_calls: p.toolCalls.value.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
    return p.text?.value ? [{ role: "assistant", content: p.text.value }, calls] : [calls];
  }
  if (p.role === "tool") return [{ role: "tool", tool_call_id: p.callId, content: p.content.value }];
  return [{ role: p.role, content: p.content.value }];
}

const openaiChat: WireAdapter = {
  completionPath: "/chat/completions",
  request(target, prompt, endpoint) {
    const body: Record<string, unknown> = { model: target.modelId, messages: prompt.parts.flatMap(chatMessages), ...sampling(target, endpoint, true), max_tokens: target.params.maxOutputTokens, stream: false };
    if (target.params.seed !== undefined) body.seed = target.params.seed;
    if (prompt.tools.length && prompt.toolChoice === "auto") body.tools = prompt.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    if (endpoint.providerRouting) body.provider = endpoint.providerRouting;
    return body;
  },
  parse(json) {
    const parsed = chatCompletion.safeParse(json);
    if (!parsed.success) return fail(parsed.error);
    const choice = parsed.data.choices[0]!;
    const toolCalls = (choice.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }));
    const ending: Ending = choice.message.refusal ? { t: "refused", why: "message.refusal" } : choice.finish_reason === "content_filter" ? { t: "filtered", why: "finish_reason content_filter" } : { t: choice.finish_reason === "length" ? "length" : "stop" };
    const finish = finishOf(ending, toolCalls.length);
    if (!finish.ok) return finish;
    const usage = { input: parsed.data.usage?.prompt_tokens ?? 0, output: parsed.data.usage?.completion_tokens ?? 0 };
    return { ok: true, value: { model: parsed.data.model, text: choice.message.content ?? "", toolCalls, usage, finish: finish.value, providerState: null } };
  },
  modelsPath: () => "/models",
  parseModels(json) {
    const parsed = openaiModels.safeParse(json);
    return parsed.success ? { ok: true, value: { ids: parsed.data.data.map((m) => m.id), next: null } } : fail(parsed.error);
  },
};

// anthropic-messages

const anthropicMessage = z.object({
  model: z.string(),
  content: z.array(z.looseObject({ type: z.string() })),
  stop_reason: z.string().nullable(),
  stop_details: z.object({ category: z.string().nullable().optional() }).nullable().optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});
const anthropicText = z.object({ type: z.literal("text"), text: z.string() });
const anthropicToolUse = z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() });
const anthropicModels = z.object({ data: z.array(z.object({ id: z.string() })), has_more: z.boolean(), last_id: z.string().nullable() });

type Block = Record<string, unknown>;
type AnthropicMessage = { role: "user" | "assistant"; content: Block[] };

/**
 * Consecutive parts of one role become one message. A user message lists its tool_result blocks first,
 * then any text (a steering note), as the API requires after a tool_use turn.
 */
function anthropicMessages(parts: readonly ChatPart[], target: ModelTarget): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const p of parts) {
    if (p.role === "system") continue;
    const role = p.role === "assistant" ? "assistant" : "user";
    let last = out.at(-1);
    if (last?.role !== role) out.push((last = { role, content: [] }));
    if ("toolCalls" in p) {
      const replayed = stateFor(p, "anthropic-messages", target) as Block[] | null;
      last.content.push(...(replayed ?? [...(p.text?.value ? [{ type: "text", text: p.text.value }] : []), ...p.toolCalls.value.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))]));
    } else if (p.role === "tool") {
      const firstText = last.content.findIndex((b) => b.type !== "tool_result");
      const block = { type: "tool_result", tool_use_id: p.callId, content: p.content.value, ...(p.failed ? { is_error: true } : {}) };
      if (firstText === -1) last.content.push(block);
      else last.content.splice(firstText, 0, block);
    } else if (p.content.value) last.content.push({ type: "text", text: p.content.value });
  }
  return out;
}

const anthropic: WireAdapter = {
  completionPath: "/v1/messages",
  request(target, prompt, endpoint) {
    const messages = anthropicMessages(prompt.parts, target);
    // A Claude model that takes sampling refuses temperature and top_p together; an explicit top_p is the deliberate choice.
    const s = sampling(target, endpoint, false);
    const body: Record<string, unknown> = { model: target.modelId, max_tokens: target.params.maxOutputTokens, messages, ...(s.top_p !== undefined ? { top_p: s.top_p } : s) };
    const system = systemText(prompt.parts);
    if (system) body.system = system;
    // A history with tool_use blocks is refused without tools, so the final call keeps them and turns them off.
    if (prompt.tools.length) {
      body.tools = prompt.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      body.tool_choice = { type: prompt.toolChoice };
    }
    return body;
  },
  parse(json, target) {
    const parsed = anthropicMessage.safeParse(json);
    if (!parsed.success) return fail(parsed.error);
    const m = parsed.data;
    const text = m.content.flatMap((b) => {
      const t = anthropicText.safeParse(b);
      return t.success ? [t.data.text] : [];
    });
    const toolCalls = m.content.flatMap((b) => {
      const t = anthropicToolUse.safeParse(b);
      return t.success ? [{ id: t.data.id, name: t.data.name, args: t.data.input }] : [];
    });
    const ending: Ending =
      m.stop_reason === "refusal"
        ? { t: "refused", why: `stop_reason refusal, category ${m.stop_details?.category ?? "none"}` }
        : { t: m.stop_reason === "max_tokens" || m.stop_reason === "model_context_window_exceeded" ? "length" : "stop" };
    const finish = finishOf(ending, toolCalls.length);
    if (!finish.ok) return finish;
    return {
      ok: true,
      value: {
        model: m.model,
        text: text.join(""),
        toolCalls,
        usage: { input: m.usage.input_tokens, output: m.usage.output_tokens },
        finish: finish.value,
        providerState: toolCalls.length ? { protocol: "anthropic-messages", endpointId: target.endpointId, modelId: target.modelId, items: m.content } : null,
      },
    };
  },
  modelsPath: (after) => `/v1/models?limit=1000${after === null ? "" : `&after_id=${encodeURIComponent(after)}`}`,
  parseModels(json) {
    const parsed = anthropicModels.safeParse(json);
    if (!parsed.success) return fail(parsed.error);
    return { ok: true, value: { ids: parsed.data.data.map((m) => m.id), next: parsed.data.has_more ? parsed.data.last_id : null } };
  },
};

// openai-responses

const responsesBody = z.object({
  model: z.string(),
  status: z.string(),
  error: z.object({ message: z.string() }).nullable().optional(),
  incomplete_details: z.object({ reason: z.string() }).nullable().optional(),
  output: z.array(z.looseObject({ type: z.string() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});
const responsesMessage = z.object({ type: z.literal("message"), content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })) });
const responsesCall = z.object({ type: z.literal("function_call"), call_id: z.string(), name: z.string(), arguments: z.string() });

function responsesInput(parts: readonly ChatPart[], target: ModelTarget): readonly unknown[] {
  return parts.flatMap((p): readonly unknown[] => {
    if (p.role === "system") return [];
    if ("toolCalls" in p) {
      const calls = p.toolCalls.value.map((c) => ({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) }));
      return stateFor(p, "openai-responses", target) ?? [...(p.text?.value ? [{ role: "assistant", content: p.text.value }] : []), ...calls];
    }
    if (p.role === "tool") return [{ type: "function_call_output", call_id: p.callId, output: p.content.value }];
    return [{ role: p.role, content: p.content.value }];
  });
}

const responses: WireAdapter = {
  completionPath: "/responses",
  request(target, prompt, endpoint) {
    const body: Record<string, unknown> = {
      model: target.modelId,
      input: responsesInput(prompt.parts, target),
      max_output_tokens: target.params.maxOutputTokens,
      ...sampling(target, endpoint, false),
      store: false,
    };
    const instructions = systemText(prompt.parts);
    if (instructions) body.instructions = instructions;
    if (prompt.tools.length) {
      body.tools = prompt.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
      body.tool_choice = prompt.toolChoice;
    }
    return body;
  },
  parse(json, target) {
    const parsed = responsesBody.safeParse(json);
    if (!parsed.success) return fail(parsed.error);
    const r = parsed.data;
    if (r.status === "failed") return fail(`response failed: ${r.error?.message ?? "no error message"}`);
    const text = r.output.flatMap((item) => {
      const m = responsesMessage.safeParse(item);
      return m.success ? m.data.content.flatMap((c) => (c.type === "output_text" && c.text !== undefined ? [c.text] : [])) : [];
    });
    const toolCalls = r.output.flatMap((item) => {
      const c = responsesCall.safeParse(item);
      return c.success ? [{ id: c.data.call_id, name: c.data.name, args: parseArgs(c.data.arguments) }] : [];
    });
    const refused = r.output.some((item) => responsesMessage.safeParse(item).data?.content.some((c) => c.type === "refusal"));
    const incomplete = r.status === "incomplete" ? (r.incomplete_details?.reason ?? null) : null;
    const ending: Ending = refused
      ? { t: "refused", why: "a refusal content part" }
      : incomplete === "content_filter"
        ? { t: "filtered", why: "incomplete, content_filter" }
        : { t: incomplete === "max_output_tokens" ? "length" : "stop" };
    const finish = finishOf(ending, toolCalls.length);
    if (!finish.ok) return finish;
    return {
      ok: true,
      value: {
        model: r.model,
        text: text.join(""),
        toolCalls,
        usage: { input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 },
        finish: finish.value,
        providerState: toolCalls.length ? { protocol: "openai-responses", endpointId: target.endpointId, modelId: target.modelId, items: r.output } : null,
      },
    };
  },
  modelsPath: () => "/models",
  parseModels: openaiChat.parseModels,
};

export const ADAPTERS: Readonly<Record<Protocol, WireAdapter>> = { "openai-chat": openaiChat, "anthropic-messages": anthropic, "openai-responses": responses };
