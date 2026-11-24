-- Planejamento da mesma solicitação, independente de jornada ou acionamento.
CREATE TABLE IF NOT EXISTS pernas_planejadas_voo (
  id TEXT PRIMARY KEY NOT NULL,
  solicitacao_id TEXT NOT NULL REFERENCES solicitacoes_reserva_voo(id),
  data_prevista TEXT NOT NULL,
  origem TEXT NOT NULL,
  destino TEXT NOT NULL,
  horario_previsto TEXT,
  numero_passageiros INTEGER NOT NULL DEFAULT 0 CHECK (numero_passageiros >= 0),
  status TEXT NOT NULL DEFAULT 'PLANEJADA' CHECK (status IN ('PLANEJADA', 'INICIADA', 'CANCELADA')),
  chave_reenvio TEXT NOT NULL,
  perna_jornada_id TEXT UNIQUE REFERENCES pernas_jornada_voo(id) ON DELETE SET NULL,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (solicitacao_id, chave_reenvio)
);
CREATE INDEX IF NOT EXISTS idx_pernas_planejadas_data ON pernas_planejadas_voo(status, data_prevista, solicitacao_id);
