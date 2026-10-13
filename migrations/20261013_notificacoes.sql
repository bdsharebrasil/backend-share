CREATE TABLE IF NOT EXISTS notificacoes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  id_from TEXT NOT NULL,
  mensagem TEXT,
  lido INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT
);

CREATE INDEX IF NOT EXISTS idx_notificacoes_user_criado
  ON notificacoes(user_id, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_notificacoes_id_from
  ON notificacoes(id_from);
