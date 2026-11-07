#!/usr/bin/env node
/**
 * pnpm trust: how often Aliquot answers with an unsupported claim, cites the wrong entry, refuses what it should
 * answer, answers what it should refuse, and obeys an instruction planted in a document. Runs lab1's questions
 * through the real run loop with a scripted worst-case model (test/trust/), prints the four numbers and writes
 * docs/trust.md and docs/trust.json. No Postgres and no key.
 *
 *   node scripts/trust.ts            measure, print, rewrite docs/trust.md and docs/trust.json
 *   node scripts/trust.ts --check    measure and print; exit 1 if any count is worse than docs/trust.json (CI)
 *   node scripts/trust.ts --live     also run the model tier through claude-batch (Sonnet) first
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LAB1_DIR } from "../test/trust/lab1.ts";
import { headline, renderDoc, score, type LiveNumbers, type TrustNumbers } from "../test/trust/report.ts";
import { loadLab1, runDeterministic } from "../test/trust/run.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = new Set(process.argv.slice(2));
const docJson = `${root}docs/trust.json`;
const liveSummary = `${LAB1_DIR}live/summary.json`;

const lab = loadLab1(LAB1_DIR);
const run = await runDeterministic(lab);
const numbers = score(lab.questions, lab.injections, run);
if (args.has("--live")) {
  const { runLive } = await import("../test/trust/live.ts");
  await runLive(lab, run, liveSummary);
}
const live: LiveNumbers | null = existsSync(liveSummary) ? JSON.parse(readFileSync(liveSummary, "utf8")) : null;

console.log(`pnpm trust: lab1, ${numbers.questions} questions, ${numbers.entries} entries, ${numbers.injections} planted instructions`);
for (const line of headline(numbers, live)) console.log(line);

/** Counts where more is worse. A rise fails --check; a fall asks for the baseline to be rewritten. */
const worseIfUp = (n: TrustNumbers): Record<string, number> => ({
  "answered, should refuse": n.underRefusal.n,
  "hosted requests carrying restricted data": n.underRefusal.hostedRequests,
  "refused, should answer": n.overRefusal.n,
  "wrong entry cited": n.citation.wrong,
  "forged citations": n.citation.forged,
  "unsupported claims (lexical)": n.claims.unsupported,
  "injections succeeded": n.injection.succeeded,
  "answers lost to an injection": n.injection.deniedAnswer,
});

if (args.has("--check")) {
  if (!existsSync(docJson)) {
    console.error("docs/trust.json is missing: run pnpm trust once and commit it");
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(docJson, "utf8")) as TrustNumbers;
  const now = worseIfUp(numbers);
  const was = worseIfUp(base);
  const worse = Object.keys(now).filter((k) => now[k]! > (was[k] ?? Infinity));
  const better = Object.keys(now).filter((k) => now[k]! < (was[k] ?? -Infinity));
  if (numbers.questions !== base.questions) worse.push(`question count ${base.questions} -> ${numbers.questions}`);
  for (const k of worse) console.error(`WORSE ${k}: ${was[k] ?? "?"} -> ${now[k] ?? "?"}`);
  for (const k of better) console.log(`better ${k}: ${was[k]} -> ${now[k]} (run pnpm trust and commit docs/trust.json)`);
  if (worse.length) process.exit(1);
  console.log("trust check: no count is worse than docs/trust.json");
} else {
  const date = new Date().toISOString().slice(0, 10);
  const fixFile = `${root}docs/trust-fix.md`;
  const fix = existsSync(fixFile) ? readFileSync(fixFile, "utf8").trim() : null;
  writeFileSync(`${root}docs/trust.md`, renderDoc(numbers, live, { date, fix }));
  writeFileSync(docJson, `${JSON.stringify({ date, ...numbers }, null, 2)}\n`);
  console.log("wrote docs/trust.md and docs/trust.json");
}
