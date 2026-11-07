/**
 * Accessibility checks for the headless browser scripts: axe-core (pinned in package.json, test only) over a page,
 * and whether the focused element shows a focus indicator.
 *
 * scan runs axe's WCAG 2.0 and 2.1 A and AA rules and returns the serious and critical violations, each with the
 * selectors it hit, so a failure names what to fix. Minor and moderate ones are counted, not failed on.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright";

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
export const AXE_VERSION = (JSON.parse(readFileSync(createRequire(import.meta.url).resolve("axe-core/package.json"), "utf8")) as { version: string }).version;
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

export interface Violation {
  readonly id: string;
  readonly impact: string;
  readonly help: string;
  readonly targets: readonly string[];
}
export interface Scan {
  readonly blocking: readonly Violation[];
  readonly other: number;
  readonly passes: number;
}

/** exclude names selectors axe skips: only a known exception recorded in docs/accessibility.md belongs here. */
export async function scan(page: Page, exclude: readonly string[] = []): Promise<Scan> {
  if (!(await page.evaluate("typeof window.axe === 'object'"))) await page.evaluate(AXE);
  const result = (await page.evaluate(
    `axe.run({ include: [document], exclude: ${JSON.stringify(exclude.map((s) => [s]))} }, { runOnly: { type: "tag", values: ${JSON.stringify(WCAG_TAGS)} }, resultTypes: ["violations"] })`,
  )) as { violations: { id: string; impact: string | null; help: string; nodes: { target: string[] }[] }[]; passes: unknown[] };
  const blocking = result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ id: v.id, impact: v.impact!, help: v.help, targets: v.nodes.map((n) => n.target.join(" ")) }));
  return { blocking, other: result.violations.length - blocking.length, passes: result.passes.length };
}

export const describe = (vs: readonly Violation[]) => vs.map((v) => `${v.impact} ${v.id} (${v.help}): ${v.targets.slice(0, 4).join(", ")}${v.targets.length > 4 ? ` and ${v.targets.length - 4} more` : ""}`).join("\n");

/**
 * What marks the focused element: its own outline, or for the chat composer's field, the ring the .box around it draws
 * (its border plus its outline). A ring counts when it is at least 2 px wide and its colour is at least 3:1 against the
 * page background, the WCAG 1.4.11 bar for a state indicator. Null when nothing is focused; ring is empty when nothing
 * passes.
 */
export async function focusRing(page: Page): Promise<{ element: string; ring: string } | null> {
  return (await page.evaluate(FOCUS_RING)) as { element: string; ring: string } | null;
}

// Runs in the page, so it is a string: this package's TypeScript has no DOM types.
const FOCUS_RING = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const name = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ' "' + (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40) + '"';
  const rgb = (c) => (c.match(/[\\d.]+/g) ?? []).map(Number);
  const lum = (c) => c.slice(0, 3).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  const bg = rgb(getComputedStyle(document.body).backgroundColor);
  const contrast = (c) => {
    const [r, g, b, a = 1] = rgb(c);
    const over = [r, g, b].map((v, i) => v * a + bg[i] * (1 - a));
    const [x, y] = [lum(over), lum(bg)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const rings = [];
  const own = getComputedStyle(el);
  if (own.outlineStyle !== "none") rings.push({ what: "outline", width: parseFloat(own.outlineWidth), color: own.outlineColor });
  const box = el.closest(".box");
  if (box) {
    const s = getComputedStyle(box);
    const outline = s.outlineStyle === "none" ? 0 : parseFloat(s.outlineWidth);
    rings.push({ what: "composer ring", width: outline + parseFloat(s.borderTopWidth), color: outline ? s.outlineColor : s.borderTopColor });
  }
  const pass = rings.find((r) => r.width >= 2 && contrast(r.color) >= 3);
  return { element: name, ring: pass ? pass.what + " " + pass.width + "px " + pass.color + ", " + contrast(pass.color).toFixed(1) + ":1" : "" };
})()`;
