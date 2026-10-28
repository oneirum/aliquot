/**
 * Skills: procedures in markdown, authored in the studio, versioned by
 * content hash. An agent sees only a catalog (name and summary per skill) in
 * its instructions and calls the built-in skill_read tool to load one.
 *
 * Export uses the open skill-folder format (SKILL.md with name and
 * description frontmatter) so lab members' own coding agents can use the same
 * procedures. The export is derived from SkillVersion, never edited by hand.
 */

import type { DataClass } from "./dataclass.ts";
import type { SkillVersionHash } from "./hash.ts";

export interface SkillVersion {
  readonly skillId: string;
  readonly version: SkillVersionHash;
  readonly name: string;
  /** One or two sentences: what it is for. Goes in the catalog. */
  readonly summary: string;
  readonly body: string;
  readonly cls: DataClass;
}

export interface SkillCatalogEntry {
  readonly name: string;
  readonly summary: string;
}

/** Pure. The catalog text placed in the system prompt. Order is by name so the prompt is stable. */
export function renderCatalog(_skills: readonly SkillCatalogEntry[]): string {
  throw new Error("not implemented");
}

/** Pure. SKILL.md content for the open skill-folder export. */
export function toSkillFolder(_skill: SkillVersion): { readonly path: string; readonly content: string } {
  throw new Error("not implemented");
}
