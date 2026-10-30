/**
 * The literature tools v0.3 adds: Europe PMC search and open-access full text, DOI lookup through Crossref and
 * Unpaywall, and citation walks through OpenAlex. Each is a built-in like the three in tools.ts: it reaches only the
 * public hosts its manifest names, through ctx.fetch, so a question above D0 sends nothing.
 */

import { z } from "zod";
import { ABSTRACT_CHARS, defineTool, ToolInputError, type ToolContext } from "./tools.ts";
import { parseJats, type JatsSection } from "./jats.ts";
import { decodeXml } from "./atom.ts";

/** About 6,000 tokens: one long article section, or a short article whole. */
export const FULLTEXT_CHARS = 24_000;
/** The longest response body a literature tool reads. A whole open-access article is usually under 1 MB. */
export const MAX_BODY_BYTES = 4_000_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Removes tag-shaped markup only, so "P < 0.001 and BMI > 30" keeps its text, then decodes entities. */
export const plainText = (s: string) => decodeXml(s.replace(/<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g, " ")).replace(/\s+/g, " ").trim();

async function bodyText(res: Response, source: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    await res.body?.cancel();
    throw new ToolInputError(`${source} sent ${declared} bytes, more than the ${MAX_BODY_BYTES} a literature tool reads`);
  }
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new ToolInputError(`${source} sent more than the ${MAX_BODY_BYTES} bytes a literature tool reads`);
  return text;
}
const bodyJson = async <T>(res: Response, source: string): Promise<T> => JSON.parse(await bodyText(res, source)) as T;

/** Sends a GET through ctx.fetch and maps the status: `final` statuses become input errors the agent should not retry. */
async function get(ctx: ToolContext, source: string, url: string, final: Readonly<Record<number, string>> = {}): Promise<Response> {
  const res = await ctx.fetch(url, { signal: ctx.signal, headers: { accept: "application/json, application/xml;q=0.9" } });
  if (res.ok) return res;
  await res.body?.cancel();
  // A 400 or 422 means the host refused the identifier as malformed; sending it again gets the same answer.
  const why = final[res.status] ?? (res.status === 400 || res.status === 422 ? `${source} refused the request as malformed (${res.status})` : undefined);
  if (why) throw new ToolInputError(why);
  throw new Error(`${source} returned ${res.status}`);
}

/** "https://doi.org/10.1/x", "doi:10.1/x" and "10.1/x" all give "10.1/x"; anything else is refused. */
export function normalizeDoi(raw: string): string {
  const doi = raw.trim().replace(/^(?:https?:\/\/(?:dx\.|www\.)?doi\.org\/|doi:\s*)/i, "");
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new ToolInputError(`${raw} is not a DOI; a DOI starts with 10. and a slash, as in 10.1038/nature14539`);
  return doi;
}

const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";

interface EpmcResult {
  readonly id: string;
  readonly source: string;
  readonly pmid?: string;
  readonly pmcid?: string;
  readonly doi?: string;
  readonly title?: string;
  readonly authorString?: string;
  readonly pubYear?: string;
  readonly journalInfo?: { readonly journal?: { readonly title?: string } };
  readonly bookOrReportDetails?: { readonly publisher?: string };
  readonly abstractText?: string;
  readonly isOpenAccess?: string;
  readonly inEPMC?: string;
  readonly license?: string;
  readonly citedByCount?: number;
}

