ALTER TABLE relatorio_despesa_viagem ADD COLUMN reembolso_caixa_share INTEGER
  CHECK (reembolso_caixa_share IN (0, 1));

-- Preserva a classificação dos relatórios que já iniciaram o fluxo anterior.
UPDATE relatorio_despesa_viagem
SET reembolso_caixa_share = 1
WHERE status IN ('aguardando_aprovacao', 'ajuste_necessario', 'ajuste_concluido', 'aprovado', 'enviado_cliente')
   OR NULLIF(TRIM(token_aprovacao_tripulante_1), '') IS NOT NULL
   OR NULLIF(TRIM(token_aprovacao_tripulante_2), '') IS NOT NULL
   OR EXISTS (
     SELECT 1 FROM financeiro_vinculos fv
     WHERE fv.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
       AND fv.origem_id = relatorio_despesa_viagem.id
       AND fv.destino_tipo IN ('CONTA_PAGAR', 'CONTA_RECEBER')
   );
