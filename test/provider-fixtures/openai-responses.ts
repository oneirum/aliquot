/**
 * Response bodies for the OpenAI Responses adapter, written from the published API reference, not from a live call:
 * - Responses, "Create a model response" (POST /responses; output items, status, incomplete_details, usage, include):
 *   https://developers.openai.com/api/reference/resources/responses/methods/create
 * - Reasoning models, "Preserve reasoning without stored responses" (store false, encrypted_content, replaying output items):
 *   https://platform.openai.com/docs/guides/reasoning
 * - Function calling (function_call items with call_id, function_call_output items): https://platform.openai.com/docs/guides/function-calling
 * - List models (GET /models): https://developers.openai.com/api/reference/resources/models/methods/list
 */

export const MODEL = "gpt-6-astra-2026-09-01";

const base = { object: "response", created_at: 1761600000, error: null, incomplete_details: null, store: false };

/** A reasoning item with its encrypted content, then the call it led to. */
export const functionCall = {
  ...base,
  id: "resp_01A",
  status: "completed",
  model: MODEL,
  output: [
    { type: "reasoning", id: "rs_01A", summary: [], encrypted_content: "gAAAA-opaque-reasoning" },
    { type: "function_call", id: "fc_01A", call_id: "call_01A", name: "kb_search", arguments: '{"query":"office hours","k":3}', status: "completed" },
  ],
  usage: { input_tokens: 300, input_tokens_details: { cached_tokens: 0 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 64 }, total_tokens: 380 },
};

/**
 * A reasoning item, a commentary message with its phase, and two parallel calls. The guide replays every output item
 * untouched and in order, and says to preserve each original phase (Reasoning models, "Preserve reasoning without
 * stored responses" and "phase parameter").
 */
export const parallelCalls = {
  ...base,
  id: "resp_01D",
  status: "completed",
  model: MODEL,
  output: [
    { type: "reasoning", id: "rs_01D", summary: [], encrypted_content: "gAAAA-opaque-d" },
    { type: "message", id: "msg_01D", status: "completed", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking both.", annotations: [] }] },
    { type: "function_call", id: "fc_01D", call_id: "call_1", name: "kb_search", arguments: '{"query":"office hours"}', status: "completed" },
    { type: "function_call", id: "fc_02D", call_id: "call_2", name: "kb_search", arguments: '{"query":"holidays"}', status: "completed" },
  ],
  usage: { input_tokens: 320, output_tokens: 96, total_tokens: 416 },
};

export const answer = {
  ...base,
  id: "resp_01B",
  status: "completed",
  model: MODEL,
  output: [
    { type: "reasoning", id: "rs_01B", summary: [], encrypted_content: "gAAAA-opaque-2" },
    { type: "message", id: "msg_01B", status: "completed", role: "assistant", content: [{ type: "output_text", text: "The office is open 9 to 5.", annotations: [] }] },
  ],
  usage: { input_tokens: 410, output_tokens: 20, total_tokens: 430 },
};

export const incomplete = {
  ...answer,
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" },
  output: [{ type: "message", id: "msg_01C", status: "incomplete", role: "assistant", content: [{ type: "output_text", text: "The office is open", annotations: [] }] }],
};

/** A message whose content is a refusal part, not output_text (Responses, output message content: refusal). */
export const refusal = {
  ...answer,
  output: [{ type: "message", id: "msg_01R", status: "completed", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
};

/** incomplete_details.reason content_filter, with the text produced before the filter stopped it. */
export const contentFilter = {
  ...answer,
  status: "incomplete",
  incomplete_details: { reason: "content_filter" },
  output: [{ type: "message", id: "msg_01F", status: "incomplete", role: "assistant", content: [{ type: "output_text", text: "half", annotations: [] }] }],
};

/** The undated alias the provider resolved to a snapshot, against an agent that pinned the alias. */
export const ALIAS = "gpt-6-astra";

export const rateLimited = { error: { message: "Rate limit reached for requests", type: "requests", param: null, code: "rate_limit_exceeded" } };

export const invalidRequest = { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: "invalid_request_error", param: "temperature", code: "unsupported_parameter" } };

export const models = { object: "list", data: [{ id: MODEL, object: "model", created: 1756684800, owned_by: "openai" }] };
