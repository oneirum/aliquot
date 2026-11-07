#!/usr/bin/env node
/**
 * pnpm walk:study: a PI freezes an agent for a study, an IRB reads its card
 * and the sheet, and a reviewer who has never seen the database replays a
 * run. On lab0 (its documents, its handbook agent, scripted fake models),
 * with the real web, worker, kb and aliquot binaries. Prints what each person
 * sees and a PASS or FAIL line per step; exits 0 only if every step passes.
 *
 *   node scripts/walk-study.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentDocument, type MemberId } from "../packages/core/src/agent.ts";
import { bootShared } from "../packages/core/src/boot-shared.ts";
import { agentCardSchema } from "../packages/core/src/card.ts";
import { confirmPublish, draftHashOf } from "../packages/core/src/publish.ts";
import { loadEvents, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { PERMISSION_FLAGS } from "../packages/core/src/seal.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { ensurePostgres, post, processes, waitFor } from "./procs.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".walk-study");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const kbDir = join(work, "kb");
cpSync(join(root, "fixtures/lab0"), kbDir, { recursive: true });
const question = (JSON.parse(readFileSync(join(kbDir, "questions.json"), "utf8")) as { inDocument: { question: string; expected: string }[] }).inDocument[2]!;

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_walk_study");
const compiler = await startFakeModel("scripted-1", "compile");
const agentModel = await startFakeModel("scripted-1", "search-then-answer");
const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: randomBytes(32).toString("hex") };

const baseAgent = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
const handbook = {
  ...baseAgent,
  agentId: "lab0-handbook",
  name: "Lab0 handbook",
  owner: "pi-lab0",
  instructions: "You answer lab members' practical questions from the lab0 handbook. Call kb_search with the member's question and answer from those entries only.",
  knowledgeBases: ["lab0-handbook"],
  irbProtocol: "lab0-protocol",
  model: { endpointId: "agentlab", modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 256 } },
};
writeFileSync(join(work, "agent-handbook.json"), JSON.stringify(handbook, null, 2));
const cfg = join(work, "lab.toml");
writeFileSync(
  cfg,
  [
    "[database]",
    'url_env = "DATABASE_URL"',
    "[store]",
    'placement = "lab"',
    'key_env = "LABH_PAYLOAD_KEY"',
    "[endpoints.local]",
    `base_url = "${compiler.url}"`,
    'placement = "lab"',
    "[endpoints.agentlab]",
    `base_url = "${agentModel.url}"`,
    'placement = "lab"',
    "[surfaces.web]",
    'placement = "lab"',
    "port = 0",
    "[policy]",
    'review_confidential = "refuse"',
    "[agents]",
    `fixtures = ["${join(work, "agent-handbook.json")}"]`,
    "",
  ].join("\n"),
);

const ps = processes(root, work, env);
const results: { name: string; ok: boolean }[] = [];
const say = (who: string, text: string) => console.log(`\n[${who}] ${text}`);
const show = (out: string) => console.log(out.trimEnd().split("\n").map((l) => `    ${l}`).join("\n"));

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One binary under the permission model, as a person would run it. `writes` adds --allow-fs-write for paths it may write. */
async function run(bin: string, args: readonly string[], opts: { env?: Record<string, string>; cwd?: string; writes?: readonly string[] } = {}): Promise<{ code: number | null; out: string; err: string }> {
  const flags = [...PERMISSION_FLAGS, ...(opts.writes ?? []).map((w) => `--allow-fs-write=${w}/*`)];
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...flags, join(root, "packages/core/bin", bin), ...args], { env: opts.env ?? env, cwd: opts.cwd ?? root, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
  const code = await new Promise<number | null>((res) => child.on("close", res));
  return { code, out, err };
}
const aliquot = async (args: readonly string[], opts: Parameters<typeof run>[2] = {}) => {
  console.log(`  $ aliquot ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  const r = await run("aliquot.ts", args[0] === "replay" ? args : ["--config", cfg, ...args], opts);
  show(r.out || r.err);
  return r;
};

let messages = 0;
async function ask(base: string, channel: string, text: string): Promise<{ runId: RunId; events: StoredEvent[] }> {
  const n = messages++;
  const sent = await post(base, "/message", { thread: `walk-${n}`, message: `m-${n}`, text, user: "member-1", channel });
  assert.equal(sent.status, 202, JSON.stringify(sent.json));
  const runId = sent.json.runId as RunId;
  const events = await waitFor(`run ${runId} finished`, async () => {
    const es = await loadEvents(db, runId);
    return es.some((e) => e.event.t === "run.finished") ? es : null;
  }, 20_000);
  return { runId, events };
}
const startedOf = (events: StoredEvent[]) => {
  const s = events[0]?.event;
  assert.ok(s?.t === "run.started");
  return s;
};

let frozen = "";
let republished = "";
const bundle = join(work, "bundles", "sleep-2026");
const reviewer = join(work, "reviewer");

try {
  await step("setup: the lab0 steward compiles and publishes the lab0 handbook", async () => {
    ps.startWorker(cfg, "W1");
    const compile = ps.start("kb-compile", "kb.ts", ["--config", cfg, "compile", "--definition", join(kbDir, "kb.json"), "--wait", "--timeout-ms", "60000"]);
    await compile.exit;
    const line = compile.out.join("").split("\n").findLast((l) => l.startsWith("{"))!;
    const snapshot = (JSON.parse(line) as { result: { snapshot: string } }).result.snapshot;
    const pub = ps.start("kb-publish", "kb.ts", ["--config", cfg, "publish", "--snapshot", snapshot]);
    await pub.exit;
    assert.match(pub.out.join(""), /"ok":true/);
    say("steward", `lab0-handbook snapshot ${snapshot.slice(0, 12)} is published`);
  });

  const web = await ps.startWeb(cfg);

  say("PI", "I register the sleep diary study, bind its channel and freeze the handbook agent for it.");
  await step("PI creates the study", async () => {
    const r = await aliquot(["study", "create", "sleep-2026", "--title", "Sleep diary study", "--as", "pi-lab0", "--floor", "D1", "--irb", "lab0-protocol"]);
    assert.equal(r.code, 0);
  });
  await step("PI binds web:sleep-study to the study", async () => {
    assert.equal((await aliquot(["study", "bind", "sleep-2026", "web:sleep-study", "--as", "pi-lab0"])).code, 0);
  });
  await step("PI freezes the handbook agent's current version", async () => {
    const r = await aliquot(["study", "freeze", "sleep-2026", "lab0-handbook", "--as", "pi-lab0", "--note", "the version named in the pre-registration", "--json"]);
    assert.equal(r.code, 0);
    frozen = (JSON.parse(r.out) as { hash: string }).hash;
    assert.match(frozen, /^[0-9a-f]{64}$/);
  });

  say("member", `I ask in the study channel: "${question.question}"`);
  await step("the study channel answers with the frozen version, routed as pinned", async () => {
    const { runId, events } = await ask(web.base, "sleep-study", question.question);
    const s = startedOf(events);
    const cited = events.flatMap((e) => (e.event.t === "tool.completed" ? (e.event.retrieved ?? []).flatMap((r) => r.entries) : [])).length;
    show(`run ${runId}\nagent ${s.agent}\nroute ${JSON.stringify(s.route)}, study ${s.studyId}\nentries retrieved: ${cited}`);
    assert.equal(s.agent, frozen);
    assert.deepEqual(s.route, { t: "pinned", studyId: "sleep-2026" });
  });

  say("author", "I publish a new version of the handbook agent, answering in fewer words, on web:open and web:sleep-study.");
  await step("a new publish moves the open channel and not the study channel", async () => {
    const core = await bootShared(cfg, env);
    try {
      const parsed = parseAgentDocument({ ...handbook, channels: ["web:open", "web:sleep-study"], instructions: `${handbook.instructions} Answer in at most two sentences.` });
      assert.ok(parsed.ok);
      const published = await confirmPublish({ db: core.db, catalog: core.catalog }, parsed.doc, draftHashOf(parsed.doc), { id: "pi-lab0" as MemberId, role: "pi" }, "shorter answers");
      assert.equal(published.t, "published");
      republished = published.head.version;
    } finally {
      await core.close();
    }
    const open = startedOf((await ask(web.base, "open", question.question)).events);
    const study = startedOf((await ask(web.base, "sleep-study", question.question)).events);
    show(`web:open        runs ${open.agent}\nweb:sleep-study runs ${study.agent} (frozen ${frozen.slice(0, 12)})`);
    assert.equal(open.agent, republished);
    assert.notEqual(republished, frozen);
    assert.equal(study.agent, frozen);
  });

  say("IRB", "I read the frozen version's card.");
  await step("the card names model, placement, tools, snapshot, ceilings and the prompt hash, and validates", async () => {
    console.log(`  $ aliquot card ${frozen}`);
    const r = await run("aliquot.ts", ["--config", cfg, "card", frozen]);
    assert.equal(r.code, 0, r.err);
    const card = agentCardSchema.parse(JSON.parse(r.out));
    show(
      [
        `agent ${card.agentId} (${card.name}) version ${card.hash}`,
        `model ${card.model.modelId} on ${card.model.endpointId}, placement ${card.model.placement}, receives up to ${card.model.receivesUpTo}`,
        ...card.tools.map((t) => `tool ${t.name} spec ${t.specHash.slice(0, 12)}, returns ${t.reads}, deployed now: ${t.deployedNow}`),
        ...card.knowledgeBases.map((k) => `knowledge base ${k.kbId} snapshot ${k.snapshot.slice(0, 12)}, ${k.cls}, ${k.entries} entries`),
        `ceilings: agent ${card.dataCeilings.agent}, instructions ${card.dataCeilings.instructions}, knowledge bases ${card.dataCeilings.knowledgeBases}`,
        `system prompt sha256 ${card.prompt.systemTextSha256} (frame ${card.prompt.frame})`,
        `frozen for: ${card.studies.map((s) => `${s.studyId} by ${s.frozenBy}`).join(", ")}`,
      ].join("\n"),
    );
    assert.deepEqual(card.studies.map((s) => s.studyId), ["sleep-2026"]);
    assert.equal(card.model.placement, "lab");
  });

  say("PI", "Participants found the answers too long. I unfreeze with a reason, which is a protocol deviation, and freeze the revised version.");
  await step("unfreeze is recorded as a deviation, and the revised version is frozen", async () => {
    assert.equal((await aliquot(["study", "unfreeze", "sleep-2026", "lab0-handbook", "--as", "pi-lab0", "--reason", "participants found answers too long; protocol amendment 2"])).code, 0);
    assert.equal((await aliquot(["study", "freeze", "sleep-2026", "lab0-handbook", "--as", "pi-lab0", "--note", "amendment 2: shorter answers"])).code, 0);
    const shown = await aliquot(["study", "show", "sleep-2026"]);
    assert.match(shown.out, /deviation: lab0-handbook at [0-9a-f]{12}, frozen by pi-lab0 .*, unfrozen by pi-lab0 .*: participants found answers too long/);
    assert.match(shown.out, new RegExp(`frozen: lab0-handbook at ${republished}`));
  });

  say("PI", "I export the study for the reviewer at D1 clearance.");
  await step("the study's bundle is written at D1", async () => {
    const r = await aliquot(["export", "--study", "sleep-2026", "--clearance", "D1", "--out", bundle, "--as", "pi-lab0"], { writes: [join(work, "bundles")] });
    assert.equal(r.code, 0, r.err);
    const audit = await db.query<{ actor: string }>("select actor from audit_events where event->>'t' = 'export.created'");
    assert.match(audit.rows[0]?.actor ?? "", /^pi-lab0 \(os user .+\)$/, "the audit stream records the export, with the OS user beside --as");
  });

  say("reviewer", "I have only the bundle: no database, no lab.toml, no payload key.");
  await step("in a fresh directory, replay verifies every chain and prints the audit view", async () => {
    cpSync(bundle, reviewer, { recursive: true });
    const bare = { PATH: env.PATH!, HOME: env.HOME! };
    const r = await aliquot(["replay", reviewer], { env: bare, cwd: reviewer });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /proves {3}the bundle is internally consistent, not that it is the lab's record/);
  });
  await step("re-execution sends nothing to an endpoint whose placement the reviewer has not given; placed lab, it agrees exactly", async () => {
    const bare = { PATH: env.PATH!, HOME: env.HOME! };
    const unplaced = await aliquot(["replay", reviewer, "--reexecute", "--endpoint", agentModel.url], { env: bare, cwd: reviewer });
    assert.equal(unplaced.code, 5, unplaced.err);
    assert.match(unplaced.out, /skipped, it would send D1 to the model, and an endpoint placed public receives up to D0/);
    const r = await aliquot(["replay", reviewer, "--reexecute", "--endpoint", agentModel.url, "--endpoint-placement", "lab"], { env: bare, cwd: reviewer });
    assert.equal(r.code, 0, r.err);
  });

  say("research IT", "I print the deployment sheet.");
  await step("the sheet lists the deployment and the study with its frozen version and deviation", async () => {
    const r = await aliquot(["sheet"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /\| web \| web \| lab \| up to D3 \|/);
    assert.match(r.out, /\| agentlab \| .* \| lab \| up to D3 \|/);
    assert.match(r.out, new RegExp(`- Frozen: lab0-handbook at version ${republished}`));
    assert.match(r.out, /- Protocol deviation: lab0-handbook at [0-9a-f]{12}, frozen by pi-lab0 on [0-9-]{10}, unfrozen by pi-lab0/);
  });
} finally {
  await ps.stopAll();
  await compiler.close();
  await agentModel.close();
  await db.end();
}

console.log("");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
process.exit(failed ? 1 : 0);
