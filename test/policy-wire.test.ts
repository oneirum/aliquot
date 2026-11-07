/**
 * Each data class's outcome, measured on the wire: a question carrying that class's data goes through the real web
 * door and worker, and the fake hosted provider counts every request that reaches it. A class whose model_tier is
 * none is refused at the door with zero requests anywhere; local is refused before the hosted model and answered by
 * a lab one; hosted is answered by the hosted model; residency "us" is refused at the door for an endpoint with no
 * region and answered by the lab endpoint in region us. Every refusal names the class and the rule.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAudit } from "../packages/core/src/audit.ts";
import { loadEvents, type RunId, type StoredEvent } from "../packages/core/src/record.ts";
import { replyFor } from "../packages/core/src/surfaces/slack.ts";
import { processes, waitFor } from "../scripts/procs.ts";
import { freshDatabase } from "./db.ts";
import { startFakeModel } from "./fake-model.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "labh-policy-"));
const { db, url } = await freshDatabase("labh_test_policy");
const hosted = await startFakeModel("hosted-2", "answer");
const lab = await startFakeModel("scripted-1", "answer");
const hex = () => randomBytes(32).toString("hex");
const ACP = hex();
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: url, LABH_PAYLOAD_KEY: hex(), POLICY_ACP_TOKEN: ACP };
const classes = readFileSync(join(root, "fixtures/policy/classes.toml"), "utf8");
const base = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;

function stack(name: string, endpointId: "hosted" | "lab", modelId: string, ceiling: string): string {
  const agent = join(work, `agent-${name}.json`);
  writeFileSync(agent, JSON.stringify({ ...base, agentId: `policy-${name}`, knowledgeBases: [], tools: [], ceiling, model: { endpointId, modelId, params: { temperature: 0, maxOutputTokens: 256 } } }));
  const cfg = join(work, `lab-${name}.toml`);
  writeFileSync(
    cfg,
    [
      `[endpoints.hosted]\nbase_url = "${hosted.url}"\nplacement = "approved"`,
      `[endpoints.lab]\nbase_url = "${lab.url}"\nplacement = "lab"\nregion = "us"`,
      '[surfaces.web]\nplacement = "lab"\nport = 0\nchannel = "front"',
      '[surfaces.acp]\nkind = "acp"\nplacement = "zdr"\ntoken_env = "POLICY_ACP_TOKEN"',
      '[channel_floors]\n"web:front" = "D0"',
      "[policy]\nparticipant_id_patterns = ['\\bP-\\d{5}\\b']",
      `[agents]\nfixtures = ["${agent}"]`,
      classes,
    ].join("\n"),
  );
  return cfg;
}

const ps = processes(root, work, env);
const hostedCfg = stack("hosted", "hosted", "hosted-2", "D2");
const labCfg = stack("lab", "lab", "scripted-1", "D3");
const hostedWeb = await ps.startWeb(hostedCfg);
ps.startWorker(hostedCfg, "P1");
after(async () => {
  await ps.stopAll();
  await hosted.close();
  await lab.close();
  await db.end();
  rmSync(work, { recursive: true, force: true });
});

let sent = 0;
interface Asked {
  readonly status: number;
  readonly body: { t: string; runId?: RunId; userFacing?: string; dataClass?: { id: string; classRule: string; audit: number } };
  readonly hostedRequests: number;
  readonly labRequests: number;
  readonly events: readonly StoredEvent[];
  readonly shown: string;
}

/** One question, and what the member sees: the door's refusal, or the run's reply once it finishes. Counts requests to each model while it ran. */
async function ask(web: string, text: string, auth?: string): Promise<Asked> {
  const before = { hosted: hosted.requests, lab: lab.requests };
  const res = await fetch(`${web}/message`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ thread: `t-${sent}`, message: `m-${sent++}`, text, user: "member-1" }) });
  const body = (await res.json()) as Asked["body"];
  let events: StoredEvent[] = [];
  let shown = body.userFacing ?? "";
  if (body.runId) {
    events = await waitFor("run.finished", async () => {
      const es = await loadEvents(db, body.runId!);
      return es.some((e) => e.event.t === "run.finished") ? es : null;
    }, 20_000);
    if (!auth) shown = (await waitFor("a reply", async () => {
      const r = (await (await fetch(`${web}/replies?runId=${body.runId}`)).json()) as { text: string }[];
      return r.length ? r : null;
    }, 10_000)).map((r) => r.text).join("\n");
  }
  return { status: res.status, body, hostedRequests: hosted.requests - before.hosted, labRequests: lab.requests - before.lab, events, shown };
}

const outcome = (a: Asked) => {
  const f = a.events.find((e) => e.event.t === "run.finished")?.event;
  return f && f.t === "run.finished" ? f.outcome : "no run";
};

