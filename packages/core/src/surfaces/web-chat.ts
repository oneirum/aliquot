/**
 * The member chat page, set as the lab's notebook: each answer is a dated, numbered entry, with its source and its
 * record in the margin. The record's hash chain witnesses the entry. Verify reads the run's events (/runs/:id/events)
 * and the door's own recomputation of the chain (/runs/:id/view, verifyChain in record.ts), then marks each event in
 * order up to that verdict, so what the page shows is the door's check and the hashes it checked.
 *
 * Static HTML with inline CSS and script, like the other pages: it reads only the JSON routes in web.ts.
 */

import { APP_HEAD } from "./web-app.ts";
import { BASE_CSS, header } from "./web-pages.ts";

export function chatPage(where = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Ask the lab · Aliquot</title>
${APP_HEAD}
<style>${BASE_CSS}
body { min-height: 100dvh; display: flex; flex-direction: column; background-image: linear-gradient(var(--rule) 1px, transparent 1px), linear-gradient(90deg, var(--rule) 1px, transparent 1px); background-size: 24px 24px; background-position: -1px -1px; }
.book { flex: 1; width: 100%; max-width: 1184px; margin: 0 auto; padding: 0 20px; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr); }
.gutter { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
@media (min-width: 900px) {
  .book { padding: 0 48px; }
  .cols { grid-template-columns: 112px minmax(0, 1fr) 288px; column-gap: 40px; }
}

.intro { padding: 48px 0 24px; }
.intro[hidden] { display: none; }
.intro .gutter { margin: 0 0 12px; }
.intro h1 { font-size: 40px; line-height: 1.05; letter-spacing: -0.025em; font-weight: 500; margin: 0; }
.tries { list-style: none; margin: 36px 0 0; padding: 0; border-top: 1px solid var(--line); }
.tries:empty { display: none; }
.tries li { border-bottom: 1px solid var(--line); }
.try { display: flex; justify-content: space-between; align-items: center; gap: 16px; width: 100%; font: inherit; font-size: 17px; line-height: 1.4; text-align: left; color: var(--ink); background: none; border: 0; padding: 14px 0; cursor: pointer; transition: transform 160ms var(--ease-out); }
.try svg { width: 16px; height: 16px; color: var(--muted); flex: none; transition: transform 200ms var(--ease-out), color 160ms ease; }
.try:active { transform: scale(0.99); }
@media (hover: hover) and (pointer: fine) { .try:hover svg { transform: translateX(3px); color: var(--ink); } }
.install { margin: 20px 0 0; font-size: 14px; color: var(--muted); }
@media (display-mode: standalone) { .install { display: none; } }
@media (min-width: 900px) { .intro { padding-top: 88px; } .intro .gutter { margin: 0; padding-top: 18px; } .intro h1 { font-size: 56px; } }

#thread { padding: 0 0 48px; }
.day { margin: 40px 0 0; padding: 10px 0 0; border-top: 1px solid var(--ink); font-size: 13px; font-weight: 500; }
.entry { padding: 24px 0 32px; border-bottom: 1px solid var(--line); transition: opacity 240ms var(--ease-out), transform 240ms var(--ease-out); }
@starting-style { .entry { opacity: 0; transform: translateY(6px); } }
.restoring .entry { transition: none; }
.entry .head { display: flex; gap: 10px; margin: 0 0 8px; }
.entry .no { color: var(--ink); font-weight: 500; }
@media (min-width: 900px) { .entry .head { flex-direction: column; gap: 2px; margin: 0; padding-top: 4px; } }
.q { font-size: 20px; line-height: 1.35; letter-spacing: -0.01em; font-weight: 500; margin: 0 0 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.a { transition: opacity 200ms ease; }
@starting-style { .a, .refusal { opacity: 0; } }
.a > * { margin: 0 0 12px; }
.a > :last-child { margin-bottom: 0; }
.a p { white-space: pre-line; }
.a ul, .a ol { padding-left: 1.3em; }
.a li { margin: 4px 0; padding-left: 2px; }
.a li::marker { color: var(--muted); font-variant-numeric: tabular-nums; }
.a .h { font-weight: 500; margin-top: 18px; }
.a > .h:first-child { margin-top: 0; }
.a pre { font: 13px/1.5 var(--mono); background: var(--quiet); border-radius: 6px; padding: 10px 12px; overflow-x: auto; white-space: pre; }
.a strong { font-weight: 600; }
.a code { font: 13px var(--mono); background: var(--quiet); padding: 1px 5px; border-radius: 4px; }
.steps { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; margin: 0; font-size: 14px; color: var(--muted); font-variant-numeric: tabular-nums; }
.steps code { font: 12.5px var(--mono); color: var(--ink-2); }
.err { color: var(--ink); font-size: 15px; margin: 0; }
.refusal { margin: 0; padding: 14px 16px 14px 28px; border: 1px solid var(--line); border-radius: 4px; background-color: var(--surface); background-image: repeating-linear-gradient(-45deg, var(--muted) 0 1px, transparent 1px 5px); background-size: 12px 100%; background-repeat: no-repeat; transition: opacity 200ms ease; }
.refusal .title { display: flex; gap: 8px; align-items: center; font-weight: 500; margin: 0 0 4px; }
.refusal .title svg { width: 14px; height: 14px; flex: none; }
.refusal p { margin: 0; font-size: 15px; }

.margin { display: grid; gap: 22px; align-content: start; font-size: 13.5px; line-height: 1.5; }
.margin:empty { display: none; }
.margin p { margin: 0; }
.margin .k { color: var(--muted); margin-bottom: 4px; }
.doc { font-weight: 500; overflow-wrap: anywhere; }
.facts { color: var(--muted); font-variant-numeric: tabular-nums; margin-top: 2px; }
@media (min-width: 900px) { .margin { border-left: 1px solid var(--line); padding-left: 24px; } }
@media (max-width: 899px) {
  .margin { gap: 18px; margin-top: 20px; padding-top: 16px; border-top: 1px dashed var(--line); }
  .cite, .witness { display: flex; flex-wrap: wrap; align-items: center; column-gap: 10px; }
  .margin .k, .witness .links { margin: 0; }
  .facts, .witness .status, .witness .seal, .witness .acts { flex-basis: 100%; }
  .witness .status { margin-top: 10px; }
}

.links { display: flex; flex-wrap: wrap; gap: 3px; margin: 8px 0 12px; }
.links i { width: 6px; height: 16px; border-radius: 1.5px; box-shadow: inset 0 0 0 1px var(--line); transition: background-color 120ms ease, box-shadow 120ms ease, opacity 160ms ease; }
.links i.held { background-color: var(--held); box-shadow: none; }
.links i.broken { background-image: linear-gradient(var(--broken) 0 6px, transparent 6px 10px, var(--broken) 10px); box-shadow: none; }
[data-chain="broken"] .links i:not(.held):not(.broken) { opacity: 0.4; }
.status { display: flex; gap: 8px; align-items: flex-start; font-weight: 500; }
.status svg { width: 14px; height: 14px; flex: none; margin-top: 3px; color: var(--muted); }
[data-chain="unverified"] .status, [data-chain="checking"] .status { font-weight: 400; color: var(--ink-2); }
[data-chain="verified"] .status svg { color: var(--held); }
[data-chain="broken"] .status svg { color: var(--broken); }
.seal { margin-top: 6px; color: var(--muted); font-variant-numeric: tabular-nums; }
.seal code { font: 13px/1.5 var(--mono); color: var(--ink-2); }
.acts { display: flex; gap: 16px; align-items: center; margin-top: 12px; }
button.verify { font: 500 13.5px/1 var(--sans); color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; cursor: pointer; transition: transform 160ms var(--ease-out), border-color 160ms ease; }
button.verify:active { transform: scale(0.97); }
button.verify:disabled { cursor: default; color: var(--muted); }
@media (hover: hover) and (pointer: fine) { button.verify:hover { border-color: var(--muted); } }

.compose { position: sticky; bottom: 0; z-index: 1; background: var(--bg); border-top: 1px solid var(--line); }
.compose .row { max-width: 1184px; margin: 0 auto; padding: 12px 20px calc(12px + env(safe-area-inset-bottom)); }
.compose .next { display: none; }
.field { display: flex; gap: 12px; align-items: flex-end; }
textarea { flex: 1; resize: none; border: 0; border-bottom: 1px solid var(--muted); border-radius: 0; outline: 0; background: transparent; color: var(--ink); font: inherit; font-size: 17px; padding: 8px 0; max-height: 160px; transition: border-color 160ms ease; }
textarea::placeholder { color: var(--muted); }
textarea:focus-visible { outline: none; border-bottom-color: var(--ink); box-shadow: 0 1px 0 var(--ink); }
button.send { font: 500 15px/1 var(--sans); background: var(--accent); color: var(--accent-ink); border: 0; border-radius: 8px; padding: 11px 18px; cursor: pointer; transition: transform 160ms var(--ease-out), background-color 160ms ease, color 160ms ease, box-shadow 160ms ease; }
button.send:active { transform: scale(0.97); }
button.send:disabled { background: transparent; color: var(--muted); box-shadow: inset 0 0 0 1px var(--line); cursor: default; transform: none; }
@media (min-width: 900px) { .compose .row { padding: 14px 48px 18px; } .compose .next { display: block; padding-top: 12px; } }
@media (prefers-reduced-motion: reduce) {
  .entry { transition: opacity 200ms ease; }
  @starting-style { .entry { transform: none; } }
  .try, .try svg, button.verify, button.send { transition: none; }
}
</style>
</head>
<body>
<div class="book">
  ${header("ask", where, '<button type="button" id="fresh" hidden>New page</button>')}
  <section class="intro cols" id="intro">
    <p class="gutter"><time id="today"></time></p>
    <div>
      <h1>Ask the lab</h1>
      <ul class="tries" id="tries"></ul>
      <p class="install" id="install">To open Aliquot like an app, choose Add to Home Screen or Install in the browser menu.</p>
    </div>
  </section>
  <main id="thread" aria-live="polite"></main>
</div>
<form id="ask" class="compose">
  <div class="row cols">
    <p class="gutter next" id="next"></p>
    <div class="field">
      <textarea id="text" rows="1" placeholder="Ask a question about the lab" aria-label="Your question"></textarea>
      <button class="send" id="send" type="submit" disabled>Ask</button>
    </div>
  </div>
</form>
<script type="module">
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const user = params.get("user") || "member-1";
const channel = params.get("channel") || undefined;
// The thread lives in this tab's sessionStorage, so a reload or a visit to a record and back keeps it.
const KEY = "aliquot.thread." + (channel || "") + "." + user;
const blank = () => ({ v: 1, thread: "web-" + crypto.randomUUID(), n: 0, turns: [] });
let state = (() => { try { const s = JSON.parse(sessionStorage.getItem(KEY) || "null"); return s && s.v === 1 && Array.isArray(s.turns) ? s : blank(); } catch { return blank(); } })();
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch {} $("fresh").hidden = !state.turns.length; $("next").textContent = "No. " + (state.turns.length + 1); };
const reduce = matchMedia("(prefers-reduced-motion: reduce)");

const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
const svg = (paths) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("aria-hidden", "true"); s.innerHTML = paths; return s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayName = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const hex = (h) => h.slice(0, 16).replace(/(.{4})(?!$)/g, "$1 ");

const today = new Date().toISOString();
$("today").dateTime = today.slice(0, 10);
$("today").textContent = dayName(today);

const ARROW = '<path d="M3 8h9.5M8.5 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
for (const q of (params.get("try") || "").split("|").filter(Boolean)) {
  const b = el("button", "try");
  b.type = "button";
  b.append(el("span", "", q), svg(ARROW));
  b.onclick = () => { $("text").value = q; sync(); $("ask").requestSubmit(); };
  const li = el("li"); li.append(b); $("tries").append(li);
}

// Safari keeps Add to Home Screen behind Share; iPadOS reports itself as a Mac with a touch screen.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) $("install").textContent = "To open Aliquot from your Home Screen, tap Share, then Add to Home Screen.";
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

const sync = () => {
  const t = $("text");
  t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px";
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

// The witness: the run's events as links, the chain's verdict in a word and a shape, and the record's hash.
const SEALS = {
  unverified: '<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2.3"/>',
  checking: '<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor"/>',
  verified: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.9 8.2l2.1 2.1 4.1-4.4" fill="none" style="stroke: var(--bg)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  broken: '<rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" style="stroke: var(--bg)" stroke-width="1.6" stroke-linecap="round"/>',
};
function mark(w, chain, text, label, hash) {
  w.dataset.chain = chain;
  const s = w.querySelector(".status");
  s.replaceChildren(svg(SEALS[chain]), el("span", "", text));
  const seal = w.querySelector(".seal");
  seal.replaceChildren(label + " ", el("code", "", hex(hash)));
}
function links(w, n) {
  const strip = w.querySelector(".links");
  strip.replaceChildren(...Array.from({ length: n }, () => el("i")));
  return [...strip.children];
}
function witness(runId, events) {
  const w = el("div", "witness");
  const status = el("p", "status"); status.setAttribute("role", "status");
  const strip = el("div", "links"); strip.setAttribute("aria-hidden", "true");
  const verify = el("button", "verify", "Verify"); verify.type = "button";
  const open = el("a", "", "Open record"); open.href = "/runs/" + runId;
  const acts = el("p", "acts"); acts.append(verify, open);
  w.append(el("p", "k", "Witnessed by the chain"), strip, status, el("p", "seal"), acts);
  links(w, events.length);
  mark(w, "unverified", "Not verified yet", "Record", events.at(-1).hash);
  verify.onclick = () => check(w, runId, verify);
  return w;
}
async function check(w, runId, verify) {
  verify.disabled = true;
  let events, view;
  try { [events, view] = await Promise.all([fetch("/runs/" + runId + "/events").then((r) => r.json()), fetch("/runs/" + runId + "/view").then((r) => r.json())]); }
  catch { w.querySelector(".status span").textContent = "The web door did not answer. Try again."; verify.disabled = false; return; }
  const n = events.length, bad = view.chain.firstBad;
  const marks = links(w, n);
  const step = reduce.matches ? 0 : Math.max(24, Math.min(70, 900 / n));
  for (let i = 0; i < (bad === null ? n : bad); i++) {
    marks[i].className = "held";
    if (step) { mark(w, "checking", "Checking event " + (i + 1) + " of " + n, "Event " + String(i).padStart(2, "0"), events[i].hash); await sleep(step); }
  }
  if (bad === null) mark(w, "verified", "Verified: chain intact over " + n + " events", "Record", events.at(-1).hash);
  else { marks[bad].className = "broken"; mark(w, "broken", "Broken at event " + bad + ": an event was edited or removed", "Event " + String(bad).padStart(2, "0"), events[bad].hash); }
  verify.textContent = "Verify again";
  verify.disabled = false;
}

let lastDay = null;
function turnOf(t, n) {
  $("intro").hidden = true;
  const at = t.at || new Date().toISOString();
  if (new Date(at).toDateString() !== lastDay) {
    lastDay = new Date(at).toDateString();
    const d = el("h2", "day"), time = el("time", "", dayName(at)); time.dateTime = at.slice(0, 10); d.append(time);
    $("thread").append(d);
  }
  const entry = el("article", "entry cols");
  const head = el("p", "head gutter");
  const time = el("time", "", clock(at)); time.dateTime = at;
  head.append(el("span", "no", "No. " + n), time, el("span", "who", user));
  const body = el("div", "body");
  body.append(el("h3", "q", t.q));
  const margin = el("aside", "margin");
  entry.append(head, body, margin);
  $("thread").append(entry);
  return { entry, head, body, margin };
}
function stepsOf(turn) {
  const steps = el("p", "steps"), clockText = el("span", "", "0 s"), t0 = Date.now();
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
  if (body.t !== "enqueued") return fail(body.error || "The message was not accepted.");
  t.runId = body.runId; save();
  await follow(turn, steps, body.runId, true);
}

async function follow(turn, steps, runId, scroll) {
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    let events;
    try { events = await (await fetch("/runs/" + runId + "/events")).json(); }
    catch { done(steps, el("p", "err", "Lost contact with the web door. Reload the page to pick up the answer.")); return; }
    for (const e of events) {
      if (e.event.t === "tool.requested" && !seen.has(e.seq)) { seen.add(e.seq); steps.append(el("code", "", e.event.tool)); }
    }
    const finished = events.find((e) => e.event.t === "run.finished");
    if (finished) {
      const started = events.find((e) => e.event.t === "run.started");
      if (started) turn.head.lastChild.textContent = started.event.trigger.memberId || user;
      const replies = await (await fetch("/replies?runId=" + runId)).json();
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
$("fresh").addEventListener("click", () => {
  state = blank(); save();
  lastDay = null;
  $("thread").replaceChildren();
  $("intro").hidden = false;
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
