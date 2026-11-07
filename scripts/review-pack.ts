#!/usr/bin/env node
/**
 * pnpm review-pack [--config config/lab.toml] [--out docs/review]: writes the security review pack for one lab.toml,
 * docs/review/<lab>/{summary,hipaa,nist-800-171,hecvat-answers}.md, and prints the summary's counts. The rows and
 * their statuses come from packages/core/src/review/controls.ts, so the pack follows the code and the config.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseConfig } from "../packages/core/src/config.ts";
import { sha256 } from "../packages/core/src/hash.ts";
import { packSlug, renderPack } from "../packages/core/src/review/render.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function writeReviewPack(configPath: string, outRoot: string): Promise<{ dir: string; files: readonly string[] }> {
  const abs = resolve(configPath);
  const text = await readFile(abs, "utf8");
  const config = parseConfig(text, abs);
  const files = renderPack(config, { configPath: relative(root, abs), configSha256: sha256(text) });
  const dir = join(outRoot, packSlug(config, basename(dirname(abs))));
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return { dir, files: Object.keys(files) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { config: { type: "string" }, out: { type: "string" } } });
  try {
    const { dir, files } = await writeReviewPack(values.config ?? "config/lab.toml", resolve(values.out ?? join(root, "docs/review")));
    for (const f of files) console.log(relative(process.cwd(), join(dir, f)));
  } catch (err) {
    console.error(`review-pack: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
