-- The studio's own Postgres role. The studio is the one unsealed process (studio.ts): it reaches core through the web
-- door, so its role holds nothing in core's schema. It owns the studio schema, where Payload keeps its users, agent
-- drafts and KB definitions, and may create schemas in this database because Payload's migration runs
-- CREATE SCHEMA IF NOT EXISTS, which Postgres checks against the database before it looks for the schema.
--
-- A role belongs to the whole Postgres server, so the first database to migrate creates it and every later one grants
-- to it. The role starts with no password: the web door sets one from ALIQUOT_STUDIO_DB_PASSWORD when it starts
-- (db.ts setStudioPassword). Handing the schema to the role takes a superuser, which the compose stack's postgres
-- user is; any other migrator skips all of this with a notice, and docs/install.md has the statements for the lab's
-- database administrator.
do $$
declare
  t record;
begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    raise notice 'aliquot_studio not set up: % is not a superuser. docs/install.md, "Least privilege", has the statements.', current_user;
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aliquot_studio') then
    create role aliquot_studio login;
  end if;
  execute format('grant connect, create on database %I to aliquot_studio', current_database());
  execute 'create schema if not exists studio';
  execute 'alter schema studio owner to aliquot_studio';
  -- A database made before this migration has Payload's tables, sequences and enum types owned by whoever ran it.
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'studio' and c.relkind in ('r', 'p', 'v', 'm', 'f') loop
    execute format('alter table studio.%I owner to aliquot_studio', t.relname);
  end loop;
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'studio' and c.relkind = 'S' and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i')) loop
    execute format('alter sequence studio.%I owner to aliquot_studio', t.relname);
  end loop;
  for t in select y.typname from pg_type y join pg_namespace n on n.oid = y.typnamespace
           where n.nspname = 'studio' and y.typtype = 'e' loop
    execute format('alter type studio.%I owner to aliquot_studio', t.typname);
  end loop;
  -- Nothing in core's schema: no table, sequence or function grant beyond what PUBLIC holds by default.
  execute 'revoke all on all tables in schema public from aliquot_studio';
  execute 'revoke all on all sequences in schema public from aliquot_studio';
end $$;
