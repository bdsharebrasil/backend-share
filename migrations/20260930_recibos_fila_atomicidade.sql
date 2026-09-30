-- Corrige a numeração concorrente dos recibos e permite sequências globais
-- para recibos sem cotista. Os dados existentes são preservados.
PRAGMA foreign_keys = OFF;
CREATE TABLE sequencia_numeros_recibos_new (
  id TEXT PRIMARY KEY NOT NULL,
  cotista_aeronave_id TEXT,
  codigo_cliente TEXT NOT NULL,
  ano TEXT NOT NULL,
  proximo_numero INTEGER NOT NULL DEFAULT 1,
  UNIQUE (codigo_cliente, ano),
  FOREIGN KEY (cotista_aeronave_id) REFERENCES cotista_aeronave(id) ON DELETE CASCADE
);
INSERT INTO sequencia_numeros_recibos_new (id, cotista_aeronave_id, codigo_cliente, ano, proximo_numero)
SELECT id, cotista_aeronave_id, codigo_cliente, ano, proximo_numero
FROM sequencia_numeros_recibos;
DROP TABLE sequencia_numeros_recibos;
ALTER TABLE sequencia_numeros_recibos_new RENAME TO sequencia_numeros_recibos;
PRAGMA foreign_keys = ON;

ALTER TABLE financeiro_fila ADD COLUMN processando_em TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_recibos_numero_recibo
  ON recibos(numero_recibo) WHERE numero_recibo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financeiro_fila_claim
  ON financeiro_fila(status, processando_em, criado_em);
