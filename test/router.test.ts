import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { listingOf, parseAgentDocument, type AgentDocument, type AgentId, type AgentListing, type Catalog, type MemberId } from "../packages/core/src/agent.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import { intake, parseRunJobPayload, type IntakeDeps, type IntakeResult } from "../packages/core/src/frontdoor.ts";
import type { InboundMessage } from "../packages/core/src/gate.ts";
import type { SnapshotId, ToolHash } from "../packages/core/src/hash.ts";
import { confirmPublish, draftHashOf, publishedAgentsFor } from "../packages/core/src/publish.ts";
import { createQueue } from "../packages/core/src/queue.ts";
import { createPayloadStore, oneKey } from "../packages/core/src/record.ts";
import { eligibleOptions, LOW_CONFIDENCE, route, scoreOptions } from "../packages/core/src/router.ts";
import type { Actor } from "../packages/core/src/roles.ts";
import { freshDatabase } from "./db.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/agent.json", import.meta.url), "utf8")) as Record<string, unknown>;
const routed = JSON.parse(await readFile(new URL("../fixtures/lab0/routed-agents.json", import.meta.url), "utf8")) as Record<string, unknown>[];

function doc(overrides: Record<string, unknown>): AgentDocument {
  const parsed = parseAgentDocument({ ...fixture, ceiling: "D1", ...overrides });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.doc;
}
const SHARED = "web:shared";
const desk = doc({ ...routed[0], channels: [SHARED] });
const methods = doc({ ...routed[1], channels: [SHARED] });
const listings: AgentListing[] = [desk, methods].map(listingOf);

/** Questions that name both agents' topics: the router must not pick for the member. */
const TWO_TOPICS = ["Do skipped diary items count as missing data?", "Should the freezer log be part of the preregistration?"];

test("calibration: with each sample question left out of its own agent, none goes to the other agent at the threshold, and two-topic questions fall below it", () => {
  const misrouted: string[] = [];
  for (const own of listings) {
    for (const q of own.sampleQuestions) {
      const held = listings.map((l) => (l.agentId === own.agentId ? { ...l, sampleQuestions: l.sampleQuestions.filter((s) => s !== q) } : l));
      const probs = scoreOptions(q, held);
      for (const other of listings) if (other.agentId !== own.agentId && probs[other.agentId]! >= LOW_CONFIDENCE) misrouted.push(`${q} -> ${other.agentId}`);
    }
  }
  assert.deepEqual(misrouted, []);
  for (const q of TWO_TOPICS) {
    const d = route({ message: q, candidates: listings, current: null });
    assert.equal(d.t, "ask-user", `${q}: ${JSON.stringify(d)}`);
  }
});

test("eligibility: only routable agents open to the member whose ceiling admits the message's class are options", () => {
  const ana = "ana" as MemberId;
  const lab = [{ t: "lab" as const }];
  const hidden = listingOf(doc({ agentId: "hidden", routable: false }));
  const bobOnly = listingOf(doc({ agentId: "bob-only", audience: { t: "members", members: ["bob"] } }));
  const all = [...listings, hidden, bobOnly];
  assert.deepEqual(eligibleOptions(all, "D1", ana, lab).map((l) => l.agentId), ["lab0-desk", "lab0-methods"]);
  assert.deepEqual(eligibleOptions(all, "D1", "bob" as MemberId, lab).map((l) => l.agentId), ["lab0-desk", "lab0-methods", "bob-only"]);
  assert.deepEqual(eligibleOptions(all, "D3", ana, lab), [], "every option here has ceiling D1, so a D3 message has none");
  assert.deepEqual(eligibleOptions(all, "D1", ana, []), [], "a member with no audience reaches no lab agent");
});

const { db } = await freshDatabase("labh_test_router");
after(() => db.end());

const catalog: Catalog = {
  latestSkill: () => undefined,
  latestSnapshot: (kbId) => (kbId === "lab0-handbook" || kbId === "lab0-methods" || kbId === "handbook" ? { id: kbId.padEnd(64, "0") as SnapshotId, cls: "D1" } : undefined),
  tool: (name) => (name === "kb_search" || name === "kb_read" ? { hash: (name === "kb_search" ? "t" : "r").repeat(64) as ToolHash, reads: "D0", effects: "read" } : undefined),
  endpoint: (id) => (id === "local" ? { placement: "lab" } : undefined),
  sandboxImage: () => undefined,
  dataset: () => undefined,
  table: () => undefined,
};
const publisher: Actor = { id: "pat" as MemberId, role: "publisher" };
for (const d of [desk, methods]) await confirmPublish({ db, catalog: async () => catalog }, d, draftHashOf(d), publisher, "on the shared channel");

const deps: IntakeDeps = {
  db,
  store: createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, keyring: oneKey(randomBytes(32)) }),
  queue: createQueue(db),
  catalog: async () => catalog,
  gate: { members: async (id) => ({ id: id as MemberId, audiences: [{ t: "lab" }] }), channelFloor: async () => "D1", labPatterns: [], policy: DEFAULT_POLICY },
  agentsFor: (channel) => publishedAgentsFor(db, channel),
};
let n = 0;
const ask = (text: string, thread = `t${n}`, channelId = "shared", pick?: string, messageId = `m${n++}`): Promise<IntakeResult> => {
  const msg: InboundMessage = { channel: { surface: "web", channelId }, threadId: thread, messageId, platformUserId: "ana", text, attachments: [], addressed: true, at: new Date().toISOString() };
  return intake(msg, deps, pick as AgentId | undefined);
};
const runs = async () => Number((await db.query<{ n: string }>("select count(*) as n from jobs where kind = 'run'")).rows[0]!.n);
const routeOfJob = async (runId: string) => parseRunJobPayload((await db.query<{ payload: unknown }>("select payload from jobs where id = $1", [runId])).rows[0]!.payload).route;

