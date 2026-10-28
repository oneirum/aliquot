-- Publish records what it checked and what the document resolved to.
-- No head has been written before this migration (publish was a stub), so
-- NOT NULL needs no default.
alter table agent_heads
  add column version    text not null references agent_versions,   -- what the document resolved to at publish; intake re-resolves per run
  add column draft_hash text not null;                             -- contentHash(document): what the publisher checked
