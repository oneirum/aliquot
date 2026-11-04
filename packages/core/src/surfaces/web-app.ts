/**
 * What makes the chat page an app a member keeps on their phone: the manifest, the icons rendered from
 * packages/core/assets/icon.svg by scripts/icons.ts, and a service worker that caches the page shell.
 *
 * The worker caches only the paths in APP_SHELL. Every other request, /replies, /runs and the record pages among
 * them, goes to the network alone, so no answer or record is ever kept on the device. No push notifications.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The page background in each theme, which is also the colour of the bar an installed app sits under. */
export const THEME = { light: "#fbfaf8", dark: "#151514" } as const;

const ICON_TYPES: Record<string, string> = {
  "icon.svg": "image/svg+xml",
  "icon-192.png": "image/png",
  "icon-512.png": "image/png",
  "maskable-512.png": "image/png",
  "apple-touch-icon.png": "image/png",
};

/** What the worker caches on install, and the only paths it ever answers from its cache. */
export const APP_SHELL = ["/", "/manifest.webmanifest", ...Object.keys(ICON_TYPES).map((name) => `/icons/${name}`)];

/** Every page links these. The lab's name rides in the manifest, so the head is the same for every lab. */
export const APP_HEAD = `<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="Aliquot">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME.light}">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${THEME.dark}">`;

/** The home screen label is "Aliquot"; the lab's name follows it wherever the full name shows. */
export function appManifest(where: string): object {
  return {
    id: "/",
    name: where ? `Aliquot · ${where}` : "Aliquot",
    short_name: "Aliquot",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: THEME.light,
    theme_color: THEME.light,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

export const SERVICE_WORKER = `const CACHE = "aliquot-shell-1";
const SHELL = ${JSON.stringify(APP_SHELL)};
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const path = url.pathname === "/chat" ? "/" : url.pathname;
  if (e.request.method !== "GET" || url.origin !== self.location.origin || !SHELL.includes(path)) return;
  // Network first, so a door that answers always serves its current page; the cache answers only when it does not.
  e.respondWith(fetch(e.request).then(
    (res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(path, copy)); } return res; },
    () => caches.match(path).then((hit) => hit || Response.error()),
  ));
});
`;

/** A path, not new URL(..., import.meta.url), for the reason db.ts gives: the studio's bundler rewrites that form. */
const assets = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");
const icons = new Map<string, Buffer>();

/** An icon by file name, read once; null for a name that is not one. */
export function appIcon(name: string): { type: string; body: Buffer } | null {
  if (!Object.hasOwn(ICON_TYPES, name)) return null;
  const type = ICON_TYPES[name]!;
  let body = icons.get(name);
  if (!body) icons.set(name, (body = readFileSync(join(assets, name))));
  return { type, body };
}
