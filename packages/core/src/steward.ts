/**
 * What a data steward runs, through `aliquot keys` and `aliquot retention`: which payload keys a process holds, what
 * each key holds, re-encryption after a rotation, and the retention sweep. Keys come from the env vars lab.toml's
 * [store] names. The studio never loads this module (test/boundaries.test.ts).
 *
 * Rotation never moves a payload's hash: the address subkey is the lab's for life (record.ts openPayloadStore), and a
 * re-encrypt rewrites only the ciphertext, nonce and key id. Retention deletes bodies and keeps tombstones, so every
 * event keeps its hash and every chain still verifies.
 */

import { appendAudit, appendAuditInTx, type AuditRow } from "./audit.ts";
import type { LabConfig } from "./config.ts";
import { DATA_CLASSES, type DataClass } from "./dataclass.ts";
import type { Db, Tx } from "./db.ts";
import type { PayloadHash } from "./hash.ts";
import { createPayloadStore, labAddressKey, loadEvents, verifyChain, type Keyring, type PayloadStore, type RunId } from "./record.ts";

const HEX_KEY = /^[0-9a-f]{64}$/i;

/** Key ids whose env var holds a key here. A key lab.toml names but this process was not given is not held, which is how a lab keeps D3's key apart. */
export function heldKeyIds(config: LabConfig, env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(Object.entries(config.store.keyEnvs).filter(([, name]) => HEX_KEY.test(env[name] ?? "")).map(([id]) => id));
}

/** Reads every payload key this process was given. The current key must be one of them; a set value that is not 64 hex characters is refused. */
export function payloadKeyringFromEnv(config: LabConfig, env: NodeJS.ProcessEnv = process.env): Keyring {
  const { keyEnvs, current, classKeys } = config.store;
  const many = Object.keys(keyEnvs).length > 1;
  const refuse = (id: string, name: string) => new Error(`${name} must hold 64 hex characters (32 bytes) for the payload store${many ? ` (key ${id})` : ""}`);
  const keys = new Map<string, Uint8Array>();
  for (const [id, name] of Object.entries(keyEnvs)) {
    const hex = env[name];
    if (!hex) continue;
    if (!HEX_KEY.test(hex)) throw refuse(id, name);
    keys.set(id, Buffer.from(hex, "hex"));
  }
  if (!keys.has(current)) throw refuse(current, keyEnvs[current]!);
  return { keys, current, classKeys };
}

/** The store over every key this process was given and the lab's address subkey. Every process that holds a key opens its store here. */
export async function openPayloadStore(db: Db, config: LabConfig, env: NodeJS.ProcessEnv = process.env): Promise<{ readonly store: PayloadStore; readonly keyring: Keyring }> {
  const keyring = payloadKeyringFromEnv(config, env);
  const store = createPayloadStore(db, { placement: config.store.placement, policy: config.policy, keyring, addressKey: await labAddressKey(db, keyring) });
  return { store, keyring };
}

export interface KeyStatus {
  readonly id: string;
  /** The env var lab.toml reads it from, or null when payloads are under an id lab.toml no longer names. */
  readonly env: string | null;
  readonly held: boolean;
  /** What new payloads go under it: "current", or the classes that name it. */
  readonly writes: readonly ("current" | DataClass)[];
  /** Bodies under it now. */
  readonly stored: number;
  /** Of those, how many `aliquot keys reencrypt` moves to their class's key. */
  readonly toMove: number;
}

/** Every key lab.toml names, in its order, then any id payloads are under that it does not name. */
export async function keyStatus(db: Db, config: LabConfig, held: ReadonlySet<string>): Promise<KeyStatus[]> {
  const { keyEnvs, current, classKeys } = config.store;
  const counts = await db.query<{ key_id: string; stored: number; to_move: number }>(
    `select key_id, count(*)::int as stored, count(*) filter (where key_id <> coalesce($1::jsonb ->> cls, $2))::int as to_move
     from payloads where ciphertext is not null and key_id is not null group by key_id order by key_id`,
    [JSON.stringify(classKeys), current],
  );
  const byId = new Map(counts.rows.map((r) => [r.key_id, r]));
  const ids = [...Object.keys(keyEnvs), ...counts.rows.map((r) => r.key_id).filter((id) => !(id in keyEnvs))];
  return ids.map((id) => ({
    id,
    env: keyEnvs[id] ?? null,
    held: held.has(id),
    writes: [...(id === current ? (["current"] as const) : []), ...DATA_CLASSES.filter((cls) => classKeys[cls] === id)],
    stored: byId.get(id)?.stored ?? 0,
    toMove: byId.get(id)?.to_move ?? 0,
  }));
}

