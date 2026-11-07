-- One row per running worker, beaten every few seconds by runWorker (queue.ts) and deleted when it stops cleanly.
-- The web door's GET /healthz reads it: a worker that died without stopping leaves a row that only goes stale.
create table worker_heartbeats (
  worker_id   text primary key,
  engine      text not null,                 -- chat | agent-cli, as the queue claims
  started_at  timestamptz not null default now(),
  beat_at     timestamptz not null default now()
);
