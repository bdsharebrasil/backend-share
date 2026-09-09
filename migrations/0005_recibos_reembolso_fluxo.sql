ALTER TABLE reembolsos ADD COLUMN lancamento_cliente_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reembolsos_lancamento_cliente
  ON reembolsos(lancamento_cliente_id);
