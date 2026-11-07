#!/usr/bin/env node
/**
 * Writes schemas/agent-card.schema.json from the card's zod schema, the one
 * definition `aliquot card` checks every card against. test/study.test.ts
 * fails when the file and the code differ.
 *
 *   node scripts/emit-card-schema.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentCardJsonSchema } from "../packages/core/src/card.ts";

const path = fileURLToPath(new URL("../schemas/agent-card.schema.json", import.meta.url));
mkdirSync(fileURLToPath(new URL("../schemas/", import.meta.url)), { recursive: true });
writeFileSync(path, `${JSON.stringify(agentCardJsonSchema(), null, 2)}\n`);
process.stdout.write(`wrote ${path}\n`);
