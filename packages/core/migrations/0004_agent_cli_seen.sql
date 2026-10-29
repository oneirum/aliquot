-- The CLI version each agent worker found installed for an agent backend, as `<binary> --version` printed it.
-- A draft resolves its agentCli.cliVersion from here, because the processes that resolve (the web door, the
-- studio) may not start a child process to ask the binary themselves.
create table agent_cli_seen (
  backend_id    text primary key,
  kind          text not null,
  cli_version   text not null,
  binary_path   text not null,
  binary_sha256 text not null,
  seen_at       timestamptz not null default now()
);
