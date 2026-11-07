/**
 * Campus presets: a university's own data tiers mapped onto Aliquot's data classes.
 *
 * lab.toml names one with `preset = "uw-madison"` (a file in presets/ at the repo root) or a path to the lab's own
 * file. A preset is the same [classes.<id>] tables lab.toml takes, each with the campus tier it maps to and the page
 * that says so, under a [preset] table naming the campus and its tiers. The lab's own [classes] are merged over it
 * key by key, so a lab changes one setting without copying the file. A preset is a starting point for the lab's data
 * steward, never the campus's own interpretation.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { DATA_CLASSES } from "./dataclass.ts";
import { MODEL_TIERS, RECORD_MODES, type DeclaredClass } from "./policy.ts";

/** The presets this repo ships, by the id lab.toml names. */
export const PRESETS = ["uw-madison", "umich", "harvard"] as const;
export const PRESET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../presets");

/** One [classes.<id>] table, in lab.toml or a preset. */
export const declaredClass = z
  .object({
    level: z.enum(DATA_CLASSES).optional(),
    model_tier: z.enum(MODEL_TIERS).optional(),
    record: z.enum(RECORD_MODES).optional(),
    retention_days: z.number().int().min(0).optional(),
    residency: z.string().regex(/^[a-z]{2}$/, "residency is a two-letter country code, such as us").optional(),
    detectors: z.array(z.string()).optional(),
    /** The lab's own regular expressions, run as this class's detector "class-pattern". */
    patterns: z.array(z.string()).optional(),
    message: z.string().trim().min(1).optional(),
    /** The campus tier this class maps to, one of the preset's tiers. */
    campus_tier: z.string().trim().min(1).optional(),
    /** The campus page the mapping rests on. */
    source: z.string().url().optional(),
  })
  .strict();

const presetFile = z
  .object({
    preset: z
      .object({
        /** The campus as a reviewer names it, shown beside every class: "UW-Madison". */
        campus: z.string().trim().min(1),
        /** The classification it follows: "UW-504". */
        scheme: z.string().trim().min(1),
        /** The campus's tiers, lowest first, in its own words. */
        tiers: z.array(z.string().trim().min(1)).min(1),
        source: z.string().url(),
        /** What the file is: must say it is a starting point for the data steward. */
        note: z.string().regex(/starting point for your data steward/, "a preset's note says it is a starting point for your data steward"),
      })
      .strict(),
    classes: z.record(z.string(), declaredClass),
  })
  .strict();

export interface Preset {
  /** The id lab.toml named, or the file's path for a lab's own preset. */
  readonly id: string;
  readonly path: string;
  readonly campus: string;
  readonly scheme: string;
  readonly tiers: readonly string[];
  readonly source: string;
  readonly note: string;
  readonly classes: Readonly<Record<string, DeclaredClass>>;
}

/** A shipped preset by id, or a lab's own file by a path relative to lab.toml. Throws with the lab.toml key on any problem. */
export function loadPreset(name: string, labDir: string): Preset {
  const own = name.includes("/") || name.endsWith(".toml");
  if (!own && !PRESETS.includes(name as (typeof PRESETS)[number])) throw new Error(`lab.toml: preset = "${name}" is not a preset; the presets are ${PRESETS.join(", ")}, or a path to the lab's own .toml`);
  const path = own ? resolve(labDir, name) : resolve(PRESET_DIR, `${name}.toml`);
  let parsed: z.infer<typeof presetFile>;
  try {
    parsed = presetFile.parse(parseToml(readFileSync(path, "utf8")));
  } catch (err) {
    throw new Error(`lab.toml: preset = "${name}" (${path}) does not load: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const [id, c] of Object.entries(parsed.classes)) {
    if (!c.campus_tier || !c.source) throw new Error(`preset ${path}: [classes.${id}] needs campus_tier and source: every mapping says which tier and which page`);
    if (!parsed.preset.tiers.includes(c.campus_tier)) throw new Error(`preset ${path}: [classes.${id}] campus_tier = "${c.campus_tier}" is not one of ${parsed.preset.tiers.join(", ")}`);
  }
  return { id: name, path, ...parsed.preset, classes: parsed.classes };
}

/** The lab's [classes] over the preset's, key by key within each class. */
export function mergeClasses(preset: Preset | null, lab: Readonly<Record<string, DeclaredClass>>): Record<string, DeclaredClass> {
  const out: Record<string, DeclaredClass> = { ...preset?.classes };
  for (const [id, c] of Object.entries(lab)) out[id] = { ...out[id], ...c };
  return out;
}
