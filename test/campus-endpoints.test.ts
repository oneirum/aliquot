/**
 * Endpoints reached through campus contracts: baa and region on an endpoint, the two refusals that follow a mark,
 * and the Azure OpenAI, Claude in Foundry and Bedrock Converse wire shapes against fakes of each.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, decideEgress, describeRefusal, Labelled, type Mark } from "../packages/core/src/dataclass.ts";
import { createGateway, Prompt, regionOf, type ExactModelId, type ModelEndpoint, type ModelTarget } from "../packages/core/src/gateway.ts";
import { classifyText, marksOf } from "../packages/core/src/gate.ts";
import { parseConfig } from "../packages/core/src/config.ts";
import { startFakeAzureOpenAI, startFakeBedrock, TEST_AWS } from "./fake-cloud.ts";
import { startFakeProvider } from "./fake-provider.ts";
import { memoryRecorder } from "./recorder.ts";

const AZURE_KEY = "azure-test-key";
const BEDROCK_MODEL = "us.anthropic.claude-opus-5-5-v1:0";
/** A base model id, served in the endpoint's own region. */
const IN_REGION = "anthropic.claude-opus-5-5-v1:0";
const azure = await startFakeAzureOpenAI({ deployment: "gpt-4o", apiVersion: "2024-10-21", apiKey: AZURE_KEY, modelId: "gpt-4o-2024-11-20" });
const bedrock = await startFakeBedrock({ region: "us-east-1", models: [BEDROCK_MODEL, IN_REGION, "global.anthropic.claude-opus-5-5-v1:0", "eu.anthropic.claude-opus-5-5-v1:0"] });
after(async () => {
  await azure.close();
  await bedrock.close();
});

process.env.TEST_AZURE_KEY = AZURE_KEY;
process.env.TEST_AWS_ID = TEST_AWS.accessKeyId;
process.env.TEST_AWS_SECRET = TEST_AWS.secretAccessKey;
const aws = { region: "us-east-1", accessKeyIdEnv: "TEST_AWS_ID", secretAccessKeyEnv: "TEST_AWS_SECRET", sessionTokenEnv: "TEST_AWS_TOKEN" };
const azureEndpoint = (id: string, baa: boolean, region?: string): ModelEndpoint => ({
  id,
  baseUrl: `${azure.url}/openai/deployments/gpt-4o`,
  apiVersion: "2024-10-21",
  placement: "institution",
  apiKeyEnv: "TEST_AZURE_KEY",
  authHeader: "api-key",
  models: ["gpt-4o-2024-11-20"],
  supportsLogprobs: false,
  baa,
  ...(region ? { region } : {}),
});
const bedrockEndpoint = (id: string, region: string | undefined, baa = true): ModelEndpoint => ({
  id,
  baseUrl: bedrock.url,
  protocol: "bedrock-converse",
  placement: "institution",
  models: [BEDROCK_MODEL, IN_REGION],
  supportsLogprobs: false,
  aws,
  baa,
  ...(region ? { region } : {}),
});
const endpoints = [azureEndpoint("azure-nobaa", false, "us"), azureEndpoint("azure-baa", true, "us"), bedrockEndpoint("bedrock-eu", "eu"), bedrockEndpoint("bedrock-us", "us"), { id: "gpu", baseUrl: "http://127.0.0.1:9", placement: "lab", supportsLogprobs: false } satisfies ModelEndpoint];
const gateway = createGateway(endpoints, DEFAULT_POLICY, fetch);
const target = (endpointId: string, modelId: string): ModelTarget => ({ endpointId, modelId: modelId as ExactModelId, params: { temperature: 0, maxOutputTokens: 64 } });
const opts = { signal: new AbortController().signal, step: 1, attempt: 1, final: false };
const KB_TOOL = { name: "kb_search", description: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } } };

/** A prompt whose user part went through the gate's classifier, as a member's message does. */
function asked(text: string): Prompt {
  const { cls, detections } = classifyText(text, "D1", []);
  return Prompt.of([{ role: "system", content: Labelled.stamp("Answer from the handbook.", "D1", "t") }, { role: "user", content: Labelled.stamp(text, cls, "gate", marksOf(detections)) }], [KB_TOOL]);
}

// The decision itself ----------------------------------------------------------------------------------------------

