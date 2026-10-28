import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseAgentDocument, resolveAgent, versionHash, type AgentDocument, type Catalog, type MemberId } from "../packages/core/src/agent.ts";
import { loadAudit, verifyAudit } from "../packages/core/src/audit.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import { intake, type IntakeDeps } from "../packages/core/src/frontdoor.ts";
import type { SnapshotId, ToolHash } from "../packages/core/src/hash.ts";
import { confirmPublish, draftHashOf, PublishRefused, publishedAgentFor, requestPublish } from "../packages/core/src/publish.ts";
import { mayPreview, type Actor } from "../packages/core/src/roles.ts";
import { createQueue } from "../packages/core/src/queue.ts";
import { createPayloadStore } from "../packages/core/src/record.ts";
import { WEB_SURFACE, testDraft } from "../packages/core/src/surfaces/web.ts";
import { freshDatabase } from "./db.ts";

const { db } = await freshDatabase("labh_test_publish");
after(() => db.end());

const fixture = JSON.parse(await readFile(new URL("../fixtures/agent.json", import.meta.url), "utf8")) as Record<string, unknown>;
const catalog: Catalog = {
  latestSkill: () => undefined,
  latestSnapshot: (kbId) => (kbId === "handbook" ? { id: "s".repeat(64) as SnapshotId, cls: "D1" } : undefined),
  tool: (name) => (name === "kb_search" || name === "kb_read" ? { hash: (name === "kb_search" ? "t" : "r").repeat(64) as ToolHash, reads: "D0", effects: "read" } : undefined),
  endpoint: (id) => (id === "local" ? { placement: "lab" } : undefined),
  sandboxImage: () => undefined,
};
const deps = { db, catalog: async () => catalog };
const member: Actor = { id: "mia" as MemberId, role: "member" };
const author: Actor = { id: "ana" as MemberId, role: "author" };
const publisher: Actor = { id: "pat" as MemberId, role: "publisher" };
const steward: Actor = { id: "sam" as MemberId, role: "steward" };
const pi: Actor = { id: "pia" as MemberId, role: "pi" };

/** D1 by default: the fixture's D3 ceiling needs a publisher, which only the roles test is about. */
function doc(overrides: Record<string, unknown>): AgentDocument {
  const parsed = parseAgentDocument({ ...fixture, ceiling: "D1", ...overrides });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.doc;
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PublishRefused) return err.refusal.t;
    throw err;
  }
  assert.fail("expected PublishRefused");
}

test("members and authors cannot publish, a publisher publishes below D3, and D3 needs the data steward or the PI", async () => {
  const d1 = doc({ agentId: "roles-d1", ceiling: "D1" });
  const d3 = doc({ agentId: "roles-d3", ceiling: "D3" });
  const d3pi = doc({ agentId: "roles-pi", ceiling: "D3" });
  assert.deepEqual((await requestPublish(deps, d1, member)).refusal, { t: "role", role: "member", cls: "D1" });
  assert.equal(await refusalOf(confirmPublish(deps, d1, draftHashOf(d1), member, "first")), "role");
  assert.equal(await refusalOf(confirmPublish(deps, d1, draftHashOf(d1), author, "first")), "role");
  assert.equal(await refusalOf(confirmPublish(deps, d3, draftHashOf(d3), publisher, "first")), "role");
  assert.equal((await confirmPublish(deps, d1, draftHashOf(d1), publisher, "first")).t, "published");
  assert.equal((await confirmPublish(deps, d3, draftHashOf(d3), steward, "first")).t, "published");
  assert.equal((await confirmPublish(deps, d3pi, draftHashOf(d3pi), pi, "first")).t, "published");
  const heads = await db.query<{ agent_id: string; published_by: string }>("select agent_id, published_by from agent_heads where agent_id like 'roles-%' order by agent_id");
  assert.deepEqual(heads.rows, [
    { agent_id: "roles-d1", published_by: "pat" },
    { agent_id: "roles-d3", published_by: "sam" },
    { agent_id: "roles-pi", published_by: "pia" },
  ]);
});

test("a publisher cannot take a restricted head by lowering the ceiling, or bind a channel a restricted head serves", async () => {
  const held = doc({ agentId: "held-d3", ceiling: "D3", channels: ["web:consent"] });
  assert.equal((await confirmPublish(deps, held, draftHashOf(held), steward, "restricted")).t, "published");
  const lowered = doc({ agentId: "held-d3", ceiling: "D1", channels: ["web:consent"] });
  assert.deepEqual((await requestPublish(deps, lowered, publisher)).refusal, { t: "role", role: "publisher", cls: "D3" });
  assert.equal(await refusalOf(confirmPublish(deps, lowered, draftHashOf(lowered), publisher, "lower it")), "role");
  const squatter = doc({ agentId: "consent-squatter", ceiling: "D1", channels: ["web:consent"] });
  assert.deepEqual((await requestPublish(deps, squatter, publisher)).refusal, { t: "role", role: "publisher", cls: "D3" });
  assert.equal(await refusalOf(confirmPublish(deps, squatter, draftHashOf(squatter), publisher, "take the channel")), "role");
  assert.deepEqual(await publishedAgentFor(db, { surface: "web", channelId: "consent" }), held, "the steward's agent still serves the channel");
  const elsewhere = doc({ agentId: "consent-squatter", ceiling: "D1", channels: ["web:other"] });
  assert.equal((await confirmPublish(deps, elsewhere, draftHashOf(elsewhere), publisher, "own channel")).t, "published");
  assert.equal((await confirmPublish(deps, lowered, draftHashOf(lowered), steward, "the steward may lower it")).t, "published");
});

