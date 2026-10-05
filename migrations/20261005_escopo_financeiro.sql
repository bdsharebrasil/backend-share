-- Separa o dashboard financeiro do Caixa Share no próprio dado persistido.
ALTER TABLE lancamentos ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'FINANCEIRO' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));
ALTER TABLE movimentos_holding ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'FINANCEIRO' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));
ALTER TABLE contas_apagar ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'FINANCEIRO' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));
ALTER TABLE contas_areceber ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'FINANCEIRO' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));
ALTER TABLE envio_despesas ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'FINANCEIRO' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));
ALTER TABLE recibos ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'FINANCEIRO' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));
ALTER TABLE recibos_saida ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'CAIXA_SHARE' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));
ALTER TABLE notas_fiscais_saida ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'CAIXA_SHARE' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));
ALTER TABLE reembolsos ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'FINANCEIRO' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));
ALTER TABLE emails_enviados ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'FINANCEIRO' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));

-- Classificação histórica por vínculo/origem. Registros ambíguos permanecem no
-- Financeiro até revisão explícita; nunca são promovidos ao Caixa Share por heurística.
UPDATE lancamentos SET escopo_financeiro = 'CAIXA_SHARE'
 WHERE UPPER(COALESCE(tipo_caixa, '')) = 'SHARE'
   AND UPPER(COALESCE(origem_tipo, '')) IN ('NF_SAIDA', 'RECIBO_SAIDA', 'RECIBO_COLABORADOR', 'PAGAMENTO_FOLHA', 'DESPESA_EMPRESA', 'SOLICITACAO_COMPRA');
UPDATE movimentos_holding SET escopo_financeiro = 'FINANCEIRO';
UPDATE contas_apagar SET escopo_financeiro = COALESCE((SELECT l.escopo_financeiro FROM lancamentos l WHERE l.id = contas_apagar.lancamentos_id), 'FINANCEIRO');
UPDATE contas_areceber SET escopo_financeiro = COALESCE((SELECT l.escopo_financeiro FROM lancamentos l WHERE l.id = contas_areceber.lancamentos_id), 'FINANCEIRO');
UPDATE envio_despesas SET escopo_financeiro = CASE WHEN LOWER(COALESCE(tipo, '')) = 'share' THEN 'CAIXA_SHARE' ELSE 'FINANCEIRO' END;
UPDATE reembolsos SET escopo_financeiro = 'FINANCEIRO';
UPDATE recibos SET escopo_financeiro = CASE WHEN LOWER(COALESCE(tipo_recibo, '')) = 'recibo_colaborador' OR LOWER(COALESCE(tipo_caixa, '')) = 'share' THEN 'CAIXA_SHARE' ELSE 'FINANCEIRO' END;
UPDATE recibos_saida SET escopo_financeiro = 'CAIXA_SHARE';
UPDATE notas_fiscais_saida SET escopo_financeiro = 'CAIXA_SHARE';

CREATE INDEX IF NOT EXISTS idx_lancamentos_escopo_criado ON lancamentos (escopo_financeiro, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_movimentos_holding_escopo_criado ON movimentos_holding (escopo_financeiro, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_contas_apagar_escopo_status ON contas_apagar (escopo_financeiro, status, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_contas_areceber_escopo_status ON contas_areceber (escopo_financeiro, status, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_envio_despesas_escopo_criado ON envio_despesas (escopo_financeiro, criado_em DESC);
