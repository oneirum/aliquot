// aliquot export and replay. export boots the shared core (lab.toml, Postgres and the payload key) and writes a bundle
// directory. replay reads only a bundle directory: no lab.toml, no database, no key. With --reexecute it calls the one
// --endpoint it is given, and nothing else.
import { resolve } from "node:path";
import { bootShared, type SharedCore } from "../src/boot-shared.ts";
import { configProblem } from "../src/config.ts";
import { PLACEMENTS, type DataClass, type Placement } from "../src/dataclass.ts";
import type { RunId } from "../src/record.ts";
import { audit, BundleUnreadable, exportBundle, ExportRefused, formatAudit, formatReplay, reexecute, type ExportScope } from "../src/replay.ts";

export const REPLAY_USAGE = `  export (--runs <id,...> | --study <id>) --clearance D0..D3 --out <dir> [--as <member>]
                      write a reviewer bundle: the runs' records, their agent versions and cards, the knowledge base
                      snapshots they pin, and every body at or below --clearance. A body above it is listed by hash
                      and class only. --out must be empty, under a path this process may write: run it as
                      pnpm aliquot:export, which allows writes under bundles/ only. The audit stream records the
                      export with --as (self-declared) and the OS user who ran it. For a SIEM, audit export
                      streams event metadata without bodies instead.
  replay <dir> [--reexecute --endpoint <url> [--endpoint-placement lab|institution|approved|zdr|public]]
                      verify every chain in a bundle and print the audit view, from the directory alone: no lab.toml,
                      database or key. --reexecute runs each run again against the OpenAI-compatible model at
                      --endpoint, every tool call answered from the record, and reports agreement or the first
                      divergence. --endpoint-placement says where that endpoint runs (default public); a run whose
                      bodies that placement may not receive is skipped before any request. Verifying shows the bundle
                      is internally consistent, not that it is the lab's: compare each head with the lab's anchor.`;

/** Exit codes past the shared ones: a broken chain is 3, as for record. */
export const REPLAY_EXIT = { diverged: 4, skipped: 5 } as const;

export interface ExportFlags {
  readonly config: string;
  readonly json: boolean;
  readonly runs?: string;
  readonly study?: string;
  readonly clearance?: string;
  readonly out?: string;
  readonly as?: string;
}

const CLEARANCE = /^D[0-3]$/;
const isPlacement = (p: string): p is Placement => (PLACEMENTS as readonly string[]).includes(p);

function usage(): number {
  process.stderr.write(`usage:\n${REPLAY_USAGE}\n`);
  return 2;
}

function scopeOf(flags: ExportFlags): ExportScope | null {
  if (flags.runs && !flags.study) {
    const runs = flags.runs.split(",").map((r) => r.trim());
    return runs.every((r) => /^[0-9a-f-]{36}$/i.test(r)) ? { runs: runs as RunId[] } : null;
  }
  return flags.study && !flags.runs ? { study: flags.study } : null;
}

export async function exportCommand(words: readonly string[], flags: ExportFlags): Promise<number> {
  const scope = scopeOf(flags);
  if (words.length || !scope || !flags.clearance || !CLEARANCE.test(flags.clearance) || !flags.out) return usage();
  const out = resolve(flags.out);
  if (!process.permission?.has("fs.write", out)) {
    process.stderr.write(`export writes under ${out}, and this process may not. Run it as pnpm aliquot:export with --out under bundles/, or allow it with --allow-fs-write=<dir>/* (the /* covers what export creates under it).\n`);
    return 2;
  }
  const refused = await configProblem(flags.config);
  if (refused) {
    process.stderr.write(`${refused}\n`);
    return 2;
  }
  let core: SharedCore;
  try {
    core = await bootShared(flags.config);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  try {
    const index = await exportBundle(core, scope, { clearance: flags.clearance as DataClass, out, ...(flags.as ? { actor: flags.as } : {}) });
    const held = index.payloads.filter((p) => p.disclosure.t !== "included").length;
    process.stdout.write(
      flags.json
        ? `${JSON.stringify(index, null, 2)}\n`
        : `wrote ${out}: ${index.runs.length} runs, ${index.payloads.length - held} bodies included, ${held} withheld at clearance ${index.clearance}\nverify with: aliquot replay ${out}\n`,
    );
    return 0;
  } catch (err) {
    if (!(err instanceof ExportRefused)) throw err;
    process.stderr.write(`refused: ${err.message}\n`);
    return 1;
  } finally {
    await core.close();
  }
}

export async function replayCommand(words: readonly string[], flags: { readonly json: boolean; readonly reexecute: boolean; readonly endpoint?: string; readonly endpointPlacement?: string }): Promise<number> {
  const [dir, ...rest] = words;
  if (!dir || rest.length || flags.reexecute !== !!flags.endpoint) return usage();
  if (flags.endpoint && !/^https?:\/\/[^/]/.test(flags.endpoint)) return usage();
  const placement = flags.endpointPlacement ?? "public";
  if (!isPlacement(placement) || (flags.endpointPlacement && !flags.endpoint)) return usage();
  try {
    const view = await audit(dir);
    const reports = flags.endpoint ? await reexecute(dir, { endpoint: flags.endpoint, endpointPlacement: placement }) : null;
    process.stdout.write(flags.json ? `${JSON.stringify(reports ? { audit: view, replay: reports } : view, null, 2)}\n` : `${formatAudit(view)}${reports ? `\n\n${formatReplay(reports)}` : ""}\n`);
    if (view.runs.some((r) => r.chain.firstBad !== null || r.brokenBodies.length)) return 3;
    if (reports?.some((r) => r.t === "replayed" && !r.agreement.exact)) return REPLAY_EXIT.diverged;
    if (reports?.some((r) => r.t === "skipped")) return REPLAY_EXIT.skipped;
    return 0;
  } catch (err) {
    if (!(err instanceof BundleUnreadable)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
}
