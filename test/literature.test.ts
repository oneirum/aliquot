// The v0.3 literature tools, run through the tool runner against recorded responses. Every fixture is a whole live
// response from 2026-10-28, saved by the live smoke run (one call per tool, through ctx.fetch, with the lab contact set).
// A route that tests only a status (an outage, a 400) reuses a recorded body, because the tool reads no body there.
// The full-text article has its reference list cut to <ref-list/>: the tool never reads <back>, and the list's page
// numbers (an S and three digits) look like the release scan's internal ids.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeApi, type Route } from "./tool-harness.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { abstractFromIndex, citationWalk, doiLookup, europepmcFulltext, europepmcSearch, FULLTEXT_CHARS, plainText } from "../packages/core/src/literature.ts";
import { parseJats } from "../packages/core/src/jats.ts";

const fixture = (file: string, type = "application/json", status?: number): Route => ({ file: new URL(`./literature-fixtures/${file}`, import.meta.url), type, ...(status ? { status } : {}) });
const EPMC = "/europepmc/webservices/rest";
const CONTACT = { contact: "lab@example.edu" };

const epmc = await fakeApi({
  [`${EPMC}/search`]: fixture("europepmc-search.json"),
  [`${EPMC}/PMC13692515/fullTextXML`]: fixture("europepmc-fulltext.xml", "application/xml"),
  [`${EPMC}/PMC11750616/fullTextXML`]: fixture("europepmc-fulltext-500.json", "application/json", 500),
});
const preprints = await fakeApi({ [`${EPMC}/search`]: fixture("europepmc-search-preprints.json") });
// A closed article and an outage both answer 500 from fullTextXML; the PMCID search tells them apart.
const closed = await fakeApi({ [`${EPMC}/PMC11750616/fullTextXML`]: fixture("europepmc-fulltext-500.json", "application/json", 500), [`${EPMC}/search`]: fixture("europepmc-lite-closed.json") });
const outage = await fakeApi({ [`${EPMC}/PMC13692515/fullTextXML`]: fixture("europepmc-fulltext-500.json", "application/json", 500), [`${EPMC}/search`]: fixture("europepmc-lite-open.json") });
// One section of 30 paragraphs of 1,500 characters: longer than the read cap.
const longDir = mkdtempSync(join(tmpdir(), "aliquot-jats-"));
writeFileSync(join(longDir, "long.xml"), `<article><front><article-title>Long</article-title></front><body><sec><title>Results</title>${Array.from({ length: 30 }, (_, i) => `<p>${String(i).padStart(4, "0")}${"x".repeat(1496)}</p>`).join("")}</sec></body></article>`);
const long = await fakeApi({ [`${EPMC}/PMC1000001/fullTextXML`]: { file: pathToFileURL(join(longDir, "long.xml")), type: "application/xml" } });
const flaky = await fakeApi({ "/works/10.2147%2Fnss.s38369": fixture("crossref-work.json"), "/v2/10.2147%2Fnss.s38369": fixture("europepmc-fulltext-500.json", "application/json", 500), "/works/10.1234%2Fbad": fixture("europepmc-fulltext-500.json", "application/json", 400) });
const doi = await fakeApi({
  "/works/10.2147%2Fnss.s38369": fixture("crossref-work.json"),
  "/v2/10.2147%2Fnss.s38369": fixture("unpaywall-work.json"),
});
const crossrefOnly = await fakeApi({ "/works/10.2147%2Fnss.s38369": fixture("crossref-work.json") });
const references = await fakeApi({ "/works/doi%3A10.1016%2Fj.sleep.2011.11.005": fixture("openalex-work.json"), "/works": fixture("openalex-references.json") });
const citedBy = await fakeApi({ "/works/W2039959638": fixture("openalex-work.json"), "/works": fixture("openalex-cited-by.json") });
after(() => Promise.all([epmc, preprints, closed, outage, long, flaky, doi, crossrefOnly, references, citedBy].map((a) => a.close())));

const sent = (api: { requests: URL[] }, from = 0) => api.requests.slice(from).map((u) => u.href);

