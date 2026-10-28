/**
 * Reviewer replay. Three modes over one bundle.
 *
 * Bundle = agent cards + ResolvedAgents + KB snapshot manifests and entries +
 * tool hashes + run events + payload bodies at or below the reviewer's
 * clearance. Bodies above clearance are replaced by their hash and class
 * (export is a decideEgress call per payload). The chain still verifies
 * because events hold hashes, not bodies.
 */

import type { DataClass } from "./dataclass.ts";
import type { AgentVersionHash } from "./hash.ts";
import type { RunId, StoredEvent } from "./record.ts";

export interface ReplayBundle {
  readonly format: "labh-bundle-v1";
  readonly clearance: DataClass;
  readonly agents: readonly AgentVersionHash[];
  readonly runs: readonly RunId[];
  /** Tarball path: bundle.json, prov.json, events/*.jsonl, payloads/<hash>, snapshots/<id>.json */
  readonly path: string;
}

export interface AuditView {
  readonly runId: RunId;
  readonly chainOk: boolean;
  readonly events: readonly StoredEvent[];
  /** Bodies the viewer may see, keyed by payload hash. */
  readonly bodies: ReadonlyMap<string, unknown>;
}

export interface ReplayReport {
  readonly original: RunId;
  readonly replay: RunId;
  readonly agreement: { readonly exact: boolean; readonly numbersAgree: boolean; readonly judge?: number };
  /** Recorded-tools mode: the first point where the model asked for a call not in the recording. */
  readonly divergence: { readonly step: number; readonly asked: string } | null;
}

export async function exportBundle(_scope: { readonly study: string } | { readonly runs: readonly RunId[] }, _opts: { readonly clearance: DataClass }): Promise<ReplayBundle> {
  throw new Error("not implemented");
}

/** Always works. No model. */
export async function audit(_runId: RunId, _clearance: DataClass): Promise<AuditView> {
  throw new Error("not implemented");
}

/**
 * Enqueues a run with trigger {t:"replay"} on the same hash and input.
 * tools "recorded": a ToolRunner that answers from the original run's outputs,
 * matched by (tool, input hash), isolating model nondeterminism.
 * tools "live": real tools.
 */
export async function reexecute(_runId: RunId, _opts: { readonly tools: "recorded" | "live" }): Promise<ReplayReport> {
  throw new Error("not implemented");
}

/** Same as reexecute, against a different agent version. */
export async function counterfactual(_runId: RunId, _agent: AgentVersionHash, _opts: { readonly tools: "recorded" | "live" }): Promise<ReplayReport> {
  throw new Error("not implemented");
}
