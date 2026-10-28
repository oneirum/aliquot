import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { applySchema, connect, type Db } from "../packages/core/src/db.ts";
import { ADMIN_URL, databaseUrl } from "./db.ts";

const dir = new URL("../packages/core/migrations/", import.meta.url);
const migrations = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

/** A database with no schema at all. */
async function emptyDatabase(name: string): Promise<Db> {
  const admin = connect(ADMIN_URL);
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  return connect(databaseUrl(name));
}

const ledger = async (db: Db) => (await db.query<{ id: string }>("select id from schema_migrations order by id")).rows.map((r) => r.id);

test("migrations apply once, in file order, and are recorded", async () => {
  const db = await emptyDatabase("labh_test_migrate");
  try {
    assert.ok(migrations.length >= 2, `found ${migrations.join(", ")}`);
    assert.deepEqual(await applySchema(db), migrations);
    assert.deepEqual(await applySchema(db), []);
    assert.deepEqual(await ledger(db), migrations);
  } finally {
    await db.end();
  }
});

test("a database from before the ledger existed is brought forward without reapplying its first migration", async () => {
  const db = await emptyDatabase("labh_test_migrate_legacy");
  try {
    await db.query(await readFile(new URL(migrations[0]!, dir), "utf8"));
    assert.deepEqual(await applySchema(db), migrations.slice(1));
    assert.deepEqual(await ledger(db), migrations);
    const column = await db.query("select 1 from information_schema.columns where table_name = 'freezes' and column_name = 'listing'");
    assert.equal(column.rowCount, 1, "the second migration's change is present");
  } finally {
    await db.end();
  }
});

test("two processes migrating at once apply each migration once", async () => {
  const db = await emptyDatabase("labh_test_migrate_race");
  try {
    const [a, b] = await Promise.all([applySchema(db), applySchema(db)]);
    assert.deepEqual([...a, ...b].sort(), migrations, "each migration applied by exactly one of them");
    assert.deepEqual(await ledger(db), migrations);
  } finally {
    await db.end();
  }
});
