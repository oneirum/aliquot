/**
 * The member chat page, set as a lab notebook. The head names the notebook (aliquot, the lab) and the state of its
 * chain; the index lists the entries by number and day, with the records under them; the spine down the left edge is
 * the same index as a graduated scale you can scrub; each entry is a dated, numbered question and answer; and the
 * composer at the bottom shows the number of the entry it will become.
 *
 * Under each answer sit its source and its record. The record is drawn as a short graduated scale, one tick per event,
 * with the record's hash beside it, and the scale is what you press to check the chain. The check reads the run's
 * events (/runs/:id/events) and the door's own recomputation of the chain (/runs/:id/view, verifyChain in record.ts),
 * then fills each event's tick in order up to that verdict, so what the page shows is the door's check and the hashes
 * it checked.
 *
 * Static HTML with inline CSS and one module script, like the other pages: it reads only the JSON routes in web.ts and
 * imports the motion library from the door's own /vendor/ path.
 */

import { APP_HEAD } from "./web-app.ts";
import { BASE_CSS, whereSpan } from "./web-pages.ts";

const icon = (paths: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;
const INDEX = icon('<path d="M2 3.5h12M2 6.5h6M2 9.5h6M2 12.5h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>');
const NEW = icon('<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>');
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
<link rel="modulepreload" href="/vendor/motion.js">
<style>${BASE_CSS}
:root {
  --field: var(--surface); --field-line: var(--line); --field-focus: rgb(28 27 25 / 0.24); --accent: var(--ink); --accent-ink: var(--bg);
  --held: #00664a; --held-fill: #009e73; --broken: #b34700; --tick: rgb(28 27 25 / 0.4); --grad: rgb(28 27 25 / 0.16);
  --pl: 260px;
}
@media (prefers-color-scheme: dark) {
  :root { --field: #1f1f1d; --field-line: #2c2b28; --field-focus: rgb(236 235 230 / 0.22); --held: #5ee0b0; --held-fill: #5ee0b0; --broken: #ff8a4c; --tick: rgb(236 235 230 / 0.42); --grad: rgb(236 235 230 / 0.16); }
}
html { scroll-padding: 64px 0 120px; }
body { min-height: 100dvh; }
body[data-side="closed"] { --pl: 0px; }
svg { display: block; }
.wordmark { font-weight: 500; letter-spacing: -0.01em; }
.icon { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border: 0; border-radius: 8px; background: none; color: var(--ink-2); cursor: pointer; transition: transform 160ms var(--ease-out), background-color 160ms ease; }
.icon svg { width: 16px; height: 16px; }
.icon:active { transform: scale(0.97); }
@media (hover: hover) and (pointer: fine) { .icon:hover { background: var(--hover); color: var(--ink); } }

.side { position: fixed; inset: 0 auto 0 0; z-index: 3; width: 260px; display: flex; flex-direction: column; background: var(--side); border-right: 1px solid var(--line); }
.side-top { height: 52px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 16px; }
.side-top .close { display: none; }
.side-nav { display: grid; padding: 0 8px; }
.row { display: flex; align-items: center; gap: 8px; width: 100%; height: 36px; padding: 0 8px; border: 0; border-radius: 8px; background: none; color: var(--ink); font: 14px/20px var(--sans); text-align: left; text-decoration: none; cursor: pointer; }
.row svg { width: 16px; height: 16px; flex: none; color: var(--ink-2); }
.row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (hover: hover) and (pointer: fine) { .row:hover { background: var(--hover); } }
.index { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 16px; }
.index .side-nav { padding: 0; }
.history { list-style: none; margin: 0; padding: 0; }
.side .label { margin: 24px 0 8px; padding: 0 8px; font-size: 13px; line-height: 20px; color: var(--muted); }
.history .row, .records .row { color: var(--ink-2); }
.history .row[aria-current] { background: var(--hover); color: var(--ink); }
.history .row .n { flex: none; min-width: 16px; color: var(--muted); font-variant-numeric: tabular-nums; }
.history .row svg { width: 12px; height: 12px; margin: 0 2px; color: var(--muted); }
.history [data-state="verified"] svg { color: var(--held); }
.history [data-state="broken"] svg { color: var(--broken); }
.me { flex: none; display: flex; align-items: center; gap: 8px; height: calc(64px + env(safe-area-inset-bottom)); padding: 0 16px env(safe-area-inset-bottom); border-top: 1px solid var(--line); font-size: 14px; line-height: 20px; }
.me > span:last-child { display: grid; min-width: 0; }
.me .where { font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.avatar { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 50%; box-shadow: inset 0 0 0 1px var(--line); color: var(--ink-2); font-size: 13px; font-weight: 500; }
.scrim { display: none; }

.pane { min-height: 100dvh; display: flex; flex-direction: column; padding-left: 260px; }
body[data-side="closed"] .side { display: none; }
body[data-side="closed"] .pane { padding-left: 0; }
.bar { position: sticky; top: 0; z-index: 2; height: 52px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 16px 0 8px; background: var(--bg); }
.bar[data-edge] { box-shadow: 0 1px 0 var(--line); }
.head { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; margin: 0; white-space: nowrap; }
.head .brand { flex: none; font-size: 16px; line-height: 24px; font-weight: 500; letter-spacing: -0.01em; }
.head .where { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 14px; line-height: 20px; color: var(--muted); }
.head .brand + .where::before { content: ""; display: inline-block; width: 1px; height: 12px; margin-right: 8px; background: var(--line); vertical-align: -1px; }
.state { flex: none; display: inline-flex; align-items: center; gap: 8px; margin-left: auto; padding-left: 8px; font-size: 13px; line-height: 20px; color: var(--muted); font-variant-numeric: tabular-nums; }
.state:empty { display: none; }
.state svg { width: 12px; height: 12px; flex: none; }
.state[data-state="verified"] { color: var(--held); }
.state[data-state="broken"] { color: var(--broken); }
@media (min-width: 900px) { body[data-side="open"] .head .brand { display: none; } body[data-side="open"] .head .where::before { content: none; } }

.spine { position: fixed; z-index: 1; top: 52px; bottom: 104px; left: max(calc(var(--pl) + 8px), calc(var(--pl) + (100% - var(--pl) - 720px) / 2 - 56px)); width: 48px; overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; cursor: pointer; }
.spine[data-drag] { cursor: ns-resize; }
.rail { position: absolute; inset: 0; }
.grads { position: absolute; top: 0; bottom: 0; left: 16px; width: 4px; background: repeating-linear-gradient(var(--grad) 0 1px, transparent 1px 8px); -webkit-mask-image: linear-gradient(transparent, #000 16px, #000 calc(100% - 96px), transparent); mask-image: linear-gradient(transparent, #000 16px, #000 calc(100% - 96px), transparent); }
.grads.major { width: 8px; background: repeating-linear-gradient(var(--grad) 0 1px, transparent 1px var(--pitch, 40px)); background-position: 0 24px; }
.pane:has(.intro:not([hidden])) .spine { bottom: 50%; }
.mark { position: absolute; left: 0; width: 48px; height: 24px; margin-top: -12px; display: flex; align-items: center; padding-left: 16px; color: var(--muted); font: 500 12px/16px var(--sans); font-variant-numeric: tabular-nums; text-decoration: none; }
.mark i { flex: none; width: 12px; height: 4px; margin-right: 4px; border-radius: 2px; box-shadow: inset 0 0 0 1px var(--tick); background: var(--bg); transform-origin: left center; transition: transform 200ms var(--ease-out); }
.mark[data-state="verified"] i { box-shadow: none; background: var(--held-fill); }
.mark[data-state="broken"] i { box-shadow: none; background: linear-gradient(90deg, var(--broken) 0 4px, transparent 4px 6px, var(--broken) 6px); }
.mark[data-state="pending"] i, .mark[data-state="none"] i { box-shadow: none; background: var(--tick); }
.mark.blank i { height: 1px; width: 8px; margin-right: 8px; box-shadow: none; background: var(--tick); }
.mark.on { color: var(--ink); }
.spine[data-tight] .mark:not(.fifth) span { display: none; }
.level { position: absolute; top: 0; left: 6px; width: 6px; height: 8px; margin-top: -4px; background: var(--ink); clip-path: polygon(0 0, 100% 50%, 0 100%); }
.spine:not([data-count]) .level { display: none; }
@media (min-width: 900px) and (max-width: 1099px) { body[data-side="open"] .spine { display: none; } }

.intro { display: contents; }
.intro[hidden] { display: none; }
.pane:has(.intro:not([hidden]))::before, .pane:has(.intro:not([hidden]))::after { content: ""; flex: 1 1 0; }
.pane:has(.intro:not([hidden]))::before { order: 1; }
.pane:has(.intro:not([hidden]))::after { order: 3; }
.intro h1 { order: 2; align-self: center; width: min(720px, 100% - 48px); margin: 0; font-size: 28px; line-height: 36px; font-weight: 500; letter-spacing: -0.015em; text-align: center; }
.pane:has(.intro:not([hidden])) .compose { order: 5; position: static; padding-top: 0; padding-bottom: calc(8px + env(safe-area-inset-bottom)); background: none; }
.tries { order: 4; align-self: center; width: min(720px, 100% - 48px); list-style: none; margin: 0 0 16px; padding: 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.tries:empty { display: none; }
.try { min-height: 40px; padding: 9px 16px; border: 1px solid var(--line); border-radius: 20px; background: none; color: var(--ink); font: 14px/20px var(--sans); cursor: pointer; transition: transform 160ms var(--ease-out), border-color 160ms ease; }
.try:active { transform: scale(0.97); }
@media (hover: hover) and (pointer: fine) { .try:hover { border-color: var(--muted); } }
.install { order: 6; align-self: center; width: min(720px, 100% - 48px); margin: 0; padding: 0 0 16px; font-size: 13px; line-height: 20px; color: var(--muted); text-align: center; }
@media (display-mode: standalone) { .install { display: none; } }

#thread { order: 7; flex: 1; width: 100%; max-width: 768px; margin: 0 auto; padding: 24px 24px 32px; }
#thread:empty { display: none; }
.day { margin: 0 0 24px; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--muted); }
.entry { margin: 0 0 48px; }
.entry:last-child { margin-bottom: 0; }
.meta { display: flex; gap: 8px; margin: 0 0 8px; font-size: 13px; line-height: 20px; color: var(--muted); font-variant-numeric: tabular-nums; }
.meta > * + *::before { content: "\\00b7"; margin-right: 8px; }
.meta .no { color: var(--ink); font-weight: 500; }
.q { margin: 0 0 16px; font-size: 20px; line-height: 28px; font-weight: 500; letter-spacing: -0.01em; white-space: pre-wrap; overflow-wrap: anywhere; }
.ghost { position: fixed; z-index: 2; margin: 0; pointer-events: none; transform-origin: 0 0; }
.a { font-size: 16px; line-height: 26px; overflow-wrap: anywhere; transition: opacity 240ms ease; }
@starting-style { .a, .refusal { opacity: 0; } }
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
.steps { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 0; font-size: 14px; line-height: 20px; color: var(--muted); font-variant-numeric: tabular-nums; }
.steps code { font: 13px var(--mono); color: var(--ink-2); }
.err { margin: 0; }
.facts { color: var(--muted); font-variant-numeric: tabular-nums; }
.body > .facts { margin: 16px 0 0; font-size: 13px; line-height: 20px; }
.refusal { margin: 0; transition: opacity 240ms ease; }
.refusal .title { display: flex; gap: 8px; align-items: center; margin: 0 0 4px; font-weight: 500; }
.refusal .title svg { width: 16px; height: 16px; flex: none; }
.refusal p:last-child { margin: 0; padding-left: 24px; font-size: 14px; line-height: 20px; color: var(--ink-2); }

.margin { display: grid; gap: 16px; margin-top: 24px; }
.margin:empty { display: none; }
.margin p { margin: 0; }
.cite { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 13px; line-height: 20px; color: var(--muted); }
.doc { color: var(--ink-2); font-weight: 500; overflow-wrap: anywhere; }
.cite > * + .facts::before { content: "\\00b7"; margin-right: 8px; }

.witness { display: grid; grid-template-columns: minmax(0, 1fr); row-gap: 8px; padding: 16px 0; border-top: 1px solid var(--line); border-bottom: 1px solid transparent; }
.status { display: flex; gap: 8px; align-items: center; margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; }
.status svg { width: 16px; height: 16px; flex: none; color: var(--muted); }
[data-chain="unverified"] .status, [data-chain="checking"] .status { font-weight: 400; color: var(--ink-2); }
[data-chain="verified"] .status { color: var(--held); }
[data-chain="broken"] .status { color: var(--broken); }
[data-chain="verified"] .status svg, [data-chain="broken"] .status svg { color: inherit; }
.trail { display: flex; min-width: 0; }
button.verify { position: relative; display: flex; align-items: flex-start; gap: 16px; max-width: 100%; height: 32px; margin: 0; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--ink-2); font: 500 13px/20px var(--sans); text-align: left; cursor: pointer; transform-origin: left center; transition: transform 160ms var(--ease-out); -webkit-tap-highlight-color: transparent; }
button.verify::before { content: ""; position: absolute; inset: -8px -12px; }
button.verify:active { transform: scale(0.97); }
button.verify:disabled { cursor: default; }
button.verify:focus-visible { outline-offset: 6px; }
.scale { position: relative; display: grid; min-width: 0; overflow: hidden; }
.links { display: flex; gap: calc(var(--pitch, 12px) - var(--w, 4px)); height: 20px; }
.links i { position: relative; flex: none; width: var(--w, 4px); height: 12px; border-radius: 2px; box-shadow: inset 0 0 0 1px var(--tick); transform-origin: top center; transition: opacity 160ms ease; }
.links i:nth-child(5n + 1) { height: 20px; }
.links i b { position: absolute; inset: 0; border-radius: inherit; background: var(--held-fill); clip-path: inset(100% 0 0 0); }
.links i.held { box-shadow: none; }
.links i.held b { clip-path: inset(0 0 0 0); }
.links i.broken { height: 20px; box-shadow: none; }
.links i.broken b { clip-path: inset(0 0 0 0); background: linear-gradient(var(--broken) 0 8px, transparent 8px 11px, var(--broken) 11px); }
[data-chain="broken"] .links i:not(.held):not(.broken) { opacity: 0.4; }
.ruler { position: relative; height: 12px; font: 11px/12px var(--mono); color: var(--muted); }
.ruler span { position: absolute; top: 0; }
.ruler .bad { color: var(--broken); }
.verb { flex: none; }
@media (hover: hover) and (pointer: fine) { button.verify:not(:disabled):hover .verb { color: var(--ink); } button.verify:not(:disabled):hover .links i:not(.held):not(.broken) { box-shadow: inset 0 0 0 1px var(--ink-2); } }
.acts { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin: 0; font-size: 13px; line-height: 20px; }
.seal code { font: 13px/20px var(--mono); color: var(--ink-2); font-variant-numeric: tabular-nums; }
.acts a { color: var(--ink-2); text-decoration-color: var(--tick); }
@media (hover: hover) and (pointer: fine) { .acts a:hover { color: var(--ink); text-decoration-color: currentColor; } }

.compose { order: 8; position: sticky; bottom: 0; z-index: 1; padding: 24px 24px calc(24px + env(safe-area-inset-bottom)); background: linear-gradient(transparent, var(--bg) 24px); }
.box { display: flex; align-items: flex-end; gap: 8px; max-width: 720px; margin: 0 auto; padding: 9px 9px 9px 16px; border: 1px solid var(--field-line); border-radius: 24px; background: var(--field); box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px rgb(0 0 0 / 0.04); transition: border-color 160ms ease; }
.box:focus-within { border-color: var(--field-focus); }
.next { align-self: flex-start; flex: none; padding: 6px 0; font-size: 15px; line-height: 24px; font-weight: 500; color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
textarea { flex: 1; min-width: 0; max-height: 192px; resize: none; border: 0; outline: 0; padding: 6px 0; background: transparent; color: var(--ink); font: 16px/24px var(--sans); }
textarea::placeholder { color: var(--muted); }
textarea:focus-visible { outline: none; }
button.send { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border: 0; border-radius: 50%; background: var(--ink); color: var(--bg); cursor: pointer; transition: transform 160ms var(--ease-out), opacity 160ms ease; }
button.send svg { width: 18px; height: 18px; }
button.send:active { transform: scale(0.97); }
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
  .bar { height: 56px; padding: 0 16px 0 calc(4px + env(safe-area-inset-left)); }
  .bar .icon { width: 40px; height: 40px; border-radius: 50%; color: var(--ink); }
  .bar .icon svg { width: 18px; height: 18px; }
  .head .brand { font-size: 17px; }
  .spine { top: 56px; bottom: calc(88px + env(safe-area-inset-bottom)); left: env(safe-area-inset-left); }
  .intro h1 { font-size: 24px; line-height: 32px; }
  .intro h1, .install { width: calc(100% - 32px); }
  #thread { padding: 16px 16px 24px; }
  .entry, .day { padding-left: 32px; }
  .cite .facts { flex-basis: 100%; }
  .cite > * + .facts::before { content: none; }
  .compose { padding: 16px 12px calc(16px + env(safe-area-inset-bottom)); }
  .tries { width: calc(100% - 24px); flex-direction: column; }
  .try { width: 100%; text-align: left; }
}
@media (prefers-reduced-motion: reduce) {
  .side, .icon, .try, .row, button.verify, .acts a, button.send, .mark i, .links i, .a, .refusal { transition: none; }
  .icon:active, .try:active, button.verify:active, button.send:active { transform: none; }
}
</style>
</head>
<body>
<aside class="side" id="side" aria-label="Notebook index">
  <div class="side-top"><a class="wordmark" href="/">aliquot</a><button type="button" class="icon close" id="close" aria-label="Close index">${CLOSE}</button></div>
  <nav class="side-nav" aria-label="Notebook">
    <button type="button" class="row fresh" id="fresh">${NEW}<span>New notebook</span></button>
  </nav>
  <div class="index">
    <ol class="history" id="history" aria-label="Entries"></ol>
    <nav class="side-nav records" aria-labelledby="records">
      <p class="label" id="records">Records</p>
      <a class="row" href="/runs"><span>All runs</span></a>
      <a class="row" href="/runs?show=refusals"><span>Refusals</span></a>
      <a class="row" href="/runs?show=failed"><span>Failed runs</span></a>
    </nav>
  </div>
  <div class="me"><span class="avatar" id="initial" aria-hidden="true"></span><span><span id="who"></span>${whereSpan(where)}</span></div>
</aside>
<div class="scrim" id="scrim"></div>
<div class="pane">
  <div class="bar">
    <button type="button" class="icon" id="toggle" aria-controls="side" aria-expanded="false" aria-label="Index">${INDEX}</button>
    <p class="head"><span class="brand">aliquot</span>${whereSpan(where)}<span class="state" id="state"></span></p>
  </div>
  <nav class="spine" id="spine" aria-label="Entries by number"><div class="rail" id="rail"><span class="grads" aria-hidden="true"></span><span class="grads major" aria-hidden="true"></span><div class="marks" id="marks"></div></div><span class="level" id="level" aria-hidden="true"></span></nav>
  <section class="intro" id="intro">
    <h1>Ask the lab</h1>
    <ul class="tries" id="tries"></ul>
    <p class="install" id="install">To open Aliquot like an app, choose Add to Home Screen or Install in the browser menu.</p>
  </section>
  <main id="thread" aria-live="polite"></main>
  <form id="ask" class="compose">
    <div class="box">
      <span class="next" id="next" aria-hidden="true">No. 1</span>
      <textarea id="text" rows="1" placeholder="Ask a question about the lab" aria-label="Your question"></textarea>
      <button class="send" id="send" type="submit" aria-label="Ask" disabled>${SEND}</button>
    </div>
  </form>
</div>
<script type="module">
import { animate, spring, stagger } from "/vendor/motion.js";
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
// One spring for everything that travels: critically damped, settled inside 350 ms.
const SPRING = { type: spring, duration: 0.35, bounce: 0 };
const EASE = [0.23, 1, 0.32, 1];

const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
const svg = (paths) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("aria-hidden", "true"); s.innerHTML = paths; return s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayName = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const hex = (h) => h.slice(0, 16).replace(/(.{4})(?!$)/g, "$1 ");

$("who").textContent = user;
$("initial").textContent = user.slice(0, 1).toUpperCase();

// The index sits beside the thread on a wide screen, where the toggle hides it and the choice is remembered, and
// slides over it as a drawer on a phone, where it starts closed.
const bar = document.querySelector(".bar");
const edge = () => bar.toggleAttribute("data-edge", scrollY > 0);

const wide = matchMedia("(min-width: 900px)");
const SIDE = "aliquot.sidebar";
const setSide = (open, focus) => {
  document.body.dataset.side = open ? "open" : "closed";
  $("toggle").setAttribute("aria-expanded", String(open));
  $("side").inert = !open;
  document.querySelector(".pane").inert = open && !wide.matches;
  if (wide.matches) { try { localStorage.setItem(SIDE, open ? "open" : "closed"); } catch {} }
  else if (focus) (open ? $("close") : $("toggle")).focus();
  requestAnimationFrame(drawSpine);
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

// The shapes every chain state is drawn with, beside its word: an open dashed ring before a check, a filled disc with
// a tick when the chain held, a cut square when it broke.
const SEALS = {
  unverified: '<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2.3"/>',
  checking: '<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor"/>',
  verified: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.9 8.2l2.1 2.1 4.1-4.4" fill="none" style="stroke: var(--bg)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  broken: '<rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" style="stroke: var(--bg)" stroke-width="1.6" stroke-linecap="round"/>',
  pending: '<circle cx="8" cy="8" r="2.5" fill="currentColor"/>',
  none: '<path d="M4 8h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};

// The notebook's chain state, read off the page: each entry's record says unverified, checking, verified or broken;
// an entry still waiting for its answer is pending, and one with no record (refused before a run, or failed) is none.
const entries = () => [...$("thread").querySelectorAll(".entry")];
const chainOf = (entry) => { const w = entry.querySelector(".witness"); return w ? w.dataset.chain : entry.querySelector(".steps") ? "pending" : "none"; };
function tally() {
  const states = entries().map(chainOf), n = states.length;
  const held = states.filter((s) => s === "verified").length, broken = states.filter((s) => s === "broken").length;
  const head = $("state");
  const count = n + (n === 1 ? " entry, " : " entries, ");
  const word = broken ? broken + " broken" : held === n ? (n === 1 ? "intact" : "all intact") : held ? held + " checked" : n === 1 ? "not checked yet" : "none checked yet";
  head.dataset.state = broken ? "broken" : held === n ? "verified" : "open";
  head.replaceChildren(...(n ? [...(broken || held === n ? [svg(SEALS[broken ? "broken" : "verified"])] : []), el("span", "", count + word)] : []));
  const rows = $("history").querySelectorAll("a.row");
  states.forEach((s, i) => {
    const row = rows[i];
    if (row && row.dataset.state !== s) { row.dataset.state = s; row.firstChild.replaceWith(svg(SEALS[s === "checking" ? "unverified" : s])); }
    const m = $("marks").children[i];
    if (m) m.dataset.state = s;
  });
}

// The spine: one mark per entry down the left edge, on graduations every 8 px, and an open mark for the entry the
// composer will become. A pointer shows where the reading is; drag along the spine and the entry under the finger
// scrolls into view, with the pointer pulled past the first and last marks against a rubber band.
const spine = $("spine"), rail = $("rail"), level = $("level");
const TOP = 24;
let pitch = 40, drag = null, settle = null, active = -1;
function drawSpine() {
  const n = entries().length, room = spine.clientHeight - TOP - 48;
  pitch = [40, 32, 24, 16, 8].find((p) => p * n <= room) || 8;
  spine.toggleAttribute("data-tight", pitch < 16);
  spine.style.setProperty("--pitch", pitch + "px");
  if (n) spine.dataset.count = String(n); else delete spine.dataset.count;
  const have = $("marks").children;
  while (have.length > n + 1) have[have.length - 1].remove();
  for (let i = 0; i <= n; i++) {
    let m = have[i];
    const next = i === n;
    if (!m || m.classList.contains("blank") !== next) {
      const fresh = next ? el("span", "mark blank") : el("a", "mark");
      fresh.append(el("i"), el("span", "", String(i + 1)));
      if (!next) { fresh.href = "#e" + (i + 1); fresh.setAttribute("aria-label", "No. " + (i + 1)); }
      else fresh.setAttribute("aria-hidden", "true");
      if (m) m.replaceWith(fresh); else $("marks").append(fresh);
      m = fresh;
    }
    m.classList.toggle("fifth", (i + 1) % 5 === 0 || i === 0);
    m.style.top = TOP + i * pitch + "px";
  }
  track();
}
function progress() {
  const es = entries();
  if (es.length < 2) return 0;
  const head = bar.offsetHeight, foot = $("ask").offsetHeight, max = document.documentElement.scrollHeight - innerHeight;
  const line = head + 16 + (max > 0 ? Math.min(1, scrollY / max) * Math.max(0, innerHeight - head - foot - 32) : 0);
  const tops = es.map((e) => e.getBoundingClientRect().top);
  let i = 0;
  while (i < tops.length - 1 && tops[i + 1] <= line) i++;
  if (i === tops.length - 1) return i;
  return i + Math.min(1, Math.max(0, (line - tops[i]) / (tops[i + 1] - tops[i])));
}
function activate(i) {
  if (i === active) return;
  active = i;
  [...$("marks").children].forEach((m, k) => m.classList.toggle("on", k === i));
  $("history").querySelectorAll("a.row").forEach((r, k) => { if (k === i) r.setAttribute("aria-current", "true"); else r.removeAttribute("aria-current"); });
}
const place = (p) => { level.style.transform = "translateY(" + (TOP + p * pitch) + "px)"; activate(Math.round(p)); };
let queued = false;
function track() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; if (!drag && !settle && entries().length) place(progress()); });
}
addEventListener("scroll", () => { edge(); track(); }, { passive: true });
addEventListener("resize", () => requestAnimationFrame(drawSpine));

const band = (x, d) => (x * d * 0.55) / (d + 0.55 * x);
function scrub(y) {
  const es = entries(), r = spine.getBoundingClientRect(), first = r.top + TOP, last = first + (es.length - 1) * pitch;
  const at = Math.min(last, Math.max(first, y)), over = y - at;
  const shift = Math.sign(over) * band(Math.abs(over), r.height);
  rail.style.transform = "translateY(" + shift / 2 + "px)";
  level.style.transform = "translateY(" + (at - r.top + shift) + "px)";
  const i = Math.round((at - first) / pitch);
  if (i !== drag.at) { drag.at = i; es[i].scrollIntoView({ block: "start" }); activate(i); }
}
spine.addEventListener("pointerdown", (e) => {
  if (drag || !entries().length || (e.pointerType === "mouse" && e.button !== 0)) return;
  e.preventDefault();
  if (settle) { settle.forEach((a) => a.stop()); settle = null; }
  spine.setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, at: -1 };
  spine.dataset.drag = "";
  scrub(e.clientY);
});
spine.addEventListener("pointermove", (e) => { if (drag && e.pointerId === drag.id) scrub(e.clientY); });
const release = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  delete spine.dataset.drag;
  const to = "translateY(" + (TOP + progress() * pitch) + "px)";
  if (reduce.matches) { rail.style.transform = ""; level.style.transform = to; return; }
  const mine = [
    animate(level, { transform: [level.style.transform || to, to] }, SPRING),
    animate(rail, { transform: [rail.style.transform || "translateY(0px)", "translateY(0px)"] }, SPRING),
  ];
  settle = mine;
  Promise.all(mine).then(() => { if (settle === mine) { settle = null; track(); } });
};
spine.addEventListener("pointerup", release);
spine.addEventListener("pointercancel", release);
// A pointer already moved the thread on pointerdown; a keyboard Enter on a mark follows its link as usual.
spine.addEventListener("click", (e) => { if (e.detail) e.preventDefault(); });

// The composer shows the number of the entry it will become.
const number = (roll) => {
  const next = $("next");
  next.textContent = "No. " + (state.turns.length + 1);
  if (roll && !reduce.matches) animate(next, { opacity: [0, 1], transform: ["translateY(8px)", "translateY(0px)"] }, SPRING);
};

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

// The entry's source and what the run read, from the answer's Source line and the record's summary.
async function cite(runId, source) {
  const c = el("div", "cite");
  if (source) c.append(el("p", "k", "Source"), el("p", "doc", source));
  try {
    const s = (await (await fetch("/runs/" + runId + "/view")).json()).summary, parts = [];
    if (s.entriesRetrieved) parts.push("Read " + s.entriesRetrieved + (s.entriesRetrieved === 1 ? " entry" : " entries"));
    const tools = s.toolCalls.reduce((n, t) => n + t.calls, 0);
    if (tools) parts.push(tools + (tools === 1 ? " tool call" : " tool calls"));
    parts.push(s.ms < 1000 ? s.ms + " ms" : (s.ms / 1000).toFixed(1) + " s");
    c.append(el("p", "facts", parts.join(" \\u00b7 ")));
  } catch {}
  return c.childNodes.length ? c : null;
}

// The witness: the chain's verdict in a word and a shape, the record as a graduated scale (one tick per event, a long
// tick and its event number every fifth), which is the button that checks it, and the record's hash.
function mark(w, chain, text, hash) {
  w.dataset.chain = chain;
  w.querySelector(".status").replaceChildren(svg(SEALS[chain]), el("span", "", text));
  w.querySelector(".seal code").textContent = hex(hash);
  tally();
}
function links(w, n) {
  const strip = w.querySelector(".links"), ruler = w.querySelector(".ruler");
  const step = n <= 16 ? 12 : Math.max(2, Math.floor(192 / n)), thick = step >= 8 ? 4 : Math.max(1, Math.round(step / 2));
  strip.style.setProperty("--pitch", step + "px");
  strip.style.setProperty("--w", thick + "px");
  strip.replaceChildren(...Array.from({ length: n }, () => { const i = el("i"); i.append(el("b")); return i; }));
  const every = step * 5 >= 24 ? 5 : step * 10 >= 24 ? 10 : 50, nums = [];
  for (let k = 0; k < n; k += every) { const s = el("span", "", String(k)); s.style.left = k * step + "px"; nums.push(s); }
  ruler.replaceChildren(...nums);
  ruler.dataset.step = String(step);
  return [...strip.children];
}
function witness(runId, events) {
  const w = el("div", "witness");
  const status = el("p", "status"); status.setAttribute("role", "status");
  const scale = el("span", "scale"); scale.setAttribute("aria-hidden", "true");
  scale.append(el("span", "links"), el("span", "ruler"));
  const verify = el("button", "verify"); verify.type = "button";
  verify.append(scale, el("span", "verb", "Check the chain"));
  const trail = el("div", "trail"); trail.append(verify);
  const seal = el("span", "seal"); seal.append(el("code"));
  const open = el("a", "", "Open record"); open.href = "/runs/" + runId;
  const acts = el("p", "acts"); acts.append(seal, open);
  w.append(status, trail, acts);
  // What this page saw when the run finished. verifyChain cannot see events cut from the end, so a record that later
  // ends sooner, or on another hash, reads as changed.
  const seen = { n: events.length, head: events.at(-1).hash };
  links(w, seen.n);
  mark(w, "unverified", "Not checked yet", seen.head);
  verify.onclick = () => check(w, runId, verify, seen);
  return w;
}
// Sealing: the scale draws in tick by tick and the record's hash counts through digits until it settles on its value.
// It starts once the smooth scroll that follows the answer has brought the record into view, from its first frame.
function sealIn(w, hash) {
  if (reduce.matches) return;
  const WAIT = 0.3, ticks = w.querySelectorAll(".links i"), code = w.querySelector(".seal code"), real = hex(hash);
  const digits = [...real].map((c, j) => ({ c, j, v: parseInt(c, 16) }));
  const roll = (p) => digits.map(({ c, j, v }) => {
    if (c === " ") return c;
    const lock = 0.3 + (0.7 * j) / real.length;
    return p >= lock ? c : ((v + Math.ceil((lock - p) * 48)) % 16).toString(16);
  }).join("");
  const later = w.querySelectorAll(".status, .ruler, .verb, .acts a");
  for (const t of ticks) t.style.opacity = "0";
  for (const x of later) x.style.opacity = "0";
  code.textContent = roll(0);
  animate(ticks, { opacity: [0, 1], transform: ["scaleY(0.4)", "scaleY(1)"] }, { ...SPRING, duration: 0.3, delay: stagger(0.016, { startDelay: WAIT }) });
  animate(later, { opacity: [0, 1] }, { duration: 0.24, ease: EASE, delay: stagger(0.04, { startDelay: WAIT + 0.08 }) });
  animate(0, 1, { delay: WAIT, duration: 0.42, ease: "linear", onUpdate: (p) => { code.textContent = roll(p); }, onComplete: () => { code.textContent = real; } });
}
// One tick's fill rises through the graduation, like liquid in a cylinder.
function fill(tick, cls) {
  tick.className = cls;
  if (!reduce.matches) animate(tick.firstChild, { clipPath: ["inset(100% 0% 0% 0%)", "inset(0% 0% 0% 0%)"] }, { duration: 0.22, ease: EASE });
}
const fetchJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(url + " answered " + r.status); return r.json(); });
async function check(w, runId, verify, seen) {
  verify.disabled = true;
  w.setAttribute("aria-busy", "true");
  const verb = verify.querySelector(".verb");
  verb.textContent = "Checking";
  try {
    const [events, view] = await Promise.all([fetchJson("/runs/" + runId + "/events"), fetchJson("/runs/" + runId + "/view")]);
    const n = events.length, last = events.at(-1);
    const changed = view.chain.events !== n ? "The record changed while it was checked. Check again."
      : view.chain.firstBad === null && (n < seen.n || !last || last.hash !== seen.head || last.event.t !== "run.finished") ? "Changed since this page loaded: the record had " + seen.n + " events and ended on " + hex(seen.head)
      : null;
    const bad = changed ? null : view.chain.firstBad;
    const marks = links(w, n);
    const stop = bad === null ? n : bad;
    // About 900 ms whatever the length: one event per step down to a frame, then several per frame.
    const delay = Math.min(70, 900 / Math.max(stop, 1)), per = Math.max(1, Math.ceil(16 / delay));
    for (let i = 0; i < stop; i += per) {
      const k = Math.min(stop, i + per) - 1;
      for (let j = i; j <= k; j++) fill(marks[j], "held");
      if (!reduce.matches) { mark(w, "checking", "Checking " + (k + 1) + " of " + n + " events", events[k].hash); await sleep(delay * per); }
    }
    if (changed) mark(w, "broken", changed, last ? last.hash : seen.head);
    else if (bad !== null) {
      fill(marks[bad], "broken");
      const at = el("span", "bad", "#" + bad); at.style.left = bad * Number(w.querySelector(".ruler").dataset.step) + "px";
      w.querySelector(".ruler").append(at);
      mark(w, "broken", "Broken at #" + bad + ": an event was edited or removed", events[bad].hash);
    }
    else mark(w, "verified", "Verified: chain intact over " + n + " events", last.hash);
    if (!reduce.matches) animate(w.querySelector(".status svg"), { opacity: [0, 1], transform: ["scale(0.6)", "scale(1)"] }, SPRING);
    verb.textContent = "Check again";
  } catch {
    links(w, seen.n);
    mark(w, "unverified", "The web door did not answer. Try again.", seen.head);
    verb.textContent = "Check the chain";
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
  let day = null;
  if (new Date(at).toDateString() !== lastDay) {
    lastDay = new Date(at).toDateString();
    day = el("h2", "day");
    const time = el("time", "", dayName(at)); time.dateTime = at.slice(0, 10); day.append(time);
    $("thread").append(day);
    $("history").append(el("li", "label", shortDay(at)));
  }
  const link = el("a", "row"); link.href = "#e" + n;
  link.append(svg(SEALS.pending), el("span", "n", String(n)), el("span", "", t.q));
  const item = el("li"); item.append(link); $("history").append(item);
  const entry = el("article", "entry"); entry.id = "e" + n;
  const head = el("p", "meta");
  const time = el("time", "", clock(at)); time.dateTime = at;
  head.append(el("span", "no", "No. " + n), time, el("span", "who", user));
  const body = el("div", "body");
  body.append(el("h3", "q", t.q));
  const margin = el("aside", "margin");
  entry.append(head, body, margin);
  $("thread").append(entry);
  return { entry, head, body, margin, day };
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

// Asking: the question leaves the composer and settles as the new entry's question, the thread moves up to make room
// for it, and the spine gains its next mark. The question travels as a copy above the composer, then hands over to the
// entry's own heading in the same place.
function arrive(turn, steps, from) {
  if (reduce.matches || !from) { turn.entry.scrollIntoView({ block: "end" }); return; }
  turn.entry.scrollIntoView({ block: "end" });
  const lift = scrollY - from.y, q = turn.body.querySelector(".q"), to = q.getBoundingClientRect();
  const box = document.querySelector(".box"), boxNow = box.getBoundingClientRect();
  const ghost = q.cloneNode(true);
  ghost.classList.add("ghost");
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, { left: to.left + "px", top: to.top + "px", width: to.width + "px" });
  document.body.append(ghost);
  q.style.opacity = "0";
  const dx = from.left - to.left, dy = from.top + 1 - to.top;
  animate(ghost, { transform: ["translate(" + dx + "px, " + dy + "px) scale(0.8)", "translate(0px, 0px) scale(1)"] }, SPRING)
    .then(() => { q.style.opacity = ""; ghost.remove(); });
  if (lift) animate($("thread"), { transform: ["translateY(" + lift + "px)", "translateY(0px)"] }, SPRING);
  if (Math.abs(from.box - boxNow.top) > 1) animate(box, { transform: ["translateY(" + (from.box - boxNow.top) + "px)", "translateY(0px)"] }, SPRING);
  animate([turn.head, steps, ...(turn.day ? [turn.day] : [])], { opacity: [0, 1] }, { duration: 0.24, ease: EASE, delay: 0.14 });
  const marks = $("marks").children, made = marks[marks.length - 2], next = marks[marks.length - 1];
  if (made) animate(made.firstChild, { transform: ["scale(0.67, 0.25)", "scale(1, 1)"] }, SPRING);
  if (next) animate(next, { opacity: [0, 1], transform: ["translateY(-8px)", "translateY(0px)"] }, { ...SPRING, delay: 0.08 });
}

async function ask(text, from) {
  const t = { q: text, at: new Date().toISOString() };
  state.turns.push(t); save();
  const turn = turnOf(t, state.turns.length), steps = stepsOf(turn);
  drawSpine(); tally(); number(true);
  arrive(turn, steps, from);
  const fail = (msg) => { t.error = msg; save(); done(steps, el("p", "err", msg)); tally(); };
  let body;
  try {
    const res = await fetch("/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel, thread: state.thread, message: state.thread + "-" + (state.n++), text, user }) });
    body = await res.json();
  } catch { return fail("The web door did not answer. Check that it is running, then ask again."); }
  if (body.t === "refused") { t.notice = body.userFacing; save(); done(steps, refusal("Not sent", body.userFacing)); tally(); return; }
  if (body.t !== "enqueued") return fail(body.error || "The message was not accepted.");
  t.runId = body.runId; save();
  await follow(turn, steps, body.runId, true);
}

async function follow(turn, steps, runId, live) {
  try { await watch(turn, steps, runId, live); }
  catch { done(steps, el("p", "err", "Lost contact with the web door. Reload the page to pick up the answer.")); tally(); }
}
async function watch(turn, steps, runId, live) {
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    const events = await fetchJson("/runs/" + runId + "/events");
    for (const e of events) {
      if (e.event.t === "tool.requested" && !seen.has(e.seq)) { seen.add(e.seq); steps.append(el("code", "", e.event.tool)); }
    }
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
        if (withheld) turn.body.append(el("p", "facts", withheld + (withheld === 1 ? " tool result" : " tool results") + " withheld from the model"));
      }
      const c = await cite(runId, source);
      if (c) turn.margin.append(c);
      const w = witness(runId, events);
      turn.margin.append(w);
      turn.entry.dataset.entryDone = "";
      tally();
      if (live) { turn.entry.scrollIntoView({ block: "end", behavior: reduce.matches ? "auto" : "smooth" }); sealIn(w, events.at(-1).hash); }
      track();
      return;
    }
    await sleep(300);
  }
  done(steps, el("p", "err", "No answer after three minutes. Check that the worker is running, then reload the page."));
  tally();
}

$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  const r = $("text").getBoundingClientRect();
  const from = { left: r.left, top: r.top + 6, y: scrollY, box: document.querySelector(".box").getBoundingClientRect().top };
  $("text").value = ""; sync();
  ask(text, from);
});
for (const b of document.querySelectorAll(".fresh")) b.addEventListener("click", () => {
  state = blank(); save();
  lastDay = null;
  active = -1;
  $("thread").replaceChildren();
  $("history").replaceChildren();
  $("intro").hidden = false;
  drawSpine(); tally(); number(false);
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
number(false);
drawSpine();
tally();
requestAnimationFrame(() => { document.documentElement.classList.remove("restoring"); if (state.turns.length) scrollTo(0, document.body.scrollHeight); });
$("text").focus();
</script>
</body>
</html>`;
}
