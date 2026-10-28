/**
 * Content addressing. Every immutable thing in the harness is named by the
 * sha256 of its canonical JSON (or raw bytes for payload blobs).
 *
 * Invariant: two values with equal canonical JSON have equal hashes, on every
 * machine and every Node version. Canonical JSON follows RFC 8785 (JCS):
 * sorted keys, no whitespace, ECMAScript number formatting. Owned here, about
 * 40 lines, so a dependency upgrade can never change a frozen study's hash.
 */

import { createHash, createHmac, hkdfSync } from "node:crypto";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Lowercase hex sha256. */
export type Sha256 = Brand<string, "Sha256">;

/** Hash of a ResolvedAgent. The only way a run names the agent it executes. */
export type AgentVersionHash = Brand<string, "AgentVersionHash">;
/** Hash of a SkillVersion body. */
export type SkillVersionHash = Brand<string, "SkillVersionHash">;
/** Keyed address of a KbSnapshot manifest (entries map, sources, compiler, class). */
export type SnapshotId = Brand<string, "SnapshotId">;
/** Keyed address of one KB entry (path, title, body, facts), equal to its payload hash. Shared across snapshots. */
export type EntryHash = Brand<string, "EntryHash">;
/** Hash over a tool folder's files plus the tool-kit version. Not a git SHA: works in a tarball deploy and ignores unrelated commits. */
export type ToolHash = Brand<string, "ToolHash">;
/** Keyed address of a payload body in the payload store. */
export type PayloadHash = Brand<string, "PayloadHash">;

/** RFC 8785 canonical JSON. Throws on undefined, functions, NaN, Infinity, bigint. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out, "$");
  return out.join("");
}

function write(value: unknown, out: string[], path: string): void {
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      // JSON.stringify of a finite number is the ES Number::toString form JCS requires; -0 serializes as 0.
      out.push(JSON.stringify(value));
      return;
    case "object":
      if (value === null) {
        out.push("null");
        return;
      }
      if (Array.isArray(value)) {
        out.push("[");
        value.forEach((item, i) => {
          if (i > 0) out.push(",");
          write(item === undefined ? null : item, out, `${path}[${i}]`);
        });
        out.push("]");
        return;
      }
      if (value instanceof Uint8Array || value instanceof Date || value instanceof Map || value instanceof Set) {
        throw new TypeError(`canonicalJson: unsupported ${value.constructor.name} at ${path}`);
      }
      writeObject(value as Record<string, unknown>, out, path);
      return;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

function writeObject(obj: Record<string, unknown>, out: string[], path: string): void {
  // JCS sorts keys by UTF-16 code units, which is the default string comparison in JS.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  out.push("{");
  keys.forEach((k, i) => {
    if (i > 0) out.push(",");
    out.push(JSON.stringify(k), ":");
    write(obj[k], out, `${path}.${k}`);
  });
  out.push("}");
}

export function sha256(bytes: string | Uint8Array): Sha256 {
  return createHash("sha256").update(bytes).digest("hex") as Sha256;
}

/** sha256(canonicalJson(value)), re-branded by the caller's module. Only the owning module brands its kind. */
export function contentHash(value: unknown): Sha256 {
  return sha256(canonicalJson(value));
}

/**
 * A keyed content address: HMAC-SHA256 of the class, a newline and the
 * canonical JSON, under an address subkey derived from the store's master key.
 * Every name that leaves the store for a body (payload refs, KB entry hashes,
 * snapshot ids, KB source hashes) is one of these, so a reader of the name
 * cannot confirm a guessed body against it, and the same bytes at two classes
 * are two names. A class name never holds a newline, so the pair is unambiguous.
 */
export type Addresser = (cls: string, value: unknown) => Sha256;

/** HKDF info for the address subkey. Fixed for the life of the data: a change would move every address. */
const ADDRESS_INFO = "labh:payload:address:v1";

export function keyedAddresser(masterKey: Uint8Array): Addresser {
  const k = Buffer.from(hkdfSync("sha256", masterKey, "", ADDRESS_INFO, 32));
  return (cls, value) => createHmac("sha256", k).update(`${cls}\n`).update(canonicalJson(value), "utf8").digest("hex") as Sha256;
}
