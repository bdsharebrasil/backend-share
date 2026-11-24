CREATE TABLE IF NOT EXISTS ctm_historico (
  modulo TEXT NOT NULL, registro_id TEXT NOT NULL, aeronave_id TEXT NOT NULL,
  versao INTEGER NOT NULL, acao TEXT NOT NULL, autor TEXT NOT NULL,
  motivo TEXT, anterior TEXT, posterior TEXT,
  data TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (modulo, registro_id, versao)
);
CREATE INDEX IF NOT EXISTS ctm_historico_por_aeronave ON ctm_historico(aeronave_id,modulo,data);
