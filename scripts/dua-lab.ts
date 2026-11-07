/**
 * The DUA scenario on the synthetic lab, through the real web door and worker, with every model request kept: what
 * pnpm walk:dua prints and test/dua-wire.test.ts asserts. lab0's sleep cohort release (fixtures/dua) has open methods
 * notes, one entry under DUA sleep-release (ana and raj), one under DUA sleep-linkage-2025 (ana, expired 2026-01-31),
 * and a whole knowledge base under DUA sleep-cohort (ana). Two members ask: ana, whom the DUAs name, and ben, whom
 * they do not. The fake models search, read every hit and answer from titles, so the bodies they receive are exactly
 * what the run let through.
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadEvents, type RunId } from "../packages/core/src/record.ts";
import { startFakeModel } from "../test/fake-model.ts";
import { freshDatabase } from "../test/db.ts";
import { ensurePostgres, processes, waitFor } from "./procs.ts";

export const SENTINELS = { consent: "SENTINEL-CONSENT-7731", linkage: "SENTINEL-LINKAGE-4420", cohort: "SENTINEL-COHORT-5150" } as const;
export const ANA = "ana@lab0.example";
export const BEN = "ben@lab0.example";

export interface Asked {
  readonly label: string;
  readonly member: string;
  readonly agent: string;
  readonly question: string;
  readonly status: number;
  /** What the member reads: the reply, or the door's refusal. */
  readonly shown: string;
  readonly outcome: string;
  /** Every request body each model received while this question ran, as JSON text. */
  readonly lab: readonly string[];
  readonly hosted: readonly string[];
}

