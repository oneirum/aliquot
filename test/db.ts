import { applySchema, connect, type Db } from "../packages/core/src/db.ts";

export const ADMIN_URL = process.env.LABH_TEST_PG ?? `postgres://postgres:labh@localhost:${process.env.LABH_PG_PORT ?? "5432"}/labh`;

/** LABH_TEST_DB_SUFFIX keeps two runs on one Postgres from dropping each other's databases. */
const suffix = process.env.LABH_TEST_DB_SUFFIX ?? "";
if (!/^[a-z0-9_]*$/.test(suffix)) throw new Error("LABH_TEST_DB_SUFFIX may hold only a-z, 0-9 and _");

export function testDatabase(name: string): string {
  return `${name}${suffix}`;
}

export function databaseUrl(name: string): string {
  return ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
}

/** Drops and recreates a database for one test file, then applies the schema. */
export async function freshDatabase(base: string): Promise<{ db: Db; url: string }> {
  const name = testDatabase(base);
  const admin = connect(ADMIN_URL);
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = databaseUrl(name);
  const db = connect(url);
  await applySchema(db);
  return { db, url };
}
