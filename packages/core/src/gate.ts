/**
 * Gate: runs before any model sees a message. Local, no network.
 *
 * Invariants:
 * - Message class = join(channel floor, detector result). A study channel bound
 *   to a D3 study has floor D3. The detector only raises, never lowers.
 * - Fails closed: a detector error classifies as the channel's ceiling, or D3
 *   if the channel has none.
 * - R content under policy "refuse" is refused here and stored only as a hash.
 */

import { join, Labelled, type DataClass, type EgressPolicy } from "./dataclass.ts";
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

export type DetectionKind = "ssn" | "mrn" | "dob" | "phone" | "email" | "participant-id" | "review-marker";

export interface Detection {
  readonly kind: DetectionKind;
  readonly cls: DataClass;
  readonly span: readonly [number, number];
}

/** Built-in patterns and the class each raises a message to. Lab participant-id patterns come from lab.toml and are D3. */
const DETECTORS: readonly { readonly kind: DetectionKind; readonly cls: DataClass; readonly pattern: RegExp }[] = [
  { kind: "ssn", cls: "D3", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "mrn", cls: "D3", pattern: /\bMRN[:#\s]*\d{5,}\b/gi },
  { kind: "dob", cls: "D3", pattern: /\bDOB\b[:\s]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi },
  { kind: "phone", cls: "D2", pattern: /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g },
  { kind: "email", cls: "D2", pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  { kind: "review-marker", cls: "R", pattern: /\bREVIEW[- ]CONFIDENTIAL\b/gi },
];

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
  | { readonly t: "refuse"; readonly reason: "unknown-member" | "review-confidential" | "channel-not-allowed"; readonly userFacing: string };

/** Pure, local patterns plus the lab's participant-id regexes from lab.toml. Also run at KB compile over every source text, source URL and the definition's own text. */
export function classifyText(text: string, floor: DataClass, labPatterns: readonly RegExp[]): { readonly cls: DataClass; readonly detections: readonly Detection[] } {
  const detections: Detection[] = [];
  const scan = (kind: DetectionKind, cls: DataClass, pattern: RegExp) => {
    // A fresh RegExp per scan: a shared global regex keeps lastIndex between calls.
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const m of text.matchAll(re)) detections.push({ kind, cls, span: [m.index, m.index + m[0].length] });
  };
  for (const d of DETECTORS) scan(d.kind, d.cls, d.pattern);
  for (const p of labPatterns) scan("participant-id", "D3", p);
  detections.sort((a, b) => a.span[0] - b.span[0]);
  return { cls: join(floor, ...detections.map((d) => d.cls)), detections };
}

export interface GateDeps {
  readonly members: (platformUserId: string, surface: string) => Promise<{ id: MemberId; audiences: readonly Audience[] } | null>;
  readonly channelFloor: (c: ChannelRef) => Promise<DataClass>;
  readonly labPatterns: readonly RegExp[];
  readonly policy: EgressPolicy;
}

export async function gate(msg: InboundMessage, deps: GateDeps): Promise<GateResult> {
  const member = await deps.members(msg.platformUserId, msg.channel.surface);
  if (!member) return { t: "refuse", reason: "unknown-member", userFacing: "You are not a member of this lab's harness. Ask the lab manager for access." };
  const floor = await deps.channelFloor(msg.channel);
  const { cls, detections } = classifyText(msg.text, floor, deps.labPatterns);
  if (cls === "R" && deps.policy.reviewConfidential === "refuse") {
    return { t: "refuse", reason: "review-confidential", userFacing: "This message carries review-confidential content, which this lab does not let agents read." };
  }
  const origin = detections.length ? `gate:${detections.map((d) => d.kind).join(",")}` : `gate:floor`;
  return { t: "admit", member: member.id, audiences: member.audiences, cls, detections, text: Labelled.stamp(msg.text, cls, origin) };
}
