-- All core tables. Payload CMS keeps its own tables (drafts, revisions, users)
-- in a separate schema "studio"; core never reads them.

-- Immutable, content-addressed -------------------------------------------

create table agent_versions (
  hash        text primary key,            -- sha256(canonicalJson(ResolvedAgent))
  agent_id    text not null,
  body        jsonb not null,              -- ResolvedAgent
  created_at  timestamptz not null default now()
);

-- Insert-only at the database level. The revoke covers any non-owner role the
-- app connects as; the trigger covers the owner too, so neither a bug nor a
-- manual query can change a frozen version.
revoke update, delete on agent_versions from public;
create function refuse_change() returns trigger language plpgsql as $$
begin
  raise exception '% is insert-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;
create trigger agent_versions_immutable
  before update or delete on agent_versions
  for each row execute function refuse_change();

create table skill_versions (
  hash text primary key, skill_id text not null, cls text not null, body jsonb not null,
  created_at timestamptz not null default now()
);

create table kb_snapshots (
  id text primary key, kb_id text not null, cls text not null,
  manifest jsonb not null,                 -- KbSnapshot minus entry bodies
  created_at timestamptz not null default now()
);

create table kb_compile_cache (           -- per-source compile results and coverage verdicts, keyed by their inputs
  key         text primary key,            -- sha256 over the inputs, the compiler target and the prompt hash
  kind        text not null,               -- source | coverage
  result      text not null,               -- payload hash of the result body
  cls         text not null,
  created_at  timestamptz not null default now()
);

create table payloads (
  hash        text primary key,            -- HMAC-SHA256 of the plaintext under the store key (record.ts): a keyed address, so it confirms no guessed body
  cls         text not null,
  ciphertext  bytea,                       -- null after retention sweep or withdrawal deletion
  nonce       bytea,
  key_id      text,                        -- AES-256-GCM key per class, from env/file
  bytes       integer not null,
  created_at  timestamptz not null default now()
);

-- A payload row changes in exactly two ways: its class goes up (the same
-- bytes stored again under a higher class) and its body is redacted
-- (retention or withdrawal set ciphertext and nonce to null). The hash and
-- the rest stay, so events keep resolving. Nothing is deleted.
revoke delete on payloads from public;
create function payloads_guard() returns trigger language plpgsql as $$
declare
  ranks text[] := array['D0', 'D1', 'D2', 'D3', 'R'];
begin
  if tg_op = 'DELETE' then
    raise exception 'payloads is insert-only: redact the body, keep the row' using errcode = 'insufficient_privilege';
  end if;
  if new.hash <> old.hash or new.bytes <> old.bytes or new.key_id is distinct from old.key_id or new.created_at <> old.created_at then
    raise exception 'payloads rows are immutable except cls (up) and the body (redaction)' using errcode = 'insufficient_privilege';
  end if;
  if array_position(ranks, new.cls) < array_position(ranks, old.cls) then
    raise exception 'payloads.cls only goes up' using errcode = 'insufficient_privilege';
  end if;
  if not ((new.ciphertext is not distinct from old.ciphertext and new.nonce is not distinct from old.nonce) or (new.ciphertext is null and new.nonce is null)) then
    raise exception 'payloads bodies are never rewritten, only redacted' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger payloads_guard
  before update or delete on payloads
  for each row execute function payloads_guard();

-- Live pointers (single owner each) --------------------------------------

create table agent_heads (                 -- written only by publish.confirmPublish
  agent_id     text primary key,
  document     jsonb not null,             -- AgentDocument, floating refs
  listing      jsonb not null,             -- AgentListing
  published_by text not null,
  published_at timestamptz not null,
  changelog    text not null
);

create table skill_heads (skill_id text primary key, hash text not null references skill_versions);
create table kb_heads    (kb_id text primary key, snapshot text not null references kb_snapshots);

-- Studies -----------------------------------------------------------------

create table studies (
  id text primary key, title text not null, owner text not null,
  prereg_url text, irb_protocol text, consent_scope text, data_floor text not null default 'D1'
);
create table study_channels (
  study_id text not null references studies, surface text not null, channel_id text not null,
  primary key (surface, channel_id)
);
create table freezes (
  study_id text not null references studies, agent_id text not null,
  hash text not null references agent_versions,
  frozen_by text not null, at timestamptz not null default now(), note text not null,
  unfrozen_by text, unfrozen_at timestamptz, reason text
);
create unique index one_active_freeze on freezes (study_id, agent_id) where unfrozen_at is null;

