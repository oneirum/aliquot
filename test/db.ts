import { applySchema, connect, type Db } from "../packages/core/src/db.ts";

export const ADMIN_URL = process.env.LABH_TEST_PG ?? `postgres://postgres:labh@localhost:${process.env.LABH_PG_PORT ?? "5432"}/labh`;

export function databaseUrl(name: string): string {
  return ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
}

/** Drops and recreates a database for one test file, then applies the schema. */
export async function freshDatabase(name: string): Promise<{ db: Db; url: string }> {
  const admin = connect(ADMIN_URL);
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = databaseUrl(name);
  const db = connect(url);
  await applySchema(db);
  return { db, url };
}
