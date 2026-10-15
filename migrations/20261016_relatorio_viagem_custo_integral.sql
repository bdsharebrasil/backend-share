-- Normaliza o custo dos relatórios de viagem sem tocar nas contas a receber:
-- a cobrança continua representando somente o valor não pago diretamente.
-- IDs de custos e rateios são persistidos uma única vez; os vínculos usam a
-- identidade do relatório e podem ser recriados sem gerar eventos financeiros.

WITH candidatos AS (
  SELECT r.*, ca.id AS cotista_aeronave_id, cl.id AS cliente_id_validado,
         ROW_NUMBER() OVER (
           PARTITION BY r.id
           ORDER BY CASE WHEN ca.id = r.cliente_id THEN 0 ELSE 1 END, ca.id
         ) AS ordem
    FROM relatorio_despesa_viagem r
    LEFT JOIN cotista_aeronave ca
      ON ca.aeronave_id = r.aeronave_id AND ca.socio_id IS NULL
     AND (ca.id = r.cliente_id OR ca.cliente_id = r.cliente_id)
    LEFT JOIN cliente cl ON cl.id = r.cliente_id
   WHERE COALESCE(r.socio_id, '') = ''
     AND CAST(COALESCE(r.total_valor, 0) AS REAL) > 0
     AND lower(COALESCE(r.status, '')) IN ('aprovado', 'enviado_cliente', 'finalizado')
)
INSERT INTO lancamentos (
  id, aeronave_id, cotista_aeronave_id, cliente_id, data_emissao, data_vencimento,
  descricao, categoria_nome, grupo_categoria, periodicidade, status, fluxo, tipo_caixa,
  valor_centavos, pago_por, pago_diretamente, reembolsavel, reembolso_quitado,
  observacoes, criado_por, origem_tipo, origem_id, idempotency_key, numero_doc,
  fornecedor_nome, url_doc, escopo_financeiro
)
SELECT lower(hex(randomblob(16))),
       r.aeronave_id, r.cotista_aeronave_id, r.cliente_id_validado,
       COALESCE(NULLIF(r.data_inicio, ''), date('now')),
       COALESCE(NULLIF(r.data_vencimento_reembolso, ''), NULLIF(r.data_fim, ''), NULLIF(r.data_inicio, ''), date('now')),
       'Relatório de despesa de viagem ' || COALESCE(NULLIF(r.numero_relatorio, ''), r.id),
       'DESPESAS DE VIAGEM', 'DESPESAS DE VIAGEM', 'EVENTUAL', 'EM_ABERTO',
       'SAIDA', 'CLIENTE', CAST(ROUND(COALESCE(r.total_valor, 0) * 100) AS INTEGER),
       NULL, 0, 0, 0,
       'Origem: relatório ' || COALESCE(NULLIF(r.numero_relatorio, ''), r.id),
       NULL, 'RELATORIO_DESPESA_VIAGEM', r.id,
       'RELATORIO_DESPESA_VIAGEM:' || r.id || ':CUSTO_INTEGRAL',
       r.numero_relatorio, 'SHARE BRASIL', r.pdf_path, 'FINANCEIRO'
  FROM candidatos r
 WHERE r.ordem = 1
   AND NOT EXISTS (
     SELECT 1 FROM lancamentos l
      WHERE l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
        AND l.origem_id = r.id
        AND l.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || r.id || ':CUSTO_INTEGRAL'
   );

