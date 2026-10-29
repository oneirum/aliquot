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
    --warn-bg: #2b2215; --warn-line: #5a4522; --warn-ink: #f0d7a6;
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
.a { max-width: 92%; white-space: pre-wrap; }
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
.banner { border: 1px solid var(--warn-line); background: var(--warn-bg); color: var(--warn-ink); border-radius: 12px; padding: 12px 14px; max-width: 92%; }
.banner strong { display: block; font-weight: 650; margin-bottom: 2px; }
.banner p { margin: 0; font-size: 14.5px; }
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
// Models answer in Markdown. Bold, italic and code become elements; everything else stays text, so nothing is parsed as HTML.
function answer(text) {
  const a = el("div", "a");
  for (const part of text.split(/(\\*\\*[^*\\n]+\\*\\*|\\*[^*\\s][^*\\n]*\\*|\`[^\`\\n]+\`)/)) {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) a.append(el("strong", "", part.slice(2, -2)));
    else if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) a.append(el("em", "", part.slice(1, -1)));
    else if (part.length > 2 && part.startsWith("\`") && part.endsWith("\`")) a.append(el("code", "", part.slice(1, -1)));
    else if (part) a.append(part);
  }
  return a;
}
const REFUSAL = {
  "class-above-ceiling": (r) => "This message is " + r.payload + ", and this agent's model may receive at most " + r.ceiling + ".",
  "destination-receives-nothing": (r) => "This destination may not hold " + r.payload + " data at all.",
  "review-confidential-refused": () => "Review-confidential content is refused by lab policy.",
  "review-confidential-needs-lab": () => "Review-confidential content may only go to models on lab hardware.",
  "host-not-declared": (r) => "Host " + r.host + " is not in the tool's egress list.",
};

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
.shell { max-width: 920px; margin: 0 auto; padding: 0 20px 64px; }
header { display: flex; align-items: baseline; justify-content: space-between; padding: 22px 0 14px; border-bottom: 1px solid var(--line); }
header .where { font-size: 13px; color: var(--muted); }
h1 { font-size: 26px; letter-spacing: -0.02em; line-height: 1.15; margin: 36px 0 6px; font-weight: 650; }
.sub { color: var(--muted); margin: 0 0 22px; font-size: 14.5px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; margin: 0 0 26px; font-size: 14px; }
dt { color: var(--muted); }
dd { margin: 0; font-family: var(--mono); font-size: 13px; word-break: break-all; }
.chain { display: inline-flex; gap: 8px; align-items: center; font-weight: 600; font-family: system-ui, sans-serif; font-size: 14px; }
.chain.ok { color: var(--ok); } .chain.bad { color: var(--bad); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 600; font-size: 12px; color: var(--muted); padding: 0 10px 8px 0; border-bottom: 1px solid var(--line); }
td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
td.seq, td.t { font: 12.5px var(--mono); color: var(--muted); white-space: nowrap; }
td.ev { font: 600 13px var(--mono); white-space: nowrap; }
tr.refused td.ev { color: var(--warn-ink); }
tr.refused { background: var(--warn-bg); }
.note { color: var(--muted); font-size: 13px; margin-top: 16px; }
</style>
</head>
<body>
<div class="shell">
  <header><a class="wordmark" href="/">Aliquot</a><span class="where">Read only</span></header>
  <h1>Run record</h1>
  <p class="sub">Every model call, tool call and refusal in this run, in order. Bodies are encrypted in the payload store and are not shown here. The label is the class of the event row itself; a refusal names the class of what it refused.</p>
  <dl id="facts"></dl>
  <table><thead><tr><th>#</th><th>Time</th><th>Event</th><th>Label</th><th>Detail</th></tr></thead><tbody id="rows"></tbody></table>
  <p class="note">Each event's hash covers the one before it, so an edited or deleted event breaks the chain from that point on.</p>
</div>
<script type="module">
const runId = ${JSON.stringify(runId)};
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
const v = await fetch("/runs/" + runId + "/view").then((r) => r.json());
const fact = (k, val) => { $("facts").append(el("dt", "", k)); const d = el("dd"); typeof val === "string" ? (d.textContent = val) : d.append(val); $("facts").append(d); };
fact("Run", v.runId);
if (v.agent) fact("Agent version", v.agent);
fact("Outcome", v.outcome);
fact("Chain", el("span", "chain " + (v.chain.firstBad === null ? "ok" : "bad"), v.chain.firstBad === null ? "Verified: chain intact over " + v.chain.events + " events" : "Chain broken at event " + v.chain.firstBad));
for (const r of v.rows) {
  const tr = el("tr", r.refused ? "refused" : "");
  tr.append(el("td", "seq", String(r.seq)), el("td", "t", "+" + r.ms + " ms"), el("td", "ev", r.t));
  const cls = el("td"); cls.append(el("span", "pill " + String(r.cls).toLowerCase(), r.cls)); tr.append(cls);
  tr.append(el("td", "", r.detail));
  $("rows").append(tr);
}
</script>
</body>
</html>`;
}
