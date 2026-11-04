/**
 * Chrome's own install check on the chat page, served on loopback, and the four stills of it:
 *
 *   node scripts/webapp-audit.ts --out <dir> [--lab "Smith Lab"]
 *
 * Writes <dir>/install-audit.json (Page.getInstallabilityErrors, which is what decides whether Chrome offers to
 * install, the manifest as Chrome parsed it, and what the service worker cached) and chat-{390,1440}-{light,dark}.png.
 * Lighthouse 12 dropped its PWA category, so this asks Chrome directly, in a real profile: Chrome never installs
 * from an incognito context, which is what a plain Playwright page is. A 404 with no manifest is the control, so an
 * empty error list means something. The page needs no database, so none is used.
 * The browser is Playwright's Chromium, or LABH_CHROMIUM.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, devices } from "playwright";
import type { Db } from "../packages/core/src/db.ts";
import type { IntakeDeps } from "../packages/core/src/frontdoor.ts";
import { createWebHandler, listenWeb } from "../packages/core/src/surfaces/web.ts";

const { values } = parseArgs({ options: { out: { type: "string" }, lab: { type: "string", default: "Smith Lab" } } });
if (!values.out) throw new Error("--out <dir> is required");
const out = resolve(values.out);
mkdirSync(out, { recursive: true });

const noDb = { query: async () => { throw new Error("the chat page asked the database for something"); } } as unknown as Db;
const { server, port } = await listenWeb(createWebHandler(noDb, {} as IntakeDeps, (line) => console.error(line), null, values.lab), 0);
const origin = `http://127.0.0.1:${port}`;
const profile = mkdtempSync(join(tmpdir(), "aliquot-audit-"));
const launch = process.env.LABH_CHROMIUM ? { executablePath: process.env.LABH_CHROMIUM } : { channel: "chromium" };
const installed = await chromium.launchPersistentContext(profile, launch);
const browser = await chromium.launch(launch);
try {
  const page = installed.pages()[0] ?? (await installed.newPage());
  const cdp = await installed.newCDPSession(page);
  await page.goto(`${origin}/no-manifest-here`);
  const control = await cdp.send("Page.getInstallabilityErrors");
  await page.goto(`${origin}/`);
  await page.evaluate(`navigator.serviceWorker.ready.then(() => navigator.serviceWorker.controller
    || new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })))`);
  const installability = await cdp.send("Page.getInstallabilityErrors");
  const manifest = await cdp.send("Page.getAppManifest");
  const cached = await page.evaluate(`caches.keys().then((names) => Promise.all(names.map((n) => caches.open(n).then((c) => c.keys()).then((reqs) => ({ cache: n, paths: reqs.map((r) => new URL(r.url).pathname) })))))`);
  const audit = {
    url: origin,
    browser: browser.version(),
    installable: installability.installabilityErrors.length === 0,
    installabilityErrors: installability.installabilityErrors,
    controlWithoutManifest: { url: `${origin}/no-manifest-here`, installabilityErrors: control.installabilityErrors },
    manifestUrl: manifest.url,
    manifestErrors: manifest.errors,
    manifest: manifest.data ? JSON.parse(manifest.data) : null,
    serviceWorkerCache: cached,
  };
  writeFileSync(join(out, "install-audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
  console.log(`installable: ${audit.installable}; errors: ${JSON.stringify(audit.installabilityErrors)}; manifest errors: ${audit.manifestErrors.length}`);

  const shots = [
    { name: "390", options: { ...devices["iPhone 15"] } },
    { name: "1440", options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
  ];
  for (const shot of shots)
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ ...shot.options, colorScheme });
      const p = await context.newPage();
      await p.goto(`${origin}/?try=${encodeURIComponent("Where is the -80 freezer log?|Who signs off on new reagents?")}`);
      await p.locator("#install").waitFor();
      const file = join(out, `chat-${shot.name}-${colorScheme}.png`);
      await p.screenshot({ path: file });
      console.log(file);
      await context.close();
    }
} finally {
  await installed.close();
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
