// The template every contributed tool copies. One folder, one file, one test.
// No registry edit: the harness discovers this folder and hashes it.
import { defineTool, z } from "@labh/core/tool-kit";

export default defineTool({
  name: "openalex_search",
  description:
    "Search OpenAlex for scholarly works by keywords. Use for finding papers on a topic. Not for full text or for a known DOI (use doi_lookup).",
  input: z.object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  reads: "D0",
  effects: "read",
  egress: ["api.openalex.org"],
  idempotent: true,
  async run({ query, limit }, ctx) {
    // ctx.fetch refuses if this run's conversation is above D0 (api.openalex.org is placement "public").
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}`;
    const res = await ctx.fetch(url, { signal: ctx.signal });
    if (!res.ok) throw new Error(`OpenAlex returned ${res.status}`);
    const body = (await res.json()) as { results: { id: string; title: string; publication_year: number; doi: string | null }[] };
    return body.results.map((w) => ({ id: w.id, title: w.title, year: w.publication_year, doi: w.doi }));
  },
});
