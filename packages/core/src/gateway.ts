/**
 * Model gateway. The only module that holds provider base URLs and keys, and
 * the only module that opens a connection to a model. Router backends and the
 * KB compiler go through it too.
 *
 * Every call, in order:
 *   1. prompt.cls is the join of its parts (computed by Prompt.of, never passed in)
 *   2. decideEgress(prompt.cls, {kind:"model", endpoint placement})  -> refused: record, return, no network
 *   3. recorder.record(model.requested) with the prompt stored as a payload
 *   4. one HTTP call to the endpoint, through send, which takes an AuthorizedRoute
 *   5. returned model id !== target.modelId  -> refused-model-mismatch (refuse, never swap)
 *   6. recorder.record(model.completed | model.failed)
 *
 * Three wire protocols, chosen per endpoint: OpenAI-compatible chat completions
 * (OpenRouter, Ollama, vLLM and most institution-hosted servers), Anthropic
 * Messages and OpenAI Responses. The body mappings are pure functions in
 * gateway-wire.ts; callers see Prompt, ModelResult and Distribution only.
 */

import { decideEgress, describeRefusal, join, Labelled, Unlabelled, type AuthorizedRoute, type DataClass, type EgressDecision, type EgressPolicy, type EgressRefusal, type ModelDestination, type Placement } from "./dataclass.ts";
import { describeFailure, type CallFailure, type CallRecorder, type ToolCallRef } from "./record.ts";
import { ADAPTERS, type Protocol, type WireCompletion } from "./gateway-wire.ts";
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
  /** Absent means openai-chat. */
  readonly protocol?: Protocol;
  /** Send temperature and top_p. Absent: sent on openai-chat, not sent on the native protocols, whose current models refuse them. */
  readonly sampling?: boolean;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export type ChatPart =
  | { readonly role: "system" | "user" | "assistant"; readonly content: Labelled<string> }
  | {
      /** One assistant turn that called tools: the text it wrote, its calls, and the provider's own record of the turn. */
      readonly role: "assistant";
      readonly text?: Labelled<string>;
      readonly toolCalls: Labelled<readonly { readonly id: string; readonly name: string; readonly args: unknown }[]>;
      /** The provider's whole output for this turn. Only the adapter that wrote it reads it, and replays it as is. */
      readonly providerState?: Labelled<unknown>;
    }
  | { readonly role: "tool"; readonly callId: string; readonly content: Labelled<string>; readonly failed?: true };

