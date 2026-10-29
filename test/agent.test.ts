import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LOOP_CONTRACT, listingOf, parseAgentDocument, parseExactModelId, resolveAgent, validateAgentDraft, verifyRunnable, versionHash, type Catalog } from "../packages/core/src/agent.ts";
import type { Sha256, SnapshotId, ToolHash } from "../packages/core/src/hash.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/agent.json", import.meta.url), "utf8")) as Record<string, unknown>;

const catalog: Catalog = {
  latestSkill: () => undefined,
  latestSnapshot: (kbId) => (kbId === "handbook" ? { id: "s".repeat(64) as SnapshotId, cls: "D1" } : undefined),
  tool: (name) => (name === "kb_search" || name === "kb_read" ? { hash: name.padEnd(64, "t") as ToolHash, reads: "D0", effects: "read" } : undefined),
  endpoint: (id) => (id === "local" ? { placement: "lab" } : id === "hosted" ? { placement: "zdr" } : undefined),
  sandboxImage: () => undefined,
  dataset: () => undefined,
};

function doc(overrides: Record<string, unknown> = {}) {
  const parsed = parseAgentDocument({ ...fixture, ...overrides });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed.ok ? parsed.doc : (undefined as never);
}

test("the fixture parses, resolves, and its hash is stable", () => {
  const r = resolveAgent(doc(), catalog);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.agent.model.modelId, "scripted-1");
  assert.deepEqual(r.agent.limits, { maxSteps: 40, maxTokens: 1_000_000, maxWallMs: 600_000 });
  assert.deepEqual(r.agent.knowledgeBases, [{ kbId: "handbook", snapshot: "s".repeat(64), cls: "D1" }]);
  assert.deepEqual(r.agent.retrieval, { algorithm: "bm25-v1", readCapTokens: 15_000 });
  const capped = resolveAgent(doc({ readCapTokens: 200 }), catalog);
  assert.ok(capped.ok);
  assert.equal(capped.agent.retrieval.readCapTokens, 200);
  assert.notEqual(versionHash(capped.agent), versionHash(r.agent), "the read cap is behavior, so it is in the hash");
  const again = resolveAgent(doc(), catalog);
  assert.ok(again.ok);
  assert.equal(versionHash(again.agent), versionHash(r.agent));
  assert.match(versionHash(r.agent), /^[0-9a-f]{64}$/);
});

test("changing one character of the instructions changes the hash; changing the description does not", () => {
  const base = resolveAgent(doc(), catalog);
  const edited = resolveAgent(doc({ instructions: `${fixture.instructions as string}.` }), catalog);
  const described = resolveAgent(doc({ description: "Use when you want something else. Not for anything." }), catalog);
  assert.ok(base.ok && edited.ok && described.ok);
  assert.notEqual(versionHash(edited.agent), versionHash(base.agent));
  assert.equal(versionHash(described.agent), versionHash(base.agent));
});

test("the version hash covers exactly what the loop reads: governance fields move to the listing", () => {
  const base = resolveAgent(doc(), catalog);
  assert.ok(base.ok);
  const unchanged: [string, Record<string, unknown>][] = [
    ["ceiling", { ceiling: "D1" }],
    ["provenancePolicy", { provenancePolicy: { numbersMustTrace: true, claimsLinkEvidence: true } }],
    ["irbProtocol", { irbProtocol: "IRB-2026-1" }],
    ["tool scopes", { tools: [{ name: "kb_search", scopes: ["read:all"] }, { name: "kb_read", scopes: ["read:all"] }] }],
  ];
  for (const [name, override] of unchanged) {
    const r = resolveAgent(doc(override), catalog);
    assert.ok(r.ok, name);
    assert.equal(versionHash(r.agent), versionHash(base.agent), `${name} is not behavior`);
  }
  const limited = resolveAgent(doc({ limits: { maxSteps: 3 } }), catalog);
  assert.ok(limited.ok);
  assert.notEqual(versionHash(limited.agent), versionHash(base.agent), "limits are behavior");
  const listing = listingOf(doc({ irbProtocol: "IRB-2026-1" }));
  assert.deepEqual([listing.ceiling, listing.provenancePolicy, listing.irbProtocol], ["D3", { numbersMustTrace: false, claimsLinkEvidence: false }, "IRB-2026-1"]);
});

test("verifyRunnable names every pin the deployment cannot honor", () => {
  const r = resolveAgent(doc(), catalog);
  assert.ok(r.ok);
  const pinned = (name: string) => name.padEnd(64, "t") as ToolHash;
  const deployed = { tools: new Map([["kb_search", pinned("kb_search")], ["kb_read", pinned("kb_read")]]), snapshots: new Set(["s".repeat(64) as SnapshotId]), sandboxImages: new Set<never>(), loopContract: LOOP_CONTRACT, retrieval: new Set(["bm25-v1"]) };
  assert.deepEqual(verifyRunnable(r.agent, deployed), []);
  const moved = { ...deployed, tools: new Map([["kb_search", "u".repeat(64) as ToolHash], ["kb_read", pinned("kb_read")]]), snapshots: new Set<SnapshotId>(), loopContract: "loop-v9", retrieval: new Set<string>() };
  assert.deepEqual(verifyRunnable(r.agent, moved), [
    { t: "tool-changed", tool: "kb_search", pinned: pinned("kb_search"), deployed: "u".repeat(64) },
    { t: "snapshot-missing", snapshot: "s".repeat(64) },
    { t: "loop-contract", pinned: LOOP_CONTRACT, current: "loop-v9" },
    { t: "retrieval-missing", algorithm: "bm25-v1" },
  ]);
});

