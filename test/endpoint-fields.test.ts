import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOP_CONTRACT, parseAgentDocument, resolveAgent, verifyRunnable, type Catalog } from "../packages/core/src/agent.ts";
import { configProblem, parseConfig } from "../packages/core/src/config.ts";
import { DEFAULT_POLICY, Labelled, type DataClass } from "../packages/core/src/dataclass.ts";
import { createGateway, Prompt, type ExactModelId, type ModelEndpoint, type ModelTarget } from "../packages/core/src/gateway.ts";
import type { SnapshotId, ToolHash } from "../packages/core/src/hash.ts";
import { startFakeProvider } from "./fake-provider.ts";
import { memoryRecorder } from "./recorder.ts";
import * as A from "./provider-fixtures/anthropic-messages.ts";
import * as R from "./provider-fixtures/openai-responses.ts";

const fake = await startFakeProvider();
after(() => fake.close());

process.env.LABH_TEST_FIELDS_KEY = "env-key";
const dir = mkdtempSync(join(tmpdir(), "aliquot-endpoint-fields-"));
const target = (endpointId: string, modelId: string): ModelTarget => ({ endpointId, modelId: modelId as ExactModelId, params: { temperature: 0, maxOutputTokens: 64 } });
const opts = { signal: new AbortController().signal, step: 1, attempt: 1, final: false };
const prompt = () => Prompt.of([{ role: "user", content: Labelled.stamp("office hours", "D1", "t") }], []);
const auth = (h: Record<string, unknown>) => ({ authorization: h.authorization, "x-api-key": h["x-api-key"], "api-key": h["api-key"] });

test("each protocol keeps its header by default, and auth_header picks bearer, x-api-key or api-key", async () => {
  const at = (id: string, protocol: ModelEndpoint["protocol"], authHeader?: ModelEndpoint["authHeader"]): ModelEndpoint => ({
    id,
    baseUrl: protocol === "anthropic-messages" ? fake.url : `${fake.url}/v1`,
    placement: "approved",
    supportsLogprobs: false,
    protocol,
    apiKeyEnv: "LABH_TEST_FIELDS_KEY",
    ...(authHeader ? { authHeader } : {}),
  });
  const shapes: [ModelEndpoint, ReturnType<typeof auth>][] = [
    [at("anthropic", "anthropic-messages"), { authorization: undefined, "x-api-key": "env-key", "api-key": undefined }],
    [at("responses", "openai-responses"), { authorization: "Bearer env-key", "x-api-key": undefined, "api-key": undefined }],
    [at("chat", "openai-chat"), { authorization: "Bearer env-key", "x-api-key": undefined, "api-key": undefined }],
    [at("foundry-bearer", "anthropic-messages", "bearer"), { authorization: "Bearer env-key", "x-api-key": undefined, "api-key": undefined }],
    [at("azure", "openai-responses", "api-key"), { authorization: undefined, "x-api-key": undefined, "api-key": "env-key" }],
    [at("gateway", "openai-chat", "x-api-key"), { authorization: undefined, "x-api-key": "env-key", "api-key": undefined }],
  ];
  const gateway = createGateway(shapes.map(([e]) => e), DEFAULT_POLICY, fetch);
  for (const [e, expected] of shapes) {
    await gateway.complete(target(e.id, "m-1"), prompt(), memoryRecorder(), opts);
    const sent = fake.sent.at(-1)!;
    assert.deepEqual(auth(sent.headers), expected, e.id);
    assert.equal(sent.headers["anthropic-version"], e.protocol === "anthropic-messages" ? "2023-06-01" : undefined, e.id);
  }
});

test("api_key_file is read on every request, so a timer outside Aliquot can refresh a short-lived token", async () => {
  const file = join(dir, "token");
  const gateway = createGateway([{ id: "vertexish", baseUrl: `${fake.url}/v1`, placement: "approved", supportsLogprobs: false, protocol: "openai-responses", apiKeyFile: file }], DEFAULT_POLICY, fetch);
  writeFileSync(file, "first-token\n");
  fake.reply("POST /v1/responses", { body: R.answer }, { body: R.answer });
  assert.ok((await gateway.complete(target("vertexish", R.MODEL), prompt(), memoryRecorder(), opts)).ok);
  assert.equal(fake.sent.at(-1)!.headers.authorization, "Bearer first-token");
  writeFileSync(file, "second-token");
  assert.ok((await gateway.complete(target("vertexish", R.MODEL), prompt(), memoryRecorder(), opts)).ok);
  assert.equal(fake.sent.at(-1)!.headers.authorization, "Bearer second-token");
});

