-- Key rotation and retention (record.ts).
--
-- payload_keys holds the lab's one address subkey, AES-256-GCM wrapped under
-- each master the lab has held. Addresses sit in hash-chained events and KB
-- names, so they never move: a new master gets the same subkey wrapped under
-- it, and an old master can be dropped once no body is under it.
create table payload_keys (
  key_id      text primary key,
  nonce       bytea not null,
  wrapped     bytea not null,
  created_at  timestamptz not null default now()
);

-- A redaction keeps a tombstone: the row's hash, class and bytes, plus when
-- and why the body went. Both are written with the redaction, never after.
alter table payloads add column redacted_at timestamptz, add column redaction_reason text;

-- The door keeps a copy of each reply for the chat page. The retention sweep
-- clears that text with the run's answer and marks when.
alter table web_messages add column redacted_at timestamptz;

create or replace function payloads_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payloads is insert-only: redact the body, keep the row' using errcode = 'insufficient_privilege';
  end if;
  if new.hash <> old.hash or new.bytes <> old.bytes or new.cls <> old.cls or new.created_at <> old.created_at then
    raise exception 'payloads rows are immutable except the body (redaction or rewrap)' using errcode = 'insufficient_privilege';
  end if;
  if new.redacted_at is distinct from old.redacted_at or new.redaction_reason is distinct from old.redaction_reason then
    if old.ciphertext is not null and new.ciphertext is null and new.nonce is null and new.key_id is not distinct from old.key_id and new.redacted_at is not null and new.redaction_reason is not null then
      return new;                                              -- redaction with its tombstone
    end if;
    raise exception 'a redaction tombstone is written once, with the redaction' using errcode = 'insufficient_privilege';
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
