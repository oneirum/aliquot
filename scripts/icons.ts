/**
 * Renders the home screen icons from packages/core/assets/icon.svg, the one master:
 *
 *   node scripts/icons.ts
 *
 * The "any" icons round their corners and leave them transparent; the maskable and Apple icons are full bleed,
 * because Android and iOS cut their own shape. The browser is Playwright's Chromium, or LABH_CHROMIUM.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const assets = fileURLToPath(new URL("../packages/core/assets/", import.meta.url));
const svg = readFileSync(join(assets, "icon.svg")).toString("base64");

const ICONS = [
  { file: "icon-192.png", size: 192, rounded: true },
  { file: "icon-512.png", size: 512, rounded: true },
  { file: "maskable-512.png", size: 512, rounded: false },
  { file: "apple-touch-icon.png", size: 180, rounded: false },
];

const browser = await chromium.launch(process.env.LABH_CHROMIUM ? { executablePath: process.env.LABH_CHROMIUM } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const icon of ICONS) {
    await page.setViewportSize({ width: icon.size, height: icon.size });
    const radius = icon.rounded ? Math.round(icon.size * 0.225) : 0;
    await page.setContent(`<body style="margin:0"><img src="data:image/svg+xml;base64,${svg}" style="display:block;width:${icon.size}px;height:${icon.size}px;border-radius:${radius}px">`);
    await page.locator("img").evaluate("(img) => img.decode()");
    writeFileSync(join(assets, icon.file), await page.screenshot({ omitBackground: true }));
    console.log(`${icon.file} ${icon.size}x${icon.size}`);
  }
} finally {
  await browser.close();
}
