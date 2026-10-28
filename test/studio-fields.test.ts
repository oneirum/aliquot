import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { agentDocumentSchema, parseAgentDocument } from "../packages/core/src/agent.ts";
import { kbDefinitionSchema, parseKbDefinition } from "../packages/core/src/kb-compile.ts";
import { documentJson, formOf, issueOwner, payloadFields, validatedPaths, type GeneratedField, type ZodLike } from "../packages/studio/fields.ts";

const form = formOf(agentDocumentSchema);
const fields = payloadFields(form, { validate: () => () => true, presentation: { description: { textarea: true }, agentId: { unique: true } } });

/**
 * Every path the schema defines, walked from zod directly, with the label the
 * form must show. A union's discriminator is the form's own control (null:
 * not compared); its options carry the branch titles.
 */
function schemaPaths(s: ZodLike): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const unwrap = (x: ZodLike): ZodLike => (["optional", "default"].includes(x._zod.def.type) ? unwrap(x._zod.def.innerType!) : x);
  const walk = (x: ZodLike, path: string) => {
    const d = unwrap(x)._zod.def;
    const into = (shape: Readonly<Record<string, ZodLike>>, skip?: string) => {
      for (const [k, v] of Object.entries(shape)) if (k !== skip) walk(v, path ? `${path}.${k}` : k);
    };
    if (d.type === "union") {
      out.set(path, x.meta()?.title ?? null);
      out.set(`${path}.${d.discriminator!}`, null);
      for (const o of d.options!) into(o._zod.def.shape!, d.discriminator);
      return;
    }
    if (path) out.set(path, x.meta()?.title ?? null);
    if (d.type === "object") into(d.shape!);
    if (d.type === "array" && d.element!._zod.def.type === "object") into(d.element!._zod.def.shape!);
  };
  walk(s, "");
  return out;
}

/** Every path the generated Payload config has, with its label. */
function payloadPaths(fs: readonly GeneratedField[], prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  for (const f of fs) {
    const path = prefix ? `${prefix}.${f.name}` : f.name;
    out.set(path, f.label);
    if ("fields" in f) payloadPaths(f.fields, path, out);
  }
  return out;
}