const at = (marks: readonly Mark[]) => Labelled.stamp("x", "D1", "t", marks);
const model = (placement: "lab" | "institution" | "approved", baa: boolean, region: string | null) => ({ kind: "model", endpointId: "e", placement, baa, region }) as const;

test("PHI is refused at a hosted endpoint without baa, and allowed with one or on lab hardware", () => {
  assert.deepEqual(decideEgress(at(["phi"]), model("approved", false, "us"), DEFAULT_POLICY), { allow: false, refusal: { code: "phi-needs-baa", endpointId: "e" } });
  assert.equal(decideEgress(at(["phi"]), model("approved", true, null), DEFAULT_POLICY).allow, true);
  assert.equal(decideEgress(at(["phi"]), model("lab", false, null), DEFAULT_POLICY).allow, true);
  assert.equal(decideEgress(at([]), model("approved", false, null), DEFAULT_POLICY).allow, true, "unmarked content needs neither");
});

test("export-controlled and CUI content are refused at a hosted endpoint outside the US or of undeclared region", () => {
  assert.deepEqual(decideEgress(at(["export-controlled"]), model("approved", true, "eu"), DEFAULT_POLICY), { allow: false, refusal: { code: "export-needs-us", mark: "export-controlled", endpointId: "e", region: "eu" } });
  assert.deepEqual(decideEgress(at(["cui"]), model("institution", true, null), DEFAULT_POLICY), { allow: false, refusal: { code: "export-needs-us", mark: "cui", endpointId: "e", region: null } });
  assert.equal(decideEgress(at(["export-controlled", "cui"]), model("approved", false, "us"), DEFAULT_POLICY).allow, true);
  assert.equal(decideEgress(at(["export-controlled"]), model("lab", false, null), DEFAULT_POLICY).allow, true);
});

