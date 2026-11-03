/**
 * The two pages the web door serves: the member chat page and the read-only
 * run record. Static HTML with inline CSS and script, no build step and no
 * third-party code, so the page loads from 127.0.0.1 with nothing fetched
 * from anywhere else. Both read only the JSON routes in web.ts.
 */

const BASE_CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8; --surface: #ffffff; --ink: #1d1c1a; --muted: #6b6862; --line: #e7e4de;
  --accent: #2f5d50; --accent-ink: #ffffff; --quiet: #f3f1ec;
  --warn-bg: #fdf3e1; --warn-line: #ecd3a4; --warn-ink: #6b4a12;
  --ok: #2f6b45; --bad: #9b2c2c;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151514; --surface: #1d1d1b; --ink: #ecebe7; --muted: #9c9991; --line: #2e2d2a;
    --accent: #8cc5b0; --accent-ink: #10201b; --quiet: #242422;
    --warn-bg: #352812; --warn-line: #6a5226; --warn-ink: #f0d7a6;
    --ok: #8fd1a5; --bad: #f0a3a3;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-underline-offset: 2px; }
.wordmark { font-weight: 650; letter-spacing: -0.01em; font-size: 15px; color: var(--ink); text-decoration: none; }
.pill { display: inline-block; font: 600 11px/1 var(--mono); letter-spacing: 0.02em; padding: 4px 6px; border-radius: 5px; background: var(--quiet); color: var(--muted); vertical-align: 1px; }
.pill.d3, .pill.r { background: var(--warn-bg); color: var(--warn-ink); }
`;

export function chatPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ask the lab · Aliquot</title>
<style>${BASE_CSS}
.shell { max-width: 720px; margin: 0 auto; min-height: 100dvh; display: flex; flex-direction: column; padding: 0 20px; }
header { display: flex; align-items: baseline; justify-content: space-between; padding: 22px 0 14px; border-bottom: 1px solid var(--line); }
header .where { font-size: 13px; color: var(--muted); }
.intro { padding: 44px 0 8px; }
.intro h1 { font-size: 28px; line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 8px; font-weight: 650; }
.intro p { margin: 0; color: var(--muted); max-width: 52ch; }
.tries { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.try { font: inherit; font-size: 14px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 7px 13px; cursor: pointer; transition: transform 160ms var(--ease-out), border-color 160ms ease; }
.try:active { transform: scale(0.97); }
@media (hover: hover) and (pointer: fine) { .try:hover { border-color: var(--muted); } }
#thread { flex: 1; padding: 20px 0 24px; display: flex; flex-direction: column; gap: 22px; }
.turn { display: flex; flex-direction: column; gap: 10px; opacity: 1; transform: none; transition: opacity 240ms var(--ease-out), transform 240ms var(--ease-out); }
@starting-style { .turn { opacity: 0; transform: translateY(6px); } }
.q { align-self: flex-end; max-width: 80%; background: var(--quiet); border-radius: 14px 14px 4px 14px; padding: 9px 14px; white-space: pre-wrap; }
.a { max-width: 92%; }
.a > * { margin: 0 0 10px; }
.a > :last-child { margin-bottom: 0; }
.a p { white-space: pre-line; }
.a ul, .a ol { padding-left: 1.3em; }
.a li { margin: 3px 0; padding-left: 2px; }
.a li::marker { color: var(--muted); }
.a .h { font-weight: 650; letter-spacing: -0.01em; margin-top: 16px; }
.a > .h:first-child { margin-top: 0; }
.a pre { font: 12.5px/1.5 var(--mono); background: var(--quiet); border-radius: 8px; padding: 10px 12px; overflow-x: auto; white-space: pre; }
.a strong { font-weight: 650; }
.a code { font: 12.5px var(--mono); background: var(--quiet); padding: 1px 5px; border-radius: 4px; }
.steps { font-size: 13px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.steps .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
.steps code { font: 12px var(--mono); background: var(--quiet); padding: 2px 6px; border-radius: 4px; color: var(--ink); }
.meta { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.source { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--line); background: var(--surface); border-radius: 8px; padding: 4px 9px; color: var(--ink); }
.source b { font-weight: 600; font-size: 12px; color: var(--muted); }
.source code { font: 12.5px var(--mono); }
.facts { font-variant-numeric: tabular-nums; }
.banner { border: 1px solid var(--warn-line); background: var(--warn-bg); color: var(--warn-ink); border-radius: 12px; padding: 12px 14px; max-width: 92%; }
.banner strong { display: block; font-weight: 650; margin-bottom: 2px; }
.banner p { margin: 0; font-size: 14.5px; }
.banner .pill { box-shadow: inset 0 0 0 1px var(--warn-line); }
.err { color: var(--bad); font-size: 14px; }
form { position: sticky; bottom: 0; padding: 12px 0 20px; background: linear-gradient(to bottom, transparent, var(--bg) 30%); }
.box { display: flex; gap: 8px; align-items: flex-end; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 8px 8px 8px 14px; box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px rgb(0 0 0 / 0.04); }
.box:focus-within { border-color: var(--muted); }
textarea { flex: 1; resize: none; border: 0; outline: 0; background: transparent; color: var(--ink); font: inherit; padding: 6px 0; max-height: 160px; }
button.send { font: 600 14px/1 system-ui, sans-serif; background: var(--accent); color: var(--accent-ink); border: 0; border-radius: 9px; padding: 10px 14px; cursor: pointer; transition: transform 160ms var(--ease-out), opacity 160ms ease; }
button.send:active { transform: scale(0.97); }
button.send:disabled { opacity: 0.45; cursor: default; }
.foot { text-align: center; font-size: 12px; color: var(--muted); margin-top: 8px; }
@media (prefers-reduced-motion: reduce) { .turn { transition: opacity 200ms ease; } @starting-style { .turn { transform: none; } } .steps .dot { animation: none; } }
</style>
</head>
<body>
<div class="shell">
  <header><a class="wordmark" href="/">Aliquot</a><span class="where">Runs on this machine</span></header>
  <section class="intro" id="intro">
    <h1>Ask the lab</h1>
    <p>Answers come from the lab's own documents and name the entry they used. A message with restricted data never goes to a hosted model.</p>
    <div class="tries" id="tries"></div>
  </section>
  <main id="thread" aria-live="polite"></main>
  <form id="ask">
    <div class="box">
      <textarea id="text" rows="1" placeholder="Ask a question about the lab" aria-label="Your question"></textarea>
      <button class="send" id="send" type="submit" disabled>Ask</button>
    </div>
    <div class="foot">Every answer leaves a record you can check.</div>
  </form>
</div>
<script type="module">
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const user = params.get("user") || "member-1";
const channel = params.get("channel") || undefined;
const thread = "web-" + crypto.randomUUID();
let n = 0;

for (const q of (params.get("try") || "").split("|").filter(Boolean)) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "try"; b.textContent = q;
  b.onclick = () => { $("text").value = q; sync(); $("ask").requestSubmit(); };
  $("tries").append(b);
}

const sync = () => {
  const t = $("text");
  t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px";
  $("send").disabled = !t.value.trim();
};
$("text").addEventListener("input", sync);
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("ask").requestSubmit(); } });

const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
};

// One quiet line from the run's record: what it read and how long it took.
async function facts(runId) {
  try {
    const v = await (await fetch("/runs/" + runId + "/view")).json();
    const s = v.summary, parts = [];
    if (s.entriesRetrieved) parts.push("read " + s.entriesRetrieved + (s.entriesRetrieved === 1 ? " entry" : " entries"));
    const tools = s.toolCalls.reduce((n, t) => n + t.calls, 0);
    if (tools) parts.push(tools + (tools === 1 ? " tool call" : " tool calls"));
    parts.push(s.ms < 1000 ? s.ms + " ms" : (s.ms / 1000).toFixed(1) + " s");
    const f = el("span", "facts", parts.join(" \u00b7 "));
    return f;
  } catch { return null; }
}

function recordLink(runId) { const a = el("a", "", "Record"); a.href = "/runs/" + runId; return a; }

async function ask(text) {
  $("intro").hidden = true;
  const turn = el("div", "turn");
  turn.append(el("div", "q", text));
  const steps = el("div", "steps"); steps.append(el("span", "dot"), el("span", "", "Reading the lab's documents"));
  turn.append(steps);
  $("thread").append(turn);
  turn.scrollIntoView({ block: "end", behavior: "smooth" });
  let res, body;
  try {
    res = await fetch("/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel, thread, message: thread + "-" + (n++), text, user }) });
    body = await res.json();
  } catch { steps.replaceWith(el("div", "err", "The web door did not answer. Is it running?")); return; }
  if (body.t === "refused") { steps.replaceWith(banner("Not sent", body.userFacing)); return; }
  if (body.t !== "enqueued") { steps.replaceWith(el("div", "err", body.error || "The message was not accepted.")); return; }
  const runId = body.runId;
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    const events = await (await fetch("/runs/" + runId + "/events")).json();
    for (const e of events) {
      if (e.event.t === "tool.requested" && !seen.has(e.seq)) { seen.add(e.seq); steps.append(el("code", "", e.event.tool)); }
    }
    const finished = events.find((e) => e.event.t === "run.finished");
    if (finished) {
      const replies = await (await fetch("/replies?runId=" + runId)).json();
      steps.remove();
      const refused = events.find((e) => e.event.t === "egress.refused");
      const withheld = events.filter((e) => e.event.t === "tool.withheld").length;
      if (refused) {
        const r = refused.event.refusal;
        const why = (REFUSAL[r.code] || (() => "The egress check refused it."))(r);
        const b = banner("Refused: restricted data", why + " Nothing was sent. The refusal is in the record.");
        b.append(el("div", "meta")); b.lastChild.append(pillOf(refused.event.payload), recordLink(runId));
        turn.append(b);
      } else {
        const reply = replies.find((x) => x.kind === "reply") || replies[0];
        const raw = reply ? reply.text : "(no reply)";
        const m = /\\n\\s*Source:\\s*(.+)\\s*$/.exec(raw);
        turn.append(answer(m ? raw.slice(0, m.index) : raw));
        const meta = el("div", "meta");
        if (m) { const s = el("span", "source"); s.append(el("b", "", "Source"), el("code", "", m[1].trim())); meta.append(s); }
        if (withheld) meta.append(el("span", "", withheld + (withheld === 1 ? " tool result" : " tool results") + " withheld from the model"));
        const sum = await facts(runId);
        if (sum) meta.append(sum);
        meta.append(recordLink(runId));
        turn.append(meta);
      }
      turn.scrollIntoView({ block: "end", behavior: "smooth" });
      return;
    }
    await sleep(300);
  }
  steps.replaceWith(el("div", "err", "No answer after three minutes. Check that the worker is running."));
}

function pillOf(cls) { return el("span", "pill " + String(cls).toLowerCase(), cls); }
function banner(title, text) { const b = el("div", "banner"); b.setAttribute("role", "status"); b.append(el("strong", "", title), el("p", "", text)); return b; }

$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  $("text").value = ""; sync();
  ask(text);
});
$("text").focus();
</script>
</body>
</html>`;
}

