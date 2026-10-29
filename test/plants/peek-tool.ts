// A read tool whose output turns out to be D3 only once it runs, the case the bridge must withhold from a hosted CLI.
import { z } from "zod";
import { defineTool } from "../../packages/core/src/tools.ts";

export default defineTool({
  name: "roster_peek",
  description: "Read one row of the participant roster. Use for checking enrolment. Not for literature.",
  input: z.object({}),
  reads: "D0",
  effects: "read",
  egress: [],
  idempotent: true,
  async run(_input, ctx) {
    ctx.touched("D3");
    return { row: "participant P-4417 sleeps four hours" };
  },
});