test("the class rule still decides first, and the refusals read as rules", () => {
  const d3 = Labelled.stamp("x", "D3", "t", ["phi"]);
  assert.deepEqual(decideEgress(d3, model("approved", true, "us"), DEFAULT_POLICY), { allow: false, refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D2" } });
  assert.equal(describeRefusal({ code: "phi-needs-baa", endpointId: "azure" }), "PHI may go only to a model endpoint under a business associate agreement, and azure is not marked baa = true");
  assert.equal(describeRefusal({ code: "export-needs-us", mark: "cui", endpointId: "b", region: null }), "CUI may go only to a model endpoint in the US, and b is in an undeclared region");
});

test("marks survive derive as a union, and only another mark can be added", () => {
  const a = Labelled.stamp("a", "D1", "t", ["cui"]);
  const b = Labelled.stamp("b", "D0", "t", ["phi", "phi"]);
  assert.deepEqual(Labelled.derive("ab", [a, b], "t").marks, ["phi", "cui"]);
  assert.deepEqual(Labelled.derive("a", [a], "t").marks, ["cui"]);
  assert.ok(Object.isFrozen(a.marks));
});

test("the gate's stand-in predicate marks PHI, export-controlled and CUI", () => {
  const marks = (t: string) => marksOf(classifyText(t, "D1", []).detections);
  assert.deepEqual(marks("MRN 0012345 came back"), ["phi"]);
  assert.deepEqual(marks("PHI: the visit notes"), ["phi"]);
  assert.deepEqual(marks("This drawing is ITAR"), ["export-controlled"]);
  assert.deepEqual(marks("EXPORT CONTROLLED technical data"), ["export-controlled"]);
  assert.deepEqual(marks("CUI//SP-PRVCY"), ["cui"]);
  assert.deepEqual(marks("What are the office hours? phi and cui are letters"), []);
  assert.equal(classifyText("CUI banner", "D1", []).cls, "D2", "a CUI banner raises the class too");
});

// On the wire -------------------------------------------------------------------------------------------------------

test("PHI to an Azure endpoint without baa is refused with zero requests on the wire", async () => {
  const rec = memoryRecorder();
  const before = azure.paths.length;
  const out = await gateway.complete(target("azure-nobaa", "gpt-4o-2024-11-20"), asked("PHI: does the visit note say the dose changed?"), rec, opts);
  assert.deepEqual(out, { ok: false, t: "refused-egress", refusal: { code: "phi-needs-baa", endpointId: "azure-nobaa" } });
  assert.equal(azure.paths.length, before, "nothing reached the fake Azure");
  assert.deepEqual(rec.events.map((e) => e.t), ["egress.refused"]);
  assert.equal(rec.events.some((e) => e.t === "model.requested"), false);
});

test("export-controlled content to a Bedrock endpoint in region eu is refused with zero requests on the wire", async () => {
  const rec = memoryRecorder();
  const before = bedrock.paths.length;
  const out = await gateway.complete(target("bedrock-eu", IN_REGION), asked("EXPORT CONTROLLED: summarize the test rig drawing"), rec, opts);
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.t === "refused-egress" && out.refusal.code === "export-needs-us");
  assert.equal(bedrock.paths.length, before, "nothing reached the fake Bedrock");
  assert.deepEqual(rec.events.map((e) => e.t), ["egress.refused"]);
});

test("a global. inference profile is not in the US even at an endpoint that says region us", async () => {
  assert.equal(regionOf({ protocol: "bedrock-converse", region: "us" }, "global.anthropic.claude-opus-5-5-v1:0"), null);
  assert.equal(regionOf({ protocol: "bedrock-converse", region: "us" }, "eu.anthropic.claude-opus-5-5-v1:0"), null);
  assert.equal(regionOf({ protocol: "bedrock-converse", region: "eu" }, "us.anthropic.claude-opus-5-5-v1:0"), null, "a prefix never moves a declared region");
  assert.equal(regionOf({ protocol: "bedrock-converse", region: "us" }, "us-gov.anthropic.claude-x-v1:0"), "us");
  assert.equal(regionOf({ protocol: "bedrock-converse" }, "us.anthropic.claude-x-v1:0"), null, "nor supplies an undeclared one");
  assert.equal(regionOf({ protocol: "bedrock-converse", region: "eu" }, IN_REGION), "eu");
  assert.equal(regionOf({ protocol: "openai-chat", region: "us" }, "global.thing"), "us", "only Bedrock ids carry a geography");
  const before = bedrock.paths.length;
  const out = await gateway.complete(target("bedrock-us", "global.anthropic.claude-opus-5-5-v1:0"), asked("CUI//SP-CTI: what does section 2 say?"), memoryRecorder(), opts);
  assert.ok(!out.ok && out.t === "refused-egress" && out.refusal.code === "export-needs-us" && out.refusal.region === null);
  assert.equal(bedrock.paths.length, before);
});

test("Azure OpenAI: deployment URL, api-version query and api-key header, and the same PHI goes through with baa", async () => {
  const rec = memoryRecorder();
  const before = azure.paths.length;
  const out = await gateway.complete(target("azure-baa", "gpt-4o-2024-11-20"), asked("PHI: does the visit note say the dose changed?"), rec, opts);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(azure.paths[before], "POST /openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21");
  assert.equal(azure.headers[before]!["api-key"], AZURE_KEY);
  assert.equal(azure.headers[before]!.authorization, undefined);
  if (out.ok) {
    assert.equal(out.value.providerModelId, "gpt-4o-2024-11-20");
    assert.deepEqual(out.value.toolCalls.map((c) => c.name), ["kb_search"]);
  }
  assert.equal(azure.rejected, 0);
});

test("Bedrock Converse: signed with SigV4, the id in the path, tools as toolSpec, and a tool turn replayed as it came", async () => {
  const before = bedrock.paths.length;
  const first = await gateway.complete(target("bedrock-us", BEDROCK_MODEL), asked("What are the office hours?"), memoryRecorder(), opts);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(bedrock.rejected, 0, "the fake verified the signature");
  assert.equal(bedrock.paths[before], `POST /model/${encodeURIComponent(BEDROCK_MODEL)}/converse`);
  const sent = bedrock.bodies[before] as { system: unknown; toolConfig: unknown; inferenceConfig: unknown; messages: unknown };
  assert.deepEqual(sent.system, [{ text: "Answer from the handbook." }]);
  assert.deepEqual(sent.inferenceConfig, { maxTokens: 64 });
  assert.deepEqual(sent.toolConfig, { tools: [{ toolSpec: { name: "kb_search", description: "search", inputSchema: { json: KB_TOOL.inputSchema } } }], toolChoice: { auto: {} } });
  assert.match(String(bedrock.headers[before]!.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date, /);
  if (!first.ok) return;
  assert.equal(first.value.providerModelId, BEDROCK_MODEL);
  assert.deepEqual(first.value.toolCalls.map((c) => c.name), ["kb_search"]);
  assert.deepEqual(first.value.usage, { input: 30, output: 12 });
  // The second turn carries the tool call and its result; the fake answers from the result.
  const call = first.value.toolCalls[0]!;
  const prompt = Prompt.of(
    [
      { role: "user", content: Labelled.stamp("What are the office hours?", "D1", "t") },
      { role: "assistant", toolCalls: Labelled.stamp([{ id: call.id, name: "kb_search", args: { query: "office hours" } }], "D1", "t") },
      { role: "tool", callId: call.id, content: Labelled.stamp(JSON.stringify({ entries: [{ path: "handbook/hours.md", body: "Office hours are Tuesdays at 2pm. Bring questions." }] }), "D1", "t") },
    ],
    [KB_TOOL],
    "none",
  );
  const second = await gateway.complete(target("bedrock-us", BEDROCK_MODEL), prompt, memoryRecorder(), opts);
  assert.equal(second.ok, true, JSON.stringify(second));
  if (second.ok) assert.equal(second.value.text, "Office hours are Tuesdays at 2pm. Bring questions.\n\nSource: handbook/hours.md");
  const sent2 = bedrock.bodies.at(-1) as { messages: { role: string; content: Record<string, unknown>[] }[]; toolConfig: Record<string, unknown> };
  assert.deepEqual(sent2.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(sent2.messages[2]!.content[0], { toolResult: { toolUseId: call.id, content: [{ text: JSON.stringify({ entries: [{ path: "handbook/hours.md", body: "Office hours are Tuesdays at 2pm. Bring questions." }] }) }], status: "success" } });
  assert.equal("toolChoice" in sent2.toolConfig, false, "Converse has no toolChoice none; a final call sends none");
});

test("Bedrock with a wrong secret is a 403 from the fake, recorded as a failed call, not retried", async () => {
  const wrong = createGateway([{ ...bedrockEndpoint("b", "us"), aws: { ...aws, secretAccessKeyEnv: "TEST_AWS_WRONG" } }], DEFAULT_POLICY, fetch);
  process.env.TEST_AWS_WRONG = "not-the-secret";
  const out = await wrong.complete(target("b", BEDROCK_MODEL), asked("What are the office hours?"), memoryRecorder(), opts);
  assert.ok(!out.ok && out.t === "failed" && out.failure.code === "http" && out.failure.status === 403 && !out.retryable);
  delete process.env.TEST_AWS_WRONG;
  const missing = await createGateway([{ ...bedrockEndpoint("b", "us"), aws: { ...aws, accessKeyIdEnv: "TEST_AWS_UNSET" } }], DEFAULT_POLICY, fetch).complete(target("b", BEDROCK_MODEL), asked("hi"), memoryRecorder(), opts);
  assert.ok(!missing.ok && missing.t === "failed" && !missing.retryable);
});

test("Claude in Microsoft Foundry is anthropic-messages at the resource's /anthropic base", async () => {
  const fake = await startFakeProvider();
  try {
    fake.reply("POST /anthropic/v1/messages", { body: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Tuesdays." }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 2 } } });
    process.env.TEST_FOUNDRY_KEY = "foundry-key";
    const g = createGateway([{ id: "foundry", baseUrl: `${fake.url}/anthropic`, protocol: "anthropic-messages", placement: "institution", apiKeyEnv: "TEST_FOUNDRY_KEY", baa: true, region: "us", supportsLogprobs: false }], DEFAULT_POLICY, fetch);
    const out = await g.complete(target("foundry", "claude-opus-5-5"), asked("PHI: when are office hours?"), memoryRecorder(), opts);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(fake.sent[0]!.headers["x-api-key"], "foundry-key");
    assert.equal(fake.sent[0]!.headers["anthropic-version"], "2023-06-01");
  } finally {
    await fake.close();
  }
});

// lab.toml ----------------------------------------------------------------------------------------------------------

const toml = (endpoint: string) => `[endpoints.x]\n${endpoint}\n[surfaces.web]\nplacement = "lab"\n`;

test("lab.toml: baa defaults false, region unknown; both parse when given", () => {
  const plain = parseConfig(toml('base_url = "http://h/v1"\nplacement = "approved"'), "/lab/lab.toml").endpoints[0]!;
  assert.equal(plain.baa, undefined, "absent is false");
  assert.equal(plain.region, undefined);
  const azureCfg = parseConfig(toml('base_url = "https://r.openai.azure.com/openai/deployments/gpt-4o"\nplacement = "approved"\nbaa = true\nregion = "us"\napi_version = "2024-10-21"\nauth_header = "api-key"\napi_key_env = "AZURE_OPENAI_API_KEY"\nmodels = ["gpt-4o-2024-11-20"]'), "/lab/lab.toml").endpoints[0]!;
  assert.deepEqual([azureCfg.baa, azureCfg.region, azureCfg.apiVersion, azureCfg.authHeader], [true, "us", "2024-10-21", "api-key"]);
  assert.throws(() => parseConfig(toml('base_url = "http://h/v1"\nplacement = "approved"\nregion = "US"'), "/l"), /lowercase/);
});

test("lab.toml: a bedrock-converse endpoint needs aws_region and models, and takes no api key", () => {
  const ok = parseConfig(toml(`base_url = "https://bedrock-runtime.us-east-1.amazonaws.com"\nplacement = "approved"\nprotocol = "bedrock-converse"\naws_region = "us-east-1"\nmodels = ["${BEDROCK_MODEL}"]\nbaa = true\nregion = "us"`), "/l").endpoints[0]!;
  assert.deepEqual(ok.aws, { region: "us-east-1", accessKeyIdEnv: "AWS_ACCESS_KEY_ID", secretAccessKeyEnv: "AWS_SECRET_ACCESS_KEY", sessionTokenEnv: "AWS_SESSION_TOKEN" });
  const bad = (body: string, why: RegExp) => assert.throws(() => parseConfig(toml(`base_url = "https://b"\nplacement = "approved"\n${body}`), "/l"), why);
  bad(`protocol = "bedrock-converse"\nmodels = ["m"]`, /without aws_region/);
  bad(`protocol = "bedrock-converse"\naws_region = "us-east-1"`, /without models/);
  bad(`protocol = "bedrock-converse"\naws_region = "us-east-1"\nmodels = ["m"]\napi_key_env = "K"`, /signs every request/);
  bad(`aws_region = "us-east-1"`, /only protocol = "bedrock-converse"/);
  bad(`protocol = "bedrock-converse"\naws_region = "eu-west-1"\nmodels = ["m"]\nregion = "us"`, /signs for eu-west-1/);
  bad(`protocol = "bedrock-converse"\naws_region = "us-east-1"\nmodels = ["global.anthropic.claude-opus-5-5-v1:0"]\nregion = "us"`, /may run outside the US/);
});

// Knowledge bases -----------------------------------------------------------------------------------------------------

test("a knowledge base with one PHI entry marks every search and read of it; an unmarked one marks none", async () => {
  const { createKbReader, memorySnapshots, snapshotFromFixture } = await import("../packages/core/src/kb.ts");
  const { keyedAddresser } = await import("../packages/core/src/hash.ts");
  const { readFile } = await import("node:fs/promises");
  const address = keyedAddresser(new Uint8Array(32).fill(7));
  const fixture = JSON.parse(await readFile(new URL("../fixtures/kb.json", import.meta.url), "utf8")) as { entries: { path: string; title: string; body: string }[] };
  const plain = snapshotFromFixture(fixture, address);
  const withPhi = snapshotFromFixture({ ...fixture, entries: [...fixture.entries, { path: "clinic/visit.md", title: "Visit log", body: "MRN 0012345 seen on Tuesday.", facts: [] }] }, address);
  const reader = createKbReader(memorySnapshots([plain, withPhi]));
  assert.deepEqual((await reader.search(plain.snapshot.id, "office hours", 3)).marks, []);
  assert.deepEqual((await reader.search(withPhi.snapshot.id, "office hours", 3)).marks, ["phi"]);
  assert.deepEqual((await reader.outline(withPhi.snapshot.id)).marks, ["phi"]);
});
