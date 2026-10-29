// The feed is a live export.arxiv.org response, 2026-10-28, kept whole.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeApi } from "./tool-harness.ts";
import { parseAtom } from "../packages/core/src/atom.ts";
import { arxivSearch as tool } from "../packages/core/src/tools.ts";

const api = await fakeApi({ "/api/query": { file: new URL("./literature-fixtures/arxiv-feed.xml", import.meta.url), type: "application/atom+xml" } });
after(() => api.close());

test("arxiv_search returns id, title, authors, date, primary category and the abstract cut to 600 characters", async () => {
  const { output } = await api.invoke(tool, { query: '"sleep diary"', limit: 2 });
  const works = output as { id: string; title: string; authors: string[]; published: string; primaryCategory: string; abstract: string }[];
  assert.deepEqual(
    works.map(({ abstract, ...w }) => ({ ...w, abstractChars: abstract.length, abstractEnd: abstract.slice(-12) })),
    [
      {
        id: "2208.00033v1",
        title: "Personalised recommendations of sleep behaviour with neural networks using sleep diaries captured in Sleepio",
        authors: ["Alejo Nevado-Holgado", "Colin Espie", "Maria Liakata", "Alasdair Henry", "Jenny Gu", "Niall Taylor", "Kate Saunders", "Tom Walker", "Chris Miller"],
        published: "2022-07-29T18:29:05Z",
        primaryCategory: "cs.LG",
        abstractChars: 600,
        abstractEnd: "ries and bu…",
      },
      {
        id: "2509.15378v2",
        title: "Conversational Agents in Behavioral Sleep Medicine: Designing Self-Report and Analytics Tools",
        authors: ["Amama Mahmood", "Bokyung Kim", "Honghao Zhao", "Molly E. Atwood", "Luis F. Buenaver", "Michael T. Smith", "Chien-Ming Huang"],
        published: "2025-09-18T19:30:29Z",
        primaryCategory: "cs.HC",
        abstractChars: 600,
        abstractEnd: "Our multi-s…",
      },
    ],
  );
  assert.deepEqual(
    api.requests.map((u) => u.href),
    ["https://export.arxiv.org/api/query?search_query=all%3A%22sleep%20diary%22&start=0&max_results=2"],
  );
});

test("the Atom reader decodes entities and folds the line breaks arXiv puts in long titles", () => {
  const feed = `<feed><entry><id>http://arxiv.org/abs/1</id><title>Mood &amp; sleep:\n  a &lt;pilot&gt; &#8220;study&#x201D;</title><summary> Short. </summary><published>2020-01-01T00:00:00Z</published><author><name>A &amp; B</name></author></entry></feed>`;
  assert.deepEqual(parseAtom(feed), [{ id: "http://arxiv.org/abs/1", title: "Mood & sleep: a <pilot> “study”", summary: "Short.", published: "2020-01-01T00:00:00Z", authors: ["A & B"], primaryCategory: null }]);
});
