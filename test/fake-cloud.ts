/**
 * Fakes of the two campus-contract clouds, each built from its vendor's REST reference, each running the same
 * "cite" brain as fake-model.ts (search, read the top entry, quote it and name the path). No cloud is called.
 *
 * Azure OpenAI, deployment URL:
 *   POST /openai/deployments/{deployment}/chat/completions?api-version={v}   header api-key
 *   (learn.microsoft.com/en-us/azure/ai-foundry/openai/reference). A wrong or missing key is a 401, an unknown
 *   api-version a 404, as Azure answers. The body is the OpenAI chat completions shape; `model` in the reply is the
 *   deployed model's id, not the deployment name.
 * Amazon Bedrock Converse:
 *   POST /model/{modelId}/converse, SigV4 for service bedrock
 *   (docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html). The fake recomputes the signature
 *   from what arrived on the wire with the test key, and answers 403 InvalidSignatureException on any difference,
 *   so a request whose bytes, path, host or date drifted from what was signed fails here as it would at AWS.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { signV4, type AwsCredentials } from "../packages/core/src/sigv4.ts";

export const TEST_AWS: AwsCredentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

export interface FakeCloud {
  readonly url: string;
  /** Every request that arrived, any path: "METHOD url". The refusal checks assert this stays empty. */
  readonly paths: readonly string[];
  readonly bodies: readonly unknown[];
  readonly headers: readonly IncomingMessage["headers"][];
  /** Requests answered 401 or 403. */
  readonly rejected: number;
  close(): Promise<void>;
}

/** One step of the cite brain, in neutral terms the two wire shapes translate. */
type Step = { readonly t: "call"; readonly name: string; readonly args: unknown } | { readonly t: "answer"; readonly text: string };

