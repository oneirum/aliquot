/**
 * Reading a source from the chat. An answer ends with the path of the entry it used ("Source: <path>"); the chat's
 * Source chip opens that entry here, from the knowledge base snapshots the run's record says it retrieved from, so the
 * page shows the entry as the answer read it, not as the knowledge base reads today. The page also says whether the
 * record shows the run retrieving that very entry, by its hash.
 *
 *   GET /runs/:id/source?path=       the read-only entry page
 *   GET /runs/:id/source.json?path=  what the chip shows: title, class, and whether this person may open it
 *
 * Who may open an entry is mayPreview at the snapshot's class: below D3 every member, at D3 and R the data steward or
 * the PI. The door checks that the run is the person's own before either route runs.
 */

import type { KbReader, HashedEntry } from "../kb.ts";
import type { SnapshotId } from "../hash.ts";
import type { DataClass } from "../dataclass.ts";
import type { StoredEvent } from "../record.ts";
import { mayPreview, whoMayPreview, type Role } from "../roles.ts";
import { APP_HEAD } from "./web-app.ts";
import { BASE_CSS, escapeHtml, header, PAGE_CSS } from "./web-pages.ts";

export type CitedEntry =
  | { readonly t: "entry"; readonly kb: string; readonly snapshot: SnapshotId; readonly cls: DataClass; readonly entry: HashedEntry; readonly retrieved: boolean }
  | { readonly t: "missing"; readonly path: string };

/** The first snapshot the run retrieved from that has an entry at path. */
export async function citedEntry(events: readonly StoredEvent[], path: string, kb: KbReader): Promise<CitedEntry> {
  const retrieved = new Map<SnapshotId, Set<string>>();
  for (const e of events) {
    if (e.event.t !== "tool.completed") continue;
    for (const r of e.event.retrieved ?? []) {
      const hashes = retrieved.get(r.snapshot) ?? new Set<string>();
      for (const h of r.entries) hashes.add(h);
      retrieved.set(r.snapshot, hashes);
    }
  }
  for (const [snapshot, hashes] of retrieved) {
    if (!(await kb.has(snapshot))) continue;
    const read = await kb.read(snapshot, [path], Number.MAX_SAFE_INTEGER);
    const entry = read.value.entries[0];
    if (!entry) continue;
    const outline = await kb.outline(snapshot);
    return { t: "entry", kb: outline.value.title, snapshot, cls: read.cls, entry, retrieved: hashes.has(entry.hash) };
  }
  return { t: "missing", path };
}

export type SourceChip =
  | { readonly path: string; readonly found: true; readonly title: string; readonly kb: string; readonly cls: DataClass; readonly retrieved: boolean; readonly open: boolean; readonly who: string }
  | { readonly path: string; readonly found: false };

/** What the chip needs, and nothing of the entry's text. */
export function sourceChip(cited: CitedEntry, role: Role): SourceChip {
  if (cited.t === "missing") return { path: cited.path, found: false };
  return { path: cited.entry.path, found: true, title: cited.entry.title, kb: cited.kb, cls: cited.cls, retrieved: cited.retrieved, open: mayPreview(role, cited.cls), who: whoMayPreview(cited.cls) };
}

const hex = (h: string) => h.replace(/^sha256:/, "").slice(0, 16).replace(/(.{4})(?!$)/g, "$1 ");

/** Paragraphs, "- " lists and "#" headings, every piece of text escaped. */
function body(text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${escapeHtml(li)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const block of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    for (const line of block.split("\n")) {
      const item = /^\s*[-*]\s+(.*)$/.exec(line);
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (item) list.push(item[1]!);
      else if (heading) {
        flush();
        out.push(`<h2>${escapeHtml(heading[1]!)}</h2>`);
      } else if (line.trim()) {
        flush();
        out.push(`<p>${escapeHtml(line.trim())}</p>`);
      }
    }
    flush();
  }
  return out.join("\n");
}

/** The status the door answers with: the entry, a refusal by class, or no such entry. */
export function sourceStatus(cited: CitedEntry, role: Role): 200 | 403 | 404 {
  return cited.t === "missing" ? 404 : mayPreview(role, cited.cls) ? 200 : 403;
}

export function sourcePage(runId: string, cited: CitedEntry, role: Role, where = ""): string {
  const record = `/runs/${escapeHtml(runId)}`;
  let main: string;
  if (cited.t === "missing") {
    main = `<h1>Not an entry</h1>
<p class="lede">The answer names <code>${escapeHtml(cited.path)}</code>, but no knowledge base this run read has an entry at that path. The record shows what the run did read.</p>`;
  } else if (!mayPreview(role, cited.cls)) {
    main = `<p class="from">${escapeHtml(cited.kb)} <span class="pill ${cited.cls.toLowerCase()}">${cited.cls}</span></p>
<h1>${escapeHtml(cited.entry.title)}</h1>
<p class="lede">This entry is ${cited.cls}, restricted. Members cannot open ${cited.cls} entries; ${whoMayPreview(cited.cls)} can. Ask them, or read what this run did in its record.</p>`;
  } else {
    const check = cited.retrieved
      ? `<p class="check ok"><span aria-hidden="true">✓</span> Retrieved by this run: the record holds this entry's hash, <code>${hex(cited.entry.hash)}</code></p>`
      : `<p class="check bad"><span aria-hidden="true">▲</span> Not retrieved by this run: the answer names this entry, but the record holds no read of hash <code>${hex(cited.entry.hash)}</code></p>`;
    main = `<p class="from">${escapeHtml(cited.kb)} <span class="pill ${cited.cls.toLowerCase()}">${cited.cls}</span> <code>${escapeHtml(cited.entry.path)}</code></p>
<h1>${escapeHtml(cited.entry.title)}</h1>
${check}
<article class="entry">${body(cited.entry.body)}</article>
<p class="snap">Snapshot <code>${escapeHtml(cited.snapshot.slice(0, 19))}</code>, as this run read it. Read only.</p>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${cited.t === "entry" ? `${escapeHtml(cited.entry.title)} · ` : ""}Source · Aliquot</title>
${APP_HEAD}
<style>${BASE_CSS}${PAGE_CSS}
.read { max-width: 680px; margin: 0 auto; padding: 32px 0 0; }
.back { display: flex; gap: 16px; flex-wrap: wrap; font-size: 14px; margin: 0 0 28px; }
.from { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--muted); font-size: 14px; margin: 0 0 8px; }
.from code, .lede code, .check code, .snap code { font: 12.5px var(--mono); }
.from code { color: var(--muted); }
.lede { color: var(--ink-2); font-size: 16px; margin: 14px 0 0; }
.check { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 14px; font-weight: 550; margin: 14px 0 0; }
.check.ok { color: var(--held); } .check.bad { color: var(--broken); }
.entry { margin: 28px 0 0; padding: 24px 0 0; border-top: 1px solid var(--line); font-size: 16.5px; line-height: 1.65; }
.entry p, .entry ul { margin: 0 0 14px; }
.entry h2 { font-size: 17px; font-weight: 620; margin: 22px 0 8px; letter-spacing: -0.01em; }
.snap { color: var(--muted); font-size: 13px; margin: 28px 0 0; padding-top: 16px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<div class="shell">
  ${header("record", where)}
  <main class="read">
    <nav class="back" aria-label="Back"><a href="/">Back to the chat</a><a href="${record}">Open the record</a></nav>
    ${main}
  </main>
</div>
</body>
</html>`;
}
