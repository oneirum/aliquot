-- A web door session, so signing out, sitting idle, or losing the account ends it on the server, not only in the one
-- browser that held the cookie. The cookie carries the session id; only its sha256 is stored here, so a copy of this
-- table opens no session. claim_role is the role a mapped group claim named at sign-in; with it null the role is read
-- from the studio account on every request.
create table door_sessions (
  id_hash text primary key,
  member_id text not null,
  email text not null,
  role_source text not null check (role_source in ('studio', 'claim')),
  claim_role text,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  ended_at timestamptz,
  ended_reason text check (ended_reason in ('signed_out', 'idle', 'time_limit', 'claim_role_limit', 'no_account')),
  check ((role_source = 'claim') = (claim_role is not null)),
  check ((ended_at is null) = (ended_reason is null))
);
create index door_sessions_open_by_member on door_sessions (member_id) where ended_at is null;