function cite(lastUser: string, toolResults: readonly string[], hasTools: boolean): Step {
  const last = toolResults.at(-1);
  if (last === undefined) return hasTools ? { t: "call", name: "kb_search", args: { query: lastUser, k: 3 } } : { t: "answer", text: "No knowledge base tools are attached." };
  const parsed = JSON.parse(last) as { results?: { path: string }[]; entries?: { path: string; body: string }[] };
  if (parsed.results) return parsed.results.length ? { t: "call", name: "kb_read", args: { paths: [parsed.results[0]!.path] } } : { t: "answer", text: "The lab's documents do not cover this question." };
  const entry = parsed.entries?.[0];
  if (!entry) return { t: "answer", text: "The lab's documents do not cover this question." };
  const opening = entry.body.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/).slice(0, 2).join(" ");
  return { t: "answer", text: `${opening}\n\nSource: ${entry.path}` };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function respond(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: string, state: { rejected: number; n: number }) => Promise<void> | void): Promise<FakeCloud> {
  const state = { rejected: 0, n: 0, paths: [] as string[], bodies: [] as unknown[], headers: [] as IncomingMessage["headers"][] };
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    state.paths.push(`${req.method} ${req.url}`);
    state.headers.push(req.headers);
    state.bodies.push(body ? (JSON.parse(body) as unknown) : null);
    state.n += 1;
    await handler(req, res, body, state);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    paths: state.paths,
    bodies: state.bodies,
    headers: state.headers,
    get rejected() {
      return state.rejected;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

interface ChatBody {
  messages: { role: string; content?: string | null }[];
  tools?: unknown[];
}

export function startFakeAzureOpenAI(o: { readonly deployment: string; readonly apiVersion: string; readonly apiKey: string; readonly modelId: string }): Promise<FakeCloud> {
  return serve((req, res, raw, state) => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.headers["api-key"] !== o.apiKey) {
      state.rejected += 1;
      return respond(res, 401, { error: { code: "401", message: "Access denied due to invalid subscription key or wrong API endpoint." } });
    }
    if (req.method !== "POST" || url.pathname !== `/openai/deployments/${o.deployment}/chat/completions`) return respond(res, 404, { error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } });
    if (url.searchParams.get("api-version") !== o.apiVersion) return respond(res, 404, { error: { code: "404", message: "Resource not found" } });
    const body = JSON.parse(raw) as ChatBody;
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const step = cite(lastUser, body.messages.filter((m) => m.role === "tool").map((m) => m.content ?? ""), (body.tools?.length ?? 0) > 0);
    const message = step.t === "answer" ? { role: "assistant", content: step.text } : { role: "assistant", content: null, tool_calls: [{ id: `call_${state.n}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
    respond(res, 200, {
      id: `chatcmpl-${state.n}`,
      object: "chat.completion",
      created: 1730000000,
      model: o.modelId,
      choices: [{ index: 0, message, finish_reason: step.t === "answer" ? "stop" : "tool_calls", content_filter_results: {} }],
      prompt_filter_results: [{ prompt_index: 0, content_filter_results: {} }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    });
  });
}

interface ConverseBody {
  messages: { role: "user" | "assistant"; content: Record<string, unknown>[] }[];
  toolConfig?: { tools: unknown[] };
}

/** The signature AWS would compute for the request as it arrived, or why it cannot. */
function expectedAuthorization(req: IncomingMessage, raw: string, region: string, credentials: AwsCredentials): string | null {
  const auth = req.headers.authorization ?? "";
  const m = /^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=[0-9a-f]{64}$/.exec(auth);
  const date = req.headers["x-amz-date"];
  if (!m || typeof date !== "string" || m[1] !== region || m[2] !== "bedrock") return null;
  const now = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
  const headers: Record<string, string> = {};
  for (const name of m[3]!.split(";")) {
    if (name === "host" || name === "x-amz-date" || name === "x-amz-security-token") continue;
    const v = req.headers[name];
    if (typeof v !== "string") return null;
    headers[name] = v;
  }
  const token = req.headers["x-amz-security-token"];
  const creds = typeof token === "string" ? { ...credentials, sessionToken: token } : credentials;
  return signV4({ method: req.method ?? "POST", url: new URL(req.url ?? "/", `http://${req.headers.host}`), headers, body: raw, region, service: "bedrock", credentials: creds, now }).authorization ?? null;
}

export function startFakeBedrock(o: { readonly region: string; readonly models: readonly string[]; readonly credentials?: AwsCredentials }): Promise<FakeCloud> {
  const credentials = o.credentials ?? TEST_AWS;
  return serve((req, res, raw, state) => {
    if (expectedAuthorization(req, raw, o.region, credentials) !== req.headers.authorization) {
      state.rejected += 1;
      return respond(res, 403, { message: "The request signature we calculated does not match the signature you provided." }, { "x-amzn-errortype": "InvalidSignatureException" });
    }
    const path = /^\/model\/([^/]+)\/converse$/.exec(req.url ?? "");
    if (req.method !== "POST" || !path) return respond(res, 404, { message: "Unknown operation" }, { "x-amzn-errortype": "UnknownOperationException" });
    if (!o.models.includes(decodeURIComponent(path[1]!))) return respond(res, 404, { message: "The provided model identifier is invalid." }, { "x-amzn-errortype": "ResourceNotFoundException" });
    const body = JSON.parse(raw) as ConverseBody;
    const texts = (m: ConverseBody["messages"][number]) => m.content.flatMap((b) => (typeof b.text === "string" ? [b.text] : []));
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user" && texts(m).length)?.content.flatMap((b) => (typeof b.text === "string" ? [b.text] : [])).join("") ?? "";
    const toolResults = body.messages.flatMap((m) => m.content.flatMap((b) => (b.toolResult ? [((b.toolResult as { content: { text: string }[] }).content[0]?.text ?? "")] : [])));
    const step = cite(lastUser, toolResults, (body.toolConfig?.tools.length ?? 0) > 0);
    const content = step.t === "answer" ? [{ text: step.text }] : [{ toolUse: { toolUseId: `tooluse_${state.n}`, name: step.name, input: step.args } }];
    respond(res, 200, {
      output: { message: { role: "assistant", content } },
      stopReason: step.t === "answer" ? "end_turn" : "tool_use",
      usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
      metrics: { latencyMs: 120 },
    });
  });
}
