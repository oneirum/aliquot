/**
 * Gate: runs before any model sees a message. Local, no network.
 *
 * Invariants:
 * - Message class = join(channel floor, detector result). A study channel bound
 *   to a D3 study has floor D3. The detector only raises, never lowers.
 * - Fails closed: a detector error classifies as the channel's ceiling, or D3
 *   if the channel has none.
 * - The class comes from the lab's policy (policy.ts). A class whose model_tier is none
 *   (review-confidential under "refuse", or a lab's own) is refused here; intake records the
 *   refusal as the class's record mode says.
 */

import { DEFAULT_POLICY, Labelled, type DataClass, type EgressPolicy } from "./dataclass.ts";
import { classById, classify, defaultPolicy, refusalText, type Classification, type Policy } from "./policy.ts";
import type { MemberId, Audience } from "./agent.ts";

export interface ChannelRef {
  readonly surface: string;
  readonly channelId: string;
}

/** Parsed from the Chat SDK event, the web page, email or MCP. Wire types stop at the adapter. */
export interface InboundMessage {
  readonly channel: ChannelRef;
  readonly threadId: string;
  readonly messageId: string;
  readonly platformUserId: string;
  readonly text: string;
  readonly attachments: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  /** Mention or DM. False in a watched channel post nobody addressed. */
  readonly addressed: boolean;
  readonly at: string;
}

/** A detector id from policy.ts DETECTORS: the seven the gate always had ("ssn", "participant-id", ...) or one a lab's classes add. */
export type DetectionKind = string;

export interface Detection {
  readonly kind: DetectionKind;
  readonly cls: DataClass;
  readonly span: readonly [number, number];
}

export type GateResult =
  | {
      readonly t: "admit";
      readonly member: MemberId;
      readonly audiences: readonly Audience[];
      readonly cls: DataClass;
      readonly detections: readonly Detection[];
      /** The message text with its class, stamped here: the gate is the origin of every message's class. */
      readonly text: Labelled<string>;
    }
  | {
      readonly t: "refuse";
      /** review-confidential: a class at level R refused it; class-refused: another class whose model_tier is none. */
      readonly reason: "unknown-member" | "review-confidential" | "class-refused" | "channel-not-allowed";
      readonly userFacing: string;
      /** The class that refused it and why, when a class did. */
      readonly dataClass?: Classification;
      /** The refused text at its level, stamped here like an admitted one, for a class whose record mode keeps it. */
      readonly text?: Labelled<string>;
    };

/**
 * The gate's classification under the default policy: the built-in detectors plus the lab's participant-id regexes.
 * Also run at KB compile over every source text, source URL and the definition's own text when no policy is passed.
 */
export function classifyText(text: string, floor: DataClass, labPatterns: readonly RegExp[]): { readonly cls: DataClass; readonly detections: readonly Detection[] } {
  return asDetections(defaultPolicy(DEFAULT_POLICY, labPatterns), classify(defaultPolicy(DEFAULT_POLICY, labPatterns), { t: "message", text, floor }));
}

/** The lattice view of a classification: its level, and each span with its class's level. */
export function asDetections(policy: Policy, c: Classification): { readonly cls: DataClass; readonly detections: readonly Detection[] } {
  return { cls: c.level, detections: c.spans.map((s) => ({ kind: s.detector, cls: classById(policy, s.class).level, span: s.span })) };
}

export interface GateDeps {
  readonly members: (platformUserId: string, surface: string) => Promise<{ id: MemberId; audiences: readonly Audience[] } | null>;
  readonly channelFloor: (c: ChannelRef) => Promise<DataClass>;
  readonly labPatterns: readonly RegExp[];
  readonly policy: EgressPolicy;
  /** lab.toml's data classes. Absent means the default policy over labPatterns and policy. */
  readonly classes?: Policy;
}

export async function gate(msg: InboundMessage, deps: GateDeps): Promise<GateResult> {
  return (await gateClassified(msg, deps)).result;
}

/** The gate, and the classification it applied, which intake carries into the record. Null when the sender is not a member. */
export async function gateClassified(msg: InboundMessage, deps: GateDeps): Promise<{ readonly result: GateResult; readonly classification: Classification | null; readonly policy: Policy }> {
  const policy = deps.classes ?? defaultPolicy(deps.policy, deps.labPatterns);
  const member = await deps.members(msg.platformUserId, msg.channel.surface);
  if (!member) return { result: { t: "refuse", reason: "unknown-member", userFacing: "You are not a member of this lab's harness. Ask the lab manager for access." }, classification: null, policy };
  const floor = await deps.channelFloor(msg.channel);
  const classification = classify(policy, { t: "message", text: msg.text, floor });
  const rule = classById(policy, classification.class);
  if (rule.modelTier === "none") {
    const reason = classification.level === "R" ? "review-confidential" : "class-refused";
    return { result: { t: "refuse", reason, userFacing: refusalText(rule, classification), dataClass: classification, text: Labelled.stamp(msg.text, classification.level, `gate:refused:${classification.class}`) }, classification, policy };
  }
  const { cls, detections } = asDetections(policy, classification);
  const origin = detections.length ? `gate:${detections.map((d) => d.kind).join(",")}` : `gate:floor`;
  return { result: { t: "admit", member: member.id, audiences: member.audiences, cls, detections, text: Labelled.stamp(msg.text, cls, origin) }, classification, policy };
}
