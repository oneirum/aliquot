/**
 * Model gateway. The only module that holds provider base URLs and keys, and
 * the only module that opens a connection to a model. Router backends and the
 * KB compiler go through it too.
 *
 * Every call, in order:
 *   1. prompt.cls is the join of its parts (computed by Prompt.of, never passed in)
 *   2. decideEgress(prompt.cls, {kind:"model", endpoint placement})  -> refused: record, return, no network
 *   3. recorder.record(model.requested) with the prompt stored as a payload
 *   4. one HTTP call to an OpenAI-compatible endpoint, through sendChat, which takes an AuthorizedRoute
 *   5. returned model id !== target.modelId  -> refused-model-mismatch (refuse, never swap)
 *   6. recorder.record(model.completed | model.failed)
 *
 * One wire protocol: OpenAI-compatible chat completions. OpenRouter, Ollama,
 * vLLM and most institution-hosted servers speak it. Wire types stay in this
 * file; callers see Prompt, ModelResult and Distribution only.
 */

import { z } from "zod";
import { decideEgress, describeRefusal, join, Labelled, Unlabelled, type AuthorizedRoute, type DataClass, type EgressPolicy, type EgressRefusal, type Placement } from "./dataclass.ts";
import { describeFailure, type CallFailure, type CallRecorder, type ToolCallRef } from "./record.ts";
import { platformFetch } from "./seal.ts";

export type ExactModelId = string & { readonly __exactModel: true };

export interface ModelParams {
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly seed?: number;
  readonly topP?: number;
}

export interface ModelTarget {
  readonly endpointId: string;
  readonly modelId: ExactModelId;
  readonly params: ModelParams;
}

/** From lab.toml. apiKeyEnv names an env var; the key never enters a document or the DB. */
export interface ModelEndpoint {
  readonly id: string;
  readonly baseUrl: string;
  readonly placement: Placement;
  readonly apiKeyEnv?: string;
  /** OpenRouter provider routing, sent verbatim as `provider`. zdr and allow_fallbacks are required when present. */
  readonly providerRouting?: { readonly zdr: true; readonly data_collection: "deny"; readonly allow_fallbacks: false; readonly only: readonly string[] };
  readonly supportsLogprobs: boolean;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export type ChatPart =
  | { readonly role: "system" | "user" | "assistant"; readonly content: Labelled<string> }
  | { readonly role: "assistant"; readonly toolCalls: Labelled<readonly { readonly id: string; readonly name: string; readonly args: unknown }[]> }
  | { readonly role: "tool"; readonly callId: string; readonly content: Labelled<string> };

function labelOf(p: ChatPart): Labelled<unknown> {
  return "content" in p ? p.content : p.toolCalls;
}

/**
 * Built only through Prompt.of, so cls is always the join of the parts and
 * cannot be understated by a caller. Nominal through the private field, like
 * Labelled, so a literal cannot pose as one at compile time and Prompt.is()
 * tells a genuine one at run time. A prompt has at least one part: the class
 * of an empty prompt would be minted, not derived.
 */
export class Prompt {
  readonly #brand: undefined;
  readonly cls: DataClass;
  readonly parts: readonly [ChatPart, ...ChatPart[]];
  readonly tools: readonly ToolSpec[];
  private constructor(cls: DataClass, parts: readonly [ChatPart, ...ChatPart[]], tools: readonly ToolSpec[]) {
    this.cls = cls;
    this.parts = parts;
    this.tools = tools;
  }
  static is(x: unknown): x is Prompt {
    return typeof x === "object" && x !== null && #brand in x;
  }
  /** Every part's label must be genuine; the class of a forged part is unknown. */
  static of(parts: readonly [ChatPart, ...ChatPart[]], tools: readonly ToolSpec[]): Prompt {
    for (const p of parts) if (!Labelled.is(labelOf(p))) throw new Unlabelled("Prompt.of");
    return new Prompt(join(...parts.map((p) => labelOf(p).cls)), parts, tools);
  }
  /** The prompt as a plain value for the record: the same parts, bodies inline. */
  toRecord(): unknown {
    return {
      parts: this.parts.map((p) => {
        if ("toolCalls" in p) return { role: "assistant", toolCalls: p.toolCalls.value };
        return p.role === "tool" ? { role: "tool", callId: p.callId, content: p.content.value } : { role: p.role, content: p.content.value };
      }),
      tools: this.tools.map((t) => t.name),
    };
  }
}

export interface ModelResult {
  readonly text: string;
  readonly toolCalls: readonly ToolCallRef[];
  readonly usage: { readonly input: number; readonly output: number };
  readonly providerModelId: string;
  readonly finish: "stop" | "tool_calls" | "length";
}

/** For the router. Probabilities sum to 1 over the given options. confidence is backend-specific; see RouterProfile. */
export interface Distribution {
  readonly probs: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly backend: "logprob-choice" | "decision-api" | "lexical";
}

export interface ChoiceRequest {
  readonly options: readonly { readonly id: string; readonly criterion: string }[];
  readonly state: string;
  readonly question: string;
}

export type GatewayOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly t: "refused-egress"; readonly refusal: EgressRefusal }
  | { readonly ok: false; readonly t: "refused-model-mismatch"; readonly requested: ExactModelId; readonly returned: string }
  | { readonly ok: false; readonly t: "failed"; readonly failure: CallFailure; readonly retryable: boolean };