test("the same channel reaches two agents by question, and the job carries why", async () => {
  const handbook = await ask("Who do I call when the freezer alarm sounds?");
  assert.ok(handbook.t === "enqueued", JSON.stringify(handbook));
  assert.equal(handbook.answeredBy.name, "Lab handbook");
  assert.ok(handbook.route.t === "agent" && handbook.route.basis === "score" && handbook.route.confidence >= LOW_CONFIDENCE, JSON.stringify(handbook.route));
  assert.deepEqual(await routeOfJob(handbook.runId), handbook.route);

  const stats = await ask("How many participants per group for a two-group comparison?");
  assert.ok(stats.t === "enqueued", JSON.stringify(stats));
  assert.equal(stats.answeredBy.agentId, "lab0-methods");
  assert.ok(stats.route.t === "agent" && stats.route.basis === "score" && stats.route.router === "lexical-v1");
  assert.notEqual(stats.agent, handbook.agent, "two agents, two version hashes");
});

test("an unsure router asks the member, nothing runs until they pick, the pick runs that agent, and a follow-up stays with it", async () => {
  const before = await runs();
  const asked = await ask(TWO_TOPICS[0]!, "pick-thread", "shared", undefined, "q1");
  assert.ok(asked.t === "asked-user", JSON.stringify(asked));
  assert.deepEqual(asked.choices.map((c) => c.name).sort(), ["Lab handbook", "Methods desk"]);
  assert.ok(asked.choices.every((c) => c.line.length > 0 && !/use when|not for/i.test(c.line)), "each choice has its one line");
  assert.equal(await runs(), before, "asking queued nothing");

  const chosen = await ask(TWO_TOPICS[0]!, "pick-thread", "shared", "lab0-methods", "q1");
  assert.ok(chosen.t === "enqueued" && !chosen.duplicate, JSON.stringify(chosen));
  assert.equal(chosen.answeredBy.agentId, "lab0-methods");
  assert.ok(chosen.route.t === "agent" && chosen.route.basis === "picked");

  // On its own this goes to the handbook; in the thread the methods desk holds, it stays there.
  const alone = route({ message: "What about the diary nights?", candidates: listings, current: null });
  assert.ok(alone.t === "agent" && alone.agentId === "lab0-desk", JSON.stringify(alone));
  const followUp = await ask("What about the diary nights?", "pick-thread", "shared", undefined, "q2");
  assert.ok(followUp.t === "enqueued" && followUp.answeredBy.agentId === "lab0-methods", JSON.stringify(followUp));
  assert.ok(followUp.route.t === "agent" && followUp.route.basis === "thread");
});

test("a pick the channel does not serve is refused; a channel with one agent runs it directly, as before", async () => {
  const refused = await ask("How long are samples kept?", "x", "shared", "someone-else");
  assert.deepEqual(refused, { t: "refused", userFacing: "That agent was not one of the choices for this message." });
  const solo = doc({ agentId: "solo", channels: ["web:solo"] });
  await confirmPublish({ db, catalog: async () => catalog }, solo, draftHashOf(solo), publisher, "alone");
  const direct = await ask("Anything at all?", "y", "solo");
  assert.ok(direct.t === "enqueued" && direct.answeredBy.agentId === "solo", JSON.stringify(direct));
  assert.deepEqual(direct.route, { t: "direct" });
});

test("a pick must be one of the choices offered for that message, and a resend with another pick reports the run that exists", async () => {
  const confident = await ask("Who do I call when the freezer alarm sounds?", "offer", "shared", "lab0-methods");
  assert.deepEqual(confident, { t: "refused", userFacing: "That agent was not one of the choices for this message." }, "the router would not offer methods for a freezer question");

  const first = await ask(TWO_TOPICS[1]!, "resend", "shared", "lab0-desk", "r1");
  assert.ok(first.t === "enqueued" && !first.duplicate && first.answeredBy.agentId === "lab0-desk", JSON.stringify(first));
  const again = await ask(TWO_TOPICS[1]!, "resend", "shared", "lab0-methods", "r1");
  // The thread now holds the desk, so methods is no longer offered; either way the existing run is what is reported.
  if (again.t === "enqueued") {
    assert.equal(again.runId, first.runId);
    assert.equal(again.agent, first.agent, "a duplicate names the agent of the run that exists");
  } else assert.equal(again.t, "refused");
});

test("a run job written before the router existed parses as a direct route", () => {
  const legacy = { agent: "a".repeat(64), kind: "interactive", trigger: { t: "test", memberId: "ana" }, thread: "web:lab:t", surface: "web", threadId: "t", input: { hash: "h", cls: "D1", bytes: 1 }, history: [], studyId: null };
  assert.deepEqual(parseRunJobPayload(legacy).route, { t: "direct" });
});
