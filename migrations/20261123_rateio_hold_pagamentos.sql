-- rateio_pagamentos.rateio_id referencia rateio_despesas(id).
-- Pagamentos de rateio_hold têm histórico próprio, com FK para a tabela correta.
-- Migração aditiva e idempotente: não recria nem altera as tabelas existentes.
CREATE TABLE IF NOT EXISTS rateio_hold_pagamentos (
  id TEXT PRIMARY KEY NOT NULL,
  rateio_id TEXT NOT NULL REFERENCES rateio_hold(id),
  conta_receber_id TEXT REFERENCES contas_areceber(id),
  tipo_pagador TEXT NOT NULL CHECK (tipo_pagador IN ('COTISTA', 'SHARE', 'HOLDING')),
  pagador_cotista_id TEXT REFERENCES cotista_aeronave(id),
  pagador_holding_id TEXT REFERENCES holdings(id),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  data_pagamento TEXT NOT NULL,
  conta_bancaria_id TEXT REFERENCES contas_bancarias(id),
  comprovante_url TEXT,
  forma_pagamento TEXT,
  status TEXT NOT NULL DEFAULT 'CONFIRMADO'
    CHECK (status IN ('PENDENTE', 'CONFIRMADO', 'ESTORNADO', 'CANCELADO')),
  observacoes TEXT,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rateio_hold_pagamentos_idempotency
  ON rateio_hold_pagamentos(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rateio_hold_pagamentos_conta_status
  ON rateio_hold_pagamentos(conta_receber_id, status);
CREATE INDEX IF NOT EXISTS idx_rateio_hold_pagamentos_rateio_status
  ON rateio_hold_pagamentos(rateio_id, status);
CREATE INDEX IF NOT EXISTS idx_rateio_hold_pagamentos_pagador
  ON rateio_hold_pagamentos(pagador_cotista_id);
