// The legitimate shapes, in the same tsc run, so an error here would mean the fixture's tsc is broken rather than the forgeries caught.
import { Labelled } from "../../packages/core/src/dataclass.ts";
import { Prompt } from "../../packages/core/src/gateway.ts";

const stamped = Labelled.stamp("hello", "D1", "gate:floor");
export const derived = Labelled.derive(stamped.value.toUpperCase(), [stamped], "control");
export const floored = Labelled.derive("nothing above", [], "control", "D1");
export const prompt = Prompt.of([{ role: "user", content: stamped }], []);
