/**
 * Anchors: signed checkpoints of the hash chains, kept outside the database.
 *
 * The audit stream and every run record are hash-chained in Postgres, and
 * verifyAudit and verifyChain recompute those chains. Someone with write
 * access to the database can still rewrite a row and recompute every hash
 * after it, and the chains verify. An anchor closes that: every few minutes
 * the worker reads the head (seq, hash) of the audit stream and of each run
 * closed since the last anchor, signs them with an Ed25519 key that lives in
 * a file the database never sees, and appends one line to a log file.
 * verifyAnchors then checks each line's signature and that the database still
 * holds the signed hash at the signed seq. A rewrite before an anchor now
 * needs the key, and a rewrite after it shows.
 *
 * One line is canonical JSON:
 *   {"at","audit":{"hash","seq"}|null,"key","n","prev","runs":[{"hash","run","seq"}],"sig","v":1}
 * n counts lines from 1 and prev is the sha256 of the line before, so a line
 * removed from the middle or the end of a copy shows too. sig signs the line
 * without sig. key is the sha256 of the raw public key, so a line signed by
 * another key is named as such rather than as a bad signature.
 *
 * The log is plain text so research IT can ship each line to WORM storage or
 * a SIEM as it is written: `aliquot anchor` prints the line it appends, and
 * the worker logs it. Aliquot itself makes no network call for this.
 */

import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { loadAudit, verifyAudit } from "./audit.ts";
import type { Db } from "./db.ts";
import { canonicalJson, sha256, type Sha256 } from "./hash.ts";
import { loadEvents, verifyChain, type RunId } from "./record.ts";

/** The environment variable that names the signing key's file. The key is never in lab.toml or the database. */
export const ANCHOR_KEY_ENV = "LABH_ANCHOR_KEY_FILE";

export interface AnchorHead {
  readonly seq: number;
  readonly hash: Sha256;
}

export interface RunHead extends AnchorHead {
  readonly run: RunId;
}

export interface AnchorBody {
  readonly v: 1;
  readonly n: number;
  readonly at: string;
  readonly key: string;
  readonly prev: Sha256 | null;
  readonly audit: AnchorHead | null;
  readonly runs: readonly RunHead[];
}

export interface Anchor extends AnchorBody {
  readonly sig: string;
}

export interface AnchorSigner {
  readonly path: string;
  readonly key: KeyObject;
}

/** Any constant works; it names the one lock every anchor write takes, so two workers cannot fork the log. */
const ANCHOR_LOCK = 7_204_120;

/** A new Ed25519 private key as PKCS#8 PEM, for aliquot init to write once. */
export function newAnchorKeyPem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

/** The signing key from its PEM file. Throws a one-line reason when the file is not an Ed25519 private key. */
export function loadAnchorKey(path: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(path));
  } catch (err) {
    throw new Error(`${path} is not a readable private key: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} holds a ${key.asymmetricKeyType} key; anchors are signed with Ed25519`);
  return key;
}

/**
 * The key that checks anchors, from a PEM file holding either the private key
 * or only its public half. Research IT can verify with the public half alone.
 */
export function loadAnchorVerifyKey(path: string): KeyObject {
  const pem = readFileSync(path, "utf8");
  let key: KeyObject;
  try {
    key = pem.includes("PRIVATE KEY") ? createPublicKey(createPrivateKey(pem)) : createPublicKey(pem);
  } catch (err) {
    throw new Error(`${path} is not a readable key: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} holds a ${key.asymmetricKeyType} key; anchors are signed with Ed25519`);
  return key;
}

/** sha256 of the raw 32-byte public key: what an anchor line names its key by. */
export function keyFingerprint(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return sha256(Buffer.from(pub.export({ format: "jwk" }).x!, "base64url"));
}

export function publicKeyPem(key: KeyObject): string {
  return (key.type === "private" ? createPublicKey(key) : key).export({ type: "spki", format: "pem" }) as string;
}

function bodyOf(a: Anchor): AnchorBody {
  const { sig: _sig, ...body } = a;
  return body;
}

export function signAnchor(body: AnchorBody, key: KeyObject): Anchor {
  return { ...body, sig: sign(null, Buffer.from(canonicalJson(body)), key).toString("base64") };
}

export function anchorSignatureValid(a: Anchor, key: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(canonicalJson(bodyOf(a))), key, Buffer.from(a.sig, "base64"));
  } catch {
    return false;
  }
}

