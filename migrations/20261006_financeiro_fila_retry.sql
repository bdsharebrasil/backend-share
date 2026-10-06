-- Reprocessamento de falhas transitórias da fila financeira com backoff.
ALTER TABLE financeiro_fila ADD COLUMN proxima_tentativa_em TEXT;
CREATE INDEX IF NOT EXISTS idx_financeiro_fila_retry
  ON financeiro_fila(status, proxima_tentativa_em, criado_em);
