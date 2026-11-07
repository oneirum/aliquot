/**
 * The README's campus preset tables, from presets/*.toml through the same loader lab.toml uses. `pnpm presets:table`
 * prints them; test/presets.test.ts fails when the README's copy differs.
 */
import { parseConfig } from "../packages/core/src/config.ts";
import { PRESET_DIR, PRESETS } from "../packages/core/src/preset.ts";

const WHO: Record<string, string> = { hosted: "an approved hosted model", local: "a lab or institution model only", none: "no model: refused at the door" };

export function presetTables(): string {
  return PRESETS.map((id) => {
    const c = parseConfig(`preset = "${id}"\n[endpoints.local]\nbase_url = "http://127.0.0.1:1"\nplacement = "lab"\n`, `${PRESET_DIR}/lab.toml`);
    const tiers = c.preset!.tiers;
    const rows = [...c.classes.classes].sort((a, b) => tiers.indexOf(a.campusTier!.tier) - tiers.indexOf(b.campusTier!.tier)).map((k) => `| ${k.campusTier!.tier} | \`${k.id}\` | ${k.level} | ${WHO[k.modelTier]}${k.residency ? `, region ${k.residency}` : ""} | [source](${k.campusTier!.source}) |`);
    return [`**${c.preset!.campus}** (\`preset = "${id}"\`, ${c.preset!.scheme})`, "", "| Campus tier | Aliquot class | Level | Who may read it | Mapping rests on |", "|---|---|---|---|---|", ...rows].join("\n");
  }).join("\n\n");
}

if (import.meta.main) process.stdout.write(`${presetTables()}\n`);
