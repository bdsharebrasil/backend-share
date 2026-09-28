ALTER TABLE recibos ADD COLUMN status_anterior TEXT;

CREATE TABLE IF NOT EXISTS recibo_reativacoes (
  id TEXT PRIMARY KEY NOT NULL,
  recibo_id TEXT NOT NULL REFERENCES recibos(id),
  justificativa TEXT NOT NULL,
  status_restaurado TEXT NOT NULL,
  reativado_por TEXT,
  reativado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recibo_reativacoes_recibo
  ON recibo_reativacoes (recibo_id, reativado_em DESC);
