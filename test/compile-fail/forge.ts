// Every line below must fail to compile. test/nominal.test.ts runs tsc on this folder and asserts exactly these lines error.
import { Labelled } from "../../packages/core/src/dataclass.ts";
import { Prompt } from "../../packages/core/src/gateway.ts";

export const forgedLabel: Labelled<string> = { value: "participant P-12345", cls: "D0", origin: "nowhere" };
export const forgedPrompt: Prompt = { cls: "D0", parts: [{ role: "user", content: Labelled.stamp("participant P-12345", "D3", "gate") }], tools: [], toRecord: () => ({}) };
export const minted = Labelled.derive("participant P-12345", [], "nowhere");
export const empty = Prompt.of([], []);