test("a member tests drafts below D3; testing at D3 or R needs the people who publish there", () => {
  assert.deepEqual(
    (["member", "author", "publisher", "steward", "pi"] as const).map((role) => [role, mayPreview(role, "D2"), mayPreview(role, "D3"), mayPreview(role, "R")]),
    [
      ["member", true, false, false],
      ["author", true, false, false],
      ["publisher", true, false, false],
      ["steward", true, true, true],
      ["pi", true, true, true],
    ],
  );
});

test("invalid drafts, stale checks and an empty changelog are refused before anything is written", async () => {
  const vague = doc({ agentId: "refused", description: "Answers questions.", model: { endpointId: "local", modelId: "latest", params: { temperature: 0, maxOutputTokens: 64 } } });
  const check = await requestPublish(deps, vague, publisher);
  assert.equal(check.version, null);
  assert.deepEqual(
    check.validation.map((i) => i.field),
    ["description", "description", "model.modelId"],
  );
  assert.equal(await refusalOf(confirmPublish(deps, vague, check.draftHash, publisher, "try")), "invalid");
  const good = doc({ agentId: "refused" });
  assert.equal(await refusalOf(confirmPublish(deps, good, check.draftHash, publisher, "try")), "stale");
  assert.equal(await refusalOf(confirmPublish(deps, good, draftHashOf(good), publisher, "   ")), "changelog-missing");
  const rows = await db.query("select 1 from agent_heads where agent_id = 'refused'");
  assert.equal(rows.rowCount, 0);
});

test("publish moves the head and appends one audit row; republishing an edit makes a new version and leaves the old row as it was", async () => {
  const v1 = doc({ agentId: "flow", channels: ["web:flow"] });
  const first = await confirmPublish(deps, v1, draftHashOf(v1), publisher, "First version");
  assert.equal(first.t, "published");
  const r1 = resolveAgent(v1, catalog);
  assert.ok(r1.ok);
  assert.equal(first.head.version, versionHash(r1.agent));
  const oldRow = await db.query("select hash, agent_id, body, created_at from agent_versions where hash = $1", [first.head.version]);

  const again = await confirmPublish(deps, v1, draftHashOf(v1), publisher, "Same again");
  assert.deepEqual(again, { t: "unchanged", head: first.head });

  const v2 = doc({ agentId: "flow", channels: ["web:flow"], instructions: `${fixture.instructions as string} Cite the handbook section.` });
  const second = await confirmPublish(deps, v2, draftHashOf(v2), publisher, "Cite sections");
  assert.equal(second.t, "published");
  assert.notEqual(second.head.version, first.head.version);
  assert.equal(second.t === "published" ? second.previous : null, first.head.version);
  assert.deepEqual((await db.query("select hash, agent_id, body, created_at from agent_versions where hash = $1", [first.head.version])).rows, oldRow.rows);

  const audit = (await loadAudit(db)).flatMap((e) => (e.event.t === "agent.published" && e.event.agentId === "flow" ? [[e.actor, e.event.changelog, e.event.version, e.event.previous]] : []));
  assert.deepEqual(
    audit,
    [
      ["pat", "First version", first.head.version, null],
      ["pat", "Cite sections", second.head.version, first.head.version],
    ],
  );
  assert.equal(verifyAudit(await loadAudit(db)), null);
  assert.equal((await publishedAgentFor(db, { surface: WEB_SURFACE, channelId: "flow" }))?.instructions, v2.instructions);
  assert.equal(await publishedAgentFor(db, { surface: WEB_SURFACE, channelId: "elsewhere" }), undefined);
});

test("intake runs the head bound to the channel; a studio test runs the unpublished draft with trigger test", async () => {
  const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: randomBytes(32), keyId: "k1" });
  const intakeDeps: IntakeDeps = {
    db,
    store,
    queue: createQueue(db),
    catalog: async () => catalog,
    gate: { members: async (id) => ({ id: id as MemberId, audiences: [{ t: "lab" }] }), channelFloor: async () => "D1", labPatterns: [], policy: DEFAULT_POLICY },
    agentFor: (channel) => publishedAgentFor(db, channel),
  };
  const head = doc({ agentId: "bound", channels: ["web:bound"] });
  const published = await confirmPublish(deps, head, draftHashOf(head), publisher, "bind");
  const msg = { channel: { surface: WEB_SURFACE, channelId: "bound" }, threadId: "t1", messageId: "m1", platformUserId: "ana", text: "Office hours?", attachments: [], addressed: true, at: new Date().toISOString() };
  const live = await intake(msg, intakeDeps);
  assert.equal(live.t === "enqueued" ? live.agent : live.t, published.head.version);

  const draft = doc({ agentId: "bound", channels: ["web:bound"], instructions: "Answer in one word." });
  const tested = await testDraft(draft, { member: "ana", thread: "studio-bound", message: "x1", text: "Office hours?" }, intakeDeps);
  assert.ok(tested.t === "enqueued");
  const r = resolveAgent(draft, catalog);
  assert.ok(r.ok);
  assert.equal(tested.agent, versionHash(r.agent));
  const job = await db.query<{ key: string; payload: { trigger: unknown } }>("select key, payload from jobs where id = $1", [tested.runId]);
  assert.deepEqual(job.rows[0], { key: "test:web:studio:studio-bound:x1", payload: { ...job.rows[0]!.payload, trigger: { t: "test", memberId: "ana" } } });
  assert.equal((await intake({ ...msg, channel: { surface: WEB_SURFACE, channelId: "unbound" } }, intakeDeps)).t, "refused");
});