export const europepmcSearch = defineTool({
  name: "europepmc_search",
  description:
    "Search Europe PMC: PubMed, PubMed Central and preprints from bioRxiv, medRxiv and others. Returns ids, title, the first three authors, journal or preprint server, year, citation count, whether it is open access, and the start of the abstract. A hit with fullText true can be read with europepmc_fulltext. Accepts Europe PMC query syntax. Use for biomedical and life-science papers and preprints when you need abstracts or full text. Not for arXiv (use arxiv_search) or a known DOI (use doi_lookup).",
  input: z.object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(25).default(10),
    preprints: z.boolean().default(false).describe("Only preprints"),
  }),
  reads: "D0",
  effects: "read",
  egress: ["www.ebi.ac.uk"],
  idempotent: true,
  async run({ query, limit, preprints }, ctx) {
    const q = preprints ? `(${query}) AND SRC:PPR` : query;
    const res = await get(ctx, "Europe PMC", `${EPMC}/search?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${limit}`);
    const body = await bodyJson<{ hitCount?: number; resultList?: { result?: EpmcResult[] } }>(res, "Europe PMC");
    if (!Array.isArray(body.resultList?.result)) throw new Error("Europe PMC answered without a result list");
    return {
      hits: body.hitCount ?? 0,
      results: body.resultList.result.map((r) => {
        const authors = (r.authorString ?? "").replace(/\.$/, "").split(", ").filter(Boolean);
        const fullText = r.isOpenAccess === "Y" && r.inEPMC === "Y" && !!r.pmcid;
        return {
          id: r.id,
          source: r.source,
          ...(r.pmid ? { pmid: r.pmid } : {}),
          ...(r.pmcid ? { pmcid: r.pmcid } : {}),
          ...(r.doi ? { doi: r.doi } : {}),
          title: plainText(r.title ?? ""),
          authors: authors.length > 3 ? [...authors.slice(0, 3), "et al."] : authors,
          venue: r.journalInfo?.journal?.title ?? r.bookOrReportDetails?.publisher ?? null,
          year: r.pubYear ? Number(r.pubYear) : null,
          preprint: r.source === "PPR",
          openAccess: r.isOpenAccess === "Y",
          fullText,
          ...(r.license ? { license: r.license } : {}),
          citedBy: r.citedByCount ?? 0,
          abstract: clip(plainText(r.abstractText ?? ""), ABSTRACT_CHARS),
        };
      }),
    };
  },
});

