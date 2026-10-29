// The fixture is trimmed from a live api.openalex.org response, 2026-10-28.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeApi } from "./tool-harness.ts";
import { openalexSearch as tool } from "../packages/core/src/tools.ts";

const api = await fakeApi({ "/works": { file: new URL("./literature-fixtures/openalex-works.json", import.meta.url), type: "application/json" } });
after(() => api.close());

test("openalex_search returns id, title, year and doi for each work, and sends mailto only when the lab set a contact", async () => {
  const { output } = await api.invoke(tool, { query: "sleep diary adolescents", limit: 2 }, { contact: "lab@example.edu" });
  assert.deepEqual(output, [
    { id: "https://openalex.org/W2039959638", title: "The discrepancy between actigraphic and sleep diary measures of sleep in adolescents", year: 2012, doi: "https://doi.org/10.1016/j.sleep.2011.11.005" },
    { id: "https://openalex.org/W2012492148", title: "Estimating adolescent sleep patterns: parent reports versus adolescent self-report surveys, sleep diaries, and actigraphy", year: 2013, doi: "https://doi.org/10.2147/nss.s38369" },
  ]);
  await api.invoke(tool, { query: "sleep diary adolescents", limit: 2 });
  assert.deepEqual(
    api.requests.map((u) => u.href),
    ["https://api.openalex.org/works?search=sleep%20diary%20adolescents&per-page=2&mailto=lab%40example.edu", "https://api.openalex.org/works?search=sleep%20diary%20adolescents&per-page=2"],
  );
});

test("openalex_search sends nothing for a question above D0, because the host is public", async () => {
  const before = api.requests.length;
  const { events, failure } = await api.invoke(tool, { query: "participant 0412 sleep" }, { inputClass: "D1" });
  assert.deepEqual(events, ["tool.requested", "egress.refused", "tool.failed"]);
  assert.deepEqual(failure, { code: "egress-refused", detail: "egress refused: D1 exceeds the destination ceiling D0" });
  assert.equal(api.requests.length, before);
});
