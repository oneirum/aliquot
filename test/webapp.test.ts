import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { IntakeDeps } from "../packages/core/src/frontdoor.ts";
import { createWebHandler, listenWeb } from "../packages/core/src/surfaces/web.ts";
import { freshDatabase } from "./db.ts";

const { db } = await freshDatabase("labh_test_webapp");
const deps = {} as IntakeDeps;
const { server, port } = await listenWeb(createWebHandler(db, deps, () => {}, null, "Smith Lab"), 0);
const base = `http://127.0.0.1:${port}`;
after(async () => {
  server.close();
  await db.end();
});

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

test("the manifest installs the chat page as Aliquot, with the lab's name in the full name and colours for both themes", async () => {
  const res = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(res.headers.get("content-type"), "application/manifest+json");
  const manifest = (await res.json()) as { icons: { src: string; sizes: string; type: string; purpose: string }[] };
  assert.deepEqual(manifest, {
    id: "/",
    name: "Aliquot · Smith Lab",
    short_name: "Aliquot",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbfaf8",
    theme_color: "#fbfaf8",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
  for (const icon of manifest.icons) {
    const png = await fetch(`${base}${icon.src}`);
    assert.equal(png.headers.get("content-type"), "image/png", icon.src);
    assert.deepEqual(pngSize(Buffer.from(await png.arrayBuffer())), icon.sizes.split("x").map(Number), icon.src);
  }
  const apple = await fetch(`${base}/icons/apple-touch-icon.png`);
  assert.deepEqual(pngSize(Buffer.from(await apple.arrayBuffer())), [180, 180]);
  assert.equal((await fetch(`${base}/icons/nope.png`)).status, 404);

  const html = await (await fetch(`${base}/`)).text();
  for (const tag of [
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfaf8">',
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#151514">',
    '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">',
    '<meta name="apple-mobile-web-app-title" content="Aliquot">',
  ])
    assert.ok(html.includes(tag), tag);

  const unnamed = await listenWeb(createWebHandler(db, deps, () => {}), 0);
  try {
    const plain = (await (await fetch(`http://127.0.0.1:${unnamed.port}/manifest.webmanifest`)).json()) as { name: string };
    assert.equal(plain.name, "Aliquot");
  } finally {
    unnamed.server.close();
  }
});

test("the chat page tells a visitor how to add it to the Home Screen in one sentence, and an installed app does not", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<p class="install" id="install">To open Aliquot like an app, choose Add to Home Screen or Install in the browser menu\.<\/p>/);
  assert.match(html, /@media \(display-mode: standalone\) \{ \.install \{ display: none; \} \}/);
});

test("the service worker serves the page shell offline and never answers /runs or /replies from its cache", { timeout: 60_000 }, async () => {
  const ANSWER = "The -80 freezer held at minus 79.6 C all week (answer 7f3a)";
  const run = (await db.query<{ id: string }>("insert into jobs (kind, key, payload) values ('run', 'k:webapp', '{\"surface\":\"web\"}') returning id")).rows[0]!.id;
  await db.query("insert into web_messages (run_id, thread_id, kind, text) values ($1, 't', 'reply', $2)", [run, ANSWER]);

  // A server of its own, so stopping it takes this page offline without touching the other tests.
  const own = await listenWeb(createWebHandler(db, deps, () => {}, null, "Smith Lab"), 0);
  const origin = `http://127.0.0.1:${own.port}`;
  const browser = await chromium.launch(process.env.LABH_CHROMIUM ? { executablePath: process.env.LABH_CHROMIUM } : {});
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/?user=m1`);
    // Browser code goes in as strings, as in scripts/unit2.ts: the repo's types are Node's, not the DOM's.
    await page.evaluate(`navigator.serviceWorker.ready.then(() => navigator.serviceWorker.controller
      || new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })))`);

    // Online, through the worker: the answer and the runs list reach the page.
    const online = (await page.evaluate(`(async () => ({
      replies: await (await fetch("/replies?runId=${run}")).text(),
      runs: (await fetch("/runs")).status,
      record: (await fetch("/runs/${run}/events")).status,
    }))()`)) as { replies: string; runs: number; record: number };
    assert.ok(online.replies.includes(ANSWER));
    assert.deepEqual([online.runs, online.record], [200, 200]);

    const cached = (await page.evaluate(`(async () => {
      const out = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) out.push({ path: new URL(req.url).pathname, body: await (await cache.match(req)).text() });
      }
      return out;
    })()`)) as { path: string; body: string }[];
    assert.deepEqual(cached.map((c) => c.path).sort(), ["/", "/icons/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon.svg", "/icons/maskable-512.png", "/manifest.webmanifest"]);
    for (const c of cached) assert.ok(!c.body.includes(ANSWER) && !c.body.includes("7f3a"), `${c.path} holds answer text`);

    own.server.closeAllConnections();
    await new Promise((r) => own.server.close(r));

    // Offline: the shell comes from the cache, whatever the query string, and nothing under /runs or /replies does.
    const shell = await page.goto(`${origin}/?user=m2`);
    assert.equal(shell?.fromServiceWorker(), true);
    assert.equal(await page.locator("h1").textContent(), "Ask the lab");
    const offline = await page.evaluate(`Promise.all(["/replies?runId=${run}", "/runs", "/runs/${run}", "/runs/${run}/events"]
      .map((path) => fetch(path).then((r) => "status " + r.status, () => "failed")))`);
    assert.deepEqual(offline, ["failed", "failed", "failed", "failed"]);
  } finally {
    await browser.close();
    own.server.close();
  }
});
