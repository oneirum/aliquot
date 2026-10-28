/**
 * Form generation. Core's zod schema is the one definition of the agent
 * document; this module reads it and produces three things from the same walk:
 *
 *   formOf(schema)               the form tree: every field with its label, help text, required flag and default
 *   payloadFields(form, ...)     Payload field configs for the collection
 *   documentJson(form, data)     Payload's saved JSON back to the document's JSON, ready for parseAgentDocument
 *
 * A zod type this module does not map throws at startup and in
 * test/studio-fields.test.ts, so a schema change cannot silently drop a field.
 *
 * The output types below are the subset of Payload's field config this module
 * writes. They are declared here rather than imported so the core test program
 * never loads Payload's and Next's global types; the collection config checks
 * them against Payload's own `Field`.
 */


/** The parts of a zod 4 schema this module reads. Structural, so the studio needs no zod import of its own. */
export interface ZodLike {
  readonly _zod: { readonly def: ZodDef };
  meta(): { readonly title?: string; readonly description?: string } | undefined;
  readonly minValue?: number | null;
  readonly maxValue?: number | null;
  readonly isInt?: boolean;
}

interface ZodDef {
  readonly type: string;
  readonly innerType?: ZodLike;
  readonly defaultValue?: unknown;
  readonly shape?: Readonly<Record<string, ZodLike>>;
  readonly element?: ZodLike;
  readonly options?: readonly ZodLike[];
  readonly discriminator?: string;
  readonly entries?: Readonly<Record<string, string>>;
  readonly values?: readonly unknown[];
}

export type FormNode =
  | { readonly k: "text" }
  | { readonly k: "number"; readonly min: number | null; readonly max: number | null; readonly int: boolean }
  | { readonly k: "checkbox" }
  | { readonly k: "select"; readonly options: readonly { readonly value: string; readonly label: string }[] }
  | { readonly k: "texts" }
  | { readonly k: "group"; readonly children: readonly FormField[] }
  | { readonly k: "rows"; readonly children: readonly FormField[] }
  | { readonly k: "union"; readonly discriminator: FormField; readonly branches: readonly { readonly value: string | boolean; readonly children: readonly FormField[] }[] };

export interface FormField {
  readonly name: string;
  /** Dotted path from the document root, array indexes left out. */
  readonly path: string;
  readonly label: string;
  readonly help: string | null;
  /** Required in the document, and every enclosing group is required too. */
  readonly required: boolean;
  readonly optional: boolean;
  readonly defaultValue: unknown;
  readonly node: FormNode;
}

function unsupported(path: string, what: string): never {
  throw new Error(`studio form: ${path} is ${what}, which the form generator does not map. Map it in packages/studio/fields.ts.`);
}

export function formOf(schema: ZodLike): FormField[] {
  const def = schema._zod.def;
  if (def.type !== "object" || !def.shape) unsupported("(root)", def.type);
  return Object.entries(def.shape).map(([name, s]) => fieldOf(name, name, s, true));
}

function fieldOf(name: string, path: string, schema: ZodLike, parentRequired: boolean): FormField {
  const meta = schema.meta() ?? {};
  let s = schema;
  let optional = false;
  let defaultValue: unknown = undefined;
  for (;;) {
    const d = s._zod.def;
    if (d.type === "optional") optional = true;
    else if (d.type === "default") defaultValue = d.defaultValue;
    else break;
    s = d.innerType!;
  }
  const label = meta.title ?? s.meta()?.title;
  if (!label) unsupported(path, "a field with no .meta({ title })");
  const required = parentRequired && !optional && defaultValue === undefined;
  return { name, path, label, help: meta.description ?? s.meta()?.description ?? null, required, optional, defaultValue, node: nodeOf(path, s, required) };
}