test("an api_key_file that cannot be read fails the call before anything is sent, and the failure names the file, not a key", async () => {
  const missing = join(dir, "nope");
  const gateway = createGateway([{ id: "gone", baseUrl: `${fake.url}/v1`, placement: "approved", supportsLogprobs: false, apiKeyFile: missing }], DEFAULT_POLICY, fetch);
  const before = fake.sent.length;
  const rec = memoryRecorder();
  const out = await gateway.complete(target("gone", "m-1"), prompt(), rec, opts);
  assert.equal(fake.sent.length, before);
  assert.ok(!out.ok && out.t === "failed");
  assert.equal(out.retryable, true);
  assert.match(String(rec.body(out.failure.detail!)), new RegExp(`api_key_file ${missing} could not be read`));
});

test("an endpoint with models answers serves from the list and asks the provider nothing", async () => {
  const gateway = createGateway([{ id: "bedrock", baseUrl: `${fake.url}/anthropic`, placement: "approved", supportsLogprobs: false, protocol: "anthropic-messages", models: ["us.anthropic.claude-sonnet-5"] }], DEFAULT_POLICY, fetch);
  const before = fake.sent.length;
  assert.equal(await gateway.serves(target("bedrock", "us.anthropic.claude-sonnet-5")), true);
  assert.equal(await gateway.serves(target("bedrock", "us.anthropic.claude-opus-5-5")), false);
  assert.equal(fake.sent.length, before);
});

const bedrockToml = (models: string) => `[endpoints.local]
base_url = "http://127.0.0.1:9/v1"
placement = "lab"

[endpoints.bedrock]
base_url = "${fake.url}/anthropic"
protocol = "anthropic-messages"
placement = "approved"
api_key_env = "LABH_TEST_FIELDS_KEY"
${models}
`;

test("a band agent on an endpoint with no model list is runnable once models names its id", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/agent.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const params = { temperature: 0, maxOutputTokens: 1024 };
  const parsed = parseAgentDocument({ ...fixture, modelsByClass: [{ upTo: "D2" satisfies DataClass, model: { endpointId: "bedrock", modelId: "us.anthropic.claude-sonnet-5", params } }] });
  assert.ok(parsed.ok);
  const problems = async (toml: string) => {
    const config = parseConfig(toml, join(dir, "lab.toml"));
    const catalog: Catalog = {
      latestSkill: () => undefined,
      dataset: () => undefined,
      latestSnapshot: (kbId) => (kbId === "handbook" ? { id: "s".repeat(64) as SnapshotId, cls: "D1" } : undefined),
      tool: (name) => ({ hash: name.padEnd(64, "t") as ToolHash, reads: "D0", effects: "read" }),
      endpoint: (id) => config.endpoints.find((e) => e.id === id),
      sandboxImage: () => undefined,
    };
    const r = resolveAgent(parsed.doc, catalog);
    assert.ok(r.ok, JSON.stringify(r));
    const gateway = createGateway(config.endpoints, DEFAULT_POLICY, fetch);
    // As the worker's servedBands asks it at run start.
    const served = new Map<string, Set<string>>();
    for (const t of [...r.agent.modelsByClass!.map((b) => b.target), r.agent.model]) {
      const ids = served.get(t.endpointId) ?? new Set<string>();
      served.set(t.endpointId, ids);
      if (t.endpointId === "local" || (await gateway.serves(t))) ids.add(t.modelId);
    }
    return verifyRunnable(r.agent, { tools: new Map(r.agent.tools.map((t) => [t.name, t.hash])), snapshots: new Set(r.agent.knowledgeBases.map((k) => k.snapshot)), sandboxImages: new Set(), loopContract: LOOP_CONTRACT, retrieval: new Set([r.agent.retrieval.algorithm]), served });
  };
  // Bedrock's /anthropic route documents no model list; the fake answers 404 to it, as an unknown route.
  assert.deepEqual(await problems(bedrockToml("")), [{ t: "model-unavailable", modelId: "us.anthropic.claude-sonnet-5" }]);
  assert.deepEqual(await problems(bedrockToml('models = ["us.anthropic.claude-sonnet-5"]')), []);
});

