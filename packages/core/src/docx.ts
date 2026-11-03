/**
 * Word (.docx) sources: the text of word/document.xml as Markdown, so a lab
 * can compile the handbook it already keeps in Word. A .docx is a zip; this
 * reads the central directory, inflates the two parts it needs and walks the
 * WordprocessingML tags. No dependency, nothing written to disk.
 *
 * Kept: paragraphs, headings (by the style's name, so a localized style id
 * still maps), list items, line breaks, tabs and tables as Markdown rows.
 * Dropped: deleted tracked changes, field codes, images, comments, headers
 * and footers. Inserted tracked changes count as text.
 */

import { inflateRawSync } from "node:zlib";

/** A part larger than this inflated is refused: a handbook is not 64 MB of XML. */
const MAX_PART = 64 * 1024 * 1024;

export function docxToMarkdown(bytes: Uint8Array, name = "document"): string {
  const parts = zipParts(bytes, name);
  const doc = parts.get("word/document.xml");
  if (!doc) throw new Error(`${name}: not a Word document (no word/document.xml); save it as .docx from Word or export it as Markdown`);
  const styles = parts.get("word/styles.xml");
  return wordXmlToMarkdown(inflate(doc, name), styles ? headingStyles(inflate(styles, name)) : new Map());
}

interface Entry {
  readonly method: number;
  readonly size: number;
  readonly data: Uint8Array;
}

function zipParts(bytes: Uint8Array, name: string): Map<string, Entry> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = (why: string) => new Error(`${name}: not a readable .docx (${why})`);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad("no zip directory");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw bad("broken zip directory");
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const skip = nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + skip;
    if (path !== "word/document.xml" && path !== "word/styles.xml") continue;
    if (csize === 0xffffffff || local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw bad(`cannot read ${path}`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (start + csize > bytes.length) throw bad(`${path} is cut short`);
    out.set(path, { method, size, data: bytes.subarray(start, start + csize) });
  }
  return out;
}

function inflate(e: Entry, name: string): string {
  if (e.size > MAX_PART) throw new Error(`${name}: a part inflates to ${e.size} bytes, over the ${MAX_PART} byte limit`);
  if (e.method === 0) return new TextDecoder().decode(e.data);
  if (e.method !== 8) throw new Error(`${name}: zip compression method ${e.method} is not supported`);
  return new TextDecoder().decode(inflateRawSync(e.data, { maxOutputLength: MAX_PART }));
}

/** styleId -> heading level, from each style's name ("heading 1" to "heading 6", "Title"). */
function headingStyles(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const styleName = /<w:name\b[^>]*w:val="([^"]+)"/.exec(m[2]!)?.[1]?.toLowerCase();
    if (!styleName) continue;
    const level = styleName === "title" ? 1 : Number(/^heading ([1-6])$/.exec(styleName)?.[1] ?? 0);
    if (level) out.set(m[1]!, level);
  }
  return out;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()]!));

export function wordXmlToMarkdown(xml: string, headings: ReadonlyMap<string, number> = new Map()): string {
  const lines: string[] = [];
  let para: string | null = null;
  let style = "";
  let list = false;
  let inText = false;
  let row: string[] | null = null;
  let cell: string[] | null = null;
  let tableDepth = 0;
  let rows = 0;
  for (const m of xml.matchAll(/<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g)) {
    const [, close, tag, attrs, selfClose, text] = m;
    if (text !== undefined) {
      if (inText && para !== null) para += decode(text);
      continue;
    }
    if (tag === "w:t") inText = !close && !selfClose;
    else if (tag === "w:p" && !close && !selfClose) { para = ""; style = ""; list = false; }
    else if (tag === "w:p" && (close || selfClose)) {
      const t = (para ?? "").replace(/[ \t]+$/gm, "").trim();
      if (cell) { if (t) cell.push(t.replace(/\n/g, " ")); }
      else if (t) {
        const level = Math.min(headings.get(style) ?? Number(/^Heading([1-6])$/i.exec(style)?.[1] ?? 0), 6);
        lines.push(level ? `${"#".repeat(level)} ${t}` : list ? `- ${t}` : t, "");
      }
      para = null;
    }
    else if (tag === "w:pStyle") style = /w:val="([^"]*)"/.exec(attrs!)?.[1] ?? "";
    else if (tag === "w:numPr" && !close) list = true;
    else if ((tag === "w:br" || tag === "w:cr") && para !== null) para += "\n";
    else if (tag === "w:tab" && para !== null && !close) para += "\t";
    else if (tag === "w:tbl") {
      tableDepth += close ? -1 : 1;
      if (!close && tableDepth === 1) rows = 0;
      if (close && tableDepth === 0) lines.push("");
    }
    else if (tag === "w:tr" && tableDepth === 1) {
      if (!close) row = [];
      else if (row) {
        lines.push(`| ${row.join(" | ")} |`);
        if (rows++ === 0) lines.push(`|${" --- |".repeat(row.length)}`);
        row = null;
      }
    }
    else if (tag === "w:tc" && tableDepth === 1) {
      if (!close) cell = [];
      else if (cell) { row?.push(cell.join(" ").replace(/\|/g, "\\|")); cell = null; }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
