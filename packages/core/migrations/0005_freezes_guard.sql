-- A freeze row changes in one way only: the study owner ends it, once, with a
-- reason (study.ts unfreeze, exported as a protocol deviation). The hash, the
-- listing and who froze it stay, and nothing is deleted, so a study's record
-- of what ran in its channels cannot be rewritten.
revoke delete on freezes from public;
create function freezes_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'freezes is insert-only: unfreeze with a reason, keep the row' using errcode = 'insufficient_privilege';
  end if;
  if old.unfrozen_at is not null then
    raise exception 'an ended freeze never changes' using errcode = 'insufficient_privilege';
  end if;
  if new.study_id <> old.study_id or new.agent_id <> old.agent_id or new.hash <> old.hash or new.frozen_by <> old.frozen_by
     or new.at <> old.at or new.note <> old.note or new.listing <> old.listing then
    raise exception 'a freeze binds one version; only unfrozen_at, unfrozen_by and reason may be set' using errcode = 'insufficient_privilege';
  end if;
  if new.unfrozen_at is null or new.unfrozen_by is null or coalesce(btrim(new.reason), '') = '' then
    raise exception 'ending a freeze needs who and a reason' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger freezes_guard
  before update or delete on freezes
  for each row execute function freezes_guard();
