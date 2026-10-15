-- As chaves são específicas do fluxo de programação de reembolso de recibo.
-- Linhas antigas sem essas chaves ficam fora dos índices parciais.
CREATE UNIQUE INDEX idx_lancamentos_recibo_reembolso_cliente_idempotencia
  ON lancamentos (idempotency_key)
  WHERE idempotency_key LIKE 'recibo-reembolso-cliente:%';

CREATE UNIQUE INDEX idx_contas_areceber_recibo_reembolso_idempotencia
  ON contas_areceber (idempotency_key)
  WHERE idempotency_key LIKE 'recibo-reembolso-cliente:%';