test("europepmc_search returns ids, venue, open-access state and a clipped abstract, and says which hits can be read in full", async () => {
  const { output } = (await epmc.invoke(europepmcSearch, { query: "sleep diary adolescents actigraphy", limit: 3 })) as { output: { hits: number; results: { abstract: string }[] } };
  assert.equal(output.hits, 1936);
  const { abstract, ...first } = output.results[0]!;
  assert.deepEqual(first, {
    id: "42924744",
    source: "MED",
    pmid: "42924744",
    pmcid: "PMC13692515",
    doi: "10.3390/clockssleep8040068",
    title: "Salivary Cortisol as a Biomarker of Sleep Quality: A Scoping Review.",
    authors: ["Aroonvanichporn P", "Thititanakul P", "Kwanmongkolpong K", "et al."],
    venue: "Clocks & sleep",
    year: 2026,
    preprint: false,
    openAccess: true,
    fullText: true,
    license: "cc by",
    citedBy: 0,
  });
  // The abstract arrives with <h4> section labels; they are text, not markup, by the time the agent reads it.
  assert.ok(abstract.startsWith("Background Sleep is a crucial regulator"), abstract);
  assert.equal(abstract.length, 600);
  assert.ok(abstract.endsWith("…") && !abstract.includes("<"));
  assert.deepEqual(sent(epmc), ["https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=sleep%20diary%20adolescents%20actigraphy&format=json&resultType=core&pageSize=3"]);
});

test("europepmc_search with preprints narrows the query to Europe PMC's preprint source and names the server", async () => {
  const { output } = (await preprints.invoke(europepmcSearch, { query: "sleep actigraphy", limit: 2, preprints: true })) as { output: { results: Record<string, unknown>[] } };
  assert.deepEqual(sent(preprints), ["https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=(sleep%20actigraphy)%20AND%20SRC%3APPR&format=json&resultType=core&pageSize=2"]);
  assert.deepEqual(
    output.results.map((r) => [r.id, r.venue, r.preprint, r.fullText, "pmid" in r]),
    [
      ["PPR1318157", "medRxiv", true, false, false],
      ["PPR1347668", "Research Square", true, false, false],
    ],
  );
});

test("europepmc_fulltext returns the outline and whole sections up to the cap, and names the sections it left out", async () => {
  const { output } = (await epmc.invoke(europepmcFulltext, { pmcid: "PMC13692515" })) as { output: { title: string; license: string; abstract: string; outline: { heading: string; chars: number }[]; sections: { heading: string; text: string }[]; omitted: string[]; note: string } };
  assert.equal(output.title, "Salivary Cortisol as a Biomarker of Sleep Quality: A Scoping Review");
  assert.equal(output.license, "https://creativecommons.org/licenses/by/4.0/");
  assert.ok(output.abstract.startsWith("Background: Sleep is a crucial regulator"));
  assert.equal(output.outline.length, 13);
  assert.deepEqual(output.outline[2], { heading: "2. Methods / 2.1. Inclusion Criteria", chars: 1290 });
  // The 13,000-character discussion does not fit after the sections before it; the shorter sections after it still do.
  assert.deepEqual(output.omitted, ["3. Results and Discussion / 3.4. Discussion"]);
  assert.deepEqual(output.sections.map((s) => s.heading).slice(-2), ["4. Conclusions", "5. Limitations"]);
  assert.ok(output.sections.reduce((n, s) => n + s.text.length, 0) <= FULLTEXT_CHARS);
  // Citation markers stay; table and figure text does not.
  assert.ok(output.sections[0]!.text.includes("poor sleep quality [1,2,3"), output.sections[0]!.text.slice(0, 600));
  assert.ok(!output.sections.some((s) => s.text.includes("<")));
});

test("europepmc_fulltext reads a named section by its own title, so 'discussion' is 3.4 and not every part of 'Results and Discussion'", async () => {
  const { output } = (await epmc.invoke(europepmcFulltext, { pmcid: "PMC13692515", sections: ["discussion"] })) as { output: Record<string, unknown> & { sections: { heading: string; text: string }[] } };
  assert.deepEqual(output.sections.map((s) => [s.heading, s.text.length]), [["3. Results and Discussion / 3.4. Discussion", 12994]]);
  assert.ok(!("abstract" in output) && !("omitted" in output));
  const whole = (await epmc.invoke(europepmcFulltext, { pmcid: "PMC13692515", sections: ["results and discussion"] })) as { output: { sections: { heading: string }[] } };
  assert.equal(whole.output.sections.length, 5);
  const none = await epmc.invoke(europepmcFulltext, { pmcid: "PMC13692515", sections: ["appendix"] });
  assert.equal(none.failure?.code, "invalid-input");
});

