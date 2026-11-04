#!/usr/bin/env node
/**
 * One step of the compose check (scripts/compose-check.sh), run inside the web
 * container: ask the web door one pre-registered lab0 question and require a
 * cited answer, or re-read a run already answered and require the same record.
 *
 *   node scripts/compose-ask.ts ask <base-url>          prints the run id
 *   node scripts/compose-ask.ts verify <base-url> <run-id>
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const [mode, base, given] = process.argv.slice(2);
assert.ok((mode === "ask" || (mode === "verify" && given)) && base, "usage: compose-ask.ts ask <base-url> | verify <base-url> <run-id>");

const questions = JSON.parse(readFileSync(new URL("../fixtures/lab0/questions.json", import.meta.url), "utf8")) as { inDocument: { id: string; question: string; expected: string }[] };
const q = questions.inDocument[0]!;

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.json() };
}

let runId = given;
if (mode === "ask") {
  const sent = await json("/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread: "compose-check", message: `m-${Date.now()}`, text: q.question, user: "member-1" }) });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  runId = sent.body.runId as string;
}

let answer: string | undefined;
for (let i = 0; i < 150 && answer === undefined; i++) {
  const replies = await json(`/replies?runId=${runId}`);
  answer = (replies.body as { kind: string; text: string }[]).find((r) => r.kind === "reply")?.text;
  if (answer === undefined) await sleep(200);
}
assert.ok(answer !== undefined, `run ${runId} posted no answer within 30 s`);
assert.ok(answer.includes(q.expected), `the answer does not cite ${q.expected}: ${answer}`);

const view = await json(`/runs/${runId}/view`);
assert.equal(view.status, 200);
assert.equal(view.body.chain.firstBad, null, `the record's hash chain is broken: ${JSON.stringify(view.body.chain)}`);
const events = (await json(`/runs/${runId}/events`)).body as { event: { t: string; retrieved?: { entries: string[] }[] } }[];
const retrieved = events.flatMap((e) => (e.event.t === "tool.completed" ? (e.event.retrieved ?? []).flatMap((r) => r.entries) : []));
assert.ok(retrieved.length > 0, "the run retrieved no knowledge base entry");

if (mode === "ask") console.log(runId);
else console.log(`run ${runId}: answer cites ${q.expected}, ${events.length} events, chain intact`);
