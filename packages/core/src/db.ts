/**
 * Postgres connection and schema. The only module that reads the
 * migrations: packages/core/migrations/NNNN_name.sql apply in file order,
 * each once, recorded in schema_migrations. Every pending one runs in one
 * transaction under an advisory lock, so two processes starting together
 * apply each migration once.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Db = pg.Pool;
/** A connection inside an open transaction. */
export type Tx = pg.PoolClient;

export function connect(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 8 });
}

// A path, not new URL("../migrations/", import.meta.url): Next's bundler, which the studio runs core inside, resolves that form as an asset and fails on a directory.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = /^\d{4}_[a-z0-9_]+\.sql$/;
/** One lock for every migrator of this schema. The number is arbitrary and fixed. */
const MIGRATION_LOCK = 7260419;

/** Applies every migration not yet recorded, in order. Returns the ids it applied. */
export async function applySchema(db: Db): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((f) => MIGRATION.test(f)).sort();
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query("create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query<{ id: string }>("select id from schema_migrations")).rows.map((r) => r.id));
    // A database made before this ledger existed has the first migration's tables and no rows here: record it rather than reapply it.
    const jobs = await client.query("select 1 from information_schema.tables where table_schema = current_schema() and table_name = 'jobs'");
    if (done.size === 0 && jobs.rowCount && files[0]) {
      await client.query("insert into schema_migrations (id) values ($1)", [files[0]]);
      done.add(files[0]);
    }
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query(await readFile(join(migrationsDir, f), "utf8"));
      await client.query("insert into schema_migrations (id) values ($1)", [f]);
      applied.push(f);
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  return applied;
}

/** The studio's Postgres role (migration 0011): it owns the studio schema and holds nothing in core's. */
export const STUDIO_ROLE = "aliquot_studio";
/** The env var that holds the studio role's password. compose.yaml gives it to the web door and puts it in the studio's DATABASE_URL. */
export const STUDIO_DB_PASSWORD_ENV = "ALIQUOT_STUDIO_DB_PASSWORD";

/**
 * Sets the studio role's password, as a SCRAM-SHA-256 verifier computed here, so the plain password never reaches the
 * server or its statement log. Returns false when the role does not exist (a migrator that was not a superuser).
 */
export async function setStudioPassword(db: Db, password: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(password)) throw new Error(`${STUDIO_DB_PASSWORD_ENV} must be at least 16 letters, digits, _ or -`);
  const role = await db.query("select 1 from pg_roles where rolname = $1", [STUDIO_ROLE]);
  if (!role.rowCount) return false;
  // Base64 and the separators only, so the verifier needs no quoting beyond the literal's own.
  await db.query(`alter role ${STUDIO_ROLE} with login password '${scramVerifier(password)}'`);
  return true;
}

/** Postgres's stored form of a SCRAM-SHA-256 password (RFC 7677): SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const hmac = (key: Buffer, text: string) => createHmac("sha256", key).update(text).digest();
  const storedKey = createHash("sha256").update(hmac(salted, "Client Key")).digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${hmac(salted, "Server Key").toString("base64")}`;
}