-- Durable execution -------------------------------------------------------

create table jobs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  key          text not null unique,       -- idempotency: msg:<surface>:<channel>:<thread>:<message>, sched:<id>:<fireAt>, ...
  thread_key   text,
  status       text not null default 'queued',   -- queued | leased | waiting | done | failed
  not_before   timestamptz not null default now(),
  lease_owner  text,
  lease_epoch  integer not null default 0,
  lease_until  timestamptz,
  attempts     integer not null default 0,  -- times the job was handed back for a transient error
  head_seq     integer,                     -- the chain head, written in the same statement as each append (the anchor)
  head_hash    text,
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);
create index jobs_claimable on jobs (not_before) where status in ('queued', 'leased');
-- One run per thread at a time, enforced where two claims can race: the second update to 'leased' fails and that claim returns nothing.
create unique index one_leased_run_per_thread on jobs (thread_key) where status = 'leased';

create table run_events (
  run_id     uuid not null references jobs(id),
  seq        integer not null,
  at         timestamptz not null,
  cls        text not null,
  prev_hash  text,
  hash       text not null,
  event      jsonb not null,
  primary key (run_id, seq)                -- the fence, with the epoch check in the insert
);
-- The record is append-only for every role, like agent_versions.
revoke update, delete on run_events from public;
create trigger run_events_immutable
  before update or delete on run_events
  for each row execute function refuse_change();

create table run_inbox (                   -- written by front doors only
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references jobs(id),
  at           timestamptz not null default now(),
  item         jsonb not null,
  consumed_seq integer                     -- set by the lease holder in the same tx as inbox.consumed
);

-- Fenced, anchored append, as one statement (record.ts FENCED_APPEND):
--   with lease as (select id from jobs where id = $1 and lease_epoch = $8 and lease_owner = $9 for update),
--        ins as (insert into run_events (run_id, seq, at, cls, prev_hash, hash, event)
--                select $1, $2, $3, $4, $5, $6, $7 from lease returning seq, hash)
--   update jobs set head_seq = ins.seq, head_hash = ins.hash from ins where jobs.id = $1;
--   -> 0 rows or unique violation = LeaseLost. The row lock orders the append after any claim in flight.
--   On resume, openJournal verifies the chain and that it ends at (head_seq, head_hash).

-- Surfaces ----------------------------------------------------------------

create table web_messages (                -- the lab-hosted web surface: one reply per run, one notice per key
  id         bigserial primary key,
  run_id     uuid not null references jobs(id),
  thread_id  text not null,
  kind       text not null,                -- reply | notice
  key        text,                         -- notices: the call id or 'stop', so a resumed run asking again posts nothing new
  text       text not null,
  at         timestamptz not null default now()
);
create unique index web_one_reply_per_run on web_messages (run_id) where kind = 'reply';
create unique index web_one_notice_per_key on web_messages (run_id, key) where kind = 'notice';

-- Every finalize call, before the idempotent insert above. The unique index hides a loop that posts
-- twice; this row count shows it (check 1 asserts one attempt for an uninterrupted post, check 2 two).
create table web_finalize_attempts (
  id     bigserial primary key,
  run_id uuid not null references jobs(id),
  at     timestamptz not null default now()
);

-- Audit -------------------------------------------------------------------

create table audit_events (                -- publishes, freezes, unfreezes, role changes, out-of-run gateway calls
  seq        bigserial primary key,
  at         timestamptz not null default now(),
  actor      text not null,
  prev_hash  text,
  hash       text not null,
  event      jsonb not null
);

create table kb_coverage_overrides (       -- a publisher's note for publishing a snapshot over its coverage gaps
  id         bigserial primary key,
  snapshot   text not null references kb_snapshots,
  publisher  text not null,
  note       text not null check (length(btrim(note)) > 0),
  gaps       jsonb not null,
  audit_seq  bigint not null references audit_events,   -- the kb.published event that carries the same note
  at         timestamptz not null
);
revoke update, delete on kb_coverage_overrides from public;
create trigger kb_coverage_overrides_immutable
  before update or delete on kb_coverage_overrides
  for each row execute function refuse_change();

-- Observability is views over run_events (choice share, low-confidence rate,
-- not-found rate, tool errors, retries, stops within 5 s, limit hits, tokens,
-- latency). No metrics store: derived, never synced.