test("europepmc_fulltext fails as final input for an article with no open-access text, and sends nothing for an id that is not a PMCID", async () => {
  const shut = await closed.invoke(europepmcFulltext, { pmcid: "PMC11750616" });
  assert.deepEqual(shut.failure, { code: "invalid-input", detail: "Europe PMC has no open-access full text for PMC11750616. Only hits with fullText true in europepmc_search can be read." });
  assert.deepEqual(sent(closed), ["https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11750616/fullTextXML", "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=PMCID%3APMC11750616&resultType=lite&format=json&pageSize=1"]);
  const before = epmc.requests.length;
  const bad = await epmc.invoke(europepmcFulltext, { pmcid: "PMC1/../../search" });
  assert.equal(bad.failure?.code, "invalid-input");
  assert.equal(epmc.requests.length, before);
});

test("europepmc_fulltext treats a 500 for an article Europe PMC lists as open access as an outage, which is retried", async () => {
  const { failure } = await outage.invoke(europepmcFulltext, { pmcid: "PMC13692515" });
  assert.deepEqual(failure, { code: "thrown", detail: "Europe PMC answered 500 for the open-access article PMC13692515; try again later" });
});

test("europepmc_fulltext brings a named section's subsections, so 'methods' is 2 and 2.1 to 2.4", async () => {
  const { output } = (await epmc.invoke(europepmcFulltext, { pmcid: "PMC13692515", sections: ["methods"] })) as { output: { sections: { heading: string }[] } };
  assert.deepEqual(output.sections.map((s) => s.heading), ["2. Methods", "2. Methods / 2.1. Inclusion Criteria", "2. Methods / 2.2. Search Strategy", "2. Methods / 2.3. Data Extraction", "2. Methods / 2.4. Analysis and Visualization"]);
});

test("europepmc_fulltext splits a section longer than the cap into numbered parts, and each part can be read by name", async () => {
  const first = (await long.invoke(europepmcFulltext, { pmcid: "PMC1000001" })) as { output: { outline: { heading: string; chars: number }[]; sections: { heading: string; text: string }[]; omitted: string[] } };
  assert.deepEqual(first.output.outline.map((o) => o.heading), ["Results (part 1 of 2)", "Results (part 2 of 2)"]);
  assert.ok(first.output.outline.every((o) => o.chars <= FULLTEXT_CHARS));
  assert.deepEqual(first.output.sections.map((s) => s.heading), ["Results (part 1 of 2)"]);
  assert.deepEqual(first.output.omitted, ["Results (part 2 of 2)"]);
  const second = (await long.invoke(europepmcFulltext, { pmcid: "PMC1000001", sections: ["part 2"] })) as { output: { sections: { heading: string; text: string }[] } };
  assert.deepEqual(second.output.sections.map((s) => s.heading), ["Results (part 2 of 2)"]);
  // Nothing is lost at the seam: the two parts hold all 30 paragraphs, in order.
  const paragraphs = [...first.output.sections, ...second.output.sections].flatMap((s) => s.text.split("\n\n")).map((p) => p.slice(0, 4));
  assert.deepEqual(paragraphs, Array.from({ length: 30 }, (_, i) => String(i).padStart(4, "0")));
});

test("plainText removes markup but keeps comparisons in statistics, whether they arrive escaped or not", () => {
  assert.equal(plainText("Sleep <i>debt</i> (P &lt; 0.001) in adults with BMI &gt; 30"), "Sleep debt (P < 0.001) in adults with BMI > 30");
  assert.equal(plainText("<h4>Results</h4>P < 0.001 and BMI > 30"), "Results P < 0.001 and BMI > 30");
});