test("every field the schema defines has a generated form field with the schema's label", () => {
  const generated = payloadPaths(fields);
  const missing: string[] = [];
  const mislabelled: string[] = [];
  for (const [path, title] of schemaPaths(agentDocumentSchema)) {
    if (!generated.has(path)) missing.push(path);
    else if (title !== null && generated.get(path) !== title) mislabelled.push(`${path}: ${String(generated.get(path))} != ${title}`);
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(mislabelled, []);
  assert.equal(generated.size, schemaPaths(agentDocumentSchema).size, "and no field the schema does not define");
  assert.equal(generated.get("audience"), "Audience");
  assert.equal(generated.get("audience.t"), "Type");
  assert.equal(generated.get("sandbox.enabled"), "Enabled");
  assert.equal(generated.get("model.modelId"), "Model id");
});

test("a schema field the generator cannot map, or one with no label, fails loudly", () => {
  assert.throws(() => formOf(z.object({ when: z.date().meta({ title: "When" }) })), /when is date, which the form generator does not map/);
  assert.throws(() => formOf(z.object({ name: z.string() })), /name is a field with no \.meta\(\{ title \}\)/);
  assert.throws(() => payloadFields(form, { validate: () => () => true, presentation: { nickname: { textarea: true } } }), /presentation names nickname, which is not a field/);
});

test("help text, defaults, options and conditions come from the schema", () => {
  const byName = (fs: readonly GeneratedField[], name: string) => fs.find((f) => f.name === name) as Record<string, any>;
  const description = byName(fields, "description");
  assert.equal(description.type, "textarea");
  assert.match(description.admin.description, /"Use when".*"Not for"/);
  assert.equal(description.required, true);
  assert.equal(byName(fields, "instructionsClass").defaultValue, "D1");
  assert.deepEqual(byName(fields, "ceiling").options.map((o: { value: string }) => o.value), ["D0", "D1", "D2", "D3", "R"]);
  const audience = byName(fields, "audience");
  const t = byName(audience.fields, "t");
  assert.deepEqual(t.options, [
    { value: "lab", label: "Whole lab" },
    { value: "study-team", label: "A study team" },
    { value: "pi-only", label: "PI only" },
    { value: "members", label: "Named members" },
  ]);
  assert.equal(t.defaultValue, "lab");
  const studyId = byName(audience.fields, "studyId");
  assert.equal(studyId.admin.condition({}, { t: "study-team" }), true);
  assert.equal(studyId.admin.condition({}, { t: "lab" }), false);
  assert.equal(byName(byName(fields, "sandbox").fields, "enabled").type, "checkbox");
});

const fixture = JSON.parse(await readFile(new URL("../fixtures/agent.json", import.meta.url), "utf8")) as Record<string, unknown>;

test("a saved Payload document converts back to the same agent document", () => {
  const saved = {
    id: 7,
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:00.000Z",
    ...fixture,
    tools: [{ id: "66f0", name: "kb_search", scopes: [] }, { id: "66f2", name: "kb_read", scopes: [] }],
    audience: { t: "lab", studyId: null, members: null },
    sandbox: { enabled: false, mountCeiling: null, mounts: null },
    limits: { maxSteps: null, maxTokens: null, maxWallMs: null },
    schedule: { cron: null, prompt: null },
    model: { endpointId: "local", modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 512, seed: null, topP: null } },
    evals: [{ id: "66f1", question: "Office hours?", expect: { t: "contains", text: "Tuesday", rubric: null } }],
    irbProtocol: null,
    consentPurpose: "",
  };
  const back = parseAgentDocument(documentJson(form, saved));
  const expected = parseAgentDocument({ ...fixture, evals: [{ question: "Office hours?", expect: { t: "contains", text: "Tuesday" } }] });
  assert.ok(back.ok && expected.ok, JSON.stringify(back));
  assert.deepEqual(back.doc, expected.doc);
  const studyTeam = documentJson(form, { audience: { t: "study-team", studyId: "S-1", members: ["ignored"] } });
  assert.deepEqual(studyTeam.audience, { t: "study-team", studyId: "S-1" });
});

test("each issue shows on the field that owns it", () => {
  const paths = validatedPaths(form);
  assert.equal(issueOwner(paths, "model.modelId"), "model.modelId");
  assert.equal(issueOwner(paths, "evals.0.expect.text"), "evals");
  assert.equal(issueOwner(paths, "maintainers.2"), "maintainers");
  assert.equal(issueOwner(paths, "sandbox"), "sandbox.enabled");
  const fromValidator = ["description", "model.modelId", "model.endpointId", "knowledgeBases", "consentPurpose", "skills", "tools", "irbProtocol", "sandbox"];
  assert.deepEqual(fromValidator.filter((f) => issueOwner(paths, f) === null), [], "every field validateAgentDraft names has an owner");
});

const kbForm = formOf(kbDefinitionSchema);

test("the KB form has a field for every path of the KB definition, with its label", () => {
  const generated = payloadPaths(payloadFields(kbForm, { validate: () => () => true }));
  const want = schemaPaths(kbDefinitionSchema);
  assert.deepEqual([...want.keys()].filter((p) => !generated.has(p)), []);
  assert.equal(generated.size, want.size, "and no field the definition does not define");
  assert.equal(generated.get("coverageQuestions"), "Coverage questions");
  assert.equal(generated.get("sources.location"), "Location");
  assert.equal(generated.get("compiler.modelId"), "Model id");
});

test("a saved KB form converts back to the definition the kb command reads from a file", async () => {
  const file = JSON.parse(await readFile(new URL("../fixtures/lab0/kb.json", import.meta.url), "utf8")) as { sources: Record<string, unknown>[] } & Record<string, unknown>;
  const saved = {
    id: 3,
    updatedAt: "2026-10-22T10:00:00.000Z",
    ...file,
    sources: file.sources.map((src, i) => ({ id: `row${i}`, ...src })),
    compiler: { endpointId: "local", modelId: "scripted-1", params: { temperature: 0, maxOutputTokens: 8192, seed: null } },
    irbProtocol: null,
    consentScope: "",
  };
  assert.deepEqual(parseKbDefinition(documentJson(kbForm, saved)), parseKbDefinition(file));
});