function labelsOf(p: ChatPart): Labelled<unknown>[] {
  if ("content" in p) return [p.content];
  return [...(p.text ? [p.text] : []), p.toolCalls, ...(p.providerState ? [p.providerState] : [])];
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
  /** none on a final call: the tools stay described, because a history with tool calls needs them, but none may be called. */
  readonly toolChoice: "auto" | "none";
  private constructor(cls: DataClass, parts: readonly [ChatPart, ...ChatPart[]], tools: readonly ToolSpec[], toolChoice: "auto" | "none") {
    this.cls = cls;
    this.parts = parts;
    this.tools = tools;
    this.toolChoice = toolChoice;
  }
  static is(x: unknown): x is Prompt {
    return typeof x === "object" && x !== null && #brand in x;
  }
  /** Every part's label must be genuine; the class of a forged part is unknown. */
  static of(parts: readonly [ChatPart, ...ChatPart[]], tools: readonly ToolSpec[], toolChoice: "auto" | "none" = "auto"): Prompt {
    const labels = parts.flatMap(labelsOf);
    for (const l of labels) if (!Labelled.is(l)) throw new Unlabelled("Prompt.of");
    return new Prompt(join(...labels.map((l) => l.cls)), parts, tools, toolChoice);
  }
  /** The prompt as a plain value for the record: the same parts, bodies inline. */
  toRecord(): unknown {
    return {
      parts: this.parts.flatMap((p) => {
        if ("toolCalls" in p) return [...(p.text ? [{ role: "assistant", content: p.text.value }] : []), { role: "assistant", toolCalls: p.toolCalls.value }];
        return [p.role === "tool" ? { role: "tool", callId: p.callId, content: p.content.value } : { role: p.role, content: p.content.value }];
      }),
      tools: this.tools.map((t) => t.name),
      ...(this.toolChoice === "none" ? { toolChoice: "none" } : {}),
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
  /**
   * The egress decision for content an agent CLI backend would receive: its task prompt and every bridge reply.
   * The session needs the route it returns to spawn the CLI and to answer a call, so a missing check does not compile.
   * Pure; the caller records a refusal, because a refused prompt and a withheld result are recorded differently.
   */
  admit(content: Labelled<unknown>, backendId: string): EgressDecision<ModelDestination>;
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

export function createGateway(endpoints: readonly ModelEndpoint[], policy: EgressPolicy, fetchImpl: typeof fetch = platformFetch, agentBackends: readonly { readonly id: string; readonly placement: Placement }[] = []): ModelGateway {
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const backends = new Map(agentBackends.map((b) => [b.id, b]));
  const endpointOf = (id: string): ModelEndpoint => {
    const e = byId.get(id);
    if (!e) throw new Error(`endpoint ${id} is not configured`);
    return e;
  };
  const headers = (e: ModelEndpoint): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    const key = e.apiKeyEnv ? process.env[e.apiKeyEnv] : undefined;
    if (e.protocol === "anthropic-messages") {
      h["anthropic-version"] = "2023-06-01";
      if (key) h["x-api-key"] = key;
    } else if (key) h.authorization = `Bearer ${key}`;
    return h;
  };
  const urlOf = (e: ModelEndpoint, path: string) => `${e.baseUrl.replace(/\/$/, "")}${path}`;

  /** The provider client. The only place a request leaves for a model, and it needs the route the egress decision produced. */
  const send = async (route: AuthorizedRoute, target: ModelTarget, prompt: Prompt, signal: AbortSignal): Promise<WireCompletion> => {
    const e = endpointOf(route.endpointId);
    const adapter = ADAPTERS[e.protocol ?? "openai-chat"];
    let res: Response;
    try {
      // Never followed: Node's fetch replays the body and x-api-key across a 307 to another origin.
      res = await fetchImpl(urlOf(e, adapter.completionPath), { method: "POST", headers: headers(e), body: JSON.stringify(adapter.request(target, prompt, e)), signal, redirect: "manual" });
    } catch (err) {
      const aborted = (err as { name?: string }).name === "AbortError" || signal.aborted;
      throw aborted ? new GatewayError("aborted", null, true) : new GatewayError("network", (err as Error).message, true);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new GatewayError("http", `the endpoint answered ${res.status}, and the gateway does not follow redirects`, false, res.status);
    }
    if (!res.ok) {
      // A 401 body echoes part of the key it was sent, and the detail is stored.
      const text = (await res.text().catch(() => "")).replace(/sk-[\w*.-]+/g, "sk-[redacted]").slice(0, 300);
      throw new GatewayError("http", text, res.status === 429 || res.status >= 500, res.status);
    }
    const parsed = adapter.parse(await res.json().catch(() => null), target);
    if (!parsed.ok) throw new GatewayError("unparseable", parsed.error, false);
    return parsed.value;
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
      const from = prompt.parts.flatMap(labelsOf);
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
      let wire: WireCompletion;
      try {
        wire = await send(decision.to, target, prompt, opts.signal);
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
      // Output is as sensitive as everything the model saw: it derives from every part of the prompt.
      const outputRef = await rec.put(Labelled.derive(wire.text, from, "gateway:output", prompt.cls));
      const toolCalls: ToolCallRef[] = [];
      for (const c of wire.toolCalls) toolCalls.push({ id: c.id, name: c.name, args: await rec.put(Labelled.derive(c.args, from, "gateway:tool-args", prompt.cls)) });
      const providerState = wire.providerState ? { providerState: await rec.put(Labelled.derive(wire.providerState, from, "gateway:provider-state", prompt.cls)) } : {};
      await rec.record({ t: "model.completed", step: opts.step, attempt: opts.attempt, providerModelId: wire.model, output: outputRef, toolCalls, usage: wire.usage, ms: Date.now() - startedAt, ...providerState });
      return { ok: true, value: { text: wire.text, toolCalls, usage: wire.usage, providerModelId: wire.model, finish: wire.finish } };
    },
    async choose() {
      throw new Error("the router arrives in P2");
    },
    async serves(target) {
      const e = endpointOf(target.endpointId);
      const adapter = ADAPTERS[e.protocol ?? "openai-chat"];
      try {
        // A bounded walk of a paged list: Anthropic pages at 1000 ids, the others answer in one page.
        let after: string | null = null;
        for (let page = 0; page < 20; page++) {
          const res = await fetchImpl(urlOf(e, adapter.modelsPath(after)), { headers: headers(e), redirect: "manual" });
          if (!res.ok) return false;
          const parsed = adapter.parseModels(await res.json());
          if (!parsed.ok) return false;
          if (parsed.value.ids.includes(target.modelId)) return true;
          if (parsed.value.next === null) return false;
          after = parsed.value.next;
        }
        return false;
      } catch {
        return false;
      }
    },
    placementOf(endpointId) {
      return backends.get(endpointId)?.placement ?? endpointOf(endpointId).placement;
    },
    admit(content, backendId) {
      const b = backends.get(backendId);
      if (!b) throw new Error(`agent backend ${backendId} is not configured`);
      return decideEgress(content, { kind: "model", endpointId: b.id, placement: b.placement }, policy);
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
