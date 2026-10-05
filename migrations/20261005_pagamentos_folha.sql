-- Campos usados pelo fluxo de pagamentos por item da competência.
ALTER TABLE pagamentos_folha ADD COLUMN rotulo TEXT
  CHECK (rotulo IS NULL OR rotulo IN ('SALARIO', 'FERIAS', '13_P1', '13_P2', 'BENEFICIO', 'HORAS_VOO', 'EXTRA'));
ALTER TABLE pagamentos_folha ADD COLUMN holerite_url TEXT;
ALTER TABLE pagamentos_folha ADD COLUMN conta_pagamento_id TEXT;
ALTER TABLE pagamentos_folha ADD COLUMN observacoes TEXT;
ALTER TABLE pagamentos_folha ADD COLUMN idempotency_key TEXT;

-- O lançamento financeiro é atualizado pelo identificador de origem e também
-- retém a chave do request/item para rejeitar reutilização acidental da chave.
ALTER TABLE lancamentos_financeiros_rh ADD COLUMN idempotency_key TEXT;

-- Uma pessoa só pode ter um item de cada rótulo por competência/empresa.
-- Linhas legadas sem rótulo permanecem válidas e fora do índice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pagamentos_folha_competencia_rotulo
  ON pagamentos_folha (empresa_id, user_id, competencia_ano, competencia_mes, rotulo);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pagamentos_folha_idempotency
  ON pagamentos_folha (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lancamentos_financeiros_rh_idempotency
  ON lancamentos_financeiros_rh (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