function nodeOf(path: string, s: ZodLike, required: boolean): FormNode {
  const d = s._zod.def;
  switch (d.type) {
    case "string":
      return { k: "text" };
    case "number":
      return { k: "number", min: s.minValue ?? null, max: s.maxValue ?? null, int: s.isInt ?? false };
    case "boolean":
      return { k: "checkbox" };
    case "enum":
      return { k: "select", options: Object.values(d.entries!).map((v) => ({ value: v, label: v })) };
    case "object":
      return { k: "group", children: Object.entries(d.shape!).map(([n, c]) => fieldOf(n, `${path}.${n}`, c, required)) };
    case "array": {
      const el = d.element!;
      if (el._zod.def.type === "string") return { k: "texts" };
      if (el._zod.def.type === "object") return { k: "rows", children: Object.entries(el._zod.def.shape!).map(([n, c]) => fieldOf(n, `${path}.${n}`, c, false)) };
      return unsupported(path, `an array of ${el._zod.def.type}`);
    }
    case "union": {
      const key = d.discriminator;
      if (!key) return unsupported(path, "a union without a discriminator");
      const options = d.options!;
      const branches = options.map((o) => {
        const shape = o._zod.def.shape!;
        const literal = shape[key]!;
        const value = literal._zod.def.values![0] as string | boolean;
        return { value, label: literal.meta()?.title ?? String(value), children: Object.entries(shape).filter(([n]) => n !== key).map(([n, c]) => fieldOf(n, `${path}.${n}`, c, false)) };
      });
      const booleanDisc = branches.every((b) => typeof b.value === "boolean");
      const discriminator: FormField = {
        name: key,
        path: `${path}.${key}`,
        // A checkbox reads as its `true` branch ("Enabled"); a select picks a type.
        label: booleanDisc ? (branches.find((b) => b.value === true)?.label ?? "Enabled") : "Type",
        help: null,
        required,
        optional: false,
        defaultValue: undefined,
        node: booleanDisc ? { k: "checkbox" } : { k: "select", options: branches.map((b) => ({ value: String(b.value), label: b.label })) },
      };
      return { k: "union", discriminator, branches: branches.map(({ value, children }) => ({ value, children })) };
    }
    default:
      return unsupported(path, d.type);
  }
}

// Payload fields -----------------------------------------------------------

export type FieldValidate = (value: unknown, options: { readonly data: unknown }) => Promise<string | true> | string | true;
type Condition = (data: unknown, siblingData: Record<string, unknown>) => boolean;
type Serializable = boolean | number | object | string;

interface Common {
  readonly name: string;
  readonly label: string | false;
  readonly required?: true;
  readonly admin: { readonly description?: string; readonly condition?: Condition };
}
interface Leaf extends Common {
  readonly defaultValue?: Serializable;
  readonly validate?: FieldValidate;
}

export type GeneratedField =
  | (Leaf & { readonly type: "text"; readonly unique?: true; readonly index?: true })
  | (Leaf & { readonly type: "text"; readonly hasMany: true })
  | (Leaf & { readonly type: "textarea" })
  | (Leaf & { readonly type: "number"; readonly min?: number; readonly max?: number })
  | (Leaf & { readonly type: "checkbox" })
  | (Leaf & { readonly type: "select"; readonly options: { readonly value: string; readonly label: string }[] })
  | (Leaf & { readonly type: "array"; readonly fields: GeneratedField[] })
  | (Common & { readonly type: "group"; readonly fields: GeneratedField[] });

export interface Presentation {
  readonly textarea?: true;
  readonly unique?: true;
}

export interface PayloadFieldOptions {
  /** Validator for a field at a path. Fields inside array rows get none; their issues show on the array. */
  readonly validate: (path: string) => FieldValidate;
  readonly presentation?: Readonly<Record<string, Presentation>>;
}

/** Every path that gets a validator: leaves and arrays outside array rows. */
export function validatedPaths(form: readonly FormField[]): string[] {
  const out: string[] = [];
  const walk = (fields: readonly FormField[]) => {
    for (const f of fields) {
      if (f.node.k === "group") walk(f.node.children);
      else if (f.node.k === "union") {
        out.push(f.node.discriminator.path);
        for (const b of f.node.branches) walk(b.children);
      } else out.push(f.path);
    }
  };
  walk(form);
  return [...new Set(out)];
}

/**
 * Which validated field shows an issue. Exact match first, then the nearest
 * enclosing validated field (an array row's field shows on its array), then
 * the first validated field inside the issue's path (a group-level issue shows
 * on its first field).
 */
export function issueOwner(paths: readonly string[], issuePath: string): string | null {
  const p = issuePath
    .split(".")
    .filter((seg) => !/^\d+$/.test(seg))
    .join(".");
  if (paths.includes(p)) return p;
  const enclosing = paths.filter((q) => p.startsWith(`${q}.`)).sort((a, b) => b.length - a.length)[0];
  if (enclosing) return enclosing;
  return paths.find((q) => q.startsWith(`${p}.`)) ?? null;
}