export function recordPage(runId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Run record · Aliquot</title>
<style>${BASE_CSS}
.shell { max-width: 960px; margin: 0 auto; padding: 0 20px 64px; }
header { display: flex; align-items: baseline; justify-content: space-between; padding: 22px 0 14px; border-bottom: 1px solid var(--line); }
header nav { display: flex; gap: 16px; font-size: 13px; }
header nav a { color: var(--muted); text-decoration: none; }
@media (hover: hover) and (pointer: fine) { header nav a:hover { color: var(--ink); } }
.top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 36px 0 18px; }
h1 { font-size: 26px; letter-spacing: -0.02em; line-height: 1.15; margin: 0; font-weight: 650; }
.when { color: var(--muted); font-size: 14px; margin: 6px 0 0; }
.dl { display: inline-flex; align-items: center; gap: 7px; font: 600 13.5px/1 system-ui, sans-serif; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 9px; padding: 9px 12px; text-decoration: none; transition: transform 160ms var(--ease-out), border-color 160ms ease; }
.dl:active { transform: scale(0.97); }
.dl svg { width: 14px; height: 14px; }
@media (hover: hover) and (pointer: fine) { .dl:hover { border-color: var(--muted); } }
.dl[hidden] { display: none; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin: 0 0 22px; }
.summary[hidden] { display: none; }
.stat { background: var(--surface); padding: 12px 14px 13px; min-width: 0; }
.stat .k { font-size: 12.5px; color: var(--muted); }
.stat .v { font-size: 19px; font-weight: 620; letter-spacing: -0.01em; margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stat .v small { font-size: 13px; font-weight: 450; color: var(--muted); letter-spacing: 0; }
.stat .s { font: 12px/1.4 var(--mono); color: var(--muted); margin-top: 3px; overflow-wrap: anywhere; }
.stat.warn { background: var(--warn-bg); }
.stat.warn .k, .stat.warn .v, .stat.warn .v small { color: var(--warn-ink); }
.mark { font-size: 0.85em; margin-right: 6px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; margin: 0 0 26px; font-size: 14px; }
dt { color: var(--muted); }
dd { margin: 0; font-family: var(--mono); font-size: 13px; word-break: break-all; }
.chain { display: inline-flex; gap: 6px; align-items: center; font-weight: 600; font-family: system-ui, sans-serif; font-size: 14px; }
.chain.ok { color: var(--ok); } .chain.bad { color: var(--bad); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 600; font-size: 12px; color: var(--muted); padding: 0 10px 8px 0; border-bottom: 1px solid var(--line); }
td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--line); vertical-align: baseline; }
td.seq, td.t { font: 12.5px var(--mono); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
td.ev { font: 600 13px var(--mono); white-space: nowrap; }
td.ev .kind { display: inline-block; width: 8px; height: 8px; margin: 0 9px 1px 0; background: var(--muted); vertical-align: middle; }
tr.model td.ev .kind { border-radius: 50%; }
tr.tool td.ev .kind { border-radius: 1px; background: transparent; box-shadow: inset 0 0 0 1.5px var(--muted); }
tr.run td.ev .kind { transform: rotate(45deg) scale(0.85); }
tr.other td.ev .kind { height: 2px; margin-bottom: 3px; }
tr.refused td.ev .kind { width: 0; height: 0; background: none; border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 9px solid var(--warn-ink); }
tr.refused td.ev { color: var(--warn-ink); }
tr.refused { background: var(--warn-bg); box-shadow: inset 3px 0 var(--warn-ink); }
th:first-child, td:first-child { padding-left: 12px; }
.outcome { font-family: system-ui, sans-serif; font-size: 14px; }
.outcome.refused, .outcome.failed { color: var(--warn-ink); font-weight: 600; }
.outcome.none { color: var(--muted); }
.chain.none { color: var(--muted); font-weight: 400; }
.legend { display: flex; gap: 6px 16px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); margin: 0 0 10px; }
.legend span { display: inline-flex; align-items: center; }
.legend .kind { display: inline-block; width: 7px; height: 7px; margin-right: 7px; background: var(--muted); }
.legend .model .kind { border-radius: 50%; }
.legend .tool .kind { background: transparent; box-shadow: inset 0 0 0 1.5px var(--muted); border-radius: 1px; }
.legend .run .kind { transform: rotate(45deg) scale(0.85); }
.legend .refused .kind { width: 0; height: 0; background: none; border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 9px solid var(--warn-ink); }
.legend[hidden] { display: none; }
.note { color: var(--muted); font-size: 13px; margin-top: 16px; max-width: 70ch; }
.state { color: var(--muted); font-size: 14.5px; padding: 18px 0; }
.state.err { color: var(--bad); }
.state[hidden], table[hidden] { display: none; }
@media (max-width: 640px) {
  h1 { font-size: 23px; }
  .top { margin-top: 28px; }
  .summary { grid-template-columns: 1fr 1fr; }
  .stat:last-child:nth-child(odd) { grid-column: span 2; }
  dl { grid-template-columns: 1fr; gap: 0; }
  dt { font-size: 12.5px; }
  dd { margin-bottom: 10px; }
  thead { display: none; }
  table, tbody { display: block; }
  tr { display: grid; grid-template-columns: 5ch 10ch 1fr; grid-template-areas: "ev ev cls" "detail detail detail" "seq t ."; gap: 3px 10px; padding: 11px 0; border-bottom: 1px solid var(--line); }
  tr td.detail, tr td.seq { padding-left: 16px; }
  tr.refused { margin: 0 -20px; padding: 11px 20px; }
  td, td:first-child { display: block; padding: 0; border: 0; }
  td.ev { grid-area: ev; white-space: normal; overflow-wrap: anywhere; }
  td.cls { grid-area: cls; justify-self: end; }
  td.detail { grid-area: detail; overflow-wrap: anywhere; }
  td.seq { grid-area: seq; font-size: 12px; }
  td.seq::before { content: "#"; }
  td.t { grid-area: t; font-size: 12px; }
}
</style>
</head>
<body>
<div class="shell">
  <header><a class="wordmark" href="/">Aliquot</a><nav><a href="/">Ask the lab</a><span class="where" style="color:var(--muted)">Read only</span></nav></header>
  <div class="top">
    <div><h1>Run record</h1><p class="when" id="when"></p></div>
    <a class="dl" id="download" hidden><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></svg>Download JSON</a>
  </div>
  <section class="summary" id="summary" aria-label="Summary" hidden></section>
  <dl id="facts"></dl>
  <p class="state" id="state" role="status">Loading the record…</p>
  <p class="legend" id="legend" hidden><span class="run"><i class="kind"></i>Run</span><span class="model"><i class="kind"></i>Model call</span><span class="tool"><i class="kind"></i>Tool call</span><span class="refused"><i class="kind"></i>Refused or withheld</span><span>Labels: D0 public, D1 internal, D2 confidential, D3 restricted</span></p>
  <table id="table" hidden><thead><tr><th>#</th><th>Time</th><th>Event</th><th>Label</th><th>Detail</th></tr></thead><tbody id="rows"></tbody></table>
  <p class="note">Bodies are encrypted in the payload store and never shown here. The label is the data class of the event row; a refusal names the class of what it refused. Each event's hash covers the one before it, so an edited or deleted event breaks the chain from that point on.</p>