export interface CallOptions {
  readonly signal: AbortSignal;
  /** Step and attempt numbers stamped on the recorded events. */
  readonly step: number;
  readonly attempt: number;
  readonly final: boolean;
}

export interface ModelGateway {
  /** One attempt. Retry policy belongs to the caller (loop.next), which counts attempts from the journal. */
  complete(target: ModelTarget, prompt: Prompt, rec: CallRecorder, opts: CallOptions): Promise<GatewayOutcome<ModelResult>>;
  /** Classifier call for the router. Same egress and recording path as complete(). */
  choose(target: ModelTarget, req: Labelled<ChoiceRequest>, rec: CallRecorder, signal: AbortSignal): Promise<GatewayOutcome<Distribution>>;
  /** Does the endpoint currently serve this exact id? Used by verifyRunnable for model-unavailable. */
  serves(target: ModelTarget): Promise<boolean>;
  /** The placement a target would go to. Lets the router pick a lab backend for D3 without guessing. */
  placementOf(endpointId: string): Placement;
}

// Wire shapes. Parsed at this boundary; nothing outside this file sees them.
const completionSchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number().default(0), completion_tokens: z.number().default(0) }).optional(),
});
type Completion = z.infer<typeof completionSchema>;

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toWire(p: ChatPart): WireMessage {
  if ("toolCalls" in p) {
    return { role: "assistant", content: null, tool_calls: p.toolCalls.value.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
  }
  if (p.role === "tool") return { role: "tool", tool_call_id: p.callId, content: p.content.value };
  return { role: p.role, content: p.content.value };
}

export class GatewayError extends Error {
  readonly code: Extract<CallFailure["code"], "aborted" | "network" | "http" | "unparseable">;
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** detail is the text worth keeping (a provider body, a parse message); null when the code says it all. */
  readonly detail: string | null;
  constructor(code: GatewayError["code"], detail: string | null, retryable: boolean, status?: number) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "GatewayError";
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
    this.status = status;
  }
}

