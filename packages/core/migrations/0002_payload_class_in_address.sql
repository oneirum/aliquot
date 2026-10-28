-- The class is part of a payload's address (record.ts payloadAddress): the
-- same bytes at two classes are two rows, so a row's class never changes.
-- A row now changes in exactly two ways: a redaction (body to null, key
-- stays) and a key rewrap (a new key_id with a new ciphertext and nonce
-- under it). The rotation story is in docs/design/DESIGN.md.
create or replace function payloads_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payloads is insert-only: redact the body, keep the row' using errcode = 'insufficient_privilege';
  end if;
  if new.hash <> old.hash or new.bytes <> old.bytes or new.cls <> old.cls or new.created_at <> old.created_at then
    raise exception 'payloads rows are immutable except the body (redaction or rewrap)' using errcode = 'insufficient_privilege';
  end if;
  if new.ciphertext is null and new.nonce is null and new.key_id is not distinct from old.key_id then
    return new;                                                -- redaction
  end if;
  if new.key_id is distinct from old.key_id and old.ciphertext is not null and new.ciphertext is not null and new.nonce is not null and new.ciphertext <> old.ciphertext then
    return new;                                                -- rewrap: a new key and a new body together; a redacted body cannot come back
  end if;
  if new.ciphertext is not distinct from old.ciphertext and new.nonce is not distinct from old.nonce and new.key_id is not distinct from old.key_id then
    return new;                                                -- nothing changed
  end if;
  raise exception 'payloads bodies are never rewritten: redact (null body) or rewrap (new key_id with a new body)' using errcode = 'insufficient_privilege';
end $$;

-- A freeze snapshots the agent's listing (ceiling, provenance policy, IRB
-- protocol) as it was, so a republish cannot change what a study reported.
-- No freeze has been written yet, which is why NOT NULL needs no default.
alter table freezes add column listing jsonb not null;