export const europepmcFulltext = defineTool({
  name: "europepmc_fulltext",
  description: `Read an open-access article's full text from Europe PMC by its PMCID, as headed sections of plain text, with its license. Tables and figures are left out. The first call returns the outline and as many whole sections as fit in ${FULLTEXT_CHARS} characters, and a longer section is split into numbered parts; name sections or parts to read the rest. A named section includes its subsections. Use after europepmc_search returns fullText true. Not for articles that are not open access.`,
  input: z.object({
    pmcid: z.string().regex(/^PMC\d{1,10}$/, "a PMCID such as PMC1234567"),
    sections: z.array(z.string().min(1).max(200)).max(20).optional().describe("Headings, or parts of headings, from the outline"),
  }),
  reads: "D0",
  effects: "read",
  egress: ["www.ebi.ac.uk"],
  idempotent: true,
  async run({ pmcid, sections }, ctx) {
    const notOpen = `Europe PMC has no open-access full text for ${pmcid}. Only hits with fullText true in europepmc_search can be read.`;
    const res = await ctx.fetch(`${EPMC}/${pmcid}/fullTextXML`, { signal: ctx.signal });
    if (res.status === 404 || res.status === 500) {
      await res.body?.cancel();
      // Europe PMC answers 500, not 404, for a PMCID with no open-access text, and also when it fails. Its search tells the two apart.
      const check = await get(ctx, "Europe PMC", `${EPMC}/search?query=${encodeURIComponent(`PMCID:${pmcid}`)}&resultType=lite&format=json&pageSize=1`);
      const hit = (await bodyJson<{ resultList?: { result?: EpmcResult[] } }>(check, "Europe PMC")).resultList?.result?.find((r) => r.pmcid === pmcid);
      if (hit?.isOpenAccess === "Y") throw new Error(`Europe PMC answered ${res.status} for the open-access article ${pmcid}; try again later`);
      throw new ToolInputError(notOpen);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Europe PMC returned ${res.status}`);
    }
    const article = parseJats(await bodyText(res, "Europe PMC"));
    if (!article.title && !article.sections.length) throw new ToolInputError(notOpen);
    const all = article.sections.flatMap(parts);
    const chosen = sections ? named(all, sections) : all;
    if (!chosen.length) throw new ToolInputError(`no section of ${pmcid} matches ${sections!.join(", ")}; the outline lists the headings`);
    const read: JatsSection[] = [];
    const omitted: string[] = [];
    let used = 0;
    for (const s of chosen) {
      if (used + s.text.length <= FULLTEXT_CHARS) {
        read.push(s);
        used += s.text.length;
      } else omitted.push(s.heading);
    }
    return {
      pmcid,
      title: article.title,
      license: article.license,
      ...(sections ? {} : { abstract: clip(article.abstract, ABSTRACT_CHARS * 5) }),
      outline: all.map((s) => ({ heading: s.heading, chars: s.text.length })),
      sections: read,
      ...(omitted.length ? { omitted, note: `The read cap is ${FULLTEXT_CHARS} characters. Name the omitted sections to read them.` } : {}),
    };
  },
});

/** Splits a section longer than the read cap at paragraph breaks, so every part fits in one call and has a name. */
function parts(s: JatsSection): JatsSection[] {
  if (s.text.length <= FULLTEXT_CHARS) return [s];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of s.text.split("\n\n"))
    for (let i = 0; i < paragraph.length; i += FULLTEXT_CHARS) {
      const piece = paragraph.slice(i, i + FULLTEXT_CHARS);
      if (current && current.length + 2 + piece.length > FULLTEXT_CHARS) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  if (current) chunks.push(current);
  return chunks.map((text, i) => ({ heading: `${s.heading} (part ${i + 1} of ${chunks.length})`, text }));
}

/**
 * The sections a list of names asks for, in document order. A name matches a section's own title first, so
 * "discussion" is 3.4 and not every part of "Results and Discussion", then its whole heading. A matched section brings
 * its subsections: "methods" is 2 and 2.1 to 2.4.
 */
function named(all: readonly JatsSection[], names: readonly string[]): JatsSection[] {
  const wanted = names.map((n) => n.toLowerCase());
  const match = (key: (s: JatsSection) => string) => all.filter((s) => wanted.some((w) => key(s).toLowerCase().includes(w)));
  const own = match((s) => s.heading.split(" / ").at(-1)!);
  const roots = (own.length ? own : match((s) => s.heading)).map((s) => s.heading);
  return all.filter((s) => roots.some((h) => s.heading === h || s.heading.startsWith(`${h} / `)));
}

interface CrossrefWork {
  readonly DOI: string;
  readonly title?: readonly string[];
  readonly author?: readonly { readonly given?: string; readonly family?: string; readonly name?: string }[];
  readonly "container-title"?: readonly string[];
  readonly publisher?: string;
  readonly type?: string;
  readonly published?: { readonly "date-parts"?: readonly (readonly number[])[] };
  readonly "references-count"?: number;
  readonly "is-referenced-by-count"?: number;
  readonly license?: readonly { readonly URL: string }[];
}

interface UnpaywallLocation {
  readonly url?: string | null;
  readonly url_for_pdf?: string | null;
  readonly license?: string | null;
  readonly version?: string | null;
  readonly host_type?: string | null;
}

export const doiLookup = defineTool({
  name: "doi_lookup",
  description:
    "Look up one DOI: title, the first five authors, journal, publisher, type, publication date, reference and citation counts, and license links from Crossref, plus whether the work is open access and where a legal open copy is, from Unpaywall. Use when you have a DOI and need its record or a readable copy. Not for searching by topic.",
  input: z.object({ doi: z.string().min(6).max(300) }),
  reads: "D0",
  effects: "read",
  egress: ["api.crossref.org", "api.unpaywall.org"],
  idempotent: true,
  async run({ doi: raw }, ctx) {
    const doi = normalizeDoi(raw);
    const path = encodeURIComponent(doi);
    const mailto = ctx.contact ? `?mailto=${encodeURIComponent(ctx.contact)}` : "";
    const res = await get(ctx, "Crossref", `https://api.crossref.org/works/${path}${mailto}`, { 404: `Crossref has no record of ${doi}. A DOI from another agency, such as DataCite for datasets, is not covered.` });
    const w = (await bodyJson<{ message: CrossrefWork }>(res, "Crossref")).message;
    const date = w.published?.["date-parts"]?.[0];
    const authors = (w.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(" "));
    const record = {
      doi: w.DOI,
      title: plainText(w.title?.[0] ?? ""),
      authors: authors.length > 5 ? [...authors.slice(0, 5), "et al."] : authors,
      journal: w["container-title"]?.[0] ?? null,
      publisher: w.publisher ?? null,
      type: w.type ?? null,
      published: date?.length ? date.map((n, i) => (i ? String(n).padStart(2, "0") : String(n))).join("-") : null,
      references: w["references-count"] ?? null,
      citedBy: w["is-referenced-by-count"] ?? null,
      licenses: [...new Set((w.license ?? []).map((l) => l.URL))],
    };
    // Unpaywall requires a contact email on every request; without the lab's, it is not asked.
    if (!ctx.contact) return { ...record, openAccess: null, note: "Open-access status needs the lab's contact email ([research] contact_email_env); Unpaywall was not asked." };
    const oa = await ctx.fetch(`https://api.unpaywall.org/v2/${path}?email=${encodeURIComponent(ctx.contact)}`, { signal: ctx.signal });
    // The Crossref record stands on its own: an Unpaywall miss or failure costs only the open-access fields.
    if (!oa.ok) {
      await oa.body?.cancel();
      return { ...record, openAccess: null, note: oa.status === 404 ? "Unpaywall has no record of this DOI." : `Unpaywall answered ${oa.status}, so open-access status is unknown.` };
    }
    const u = (await bodyJson<unknown>(oa, "Unpaywall")) as { is_oa: boolean; oa_status: string; best_oa_location: UnpaywallLocation | null };
    const best = u.best_oa_location;
    return {
      ...record,
      openAccess: {
        isOpen: u.is_oa,
        status: u.oa_status,
        ...(best ? { url: best.url ?? null, pdfUrl: best.url_for_pdf ?? null, license: best.license ?? null, version: best.version ?? null, host: best.host_type ?? null } : {}),
      },
    };
  },
});

const OPENALEX = "https://api.openalex.org";
const WORK_FIELDS = "id,doi,title,publication_year,cited_by_count,abstract_inverted_index";
/** OpenAlex's limit on ids in one openalex_id filter. */
const IDS_PER_FILTER = 100;

interface OpenAlexWork {
  readonly id: string;
  readonly doi: string | null;
  readonly title: string | null;
  readonly publication_year: number | null;
  readonly cited_by_count: number;
  readonly abstract_inverted_index?: Readonly<Record<string, readonly number[]>> | null;
  readonly referenced_works?: readonly string[];
}

/** OpenAlex ships abstracts as word -> positions; this puts the words back in order. */
export function abstractFromIndex(index: Readonly<Record<string, readonly number[]>> | null | undefined): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return words.filter((w) => w !== undefined).join(" ");
}

