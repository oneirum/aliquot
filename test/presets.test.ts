/**
 * Campus presets: a sample item of every campus tier goes through the real gate under lab.toml's preset and gets the
 * class and outcome the preset says, and a refusal names the campus tier beside Aliquot's class.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../packages/core/src/config.ts";
import type { DataClass } from "../packages/core/src/dataclass.ts";
import { gate, type InboundMessage } from "../packages/core/src/gate.ts";
import { classById, classLabel, residencyRefusal, classify } from "../packages/core/src/policy.ts";
import { PRESETS } from "../packages/core/src/preset.ts";
import type { MemberId } from "../packages/core/src/agent.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const lab = (extra = "") =>
  `[endpoints.local]\nbase_url = "http://127.0.0.1:1"\nplacement = "lab"\n[surfaces.web]\nplacement = "lab"\nport = 0\nchannel = "front"\n[channel_floors]\n"web:front" = "D0"\n[policy]\nparticipant_id_patterns = ['\\bP-\\d{5}\\b']\n${extra}`;
const withPreset = (preset: string, extra = "") => parseConfig(`preset = "${preset}"\n${lab(extra)}`, join(root, "lab.toml"));

/** What happens to the message: read by an approved hosted model, only by a lab or institution model, or refused at the door. */
type Outcome = "hosted" | "local only" | "refused";
interface Sample {
  readonly tier: string;
  readonly text: string;
  readonly floor: DataClass;
  readonly cls: string;
  readonly outcome: Outcome;
}

const CASES: Record<(typeof PRESETS)[number], { campus: string; samples: readonly Sample[] }> = {
  "uw-madison": {
    campus: "UW-Madison",
    samples: [
      { tier: "Public", text: "When is the lab's public seminar?", floor: "D0", cls: "public", outcome: "hosted" },
      { tier: "Internal", text: "Summarize last week's lab meeting notes.", floor: "D1", cls: "internal", outcome: "hosted" },
      { tier: "Sensitive", text: "Did P-12345 finish the follow-up survey?", floor: "D1", cls: "restricted", outcome: "local only" },
      { tier: "Restricted", text: "Patient: John Smith, MRN 0012345, was admitted 03/04/2026.", floor: "D1", cls: "phi", outcome: "refused" },
    ],
  },
  umich: {
    campus: "U-M",
    samples: [
      { tier: "Low", text: "Find the published paper on sleep and memory.", floor: "D0", cls: "public", outcome: "hosted" },
      { tier: "Moderate", text: "Draft an outline of our unpublished results.", floor: "D1", cls: "internal", outcome: "hosted" },
      { tier: "High", text: "Which consent groups does phs000123.v2.p1 allow?", floor: "D1", cls: "controlled_access", outcome: "refused" },
      { tier: "Restricted", text: "The participant paid with card 4111 1111 1111 1111.", floor: "D1", cls: "payment_card", outcome: "refused" },
    ],
  },
  harvard: {
    campus: "Harvard",
    samples: [
      { tier: "Level 1 Public, non-Sensitive", text: "When is the lab's public seminar?", floor: "D0", cls: "public", outcome: "hosted" },
      { tier: "Level 2 Low Risk, non-Sensitive", text: "Summarize last week's lab meeting notes.", floor: "D1", cls: "internal", outcome: "hosted" },
      { tier: "Level 3 Medium Risk, Sensitive", text: "Here is the DSL3 interview codebook for the coders.", floor: "D1", cls: "restricted", outcome: "local only" },
      { tier: "Level 4 High Risk, Sensitive", text: "ssn 123-45-6789 for the payroll form", floor: "D1", cls: "phi", outcome: "refused" },
      { tier: "Level 5 Extreme Risk, Sensitive", text: "This file is DSL5 and must not leave the enclave.", floor: "D1", cls: "extreme_risk", outcome: "refused" },
    ],
  },
};

const msg = (text: string): InboundMessage => ({ channel: { surface: "web", channelId: "front" }, threadId: "t1", messageId: "m1", platformUserId: "alice", text, attachments: [], addressed: true, at: "2026-01-01T00:00:00.000Z" });

for (const id of PRESETS) {
  const { campus, samples } = CASES[id];
  test(`preset ${id}: a sample of each ${campus} tier gets the expected class and outcome, and a refusal names the tier`, async () => {
    const config = withPreset(id);
    assert.deepEqual([...new Set(samples.map((s) => s.tier))], config.preset!.tiers, "one sample per tier, in the preset's order");
    for (const s of samples) {
      const r = await gate(msg(s.text), {
        members: async () => ({ id: "alice" as MemberId, audiences: [{ t: "lab" as const }] }),
        channelFloor: async () => s.floor,
        labPatterns: config.participantIdPatterns,
        policy: config.policy,
        classes: config.classes,
      });
      const cls = classify(config.classes, { t: "message", text: s.text, floor: s.floor }).class;
      const rule = classById(config.classes, cls);
      assert.equal(cls, s.cls, s.text);
      assert.deepEqual(rule.campusTier && { campus: rule.campusTier.campus, tier: rule.campusTier.tier }, { campus, tier: s.tier }, s.text);
      const outcome: Outcome = r.t === "refuse" ? "refused" : rule.modelTier === "local" ? "local only" : "hosted";
      assert.equal(outcome, s.outcome, s.text);
      if (r.t === "refuse") assert.match(r.userFacing, new RegExp(`^Not sent\\. Data class ${cls} \\(${campus} ${s.tier.replace(/[()]/g, "\\$&")}\\)`), r.userFacing);
    }
  });
}

