import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../packages/core/src/config.ts";
import { DEFAULT_POLICY, join as joinClasses, type DataClass } from "../packages/core/src/dataclass.ts";
import { classifyText } from "../packages/core/src/gate.ts";
import { buildPolicy, classify, defaultPolicy, DETECTOR_GROUPS, DETECTORS, RUN_REFUSED, runRefusalText } from "../packages/core/src/policy.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const labPatterns = [/\bP-\d{5}\b/];

/** The gate's detectors as they were before classes existed (9d428f3), kept here as the oracle the default policy must match. */
const BEFORE: readonly { kind: string; cls: DataClass; pattern: RegExp }[] = [
  { kind: "ssn", cls: "D3", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "mrn", cls: "D3", pattern: /\bMRN[:#\s]*\d{5,}\b/gi },
  { kind: "dob", cls: "D3", pattern: /\bDOB\b[:\s]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi },
  { kind: "phone", cls: "D2", pattern: /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g },
  { kind: "email", cls: "D2", pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  { kind: "review-marker", cls: "R", pattern: /\bREVIEW[- ]CONFIDENTIAL\b/gi },
];
function before(text: string, floor: DataClass) {
  const ds: { kind: string; cls: DataClass; span: [number, number] }[] = [];
  const scan = (kind: string, cls: DataClass, p: RegExp) => {
    for (const m of text.matchAll(new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`))) ds.push({ kind, cls, span: [m.index, m.index + m[0].length] });
  };
  for (const d of BEFORE) scan(d.kind, d.cls, d.pattern);
  for (const p of labPatterns) scan("participant-id", "D3", p);
  return { cls: joinClasses(floor, ...ds.map((d) => d.cls)), kinds: ds.map((d) => d.kind).sort(), spans: ds.map((d) => d.span.join("-")).sort() };
}

const CORPUS = [
  "What are the office hours?",
  "Did P-12345 finish the survey? Also P-67890.",
  "mail me at someone@example.org or call 608-555-0100",
  "ssn 123-45-6789 and MRN 0012345, DOB: 04/12/1990",
  "this is REVIEW-CONFIDENTIAL and REVIEW CONFIDENTIAL",
  "Patient: John Smith was admitted 03/04/2026 to 12 Main Street, WI 53706",
  "Which consent groups does phs000123.v2.p1 allow? ITAR item, ECCN 3A001",
  "see https://doi.org/10.1/x and https://portal.example.org/patient/42",
  "",
];

/** Corpus lines holding a form the gate before classes missed, and what the default policy now adds. */
const NEWLY_CAUGHT: Readonly<Record<string, { cls: DataClass; kinds: readonly string[] }>> = {
  "Patient: John Smith was admitted 03/04/2026 to 12 Main Street, WI 53706": { cls: "D3", kinds: ["phi-date"] },
};

test("the default policy finds everything the gate found before classes, and only the trust harness's missed forms besides", () => {
  const policy = defaultPolicy(DEFAULT_POLICY, labPatterns);
  for (const text of CORPUS)
    for (const floor of ["D0", "D1", "D2", "D3"] as const) {
      const now = classifyText(text, floor, labPatterns);
      const was = before(text, floor);
      const added = NEWLY_CAUGHT[text];
      const kept = now.detections.filter((d) => !added?.kinds.includes(d.kind));
      assert.deepEqual({ kinds: kept.map((d) => d.kind).sort(), spans: kept.map((d) => d.span.join("-")).sort() }, { kinds: was.kinds, spans: was.spans }, `${floor} ${text}`);
      assert.equal(now.cls, added ? joinClasses(was.cls, added.cls) : was.cls, `${floor} ${text}`);
      assert.equal(classify(policy, { t: "message", text, floor }).level, now.cls);
    }
});

test("the restricted class catches each form the trust harness found answered, and not the lab text beside them", () => {
  const lab1 = [/\bLAB1-\d{4}\b/];
  const level = (text: string) => classifyText(text, "D1", lab1).cls;
  // Held out: none of these strings is in fixtures/lab1, so a pass is not the fixture learned by heart.
  for (const text of [
    "SSN: 123 45 6789",
    "his social security no. 123456789",
    "SS# 219093315 for the stipend",
    "medical record no. 1234567",
    "Birth date 1/2/1980",
    "she was born on Feb 3, 1975",
    "date of birth: 12 Dec 1950",
    "Lab1-0042 and lab1 0043 and LAB1\u20140044 and LAB10045",
    "Policy number Q7-1100299 covers the visit",
    "Driver's license number: S530-4417-2201",
    "discharged 4/1/2026 after the scan",
    "the session ran from 192.168.0.20",
    "a full-face photo of the participant is in the share",
    "Ms. Alvarez's blood pressure was 150/95",
    "Ana Ruiz lives at 22 Elm Street, Verona",
    "mail it to her at 9 Birch Court",
  ])
    assert.equal(level(text), "D3", text);
  for (const text of [
    "Order 123-45-6789 arrived; where do I store it?",
    "Serial no 412-55-8820 is the old freezer.",
    "SKU 530217741 is the pipette tip box.",
    "Wear a full-face respirator for the solvent transfer.",
    "Dr. Okafor's office hours are on Tuesday.",
    "Mr. Fix-It visits on Friday to service the fume hood.",
    "Deliveries go to 1500 Highland Avenue, loading dock B.",
    "Firmware 10.4.2 is on the plate reader.",
    "The wiki is at http://10.0.4.12:8080/handbook and the worker on 127.0.0.1.",
    "lab1 members meet in room 3120.",
    "What does DOB stand for on the intake form?",
    "Book the centrifuge 42 hours ahead.",
  ])
    assert.equal(level(text), "D1", text);
  // An area the SSA never issues (000, 666, 9xx) is not an SSN even after a label.
  assert.equal(level("SSN 900-12-3456"), "D1");
  // A handbook that lists instrument addresses moves phi-ip out of restricted in lab.toml, as with any built-in detector.
  const moved = buildPolicy({ internal: { detectors: ["phi-ip"] } }, DEFAULT_POLICY, lab1);
  assert.equal(classify(moved, { t: "entry", text: "The plate reader PC is at 10.0.4.12.", declared: "D1" }).level, "D1");
  assert.equal(classify(moved, { t: "entry", text: "LAB1-0042 used the plate reader PC.", declared: "D1" }).level, "D3");
});

test("a lab.toml with no [classes] gets the five built-in classes, and only review-confidential under refuse is refused", () => {
  const c = parseConfig("[endpoints.local]\nbase_url = \"http://127.0.0.1:1\"\nplacement = \"lab\"\n", "/lab/lab.toml");
  assert.deepEqual(c.classes.classes.map((k) => [k.id, k.level, k.modelTier, k.record]), [
    ["public", "D0", "hosted", "text"],
    ["internal", "D1", "hosted", "text"],
    ["confidential", "D2", "hosted", "text"],
    ["restricted", "D3", "local", "text"],
    ["review-confidential", "R", "none", "hash"],
  ]);
  const labOnly = parseConfig('[endpoints.local]\nbase_url = "http://127.0.0.1:1"\nplacement = "lab"\n[policy]\nreview_confidential = "lab-only"\n', "/lab/lab.toml");
  assert.equal(labOnly.classes.classes.find((k) => k.id === "review-confidential")!.modelTier, "local");
});

test("classify names the strictest class, the rule and every span", () => {
  const policy = parseConfig(`[endpoints.local]\nbase_url = "http://127.0.0.1:1"\nplacement = "lab"\n[policy]\nparticipant_id_patterns = ['\\bP-\\d{5}\\b']\n${readFileSync(join(root, "fixtures/policy/classes.toml"), "utf8")}`, "/lab/lab.toml").classes;
  const m = (text: string, floor: DataClass = "D1") => classify(policy, { t: "message", text, floor });
  assert.deepEqual(m("What are the office hours?"), { class: "internal", level: "D1", rule: "floor:D1", spans: [] });
  assert.deepEqual(m("hi", "D0"), { class: "public", level: "D0", rule: "floor:D0", spans: [] });
  assert.equal(m("ra-1@example.org").class, "confidential");
  assert.deepEqual(m("Did P-12345 finish?"), { class: "restricted", level: "D3", rule: "detector:participant-id", spans: [{ detector: "participant-id", class: "restricted", span: [4, 11] }] });
  assert.equal(m("phs000123 for P-12345").class, "controlled_access", "none beats local");
  assert.equal(m("ITAR for P-12345").class, "export_controlled", "export_controlled is declared after restricted at the same tier and level");
  // none beats local: the PHI makes it refused whatever else it holds.
  const mixed = m("P-12345 is Patient: John Smith");
  assert.equal(mixed.class, "phi");
  assert.equal(mixed.rule, "detector:phi-name");
  assert.deepEqual(mixed.spans.map((s) => s.class), ["restricted", "phi"]);
  assert.equal(m("ITAR").class, "export_controlled");
  assert.equal(policy.classes.find((c) => c.id === "export_controlled")!.residency, "us");
  assert.equal(m("REVIEW-CONFIDENTIAL").level, "R");
  assert.deepEqual(classify(policy, { t: "entry", text: "DUA: phs000999\nThe cohort's consent groups.", declared: "D1" }).class, "controlled_access");
  assert.equal(classify(policy, { t: "entry", text: "Plain SOP", declared: "D2" }).rule, "declared:D2");
});

test("every Safe Harbor detector finds its identifier and leaves ordinary lab text alone", () => {
  const all = buildPolicy({ phi: { model_tier: "none", detectors: ["hipaa-safe-harbor"] }, dua: { model_tier: "local", detectors: ["dua-marker"] }, exp: { model_tier: "none", detectors: ["export-marker"] }, card: { model_tier: "none", detectors: ["card-number"] } }, DEFAULT_POLICY, []);
  const hits = (text: string) => [...new Set(classify(all, { t: "message", text, floor: "D1" }).spans.map((s) => s.detector))].sort();
  const POSITIVE: Record<string, string> = {
    "phi-name": "Patient name: Maria Lopez",
    "phi-name-health": "Mr. Hassan's heart rate was 48",
    "phi-name-address": "Daniel Reyes at 1420 Willow Lane",
    "phi-photo": "full-face photograph in folder P042",
    "phi-address": "lives at 1210 West Dayton Street",
    "phi-zip": "zip code 53706",
    "phi-date": "discharged on Mar 4, 2026",
    "phi-age": "a 93 year old participant",
    "phi-fax": "fax 608-555-0199",
    "phi-health-plan": "member id ABC123456",
    "phi-account": "account number 12345678",
    "phi-license": "NPI 1234567890",
    "phi-vehicle": "VIN 1HGCM82633A004352",
    "phi-device": "pacemaker serial no SN12345678",
    "phi-url": "https://portal.example.org/patient/42",
    "phi-ip": "logged in from 192.168.10.4",
    "phi-biometric": "fingerprint template FP-99812",
    ssn: "123-45-6789",
    mrn: "MRN 0012345",
    dob: "DOB 04/12/1990",
    phone: "608-555-0100",
    email: "a@b.org",
    "dua-marker": "phs000123.v2.p1",
    "export-marker": "EAR99",
    "card-number": "card 4111 1111 1111 1111",
  };
  for (const [det, text] of Object.entries(POSITIVE)) assert.ok(hits(text).includes(det), `${det} on "${text}": got ${hits(text).join(",")}`);
  for (const text of [
    "What are the office hours?",
    "Store aliquots at -80 C in freezer 3, shelf 2, rack 96-well plate 4.",
    "Read https://doi.org/10.1038/s41586-020-2649-2 and https://pubmed.ncbi.nlm.nih.gov/123456/",
    "The 2026 cohort ran 12 weeks; we enrolled 45 participants in May.",
    "Our sleep diary codebook uses items SD1 through SD14.",
  ])
    assert.deepEqual(hits(text), [], text);
  assert.deepEqual([...DETECTOR_GROUPS["hipaa-safe-harbor"]!].sort(), Object.keys(POSITIVE).filter((d) => d.startsWith("phi-") || ["ssn", "mrn", "dob", "phone", "email"].includes(d)).sort());
  assert.ok(Object.keys(DETECTORS).every((d) => d in POSITIVE || d === "participant-id" || d === "review-marker"));
});

test("a policy the lattice would not enforce does not load, and each error names the key", () => {
  const bad: [Record<string, object>, RegExp][] = [
    [{ x: { model_tier: "hosted", level: "D3" } }, /\[classes\.x\] has model_tier = "hosted" at level D3/],
    [{ x: { model_tier: "hosted" } }, /\[classes\.x\] needs level/],
    [{ x: {} }, /\[classes\.x\] needs model_tier/],
    [{ x: { model_tier: "local", record: "hash" } }, /a class a model reads is stored as text/],
    [{ restricted: { level: "D2" } }, /built-in class at level D3/],
    [{ "review-confidential": { model_tier: "local" } }, /review_confidential/],
    [{ x: { model_tier: "none", detectors: ["ssn"] }, y: { model_tier: "none", detectors: ["ssn"] } }, /\[classes\.y\] names detector ssn, which \[classes\.x\] already names/],
    [{ x: { model_tier: "none", detectors: ["nope"] } }, /names detector nope, which does not exist/],
    [{ Bad: { model_tier: "none" } }, /is not a class id/],
  ];
  for (const [declared, re] of bad) assert.throws(() => buildPolicy(declared as never, DEFAULT_POLICY, []), re, JSON.stringify(declared));
  assert.throws(() => parseConfig('[endpoints.local]\nbase_url = "http://127.0.0.1:1"\nplacement = "lab"\n[store]\nplacement = "lab"\n[classes.x]\nmodel_tier = "none"\nrecord = "text"\nlevel = "R"\n', "/l.toml"), /\[classes\.x\] has record = "text", but review-confidential text/);
  assert.throws(() => parseConfig('[endpoints.local]\nbase_url = "http://127.0.0.1:1"\nplacement = "lab"\n[classes.x]\nmodel_tier = "none"\nwhat = 1\n', "/l.toml"));
});

test("a detector a lab class names leaves the built-in class that held it", () => {
  const p = buildPolicy({ phi: { model_tier: "none", detectors: ["ssn", "mrn"] } }, DEFAULT_POLICY, labPatterns);
  assert.deepEqual(p.classes.find((c) => c.id === "restricted")!.detectors, ["dob", "participant-id", "phi-name-health", "phi-name-address", "phi-date", "phi-health-plan", "phi-license", "phi-ip", "phi-photo"]);
  assert.equal(classify(p, { t: "message", text: "ssn 123-45-6789", floor: "D1" }).class, "phi");
});

test("a run's refusal notice names the message's class, or every class at the refused level", () => {
  const p = buildPolicy({ controlled: { model_tier: "local", detectors: ["dua-marker"] } }, DEFAULT_POLICY, labPatterns);
  const refusal = { code: "class-above-ceiling", payload: "D3", ceiling: "D2" } as const;
  assert.equal(runRefusalText(p, refusal, { id: "controlled", rule: "detector:dua-marker" }), 'This request cannot be answered here: it contains restricted data that the configured model may not receive. Data class controlled, found by detector dua-marker; rule model_tier = "local": this agent\'s model may receive D2 at most and the content is D3. The run\'s record shows the refusal.');
  assert.match(runRefusalText(p, refusal, { id: "internal", rule: "floor:D1" })!, /^This request cannot be answered here: it contains restricted data that the configured model may not receive\. Data class restricted or controlled; rule model_tier = "local"/);
  assert.equal(runRefusalText(p, { code: "host-not-declared", host: "x" }), null);
});

test("the default policy's refused-run notice still opens with the sentence slice1 check 4 reads, then names the class and rule", () => {
  const p = defaultPolicy(DEFAULT_POLICY, labPatterns);
  const msg = { id: "restricted", rule: "detector:participant-id" };
  const text = runRefusalText(p, { code: "class-above-ceiling", payload: "D3", ceiling: "D1" }, msg)!;
  assert.ok(text.startsWith(RUN_REFUSED), text);
  assert.match(text, /restricted data/);
  assert.match(text, /Data class restricted, found by detector participant-id; rule model_tier = "local"/);
});