const record = {
  doi: "10.2147/nss.s38369",
  title: "Estimating adolescent sleep patterns: parent reports versus adolescent self-report surveys, sleep diaries, and actigraphy",
  authors: ["Michelle Short", "Gradisar", "Leon Lack", "Wright", "Chatburn"],
  journal: "Nature and Science of Sleep",
  publisher: "Informa UK Limited",
  type: "journal-article",
  published: "2013-02",
  references: 0,
  citedBy: 155,
  licenses: ["http://creativecommons.org/licenses/by-nc/3.0/"],
};

test("doi_lookup joins Crossref's record with Unpaywall's open copy, and accepts a DOI written as a link", async () => {
  const { output } = await doi.invoke(doiLookup, { doi: "https://doi.org/10.2147/nss.s38369" }, CONTACT);
  assert.deepEqual(output, {
    ...record,
    openAccess: { isOpen: true, status: "gold", url: "https://www.dovepress.com/getfile.php?fileID=15179", pdfUrl: "https://www.dovepress.com/getfile.php?fileID=15179", license: "cc-by-nc", version: "publishedVersion", host: "publisher" },
  });
  assert.deepEqual(sent(doi), ["https://api.crossref.org/works/10.2147%2Fnss.s38369?mailto=lab%40example.edu", "https://api.unpaywall.org/v2/10.2147%2Fnss.s38369?email=lab%40example.edu"]);
});

test("doi_lookup does not ask Unpaywall without the lab's contact email, and says so", async () => {
  const before = doi.requests.length;
  const { output } = await doi.invoke(doiLookup, { doi: "doi:10.2147/nss.s38369" });
  assert.deepEqual(output, { ...record, openAccess: null, note: "Open-access status needs the lab's contact email ([research] contact_email_env); Unpaywall was not asked." });
  assert.deepEqual(sent(doi, before), ["https://api.crossref.org/works/10.2147%2Fnss.s38369"]);
});

test("doi_lookup keeps the Crossref record when Unpaywall has none", async () => {
  const { output } = await crossrefOnly.invoke(doiLookup, { doi: "10.2147/nss.s38369" }, CONTACT);
  assert.deepEqual(output, { ...record, openAccess: null, note: "Unpaywall has no record of this DOI." });
});

test("doi_lookup keeps the Crossref record when Unpaywall fails, and a 400 from Crossref is final", async () => {
  const { output } = await flaky.invoke(doiLookup, { doi: "https://www.doi.org/10.2147/nss.s38369" }, CONTACT);
  assert.deepEqual(output, { ...record, openAccess: null, note: "Unpaywall answered 500, so open-access status is unknown." });
  const bad = await flaky.invoke(doiLookup, { doi: "10.1234/bad" }, CONTACT);
  assert.deepEqual(bad.failure, { code: "invalid-input", detail: "Crossref refused the request as malformed (400)" });
});

test("doi_lookup fails as final input for a DOI Crossref does not know, and sends nothing for text that is not a DOI", async () => {
  const unknown = await doi.invoke(doiLookup, { doi: "10.9999/does-not-exist-aliquot" }, CONTACT);
  assert.deepEqual(unknown.failure, { code: "invalid-input", detail: "Crossref has no record of 10.9999/does-not-exist-aliquot. A DOI from another agency, such as DataCite for datasets, is not covered." });
  const before = doi.requests.length;
  const notDoi = await doi.invoke(doiLookup, { doi: "nature14539" });
  assert.equal(notDoi.failure?.code, "invalid-input");
  assert.equal(doi.requests.length, before);
});

test("citation_walk ranks a work's references by citations, from a DOI, with abstracts rebuilt from OpenAlex's index", async () => {
  const { output } = (await references.invoke(citationWalk, { work: "10.1016/j.sleep.2011.11.005", direction: "references", limit: 3 }, CONTACT)) as { output: { work: unknown; total: number; results: { id: string; year: number; citedBy: number; abstract: string }[] } };
  assert.deepEqual(output.work, { id: "W2039959638", title: "The discrepancy between actigraphic and sleep diary measures of sleep in adolescents", year: 2012, doi: "https://doi.org/10.1016/j.sleep.2011.11.005" });
  assert.equal(output.total, 35);
  assert.deepEqual(output.results.map((r) => [r.id, r.citedBy]), [["W2159011576", 109530], ["W3196369884", 19738], ["W2144059033", 3349]]);
  assert.ok(output.results[0]!.abstract.startsWith("Abstract The fifth edition of the Diagnostic and Statistical Manual"), output.results[0]!.abstract);
  const [root, list] = sent(references);
  assert.equal(root, "https://api.openalex.org/works/doi%3A10.1016%2Fj.sleep.2011.11.005?select=id,doi,title,publication_year,cited_by_count,referenced_works&mailto=lab%40example.edu");
  const filter = new URL(list!).searchParams.get("filter")!;
  assert.equal(filter.split("|").length, 35);
  assert.ok(filter.startsWith("openalex_id:W117545607|"));
});

