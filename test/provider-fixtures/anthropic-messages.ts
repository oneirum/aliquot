/**
 * Response bodies for the Anthropic Messages adapter, written from the published API reference, not from a live call:
 * - Messages, "Create a Message" (POST /v1/messages): https://platform.claude.com/docs/en/api/messages
 *   (content blocks text, tool_use, thinking; stop_reason; usage.input_tokens and output_tokens; error body shape)
 * - Extended thinking, thinking blocks returned with tool use: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 * - List Models (GET /v1/models, limit, after_id, has_more, last_id): https://platform.claude.com/docs/en/api/models/list
 */

export const MODEL = "claude-opus-5-5";

/** A thinking block, then a tool_use block: the turn the next request must send back with its thinking. */
export const toolUse = {
  id: "msg_01A",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [
    { type: "thinking", thinking: "", signature: "sig-opaque-1" },
    { type: "text", text: "Let me search the handbook." },
    { type: "tool_use", id: "toolu_01A", name: "kb_search", input: { query: "office hours", k: 3 } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 412, output_tokens: 57, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
};

/**
 * Interleaved thinking with two parallel tool calls, the shape Claude Opus 5.5 returns: text between tool calls comes
 * back as progress-update thinking blocks (claude-api skill, "Claude Opus 5.5"), and the whole content array goes back
 * unchanged, in order, on the next request (Extended thinking, "Preserving thinking blocks"; the skill's preserved
 * thinking rule, which refuses an edited assistant turn).
 */
export const interleaved = {
  id: "msg_01C",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [
    { type: "thinking", thinking: "", signature: "sig-opaque-s1" },
    { type: "text", text: "First. " },
    { type: "tool_use", id: "toolu_1", name: "kb_search", input: { query: "office hours" } },
    { type: "thinking", thinking: "", signature: "sig-opaque-s2" },
    { type: "text", text: "Second." },
    { type: "tool_use", id: "toolu_2", name: "kb_search", input: { query: "holidays" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 430, output_tokens: 90 },
};

export const answer = {
  id: "msg_01B",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [{ type: "text", text: "The office is open 9 to 5." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 520, output_tokens: 12 },
};

export const maxTokens = { ...answer, content: [{ type: "text", text: "The office is open" }], stop_reason: "max_tokens" };

/** A classifier refusal: HTTP 200, partial text, stop_reason refusal with stop_details (claude-api skill, "Stop details"). */
export const refusal = {
  ...answer,
  content: [{ type: "text", text: "Partial ans" }],
  stop_reason: "refusal",
  stop_details: { type: "refusal", category: "cyber", explanation: "This request was declined." },
};

/** The output cap hit inside a tool call: the tool_use input may be cut off (Messages, stop_reason max_tokens). */
export const maxTokensInCall = {
  ...toolUse,
  content: [
    { type: "text", text: "Searching." },
    { type: "tool_use", id: "toolu_01T", name: "kb_search", input: { query: "office" } },
  ],
  stop_reason: "max_tokens",
};

/** Messages, stop_reason model_context_window_exceeded: the answer stopped at the context window, not by choice. */
export const contextExceeded = { ...answer, content: [{ type: "text", text: "The office" }], stop_reason: "model_context_window_exceeded" };

/** A dated snapshot that differs from the id the agent pinned. */
export const otherModel = { ...answer, model: "claude-opus-5-5-20261001" };

export const rateLimited = { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } };

export const invalidRequest = { type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: unexpected tool_use_id" } };

export const modelsPage1 = { data: [{ type: "model", id: "claude-fable-5-1", display_name: "Claude Fable 5.1", created_at: "2026-09-01T00:00:00Z" }], has_more: true, first_id: "claude-fable-5-1", last_id: "claude-fable-5-1" };

export const modelsPage2 = { data: [{ type: "model", id: MODEL, display_name: "Claude Opus 5.5", created_at: "2026-08-01T00:00:00Z" }], has_more: false, first_id: MODEL, last_id: MODEL };
