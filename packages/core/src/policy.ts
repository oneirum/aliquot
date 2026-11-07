/**
 * Data classes as a lab declares them: the policy layer over the D0..R lattice.
 *
 * A lab names classes in lab.toml (`[classes.<id>]`). Each class says which
 * model tier may read it (hosted, local, none), what the record keeps of a
 * message it refuses (the text, a keyed hash, nothing), how long the lab keeps
 * it, which detectors put content in it, and what a member is told. Each class
 * also sits at one level of the lattice in dataclass.ts, and the level is what
 * every egress decision reads, so this layer adds no second egress path:
 *
 *   hosted -> level D0..D2: a hosted endpoint whose placement admits the level may read it
 *   local  -> level D3 or R: the CEILINGS table admits D3 only at lab and institution placements
 *   none   -> refused at the gate, before a run exists, so no model at any placement reads it;
 *             a knowledge base source in such a class is refused at compile
 *
 * With no [classes] table the policy is DEFAULT_CLASSES, which is the behaviour
 * before this layer existed: the same detectors raise a message to the same
 * level, and only review-confidential content under review_confidential =
 * "refuse" is refused at the gate.
 *
 * classify() is the one interface for asking what class a message or a
 * knowledge base entry is in. The gate, KB compile and the studio call it; a
 * measurement harness can call it with nothing else.
 */

import { ceilingOf, DATA_CLASSES, rank, type DataClass, type EgressPolicy, type EgressRefusal, type Placement } from "./dataclass.ts";

