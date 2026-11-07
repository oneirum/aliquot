import { test, after } from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { listingOf, LOOP_CONTRACT, parseAgentDocument, resolveAgent, versionHash, type AgentDocument, type AgentId, type Catalog, type Deployed, type MemberId } from "../packages/core/src/agent.ts";
import { loadAudit, verifyAudit } from "../packages/core/src/audit.ts";
import { agentCard, agentCardJsonSchema, agentCardSchema } from "../packages/core/src/card.ts";
import { parseConfig } from "../packages/core/src/config.ts";
import { DEFAULT_POLICY } from "../packages/core/src/dataclass.ts";
import { intake, type IntakeDeps } from "../packages/core/src/frontdoor.ts";
import type { AgentVersionHash, EntryHash, SnapshotId, ToolHash } from "../packages/core/src/hash.ts";
import type { KbSnapshot } from "../packages/core/src/kb.ts";
import { confirmPublish, draftHashOf, publishedAgentsFor } from "../packages/core/src/publish.ts";
import { createQueue } from "../packages/core/src/queue.ts";
import { createPayloadStore, oneKey } from "../packages/core/src/record.ts";
import { renderSheet } from "../packages/core/src/sheet.ts";
import { bindChannel, createStudy, deviations, freeze, freezeListing, pinFor, StudyRefused, unfreeze } from "../packages/core/src/study.ts";
import { builtinTools, registryOf } from "../packages/core/src/tools.ts";
import { WEB_SURFACE } from "../packages/core/src/surfaces/web.ts";
import { freshDatabase } from "./db.ts";

const { db } = await freshDatabase("labh_test_study");
after(() => db.end());

const registry = registryOf(builtinTools());
const SNAP = "5".repeat(64) as SnapshotId;
const catalog: Catalog = {
  latestSkill: () => undefined,
  latestSnapshot: (kbId) => (kbId === "handbook" ? { id: SNAP, cls: "D1" } : undefined),
  tool: (name) => {
    const t = registry.get(name);
    return t ? { hash: t.hash, reads: t.manifest.reads, effects: t.manifest.effects } : undefined;
  },
  endpoint: (id) => (id === "local" ? { placement: "lab" } : undefined),
  sandboxImage: () => undefined,
  dataset: () => undefined,
};
const deployed: Deployed = { tools: registry.deployed(), snapshots: new Set([SNAP]), sandboxImages: new Set(), loopContract: LOOP_CONTRACT, retrieval: new Set(["bm25-v1"]) };
const fixture = JSON.parse(await readFile(new URL("../fixtures/agent.json", import.meta.url), "utf8")) as Record<string, unknown>;
function doc(overrides: Record<string, unknown> = {}): AgentDocument {
  const parsed = parseAgentDocument({ ...fixture, ceiling: "D1", ...overrides });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.doc;
}
async function stored(d: AgentDocument): Promise<AgentVersionHash> {
  const r = resolveAgent(d, catalog);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
  const hash = versionHash(r.agent);
  await db.query("insert into agent_versions (hash, agent_id, body) values ($1, $2, $3) on conflict (hash) do nothing", [hash, r.agent.agentId, JSON.stringify(r.agent)]);
  return hash;
}
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof StudyRefused) return err.message;
    throw err;
  }
  assert.fail("expected StudyRefused");
}

const pi = "pia" as MemberId;
const ra = "ray" as MemberId;
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, keyring: oneKey(randomBytes(32)) });
const intakeDeps: IntakeDeps = {
  db,
  store,
  queue: createQueue(db),
  catalog: async () => catalog,
  gate: { members: async (id) => ({ id: id as MemberId, audiences: [{ t: "lab" }] }), channelFloor: async () => "D1", labPatterns: [], policy: DEFAULT_POLICY },
  agentsFor: (channel) => publishedAgentsFor(db, channel),
};
let messages = 0;
const ask = (channelId: string, deps: IntakeDeps = intakeDeps) =>
  intake({ channel: { surface: WEB_SURFACE, channelId }, threadId: `t${messages}`, messageId: `m${messages++}`, platformUserId: "member-1", text: "Office hours?", attachments: [], addressed: true, at: new Date().toISOString() }, deps);
async function studyOn(id: string, d: AgentDocument, floor: "D1" | "D2", listing = listingOf(d)): Promise<AgentVersionHash> {
  const h = await stored(d);
  await createStudy(db, { id, title: id, owner: pi, dataFloor: floor });
  await bindChannel(db, id, { surface: WEB_SURFACE, channelId: id }, pi);
  await freeze(db, id, h, pi, "v", { listing, deployed });
  return h;
}