test("lab.toml reads auth_header, api_key_file beside lab.toml, and models", () => {
  const c = parseConfig(
    `[endpoints.azure]
base_url = "https://r.openai.azure.com/openai/v1"
protocol = "openai-responses"
placement = "approved"
api_key_env = "AZURE_OPENAI_API_KEY"
auth_header = "api-key"

[endpoints.vertex]
base_url = "http://litellm:4000/v1"
placement = "approved"
api_key_file = "secrets/vertex-token"
models = ["claude-sonnet-5@20260901"]
`,
    "/l/config/lab.toml",
  );
  assert.deepEqual(c.endpoints, [
    { id: "azure", baseUrl: "https://r.openai.azure.com/openai/v1", placement: "approved", apiKeyEnv: "AZURE_OPENAI_API_KEY", authHeader: "api-key", supportsLogprobs: false, protocol: "openai-responses" },
    { id: "vertex", baseUrl: "http://litellm:4000/v1", placement: "approved", apiKeyFile: "/l/config/secrets/vertex-token", models: ["claude-sonnet-5@20260901"], supportsLogprobs: false, protocol: "openai-chat" },
  ]);
});

test("lab.toml refuses a key named twice, an unknown header and an empty model list, each in one line naming the endpoint", () => {
  const head = '[endpoints.x]\nbase_url = "https://x.example/v1"\nplacement = "approved"\n';
  const refused: [string, string, RegExp][] = [
    ["api_key_env and api_key_file", 'api_key_env = "K"\napi_key_file = "k"\n', /^lab\.toml: endpoint x .*api_key_env.*api_key_file/],
    ["an unknown auth_header", 'auth_header = "basic"\n', /^lab\.toml: endpoint x .*auth_header/],
    ["models = []", "models = []\n", /^lab\.toml: endpoint x .*models/],
  ];
  for (const [what, toml, message] of refused) assert.throws(() => parseConfig(`${head}${toml}`, "/l/lab.toml"), (err: Error) => message.test(err.message) && !err.message.includes("\n"), what);
});

test("a zdr endpoint pinned to a Covered Model refuses at startup, whatever the id's prefix", async () => {
  const zdr = (models: string, placement = "zdr") => `[endpoints.anthropic]\nbase_url = "https://api.anthropic.com"\nprotocol = "anthropic-messages"\nplacement = "${placement}"\nmodels = ${models}\n`;
  const path = join(dir, "covered.toml");
  writeFileSync(path, zdr('["claude-opus-5-5", "claude-fable-5-1"]'));
  assert.equal(await configProblem(path), "lab.toml: endpoint anthropic: claude-fable-5-1 is a Covered Model, which Anthropic keeps for 30 days on every route, so no endpoint serving it is zdr; give it the placement that 30-day retention allows");
  for (const id of ["claude-mythos-5", "us.anthropic.claude-fable-5-1-v1:0", "anthropic/claude-mythos-5.1", "Claude-Fable-5"]) assert.throws(() => parseConfig(zdr(`["${id}"]`), path), /Covered Model/, id);
  assert.equal(parseConfig(zdr('["claude-fable-5-1"]', "approved"), path).endpoints[0]!.placement, "approved");
  assert.equal(parseConfig(zdr('["claude-opus-5-5", "claude-fable-4"]'), path).endpoints[0]!.placement, "zdr");
});

