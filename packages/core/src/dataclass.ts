/**
 * Data classes and the single egress decision.
 *
 * decideEgress() is the only function in the codebase that answers
 * "may this labelled content go to destination D". It takes the Labelled
 * itself, never a bare class, and checks at runtime that it is genuine. It
 * has exactly five call sites, one per Destination kind
 * (test/boundaries.test.ts fails on a sixth):
 *   model  -> gateway.ts   (ModelGateway.complete / choose)
 *   http   -> tools.ts     (HttpEgress.request: ToolContext.fetch and KB URL sources)
 *   chat   -> frontdoor.ts (postReply)
 *   store  -> record.ts    (PayloadStore.put) and startup
 *   export -> replay.ts    (exportBundle)
 * A new destination kind is a new union member, which breaks the CEILINGS
 * record below and forces a policy row. It cannot be added without a decision.
 */

/** Total order, lowest to highest. R (review-confidential) sits above D3: it may go nowhere D3 may not, and by default nowhere. */
export const DATA_CLASSES = ["D0", "D1", "D2", "D3", "R"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export function rank(c: DataClass): number {
  return DATA_CLASSES.indexOf(c);
}

/** Least upper bound. join() of nothing is D0. Classes only ever go up: there is no declassify in v1. */
export function join(...cs: DataClass[]): DataClass {
  let top: DataClass = "D0";
  for (const c of cs) if (rank(c) > rank(top)) top = c;
  return top;
}

export function atMost(c: DataClass, ceiling: DataClass): boolean {
  return rank(c) <= rank(ceiling);
}

/**
 * A value and the class it was given at its origin. Content enters a run only
 * through stamp() at an origin (gate for messages, kb for snapshots, tools for
 * outputs, agent for instructions) or through derive(), whose class is the
 * join of its inputs. Nothing can build a Labelled with a lower class than
 * the content it was made from. The private field makes the type nominal at
 * compile time (an object literal is rejected, test/compile-fail/forge.ts)
 * and checkable at run time: Labelled.is() asks `#brand in x`, which no
 * JSON.parse result, literal or Object.create(Labelled.prototype) can
 * satisfy. derive(), Prompt.of(), decideEgress() and the payload store all
 * ask, so a forgery that slips past the compiler through `any` is refused at
 * the first consumer that trusts it.
 */
export class Labelled<T> {
  readonly #brand: undefined;
  readonly value: T;
  readonly cls: DataClass;
  /** Where the class came from, for the record: "gate:pattern:ssn", "kb:<snapshot>", "tool:kb_search". */
  readonly origin: string;

  private constructor(value: T, cls: DataClass, origin: string) {
    this.value = value;
    this.cls = cls;
    this.origin = origin;
  }

  /** Genuine: built by stamp or derive in this process. */
  static is(x: unknown): x is Labelled<unknown> {
    return typeof x === "object" && x !== null && #brand in x;
  }

  static stamp<T>(value: T, cls: DataClass, origin: string): Labelled<T> {
    return new Labelled(value, cls, origin);
  }

  /**
   * New value whose class is the join of the inputs' classes and the floor.
   * Either at least one input or an explicit floor is required: a derive from
   * nothing would mint D0 for any content. An input that is not a genuine
   * Labelled throws: its class cannot be trusted.
   */
  static derive<T>(value: T, from: readonly [Labelled<unknown>, ...Labelled<unknown>[]], origin: string, floor?: DataClass): Labelled<T>;
  static derive<T>(value: T, from: readonly Labelled<unknown>[], origin: string, floor: DataClass): Labelled<T>;
  static derive<T>(value: T, from: readonly Labelled<unknown>[], origin: string, floor: DataClass = "D0"): Labelled<T> {
    for (const f of from) if (!Labelled.is(f)) throw new Unlabelled(origin);
    return new Labelled(value, join(floor, ...from.map((f) => f.cls)), origin);
  }
}

/** A value posed as a Labelled or a Prompt without being one. A bug or an attack, never transient. */
export class Unlabelled extends Error {
  constructor(where: string) {
    super(`${where}: a value posed as labelled content but was not built by stamp or derive`);
    this.name = "Unlabelled";
  }
}

/**
 * Where a destination physically is, as declared in lab.toml.
 * lab:         hardware the lab controls (the harness server, a lab GPU box, the web page it serves)
 * institution: university-run service the institution approved (e.g. an institution-hosted model or Teams tenant)
 * approved:    a hosted vendor the institution approved for confidential data
 * zdr:         a hosted vendor under zero data retention
 * public:      anything else, including any host not listed in config (fail closed)
 */
export const PLACEMENTS = ["lab", "institution", "approved", "zdr", "public"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export type SurfaceId = string & { readonly __surface: true };

export type Destination =
  | { readonly kind: "model"; readonly endpointId: string; readonly placement: Placement }
  | { readonly kind: "http"; readonly host: string; readonly placement: Placement }
  | { readonly kind: "chat"; readonly surface: SurfaceId; readonly placement: Placement }
  | { readonly kind: "store"; readonly placement: Placement }
  | { readonly kind: "export"; readonly clearance: DataClass };

export type ModelDestination = Extract<Destination, { kind: "model" }>;

/**
 * The highest class each (kind, placement) may receive. This is
 * code, not configuration: lab.toml names a placement and nothing else, so a
 * config file has no field in which to say "hosted, D3". R is handled by
 * EgressPolicy.reviewConfidential, not by this table.
 */
const CEILINGS: Readonly<Record<Exclude<Destination["kind"], "export">, Readonly<Record<Placement, DataClass | "none">>>> = {
  model: { lab: "D3", institution: "D3", approved: "D2", zdr: "D1", public: "D0" },
  http: { lab: "D3", institution: "D2", approved: "D2", zdr: "D1", public: "D0" },
  chat: { lab: "D3", institution: "D2", approved: "D2", zdr: "D1", public: "D0" },
  store: { lab: "D3", institution: "D2", approved: "none", zdr: "none", public: "none" },
};

export function ceilingOf(kind: Exclude<Destination["kind"], "export">, placement: Placement): DataClass | "none" {
  return CEILINGS[kind][placement];
}

export interface EgressPolicy {
  /** "refuse": R content is refused at the gate and stored only as a hash. "lab-only": R may go to lab placements for model, store and chat. */
  readonly reviewConfidential: "refuse" | "lab-only";
}

export const DEFAULT_POLICY: EgressPolicy = { reviewConfidential: "refuse" };

/** Why a destination may not receive a payload. Codes, not prose, so refusals are counted on the console and tested by code. */
export type EgressRefusal =
  | { readonly code: "class-above-ceiling"; readonly payload: DataClass; readonly ceiling: DataClass }
  | { readonly code: "destination-receives-nothing"; readonly payload: DataClass }
  | { readonly code: "review-confidential-refused" }
  | { readonly code: "review-confidential-needs-lab"; readonly placement: Placement }
  | { readonly code: "above-clearance"; readonly payload: DataClass; readonly clearance: DataClass }
  /** The payload was not a genuine Labelled, so its class is unknown and nothing may receive it. */
  | { readonly code: "unlabelled" };

declare const authorized: unique symbol;
/** A destination the egress decision allowed for one payload. Only decideEgress produces it. */
export type Authorized<D extends Destination> = D & { readonly [authorized]: true };
/** What the provider client in gateway.ts accepts. There is no other way to reach a model endpoint. */
export type AuthorizedRoute = Authorized<ModelDestination>;

export type EgressDecision<D extends Destination = Destination> =
  | { readonly allow: true; readonly to: Authorized<D> }
  | { readonly allow: false; readonly refusal: EgressRefusal };

/**
 * Pure and total. No IO, no logging: callers record the decision in the run
 * journal or audit stream through their CallRecorder, so a refusal is logged
 * exactly once by the caller that would have sent. The payload is checked
 * to be a genuine Labelled before its class is read.
 */
export function decideEgress<D extends Destination>(payload: Labelled<unknown>, dest: D, policy: EgressPolicy): EgressDecision<D> {
  if (!Labelled.is(payload)) return { allow: false, refusal: { code: "unlabelled" } };
  const refusal = refusalFor(payload.cls, dest, policy);
  // The one place the brand is applied: the decision itself is the authorization.
  return refusal === null ? { allow: true, to: dest as Authorized<D> } : { allow: false, refusal };
}

function refusalFor(payload: DataClass, dest: Destination, policy: EgressPolicy): EgressRefusal | null {
  if (dest.kind === "export") {
    return atMost(payload, dest.clearance) ? null : { code: "above-clearance", payload, clearance: dest.clearance };
  }
  if (payload === "R") {
    if (policy.reviewConfidential === "refuse") return { code: "review-confidential-refused" };
    const labKind = dest.kind === "model" || dest.kind === "store" || dest.kind === "chat";
    return labKind && dest.placement === "lab" ? null : { code: "review-confidential-needs-lab", placement: dest.placement };
  }
  const ceiling = CEILINGS[dest.kind][dest.placement];
  if (ceiling === "none") return { code: "destination-receives-nothing", payload };
  return atMost(payload, ceiling) ? null : { code: "class-above-ceiling", payload, ceiling };
}

/** One line for logs and user-facing refusals. */
export function describeRefusal(r: EgressRefusal): string {
  switch (r.code) {
    case "class-above-ceiling":
      return `${r.payload} exceeds the destination ceiling ${r.ceiling}`;
    case "destination-receives-nothing":
      return `the destination may not hold ${r.payload} data at all`;
    case "review-confidential-refused":
      return "review-confidential content is refused by lab policy";
    case "review-confidential-needs-lab":
      return `review-confidential content may only go to lab placements, not ${r.placement}`;
    case "above-clearance":
      return `${r.payload} exceeds the reviewer clearance ${r.clearance}`;
    case "unlabelled":
      return "the content carries no genuine class label";
    default: {
      const never: never = r;
      return never;
    }
  }
}

/** Unlisted hosts are public. Used by HttpEgress so nothing reaches an unknown host above D0. */
export function placementOfHost(host: string, config: { readonly hosts: Readonly<Record<string, Placement>> }): Placement {
  return config.hosts[host.toLowerCase()] ?? "public";
}