/** One parsed line, or the reason it is not an anchor. */
export function parseAnchorLine(text: string): Anchor | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "not JSON";
  }
  const a = v as Partial<Anchor>;
  const head = (h: unknown): boolean => typeof h === "object" && h !== null && Number.isInteger((h as AnchorHead).seq) && typeof (h as AnchorHead).hash === "string";
  if (
    typeof v !== "object" || v === null || a.v !== 1 || !Number.isInteger(a.n) || typeof a.at !== "string" || typeof a.key !== "string" || typeof a.sig !== "string" ||
    !(a.prev === null || typeof a.prev === "string") || !(a.audit === null || head(a.audit)) ||
    !Array.isArray(a.runs) || !a.runs.every((r) => head(r) && typeof (r as RunHead).run === "string")
  )
    return "not an anchor line (v, n, at, key, prev, audit, runs, sig)";
  return a as Anchor;
}

function logLines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

export class AnchorRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorRefused";
  }
}

export interface Anchored {
  /** The line as appended, without its newline: the export hook prints exactly this. */
  readonly line: string;
  readonly anchor: Anchor;
  /** Closed runs left out because their own chain does not verify; each is named with its first bad seq. */
  readonly skipped: readonly { readonly run: RunId; readonly seq: number }[];
}

/**
 * Signs the current heads and appends one line. Before signing it checks that
 * the audit rows written since the last anchor continue from the hash that
 * anchor signed, and that each new run's chain verifies, so it never signs a
 * head that already disagrees with an earlier anchor.
 */
export async function writeAnchor(db: Db, signer: AnchorSigner, now: Date = new Date()): Promise<Anchored> {
  const client = await db.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [ANCHOR_LOCK]);
    const lines = existsSync(signer.path) ? logLines(readFileSync(signer.path, "utf8")) : [];
    const anchors: Anchor[] = [];
    for (const [i, text] of lines.entries()) {
      const a = parseAnchorLine(text);
      if (typeof a === "string") throw new AnchorRefused(`${signer.path} line ${i + 1} is ${a}. Nothing was appended; run aliquot verify --anchors.`);
      anchors.push(a);
    }
    const last = anchors.at(-1);
    const lastAudit = anchors.findLast((a) => a.audit !== null)?.audit ?? null;
    const anchoredRuns = new Set(anchors.flatMap((a) => a.runs.map((r) => r.run)));

    const fresh = await loadAudit(db, lastAudit?.seq ?? 0);
    if (lastAudit) {
      const still = await client.query<{ hash: string }>("select hash from audit_events where seq = $1", [lastAudit.seq]);
      if (still.rows[0]?.hash !== lastAudit.hash)
        throw new AnchorRefused(`audit seq ${lastAudit.seq} no longer holds the hash the last anchor signed. Nothing was appended; run aliquot verify --anchors.`);
    }
    const bad = verifyAudit(fresh, lastAudit?.hash ?? null);
    if (bad !== null) throw new AnchorRefused(`audit seq ${bad} does not verify. Nothing was appended; run aliquot verify.`);
    const auditHead = fresh.at(-1) ?? null;

    const closed = await client.query<{ id: RunId }>("select id from jobs where kind = 'run' and status in ('done', 'failed') and head_seq is not null order by created_at, id");
    const runs: RunHead[] = [];
    const skipped: { run: RunId; seq: number }[] = [];
    for (const { id } of closed.rows) {
      if (anchoredRuns.has(id)) continue;
      const events = await loadEvents(db, id);
      const broken = verifyChain(events);
      if (broken !== null || !events.length) skipped.push({ run: id, seq: broken ?? 0 });
      else runs.push({ run: id, seq: events.at(-1)!.seq, hash: events.at(-1)!.hash });
    }

    const body: AnchorBody = {
      v: 1,
      n: (last?.n ?? 0) + 1,
      at: now.toISOString(),
      key: keyFingerprint(signer.key),
      prev: lines.length ? sha256(lines.at(-1)!) : null,
      audit: auditHead ? { seq: auditHead.seq, hash: auditHead.hash } : lastAudit,
      runs,
    };
    const anchor = signAnchor(body, signer.key);
    const line = canonicalJson(anchor);
    // "as" opens with O_SYNC, so the line is on disk when writeSync returns; fsync itself is refused under the permission model.
    const fd = openSync(signer.path, "as", 0o644);
    try {
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
    return { line, anchor, skipped };
  } finally {
    await client.query("select pg_advisory_unlock($1)", [ANCHOR_LOCK]).catch(() => {});
    client.release();
  }
}