const QUESTIONS = {
  public: "What are the office hours?",
  internal: "What are the office hours?",
  confidential: "Can you remind ra-1@example.org about the freezer log?",
  restricted: "Did P-12345 finish the sleep diary?",
  controlled_access: "Which consent groups does phs000123.v2.p1 allow?",
  phi: "Patient: John Smith was admitted 03/04/2026, can he enroll?",
  export_controlled: "Can I paste the ITAR drawings for the sensor housing?",
  "review-confidential": "REVIEW-CONFIDENTIAL: reviewer 2 says the aims overlap",
} as const;

test("hosted classes are answered by the hosted model: public on the D0 channel, internal on a D1 one, confidential at approved", async () => {
  for (const [cls, auth] of [["public", undefined], ["internal", ACP], ["confidential", undefined]] as const) {
    const a = await ask(hostedWeb.base, QUESTIONS[cls], auth);
    assert.equal(a.status, 202, `${cls}: ${JSON.stringify(a.body)}`);
    assert.equal(outcome(a), "answered", cls);
    assert.ok(a.hostedRequests > 0, `${cls}: the hosted model answered`);
    const started = a.events[0]!.event;
    assert.equal(started.t === "run.started" && started.input.cls, cls === "public" ? "D0" : cls === "internal" ? "D1" : "D2");
  }
});

test("restricted never reaches the hosted model: the run is refused and its notice names the class and the rule", async () => {
  for (const cls of ["restricted"] as const) {
    const a = await ask(hostedWeb.base, QUESTIONS[cls]);
    assert.equal(a.status, 202, cls);
    assert.equal(outcome(a), "refused", cls);
    assert.equal(a.hostedRequests, 0, `${cls}: zero hosted requests`);
    assert.ok(a.events.some((e) => e.event.t === "egress.refused"), `${cls}: the record holds the refusal`);
    assert.match(a.shown, new RegExp(`Data class ${cls}, found by detector [a-z-]+; rule model_tier = "local"`), `${cls}: ${a.shown}`);
  }
});

test("export_controlled is refused at the door for an endpoint with no region, with zero requests, and recorded", async () => {
  const a = await ask(hostedWeb.base, QUESTIONS.export_controlled);
  assert.equal(a.status, 403);
  assert.equal(a.hostedRequests + a.labRequests, 0);
  assert.match(a.shown, /^Not sent\. Data class export_controlled, found by detector export-marker; rule residency = "us": this agent's model endpoint hosted names no region\. .+ Recorded as audit event \d+\.$/, a.shown);
  const audit = (await loadAudit(db)).find((r) => r.seq === a.body.dataClass!.audit)!.event;
  assert.ok(audit.t === "gate.refused" && audit.dataClass === "export_controlled" && audit.classRule === 'residency = "us"' && audit.kept.t === "text");
});

test("local classes are answered by a lab model in region us, with zero hosted requests", async () => {
  const web = await ps.startWeb(labCfg);
  ps.startWorker(labCfg, "P2");
  for (const cls of ["restricted", "export_controlled"] as const) {
    const a = await ask(web.base, QUESTIONS[cls]);
    assert.equal(outcome(a), "answered", cls);
    assert.equal(a.hostedRequests, 0, `${cls}: zero hosted requests`);
    assert.ok(a.labRequests > 0, `${cls}: the lab model answered`);
  }
});

test("none classes are refused at the door with zero model requests anywhere, named in the reply, the audit record and Slack", async () => {
  const kept = { phi: "hash", controlled_access: "hash", "review-confidential": "hash" } as const;
  for (const cls of ["phi", "controlled_access", "review-confidential"] as const) {
    const a = await ask(hostedWeb.base, QUESTIONS[cls]);
    assert.equal(a.status, 403, cls);
    assert.equal(a.body.t, "refused");
    assert.equal(a.hostedRequests + a.labRequests, 0, `${cls}: zero model requests`);
    assert.equal(a.body.runId, undefined, `${cls}: no run exists`);
    assert.match(a.shown, new RegExp(`^Not sent\\. Data class ${cls}, found by detector [a-z-]+; rule model_tier = "none"\\. .+ Recorded as audit event \\d+\\.$`), a.shown);
    const audit = (await loadAudit(db)).find((r) => r.seq === a.body.dataClass!.audit)!.event;
    assert.ok(audit.t === "gate.refused");
    assert.equal(audit.dataClass, cls);
    assert.equal(audit.classRule, 'model_tier = "none"');
    assert.equal(audit.kept.t, kept[cls]);
    assert.ok(!JSON.stringify(audit).includes(QUESTIONS[cls].slice(0, 20)), `${cls}: the audit row holds no text`);
    assert.equal(replyFor({ t: "refused", runId: null, message: a.shown }, ""), a.shown.replace(/&/g, "&amp;"), `${cls}: the Slack door shows the same refusal`);
  }
  const phi = (await loadAudit(db)).map((r) => r.event).find((e) => e.t === "gate.refused" && e.dataClass === "phi");
  assert.equal(phi?.t === "gate.refused" && phi.retentionDays, 30, "the record carries the class's retention");
});