test("an agent that pins a Covered Model to a zdr endpoint is a publish error, and the gateway refuses the call without sending it", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/agent.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const params = { temperature: 0, maxOutputTokens: 1024 };
  const catalog: Catalog = {
    latestSkill: () => undefined,
    dataset: () => undefined,
    latestSnapshot: (kbId) => (kbId === "handbook" ? { id: "s".repeat(64) as SnapshotId, cls: "D1" } : undefined),
    tool: (name) => ({ hash: name.padEnd(64, "t") as ToolHash, reads: "D0", effects: "read" }),
    endpoint: (id) => (id === "hosted" ? { placement: "zdr" } : id === "local" ? { placement: "lab" } : undefined),
    sandboxImage: () => undefined,
  };
  const issues = (doc: Record<string, unknown>) => {
    const parsed = parseAgentDocument({ ...fixture, ...doc });
    assert.ok(parsed.ok);
    const r = resolveAgent(parsed.doc, catalog);
    return r.ok ? [] : r.issues.map((i) => `${i.field}: ${i.message}`);
  };
  const covered = "claude-fable-5-1 is a Covered Model, which Anthropic keeps for 30 days on every route, so no endpoint serving it is zdr";
  assert.deepEqual(issues({ ceiling: "D1", model: { endpointId: "hosted", modelId: "claude-fable-5-1", params } }), [`model.endpointId: ${covered}`]);
  assert.deepEqual(issues({ modelsByClass: [{ upTo: "D1", model: { endpointId: "hosted", modelId: "claude-fable-5-1", params } }] }), [`modelsByClass: band 1: ${covered}`]);
  assert.deepEqual(issues({ modelsByClass: [{ upTo: "D1", model: { endpointId: "hosted", modelId: "claude-opus-5-5", params } }] }), []);

  const gateway = createGateway([{ id: "hosted", baseUrl: fake.url, placement: "zdr", supportsLogprobs: false, protocol: "anthropic-messages" }], DEFAULT_POLICY, fetch);
  const before = fake.sent.length;
  const rec = memoryRecorder();
  const out = await gateway.complete(target("hosted", "claude-fable-5-1"), prompt(), rec, opts);
  assert.equal(fake.sent.length, before);
  assert.deepEqual(out, { ok: false, t: "refused-egress", refusal: { code: "covered-model", modelId: "claude-fable-5-1", placement: "zdr" } });
  assert.equal(rec.events.at(-1)!.t, "egress.refused");
  fake.reply("POST /v1/messages", { body: A.answer });
  assert.ok((await gateway.complete(target("hosted", A.MODEL), prompt(), memoryRecorder(), opts)).ok);
});

test("lab.example.toml's Bedrock, Azure, Foundry, Gemini, campus gateway and campus contract blocks parse once uncommented", () => {
  const path = fileURLToPath(new URL("../lab.example.toml", import.meta.url));
  const text = readFileSync(path, "utf8");
  const expected: Record<string, Partial<ModelEndpoint>> = {
    bedrock: { placement: "approved", protocol: "anthropic-messages", models: ["us.anthropic.claude-sonnet-5"] },
    azure: { placement: "approved", protocol: "openai-responses", authHeader: "api-key" },
    foundry: { placement: "approved", protocol: "anthropic-messages" },
    gemini: { placement: "public", protocol: "openai-chat" },
    campus: { placement: "institution", protocol: "openai-chat" },
    "azure-hipaa": { placement: "institution", protocol: "openai-chat", apiVersion: "2024-10-21", baa: true, region: "us" },
    "bedrock-converse": { placement: "institution", protocol: "bedrock-converse", baa: true, region: "us", aws: { region: "us-east-1", accessKeyIdEnv: "AWS_ACCESS_KEY_ID", secretAccessKeyEnv: "AWS_SECRET_ACCESS_KEY", sessionTokenEnv: "AWS_SESSION_TOKEN" } },
  };
  for (const [id, want] of Object.entries(expected)) {
    const start = text.indexOf(`# [endpoints.${id}]`);
    assert.notEqual(start, -1, id);
    const end = text.indexOf("\n\n", start);
    const block = text.slice(start, end).replace(/^# ((?:\[|[a-z_]+ = ).*)$/gm, "$1");
    const e = parseConfig(`${text.slice(0, start)}${block}${text.slice(end)}`, path).endpoints.find((x) => x.id === id);
    assert.ok(e, id);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(e[k as keyof ModelEndpoint], v, `${id}.${k}`);
  }
});
