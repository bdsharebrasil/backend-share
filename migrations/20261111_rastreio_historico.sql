-- Preserva posições existentes. Não há expiração automática do histórico de voo.
CREATE TABLE IF NOT EXISTS rastreio_posicoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trilha_id TEXT NOT NULL,
  solicitacao_id TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  alt_ft REAL,
  rumo_graus REAL,
  registrado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rastreio_posicoes_solicitacao ON rastreio_posicoes(solicitacao_id, registrado_em);
CREATE INDEX IF NOT EXISTS idx_rastreio_posicoes_trilha ON rastreio_posicoes(trilha_id, registrado_em);
CREATE TABLE IF NOT EXISTS rastreio_sinais (
  solicitacao_id TEXT PRIMARY KEY NOT NULL,
  sinal_ativo INTEGER NOT NULL DEFAULT 0,
  no_solo INTEGER NOT NULL DEFAULT 0,
  ultimo_sinal_em TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS rastreio_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitacao_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK(tipo IN ('SINAL_RECEBIDO', 'SINAL_PERDIDO', 'EM_SOLO_ADSB')),
  ocorrido_em TEXT NOT NULL,
  detectado_em TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rastreio_eventos_solicitacao ON rastreio_eventos(solicitacao_id, id);
