-- One position across the audit stream and every run record, for `aliquot audit export`.
--
-- A trigger stamps export_seq on insert after taking one transaction-scoped advisory lock, held until commit, so
-- export_seq order is commit order: a reader that has seen position n has already seen every committed row below n,
-- and `export --follow` can resume from the last position it printed without skipping a late commit. A copied row
-- that already carries a position (pg_restore) keeps it.
create sequence event_export_seq;

create function stamp_export_seq() returns trigger language plpgsql as $$
begin
  if new.export_seq is null then
    perform pg_advisory_xact_lock(7260420);
    new.export_seq := nextval('event_export_seq');
  end if;
  return new;
end $$;

alter table audit_events add column export_seq bigint;
alter table run_events add column export_seq bigint;

-- Rows written before this migration get positions in time order. run_events refuses updates for every role,
-- the owner included, so its guard is set aside for this one statement.
create temporary table export_backfill on commit drop as
  select src, k1, k2, row_number() over (order by at, src, k1, k2) as n from (
    select 'a' as src, lpad(seq::text, 20, '0') as k1, 0 as k2, at from audit_events
    union all
    select 'r', run_id::text, seq, at from run_events) rows;
update audit_events a set export_seq = b.n from export_backfill b where b.src = 'a' and lpad(a.seq::text, 20, '0') = b.k1;
alter table run_events disable trigger run_events_immutable;
update run_events r set export_seq = b.n from export_backfill b where b.src = 'r' and r.run_id::text = b.k1 and r.seq = b.k2;
alter table run_events enable trigger run_events_immutable;
select setval('event_export_seq', greatest(
  (select coalesce(max(export_seq), 0) from audit_events),
  (select coalesce(max(export_seq), 0) from run_events), 1));

alter table audit_events alter column export_seq set not null;
alter table run_events alter column export_seq set not null;
create unique index audit_events_export_seq on audit_events (export_seq);
create unique index run_events_export_seq on run_events (export_seq);
create index run_events_at on run_events (at);
create index audit_events_at on audit_events (at);

create trigger audit_events_export_seq before insert on audit_events for each row execute function stamp_export_seq();
create trigger run_events_export_seq before insert on run_events for each row execute function stamp_export_seq();
