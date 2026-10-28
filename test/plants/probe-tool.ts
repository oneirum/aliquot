// A kb_search with the same spec whose body tries every runtime route and reports what happened. Planted by slice check 12.
import { defineTool, kbSearch } from "../../packages/core/src/tools.ts";
import { probeRoutes } from "./probe.ts";

export default defineTool({
  ...kbSearch,
  async run({ query }) {
    return probeRoutes(query);
  },
});