export async function duaWalk(root: string, work: string, database: string): Promise<Asked[]> {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const fx = join(work, "fixtures");
  cpSync(join(root, "fixtures/dua"), fx, { recursive: true });
  const visits = join(work, "cohort-visits");
  mkdirSync(visits);
  writeFileSync(join(visits, "visits.csv"), "visit,hours\nbaseline,7\n");

  await ensurePostgres(root);
  const { db, url } = await freshDatabase(database);
  const lab = await startFakeModel("scripted-1", "search-read-answer");
  const hosted = await startFakeModel("hosted-2", "search-read-answer");
  const hex = () => randomBytes(32).toString("hex");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: url, LABH_PAYLOAD_KEY: hex() };
  const base = JSON.parse(readFileSync(join(root, "fixtures/agent.json"), "utf8")) as Record<string, unknown>;
  const duas = readFileSync(join(fx, "duas.toml"), "utf8");

  const config = (name: string, kb: string, endpoint: "lab" | "hosted", ceiling: string) => {
    const agent = join(work, `agent-${name}.json`);
    const modelId = endpoint === "lab" ? "scripted-1" : "hosted-2";
    writeFileSync(agent, JSON.stringify({ ...base, agentId: name, name, knowledgeBases: [kb], ceiling, model: { endpointId: endpoint, modelId, params: { temperature: 0, maxOutputTokens: 256 } } }));
    const path = join(work, `lab-${name}.toml`);
    writeFileSync(
      path,
      [
        `[endpoints.lab]\nbase_url = "${lab.url}"\nplacement = "lab"\nregion = "us"`,
        `[endpoints.hosted]\nbase_url = "${hosted.url}"\nplacement = "approved"`,
        '[surfaces.web]\nplacement = "lab"\nport = 0\nchannel = "front"',
        '[channel_floors]\n"web:front" = "D0"',
        `[agents]\nfixtures = ["${agent}"]`,
        `[knowledge_bases]\nfixtures = ["${join(fx, "kb-release.json")}", "${join(fx, "kb-cohort.json")}"]`,
        `[datasets.cohort-visits]\npath = "${visits}"\nclass = "D3"\ndescription = "Hours of sleep per cohort visit"`,
        duas,
      ].join("\n"),
    );
    return path;
  };

  const ps = processes(root, work, env);
  const asked: Asked[] = [];
  let n = 0;
  try {
    const doors = {
      "release-lab": await ps.startWeb(config("release-lab", "lab0-release", "lab", "D3")),
      "release-hosted": await ps.startWeb(config("release-hosted", "lab0-release", "hosted", "D2")),
      "cohort-hosted": await ps.startWeb(config("cohort-hosted", "lab0-cohort", "hosted", "D2")),
    };
    ps.startWorker(config("worker", "lab0-release", "lab", "D3"), "D1");
    const ask = async (label: string, member: string, agent: keyof typeof doors, question: string) => {
      const before = { lab: lab.bodies.length, hosted: hosted.bodies.length };
      const web = doors[agent].base;
      const res = await fetch(`${web}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread: `dua-${n}`, message: `m-${n++}`, text: question, user: member }) });
      const body = (await res.json()) as { runId?: string; userFacing?: string };
      let shown = String(body.userFacing ?? "");
      let outcome = `door ${res.status}, no run`;
      if (typeof body.runId === "string") {
        const runId = body.runId as RunId;
        const events = await waitFor("run.finished", async () => {
          const es = await loadEvents(db, runId);
          return es.some((e) => e.event.t === "run.finished") ? es : null;
        }, 30_000);
        const finished = events.find((e) => e.event.t === "run.finished")?.event;
        outcome = finished?.t === "run.finished" ? `run ${finished.outcome}` : "run ?";
        shown = (await waitFor("a reply", async () => {
          const r = (await (await fetch(`${web}/replies?runId=${runId}`)).json()) as { text: string }[];
          return r.length ? r : null;
        }, 15_000)).map((r) => r.text).join(" / ");
      }
      asked.push({ label, member, agent, question, status: res.status, shown, outcome, lab: lab.bodies.slice(before.lab).map((b) => JSON.stringify(b)), hosted: hosted.bodies.slice(before.hosted).map((b) => JSON.stringify(b)) });
    };
    const Q = "Which consent groups and linkage keys does the release have, and how is the actigraphy watch worn?";
    await ask("ben, not named, lab model", BEN, "release-lab", Q);
    await ask("ana, named, lab model", ANA, "release-lab", Q);
    await ask("ana, named, hosted model", ANA, "release-hosted", Q);
    await ask("ana, named, whole-KB DUA on a hosted model", ANA, "cohort-hosted", "When are the cohort visits and what does each visit collect?");
    await ask("ben, not named, whole-KB DUA on a hosted model", BEN, "cohort-hosted", "When are the cohort visits and what does each visit collect?");
  } finally {
    await ps.stopAll();
    await lab.close();
    await hosted.close();
    await db.end();
  }
  return asked;
}

/** The outcomes the walk must show, as the unit's done-when states them. Throws on the first one that does not hold. */
export function checkDuaWalk(asked: readonly Asked[]): void {
  const by = (label: string) => asked.find((a) => a.label.startsWith(label)) ?? assert.fail(`no question ${label}`);
  const every = (a: Asked) => [...a.lab, ...a.hosted];
  const has = (a: Asked, text: string) => every(a).some((b) => b.includes(text));

  const ben = by("ben, not named, lab model");
  assert.equal(ben.outcome, "run answered");
  assert.ok(ben.lab.length > 0, "ben's question reached the lab model");
  for (const s of Object.values(SENTINELS)) assert.ok(!has(ben, s), `ben: no request carries ${s}`);
  for (const path of ["release/consent-groups.md", "release/linkage-keys.md"]) assert.ok(!has(ben, path), `ben: no request names ${path}, not even in the outline`);
  assert.ok(has(ben, "DUA sleep-release does not name the member who asked; rule: only the members [duas.sleep-release] members names read its data"), "ben's model was told which DUA and which rule");

  const ana = by("ana, named, lab model");
  assert.equal(ana.outcome, "run answered");
  assert.ok(has(ana, SENTINELS.consent), "ana, named in sleep-release, read its entry on the lab model");
  assert.ok(!has(ana, SENTINELS.linkage), "the expired DUA refused ana, whom it names");
  assert.ok(has(ana, "DUA sleep-linkage-2025 expired on 2026-01-31; rule: no one reads its data after [duas.sleep-linkage-2025] expires"));
  assert.equal(ana.hosted.length, 0);

  for (const label of ["ana, named, hosted model", "ana, named, whole-KB"]) {
    const a = by(label);
    assert.equal(a.status, 403, `${label}: refused at the door`);
    assert.equal(a.hosted.length + a.lab.length, 0, `${label}: zero model requests`);
    assert.match(a.shown, /bound by DUA sleep-(release|cohort), data class restricted at D3, .* rule: a DUA's data goes only to a model on hardware its class allows \(model_tier = "local"\)/);
  }
  const benHosted = by("ben, not named, whole-KB");
  assert.equal(benHosted.outcome, "run answered", "a member the DUA does not name still uses the agent");
  assert.ok(!has(benHosted, SENTINELS.cohort) && !has(benHosted, "cohort/visit-schedule.md"), "and no hosted request carries the DUA's knowledge base");
  assert.ok(has(benHosted, "DUA sleep-cohort does not name the member who asked"));
}
