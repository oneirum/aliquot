import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATA_CLASSES,
  DEFAULT_POLICY,
  Labelled,
  Unlabelled,
  PLACEMENTS,
  decideEgress,
  describeRefusal,
  join,
  placementOfHost,
  type DataClass,
  type Destination,
  type EgressRefusal,
  type Placement,
  type SurfaceId,
} from "../packages/core/src/dataclass.ts";

test("join is the maximum class and D0 for nothing", () => {
  assert.equal(join(), "D0");
  assert.equal(join("D1", "D3", "D0"), "D3");
  assert.equal(join("D2", "R"), "R");
});

test("Labelled.derive joins its inputs and cannot land below any of them", () => {
  const a = Labelled.stamp("x", "D1", "gate");
  const b = Labelled.stamp(1, "D3", "kb:snap");
  const d = Labelled.derive({ a: a.value, b: b.value }, [a, b], "prompt");
  assert.equal(d.cls, "D3");
  assert.equal(Labelled.derive("y", [], "floored-only", "D1").cls, "D1", "with no inputs the floor is the class");
  assert.equal(Labelled.derive("y", [a], "floored", "D2").cls, "D2");
  // @ts-expect-error the constructor is private: content gets a class only at an origin
  new Labelled("forged", "D0", "nowhere");
});

/** Content stamped at a class, for the decision. */
const at = (cls: DataClass) => Labelled.stamp("content", cls, "test");

const dest = (kind: "model" | "http" | "chat" | "store", placement: Placement): Destination => {
  switch (kind) {
    case "model":
      return { kind, endpointId: "e", placement };
    case "http":
      return { kind, host: "h", placement };
    case "chat":
      return { kind, surface: "web" as SurfaceId, placement };
    case "store":
      return { kind, placement };
  }
};

/** The placement table, restated as the highest class each placement admits. */
const EXPECTED: Record<"model" | "http" | "chat" | "store", Record<Placement, DataClass | "none">> = {
  model: { lab: "D3", institution: "D3", approved: "D2", zdr: "D1", public: "D0" },
  http: { lab: "D3", institution: "D2", approved: "D2", zdr: "D1", public: "D0" },
  chat: { lab: "D3", institution: "D2", approved: "D2", zdr: "D1", public: "D0" },
  store: { lab: "D3", institution: "D2", approved: "none", zdr: "none", public: "none" },
};

test("decideEgress follows the placement table for every class, kind and placement", () => {
  const classes = DATA_CLASSES.filter((c): c is Exclude<DataClass, "R"> => c !== "R");
  for (const kind of ["model", "http", "chat", "store"] as const) {
    for (const placement of PLACEMENTS) {
      const ceiling = EXPECTED[kind][placement];
      for (const cls of classes) {
        const d = decideEgress(at(cls), dest(kind, placement), DEFAULT_POLICY);
        const shouldAllow = ceiling !== "none" && DATA_CLASSES.indexOf(cls) <= DATA_CLASSES.indexOf(ceiling);
        assert.equal(d.allow, shouldAllow, `${cls} -> ${kind}/${placement}`);
        if (!d.allow) {
          const expected: EgressRefusal =
            ceiling === "none" ? { code: "destination-receives-nothing", payload: cls } : { code: "class-above-ceiling", payload: cls, ceiling };
          assert.deepEqual(d.refusal, expected);
        }
      }
    }
  }
});

test("an allowed decision hands back the same destination as the authorized route", () => {
  const d = decideEgress(at("D1"), { kind: "model", endpointId: "local", placement: "lab" }, DEFAULT_POLICY);
  assert.equal(d.allow, true);
  if (d.allow) assert.deepEqual({ ...d.to }, { kind: "model", endpointId: "local", placement: "lab" });
});

test("R is refused everywhere by default and only reaches lab model, store and chat under lab-only", () => {
  const labOnly = { reviewConfidential: "lab-only" } as const;
  assert.deepEqual(decideEgress(at("R"), dest("model", "lab"), DEFAULT_POLICY), { allow: false, refusal: { code: "review-confidential-refused" } });
  assert.equal(decideEgress(at("R"), dest("model", "lab"), labOnly).allow, true);
  assert.equal(decideEgress(at("R"), dest("store", "lab"), labOnly).allow, true);
  assert.equal(decideEgress(at("R"), dest("chat", "lab"), labOnly).allow, true);
  assert.deepEqual(decideEgress(at("R"), dest("http", "lab"), labOnly), { allow: false, refusal: { code: "review-confidential-needs-lab", placement: "lab" } });
  assert.deepEqual(decideEgress(at("R"), dest("model", "institution"), labOnly), {
    allow: false,
    refusal: { code: "review-confidential-needs-lab", placement: "institution" },
  });
});

test("export compares the payload with the reviewer clearance", () => {
  assert.equal(decideEgress(at("D1"), { kind: "export", clearance: "D1" }, DEFAULT_POLICY).allow, true);
  assert.deepEqual(decideEgress(at("D3"), { kind: "export", clearance: "D1" }, DEFAULT_POLICY), {
    allow: false,
    refusal: { code: "above-clearance", payload: "D3", clearance: "D1" },
  });
});

test("describeRefusal names the classes involved", () => {
  assert.equal(describeRefusal({ code: "class-above-ceiling", payload: "D3", ceiling: "D1" }), "D3 exceeds the destination ceiling D1");
});

test("placementOfHost fails closed to public for unlisted hosts", () => {
  const config = { hosts: { "api.openalex.org": "public" as const, "models.lab.internal": "lab" as const } };
  assert.equal(placementOfHost("models.lab.internal", config), "lab");
  assert.equal(placementOfHost("MODELS.LAB.INTERNAL", config), "lab");
  assert.equal(placementOfHost("evil.example", config), "public");
});

test("a forged label is refused at the egress decision and by derive, however it was forged", () => {
  const real = Labelled.stamp("participant P-12345", "D3", "gate");
  const parsed = JSON.parse(JSON.stringify({ ...real, cls: "D0" })) as Labelled<string>;
  const created = Object.assign(Object.create(Labelled.prototype), { value: real.value, cls: "D0", origin: "nowhere" }) as Labelled<string>;
  const literal = { value: real.value, cls: "D0", origin: "nowhere" } as unknown as Labelled<string>;
  for (const forged of [parsed, created, literal]) {
    assert.equal(Labelled.is(forged), false);
    assert.deepEqual(decideEgress(forged, dest("model", "zdr"), DEFAULT_POLICY), { allow: false, refusal: { code: "unlabelled" } });
    assert.throws(() => Labelled.derive("x", [forged], "test"), Unlabelled);
  }
  assert.equal(Labelled.is(real), true);
  assert.deepEqual(decideEgress(real, dest("model", "zdr"), DEFAULT_POLICY), { allow: false, refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } });
  assert.equal(decideEgress(Labelled.derive("x", [real], "test"), dest("model", "lab"), DEFAULT_POLICY).allow, true);
});