</div>
<script type="module">
const runId = ${JSON.stringify(runId)};
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
let v;
try {
  const res = await fetch("/runs/" + runId + "/view");
  if (!res.ok) throw new Error(res.status === 404 ? "No run has the id " + runId + "." : "The web door answered " + res.status + ".");
  v = await res.json();
} catch (err) {
  $("state").className = "state err";
  $("state").setAttribute("role", "alert");
  $("state").textContent = err instanceof TypeError ? "The web door did not answer. Is it running?" : err.message;
  throw err;
}
if (v.rows.length) {
  $("state").hidden = true;
  $("table").hidden = false;
  $("legend").hidden = false;
  const dl = $("download");
  dl.href = "/runs/" + runId + "/view";
  dl.download = "aliquot-run-" + runId + ".json";
  dl.hidden = false;
} else {
  $("state").textContent = "No run with the id " + runId + " has recorded any events. A run sent a moment ago shows its first event within a second; otherwise check the Record link. ";
  const back = el("a", "", "Back to the chat");
  back.href = "/";
  $("state").append(back);
}
if (v.startedAt) $("when").textContent = "Started " + new Date(v.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
const ms = (n) => (n < 1000 ? n + " ms" : (n / 1000).toFixed(n < 10000 ? 1 : 0) + " s");
const stat = (k, v, sub, warn) => {
  const c = el("div", "stat" + (warn ? " warn" : ""));
  c.append(el("div", "k", k));
  const val = el("div", "v"); typeof v === "string" ? (val.textContent = v) : val.append(...v); c.append(val);
  if (sub) c.append(el("div", "s", sub));
  $("summary").append(c);
};
if (v.chain.events) {
  const s = v.summary;
  const bad = v.outcome === "refused" || v.outcome === "failed" || v.outcome === "faulted";
  const om = el("span", "mark", bad ? "\u2298" : v.outcome === "running" ? "\u2026" : "\u2713"); om.setAttribute("aria-hidden", "true");
  stat("Outcome", [om, v.outcome], null, bad);
  stat("Time", ms(s.ms));
  const tok = el("small", "", " in, " + s.tokens.output + " out");
  stat("Model calls", String(s.modelCalls), s.modelCalls ? null : "nothing sent to a model");
  stat("Tokens", [String(s.tokens.input), tok]);
  stat("Tool calls", String(s.toolCalls.reduce((a, t) => a + t.calls, 0)), s.toolCalls.map((t) => t.calls > 1 ? t.tool + " \u00d7" + t.calls : t.tool).join(", ") || null);
  stat("Entries retrieved", String(s.entriesRetrieved));
  const blocked = s.refused + s.withheld;
  stat("Refused", String(blocked), s.withheld ? plural(s.withheld, "result") + " withheld" : null, blocked > 0);
  $("summary").hidden = false;
}
const fact = (k, val) => { $("facts").append(el("dt", "", k)); const d = el("dd"); typeof val === "string" ? (d.textContent = val) : d.append(val); $("facts").append(d); };
fact("Run", v.runId);
if (v.agent) fact("Agent version", v.agent);
const cm = (ok) => { const m = el("span", "", ok ? "\u2713" : "\u2717"); m.setAttribute("aria-hidden", "true"); return m; };
if (v.chain.events === 0) fact("Chain", el("span", "chain none", "Nothing to verify yet"));
else { const c = el("span", "chain " + (v.chain.firstBad === null ? "ok" : "bad")); c.append(cm(v.chain.firstBad === null), v.chain.firstBad === null ? "Verified: chain intact over " + v.chain.events + " events" : "Chain broken at event " + v.chain.firstBad); fact("Chain", c); }
const CLASS_NAMES = { D0: "D0, public", D1: "D1, internal", D2: "D2, confidential", D3: "D3, restricted", R: "R, review-confidential" };
const kindOf = (t, refused) => refused ? "refused" : t.startsWith("model.") ? "model" : t.startsWith("tool.") ? "tool" : t.startsWith("run.") ? "run" : "other";
for (const r of v.rows) {
  const tr = el("tr", kindOf(r.t, r.refused));
  const ev = el("td", "ev"); const k = el("i", "kind"); k.setAttribute("aria-hidden", "true"); ev.append(k, r.t);
  tr.append(el("td", "seq", String(r.seq)), el("td", "t", "+" + r.ms + " ms"), ev);
  const cls = el("td", "cls"); const pill = el("span", "pill " + String(r.cls).toLowerCase(), r.cls); pill.title = CLASS_NAMES[r.cls] || r.cls; cls.append(pill); tr.append(cls);
  tr.append(el("td", "detail", r.detail));
  $("rows").append(tr);
}
</script>
</body>
</html>`;
}