test("citation_walk lists the works that cite one, with the total OpenAlex counts", async () => {
  const { output } = (await citedBy.invoke(citationWalk, { work: "https://openalex.org/W2039959638", direction: "cited_by", limit: 3 })) as { output: { total: number; results: { id: string; abstract: string }[] } };
  assert.equal(output.total, 237);
  assert.deepEqual(output.results.map((r) => r.id), ["W2064090130", "W3027542457", "W1122496926"]);
  // OpenAlex has no abstract for the first one; the field is empty rather than missing.
  assert.equal(output.results[0]!.abstract, "");
  assert.deepEqual(sent(citedBy).map((u) => new URL(u).searchParams.get("filter")), [null, "cites:W2039959638"]);
});

test("the new tools send nothing for a question above D0, because every host they reach is public", async () => {
  for (const [api, tool, input] of [
    [epmc, europepmcSearch, { query: "participant LAB0-0003 sleep" }],
    [epmc, europepmcFulltext, { pmcid: "PMC13692515" }],
    [doi, doiLookup, { doi: "10.2147/nss.s38369" }],
    [citedBy, citationWalk, { work: "W2039959638", direction: "cited_by" }],
  ] as const) {
    const before = api.requests.length;
    const { events, failure } = await api.invoke(tool, input, { inputClass: "D1", contact: "lab@example.edu" });
    assert.deepEqual(events, ["tool.requested", "egress.refused", "tool.failed"]);
    assert.equal(failure?.code, "egress-refused");
    assert.equal(api.requests.length, before);
  }
});

test("abstractFromIndex puts each word back at every position it holds", () => {
  assert.equal(abstractFromIndex({ the: [0, 3], cat: [1], saw: [2], dog: [4] }), "the cat saw the dog");
  assert.equal(abstractFromIndex(null), "");
});

test("parseJats keeps nested headings, list paragraphs and citation markers, and drops tables, figures, formulas and the graphical abstract", () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE article PUBLIC "-//NLM//DTD JATS//EN" "x.dtd"><article><front><article-meta><title-group><article-title>Sleep &amp; <italic>mood</italic></article-title></title-group>
    <permissions><license xlink:href="https://creativecommons.org/licenses/by-nc/4.0/"><license-p>CC BY-NC</license-p></license></permissions>
    <abstract abstract-type="graphical"><p>picture</p></abstract><abstract><title>Abstract</title><p>We measured sleep.</p></abstract></article-meta></front>
    <body><p>Preamble text.</p><sec><title>1. Methods</title><p>Diaries were kept <xref ref-type="bibr">[4]</xref>.</p>
      <sec><title>1.1 Scoring</title><p>Items:<list><list-item><p>bedtime;</p></list-item><list-item><p>wake time.</p></list-item></list></p>
      <table-wrap><caption><p>Table 1 text</p></caption><table><tr><td>9</td></tr></table></table-wrap><p>Mean <inline-formula><mml:math><mml:mi>x</mml:mi></mml:math></inline-formula> was 7&#x2009;h.</p></sec>
      <fig><caption><p>Figure text</p></caption></fig></sec></body><back><ref-list><ref>A reference</ref></ref-list></back></article>`;
  assert.deepEqual(parseJats(xml), {
    title: "Sleep & mood",
    abstract: "Abstract We measured sleep.",
    license: "https://creativecommons.org/licenses/by-nc/4.0/",
    sections: [
      { heading: "Body", text: "Preamble text." },
      { heading: "1. Methods", text: "Diaries were kept [4]." },
      { heading: "1. Methods / 1.1 Scoring", text: "Items: bedtime; wake time.\n\nMean was 7 h." },
    ],
  });
});