export type AnchorProblem =
  | { readonly t: "bad-line"; readonly line: number; readonly why: string }
  | { readonly t: "bad-signature"; readonly line: number; readonly at: string }
  | { readonly t: "other-key"; readonly line: number; readonly at: string; readonly key: string }
  | { readonly t: "log-chain"; readonly line: number; readonly at: string; readonly why: string }
  | { readonly t: "audit-chain"; readonly seq: number }
  | { readonly t: "audit-diverged"; readonly line: number; readonly at: string; readonly from: number; readonly seq: number; readonly rowAt: string | null; readonly later: number }
  | { readonly t: "run-diverged"; readonly line: number; readonly at: string; readonly run: RunId; readonly seq: number; readonly why: "missing" | "chain" | "hash"; readonly badSeq: number | null };

export interface AnchorReport {
  readonly lines: number;
  /** The highest audit seq a valid anchor signed and the database still matches, or null. */
  readonly auditThrough: number | null;
  readonly runsChecked: number;
  readonly problems: readonly AnchorProblem[];
}

/**
 * Checks every line of an anchor log against the database: its place in the
 * log, its signature under `key`, and that the database still holds each
 * signed hash at its seq. A line whose signature fails is reported and its
 * contents are not trusted for anything else.
 */
export async function verifyAnchors(db: Db, logText: string, key: KeyObject): Promise<AnchorReport> {
  const fingerprint = keyFingerprint(key);
  const problems: AnchorProblem[] = [];
  const rows = await loadAudit(db);
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  const auditBad = verifyAudit(rows);
  if (auditBad !== null) problems.push({ t: "audit-chain", seq: auditBad });

  const lines = logLines(logText);
  let prevText: string | null = null;
  let lastGood = 0;
  let auditThrough: number | null = null;
  let diverged: { -readonly [K in keyof Extract<AnchorProblem, { t: "audit-diverged" }>]: Extract<AnchorProblem, { t: "audit-diverged" }>[K] } | null = null;
  let runsChecked = 0;
  for (const [i, text] of lines.entries()) {
    const line = i + 1;
    const a = parseAnchorLine(text);
    const expectedPrev = prevText === null ? null : sha256(prevText);
    prevText = text;
    if (typeof a === "string") {
      problems.push({ t: "bad-line", line, why: a });
      continue;
    }
    if (a.n !== line || a.prev !== expectedPrev)
      problems.push({ t: "log-chain", line, at: a.at, why: a.n !== line ? `it says it is line ${a.n}, so lines before it were removed or reordered` : "it does not follow the line before it, so a line between them was removed or changed" });
    if (a.key !== fingerprint) {
      problems.push({ t: "other-key", line, at: a.at, key: a.key });
      continue;
    }
    if (!anchorSignatureValid(a, key)) {
      problems.push({ t: "bad-signature", line, at: a.at });
      continue;
    }
    if (a.audit) {
      const row = bySeq.get(a.audit.seq);
      if (diverged) diverged.later++;
      else if (row?.hash === a.audit.hash) {
        lastGood = a.audit.seq;
        auditThrough = a.audit.seq;
      } else diverged = { t: "audit-diverged", line, at: a.at, from: lastGood + 1, seq: a.audit.seq, rowAt: row?.at ?? null, later: 0 };
    }
    for (const r of a.runs) {
      runsChecked++;
      const events = await loadEvents(db, r.run);
      const broken = verifyChain(events);
      if (!events.length) problems.push({ t: "run-diverged", line, at: a.at, run: r.run, seq: r.seq, why: "missing", badSeq: null });
      else if (broken !== null) problems.push({ t: "run-diverged", line, at: a.at, run: r.run, seq: r.seq, why: "chain", badSeq: broken });
      else if (events[r.seq]?.hash !== r.hash) problems.push({ t: "run-diverged", line, at: a.at, run: r.run, seq: r.seq, why: "hash", badSeq: null });
    }
  }
  if (diverged) problems.push(diverged);
  return { lines: lines.length, auditThrough, runsChecked, problems: problems.sort((x, y) => lineOf(x) - lineOf(y)) };
}

