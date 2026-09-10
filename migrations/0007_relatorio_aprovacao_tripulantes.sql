-- Fluxo independente de aprovação por tripulante do relatório de viagem
ALTER TABLE relatorio_despesa_viagem ADD COLUMN token_aprovacao_tripulante_1 TEXT;
ALTER TABLE relatorio_despesa_viagem ADD COLUMN token_aprovacao_tripulante_2 TEXT;
ALTER TABLE relatorio_despesa_viagem ADD COLUMN aprovado_tripulante_1_em TEXT;
ALTER TABLE relatorio_despesa_viagem ADD COLUMN motivo_reprovacao_tripulante_1 TEXT;
ALTER TABLE relatorio_despesa_viagem ADD COLUMN motivo_reprovacao_tripulante_2 TEXT;
ALTER TABLE relatorio_despesa_viagem ADD COLUMN programado_pagamento_em TEXT;
ALTER TABLE relatorio_despesa_viagem ADD COLUMN data_vencimento_reembolso TEXT;
ALTER TABLE relatorio_despesa_viagem ADD COLUMN periodicidade_reembolso TEXT;
ALTER TABLE contas_apagar ADD COLUMN tripulante_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_relatorio_token_tripulante_1 ON relatorio_despesa_viagem(token_aprovacao_tripulante_1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relatorio_token_tripulante_2 ON relatorio_despesa_viagem(token_aprovacao_tripulante_2);
