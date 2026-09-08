CREATE TABLE IF NOT EXISTS rateio_pagamentos (
  id TEXT PRIMARY KEY NOT NULL,
  rateio_id TEXT NOT NULL REFERENCES rateio_despesas(id),
  conta_receber_id TEXT NOT NULL REFERENCES contas_areceber(id),
  tipo_pagador TEXT NOT NULL CHECK (tipo_pagador IN ('COTISTA','SHARE','HOLDING')),
  pagador_cotista_id TEXT REFERENCES cotista_aeronave(id),
  pagador_holding_id TEXT REFERENCES holdings(id),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  data_pagamento TEXT NOT NULL,
  conta_bancaria_id TEXT REFERENCES contas_bancarias(id),
  comprovante_url TEXT,
  forma_pagamento TEXT,
  status TEXT NOT NULL DEFAULT 'CONFIRMADO' CHECK (status IN ('PENDENTE','CONFIRMADO','CANCELADO')),
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rateio_pagamentos_rateio_status ON rateio_pagamentos(rateio_id,status);
CREATE INDEX IF NOT EXISTS idx_rateio_pagamentos_conta_receber ON rateio_pagamentos(conta_receber_id);
CREATE INDEX IF NOT EXISTS idx_rateio_pagamentos_pagador ON rateio_pagamentos(tipo_pagador,pagador_cotista_id,pagador_holding_id);
CREATE INDEX IF NOT EXISTS idx_rateio_despesas_lancamento_status ON rateio_despesas(lancamento_id,status);
CREATE INDEX IF NOT EXISTS idx_contas_apagar_status_vencimento ON contas_apagar(status,data_vencimento);
CREATE INDEX IF NOT EXISTS idx_contas_areceber_status_vencimento ON contas_areceber(status,data_vencimento);
CREATE INDEX IF NOT EXISTS idx_lancamentos_caixa_status ON lancamentos(tipo_caixa,status,fluxo);
