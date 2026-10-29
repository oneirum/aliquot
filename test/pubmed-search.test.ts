// Both fixtures are trimmed from live eutils.ncbi.nlm.nih.gov responses, 2026-10-28.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeApi } from "./tool-harness.ts";
import { pubmedSearch as tool } from "../packages/core/src/tools.ts";

const api = await fakeApi({
  "/entrez/eutils/esearch.fcgi": { file: new URL("./literature-fixtures/pubmed-esearch.json", import.meta.url), type: "application/json" },
  "/entrez/eutils/esummary.fcgi": { file: new URL("./literature-fixtures/pubmed-esummary.json", import.meta.url), type: "application/json" },
});
after(() => api.close());

test("pubmed_search runs esearch then esummary and returns pmid, title, journal, year, three authors and the doi", async () => {
  const { output } = await api.invoke(tool, { query: "sleep diary adolescents", limit: 2 }, { contact: "lab@example.edu" });
  assert.deepEqual(output, [
    {
      pmid: "42924740",
      title: "Longitudinal Changes in Insomnia, Sleep Continuity, and Sleep Timing During Residential Treatment for Eating Disorders: A Six-Month Observational Study.",
      journal: "Clocks Sleep",
      year: 2026,
      authors: ["Monaco F", "Vignapiano A", "Landi S"],
      doi: "10.3390/clockssleep8040064",
    },
    {
      pmid: "42900036",
      title: "Sleep, Dietary Intake, and Physical Activity: Examining Bidirectionality Using Repeated-Measures Analyses.",
      journal: "J Adolesc Health",
      year: 2026,
      authors: ["Taylor RW", "Haszard JJ", "Wickham SR"],
      doi: "10.1016/j.jadohealth.2026.07.030",
    },
  ]);
  assert.deepEqual(
    api.requests.map((u) => u.href),
    [
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=sleep%20diary%20adolescents&retmax=2&retmode=json&tool=aliquot&email=lab%40example.edu",
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=42924740,42900036&retmode=json&tool=aliquot&email=lab%40example.edu",
    ],
  );
});

test("pubmed_search leaves out tool and email when the lab set no contact", async () => {
  const before = api.requests.length;
  await api.invoke(tool, { query: "sleep diary adolescents", limit: 2 });
  assert.deepEqual(
    api.requests.slice(before).map((u) => [...u.searchParams.keys()]),
    [
      ["db", "term", "retmax", "retmode"],
      ["db", "id", "retmode"],
    ],
  );
});

test("an eutils answer with ERROR in place of the id list fails as final input, carrying the message", async () => {
  // The shape eutils documents for a backend error, written by hand: the live probes never produced one.
  const failing = await fakeApi({ "/entrez/eutils/esearch.fcgi": { file: new URL("./literature-fixtures/pubmed-esearch-error.json", import.meta.url), type: "application/json" } });
  try {
    const r = await failing.invoke(tool, { query: "sleep", limit: 2 });
    assert.deepEqual(r.failure, { code: "invalid-input", detail: "PubMed refused the search: Search Backend failed: Database is not supported: pubmd" });
    assert.deepEqual(r.events, ["tool.requested", "tool.failed"]);
  } finally {
    await failing.close();
  }
});
