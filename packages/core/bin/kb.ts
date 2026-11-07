#!/usr/bin/env node
// labh kb: node --permission --allow-fs-read=* --allow-net packages/core/bin/kb.ts <command> --config lab.toml ...
//   compile  --definition kb.json [--wait]      enqueue a kb-compile job; with --wait, print how it ended
//   coverage --snapshot <id>                    the coverage report
//   publish  --snapshot <id> [--override-gaps <note> --actor <publisher>]
//                                               move kb_heads; a snapshot with coverage gaps needs the override
//   diff     --from <id> --to <id>              what changed between two snapshots
//   search   --snapshot <id> --query <q> [--k 5]  bm25-v1 hits as JSON
//   sync     [--watch]                          ingest every [sources.<id>] and publish each synced KB that changed;
//                                               with --watch, keep going: folders on change, Drive on its poll
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { boot } from "../src/boot.ts";
import { configProblem } from "../src/config.ts";
import type { SnapshotId } from "../src/hash.ts";
import { createKbReader, loadManifest, renderDiff, storedSnapshots } from "../src/kb.ts";
import { compileResult, filesIn, loadOverrides, parseKbDefinition, publishSnapshot, readSources, renderCoverage, requestCompile } from "../src/kb-compile.ts";
import { directoryFromConfig } from "../src/members.ts";
import { requireProcessPermission, sealNetwork } from "../src/seal.ts";
import { describeSync, sourcesFromConfig, syncKb, watchSources, type DocumentSource } from "../src/sources.ts";

const denied = requireProcessPermission();
if (denied) {
  process.stderr.write(`${denied}\n`);
  process.exit(2);
}
sealNetwork();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "lab.toml" },
    definition: { type: "string" },
    wait: { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "600000" },
    snapshot: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    query: { type: "string" },
    k: { type: "string", default: "5" },
    actor: { type: "string" },
    "override-gaps": { type: "string" },
    watch: { type: "boolean", default: false },
  },
});

const configRefused = await configProblem(values.config);
if (configRefused) {
  process.stderr.write(`${configRefused}\n`);
  process.exit(2);
}
const need = (name: keyof typeof values): string => {
  const v = values[name];
  if (typeof v !== "string") throw new Error(`--${name} is required`);
  return v;
};

const core = await boot(values.config);
try {
  const command = positionals[0];
  switch (command) {
    case "compile": {
      const path = resolve(need("definition"));
      const def = parseKbDefinition(JSON.parse(await readFile(path, "utf8")));
      const req = await requestCompile(core, def, await readSources(def, filesIn(dirname(path)), { http: core.http, address: core.store.address, db: core.db, actor: values.actor ?? "cli", labPatterns: core.config.participantIdPatterns, classes: core.config.classes, endpointRegion: (id) => core.config.endpoints.find((e) => e.id === id)?.region ?? null, ...(core.sandbox ? { pdf: core.sandbox.readPdf } : {}) }), new Date());
      if (!values.wait) {
        console.log(JSON.stringify(req));
        break;
      }
      const until = Date.now() + Number(values["timeout-ms"]);
      let result = await compileResult(core.db, req.jobId);
      while (!result && Date.now() < until) {
        await sleep(200);
        result = await compileResult(core.db, req.jobId);
      }
      console.log(JSON.stringify({ ...req, result }));
      if (!result || result.t !== "compiled") process.exitCode = 1;
      break;
    }
    case "coverage": {
      const s = await loadManifest(core.db, core.store.address, need("snapshot") as SnapshotId);
      if (!s) throw new Error("no such snapshot");
      console.log(renderCoverage(s, await loadOverrides(core.db, s.id)));
      break;
    }
    case "publish": {
      const note = values["override-gaps"];
      // An override is a person's judgment, so it names them; "cli" names no one.
      if (note !== undefined && !values.actor) throw new Error("--override-gaps needs --actor naming the publisher");
      const r = await publishSnapshot(core.db, core.store.address, need("snapshot") as SnapshotId, values.actor ?? "cli", note === undefined ? null : { note });
      console.log(JSON.stringify(r));
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case "diff": {
      const source = storedSnapshots(core.db, core.store);
      const [a, b] = await Promise.all([source.load(need("from") as SnapshotId), source.load(need("to") as SnapshotId)]);
      if (!a || !b) throw new Error("no such snapshot");
      console.log(renderDiff(a, b));
      break;
    }
    case "search": {
      const reader = createKbReader(storedSnapshots(core.db, core.store));
      const hits = await reader.search(need("snapshot") as SnapshotId, need("query"), Number(values.k), "all");
      console.log(JSON.stringify(hits.value));
      break;
    }
    case "sync": {
      const configs = core.config.sources;
      if (!configs.length) throw new Error("lab.toml has no [sources.<id>]; add a synced folder or a Drive folder (docs/sources.md)");
      const labPatterns = core.config.participantIdPatterns;
      const sources = sourcesFromConfig(configs, { http: core.http, db: core.db, directory: directoryFromConfig(core.config.directory), labPatterns, ...(core.sandbox ? { pdf: core.sandbox.readPdf } : {}) }, process.env);
      const deps = { db: core.db, store: core.store, labPatterns, actor: values.actor ?? "source-sync" };
      if (!values.watch) {
        const byKb = new Map<string, DocumentSource[]>();
        for (const s of sources) byKb.set(s.kb, [...(byKb.get(s.kb) ?? []), s]);
        for (const [kb, list] of byKb) console.log(describeSync(kb, await syncKb(deps, kb, list)));
        break;
      }
      const folders = new Map(configs.flatMap((c) => (c.kind === "folder" ? [[c.id, c.path] as const] : [])));
      const polls = new Map(configs.flatMap((c) => (c.kind === "gdrive" ? [[c.id, c.pollSeconds] as const] : [])));
      const w = watchSources(deps, sources, folders, polls, (line) => console.log(line));
      await w.ready;
      console.log(`watching ${sources.length} ${sources.length === 1 ? "source" : "sources"}: ${configs.map((c) => `${c.id} (${c.kind === "folder" ? "on change" : `every ${c.pollSeconds} s`})`).join(", ")}`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
      });
      w.close();
      break;
    }
    default:
      throw new Error(`unknown command ${command ?? "(none)"}: compile, coverage, publish, diff, search or sync`);
  }
} catch (err) {
  // A source that cannot be read (a scanned PDF, a missing file) is the operator's to fix: the message, not a stack.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await core.close();
}
