-- Índices incrementais para os contratos financeiros paginados.
-- Não altera dados históricos nem cria tabelas em runtime.
CREATE INDEX IF NOT EXISTS idx_recibos_filtros_data_status
  ON recibos (status, beneficiario_tipo, data_emissao DESC, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_recibos_criado_em
  ON recibos (criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_envio_despesas_status_tipo_criado
  ON envio_despesas (status, tipo, criado_em DESC);
