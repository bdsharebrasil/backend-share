CREATE TABLE IF NOT EXISTS aerodromo (
  id TEXT PRIMARY KEY NOT NULL,
  nome TEXT NOT NULL,
  designativo_icao TEXT NOT NULL,
  coordenadas TEXT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_aerodromo_designativo_icao
  ON aerodromo(designativo_icao);

CREATE INDEX IF NOT EXISTS idx_aerodromo_nome
  ON aerodromo(nome COLLATE NOCASE);