export const MODEL_TIERS = ["hosted", "local", "none"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const RECORD_MODES = ["text", "hash", "none"] as const;
export type RecordMode = (typeof RECORD_MODES)[number];

export interface ClassRule {
  readonly id: string;
  readonly level: DataClass;
  readonly modelTier: ModelTier;
  /** What the record keeps of a message this class refuses. A class a model reads is stored as text: the run reads it from the store. */
  readonly record: RecordMode;
  /** Days the lab keeps content of this class, or null for the deployment's default. Recorded with each refusal and run; enforced by the retention job. */
  readonly retentionDays: number | null;
  readonly detectors: readonly string[];
  /**
   * A country code ("us") the class's content may not leave: a model reads it only at an endpoint whose region is
   * that country, checked at intake and at KB compile before any request. Null for no residency rule.
   */
  readonly residency: string | null;
  /** What a member is told when this class refuses a message. */
  readonly message: string;
  /** The lab's own regular expressions for this class, run as detector "class-pattern". */
  readonly patterns: readonly string[];
  /** The campus tier this class maps to under lab.toml's preset, or null with no preset. */
  readonly campusTier: CampusTier | null;
  /** One of the five classes every policy has. Its level is fixed. */
  readonly builtin: boolean;
}

/** A campus tier as a reviewer reads it: "UW-Madison" "Restricted", and the page the mapping rests on. */
export interface CampusTier {
  readonly campus: string;
  readonly tier: string;
  readonly source: string;
}

/** The campus a preset names and its tiers, for buildPolicy. */
export interface Campus {
  readonly campus: string;
  readonly preset: string;
  readonly tiers: readonly string[];
}

export interface Policy {
  /** In declaration order: the five built-ins first, then the lab's own. */
  readonly classes: readonly ClassRule[];
  /** The lab's participant-id regexes, run as the participant-id detector. */
  readonly labPatterns: readonly RegExp[];
  /** The campus lab.toml's preset names, or null. Every class has a campusTier when it is set. */
  readonly campus?: Campus | null;
}

/** A detector: patterns, plus an optional filter over each match. Local and pure, like the gate. */
interface Detector {
  readonly patterns: readonly RegExp[];
  /** Which HIPAA Safe Harbor identifier (45 CFR 164.514(b)(2)(i)) it covers, for the docs and the studio. */
  readonly safeHarbor?: string;
  /** Whether a match counts, given the text around it (index is where the match starts). */
  readonly keep?: (match: string, text: string, index: number) => boolean;
}

const PHONE = String.raw`(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}`;
const MONTH = String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?`;
/** 04/12/1958, 7-3-1961, 1958-04-12, April 12, 1958, 3 March 1961. */
const DATE = String.raw`(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|${MONTH}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+${MONTH},?\s+\d{4})`;

let endsOf: { readonly text: string; readonly ends: readonly number[] } = { text: "", ends: [] };
/** Where sentences end in a text, kept for the last text scanned: classify() asks once per match of the same text. */
function sentenceEnds(text: string): readonly number[] {
  // A full stop ends a sentence unless it closes an honorific: "Mrs. Lin, admitted 05/02/2026" is one sentence.
  if (endsOf.text !== text) endsOf = { text, ends: [...text.matchAll(/(?<!\b(?:Mr|Mrs|Ms|Mx|Dr|St))[.?!](?=\s)|\n/g)].map((m) => m.index) };
  return endsOf.ends;
}

/** The sentence a match sits in, up to the match and from it on: detectors that need a second identifier look here. */
function sentenceAround(text: string, index: number, length: number): { readonly before: string; readonly after: string } {
  const ends = sentenceEnds(text);
  const start = (ends.findLast((e) => e < index) ?? -1) + 1;
  const end = ends.find((e) => e >= index + length) ?? text.length;
  return { before: text.slice(start, index), after: text.slice(index + length, end) };
}

/** Words that make a 3-2-4 digit group a part, lot or order number rather than an SSN, unless an SSN label is also near. */
const NOT_SSN_CONTEXT = /\b(?:part|lot|batch|serial|s\/n|catalog(?:ue)?|cat\.?|reorder|order|PO|SKU|item|invoice|ticket|model|ref(?:erence)?|code|asset|tracking|confirmation|kit)\b[^\d]{0,24}$/i;
const SSN_LABEL = /\b(?:SSN|SS#|social(?:\s+security)?)\b/i;

/** An SSN the Social Security Administration could issue: no area 000, 666 or 9xx, no group 00, no serial 0000. */
function ssnShaped(match: string, text: string, index: number): boolean {
  const d = match.replace(/\D/g, "");
  if (d.length !== 9 || /^(?:000|666|9)/.test(d) || d.slice(3, 5) === "00" || d.slice(5) === "0000") return false;
  const before = text.slice(Math.max(0, index - 40), index);
  return SSN_LABEL.test(before) || !NOT_SSN_CONTEXT.test(before);
}

/** Readings and findings about a person's body: a name in the same sentence makes the sentence PHI. */
const HEALTH_MEASURE = /\b(?:heart\s+rate|pulse|blood\s+pressure|BP|weight|weighed|BMI|glucose|A1c|cholesterol|temperature|SpO2|oxygen|diagnos(?:is|ed)|medication|dose|lab\s+results?|blood\s+(?:test|draw|work)|scored|score)\b/i;
/** What precedes a street address that makes it a person's: their name, or a word that says where someone lives. */
const PERSON_BEFORE_ADDRESS = /(?:\b[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+(?:at|of|on)|,)?|\b(?:home|lives|living|resides|residing|his|her|their|mail(?:ed|ing)?\s+to|address(?:\s+is)?)\b[^.\n]{0,20})\s*$/;
/** A card network's number prefix (Visa, Mastercard, Amex, Discover, JCB, Diners), which an epoch timestamp (17..., 18...) never has. */
const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|3[0689]|35|6011|64[4-9]|65)/;

/** A payment card number has a network prefix and passes the Luhn check; most other long digit runs do neither. */
function luhn(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || !CARD_PREFIX.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** Scholarly and public hosts whose links are citations, not identifiers of a person. */
const PUBLIC_LINK_HOSTS = /^(?:[a-z0-9-]+\.)*(?:doi\.org|ncbi\.nlm\.nih\.gov|europepmc\.org|arxiv\.org|openalex\.org|biorxiv\.org|medrxiv\.org|clinicaltrials\.gov|osf\.io|zenodo\.org|github\.com)$/i;

/**
 * Every detector a class may name. The first seven are the gate's detectors
 * before classes existed; ssn, mrn, dob and participant-id have since learned
 * the spelled-out and loosely typed forms the trust harness found them missing.
 * The phi-* set and the four shared with it cover the Safe Harbor identifiers a
 * pattern can find in text; a photograph is found only where the text refers
 * to one, and "any other unique identifying number" is the lab's own
 * participant-id patterns.
 */
const BASE_DETECTORS: Readonly<Record<string, Detector>> = {
  ssn: {
    patterns: [/\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, /\b(?:SSN|SS#|social(?:\s+security)?(?:\s+(?:number|no\.?|#))?)(?:\s+(?:is|was))?[:#\s]*\d{9}\b/gi],
    safeHarbor: "(G) Social Security numbers",
    keep: ssnShaped,
  },
  mrn: { patterns: [/\b(?:MRN|medical\s+record\s*(?:number|no\.?|#)?)(?:\s+(?:is|was))?[:#\s]*\d{5,}\b/gi], safeHarbor: "(H) Medical record numbers" },
  dob: {
    patterns: [new RegExp(String.raw`\b(?:DOB|D\.O\.B\.?|date\s+of\s+birth|birth\s*date|birthday|born)\b(?:\s+(?:is|was|on|of))*[:,\s]*${DATE}`, "gi")],
    safeHarbor: "(C) Dates related to an individual",
  },
  phone: { patterns: [new RegExp(String.raw`\b${PHONE}\b`, "g")], safeHarbor: "(D) Telephone numbers" },
  email: { patterns: [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g], safeHarbor: "(F) Email addresses" },
  "participant-id": { patterns: [], safeHarbor: "(R) Any other unique identifying number" },
  "review-marker": { patterns: [/\bREVIEW[- ]CONFIDENTIAL\b/gi] },
  "phi-name": { patterns: [/\b(?:[Pp]atient|[Pp]t\.?|[Nn]ame)(?:'s)?(?:\s+[Nn]ame)?\s*[:-]?\s*[A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+(?:-[A-Z][a-z]+)?\b/g], safeHarbor: "(A) Names" },
  "phi-name-health": {
    patterns: [/\b(?:Mr|Mrs|Ms|Mx|Miss)\.?\s+[A-Z][a-z]+(?:-[A-Z][a-z]+)?(?:'s)?/g],
    safeHarbor: "(A) Names",
    keep: (m, text, i) => {
      const s = sentenceAround(text, i, m.length);
      return HEALTH_MEASURE.test(s.before) || HEALTH_MEASURE.test(s.after);
    },
  },
  "phi-name-address": {
    patterns: [/\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way|Pl|Place|Terrace|Pkwy|Parkway)\b\.?/g],
    safeHarbor: "(B) Geographic subdivisions smaller than a state",
    keep: (m, text, i) => PERSON_BEFORE_ADDRESS.test(sentenceAround(text, i, m.length).before),
  },
  "phi-address": {
    patterns: [/\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way|Pl|Place|Terrace|Pkwy|Parkway)\b\.?/g],
    safeHarbor: "(B) Geographic subdivisions smaller than a state",
  },
  "phi-zip": { patterns: [/\b(?:ZIP|zip(?:\s*code)?|postal\s*code)[:#\s]*\d{5}(?:-\d{4})?\b/gi, /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g], safeHarbor: "(B) Geographic subdivisions smaller than a state" },
  "phi-date": {
    patterns: [new RegExp(String.raw`\b(?:admitted|admission(?:\s+date)?|discharged|discharge(?:\s+date)?|date\s+of\s+death|DOD|died|date\s+of\s+service|DOS|born)\b[:\s]*(?:on\s+)?${DATE}`, "gi")],
    safeHarbor: "(C) Dates related to an individual",
  },
  "phi-age": { patterns: [/\b(?:aged?\s*)?(?:9\d|1[0-4]\d)\s*-?\s*(?:years?|yrs?|yo|y\/o)(?:[\s-]*old)?\b/gi], safeHarbor: "(C) Ages over 89" },
  "phi-fax": { patterns: [new RegExp(String.raw`\bfax[:#\s]*${PHONE}\b`, "gi")], safeHarbor: "(E) Fax numbers" },
  "phi-health-plan": {
    patterns: [/\b(?:health\s+plan|member|subscriber|beneficiary|insurance|policy)(?:\s+(?:beneficiary|member|subscriber))?\s*(?:id|no\.?|number|#)(?:\s+(?:is|was))?[:#\s]*(?=[A-Z0-9-]*\d)[A-Z0-9-]{5,}\b/gi],
    safeHarbor: "(I) Health plan beneficiary numbers",
  },
  "phi-account": { patterns: [/\b(?:account|acct)\s*(?:no\.?|number|#)?[:#\s]*\d{6,}\b/gi], safeHarbor: "(J) Account numbers" },
  "phi-license": {
    patterns: [/\b(?:(?:licen[cs]e|certificate)\s*(?:no\.?|number|#)|NPI|DEA)[:#\s]*[A-Z]{0,2}\d{5,}\b/gi, /\bdriver'?s?\s+licen[cs]e(?:\s+(?:no\.?|number|#))?(?:\s+(?:is|was))?[:#\s]*[A-Z]{0,2}\d[\dA-Z-]{4,}\b/gi],
    safeHarbor: "(K) Certificate and license numbers",
  },
  "phi-vehicle": { patterns: [/\b(?=[A-HJ-NPR-Z]*\d)(?=\d*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/g, /\blicense\s+plate\s*(?:no\.?|number|#)?[:#\s]*[A-Z0-9-]{2,8}\b/gi], safeHarbor: "(L) Vehicle identifiers and serial numbers" },
  "phi-device": { patterns: [/\b(?:serial|device\s+id|UDI|implant)\s*(?:no\.?|number|#|id)?[:#\s]*[A-Z0-9-]*\d[A-Z0-9-]{5,}\b/gi], safeHarbor: "(M) Device identifiers and serial numbers" },
  "phi-url": {
    patterns: [/\bhttps?:\/\/[^\s<>"')\]]+/gi],
    safeHarbor: "(N) Web URLs",
    keep: (m) => {
      try {
        return !PUBLIC_LINK_HOSTS.test(new URL(m).hostname);
      } catch {
        return true;
      }
    },
  },
  "phi-ip": {
    patterns: [/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g],
    safeHarbor: "(O) IP addresses",
    // A URL's host is where a request goes, not a person's device (phi-url covers the URL), and loopback is no one's.
    keep: (m, text, i) => !/^(?:127|0)\./.test(m) && !/(?:\/\/|@)$/.test(text.slice(Math.max(0, i - 3), i)),
  },
  "phi-photo": {
    patterns: [/\b(?:photo(?:graph)?|picture|image|headshot)s?\b[^.\n]{0,40}?\bfull[- ]face\b/gi, /\bfull[- ]face\s+(?:photo(?:graph)?|picture|image|headshot)s?\b/gi],
    safeHarbor: "(Q) Full-face photographs",
  },
  "phi-biometric": { patterns: [/\b(?:fingerprint|voiceprint|retinal?\s+scan|iris\s+scan|face\s?print)\s*(?:id|template|no\.?|#)[:#\s]*[A-Z0-9-]{4,}\b/gi], safeHarbor: "(P) Biometric identifiers" },
  "dua-marker": { patterns: [/^[ \t]*(?:DUA|Data\s+Use\s+Agreement|dbGaP)[ \t]*[:#][ \t]*\S+/gim, /\bphs\d{6}(?:\.v\d+(?:\.p\d+)?)?\b/g, /\bEGA[SD]\d{11}\b/g] },
  "card-number": { patterns: [/\b\d(?:[ -]?\d){12,18}\b/g], keep: luhn },
  "export-marker": { patterns: [/\b(?:ITAR|EAR99|export[- ]controlled)\b/gi, /\bECCN[:#\s]*\d[A-E]\d{3}\b/gi, /\bUSML\s+Category\s+[IVXL]+\b/g] },
};

/** Someone named or pointed at in the sentence: a pronoun, an honorific, a role, a participant id shape or a first and last name. */
const PERSON_WORD = /\b(?:he|she|him|his|her|hers|they|them|their|participant|patient|subject|pt|mr|mrs|ms|mx|miss)\b/i;
const PERSON_NAME = /\b[A-Z]{2,}\d*[-\s]?\d{2,}\b|\b(?!(?:The|A|An|Our|This|That|My|Your|Each|Every)\b)[A-Z][a-z]+\s+[A-Z][a-z]+\b/;
const PERSON = { test: (s: string) => PERSON_WORD.test(s) || PERSON_NAME.test(s) };

/**
 * A detector that counts only in a sentence about a person: an admission date or an IP is an identifier when it is
 * someone's, while "the freezer died on 3/4/2026" and "the LIMS server is 192.168.1.10" are handbook text.
 */
function aboutPerson(d: Detector): Detector {
  return {
    ...d,
    keep: (m, text, i) => {
      if (d.keep && !d.keep(m, text, i)) return false;
      const s = sentenceAround(text, i, m.length);
      return PERSON.test(s.before) || PERSON.test(s.after);
    },
  };
}

export const DETECTORS: Readonly<Record<string, Detector>> = {
  ...BASE_DETECTORS,
  "phi-date-person": aboutPerson(BASE_DETECTORS["phi-date"]!),
  "phi-ip-person": aboutPerson(BASE_DETECTORS["phi-ip"]!),
};

/** Names that expand to several detectors in a class's detectors list. */
export const DETECTOR_GROUPS: Readonly<Record<string, readonly string[]>> = {
  "hipaa-safe-harbor": Object.entries(DETECTORS)
    .filter(([id, d]) => d.safeHarbor && id !== "participant-id")
    .map(([id]) => id),
};

/**
 * The built-in restricted class's detectors: the four it always had, and the Safe Harbor identifiers whose shapes
 * do not occur in a lab handbook (a person's address, not a building's; a name beside a reading of their body; a date
 * or an IP in a sentence about someone).
 */
const RESTRICTED_DETECTORS = ["ssn", "mrn", "dob", "participant-id", "phi-name-health", "phi-name-address", "phi-date-person", "phi-health-plan", "phi-license", "phi-ip-person", "phi-photo"] as const;

const REVIEW_REFUSED = "This message carries review-confidential content, which this lab does not let agents read.";

/** The five classes every policy has, one per level, in the shape that reproduces the gate before classes existed. */
export function defaultClasses(egress: EgressPolicy): ClassRule[] {
  const c = (id: string, level: DataClass, modelTier: ModelTier, detectors: readonly string[], message: string, record: RecordMode = "text"): ClassRule => ({ id, level, modelTier, record, retentionDays: null, detectors, residency: null, message, patterns: [], campusTier: null, builtin: true });
  return [
    c("public", "D0", "hosted", [], "This message is public."),
    c("internal", "D1", "hosted", [], "This message is internal to the lab."),
    c("confidential", "D2", "hosted", ["phone", "email"], "This message carries contact details, which only an approved model may read."),
    c("restricted", "D3", "local", RESTRICTED_DETECTORS, "This message carries restricted data, such as a participant id, which only a model on lab or institution hardware may read."),
    // Under "refuse" no model reads it and the record keeps a hash; under "lab-only" a lab model reads it from the store.
    egress.reviewConfidential === "refuse" ? c("review-confidential", "R", "none", ["review-marker"], REVIEW_REFUSED, "hash") : c("review-confidential", "R", "local", ["review-marker"], REVIEW_REFUSED),
  ];
}

export function defaultPolicy(egress: EgressPolicy, labPatterns: readonly RegExp[] = []): Policy {
  return { classes: defaultClasses(egress), labPatterns };
}

const TIER_RANK: Record<ModelTier, number> = { hosted: 0, local: 1, none: 2 };

/** Which levels each tier may sit at, so the lattice enforces the tier and no second check is needed. */
const TIER_LEVELS: Record<ModelTier, readonly DataClass[]> = { hosted: ["D0", "D1", "D2"], local: ["D3", "R"], none: DATA_CLASSES };

export const CLASS_ID = /^[a-z][a-z0-9_-]*$/;

/** One [classes.<id>] table as parsed by config.ts, before it is merged with the defaults. */
export interface DeclaredClass {
  readonly level?: DataClass;
  readonly model_tier?: ModelTier;
  readonly record?: RecordMode;
  readonly retention_days?: number;
  readonly residency?: string;
  readonly detectors?: readonly string[];
  readonly patterns?: readonly string[];
  readonly message?: string;
  readonly campus_tier?: string;
  readonly source?: string;
}

/**
 * Merges the lab's [classes] over the defaults. A built-in class keeps its
 * level; a lab may change its tier, record, retention, message and detectors.
 * Naming a detector in one class takes it from the built-in class that held
 * it, and naming it in two lab classes is an error. Throws with the lab.toml
 * key on any inconsistency, so a policy that loads is one the lattice enforces.
 */
export function buildPolicy(declared: Readonly<Record<string, DeclaredClass>>, egress: EgressPolicy, labPatterns: readonly RegExp[], campus: Campus | null = null): Policy {
  const fail = (id: string, why: string): never => {
    throw new Error(`lab.toml: [classes.${id}] ${why}`);
  };
  const defaults = defaultClasses(egress);
  const expand = (id: string, names: readonly string[]): string[] =>
    names.flatMap((n) => {
      if (DETECTOR_GROUPS[n]) return [...DETECTOR_GROUPS[n]];
      if (!DETECTORS[n]) return fail(id, `names detector ${n}, which does not exist; the detectors are ${[...Object.keys(DETECTORS), ...Object.keys(DETECTOR_GROUPS)].join(", ")}`);
      return [n];
    });
  const tierOf = (d: DeclaredClass | undefined): CampusTier | null => (campus && d?.campus_tier ? { campus: campus.campus, tier: d.campus_tier, source: d.source ?? "" } : null);
  const claimed = new Map<string, string>();
  for (const [id, d] of Object.entries(declared)) {
    if (!CLASS_ID.test(id)) fail(id, "is not a class id: lowercase letters, digits, _ and -, starting with a letter");
    for (const p of d.patterns ?? []) {
      let re: RegExp;
      try {
        re = new RegExp(p);
      } catch (err) {
        return fail(id, `pattern ${JSON.stringify(p)} does not compile: ${(err as Error).message}`);
      }
      if (re.test("")) fail(id, `pattern ${JSON.stringify(p)} matches the empty string, so it would put every message in this class`);
    }
    if (d.campus_tier !== undefined && !campus) fail(id, "names campus_tier, which needs a preset: set preset in lab.toml");
    if (d.campus_tier !== undefined && campus && !campus.tiers.includes(d.campus_tier)) fail(id, `campus_tier = "${d.campus_tier}" is not a tier of preset ${campus.preset}: ${campus.tiers.join(", ")}`);
    for (const det of d.detectors ? expand(id, d.detectors) : []) {
      const first = claimed.get(det);
      if (first && first !== id) fail(id, `names detector ${det}, which [classes.${first}] already names; a detector puts content in one class`);
      claimed.set(det, id);
    }
  }
  const out: ClassRule[] = defaults.map((b) => {
    const d = declared[b.id];
    if (d?.level && d.level !== b.level) fail(b.id, `is a built-in class at level ${b.level}; its level cannot change. Declare a new class instead`);
    if (b.id === "review-confidential" && d?.model_tier) fail(b.id, 'takes its model tier from [policy] review_confidential ("refuse" is none, "lab-only" is local)');
    return {
      ...b,
      ...(d?.model_tier ? { modelTier: d.model_tier } : {}),
      ...(d?.record ? { record: d.record } : {}),
      ...(d?.retention_days !== undefined ? { retentionDays: d.retention_days } : {}),
      ...(d?.residency ? { residency: d.residency } : {}),
      ...(d?.message ? { message: d.message } : {}),
      ...(d?.patterns ? { patterns: d.patterns } : {}),
      campusTier: tierOf(d),
      detectors: d?.detectors ? expand(b.id, d.detectors) : b.detectors.filter((det) => (claimed.get(det) ?? b.id) === b.id),
    };
  });
  for (const [id, d] of Object.entries(declared)) {
    if (defaults.some((b) => b.id === id)) continue;
    const modelTier = d.model_tier ?? fail(id, "needs model_tier = hosted, local or none");
    const level = d.level ?? (modelTier === "hosted" ? fail(id, "needs level (D0, D1 or D2) for a hosted class: it says which hosted placements may read it") : "D3");
    out.push({
      id,
      level,
      modelTier,
      record: d.record ?? (modelTier === "none" ? "hash" : "text"),
      retentionDays: d.retention_days ?? null,
      residency: d.residency ?? null,
      detectors: expand(id, d.detectors ?? []),
      message: d.message ?? `This message carries ${id} data, which ${modelTier === "none" ? "no model" : "only a model on lab or institution hardware"} may read under this lab's policy.`,
      patterns: d.patterns ?? [],
      campusTier: tierOf(d),
      builtin: false,
    });
  }
  for (const c of out) {
    if (!TIER_LEVELS[c.modelTier].includes(c.level)) fail(c.id, `has model_tier = "${c.modelTier}" at level ${c.level}, which the egress lattice would not enforce; ${c.modelTier} takes level ${TIER_LEVELS[c.modelTier].join(", ")}`);
    if (c.modelTier !== "none" && c.record !== "text") fail(c.id, `has record = "${c.record}", but a class a model reads is stored as text so the run can read it; bound how long with retention_days`);
    if (c.retentionDays !== null && (!Number.isInteger(c.retentionDays) || c.retentionDays < 0)) fail(c.id, "retention_days must be a whole number of days");
    if (c.level === "R" && c.modelTier === "local" && egress.reviewConfidential === "refuse") fail(c.id, 'is at level R with model_tier = "local", which needs [policy] review_confidential = "lab-only"');
    if (campus && !c.campusTier) fail(c.id, `has no campus_tier; under preset ${campus.preset} every class names one of ${campus.tiers.join(", ")}`);
  }
  return { classes: out, labPatterns, campus };
}

export interface Span {
  readonly detector: string;
  readonly class: string;
  readonly span: readonly [number, number];
}

/** The answer classify() gives: the class that governs, the lattice level every egress decision reads, the rule that put it there, and where. */
export interface Classification {
  readonly class: string;
  readonly level: DataClass;
  /** "detector:<id>" for the span that decided the class, "floor:<level>" for a message's channel, "declared:<level>" for an entry's declared class. */
  readonly rule: string;
  readonly spans: readonly Span[];
}

export type Classifiable =
  /** A member's message and the floor of the channel it arrived in. */
  | { readonly t: "message"; readonly text: string; readonly floor: DataClass }
  /** A knowledge base source or entry and the class its definition declares. */
  | { readonly t: "entry"; readonly text: string; readonly declared: DataClass };

export function classById(policy: Policy, id: string): ClassRule {
  const c = policy.classes.find((x) => x.id === id);
  if (!c) throw new Error(`no data class ${id} in this policy`);
  return c;
}

/** The class content at a level with no detection is in: the built-in class of that level. */
export function classOfLevel(policy: Policy, level: DataClass): ClassRule {
  return policy.classes.find((c) => c.builtin && c.level === level)!;
}

/** Every class at a level, for a refusal that knows the level and not which detector raised it. */
export function classesAtLevel(policy: Policy, level: DataClass): readonly ClassRule[] {
  return policy.classes.filter((c) => c.level === level);
}

/** Stricter first by tier, then level, then later declaration. */
function stricter(policy: Policy, a: ClassRule, b: ClassRule): boolean {
  if (TIER_RANK[a.modelTier] !== TIER_RANK[b.modelTier]) return TIER_RANK[a.modelTier] > TIER_RANK[b.modelTier];
  if (a.level !== b.level) return rank(a.level) > rank(b.level);
  return policy.classes.indexOf(a) > policy.classes.indexOf(b);
}

/** The strictest of these classes, or the built-in class of level D0 for none. */
export function strictestClass(policy: Policy, ids: readonly string[]): ClassRule {
  let top = classOfLevel(policy, "D0");
  for (const id of ids) {
    const c = classById(policy, id);
    if (stricter(policy, c, top)) top = c;
  }
  return top;
}

/**
 * A lab's participant-id patterns, and for each one that opens with a literal prefix of two or more characters
 * (`\bLAB1-\d{4}\b`), the same id as a person types it: any case, a space, en dash or no separator, any number of
 * digits (lab1-0042, LAB1 0107, LAB1–0311, LAB1-42). The exact pattern still runs, so nothing it found is lost.
 */
function participantIdPatterns(labPatterns: readonly RegExp[]): readonly RegExp[] {
  return labPatterns.flatMap((re) => {
    const prefix = /^(?:\\b)?((?:[A-Za-z0-9]|\\-)+?)(?:-|\\-|_|\[[^\]]*\]|\\s|\\d|\()/.exec(re.source)?.[1]?.replace(/\\-/g, "-").replace(/-$/, "");
    if (!prefix || prefix.length < 2 || !/[A-Za-z]/.test(prefix)) return [re];
    return [re, new RegExp(String.raw`\b${prefix.replace(/-/g, "[-\u2010-\u2015]")}[\s_\u2010-\u2015-]?\d+\b`, "gi")];
  });
}

/** Pure and local. The level is the join of the floor and every span's class level; the class is the strictest among them. */
export function classify(policy: Policy, input: Classifiable): Classification {
  const base = input.t === "message" ? input.floor : input.declared;
  const spans: Span[] = [];
  for (const c of policy.classes) {
    for (const id of c.detectors) {
      const d = DETECTORS[id]!;
      const patterns = id === "participant-id" ? participantIdPatterns(policy.labPatterns) : d.patterns;
      for (const pattern of patterns) {
        // A fresh RegExp per scan: a shared global regex keeps lastIndex between calls.
        const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
        for (const m of input.text.matchAll(re)) if (!d.keep || d.keep(m[0], input.text, m.index)) spans.push({ detector: id, class: c.id, span: [m.index, m.index + m[0].length] });
      }
    }
    for (const p of c.patterns) for (const m of input.text.matchAll(new RegExp(p, "g"))) spans.push({ detector: "class-pattern", class: c.id, span: [m.index, m.index + m[0].length] });
  }
  spans.sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  // A loose participant-id pattern finds what the exact one found: keep one span per place per detector.
  const unique = spans.filter((s, i) => !spans.slice(0, i).some((t) => t.detector === s.detector && t.class === s.class && t.span[0] <= s.span[0] && t.span[1] >= s.span[1]));
  spans.splice(0, spans.length, ...unique);
  let top = classOfLevel(policy, base);
  let rule = `${input.t === "message" ? "floor" : "declared"}:${base}`;
  let level = base;
  for (const s of spans) {
    const c = classById(policy, s.class);
    if (rank(c.level) > rank(level)) level = c.level;
    if (stricter(policy, c, top)) {
      top = c;
      rule = `detector:${s.detector}`;
    }
  }
  return { class: top.id, level, rule, spans };
}

/** A class as a member and a reviewer read it: `phi`, or `phi (UW-Madison Restricted)` under a preset. */
export function classLabel(c: ClassRule): string {
  return c.campusTier ? `${c.id} (${c.campusTier.campus} ${c.campusTier.tier})` : c.id;
}

/** The rule a refusal applied, as a member reads it: `model_tier = "none"`. */
export function ruleText(c: ClassRule): string {
  return `model_tier = "${c.modelTier}"`;
}

/** What a member is told when the gate refuses a message for its class. Names the class and the rule, then the lab's message. */
export function refusalText(c: ClassRule, cls: Classification): string {
  const why = cls.rule.startsWith("detector:") ? `, found by detector ${cls.rule.slice("detector:".length)}` : "";
  return `Not sent. Data class ${classLabel(c)}${why}; rule ${ruleText(c)}. ${c.message}`;
}

/** Retention for content of a class, for the retention job (owned by the keys and retention unit). */
export function retentionOf(policy: Policy, classId: string): number | null {
  return classById(policy, classId).retentionDays;
}

/** Why a payload store at this placement cannot keep a refused message's text at this level, or null when it can. Mirrors the store row of the lattice. */
export function ceilingOfStore(level: DataClass, placement: Placement, egress: EgressPolicy): string | null {
  if (level === "R") return egress.reviewConfidential === "lab-only" && placement === "lab" ? null : 'review-confidential text is kept only in a lab store under review_confidential = "lab-only"';
  const ceiling = ceilingOf("store", placement);
  return ceiling === "none" || rank(level) > rank(ceiling) ? `the store at placement ${placement} may not hold ${level}` : null;
}

/** The sentence every refused run has always opened with; the class and the rule follow it, so earlier readers of the notice still match. */
export const RUN_REFUSED = "This request cannot be answered here: it contains restricted data that the configured model may not receive.";

/**
 * The notice for a run the egress decision refused: the class whose level the refused payload reached, and its rule.
 * The message's own class when it is at that level (the gate recorded it on the job); otherwise every class at the
 * level, because content from a knowledge base or a tool carries a level, not a detector. Null for a refusal that is
 * not about a class (a host or model rule), which keeps the generic notice.
 */
export function runRefusalText(policy: Policy, refusal: EgressRefusal, messageClass?: { readonly id: string; readonly rule: string }): string | null {
  const level: DataClass | null =
    refusal.code === "class-above-ceiling" || refusal.code === "destination-receives-nothing" ? refusal.payload
    : refusal.code === "review-confidential-refused" || refusal.code === "review-confidential-needs-lab" ? "R"
    : null;
  if (level === null) return null;
  const own = messageClass && policy.classes.find((c) => c.id === messageClass.id && c.level === level);
  const candidates = own ? [own] : classesAtLevel(policy, level);
  const names = candidates.map(classLabel);
  const named = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  const found = own && messageClass?.rule.startsWith("detector:") ? `, found by detector ${messageClass.rule.slice("detector:".length)}` : "";
  const tiers = [...new Set(candidates.map((c) => ruleText(c)))].join(" / ");
  const where = refusal.code === "class-above-ceiling" ? `this agent's model may receive ${refusal.ceiling} at most and the content is ${level}` : "this agent's model may not receive it";
  return `${RUN_REFUSED} Data class ${named}${found}; rule ${tiers}: ${where}. The run's record shows the refusal.`;
}

/** The rule a residency refusal applied: `residency = "us"`. */
export function residencyRuleText(c: ClassRule): string {
  return `residency = "${c.residency}"`;
}

/**
 * Null when an endpoint in `region` may read content of this class; otherwise what a member is told. An endpoint
 * lab.toml gives no region is in none, so a class with a residency rule refuses it.
 */
export function residencyRefusal(c: ClassRule, cls: Classification, endpointId: string, region: string | null): string | null {
  if (c.residency === null || region === c.residency) return null;
  const why = cls.rule.startsWith("detector:") ? `, found by detector ${cls.rule.slice("detector:".length)}` : "";
  return `Not sent. Data class ${classLabel(c)}${why}; rule ${residencyRuleText(c)}: this agent's model endpoint ${endpointId} ${region ? `is in region ${region}` : "names no region"}. ${c.message}`;
}
