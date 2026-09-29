-- Move lançamentos financeiros de relatórios de viagem de holding da aeronave
-- PR-LRM para movimentos_holding. Restrito a relatórios com socio_id/holding_id.
-- O banco legado possui uma FK quebrada para `clientes`; a tabela compatível é
-- criada apenas durante a exclusão e removida ao final.

INSERT OR IGNORE INTO movimentos_holding
  (id, holding_id, socio_id, aeronave_id, periodicidade, tipo_caixa,
   colaborador_id, data_emissao, data_vencimento, data_pagamento, descricao,
   fornecedor_nome, categoria_nome, grupo_categoria, fluxo, valor_centavos,
   status, pago_diretamente, forma_pagamento, comprovante_url, numero_doc,
   url_doc, observacoes, criado_por, criado_em, atualizado_em)
SELECT l.id, hs.holding_id, r.socio_id, l.aeronave_id,
       COALESCE(l.periodicidade, 'EVENTUAL'), 'HOLD', l.colaborador_id,
       l.data_emissao, l.data_vencimento, l.data_pagamento, l.descricao,
       l.fornecedor_nome, l.categoria_nome, l.grupo_categoria, l.fluxo,
       l.valor_centavos,
       CASE WHEN l.status IN ('EM_ABERTO', 'PAGO', 'RECEBIDO', 'ENTRADA',
                              'APORTE_MENSAL', 'RENDIMENTO_BANCARIO',
                              'AGUARDANDO_REEMBOLSO', 'REEMBOLSADO', 'CANCELADO')
            THEN l.status ELSE 'EM_ABERTO' END,
       l.pago_diretamente, l.forma_pagamento, l.comprovante_url,
       l.numero_doc, l.url_doc, l.observacoes, l.criado_por,
       l.criado_em, l.atualizado_em
  FROM lancamentos l
  INNER JOIN relatorio_despesa_viagem r ON r.id = l.origem_id
  INNER JOIN hold_socios hs ON hs.id = r.socio_id
 WHERE l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
   AND r.aeronave_id = '72104170-ebf6-4f35-8d7b-301f352a89ac'
   AND r.socio_id IS NOT NULL;

-- Caso existam rateios de cliente legados, converte-os para rateio_hold.
INSERT OR IGNORE INTO rateio_hold
  (id, movimento_holding_id, aeronave_id, socio_id, data_emissao,
   data_vencimento, data_pagamento, data_competencia_demonstrativo,
   categoria_id, categoria_nome, subcategoria_1, subcategoria_2,
   subcategoria_3, subcategoria_4, tipo_rateio, periodicidade,
   percentual_sociedade, percentual_uso, valor_total_centavos,
   valor_rateado_centavos, valor_pago_real_centavos, pago_por_socio_id,
   pago_diretamente, status, descricao_despesa, observacoes, origem_id,
   origem_tipo, documento_numero, documento_url)
SELECT rd.id, rd.lancamento_id, rd.aeronave_id, r.socio_id,
       rd.data_emissao, rd.data_vencimento, rd.data_pagamento,
       rd.data_competencia_demonstrativo, NULL, rd.categoria_nome,
       rd.subcategoria_1, rd.subcategoria_2, rd.subcategoria_3,
       rd.subcategoria_4, rd.tipo_rateio, rd.periodicidade,
       rd.percentual_sociedade, rd.percentual_uso, rd.valor_total_centavos,
       rd.valor_rateado_centavos, rd.valor_pago_real_centavos, NULL,
       rd.pago_diretamente,
       CASE WHEN rd.status = 'SAIDA' THEN 'EM_ABERTO' ELSE rd.status END,
       rd.descricao_despesa, rd.observacoes, rd.origem_id, rd.origem_tipo,
       rd.documento_numero, rd.documento_url
  FROM rateio_despesas rd
  INNER JOIN lancamentos l ON l.id = rd.lancamento_id
  INNER JOIN relatorio_despesa_viagem r ON r.id = l.origem_id
 WHERE l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
   AND r.aeronave_id = '72104170-ebf6-4f35-8d7b-301f352a89ac'
   AND r.socio_id IS NOT NULL;

UPDATE contas_areceber
   SET movimentos_id = lancamentos_id,
       lancamentos_id = NULL,
       atualizado_em = CURRENT_TIMESTAMP
 WHERE lancamentos_id IN (
   SELECT l.id FROM lancamentos l
   INNER JOIN relatorio_despesa_viagem r ON r.id = l.origem_id
   WHERE l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
     AND r.aeronave_id = '72104170-ebf6-4f35-8d7b-301f352a89ac'
     AND r.socio_id IS NOT NULL
 );

UPDATE contas_apagar
   SET lancamentos_id = NULL,
       atualizado_em = CURRENT_TIMESTAMP
 WHERE lancamentos_id IN (
   SELECT l.id FROM lancamentos l
   INNER JOIN relatorio_despesa_viagem r ON r.id = l.origem_id
   WHERE l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
     AND r.aeronave_id = '72104170-ebf6-4f35-8d7b-301f352a89ac'
     AND r.socio_id IS NOT NULL
 );

DELETE FROM financeiro_vinculos
 WHERE destino_tipo = 'LANCAMENTO'
   AND destino_id IN (
     SELECT l.id FROM lancamentos l
     INNER JOIN relatorio_despesa_viagem r ON r.id = l.origem_id
     WHERE l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
       AND r.aeronave_id = '72104170-ebf6-4f35-8d7b-301f352a89ac'
       AND r.socio_id IS NOT NULL
   );

INSERT OR IGNORE INTO financeiro_vinculos
  (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
SELECT lower(hex(randomblob(16))), 'RELATORIO_DESPESA_VIAGEM', l.origem_id,
       'MOVIMENTO_HOLDING', l.id, 'RELATORIO_MOVIMENTO_HOLDING'
  FROM lancamentos l
  INNER JOIN relatorio_despesa_viagem r ON r.id = l.origem_id
 WHERE l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
   AND r.aeronave_id = '72104170-ebf6-4f35-8d7b-301f352a89ac'
   AND r.socio_id IS NOT NULL;

DELETE FROM rateio_despesas
 WHERE lancamento_id IN (
   SELECT l.id FROM lancamentos l
   INNER JOIN relatorio_despesa_viagem r ON r.id = l.origem_id
   WHERE l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
     AND r.aeronave_id = '72104170-ebf6-4f35-8d7b-301f352a89ac'
     AND r.socio_id IS NOT NULL
 );

CREATE TABLE IF NOT EXISTS clientes (id TEXT PRIMARY KEY);
INSERT OR IGNORE INTO clientes (id)
SELECT DISTINCT cliente_id FROM lancamentos WHERE cliente_id IS NOT NULL;
DELETE FROM lancamentos
 WHERE id IN (
   SELECT l.id FROM lancamentos l
   INNER JOIN relatorio_despesa_viagem r ON r.id = l.origem_id
   WHERE l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
     AND r.aeronave_id = '72104170-ebf6-4f35-8d7b-301f352a89ac'
     AND r.socio_id IS NOT NULL
 );
DROP TABLE clientes;