test("limits from the document override the kind's defaults", () => {
  const r = resolveAgent(doc({ limits: { maxSteps: 2 } }), catalog);
  assert.ok(r.ok);
  assert.deepEqual(r.agent.limits, { maxSteps: 2, maxTokens: 1_000_000, maxWallMs: 600_000 });
  const bg = resolveAgent(doc({ kind: "background" }), catalog);
  assert.ok(bg.ok);
  assert.equal(bg.agent.limits.maxSteps, 200);
});

test("parseExactModelId rejects floating names", () => {
  assert.equal(parseExactModelId("qwen3:8b"), "qwen3:8b");
  assert.equal(parseExactModelId("anthropic/claude-sonnet-4.5"), "anthropic/claude-sonnet-4.5");
  assert.equal(typeof parseExactModelId("qwen3:latest"), "object");
  assert.equal(typeof parseExactModelId("latest"), "object");
  assert.equal(typeof parseExactModelId("openrouter/auto"), "object");
  assert.equal(typeof parseExactModelId("gpt"), "object");
  assert.equal(typeof parseExactModelId(""), "object");
});

test("validateAgentDraft reports the lab rules by field", () => {
  const issues = validateAgentDraft(doc({ description: "Answers things.", model: { endpointId: "hosted", modelId: "latest", params: { temperature: 0, maxOutputTokens: 10 } }, ceiling: "D3", knowledgeBases: ["handbook", "missing"] }), catalog);
  assert.deepEqual(
    issues.map((i) => i.field).sort(),
    ["description", "description", "knowledgeBases", "model.endpointId", "model.modelId"],
  );
  assert.deepEqual(validateAgentDraft(doc(), catalog), []);
});

test("parseAgentDocument reports shape errors with their paths", () => {
  const bad = parseAgentDocument({ ...fixture, ceiling: "D9" });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.issues[0]?.field, "ceiling");
});

test("publish refuses a sandbox mount that lab.toml does not declare or that sits above the mount ceiling", () => {
  const withSandbox: Catalog = { ...catalog, sandboxImage: () => "d".repeat(64) as Sha256, dataset: (id) => (id === "visits" ? { cls: "D1" } : id === "cohort" ? { cls: "D2" } : undefined) };
  const sandbox = (mounts: string[], mountCeiling = "D1") => doc({ ceiling: "D2", sandbox: { enabled: true, mountCeiling, mounts } });
  assert.deepEqual(validateAgentDraft(sandbox(["visits"]), withSandbox), []);
  assert.deepEqual(
    validateAgentDraft(sandbox(["visits", "cohort", "nonesuch"]), withSandbox).map((i) => i.message),
    ["dataset cohort is D2, above the mount ceiling D1", "dataset nonesuch is not in lab.toml"],
  );
  assert.deepEqual(validateAgentDraft(sandbox([], "D3"), withSandbox).map((i) => i.message), ["mount ceiling D3 is above the agent ceiling D2"]);
  const r = resolveAgent(sandbox(["visits"]), withSandbox);
  assert.deepEqual(r.ok && r.agent.sandbox, { imageDigest: "d".repeat(64), mountCeiling: "D1", mounts: ["visits"] });
});

test("an agent that may mount D3 data needs an IRB protocol, as one that reads a D3 knowledge base does", () => {
  const withSandbox: Catalog = { ...catalog, sandboxImage: () => "d".repeat(64) as Sha256, dataset: (id) => (id === "ehr" ? { cls: "D3" } : id === "visits" ? { cls: "D1" } : undefined) };
  const sandbox = (mounts: string[], mountCeiling: string, irb?: string) => doc({ ceiling: "D3", sandbox: { enabled: true, mountCeiling, mounts }, ...(irb ? { irbProtocol: irb } : {}) });
  const irbRule = [{ field: "irbProtocol", severity: "error", message: "an agent that reads D3 data must name its IRB protocol" }];
  assert.deepEqual(validateAgentDraft(sandbox(["ehr"], "D3"), withSandbox), irbRule);
  // The ceiling alone counts: a mount raised to D3 in lab.toml later is mounted under the frozen D3 ceiling.
  assert.deepEqual(validateAgentDraft(sandbox(["visits"], "D3"), withSandbox), irbRule);
  assert.deepEqual(validateAgentDraft(sandbox(["ehr"], "D3", "IRB-2026-1"), withSandbox), []);
  assert.deepEqual(validateAgentDraft(sandbox(["visits"], "D2"), withSandbox), []);
});
