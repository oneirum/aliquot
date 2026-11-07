#!/usr/bin/env node
/**
 * pnpm walk:policy: the data classes on the synthetic lab, as a member sees them.
 *
 * lab0's lab.toml plus fixtures/policy/classes.toml (phi, controlled_access, export_controlled over the five built-ins).
 * One question per class goes through the real web door and worker to an agent on a hosted (approved) model, and the
 * walk prints what the member reads and what reached each model on the wire. The two classes a lab model may read
 * are asked again of an agent on the lab's own model, whose endpoint is in region us. Then the knowledge base side: a
 * DUA-bound source is refused before any compiler call, export-controlled notes compile on the lab's US compiler, and
 * the studio's view lists which entries carry each class. Scripted fakes, so this checks the policy, not answer quality.
 *
 *   node scripts/walk-policy.ts
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAudit } from "../packages/core/src/audit.ts";
import { loadEvents, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { ensurePostgres, processes, waitFor } from "./procs.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = join(root, ".walk-policy");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const kbDir = join(work, "kb");
cpSync(join(root, "fixtures/lab0"), kbDir, { recursive: true });
cpSync(join(root, "fixtures/policy"), kbDir, { recursive: true });

await ensurePostgres(root);
const { db, url: dbUrl } = await freshDatabase("labh_walk_policy");
const compiler = await startFakeModel("scripted-1", "compile");
const lab = await startFakeModel("scripted-1", "search-then-answer");
const hosted = await startFakeModel("hosted-2", "answer");
const hex = () => randomBytes(32).toString("hex");
const tokens = { WALK_ACP_TOKEN: hex(), WALK_STUDIO_TOKEN: hex() };
const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: dbUrl, LABH_PAYLOAD_KEY: hex(), ...tokens };
const classes = readFileSync(join(root, "fixtures/policy/classes.toml"), "utf8");
const baseAgent = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
const prereg = JSON.parse(readFileSync(join(kbDir, "questions.json"), "utf8")) as { restricted: { pattern: string } };

function config(name: string, agent: Record<string, unknown>): string {
  const agentPath = join(work, `agent-${name}.json`);
  writeFileSync(agentPath, JSON.stringify({ ...baseAgent, ...agent }, null, 2));
  const path = join(work, `lab-${name}.toml`);
  writeFileSync(
    path,
    [
      `[endpoints.local]\nbase_url = "${compiler.url}"\nplacement = "lab"\nregion = "us"`,
      `[endpoints.agentlab]\nbase_url = "${lab.url}"\nplacement = "lab"\nregion = "us"`,
      `[endpoints.hosted]\nbase_url = "${hosted.url}"\nplacement = "approved"`,
      '[surfaces.web]\nplacement = "lab"\nport = 0\nchannel = "front-desk"',
      '[surfaces.acp]\nkind = "acp"\nplacement = "zdr"\ntoken_env = "WALK_ACP_TOKEN"',
      '[surfaces.studio]\nkind = "studio"\nplacement = "lab"\ntoken_env = "WALK_STUDIO_TOKEN"',
      '[channel_floors]\n"web:front-desk" = "D0"',
      `[policy]\nreview_confidential = "refuse"\nparticipant_id_patterns = ['${prereg.restricted.pattern}']`,
      `[agents]\nfixtures = ["${agentPath}"]`,
      classes,
    ].join("\n"),
  );
  return path;
}

const cfgHosted = config("hosted", { agentId: "walk-hosted", name: "Front desk (hosted)", knowledgeBases: [], tools: [], ceiling: "D2", model: { endpointId: "hosted", modelId: "hosted-2", params: { temperature: 0, maxOutputTokens: 256 } } });
const cfgLab = config("lab", {
  agentId: "walk-lab",
  name: "Front desk (lab model)",
  instructions: "Call kb_search with the member's question and answer from those entries only.",
  knowledgeBases: ["lab0-export"],
  ceiling: "D3",
  irbProtocol: "SYNTH-LAB0",
  model: { endpointId: "agentlab", modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 256 } },
});

const ps = processes(root, work, env);
const print = (line = "") => process.stdout.write(`${line}\n`);
let n = 0;

async function ask(web: string, text: string, auth?: string): Promise<{ status: number; body: Record<string, unknown>; shown: string; hosted: number; lab: number; events: StoredEvent[] }> {
  const before = { hosted: hosted.requests, lab: lab.requests };
  const res = await fetch(`${web}/message`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ thread: `walk-${n}`, message: `m-${n++}`, text, user: "member-1" }) });
  const body = (await res.json()) as Record<string, unknown>;
  let shown = String(body.userFacing ?? "");
  let events: StoredEvent[] = [];
  if (typeof body.runId === "string") {
    const runId = body.runId as RunId;
    events = await waitFor("run.finished", async () => {
      const es = await loadEvents(db, runId);
      return es.some((e) => e.event.t === "run.finished") ? es : null;
    }, 20_000);
    shown = auth
      ? `(the ACP client gets the run's answer; record ${web}/runs/${runId})`
      : (await waitFor("a reply", async () => {
          const r = (await (await fetch(`${web}/replies?runId=${runId}`)).json()) as { text: string }[];
          return r.length ? r : null;
        }, 10_000)).map((r) => r.text).join(" / ");
  }
  return { status: res.status, body, shown, hosted: hosted.requests - before.hosted, lab: lab.requests - before.lab, events };
}

function view(cls: string, rule: string, question: string, a: Awaited<ReturnType<typeof ask>>): void {
  const finished = a.events.find((e) => e.event.t === "run.finished")?.event;
  const outcome = finished?.t === "run.finished" ? `run ${finished.outcome}` : `door ${a.status}, no run`;
  const dc = a.body.dataClass as { audit: number } | undefined;
  print(`── ${cls}  (${rule})`);
  print(`   member  > ${question}`);
  print(`   aliquot > ${a.shown}`);
  print(`   wire    : ${outcome}; ${a.hosted} hosted requests, ${a.lab} lab model requests${dc ? `; audit event ${dc.audit}` : ""}`);
  print();
}

const asked: Record<string, Awaited<ReturnType<typeof ask>>> = {};
let failed = false;
try {
  ps.startWorker(cfgHosted, "W1");
  const web = await ps.startWeb(cfgHosted);
  print(`Aliquot data classes on lab0. Agent: front desk on a hosted model at placement approved (D2 at most).\n`);
  const Q: [string, string, string, string?][] = [
    ["public", 'model_tier = "hosted", level D0', "What are the office hours?"],
    ["internal", 'model_tier = "hosted", level D1', "What are the office hours?", tokens.WALK_ACP_TOKEN],
    ["confidential", 'model_tier = "hosted", level D2', "Can you remind ra-1@example.org about the freezer log?"],
    ["restricted", 'model_tier = "local", level D3', "Is LAB0-0003 still pending for wave 1?"],
    ["export_controlled", 'model_tier = "local", residency = "us"', "Where are the ITAR drawings for the sensor housing kept?"],
    ["phi", 'model_tier = "none", record hash, 30 days', "Patient: John Smith was admitted 03/04/2026, can he enroll?"],
    ["controlled_access", 'model_tier = "none", record hash, DUA marker', "Which consent groups does phs000123.v2.p1 allow?"],
    ["review-confidential", 'model_tier = "none", record hash', "REVIEW-CONFIDENTIAL: reviewer 2 says the aims overlap"],
  ];
  for (const [cls, rule, q, auth] of Q) {
    const a = await ask(web.base, q, auth);
    asked[cls] = a;
    view(cls, rule, q, a);
  }

  print("The two local classes again, asked of the front desk on the lab's own model (region us) with the rig notes knowledge base:\n");
  ps.startWorker(cfgLab, "C1");
  const kb = async (args: string[]) => {
    const p = ps.start(`kb-${n++}`, "kb.ts", ["--config", cfgLab, ...args]);
    await p.exit;
    return p.out.join("").trim();
  };
  const lastJson = (out: string) => JSON.parse(out.split("\n").findLast((l) => l.startsWith("{")) ?? "null") as { result?: { t: string; snapshot?: string } } | null;
  const compiled = lastJson(await kb(["compile", "--definition", join(kbDir, "kb-export.json"), "--wait", "--timeout-ms", "60000"]));
  assert.equal(compiled?.result?.t, "compiled", JSON.stringify(compiled));
  await kb(["publish", "--snapshot", compiled!.result!.snapshot!, "--override-gaps", "walk: coverage is not under test", "--actor", "steward-1"]);
  const labWeb = await ps.startWeb(cfgLab);
  ps.startWorker(cfgLab, "W2");
  for (const [cls, q] of [["restricted", "Is LAB0-0003 still pending for wave 1?"], ["export_controlled", "Where are the ITAR drawings for the sensor housing kept?"]] as const) {
    const a = await ask(labWeb.base, q);
    asked[`${cls}-lab`] = a;
    view(`${cls} on the lab model`, 'model_tier = "local"', q, a);
  }

  print("Knowledge bases. The compiler is a model too, so a source in a class no model may read never reaches it:\n");
  const before = compiler.requests;
  const duaOut = await kb(["compile", "--definition", join(kbDir, "kb-dbgap.json"), "--wait", "--timeout-ms", "60000"]);
  const duaLine = duaOut.split("\n").find((l) => l.includes("dbgap-consent")) ?? duaOut;
  print(`   kb compile kb-dbgap.json > ${duaLine}`);
  print(`   wire    : ${compiler.requests - before} compiler requests`);
  asked["kb-dua"] = { status: 0, body: {}, shown: duaLine, hosted: 0, lab: compiler.requests - before, events: [] };
  print();

  const studio = await fetch(`${labWeb.base}/studio/data-classes`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.WALK_STUDIO_TOKEN}` }, body: JSON.stringify({ actor: { id: "pi@lab0", role: "pi" } }) });
  const sv = (await studio.json()) as { classes: { id: string; level: string; modelTier: string; record: string; retentionDays: number | null; residency: string | null }[]; knowledgeBases: { kbId: string; sources: { sourceId: string; class: string; detectors: string[] }[]; entries: { path: string; class: string }[] }[] };
  print("The studio's Data classes panel (the door's data-classes op):\n");
  for (const c of sv.classes) {
    const entries = sv.knowledgeBases.flatMap((k) => k.entries.filter((e) => e.class === c.id).map((e) => `${k.kbId}/${e.path}`));
    print(`   ${c.id.padEnd(20)} ${c.level}  ${c.modelTier.padEnd(6)} record ${c.record.padEnd(4)} ${c.retentionDays === null ? "" : `${c.retentionDays} days`}${c.residency ? `residency ${c.residency}` : ""}${entries.length ? `\n${" ".repeat(23)}entries: ${entries.join(", ")}` : ""}`);
  }
  print();

  const audit = (await loadAudit(db)).map((r) => r.event).filter((e) => e.t === "gate.refused" || e.t === "kb.source-refused");
  print(`Audit stream: ${audit.map((e) => (e.t === "gate.refused" ? `gate.refused ${e.dataClass} kept ${e.kept.t}` : e.t === "kb.source-refused" ? `kb.source-refused ${e.dataClass} ${e.sourceId}` : "")).join("; ")}`);

  // The walk is also a check: each class's outcome, as the brief and the tests state it.
  for (const c of ["public", "internal", "confidential"]) assert.ok(asked[c]!.hosted > 0, `${c} answered by the hosted model`);
  for (const c of ["restricted", "export_controlled"]) {
    assert.equal(asked[c]!.hosted, 0, `${c}: no hosted request`);
    assert.match(asked[c]!.shown, new RegExp(`Data class ${c}, found by detector [a-z-]+; rule (model_tier = "local"|residency = "us")`));
    assert.equal(asked[`${c}-lab`]!.hosted, 0);
    assert.ok(asked[`${c}-lab`]!.lab > 0, `${c} answered by the lab model`);
  }
  for (const c of ["phi", "controlled_access", "review-confidential"]) {
    assert.equal(asked[c]!.status, 403);
    assert.equal(asked[c]!.hosted + asked[c]!.lab, 0, `${c}: no model request`);
    assert.match(asked[c]!.shown, new RegExp(`Data class ${c}`));
  }
  assert.equal(asked["kb-dua"]!.lab, 0, "no compiler request for a DUA-bound source");
  assert.match(asked["kb-dua"]!.shown, /data class controlled_access \(detector dua-marker\); rule model_tier = "none"/);
  const rig = sv.knowledgeBases.find((k) => k.kbId === "lab0-export");
  assert.ok(rig && rig.entries.length > 0 && rig.entries.every((e) => e.class === "export_controlled"), "the rig notes' entries carry export_controlled");
  print("\nwalk:policy ok: every class got its outcome; 0 hosted requests for restricted, export_controlled, phi, controlled_access and review-confidential.");
} catch (err) {
  failed = true;
  print(`\nwalk:policy FAILED: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await ps.stopAll();
  await compiler.close();
  await lab.close();
  await hosted.close();
  await db.end();
}
process.exit(failed ? 1 : 0);
