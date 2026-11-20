-- Reports abertos pelo aplicativo mobile, sem alterar os relatórios CTM legados.
CREATE TABLE IF NOT EXISTS ctm_reports_mobile (
  id TEXT PRIMARY KEY NOT NULL,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id),
  data_relatorio TEXT NOT NULL,
  descricao TEXT NOT NULL,
  severidade TEXT NOT NULL DEFAULT 'medium'
    CHECK (severidade IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_analysis','in_maintenance','resolved')),
  acao_corretiva TEXT,
  criado_por TEXT NOT NULL REFERENCES user_profiles(id),
  criado_por_nome TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ctm_reports_mobile_aeronave_data
  ON ctm_reports_mobile(aeronave_id, data_relatorio DESC);
