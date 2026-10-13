CREATE TABLE IF NOT EXISTS relatorio_despesa_viagem_historico_ajustes (
  id TEXT PRIMARY KEY,
  relatorio_despesa_viagem_id TEXT NOT NULL,
  tripulante_pos INTEGER NOT NULL CHECK (tripulante_pos IN (1, 2)),
  motivo TEXT NOT NULL,
  anexos TEXT NOT NULL DEFAULT '[]',
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_relatorio_viagem_historico_ajustes_relatorio
  ON relatorio_despesa_viagem_historico_ajustes (relatorio_despesa_viagem_id, criado_em);
