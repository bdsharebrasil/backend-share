CREATE TABLE IF NOT EXISTS portal_sessoes_revogadas (
  token_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_sessoes_revogadas_exp
  ON portal_sessoes_revogadas(expires_at);