test("a study channel runs its frozen hash: a later publish moves the open channel and not the study's, and unfreezing is a deviation", async () => {
  const v1 = doc({ agentId: "handbook", channels: ["web:open", "web:sleep-study"] });
  await confirmPublish({ db, catalog: async () => catalog }, v1, draftHashOf(v1), { id: pi, role: "pi" }, "first");
  const frozenHash = await stored(v1);

  await createStudy(db, { id: "sleep-2026", title: "Sleep diary study", owner: pi, dataFloor: "D1" });
  assert.deepEqual(await createStudy(db, { id: "sleep-2026", title: "Sleep diary study", owner: pi, dataFloor: "D1" }).then((s) => s.id), "sleep-2026", "creating the same study again is a no-op");
  await bindChannel(db, "sleep-2026", { surface: WEB_SURFACE, channelId: "sleep-study" }, pi);
  assert.match(await refusal(bindChannel(db, "sleep-2026", { surface: WEB_SURFACE, channelId: "other" }, ra)), /only the study owner, pia/);
  const before = await ask("sleep-study");
  assert.deepEqual(before, { t: "refused", userFacing: "This channel belongs to study sleep-2026, which has no frozen agent. Ask the study owner, pia." });

  const listing = listingOf(v1);
  const f = await freeze(db, "sleep-2026", frozenHash, pi, "pre-registered version", { listing, deployed });
  assert.equal(f.hash, frozenHash);
  assert.deepEqual(await freeze(db, "sleep-2026", frozenHash, pi, "again", { listing, deployed }), f, "freezing the same hash again returns the existing freeze");
  assert.match(await refusal(freeze(db, "sleep-2026", frozenHash, ra, "mine", { listing, deployed })), /only the study owner/);

  const v2 = doc({ agentId: "handbook", channels: ["web:open", "web:sleep-study"], instructions: "Answer in one word." });
  await confirmPublish({ db, catalog: async () => catalog }, v2, draftHashOf(v2), { id: pi, role: "pi" }, "terser");
  const v2Hash = await stored(v2);
  assert.notEqual(v2Hash, frozenHash);
  const open = await ask("open");
  const study = await ask("sleep-study");
  assert.equal(open.t === "enqueued" && open.agent, v2Hash, "the open channel runs the new head");
  assert.equal(study.t === "enqueued" && study.agent, frozenHash, "the study channel still runs the frozen version");
  const job = await db.query<{ payload: { studyId: string | null } }>("select payload from jobs where id = $1", [study.t === "enqueued" ? study.runId : ""]);
  assert.equal(job.rows[0]?.payload.studyId, "sleep-2026");
  assert.match(await refusal(freeze(db, "sleep-2026", v2Hash, pi, "newer", { listing, deployed })), /unfreeze it first, with a reason/);

  assert.match(await refusal(unfreeze(db, "sleep-2026", "handbook" as AgentId, pi, "  ")), /needs a reason/);
  const d = await unfreeze(db, "sleep-2026", "handbook" as AgentId, pi, "participant feedback: answers too long");
  assert.deepEqual({ ...d, at: "", frozenAt: "" }, { studyId: "sleep-2026", agentId: "handbook", hash: frozenHash, frozenBy: pi, frozenAt: "", note: "pre-registered version", by: pi, reason: "participant feedback: answers too long", at: "" });
  assert.equal((await deviations(db, "sleep-2026")).length, 1);
  assert.deepEqual((await pinFor(db, { surface: WEB_SURFACE, channelId: "sleep-study" }))?.freezes, []);

  const audit = await loadAudit(db);
  assert.equal(verifyAudit(audit), null);
  const asPi = `pia (os user ${userInfo().username})`;
  assert.deepEqual(
    audit.filter((r) => r.event.t.startsWith("study.") || r.event.t.startsWith("agent.frozen") || r.event.t === "agent.unfrozen").map((r) => [r.actor, r.event.t]),
    [
      [asPi, "study.created"],
      [asPi, "study.channel-bound"],
      [asPi, "agent.frozen"],
      [asPi, "agent.unfrozen"],
    ],
  );
});

test("the database refuses to rewrite or delete a freeze, and to end one twice", async () => {
  await assert.rejects(db.query("update freezes set hash = $1 where study_id = 'sleep-2026'", ["0".repeat(64)]), /an ended freeze never changes/);
  await assert.rejects(db.query("delete from freezes"), /insert-only/);
  const h = await stored(doc({ agentId: "guarded" }));
  await createStudy(db, { id: "guard", title: "Guard", owner: pi, dataFloor: "D1" });
  await freeze(db, "guard", h, pi, "v", { listing: listingOf(doc({ agentId: "guarded" })), deployed });
  await assert.rejects(db.query("update freezes set hash = $1 where study_id = 'guard'", ["0".repeat(64)]), /binds one version/);
  await assert.rejects(db.query("update freezes set unfrozen_at = now() where study_id = 'guard'"), /needs who and a reason/);
});

