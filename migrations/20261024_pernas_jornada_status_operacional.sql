CREATE TABLE pernas_jornada_voo_nova (
  id                    TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  jornada_id            TEXT NOT NULL REFERENCES jornadas_voo(id) ON DELETE CASCADE,
  numero                INTEGER NOT NULL,
  origem                TEXT NOT NULL,
  destino               TEXT NOT NULL,
  horario_ac            TEXT,
  horario_dep           TEXT,
  horario_pouso         TEXT,
  horario_corte         TEXT,
  status                TEXT NOT NULL DEFAULT 'programada'
                          CHECK (status IN ('programada', 'acionado', 'em_voo', 'em_solo', 'pousado', 'cortado')),
  lancamento_diario_id  TEXT REFERENCES lancamentos_diario_bordo(id),
  criado_em             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  passageiros           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (jornada_id, numero)
);

INSERT INTO pernas_jornada_voo_nova (
  id, jornada_id, numero, origem, destino, horario_ac, horario_dep,
  horario_pouso, horario_corte, status, lancamento_diario_id,
  criado_em, atualizado_em, passageiros
)
SELECT
  id, jornada_id, numero, origem, destino, horario_ac, horario_dep,
  horario_pouso, horario_corte,
  CASE
    WHEN status = 'cortado' OR horario_corte IS NOT NULL THEN 'cortado'
    WHEN horario_pouso IS NOT NULL OR status IN ('em_solo', 'pousado') THEN 'em_solo'
    WHEN horario_dep IS NOT NULL OR status = 'em_voo' THEN 'em_voo'
    WHEN horario_ac IS NOT NULL OR status = 'acionado' THEN 'acionado'
    ELSE 'programada'
  END,
  lancamento_diario_id, criado_em, atualizado_em, passageiros
FROM pernas_jornada_voo;

DROP TABLE pernas_jornada_voo;
ALTER TABLE pernas_jornada_voo_nova RENAME TO pernas_jornada_voo;

CREATE INDEX idx_pernas_jornada_voo_lancamento
  ON pernas_jornada_voo (lancamento_diario_id);

CREATE TRIGGER trg_pernas_jornada_voo_atualizado_em
AFTER UPDATE ON pernas_jornada_voo
FOR EACH ROW
BEGIN
  UPDATE pernas_jornada_voo SET atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER trg_pernas_jornada_voo_status
AFTER UPDATE OF horario_ac, horario_dep, horario_pouso, horario_corte ON pernas_jornada_voo
FOR EACH ROW
WHEN NEW.status != 'cortado' OR NEW.horario_corte IS NULL
BEGIN
  UPDATE pernas_jornada_voo
  SET status = CASE
    WHEN NEW.horario_corte IS NOT NULL THEN 'cortado'
    WHEN NEW.horario_pouso IS NOT NULL THEN 'em_solo'
    WHEN NEW.horario_dep IS NOT NULL THEN 'em_voo'
    WHEN NEW.horario_ac IS NOT NULL THEN 'acionado'
    ELSE 'programada'
  END
  WHERE id = NEW.id;
END;