function lineOf(p: AnchorProblem): number {
  return p.t === "audit-chain" ? 0 : p.line;
}

export function describeAnchorProblem(p: AnchorProblem): string {
  switch (p.t) {
    case "bad-line":
      return `line ${p.line}: ${p.why}`;
    case "bad-signature":
      return `line ${p.line} (${p.at}): the signature does not verify, so this line was not written by the anchor key; its contents are ignored`;
    case "other-key":
      return `line ${p.line} (${p.at}): signed by key ${p.key.slice(0, 16)}, not by the key given (pass the right one with --public-key)`;
    case "log-chain":
      return `line ${p.line} (${p.at}): ${p.why}`;
    case "audit-chain":
      return `audit seq ${p.seq}: the stored chain does not recompute`;
    case "audit-diverged": {
      const rows = p.from === p.seq ? `audit seq ${p.seq}` : `audit seqs ${p.from} to ${p.seq}`;
      const when = p.rowAt ? `, the row now dated ${p.rowAt}` : ", and the row is gone";
      const later = p.later ? `; ${p.later} later anchor${p.later === 1 ? "" : "s"} disagree too` : "";
      return `${rows} changed after anchor line ${p.line} signed it at ${p.at}: the database no longer holds the signed hash at seq ${p.seq}${when}${later}`;
    }
    case "run-diverged":
      return p.why === "missing"
        ? `run ${p.run}: anchor line ${p.line} (${p.at}) signed it through seq ${p.seq}, and the database has no events for it`
        : p.why === "chain"
          ? `run ${p.run}: seq ${p.badSeq} does not recompute (anchor line ${p.line}, ${p.at})`
          : `run ${p.run}: changed at or before seq ${p.seq} after anchor line ${p.line} signed it at ${p.at}`;
  }
}

/** The worker's schedule: one anchor now, then one every `everyMs`, until the signal aborts. Failures are logged, never fatal. */
export async function anchorLoop(db: Db, signer: AnchorSigner, everyMs: number, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  while (!signal.aborted) {
    try {
      const out = await writeAnchor(db, signer);
      log(`anchor ${out.line}`);
      for (const s of out.skipped) log(`anchor: run ${s.run} left out, its chain does not verify at seq ${s.seq}`);
    } catch (err) {
      log(`anchor failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await sleep(everyMs, undefined, { signal });
    } catch {
      return;
    }
  }
}