function workSelector(raw: string): string {
  const id = /^(?:https?:\/\/openalex\.org\/)?(W\d{1,12})$/i.exec(raw.trim());
  return id ? id[1]!.toUpperCase() : `doi:${normalizeDoi(raw)}`;
}

const shortId = (id: string) => id.replace(/^https?:\/\/openalex\.org\//, "");

const summary = (w: OpenAlexWork) => ({
  id: shortId(w.id),
  title: w.title ?? "",
  year: w.publication_year,
  doi: w.doi,
  citedBy: w.cited_by_count,
  abstract: clip(abstractFromIndex(w.abstract_inverted_index), ABSTRACT_CHARS),
});

export const citationWalk = defineTool({
  name: "citation_walk",
  description:
    "Walk the citation graph from one work in OpenAlex: the works it cites (references) or the works that cite it (cited_by), most cited first, with year, DOI, citation count and the start of the abstract. Takes an OpenAlex id (W...) or a DOI. Use to find the papers a known paper builds on or the newer work that followed it. Not for keyword search (use openalex_search).",
  input: z.object({
    work: z.string().min(2).max(300).describe("An OpenAlex work id such as W2039959638, or a DOI"),
    direction: z.enum(["references", "cited_by"]),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  reads: "D0",
  effects: "read",
  egress: ["api.openalex.org"],
  idempotent: true,
  async run({ work, direction, limit }, ctx) {
    const mailto = ctx.contact ? `&mailto=${encodeURIComponent(ctx.contact)}` : "";
    const selector = workSelector(work);
    const res = await get(ctx, "OpenAlex", `${OPENALEX}/works/${encodeURIComponent(selector)}?select=id,doi,title,publication_year,cited_by_count,referenced_works${mailto}`, { 404: `OpenAlex has no work ${selector}` });
    const root = await bodyJson<OpenAlexWork>(res, "OpenAlex");
    const id = shortId(root.id);
    const head = { work: { id, title: root.title ?? "", year: root.publication_year, doi: root.doi }, direction, order: "most cited first" };
    let filter: string;
    let total: number;
    if (direction === "cited_by") {
      filter = `cites:${id}`;
      total = root.cited_by_count;
    } else {
      const refs = (root.referenced_works ?? []).map(shortId);
      if (!refs.length) return { ...head, total: 0, results: [], note: "OpenAlex lists no references for this work." };
      filter = `openalex_id:${refs.slice(0, IDS_PER_FILTER).join("|")}`;
      total = refs.length;
    }
    const list = await get(ctx, "OpenAlex", `${OPENALEX}/works?filter=${encodeURIComponent(filter)}&sort=cited_by_count:desc&per-page=${limit}&select=${WORK_FIELDS}${mailto}`);
    const body = await bodyJson<{ results?: OpenAlexWork[] }>(list, "OpenAlex");
    if (!Array.isArray(body.results)) throw new Error("OpenAlex answered without a result list");
    return {
      ...head,
      total,
      results: body.results.map(summary),
      ...(direction === "references" && total > IDS_PER_FILTER ? { note: `Only the first ${IDS_PER_FILTER} of ${total} references were ranked.` } : {}),
    };
  },
});
