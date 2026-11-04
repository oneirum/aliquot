/**
 * The member chat page: a sidebar with this conversation's questions by day, a reading column of dated entries, and a
 * composer pinned to the bottom. Under each answer sit its source and its record. Check reads the run's events
 * (/runs/:id/events) and the door's own recomputation of the chain (/runs/:id/view, verifyChain in record.ts), steps
 * the record's hash through each event it checked up to that verdict, then shows the verdict, so what the page shows is
 * the door's check and the hashes it checked.
 *
 * Static HTML with inline CSS and script, like the other pages: it reads only the JSON routes in web.ts, and imports
 * the motion library the door serves at /vendor/motion.js.
 */

import { APP_HEAD } from "./web-app.ts";
import { BASE_CSS, whereSpan } from "./web-pages.ts";

const icon = (paths: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;
const SIDEBAR = icon('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 3v10" stroke="currentColor" stroke-width="1.5"/>');
const NEW = icon('<path d="M13.25 8.75v2.5a2 2 0 0 1-2 2h-6.5a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2h2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11.5 2.5a1.41 1.41 0 0 1 2 2L8.25 9.75 6 10.25l.5-2.25z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>');
const RUNS = icon('<path d="M6 4.25h7.25M6 8h7.25M6 11.75h7.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="3" cy="4.25" r="1" fill="currentColor"/><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="3" cy="11.75" r="1" fill="currentColor"/>');
const REFUSED = icon('<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 12l8-8" stroke="currentColor" stroke-width="1.5"/>');
const FAILED = icon('<path d="M8 2.25l6 10.5H2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5v2.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.1" r=".85" fill="currentColor"/>');
const CLOSE = icon('<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>');
const SEND = icon('<path d="M8 13V3.5M3.75 7.5L8 3.25l4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>');

export function chatPage(where = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Ask the lab · Aliquot</title>
${APP_HEAD}
<style>${BASE_CSS}
:root { --field: var(--surface); --field-line: var(--line); --field-focus: rgb(28 27 25 / 0.22); --edge: rgb(28 27 25 / 0.16); --accent: var(--ink); --accent-ink: var(--bg); --held: #00664a; --broken: #b34700; }
@media (prefers-color-scheme: dark) { :root { --field: #252523; --field-line: transparent; --field-focus: rgb(236 235 230 / 0.16); --edge: rgb(236 235 230 / 0.2); --held: #5ee0b0; --broken: #ff8a4c; } }
html { scroll-padding: 64px 0 120px; }
body { min-height: 100dvh; }
svg { display: block; }
.icon { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border: 0; border-radius: 8px; background: none; color: var(--ink-2); cursor: pointer; transition: transform 160ms var(--ease-out), background-color 160ms ease; }
.icon svg { width: 16px; height: 16px; }
.icon:active { transform: scale(0.96); }
@media (hover: hover) and (pointer: fine) { .icon:hover { background: var(--hover); color: var(--ink); } }

.side { position: fixed; inset: 0 auto 0 0; z-index: 3; width: 260px; display: flex; flex-direction: column; background: var(--side); border-right: 1px solid var(--line); }
.side-top { height: 52px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 16px; }
/* The wordmark and the lab name share one line: both bars are 52 px, both names 16/24 at 500, so their baselines meet. */
.side-top .wordmark { font-size: 16px; line-height: 24px; font-weight: 500; letter-spacing: 0; }
.side-top .close { display: none; }
.side-nav { display: grid; padding: 0 8px; }
.row { display: flex; align-items: center; gap: 8px; width: 100%; height: 36px; padding: 0 8px; border: 0; border-radius: 8px; background: none; color: var(--ink); font: 14px/20px var(--sans); text-align: left; text-decoration: none; cursor: pointer; }
.row svg { width: 16px; height: 16px; flex: none; color: var(--ink-2); }
.row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (hover: hover) and (pointer: fine) { .row:hover { background: var(--hover); } }
.history { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 0 8px 16px; }
.side .label { margin: 24px 0 8px; padding: 0 8px; font-size: 13px; line-height: 20px; color: var(--muted); }
.history .row { color: var(--ink-2); }
.me { flex: none; display: flex; align-items: center; gap: 8px; height: calc(64px + env(safe-area-inset-bottom)); padding: 0 16px env(safe-area-inset-bottom); font-size: 14px; line-height: 20px; }
.me > span:last-child { display: grid; min-width: 0; }
.me .where { font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.avatar { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 50%; background: var(--accent); color: var(--accent-ink); font-size: 13px; font-weight: 500; }
.scrim { display: none; }

.pane { min-height: 100dvh; display: flex; flex-direction: column; padding-left: 260px; }
body[data-side="closed"] .side { display: none; }
body[data-side="closed"] .pane { padding-left: 0; }
/* 6 px of padding puts the toggle's icon 16 px from the pane's edge, the inset of the sidebar's own rows. */
.bar { position: sticky; top: 0; z-index: 2; height: 52px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 6px; }
/* The bar is a material the thread passes under: the page colour, translucent and blurred, running 16 px past the
   bar's edge and fading out there, so text softens as it goes under instead of meeting a ruled line. */
.bar::before { content: ""; position: absolute; inset: 0 0 -16px; z-index: -1; background: color-mix(in srgb, var(--bg) 80%, transparent); -webkit-backdrop-filter: blur(16px) saturate(180%); backdrop-filter: blur(16px) saturate(180%); mask-image: linear-gradient(#000 calc(100% - 16px), transparent); pointer-events: none; }
@media (prefers-reduced-transparency: reduce) { .bar::before { background: var(--bg); -webkit-backdrop-filter: none; backdrop-filter: none; } }
.bar .title { flex: 1; min-width: 0; margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.intro { display: contents; }
.intro[hidden] { display: none; }
/* Empty state: the title, the suggestions and the composer are one group at the bottom, with the open space above. */
.pane:has(.intro:not([hidden]))::before { content: ""; flex: 1 1 0; order: 1; }
.intro h1 { order: 2; align-self: center; width: min(720px, 100% - 48px); margin: 0 0 32px; font-size: 28px; line-height: 36px; font-weight: 500; letter-spacing: -0.015em; text-align: center; }
.pane:has(.intro:not([hidden])) .compose { padding-top: 0; background: none; }
.tries { order: 4; align-self: center; width: min(720px, 100% - 48px); list-style: none; margin: 0 0 16px; padding: 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.tries:empty { display: none; }
.try { min-height: 40px; padding: 9px 16px; border: 1px solid var(--line); border-radius: 20px; background: none; color: var(--ink); font: 15px/20px var(--sans); cursor: pointer; transition: transform 160ms var(--ease-out), background-color 160ms ease; }
.try:active { transform: scale(0.97); }
@media (hover: hover) and (pointer: fine) { .try:hover { background: var(--hover); } }
/* A footnote on the rows' 16 px inset; the member row's avatar sits 16 px inside it, so the note ends 16 px above the chip. */
.install { flex: none; margin: 0; padding: 0 16px; font-size: 13px; line-height: 20px; color: var(--muted); text-wrap: pretty; }
@media (display-mode: standalone) { .install { display: none; } }

#thread { order: 7; flex: 1; width: 100%; max-width: 768px; margin: 0 auto; padding: 24px 24px 32px; text-wrap: pretty; }
#thread:empty { display: none; }
.day { margin: 0 0 24px; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--muted); }
.entry { margin: 0 0 48px; transition: opacity 200ms var(--ease-out); }
.entry:last-child { margin-bottom: 0; }
@starting-style { .entry { opacity: 0; } }
.restoring .entry { transition: none; }
.meta { display: flex; gap: 8px; margin: 0 0 8px; font-size: 13px; line-height: 20px; color: var(--muted); font-variant-numeric: tabular-nums; }
.meta > * + *::before { content: "\\00b7"; margin-right: 8px; }
.q { margin: 0 0 16px; font-size: 18px; line-height: 26px; font-weight: 500; white-space: pre-wrap; overflow-wrap: anywhere; text-wrap: pretty; }
.a { font-size: 16px; line-height: 26px; overflow-wrap: anywhere; text-wrap: pretty; }
.a, .refusal, .cite, .witness, .withheld { transition: opacity 200ms var(--ease-out); }
@starting-style { .a, .refusal, .cite, .witness, .withheld { opacity: 0; } }
.a > * { margin: 0 0 16px; }
.a > :last-child { margin-bottom: 0; }
.a p { white-space: pre-line; }
.a ul, .a ol { padding-left: 24px; }
.a li { margin: 0 0 8px; }
.a li:last-child { margin-bottom: 0; }
.a li::marker { color: var(--muted); font-variant-numeric: tabular-nums; }
.a .h { font-weight: 500; margin-top: 24px; }
.a > .h:first-child { margin-top: 0; }
.a pre { font: 13px/20px var(--mono); background: var(--quiet); border-radius: 8px; padding: 12px 16px; overflow-x: auto; white-space: pre; }
.a strong { font-weight: 500; }
.a code { font: 14px var(--mono); background: var(--quiet); padding: 2px 4px; border-radius: 4px; }
.steps { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; font-size: 16px; line-height: 26px; color: var(--muted); font-variant-numeric: tabular-nums; }
.steps > * + *::before { content: "\\00b7"; margin-right: 8px; }
.err { margin: 0; color: var(--ink-2); }
.withheld { margin: 16px 0 0; font-size: 13px; line-height: 20px; color: var(--muted); }
.refusal { margin: 0; }
.refusal .title { display: flex; gap: 8px; align-items: center; margin: 0 0 8px; font-weight: 500; }
.refusal .title svg { width: 16px; height: 16px; flex: none; }
.refusal p { margin: 0; line-height: 26px; }
.refusal p:last-child { color: var(--ink-2); }

.margin { display: grid; gap: 16px; margin-top: 24px; }
.margin:empty { display: none; }
.margin p { margin: 0; }
.cite { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 13px; line-height: 20px; color: var(--muted); }
.doc { color: var(--ink-2); font-weight: 500; overflow-wrap: anywhere; }
/* Two 32 px rows: the status and Check, then the hash and Open record. 6 px above and below each 20 px line centres it
   on Check's pill, so the rows step 32 px baseline to baseline; a status that wraps grows downward with Check on its
   first line. */
.witness { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 16px; font-size: 13px; line-height: 20px; }
.status { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; color: var(--ink-2); }
.glyph { display: grid; place-items: center; flex: none; width: 16px; height: 20px; color: var(--muted); }
.glyph svg { grid-area: 1 / 1; width: 16px; height: 16px; }
.glyph .ghost { color: var(--muted); }
[data-chain="verified"] .status, [data-chain="verified"] .glyph { color: var(--held); font-weight: 500; }
[data-chain="broken"] .status, [data-chain="broken"] .glyph { color: var(--broken); font-weight: 500; }
.trail { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 0 16px; min-height: 32px; }
.seal code { display: inline-block; font: 13px/20px var(--mono); color: var(--muted); }
/* Check is the block's one control: a pill, 32 px tall with a 44 px touch target. Open record is quiet text with an
   arrow, in the second ink, going full ink on hover; its touch target is 44 px tall too. */
button.verify { position: relative; align-self: start; display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border: 1px solid var(--edge); border-radius: 16px; background: none; color: var(--ink); font: 500 13px/20px var(--sans); cursor: pointer; transition: transform 160ms var(--ease-out), background-color 160ms ease; }
button.verify::after { content: ""; position: absolute; inset: -7px -1px; }
button.verify:active { transform: scale(0.97); }
button.verify:disabled { cursor: default; color: var(--muted); transform: none; }
.trail a { position: relative; display: inline-flex; align-items: center; gap: 4px; color: var(--ink-2); text-decoration: none; transition: color 160ms ease; }
.trail a svg { width: 12px; height: 12px; flex: none; }
.trail a::after { content: ""; position: absolute; inset: -12px -8px; }
@media (hover: hover) and (pointer: fine) { button.verify:not(:disabled):hover { background: var(--hover); } .trail a:hover { color: var(--ink); } }

.compose { order: 8; position: sticky; bottom: 0; z-index: 1; padding: 24px 24px calc(32px + env(safe-area-inset-bottom)); background: linear-gradient(transparent, var(--bg) 24px); }
.box { display: flex; align-items: flex-end; gap: 8px; max-width: 720px; margin: 0 auto; padding: 9px 11px; border: 1px solid var(--field-line); border-radius: 24px; background: var(--field); box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px rgb(0 0 0 / 0.04); transition: border-color 160ms ease; }
.box:focus-within { border-color: var(--field-focus); }
textarea { flex: 1; min-width: 0; max-height: 192px; resize: none; border: 0; outline: 0; padding: 6px 0; background: transparent; color: var(--ink); font: 16px/24px var(--sans); }
textarea::placeholder { color: var(--muted); }
textarea:focus-visible { outline: none; }
button.send { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border: 0; border-radius: 50%; background: var(--ink); color: var(--bg); cursor: pointer; transition: transform 160ms var(--ease-out), background-color 160ms ease, color 160ms ease; }
button.send svg { width: 18px; height: 18px; }
button.send:active { transform: scale(0.94); }
button.send:disabled { cursor: default; transform: none; }

@media (max-width: 899px) {
  html { scroll-padding: 72px 0 112px; }
  .side { width: 288px; border-right: 0; transform: translateX(-100%); transition: transform 280ms var(--ease-drawer); }
  body[data-side="closed"] .side { display: flex; }
  body[data-side="open"] .side { transform: none; box-shadow: 0 0 32px rgb(0 0 0 / 0.16); }
  .side-top { height: 56px; }
  .side-top .close { display: grid; width: 44px; height: 44px; }
  .side { z-index: 5; overscroll-behavior: contain; }
  .scrim { display: block; position: fixed; inset: 0; z-index: 4; background: rgb(0 0 0 / 0.32); opacity: 0; pointer-events: none; transition: opacity 200ms ease; }
  body[data-side="open"] .scrim { opacity: 1; pointer-events: auto; }
  .pane { padding-left: 0; }
  /* A 44 px drawer button with no fill; 2 px of bar padding puts its icon's stroke on the thread's 16 px gutter. */
  .bar { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; height: 56px; padding: 0 2px; }
  .bar .icon { width: 44px; height: 44px; border-radius: 50%; color: var(--ink); }
  .bar .icon:active { background: var(--hover); }
  .bar .icon svg { width: 18px; height: 18px; }
  .bar .title { font-size: 17px; line-height: 24px; text-align: center; }
  .intro h1 { font-size: 24px; line-height: 32px; }
  .intro h1, .tries { width: calc(100% - 32px); }
  #thread { padding: 16px 16px 24px; }
  .compose { padding: 16px 12px calc(16px + env(safe-area-inset-bottom)); }
}
@media (prefers-reduced-motion: reduce) {
  .side { transition: none; }
  .icon, .try, .row, button.verify, .trail a, button.send { transition: none; }
}
</style>
</head>
<body>
<aside class="side" id="side" aria-label="Conversation">
  <div class="side-top"><a class="wordmark" href="/">Aliquot</a><button type="button" class="icon close" id="close" aria-label="Close sidebar">${CLOSE}</button></div>
  <nav class="side-nav">
    <button type="button" class="row fresh" id="fresh">${NEW}<span>New question</span></button>
  </nav>
  <nav class="side-nav" aria-labelledby="records">
    <p class="label" id="records">Records</p>
    <a class="row" href="/runs">${RUNS}<span>All runs</span></a>
    <a class="row" href="/runs?show=refusals">${REFUSED}<span>Refusals</span></a>
    <a class="row" href="/runs?show=failed">${FAILED}<span>Failed runs</span></a>
  </nav>
  <ol class="history" id="history"></ol>
  <p class="install" id="install">To open Aliquot like an app, choose Add to Home Screen or Install in the browser menu.</p>
  <div class="me"><span class="avatar" id="initial" aria-hidden="true"></span><span><span id="who"></span>${whereSpan(where)}</span></div>
</aside>
<div class="scrim" id="scrim"></div>
<div class="pane">
  <div class="bar">
    <button type="button" class="icon" id="toggle" aria-controls="side" aria-expanded="false" aria-label="Sidebar">${SIDEBAR}</button>
    <p class="title">${whereSpan(where)}</p>
  </div>
  <section class="intro" id="intro">
    <h1>Ask the lab</h1>
    <ul class="tries" id="tries"></ul>
  </section>
  <main id="thread" aria-live="polite"></main>
  <form id="ask" class="compose">
    <div class="box">
      <textarea id="text" rows="1" placeholder="Ask a question about the lab" aria-label="Your question"></textarea>
      <button class="send" id="send" type="submit" aria-label="Ask" disabled>${SEND}</button>
    </div>
  </form>
</div>
<script type="module">
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const user = params.get("user") || "member-1";
const channel = params.get("channel") || undefined;
// The thread lives in this tab's sessionStorage, so a reload or a visit to a record and back keeps it.
const KEY = "aliquot.thread." + (channel || "") + "." + user;
const blank = () => ({ v: 1, thread: "web-" + crypto.randomUUID(), n: 0, turns: [] });
let state = (() => { try { const s = JSON.parse(sessionStorage.getItem(KEY) || "null"); return s && s.v === 1 && Array.isArray(s.turns) ? s : blank(); } catch { return blank(); } })();
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
// Loaded once, off the critical path; if it fails to load, a check still shows its verdict, without movement.
const motion = import("/vendor/motion.js").catch(() => null);

const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
const svg = (paths) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("aria-hidden", "true"); s.innerHTML = paths; return s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayName = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const hex = (h) => h.slice(0, 16).replace(/(.{4})(?!$)/g, "$1 ");

$("who").textContent = user;
$("initial").textContent = user.slice(0, 1).toUpperCase();

// The sidebar sits beside the thread on a wide screen, where the toggle hides it and the choice is remembered, and
// slides over it as a drawer on a phone, where it starts closed.
const wide = matchMedia("(min-width: 900px)");
const SIDE = "aliquot.sidebar";
const setSide = (open, focus) => {
  document.body.dataset.side = open ? "open" : "closed";
  $("toggle").setAttribute("aria-expanded", String(open));
  $("side").inert = !open;
  document.querySelector(".pane").inert = open && !wide.matches;
  if (wide.matches) { try { localStorage.setItem(SIDE, open ? "open" : "closed"); } catch {} }
  else if (focus) (open ? $("close") : $("toggle")).focus();
};
const sideStart = () => { let kept = null; try { kept = localStorage.getItem(SIDE); } catch {} setSide(wide.matches && kept !== "closed", false); };
sideStart();
wide.addEventListener("change", sideStart);
$("toggle").addEventListener("click", () => setSide(document.body.dataset.side !== "open", true));
$("close").addEventListener("click", () => setSide(false, true));
$("scrim").addEventListener("click", () => setSide(false, true));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !wide.matches && document.body.dataset.side === "open") setSide(false, true); });
$("history").addEventListener("click", (e) => { if (e.target.closest("a") && !wide.matches) setSide(false, false); });

for (const q of (params.get("try") || "").split("|").filter(Boolean)) {
  const b = el("button", "try");
  b.type = "button";
  b.textContent = q;
  b.onclick = () => { $("text").value = q; sync(); $("ask").requestSubmit(); };
  const li = el("li"); li.append(b); $("tries").append(li);
}

// Safari keeps Add to Home Screen behind Share; iPadOS reports itself as a Mac with a touch screen.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) $("install").textContent = "To open Aliquot from your Home Screen, tap Share, then Add to Home Screen.";
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

const sync = () => {
  const t = $("text");
  t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 192) + "px";
  $("send").disabled = !t.value.trim();
};
$("text").addEventListener("input", sync);
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("ask").requestSubmit(); } });

// Models answer in Markdown. Paragraphs, lists, headings and code blocks become elements, and so do bold,
// italic and inline code; every piece of text goes in as text, so nothing is parsed as HTML.
function inline(parent, text) {
  for (const part of text.split(/(\\*\\*[^*\\n]+\\*\\*|\\*[^*\\s][^*\\n]*\\*|\`[^\`\\n]+\`)/)) {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) parent.append(el("strong", "", part.slice(2, -2)));
    else if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) parent.append(el("em", "", part.slice(1, -1)));
    else if (part.length > 2 && part.startsWith("\`") && part.endsWith("\`")) parent.append(el("code", "", part.slice(1, -1)));
    else if (part) parent.append(part);
  }
  return parent;
}
function answer(text) {
  const a = el("div", "a");
  const lines = text.replace(/\\r\\n/g, "\\n").split("\\n");
  let para = [], list = null;
  const flush = () => { if (para.length) a.append(inline(el("p"), para.join("\\n"))); para = []; list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\\s*\`\`\`/.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^\\s*\`\`\`/.test(lines[i])) code.push(lines[i]);
      a.append(el("pre", "", code.join("\\n")));
      continue;
    }
    const h = /^\\s*#{1,6}\\s+(.*)$/.exec(line);
    const li = /^\\s*(?:([-*•])|(\\d+)[.)])\\s+(.*)$/.exec(line);
    if (h) { flush(); a.append(inline(el("div", "h"), h[1])); }
    else if (li) {
      if (para.length) { a.append(inline(el("p"), para.join("\\n"))); para = []; }
      const tag = li[1] ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) { list = el(tag); if (li[2] && li[2] !== "1") list.start = Number(li[2]); a.append(list); }
      list.append(inline(el("li"), li[3]));
    }
    else if (!line.trim()) { if (para.length) flush(); }
    else if (list && /^\\s{2,}\\S/.test(line)) list.lastChild.append(" " + line.trim());
    else { list = null; para.push(line); }
  }
  flush();
  return a;
}
const REFUSAL = {
  "class-above-ceiling": (r) => "This message is " + r.payload + ", and this agent's model may receive at most " + r.ceiling + ".",
  "destination-receives-nothing": (r) => "This destination may not hold " + r.payload + " data at all.",
  "review-confidential-refused": () => "Review-confidential content is refused by lab policy.",
  "review-confidential-needs-lab": () => "Review-confidential content may only go to models on lab hardware.",
  "host-not-declared": (r) => "Host " + r.host + " is not in the tool's egress list.",
  "covered-model": (r) => r.modelId + " is kept by its vendor on every route, so it may not run on a " + r.placement + " endpoint.",
};
const NOT_SENT = '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.6 12.4l8.8-8.8" stroke="currentColor" stroke-width="1.5"/>';
function refusal(title, text) {
  const b = el("div", "refusal"); b.setAttribute("role", "status");
  const t = el("p", "title"); t.append(svg(NOT_SENT), title);
  b.append(t, el("p", "", text));
  return b;
}

// The document the answer names on its Source line.
function cite(source) {
  if (!source) return null;
  const c = el("p", "cite");
  c.append(el("span", "k", "Source"), el("span", "doc", source));
  return c;
}

// The record: its state in a word and a shape with Check beside it, then the record's hash and the link to the full
// record.
const OPEN = '<path d="M3.25 8h9.5M9 4.25L12.75 8 9 11.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
const SEALS = {
  unverified: '<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2.3"/>',
  verified: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.9 8.2l2.1 2.1 4.1-4.4" fill="none" style="stroke: var(--bg)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  broken: '<rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" style="stroke: var(--bg)" stroke-width="1.6" stroke-linecap="round"/>',
};
SEALS.checking = SEALS.unverified;
function mark(w, chain, text, hash) {
  w.dataset.chain = chain;
  const glyph = el("span", "glyph"); glyph.append(svg(SEALS[chain]));
  w.querySelector(".status").replaceChildren(glyph, el("span", "words", text));
  w.querySelector(".seal code").textContent = hex(hash);
}
function witness(runId, events) {
  const w = el("div", "witness");
  const status = el("p", "status"); status.setAttribute("role", "status");
  const verify = el("button", "verify", "Check"); verify.type = "button";
  const seal = el("p", "seal"); seal.append(el("code"));
  const open = el("a", "", "Open record"); open.href = "/runs/" + runId; open.append(svg(OPEN));
  const trail = el("div", "trail"); trail.append(seal, open);
  w.append(status, verify, trail);
  // What this page saw when the run finished. verifyChain cannot see events cut from the end, so a record that later
  // ends sooner, or on another hash, reads as changed.
  const seen = { n: events.length, head: events.at(-1).hash };
  mark(w, "unverified", "Not checked", seen.head);
  verify.onclick = () => check(w, runId, verify, seen);
  return w;
}

// The check moment, the page's one motion with character: the hash steps through each event the door checked, then
// the verdict settles in one beat, the glyph filling its dashed ring, the hash landing, the words fading in. A spring
// with no bounce, transform, opacity and clip-path only. Reduced motion skips the steps and shows the verdict at once.
const STEP = [0.23, 1, 0.32, 1];
const SETTLE = { type: "spring", bounce: 0, duration: 0.35 };
const landHash = (m, code, options) => m.animate(code, { transform: ["translateY(4px)", "translateY(0px)"], opacity: [0.4, 1] }, options);
function settle(m, w) {
  const glyph = w.querySelector(".glyph svg"), ghost = svg(SEALS.unverified);
  ghost.setAttribute("class", "ghost");
  glyph.after(ghost);
  // 60% of the glyph's 16 px box is just past the square's corners, so the fill lasts the whole spring.
  m.animate(glyph, { clipPath: ["circle(0% at 50% 50%)", "circle(60% at 50% 50%)"], transform: ["scale(0.85)", "scale(1)"] }, SETTLE);
  m.animate(ghost, { opacity: [1, 0] }, { duration: 0.2, ease: STEP }).finished.then(() => ghost.remove(), () => ghost.remove());
  m.animate(w.querySelector(".words"), { opacity: [0, 1] }, { duration: 0.2, ease: STEP });
  landHash(m, w.querySelector(".seal code"), SETTLE);
}

const fetchJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(url + " answered " + r.status); return r.json(); });
async function check(w, runId, verify, seen) {
  verify.disabled = true;
  w.setAttribute("aria-busy", "true");
  try {
    const [events, view, loaded] = await Promise.all([fetchJson("/runs/" + runId + "/events"), fetchJson("/runs/" + runId + "/view"), motion]);
    const m = reduce.matches ? null : loaded;
    const n = events.length, last = events.at(-1), head = last ? last.hash : seen.head;
    const changed = view.chain.events !== n ? "The record changed while it was checked. Check again."
      : view.chain.firstBad === null && (n < seen.n || !last || last.hash !== seen.head || last.event.t !== "run.finished") ? "Changed since this page loaded: the record had " + seen.n + " events and ended on " + hex(seen.head)
      : null;
    const bad = changed ? null : view.chain.firstBad;
    const stop = bad === null ? n : bad;
    if (!reduce.matches) {
      mark(w, "checking", "Checking 0 of " + n + " events", seen.head);
      const words = w.querySelector(".words"), code = w.querySelector(".seal code");
      // About 900 ms whatever the length: one event per step down to a frame, then several per frame.
      const delay = Math.min(70, 900 / Math.max(stop, 1)), per = Math.max(1, Math.ceil(16 / delay));
      for (let i = 0; i < stop; i += per) {
        const k = Math.min(stop, i + per) - 1;
        words.textContent = "Checking " + (k + 1) + " of " + n + " events";
        code.textContent = hex(events[k].hash);
        if (m) landHash(m, code, { duration: (delay * per) / 1000, ease: STEP });
        await sleep(delay * per);
      }
    }
    if (changed) mark(w, "broken", changed, head);
    else if (bad !== null) mark(w, "broken", "Broken at #" + bad + ": an event was edited or removed", head);
    else mark(w, "verified", "Verified: chain intact over " + n + " events", head);
    if (m) settle(m, w);
  } catch {
    mark(w, "unverified", "The web door did not answer. Try again.", seen.head);
  } finally {
    w.removeAttribute("aria-busy");
    verify.disabled = false;
  }
}

let lastDay = null;
const shortDay = (iso) => {
  const d = new Date(iso), now = new Date(), yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
};
function turnOf(t, n) {
  $("intro").hidden = true;
  const at = t.at || new Date().toISOString();
  if (new Date(at).toDateString() !== lastDay) {
    lastDay = new Date(at).toDateString();
    const d = el("h2", "day"), time = el("time", "", dayName(at)); time.dateTime = at.slice(0, 10); d.append(time);
    $("thread").append(d);
    $("history").append(el("li", "label", shortDay(at)));
  }
  const link = el("a", "row"); link.href = "#e" + n; link.append(el("span", "", t.q));
  const item = el("li"); item.append(link); $("history").append(item);
  const entry = el("article", "entry"); entry.id = "e" + n;
  const head = el("p", "meta");
  const time = el("time", "", clock(at)); time.dateTime = at;
  head.append(time, el("span", "who", user));
  const body = el("div", "body");
  body.append(el("h3", "q", t.q));
  const margin = el("aside", "margin");
  entry.append(head, body, margin);
  $("thread").append(entry);
  return { entry, head, body, margin };
}
function stepsOf(turn) {
  const steps = el("p", "steps"), clockText = el("span", "", "0 s"), t0 = Date.now();
  clockText.setAttribute("aria-hidden", "true");
  steps.append(el("span", "", "Reading the lab's documents"), clockText);
  steps.timer = setInterval(() => { clockText.textContent = Math.round((Date.now() - t0) / 1000) + " s"; }, 1000);
  turn.body.append(steps);
  return steps;
}
const done = (steps, node) => { clearInterval(steps.timer); steps.replaceWith(node); };

async function ask(text) {
  const t = { q: text, at: new Date().toISOString() };
  state.turns.push(t); save();
  const turn = turnOf(t, state.turns.length), steps = stepsOf(turn);
  turn.entry.scrollIntoView({ block: "end", behavior: reduce.matches ? "auto" : "smooth" });
  const fail = (msg) => { t.error = msg; save(); done(steps, el("p", "err", msg)); };
  let body;
  try {
    const res = await fetch("/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel, thread: state.thread, message: state.thread + "-" + (state.n++), text, user }) });
    body = await res.json();
  } catch { return fail("The web door did not answer. Check that it is running, then ask again."); }
  if (body.t === "refused") { t.notice = body.userFacing; save(); done(steps, refusal("Not sent", body.userFacing)); return; }
  if (body.t !== "enqueued") return fail(body.error || "The web door did not take the question, so ask it again.");
  t.runId = body.runId; save();
  await follow(turn, steps, body.runId, true);
}

async function follow(turn, steps, runId, scroll) {
  try { await watch(turn, steps, runId, scroll); }
  catch { done(steps, el("p", "err", "Lost contact with the web door. Reload the page to pick up the answer.")); }
}
async function watch(turn, steps, runId, scroll) {
  for (let i = 0; i < 600; i++) {
    const events = await fetchJson("/runs/" + runId + "/events");
    const finished = events.find((e) => e.event.t === "run.finished");
    if (finished) {
      const started = events.find((e) => e.event.t === "run.started");
      if (started) turn.head.lastChild.textContent = started.event.trigger.memberId || user;
      const replies = await fetchJson("/replies?runId=" + runId);
      const refused = events.find((e) => e.event.t === "egress.refused");
      const withheld = events.filter((e) => e.event.t === "tool.withheld").length;
      let source = null;
      if (refused) {
        const r = refused.event.refusal;
        const why = (REFUSAL[r.code] || (() => "The egress check refused it."))(r);
        done(steps, refusal("Refused: restricted data", why + " Nothing was sent, and the refusal is in the record."));
      } else {
        const reply = replies.find((x) => x.kind === "reply") || replies[0];
        const raw = reply ? reply.text : "(no reply)";
        const m = /\\n\\s*Source:\\s*(.+)\\s*$/.exec(raw);
        source = m ? m[1].trim() : null;
        done(steps, answer(m ? raw.slice(0, m.index) : raw));
        if (withheld) turn.body.append(el("p", "withheld", withheld + (withheld === 1 ? " tool result was" : " tool results were") + " withheld from the model"));
      }
      const c = cite(source);
      if (c) turn.margin.append(c);
      turn.margin.append(witness(runId, events));
      turn.entry.dataset.entryDone = "";
      if (scroll) turn.entry.scrollIntoView({ block: "end", behavior: reduce.matches ? "auto" : "smooth" });
      return;
    }
    await sleep(300);
  }
  done(steps, el("p", "err", "No answer after three minutes. Check that the worker is running, then reload the page."));
}

$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  $("text").value = ""; sync();
  ask(text);
});
for (const b of document.querySelectorAll(".fresh")) b.addEventListener("click", () => {
  state = blank(); save();
  lastDay = null;
  $("thread").replaceChildren();
  $("history").replaceChildren();
  $("intro").hidden = false;
  if (!wide.matches) setSide(false, false);
  $("text").focus();
});

document.documentElement.classList.add("restoring");
state.turns.forEach((t, i) => {
  const turn = turnOf(t, i + 1);
  if (t.notice) turn.body.append(refusal("Not sent", t.notice));
  else if (t.error) turn.body.append(el("p", "err", t.error));
  else if (t.runId) follow(turn, stepsOf(turn), t.runId, false);
});
save();
requestAnimationFrame(() => { document.documentElement.classList.remove("restoring"); if (state.turns.length) scrollTo(0, document.body.scrollHeight); });
$("text").focus();
</script>
</body>
</html>`;
}
