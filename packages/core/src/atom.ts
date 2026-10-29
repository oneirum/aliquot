// Just enough of an Atom reader for export.arxiv.org: each <entry>, its direct text fields, its authors and the
// primary category. arXiv's feed has no CDATA and no nested entries, so a regex walk over the elements is exact here.

export interface AtomEntry {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly published: string;
  readonly authors: readonly string[];
  readonly primaryCategory: string | null;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

const text = (s: string) => decode(s).replace(/\s+/g, " ").trim();

function field(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? text(m[1]!) : "";
}

export function parseAtom(xml: string): AtomEntry[] {
  return [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)].map(([, body]) => ({
    id: field(body!, "id"),
    title: field(body!, "title"),
    summary: field(body!, "summary"),
    published: field(body!, "published"),
    authors: [...body!.matchAll(/<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/g)].map(([, a]) => field(a!, "name")),
    primaryCategory: /<arxiv:primary_category\s[^>]*term="([^"]*)"/.exec(body!)?.[1] ?? null,
  }));
}
