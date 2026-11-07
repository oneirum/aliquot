#!/usr/bin/env node
/**
 * pnpm walk:dua: data bound to named people and a date, on the synthetic lab, as two members see it (scripts/dua-lab.ts).
 * Prints what each member reads and what reached each model on the wire, then checks the outcomes.
 *
 * With --stills <script>, the doors stay up after the questions and the script is run with their URLs as JSON: on
 * this lab's Mac, a Playwright script run in the Atlas helper login, which saves chat-page stills.
 *
 *   node scripts/walk-dua.ts [--stills shoot.mjs]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDuaWalk, duaWalk, SENTINELS } from "./dua-lab.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const print = (line = "") => process.stdout.write(`${line}\n`);
let failed = false;
try {
  print("Aliquot DUAs on lab0. DUA sleep-release names ana and raj; sleep-linkage-2025 named ana and expired 2026-01-31; sleep-cohort names ana for the whole visit schedule.\n");
  const at = process.argv.indexOf("--stills");
  const shoot = at > 0 ? process.argv[at + 1] : undefined;
  // Async, never execFileSync: the fake models answer from this process, so blocking it would stall every run the stills ask.
  const hold = shoot ? async (doors: Readonly<Record<string, string>>) => void print((await promisify(execFile)("atlas", ["run", "--timeout", "600", "--", process.execPath, resolve(shoot), JSON.stringify(doors)])).stdout) : undefined;
  const asked = await duaWalk(root, join(root, ".walk-dua"), "labh_walk_dua", hold);
  const carried = (bodies: readonly string[]) => Object.entries(SENTINELS).filter(([, s]) => bodies.some((b) => b.includes(s))).map(([k]) => k);
  for (const a of asked) {
    print(`── ${a.label}  (agent ${a.agent})`);
    print(`   ${a.member.split("@")[0]}  > ${a.question}`);
    print(`   aliquot > ${a.shown.replace(/\s+/g, " ").slice(0, 300)}`);
    const why = [...new Set([...a.lab, ...a.hosted].flatMap((b) => b.match(/DUA [a-z0-9-]+ (?:does not name|expired on \d{4}-\d{2}-\d{2})/g) ?? []))];
    print(`   wire    : ${a.outcome}; ${a.lab.length} lab model requests, ${a.hosted.length} hosted; entry text in them: ${carried([...a.lab, ...a.hosted]).join(", ") || "none"}`);
    if (why.length) print(`   tools   : told the model ${why.join("; ")}`);
    print();
  }
  checkDuaWalk(asked);
  print("walk:dua ok: ben's runs carried no DUA entry text; ana read sleep-release on the lab model only; the expired DUA refused her; 0 hosted requests carried DUA data.");
} catch (err) {
  failed = true;
  print(`\nwalk:dua FAILED: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(failed ? 1 : 0);