export function createGateway(endpoints: readonly ModelEndpoint[], policy: EgressPolicy, fetchImpl: typeof fetch = platformFetch): ModelGateway {
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const endpointOf = (id: string): ModelEndpoint => {
    const e = byId.get(id);
    if (!e) throw new Error(`endpoint ${id} is not configured`);
    return e;
  };
  const headers = (e: ModelEndpoint): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    const key = e.apiKeyEnv ? process.env[e.apiKeyEnv] : undefined;
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  };

  /** The provider client. The only place a request leaves for a model, and it needs the route the egress decision produced. */
  const sendChat = async (route: AuthorizedRoute, target: ModelTarget, prompt: Prompt, signal: AbortSignal): Promise<Completion> => {
    const e = endpointOf(route.endpointId);
    const body: Record<string, unknown> = {
      model: target.modelId,
      messages: prompt.parts.map(toWire),
      temperature: target.params.temperature,
      max_tokens: target.params.maxOutputTokens,
      stream: false,
    };
    if (target.params.seed !== undefined) body.seed = target.params.seed;
    if (target.params.topP !== undefined) body.top_p = target.params.topP;
    if (prompt.tools.length) body.tools = prompt.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    if (e.providerRouting) body.provider = e.providerRouting;
    let res: Response;
    try {
      res = await fetchImpl(`${e.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: headers(e), body: JSON.stringify(body), signal });
    } catch (err) {
      const aborted = (err as { name?: string }).name === "AbortError" || signal.aborted;
      throw aborted ? new GatewayError("aborted", null, true) : new GatewayError("network", (err as Error).message, true);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      throw new GatewayError("http", text, res.status === 429 || res.status >= 500, res.status);
    }
    const parsed = completionSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new GatewayError("unparseable", parsed.error.issues[0]?.message ?? "no body", false);
    return parsed.data;
  };

  return {
    async complete(target, prompt, rec, opts) {
      const e = endpointOf(target.endpointId);
      const destination = { kind: "model", endpointId: e.id, placement: e.placement } as const;
      if (!Prompt.is(prompt)) {
        const refusal = { code: "unlabelled" } as const;
        await rec.record({ t: "egress.refused", destination: `model:${e.id}`, payload: "unverified", refusal });
        return { ok: false, t: "refused-egress", refusal };
      }
      // Everything derived from the prompt is at least the prompt's class, so that is the floor on each put.
      const from = prompt.parts.map(labelOf);
      const record = Labelled.derive(prompt.toRecord(), from, "gateway:prompt", prompt.cls);
      const decision = decideEgress(record, destination, policy);
      if (!decision.allow) {
        await rec.record({ t: "egress.refused", destination: `model:${e.id}`, payload: prompt.cls, refusal: decision.refusal });
        return { ok: false, t: "refused-egress", refusal: decision.refusal };
      }
      const promptRef = await rec.put(record);
      await rec.record({ t: "model.requested", step: opts.step, attempt: opts.attempt, target, prompt: promptRef, final: opts.final });
      const startedAt = Date.now();
      // Free text about the call (a provider body can echo the prompt) is stored at the prompt's class, not in the event.
      const detailRef = async (text: string | null) => (text === null ? null : rec.put(Labelled.derive(text, from, "gateway:error", prompt.cls)));
      let wire: Completion;
      try {
        wire = await sendChat(decision.to, target, prompt, opts.signal);
      } catch (err) {
        if (!(err instanceof GatewayError)) throw err;
        const failure: CallFailure = { code: err.code, ...(err.status !== undefined ? { status: err.status } : {}), detail: await detailRef(err.detail) };
        await rec.record({ t: "model.failed", step: opts.step, attempt: opts.attempt, failure, retryable: err.retryable });
        return { ok: false, t: "failed", failure, retryable: err.retryable };
      }
      if (wire.model !== target.modelId) {
        const failure: CallFailure = { code: "model-mismatch", detail: await detailRef(`asked for ${target.modelId}, provider served ${wire.model}`) };
        await rec.record({ t: "model.failed", step: opts.step, attempt: opts.attempt, failure, retryable: false });
        return { ok: false, t: "refused-model-mismatch", requested: target.modelId, returned: wire.model };
      }
      const choice = wire.choices[0]!;
      const text = choice.message.content ?? "";
      // Output is as sensitive as everything the model saw: it derives from every part of the prompt.
      const outputRef = await rec.put(Labelled.derive(text, from, "gateway:output", prompt.cls));
      const toolCalls: ToolCallRef[] = [];
      for (const c of choice.message.tool_calls ?? []) {
        let args: unknown;
        try {
          args = JSON.parse(c.function.arguments);
        } catch {
          args = { _unparsed: c.function.arguments };
        }
        toolCalls.push({ id: c.id, name: c.function.name, args: await rec.put(Labelled.derive(args, from, "gateway:tool-args", prompt.cls)) });
      }
      const usage = { input: wire.usage?.prompt_tokens ?? 0, output: wire.usage?.completion_tokens ?? 0 };
      await rec.record({ t: "model.completed", step: opts.step, attempt: opts.attempt, providerModelId: wire.model, output: outputRef, toolCalls, usage, ms: Date.now() - startedAt });
      const finish = toolCalls.length ? "tool_calls" : choice.finish_reason === "length" ? "length" : "stop";
      return { ok: true, value: { text, toolCalls, usage, providerModelId: wire.model, finish } };
    },
    async choose() {
      throw new Error("the router arrives in P2");
    },
    async serves(target) {
      const e = endpointOf(target.endpointId);
      try {
        const res = await fetchImpl(`${e.baseUrl.replace(/\/$/, "")}/models`, { headers: headers(e) });
        if (!res.ok) return false;
        const parsed = modelsSchema.safeParse(await res.json());
        return parsed.success && parsed.data.data.some((m) => m.id === target.modelId);
      } catch {
        return false;
      }
    },
    placementOf(endpointId) {
      return endpointOf(endpointId).placement;
    },
  };
}

export function describeOutcome(o: GatewayOutcome<unknown>): string {
  if (o.ok) return "ok";
  switch (o.t) {
    case "refused-egress":
      return describeRefusal(o.refusal);
    case "refused-model-mismatch":
      return `provider served ${o.returned} instead of ${o.requested}`;
    case "failed":
      return describeFailure(o.failure);
  }
}
