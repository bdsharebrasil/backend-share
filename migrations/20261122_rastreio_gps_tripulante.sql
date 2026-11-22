CREATE TABLE IF NOT EXISTS rastreio_gps_tripulante (
  voo_id TEXT NOT NULL REFERENCES solicitacoes_reserva_voo(id),
  user_id TEXT NOT NULL REFERENCES user_profiles(id),
  ponto_id TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL, registrado_em TEXT NOT NULL,
  precisao_m REAL NOT NULL, alt_ft REAL, gs_kt REAL, rumo_graus REAL,
  recebido_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (voo_id, user_id, ponto_id)
);
CREATE INDEX IF NOT EXISTS idx_rastreio_gps_voo_data ON rastreio_gps_tripulante(voo_id, registrado_em);
