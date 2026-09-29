CREATE TABLE IF NOT EXISTS documentos_aeronave (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  nome TEXT NOT NULL,
  descricao TEXT,
  caminho_arquivo TEXT NOT NULL,
  tipo_arquivo TEXT,
  tamanho_arquivo INTEGER,
  enviado_por TEXT,
  criado_em TEXT DEFAULT (datetime('now')),
  aeronave_id TEXT,
  tipo_documento TEXT,
  data_validade TEXT,
  atualizado_em TEXT DEFAULT (datetime('now')),
  dias_alerta INTEGER DEFAULT 30
);

CREATE INDEX IF NOT EXISTS idx_documentos_aeronave_aeronave_validade
  ON documentos_aeronave (aeronave_id, data_validade);
