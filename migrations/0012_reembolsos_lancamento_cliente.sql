-- Garante o vínculo do lançamento do caixa Cliente no fluxo de recibo de reembolso.
-- Aplicada manualmente no D1 de produção em 2026-09-11 após divergência de schema.
ALTER TABLE reembolsos ADD COLUMN lancamento_cliente_id TEXT;
CREATE INDEX IF NOT EXISTS idx_reembolsos_lancamento_cliente
  ON reembolsos(lancamento_cliente_id);