INSERT OR IGNORE INTO financeiro_vinculos
  (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
SELECT lower(hex(randomblob(16))), 'RELATORIO_DESPESA_VIAGEM', r.id,
       'LANCAMENTO', l.id, 'RELATORIO_CUSTO_INTEGRAL'
  FROM relatorio_despesa_viagem r
  JOIN lancamentos l
    ON l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
   AND l.origem_id = r.id
   AND l.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || r.id || ':CUSTO_INTEGRAL'
 WHERE COALESCE(r.socio_id, '') = ''
   AND NOT EXISTS (
     SELECT 1 FROM financeiro_vinculos fv
      WHERE fv.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND fv.origem_id = r.id
        AND fv.destino_tipo = 'LANCAMENTO' AND fv.destino_id = l.id
        AND fv.tipo_vinculo = 'RELATORIO_CUSTO_INTEGRAL'
   );

-- Reaponta os rateios legados ao novo lançamento principal, preservando seus
-- IDs, pagamentos e estados. A descrição cobre registros antigos sem vínculo.
UPDATE rateio_despesas AS rd
   SET lancamento_id = (
     SELECT l.id
       FROM relatorio_despesa_viagem r
       JOIN lancamentos l
         ON l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
        AND l.origem_id = r.id
        AND l.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || r.id || ':CUSTO_INTEGRAL'
      WHERE COALESCE(r.socio_id, '') = ''
        AND (
          EXISTS (SELECT 1 FROM financeiro_vinculos fv
                   WHERE fv.destino_tipo = 'RATEIO_DESPESAS' AND fv.destino_id = rd.id
                     AND fv.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND fv.origem_id = r.id)
          OR rd.observacoes LIKE '%Origem: relatório ' || COALESCE(NULLIF(r.numero_relatorio, ''), r.id) || '%'
        )
      ORDER BY r.id LIMIT 1
   )
 WHERE EXISTS (
     SELECT 1 FROM relatorio_despesa_viagem r
      WHERE COALESCE(r.socio_id, '') = ''
        AND (
          EXISTS (SELECT 1 FROM financeiro_vinculos fv
                   WHERE fv.destino_tipo = 'RATEIO_DESPESAS' AND fv.destino_id = rd.id
                     AND fv.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND fv.origem_id = r.id)
          OR rd.observacoes LIKE '%Origem: relatório ' || COALESCE(NULLIF(r.numero_relatorio, ''), r.id) || '%'
        )
   );

-- Garante a parcela econômica quando um relatório antigo ainda não tinha
-- rateio; o cotista é resolvido da mesma forma que no fluxo de sincronização.
INSERT INTO rateio_despesas (
  id, lancamento_id, aeronave_id, cotista_id, data_emissao, data_vencimento,
  data_pagamento, categoria_nome, tipo_rateio, periodicidade, percentual_sociedade,
  percentual_uso, valor_total_centavos, valor_rateado_centavos, valor_pago_real_centavos,
  pago_por, pago_diretamente, status, descricao_despesa, observacoes
)
SELECT lower(hex(randomblob(16))), l.id, r.aeronave_id, ca.id,
       COALESCE(NULLIF(r.data_inicio, ''), date('now')),
       COALESCE(NULLIF(r.data_fim, ''), NULLIF(r.data_inicio, ''), date('now')),
       NULL, 'DESPESAS DE VIAGEM', 'VARIAVEL_POR_VOO', 'EVENTUAL',
       COALESCE(NULLIF(ca.percentual_sociedade, 0), 100), 100,
       CAST(ROUND(COALESCE(r.total_valor, 0) * 100) AS INTEGER),
       CAST(ROUND(COALESCE(r.total_valor, 0) * 100) AS INTEGER),
       MIN(CAST(ROUND(COALESCE(r.total_cliente, 0) * 100) AS INTEGER), CAST(ROUND(COALESCE(r.total_valor, 0) * 100) AS INTEGER)),
       CASE WHEN COALESCE(r.total_cliente, 0) > 0 THEN ca.id ELSE NULL END,
       CASE WHEN COALESCE(r.total_valor, 0) > 0 AND COALESCE(r.total_cliente, 0) >= COALESCE(r.total_valor, 0) THEN 1 ELSE 0 END,
       CASE WHEN COALESCE(r.total_valor, 0) > 0 AND COALESCE(r.total_cliente, 0) >= COALESCE(r.total_valor, 0) THEN 'PAGO_DIRETAMENTE' ELSE 'EM_ABERTO' END,
       'Relatório de despesa de viagem ' || COALESCE(NULLIF(r.numero_relatorio, ''), r.id),
       'Origem: relatório ' || COALESCE(NULLIF(r.numero_relatorio, ''), r.id)
  FROM relatorio_despesa_viagem r
  JOIN lancamentos l
    ON l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
   AND l.origem_id = r.id
   AND l.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || r.id || ':CUSTO_INTEGRAL'
  JOIN cotista_aeronave ca
    ON ca.aeronave_id = r.aeronave_id AND ca.socio_id IS NULL
   AND (ca.id = r.cliente_id OR ca.cliente_id = r.cliente_id)
 WHERE COALESCE(r.socio_id, '') = ''
   AND CAST(COALESCE(r.total_valor, 0) AS REAL) > 0
   AND NOT EXISTS (
     SELECT 1 FROM rateio_despesas rd
      WHERE rd.lancamento_id = l.id
         OR (rd.aeronave_id = r.aeronave_id AND rd.cotista_id = ca.id
             AND rd.observacoes LIKE '%Origem: relatório ' || COALESCE(NULLIF(r.numero_relatorio, ''), r.id) || '%')
         OR EXISTS (SELECT 1 FROM financeiro_vinculos fv
                     WHERE fv.destino_tipo = 'RATEIO_DESPESAS' AND fv.destino_id = rd.id
                       AND fv.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND fv.origem_id = r.id)
   );

-- Reconciliar pagamentos diretos existentes dentro do rateio (não cria baixa
-- nem novo evento). Pagamento parcial fica EM_ABERTO e não marca o custo todo
-- como pago diretamente; valor_pago_real_centavos registra somente o valor real.
UPDATE rateio_despesas AS rd
   SET valor_pago_real_centavos = CASE
         WHEN COALESCE(rd.valor_pago_real_centavos, 0) > MIN(CAST(ROUND(COALESCE(r.total_cliente, 0) * 100) AS INTEGER), COALESCE(rd.valor_rateado_centavos, 0))
           THEN rd.valor_pago_real_centavos
         ELSE MIN(CAST(ROUND(COALESCE(r.total_cliente, 0) * 100) AS INTEGER), COALESCE(rd.valor_rateado_centavos, 0))
       END,
       pago_por = CASE
         WHEN COALESCE(r.total_cliente, 0) > 0 THEN COALESCE(NULLIF(rd.pago_por, ''), rd.cotista_id)
         ELSE rd.pago_por
       END,
       pago_diretamente = CASE
         WHEN COALESCE(rd.pago_diretamente, 0) = 1 THEN 1
         WHEN COALESCE(r.total_cliente, 0) > 0
          AND CAST(ROUND(COALESCE(r.total_cliente, 0) * 100) AS INTEGER) >= COALESCE(rd.valor_rateado_centavos, 0)
           THEN 1
         ELSE 0
       END,
       status = CASE
         WHEN UPPER(COALESCE(rd.status, '')) IN ('PAGO', 'RECEBIDO', 'REEMBOLSADO', 'CANCELADO', 'PAGO_DIRETAMENTE') THEN rd.status
         WHEN COALESCE(r.total_cliente, 0) > 0
          AND CAST(ROUND(COALESCE(r.total_cliente, 0) * 100) AS INTEGER) >= COALESCE(rd.valor_rateado_centavos, 0)
           THEN 'PAGO_DIRETAMENTE'
         ELSE rd.status
       END
  FROM relatorio_despesa_viagem r
 WHERE COALESCE(r.socio_id, '') = ''
   AND COALESCE(r.total_cliente, 0) > 0
   AND rd.lancamento_id = (
     SELECT l.id FROM lancamentos l
      WHERE l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND l.origem_id = r.id
        AND l.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || r.id || ':CUSTO_INTEGRAL'
      LIMIT 1
   );

INSERT OR IGNORE INTO financeiro_vinculos
  (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
SELECT lower(hex(randomblob(16))), 'RELATORIO_DESPESA_VIAGEM', r.id,
       'RATEIO_DESPESAS', rd.id, 'RELATORIO_RATEIO_DESPESA'
  FROM relatorio_despesa_viagem r
  JOIN lancamentos l
    ON l.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
   AND l.origem_id = r.id
   AND l.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || r.id || ':CUSTO_INTEGRAL'
  JOIN rateio_despesas rd ON rd.lancamento_id = l.id
 WHERE COALESCE(r.socio_id, '') = ''
   AND NOT EXISTS (
     SELECT 1 FROM financeiro_vinculos fv
      WHERE fv.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND fv.origem_id = r.id
        AND fv.destino_tipo = 'RATEIO_DESPESAS' AND fv.destino_id = rd.id
        AND fv.tipo_vinculo = 'RELATORIO_RATEIO_DESPESA'
   );

-- Entradas e saídas que pertencem ao caixa interno da Share não compõem o
-- custo econômico dos cotistas.
UPDATE lancamentos
   SET escopo_financeiro = 'CAIXA_SHARE'
 WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
   AND tipo_caixa = 'SHARE'
   AND (UPPER(COALESCE(fluxo, '')) = 'ENTRADA'
        OR (UPPER(COALESCE(fluxo, '')) = 'SAIDA'
            AND categoria_nome = 'DESPESAS REEMBOLSÁVEIS'));
