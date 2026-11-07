import { test, after } from "node:test";
import assert from "node:assert/strict";
import { applySchema, connect, scramVerifier, setStudioPassword, STUDIO_ROLE } from "../packages/core/src/db.ts";
import { freshDatabase } from "./db.ts";

const { db, url } = await freshDatabase("labh_test_studio_role");
// A role belongs to the whole server, so every run of this test sets the same password: two runs at once cannot lock each other out.
const PASSWORD = "studio-role-test-password";
assert.equal(await setStudioPassword(db, PASSWORD), true);
const asStudio = new URL(url);
asStudio.username = STUDIO_ROLE;
asStudio.password = PASSWORD;
const studio = connect(asStudio.toString());
after(async () => {
  await studio.end();
  await db.end();
});

const denied = async (sql: string) => assert.rejects(studio.query(sql), (err: { code?: string }) => err.code === "42501", sql);

test("the studio's role cannot read or write core's tables", async () => {
  await db.query("insert into jobs (kind, key, status, payload) values ('run', 'grant-test', 'done', '{}')");
  for (const table of ["payloads", "web_messages", "run_events", "audit_events", "jobs", "agent_heads", "kb_snapshots", "worker_heartbeats"]) {
    await denied(`select 1 from ${table} limit 1`);
  }
  await denied("insert into audit_events (actor, hash, event) values ('studio', 'x', '{}')");
  await denied("update jobs set status = 'failed'");
  await denied("create table public.studio_was_here (id int)");
});

test("it owns the studio schema, where Payload creates its tables, and Payload's migration statement passes", async () => {
  await studio.query('CREATE SCHEMA IF NOT EXISTS "studio"');
  await studio.query("create table studio.grant_probe (id serial primary key, name text)");
  await studio.query("insert into studio.grant_probe (name) values ('ok')");
  assert.equal((await studio.query("select count(*)::int as n from studio.grant_probe")).rows[0].n, 1);
  await studio.query("drop table studio.grant_probe");
});

test("migrating again changes nothing, and tables made in studio before the role existed move to it", async () => {
  await db.query("create table studio.made_by_owner (id int)");
  await db.query("delete from schema_migrations where id = '0011_studio_role.sql'");
  await applySchema(db);
  await studio.query("insert into studio.made_by_owner values (1)");
  await denied("select 1 from payloads");
});

// The studio connection above signing in at all is the proof the verifier is right; this pins its stored form.
test("the password goes to Postgres as a SCRAM verifier, and a weak one is refused", async () => {
  const v = scramVerifier("pencil", Buffer.from("QSXCR+Q6sek8bf92", "base64"), 4096);
  assert.match(v, /^SCRAM-SHA-256\$4096:QSXCR\+Q6sek8bf92\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
  const stored = await db.query<{ rolpassword: string }>("select rolpassword from pg_authid where rolname = $1", [STUDIO_ROLE]);
  assert.match(stored.rows[0]!.rolpassword, /^SCRAM-SHA-256\$4096:/);
  await assert.rejects(setStudioPassword(db, "short"), /at least 16/);
  await assert.rejects(setStudioPassword(db, "it's-sixteen-chars-or-more"), /at least 16/);
});