test("every class of every preset names a tier and the page it rests on, and every tier has a class", () => {
  for (const id of PRESETS) {
    const config = withPreset(id);
    const text = readFileSync(join(root, "presets", `${id}.toml`), "utf8");
    assert.match(text, /starting point for your data steward/);
    for (const c of config.classes.classes) {
      assert.ok(c.campusTier, `${id} ${c.id}`);
      assert.match(c.campusTier.source, /^https:\/\//, `${id} ${c.id}`);
    }
    for (const tier of config.preset!.tiers) assert.ok(config.classes.classes.some((c) => c.campusTier?.tier === tier), `${id} has no class for ${tier}`);
  }
});

test("a residency refusal names the campus tier too", () => {
  const config = withPreset("uw-madison");
  const text = "The ITAR drawings for the sensor";
  const cls = classify(config.classes, { t: "message", text, floor: "D1" });
  const r = residencyRefusal(classById(config.classes, cls.class), cls, "hosted", null);
  assert.match(r!, /^Not sent\. Data class export_controlled \(UW-Madison Restricted\), found by detector export-marker; rule residency = "us"/);
});

test("the lab's own [classes] keys win over the preset's, and a class the lab adds must name a tier", () => {
  const config = withPreset("uw-madison", '[classes.phi]\nretention_days = 7\n[classes.restricted]\ncampus_tier = "Restricted"\n');
  const phi = classById(config.classes, "phi");
  assert.equal(phi.retentionDays, 7);
  assert.equal(phi.modelTier, "none", "the rest of the preset's phi stays");
  assert.equal(classLabel(classById(config.classes, "restricted")), "restricted (UW-Madison Restricted)");
  assert.throws(() => withPreset("uw-madison", '[classes.grants]\nmodel_tier = "local"\n'), /\[classes\.grants\] has no campus_tier; under preset uw-madison every class names one of Public, Internal, Sensitive, Restricted/);
  assert.throws(() => withPreset("uw-madison", '[classes.phi]\ncampus_tier = "Secret"\n'), /campus_tier = "Secret" is not a tier of preset uw-madison/);
  assert.throws(() => withPreset("stanford"), /preset = "stanford" is not a preset; the presets are uw-madison, umich, harvard/);
  assert.throws(() => parseConfig(lab('[classes.phi]\nmodel_tier = "none"\ncampus_tier = "Restricted"\n'), "/lab.toml"), /needs a preset/);
});

test("a lab's own preset file loads by a path relative to lab.toml, and must call itself a starting point", () => {
  const dir = mkdtempSync(join(tmpdir(), "labh-preset-"));
  const own = readFileSync(join(root, "presets/umich.toml"), "utf8").replace('campus = "U-M"', 'campus = "U-M Medicine"');
  writeFileSync(join(dir, "campus.toml"), own);
  const config = parseConfig(`preset = "./campus.toml"\n${lab()}`, join(dir, "lab.toml"));
  assert.equal(classLabel(classById(config.classes, "phi")), "phi (U-M Medicine High)");
  writeFileSync(join(dir, "bad.toml"), own.replace(/note = .*\n/, 'note = "The official classification."\n'));
  assert.throws(() => parseConfig(`preset = "bad.toml"\n${lab()}`, join(dir, "lab.toml")), /starting point for your data steward/);
});

test("without a preset nothing changes: no tier, and the refusal reads as before", async () => {
  const config = parseConfig(lab(readFileSync(join(root, "fixtures/policy/classes.toml"), "utf8")), "/lab.toml");
  assert.equal(config.preset, null);
  assert.ok(config.classes.classes.every((c) => c.campusTier === null));
  const r = await gate(msg("ssn 123-45-6789"), { members: async () => ({ id: "alice" as MemberId, audiences: [] }), channelFloor: async () => "D1", labPatterns: config.participantIdPatterns, policy: config.policy, classes: config.classes });
  assert.equal(r.t === "refuse" && r.userFacing.startsWith("Not sent. Data class phi, found by detector ssn;"), true);
});

test("the card-number detector takes Luhn-valid numbers only", () => {
  const config = withPreset("umich");
  const c = (text: string) => classify(config.classes, { t: "message", text, floor: "D1" }).class;
  assert.equal(c("card 4111-1111-1111-1111"), "payment_card");
  assert.equal(c("card 4111 1111 1111 1112"), "internal");
  assert.equal(c("sample 20260304120000 run"), "internal");
});

test("the README's preset tables are what pnpm presets:table prints", async () => {
  const { presetTables } = await import("../scripts/presets-table.ts");
  assert.ok(readFileSync(join(root, "README.md"), "utf8").includes(presetTables()), "run pnpm presets:table and paste its output into README \"Your campus's tiers\"");
});