export function payloadFields(form: readonly FormField[], opts: PayloadFieldOptions): GeneratedField[] {
  const presentation = opts.presentation ?? {};
  const known = new Set(validatedPaths(form));
  for (const p of Object.keys(presentation)) if (!known.has(p)) throw new Error(`studio form: presentation names ${p}, which is not a field`);
  return form.map((f) => toPayload(f, opts, presentation, true, undefined));
}

function toPayload(f: FormField, opts: PayloadFieldOptions, presentation: Readonly<Record<string, Presentation>>, validated: boolean, condition: Condition | undefined): GeneratedField {
  const p = presentation[f.path] ?? {};
  const admin = { ...(f.help ? { description: f.help } : {}), ...(condition ? { condition } : {}) };
  const base = { name: f.name, label: f.label, admin, ...(f.required && !condition ? { required: true as const } : {}) };
  const withDefault = f.defaultValue !== undefined && f.node.k !== "group" && f.node.k !== "union" ? { defaultValue: f.defaultValue as Serializable } : {};
  const validate = validated ? { validate: opts.validate(f.path) } : {};
  const node = f.node;
  switch (node.k) {
    case "text":
      return p.textarea ? { ...base, ...withDefault, ...validate, type: "textarea" } : { ...base, ...withDefault, ...validate, type: "text", ...(p.unique ? { unique: true as const, index: true as const } : {}) };
    case "number":
      return { ...base, ...withDefault, ...validate, type: "number", ...(node.min !== null ? { min: node.min } : {}), ...(node.max !== null ? { max: node.max } : {}) };
    case "checkbox":
      return { ...base, ...withDefault, ...validate, type: "checkbox" };
    case "select":
      return { ...base, ...withDefault, ...validate, type: "select", options: node.options.map((o) => ({ value: o.value, label: o.label })) };
    case "texts":
      return { ...base, ...withDefault, ...validate, type: "text", hasMany: true as const };
    case "group":
      return { ...base, type: "group", fields: node.children.map((c) => toPayload(c, opts, presentation, validated, undefined)) };
    case "rows":
      return { ...base, ...validate, type: "array", fields: node.children.map((c) => toPayload(c, opts, presentation, false, undefined)) };
    case "union": {
      const key = node.discriminator.name;
      const unionDefault = f.defaultValue as Record<string, unknown> | undefined;
      const disc = toPayload({ ...node.discriminator, defaultValue: unionDefault?.[key] }, opts, presentation, validated, undefined);
      const active = new Map<string, Set<string | boolean>>();
      const children: FormField[] = [];
      for (const b of node.branches) {
        for (const c of b.children) {
          if (!active.has(c.name)) {
            active.set(c.name, new Set());
            children.push(c);
          }
          active.get(c.name)!.add(b.value);
        }
      }
      const branchFields = children.map((c) => toPayload(c, opts, presentation, validated, (_data, sibling) => active.get(c.name)!.has(sibling[key] as string | boolean)));
      return { ...base, type: "group", fields: [disc, ...branchFields] };
    }
  }
}

// Payload JSON back to the document ----------------------------------------

const absent = (v: unknown) => v === null || v === undefined || v === "";

/** Picks the schema's fields out of a saved Payload document, drops Payload's own keys, and turns empty inputs into absent ones. */
export function documentJson(form: readonly FormField[], data: unknown): Record<string, unknown> {
  return objectOf(form, (data ?? {}) as Record<string, unknown>);
}

function objectOf(fields: readonly FormField[], data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = valueOf(f, data[f.name]);
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

function valueOf(f: FormField, v: unknown): unknown {
  const node = f.node;
  switch (node.k) {
    case "text":
    case "number":
    case "checkbox":
    case "select":
      return absent(v) ? undefined : v;
    case "texts":
      return Array.isArray(v) ? v : undefined;
    case "group": {
      const obj = objectOf(node.children, (v ?? {}) as Record<string, unknown>);
      return f.optional && Object.keys(obj).length === 0 ? undefined : obj;
    }
    case "rows":
      return Array.isArray(v) ? v.map((row) => objectOf(node.children, row as Record<string, unknown>)) : undefined;
    case "union": {
      const data = (v ?? {}) as Record<string, unknown>;
      const key = node.discriminator.name;
      const branch = node.branches.find((b) => b.value === data[key]);
      if (!branch) return undefined;
      return { [key]: branch.value, ...objectOf(branch.children, data) };
    }
  }
}