test("a freeze checks the study's floor and IRB protocol against the agent's listing, and that the version runs here", async () => {
  await createStudy(db, { id: "d3-study", title: "Roster study", owner: pi, dataFloor: "D3", irbProtocol: "IRB-7" });
  assert.match(await refusal(createStudy(db, { id: "no-irb", title: "x", owner: pi, dataFloor: "D3" })), /must name its IRB protocol/);
  const d = doc({ agentId: "low", ceiling: "D1" });
  const h = await stored(d);
  assert.match(await refusal(freeze(db, "d3-study", h, pi, "v", { listing: listingOf(d), deployed })), /ceiling D1, below the study's floor D3/);
  const high = doc({ agentId: "high", ceiling: "D3", irbProtocol: "IRB-9" });
  const hh = await stored(high);
  assert.match(await refusal(freeze(db, "d3-study", hh, pi, "v", { listing: listingOf(high), deployed })), /names IRB protocol IRB-9; study d3-study runs under IRB-7/);
  const moved = { ...deployed, snapshots: new Set<SnapshotId>() };
  assert.match(await refusal(freeze(db, "d3-study", hh, pi, "v", { listing: { ...listingOf(high), irbProtocol: "IRB-7" }, deployed: moved })), /cannot run on this deployment: snapshot-missing/);
});

test("the agent card names the model's placement, tool spec hashes, snapshots, ceilings and the system prompt hash, and matches the schema in the repo", async () => {
  const d = doc({ agentId: "carded" });
  const r = resolveAgent(d, catalog);
  assert.ok(r.ok);
  const hash = versionHash(r.agent);
  const snapshot: KbSnapshot = { id: SNAP, kbId: "handbook", title: "Lab handbook", cls: "D1", purpose: "How the lab works.", entries: { "b.md": "e".repeat(64) as EntryHash, "a.md": "f".repeat(64) as EntryHash }, sources: [], compiler: null, coverage: [], irbProtocol: null, consentScope: null, createdAt: "2026-01-01T00:00:00.000Z" };
  const card = agentCard(hash, r.agent, { placements: new Map([["local", "lab"]]), registry, snapshots: new Map([[SNAP, snapshot]]), name: d.name, listing: listingOf(d), freezes: [] });
  assert.deepEqual(card.model, { endpointId: "local", modelId: "scripted-1", placement: "lab", receivesUpTo: "D3", params: { temperature: 0, maxOutputTokens: 512 } });
  assert.deepEqual(
    card.tools.map((t) => [t.name, t.specHash === registry.get(t.name)!.hash, t.deployedNow, t.reads]),
    [
      ["kb_search", true, true, "D0"],
      ["kb_read", true, true, "D0"],
    ],
  );
  assert.deepEqual(card.knowledgeBases, [{ kbId: "handbook", snapshot: SNAP, cls: "D1", title: "Lab handbook", entries: 2, irbProtocol: null, consentScope: null }]);
  assert.deepEqual(card.dataCeilings, { agent: "D1", instructions: "D1", knowledgeBases: "D1", sandboxMounts: null });
  assert.equal(card.prompt.frame, "v1");
  assert.match(card.prompt.systemTextSha256 ?? "", /^[0-9a-f]{64}$/);
  const reworded = agentCard(hash, { ...r.agent, prompt: { ...r.agent.prompt!, retrieval: "Other text." } }, { placements: new Map(), registry: registryOf([]), snapshots: new Map(), name: null, listing: null, freezes: [] });
  assert.deepEqual([reworded.prompt.frame, reworded.prompt.systemTextSha256, reworded.model.placement, reworded.tools[0]?.deployedNow], ["custom", null, null, false]);
  assert.equal(agentCardSchema.safeParse({ ...card, extra: 1 }).success, false, "the card schema is closed");
  const shipped = JSON.parse(await readFile(new URL("../schemas/agent-card.schema.json", import.meta.url), "utf8")) as unknown;
  assert.deepEqual(shipped, agentCardJsonSchema(), "schemas/agent-card.schema.json is the schema the code checks cards against; regenerate it with node scripts/emit-card-schema.ts");
});

test("the sheet lists every surface, endpoint and host with its placement and ceiling, and each study's frozen versions", async () => {
  const config = parseConfig(
    [
      "[database]",
      'url_env = "DATABASE_URL"',
      "[endpoints.agentlab]",
      'base_url = "http://127.0.0.1:9001/v1"',
      'placement = "lab"',
      "[endpoints.hosted]",
      'base_url = "https://api.example.org/v1"',
      'placement = "zdr"',
      "[surfaces.web]",
      'placement = "lab"',
      "[surfaces.slack]",
      'kind = "slack"',
      'placement = "approved"',
      'token_env = "SLACK_SURFACE_TOKEN"',
      "[hosts]",
      '"api.openalex.org" = "public"',
      "[policy]",
      "participant_id_patterns = ['P-[0-9]{4}']",
      "",
    ].join("\n"),
    "/lab/lab.toml",
  );
  const sheet = renderSheet({ config, registry, agents: [{ agentId: "handbook", name: "Lab handbook", source: "lab.toml", endpointId: "agentlab", modelId: "scripted-1", ceiling: "D1" }], studies: [] });
  const rows = (heading: string) => sheet.split(`## ${heading}`)[1]!.split("\n## ")[0]!.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---"));
  assert.deepEqual(rows("Surfaces"), [
    "| Surface | Kind | Placement | Answers shown | Identifies with |",
    "| web | web | lab | up to D3 | the member id it is given (no [auth] sign-on) |",
    "| slack | slack | approved | up to D2 | bearer token from $SLACK_SURFACE_TOKEN |",
  ]);
  assert.deepEqual(rows("Model endpoints"), ["| Endpoint | Base URL | Placement | Receives |", "| agentlab | http://127.0.0.1:9001/v1 | lab | up to D3 |", "| hosted | https://api.example.org/v1 | zdr | up to D1 |"]);
  assert.equal(rows("Tool hosts")[1], "| api.openalex.org | public | up to D0 |");
  assert.match(sheet, /- 1 participant id pattern from lab.toml/);
  assert.match(sheet, /No study is registered\./);
});

test("study freeze takes the agent's current version, or one an earlier freeze stored a listing for; another older hash is refused", async () => {
  const fixtures = { agents: [], catalog: async () => catalog };
  const publish = async (d: AgentDocument, note: string) => {
    await confirmPublish({ db, catalog: async () => catalog }, d, draftHashOf(d), { id: pi, role: "pi" }, note);
    return stored(d);
  };
  const a1 = doc({ agentId: "roster", channels: ["web:roster-study"] });
  const h1 = await publish(a1, "first");
  assert.deepEqual(await freezeListing(db, h1, fixtures), listingOf(a1));
  await createStudy(db, { id: "roster-study", title: "Roster", owner: pi, dataFloor: "D1" });
  await freeze(db, "roster-study", h1, pi, "v1", { listing: await freezeListing(db, h1, fixtures), deployed });

  const h2 = await publish(doc({ agentId: "roster", channels: ["web:roster-study"], instructions: "Answer in one word." }), "second");
  const a3 = doc({ agentId: "roster", channels: ["web:roster-study"], ceiling: "D2", instructions: "Answer in two words." });
  const h3 = await publish(a3, "third");
  assert.equal((await freezeListing(db, h3, fixtures)).ceiling, "D2", "the head's listing");
  assert.deepEqual(await freezeListing(db, h1, fixtures), listingOf(a1), "the listing the earlier freeze stored");
  assert.equal(
    await refusal(freezeListing(db, h2, fixtures)),
    `${h2.slice(0, 12)} is not roster's current version (${h3.slice(0, 12)}), and no listing is stored for it, so its ceiling and IRB protocol cannot be checked. Freeze the current version, or publish this one again first.`,
  );
  assert.match(await refusal(freezeListing(db, "9".repeat(64) as AgentVersionHash, fixtures)), /^no stored version 999999999999:/);
});

test("a study channel checks each frozen listing against the message: the study's floor raises its class, and a ceiling or audience that does not admit it refuses", async () => {
  await studyOn("floor-study", doc({ agentId: "floored", channels: ["web:floor-study"], ceiling: "D2" }), "D2");
  const raised = await ask("floor-study");
  assert.ok(raised.t === "enqueued", JSON.stringify(raised));
  const job = await db.query<{ payload: { input: { cls: string } } }>("select payload from jobs where id = $1", [raised.runId]);
  assert.equal(job.rows[0]?.payload.input.cls, "D2", "a D1 message is stored and sent at the study's floor, D2");

  await studyOn("low-study", doc({ agentId: "low", channels: ["web:low-study"] }), "D1");
  const hot: IntakeDeps = { ...intakeDeps, gate: { ...intakeDeps.gate, channelFloor: async () => "D2" } };
  assert.deepEqual(await ask("low-study", hot), { t: "refused", userFacing: "Not sent. This message is D2 in study low-study, above what its frozen agent may receive (low up to D1). Ask the study owner, pia." });

  const closed = doc({ agentId: "closed", channels: ["web:closed-study"] });
  await studyOn("closed-study", closed, "D1", { ...listingOf(closed), audience: { t: "pi-only" } });
  assert.deepEqual(await ask("closed-study"), { t: "refused", userFacing: "The frozen agent in study closed-study is not open to you. Ask the study owner, pia." });
});
