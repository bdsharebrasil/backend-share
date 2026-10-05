-- Separa o dashboard financeiro do Caixa Share nas duas tabelas de origem.
ALTER TABLE lancamentos ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'FINANCEIRO' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));
ALTER TABLE movimentos_holding ADD COLUMN escopo_financeiro TEXT NOT NULL DEFAULT 'FINANCEIRO' CHECK (escopo_financeiro IN ('FINANCEIRO', 'CAIXA_SHARE'));

-- Classificação histórica conservadora: somente operações Share explicitamente
-- identificadas como internas são retiradas do dashboard financeiro.
UPDATE lancamentos SET escopo_financeiro = 'CAIXA_SHARE'
 WHERE UPPER(COALESCE(tipo_caixa, '')) = 'SHARE'
   AND UPPER(COALESCE(origem_tipo, '')) IN ('NF_SAIDA', 'RECIBO_SAIDA', 'RECIBO_COLABORADOR', 'PAGAMENTO_FOLHA', 'DESPESA_EMPRESA', 'SOLICITACAO_COMPRA');

CREATE INDEX IF NOT EXISTS idx_lancamentos_escopo_criado ON lancamentos (escopo_financeiro, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_movimentos_holding_escopo_criado ON movimentos_holding (escopo_financeiro, criado_em DESC);
