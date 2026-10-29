#!/usr/bin/env node
/**
 * A headless browser capture of a running demo's chat page, for the README. It asks every question the demo printed,
 * opens the first answer's record, and writes docs/images/demo.mp4 and demo.gif. It is a scripted capture, not a
 * screen recording: docs/demo-recording.md has the shot list for a real one.
 *
 *   pnpm demo                      # in one terminal; copy the chat page link it prints
 *   node scripts/record-demo.ts --url '<that link>'
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values } = parseArgs({ options: { url: { type: "string" }, out: { type: "string" }, scheme: { type: "string", default: "light" } } });
if (!values.url) throw new Error("--url is required: the chat page link the demo printed");
const url = new URL(values.url);
const questions = (url.searchParams.get("try") ?? "").split("|").filter(Boolean);
if (questions.length < 2) throw new Error("the link needs at least two questions in ?try=");
const out = resolve(values.out ?? join(fileURLToPath(new URL("..", import.meta.url)), "docs/images"));
const size = { width: 1280, height: 800 };

const raw = mkdtempSync(join(tmpdir(), "aliquot-capture-"));
const browser = await chromium.launch({ ...(process.env.LABH_CHROMIUM ? { executablePath: process.env.LABH_CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: values.scheme === "dark" ? "dark" : "light", recordVideo: { dir: raw, size } });
const page = await context.newPage();
page.setDefaultTimeout(180_000);
const records = page.locator(".turn a", { hasText: "Record" });

await page.goto(url.href);
await page.waitForTimeout(1500);
await page.locator("button.try").first().click();
await records.nth(0).waitFor();
await page.waitForTimeout(3500);
for (const [i, q] of questions.slice(1).entries()) {
  await page.locator("#text").pressSequentially(q, { delay: 35 });
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await records.nth(i + 1).waitFor();
  await page.waitForTimeout(500);
  await page.evaluate('window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })');
  await page.waitForTimeout(4500);
}
await records.nth(0).click();
await page.locator("#rows").waitFor();
await page.waitForTimeout(2500);
await page.mouse.wheel(0, 500);
await page.waitForTimeout(3000);
await context.close();
await browser.close();

const webm = join(raw, readdirSync(raw).find((f) => f.endsWith(".webm"))!);
const mp4 = join(out, "demo.mp4");
const gif = join(out, "demo.gif");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-movflags", "+faststart", mp4]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf", "fps=10,crop=900:800:190:0,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", gif]);
rmSync(raw, { recursive: true, force: true });
console.log(`wrote ${mp4} and ${gif}`);
