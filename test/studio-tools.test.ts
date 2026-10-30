import { test } from "node:test";
import assert from "node:assert/strict";
import { toolInfos } from "../packages/core/src/studio.ts";
import { builtinTools } from "../packages/core/src/tools.ts";

test("the studio's tool list is plain data: every built-in, its first sentence, its class and its hosts, and no code", () => {
  const infos = toolInfos(builtinTools());
  assert.deepEqual(JSON.parse(JSON.stringify(infos)), infos);
  assert.equal(infos.length, 11);
  assert.deepEqual(infos.find((t) => t.name === "doi_lookup"), {
    name: "doi_lookup",
    summary: "Look up one DOI: title, the first five authors, journal, publisher, type, publication date, reference and citation counts, and license links from Crossref, plus whether the work is open access and where a legal open copy is, from Unpaywall.",
    reads: "D0",
    effects: "read",
    egress: ["api.crossref.org", "api.unpaywall.org"],
  });
  assert.deepEqual(infos.find((t) => t.name === "run_code")?.summary, "Run R or Python in a container with no network.");
});
