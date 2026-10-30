// Just enough of a JATS reader for Europe PMC's open-access full text: the article title, the abstract, the license,
// and the body as headed sections of plain text. Tables, figures, formulas and supplementary material are left out,
// because their text read inline is noise. Citation markers stay as the publisher writes them, for example "[1,2]".

import { decodeXml } from "./atom.ts";

export interface JatsSection {
  /** The section's title path, outermost first: "2. Methods / 2.1. Participants". "Body" for text outside any section. */
  readonly heading: string;
  readonly text: string;
}

export interface JatsArticle {
  readonly title: string;
  readonly abstract: string;
  /** The license URL when the article names one, else the license statement, else null. */
  readonly license: string | null;
  readonly sections: readonly JatsSection[];
}

const SKIPPED: ReadonlySet<string> = new Set(["table-wrap", "fig", "fig-group", "disp-formula", "inline-formula", "mml:math", "supplementary-material", "graphic", "media", "alternatives"]);

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>|([^<]+)/g;

type Token = { readonly t: "open" | "close"; readonly name: string } | { readonly t: "text"; readonly text: string };

function* tokens(xml: string): Generator<Token> {
  for (const m of xml.matchAll(TOKEN)) {
    if (m[1] !== undefined) yield { t: "text", text: m[1] };
    else if (m[5] !== undefined) yield { t: "text", text: decodeXml(m[5]) };
    else if (m[3] !== undefined) {
      if (m[2]) yield { t: "close", name: m[3] };
      else {
        yield { t: "open", name: m[3] };
        if (m[4]) yield { t: "close", name: m[3] };
      }
    }
  }
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function element(xml: string, tag: string): string | null {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? null;
}

/** The text of a fragment with the skipped elements removed. Paragraphs and titles are separated by a space. */
function plain(fragment: string): string {
  let skip = 0;
  let out = "";
  for (const tok of tokens(fragment)) {
    if (tok.t === "text") {
      if (!skip) out += tok.text;
    } else if (SKIPPED.has(tok.name)) skip += tok.t === "open" ? 1 : -1;
    else if (tok.name === "p" || tok.name === "title") out += " ";
  }
  return squash(out);
}

function body(xml: string): JatsSection[] {
  const fragment = element(xml, "body");
  if (fragment === null) return [];
  const sections = new Map<string, string[]>();
  const path: string[] = [];
  const stack: string[] = [];
  let skip = 0;
  let title: string | null = null;
  let para: string | null = null;
  let paraDepth = 0;
  for (const tok of tokens(fragment)) {
    if (tok.t === "text") {
      if (skip) continue;
      if (title !== null) title += tok.text;
      else if (para !== null) para += tok.text;
      continue;
    }
    if (SKIPPED.has(tok.name)) {
      skip += tok.t === "open" ? 1 : -1;
      continue;
    }
    if (skip) continue;
    if (tok.t === "open") {
      if (tok.name === "sec") path.push("");
      else if (tok.name === "title" && stack.at(-1) === "sec") title = "";
      else if (tok.name === "p") {
        if (paraDepth++ === 0) para = "";
        else para += " ";
      }
      stack.push(tok.name);
      continue;
    }
    stack.pop();
    if (tok.name === "sec") path.pop();
    else if (tok.name === "title" && title !== null) {
      path[path.length - 1] = squash(title);
      title = null;
    } else if (tok.name === "p" && --paraDepth === 0 && para !== null) {
      const text = squash(para);
      para = null;
      if (!text) continue;
      const heading = path.filter(Boolean).join(" / ") || "Body";
      sections.set(heading, [...(sections.get(heading) ?? []), text]);
    }
  }
  return [...sections].map(([heading, paras]) => ({ heading, text: paras.join("\n\n") }));
}

export function parseJats(xml: string): JatsArticle {
  const front = element(xml, "front") ?? "";
  const license = element(front, "license");
  const licenseUrl = license === null ? null : (element(license, "ali:license_ref") ?? /xlink:href="([^"]+)"/.exec(/<license\s[^>]*>/.exec(front)?.[0] ?? "")?.[1] ?? null);
  return {
    title: plain(element(front, "article-title") ?? ""),
    abstract: plain(/<abstract(?:\s(?![^>]*abstract-type="graphical")[^>]*)?>([\s\S]*?)<\/abstract>/.exec(front)?.[1] ?? ""),
    license: licenseUrl ? squash(decodeXml(licenseUrl)) : license === null ? null : plain(license) || null,
    sections: body(xml),
  };
}
