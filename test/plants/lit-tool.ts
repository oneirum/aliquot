// A literature search against a fake host on loopback, for the agent worker end-to-end test. LIT_URL is the host.
import { z } from "zod";
import { defineTool } from "../../packages/core/src/tools.ts";

export default defineTool({
  name: "lit_search",
  description: "Search a literature index by keyword. Use for finding papers. Not for lab data.",
  input: z.object({ q: z.string().min(1) }),
  reads: "D0",
  effects: "read",
  egress: ["127.0.0.1"],
  idempotent: true,
  async run({ q }, ctx) {
    const res = await ctx.fetch(`${process.env.LIT_URL}/search?q=${encodeURIComponent(q)}`);
    return { titles: (await res.json()) as string[] };
  },
});
