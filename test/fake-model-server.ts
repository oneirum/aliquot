#!/usr/bin/env node
/**
 * The scripted fakes as a long-running service, for the compose check
 * (compose.check.yaml): the compiler on 8101 and the agent model on 8102,
 * the same scripts pnpm lab0 uses. Not part of a lab deployment.
 *
 *   node test/fake-model-server.ts
 */
import { startFakeModel } from "./fake-model.ts";

const host = "0.0.0.0";
const compiler = await startFakeModel("scripted-1", "compile", { port: 8101, host });
const agent = await startFakeModel("scripted-1", "search-then-answer", { port: 8102, host });
console.log(`[fake-model] compile at ${compiler.url}, search-then-answer at ${agent.url}`);
const stop = () => void Promise.all([compiler.close(), agent.close()]).then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