/** Records that the lab's current key changed. Opening the store already wrapped the address key under every key this process holds. */
export async function recordRotation(db: Db, ring: Keyring, actor: string): Promise<AuditRow> {
  return appendAudit(db, actor, { t: "keys.rotated", current: ring.current, classKeys: ring.classKeys, held: [...ring.keys.keys()].sort() });
}

/**
 * Re-encrypts, batch by batch, every body this process can move to its class's key. Each batch commits on its own,
 * so a stopped run resumes where it stopped, and a second run finds nothing to do. Writes one audit event when it moved anything.
 */
export async function reencryptAll(db: Db, store: PayloadStore, ring: Keyring, actor: string, batch = 500, progress: (moved: number) => void = () => {}): Promise<number> {
  let moved = 0;
  for (let n = await store.reencrypt(batch); n > 0; n = await store.reencrypt(batch)) {
    moved += n;
    progress(moved);
  }
  if (moved) await appendAudit(db, actor, { t: "keys.reencrypted", current: ring.current, classKeys: ring.classKeys, rows: moved });
  return moved;
}

/** A body whose newest run is past its class's window. */
export interface RetentionCandidate {
  readonly hash: PayloadHash;
  readonly cls: DataClass;
  readonly bytes: number;
  /** When the newest run event that names it was written. */
  readonly lastUsed: string;
  readonly runs: readonly RunId[];
}

/**
 * Every object in an event with hash, cls and bytes is a PayloadRef (record.ts eventRefs), so this finds each body a
 * run names without loading events into the process. Strict mode, because lax .** visits array elements twice.
 */
const PAST_WINDOW = `
  select p.hash, p.cls, p.bytes, max(e.at) as last_used, array_agg(distinct e.run_id::text order by e.run_id::text) as runs
  from run_events e
  cross join lateral jsonb_path_query(e.event, 'strict $.** ? (@.type() == "object" && exists(@.hash) && exists(@.cls) && exists(@.bytes)).hash') as ref(h)
  join payloads p on p.hash = ref.h #>> '{}'
  where p.ciphertext is not null and $1::jsonb ? p.cls
  group by p.hash, p.cls, p.bytes
  having max(e.at) < $2::timestamptz - make_interval(days => ($1::jsonb ->> p.cls)::int)
  order by max(e.at), p.hash`;

/**
 * Run bodies past the window: every run that names the body (a later turn's history names earlier turns) is older
 * than its class's days. Knowledge base entries and compile prompts are not run bodies and are never candidates.
 */
export async function pastRetention(db: Pick<Db, "query">, days: LabConfig["retentionDays"], now: Date): Promise<RetentionCandidate[]> {
  if (!Object.keys(days).length) return [];
  const res = await db.query<{ hash: PayloadHash; cls: DataClass; bytes: number; last_used: Date; runs: string[] }>(PAST_WINDOW, [JSON.stringify(days), now.toISOString()]);
  return res.rows.map((r) => ({ hash: r.hash, cls: r.cls, bytes: r.bytes, lastUsed: r.last_used.toISOString(), runs: r.runs as RunId[] }));
}

/**
 * Redacts every candidate's body and keeps its tombstone (hash, class, bytes, when, why), with one audit event for
 * the sweep in the same transaction, even when nothing was past the window. Returns what this sweep redacted.
 */
export async function sweepRetention(db: Db, days: LabConfig["retentionDays"], now: Date, actor: string): Promise<{ readonly redacted: readonly RetentionCandidate[]; readonly audit: AuditRow }> {
  return inTx(db, async (tx) => {
    const candidates = await pastRetention(tx, days, now);
    const done = await tx.query<{ hash: PayloadHash }>(
      "update payloads set ciphertext = null, nonce = null, redacted_at = $2, redaction_reason = 'retention' where hash = any($1) and ciphertext is not null returning hash",
      [candidates.map((c) => c.hash), now.toISOString()],
    );
    const hit = new Set(done.rows.map((r) => r.hash));
    const redacted = candidates.filter((c) => hit.has(c.hash));
    const audit = await appendAuditInTx(tx, actor, {
      t: "retention.swept",
      days,
      asOf: now.toISOString(),
      redacted: redacted.length,
      bytes: redacted.reduce((n, c) => n + c.bytes, 0),
      runs: new Set(redacted.flatMap((c) => c.runs)).size,
    });
    return { redacted, audit };
  });
}

/** Recomputes each run's chain. Returns the runs whose chain does not verify. */
export async function brokenChains(db: Db, runs: readonly RunId[]): Promise<RunId[]> {
  const broken: RunId[] = [];
  for (const id of runs) if (verifyChain(await loadEvents(db, id)) !== null) broken.push(id);
  return broken;
}

async function inTx<T>(db: Db, body: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const out = await body(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
