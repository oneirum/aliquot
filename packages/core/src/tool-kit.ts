/**
 * The only import a tool folder may use from the harness. Small on purpose:
 * a contributor reads this file and tools/openalex_search/tool.ts and can
 * write a tool.
 */

export { defineTool, EgressRefused } from "./tools.ts";
export type { ToolManifest, ToolContext, Effect } from "./tools.ts";
export type { DataClass } from "./dataclass.ts";
export { z } from "zod";

/** Bumped when ToolContext changes shape. Part of every tool's hash. */
export const TOOL_KIT_VERSION = "1";
