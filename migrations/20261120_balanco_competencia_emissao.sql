-- Emissão é a competência financeira única do Fechamento e do Portal.
-- Atualiza apenas a VIEW: não apaga tabelas, rateios, pagamentos ou ajustes.
-- Aplicar primeiro em D1 de homologação e revisar os gatilhos dependentes.
DROP VIEW IF EXISTS vw_balanco_rateios;
CREATE VIEW vw_balanco_rateios AS
 SELECT 'CLIENTE:' || r.id AS id, r.aeronave_id, r.cotista_id AS participante_id,
        'CLIENTES' AS dominio,
        CASE
          WHEN EXISTS (SELECT 1 FROM lancamentos l WHERE l.id=r.lancamento_id)
            AND EXISTS (SELECT 1 FROM envio_despesas e WHERE e.id=r.lancamento_id)
            THEN 'SEM_VINCULO:AMBIGUO:' || r.id
          WHEN EXISTS (SELECT 1 FROM lancamentos l WHERE l.id=r.lancamento_id)
            THEN 'LANCAMENTO:' || r.lancamento_id
          WHEN (SELECT COUNT(*) FROM envio_despesas e WHERE e.id=r.lancamento_id)=1
            THEN 'ENVIO:' || r.lancamento_id
          ELSE 'SEM_VINCULO:' || r.id END AS origem_chave,
        r.data_emissao AS competencia,
        r.categoria_nome, r.descricao_despesa, r.tipo_rateio, r.valor_rateado_centavos,
        r.valor_pago_real_centavos, r.pago_por, r.pago_diretamente, r.data_pagamento, r.status
 FROM rateio_despesas r
 UNION ALL
 SELECT 'HOLD:' || r.id, r.aeronave_id, ca.id, 'HOLD:' || hs.holding_id,
        CASE
          WHEN EXISTS (SELECT 1 FROM movimentos_holding m WHERE m.id=r.movimento_id)
            AND EXISTS (SELECT 1 FROM envio_despesas e WHERE e.id=r.movimento_id)
            THEN 'SEM_VINCULO:AMBIGUO:' || r.id
          WHEN EXISTS (SELECT 1 FROM movimentos_holding m WHERE m.id=r.movimento_id)
            THEN 'MOVIMENTO:' || r.movimento_id
          WHEN (SELECT COUNT(*) FROM envio_despesas e WHERE e.id=r.movimento_id)=1
            THEN 'ENVIO:' || r.movimento_id
          -- Para pagamentos diretos de holding sem movimento bancário.
          WHEN UPPER(COALESCE(r.origem_tipo,''))='ENVIO_DESPESA'
            AND (SELECT COUNT(*) FROM envio_despesas e WHERE e.id=r.origem_id)=1
            THEN 'ENVIO:' || r.origem_id
          ELSE 'SEM_VINCULO:' || r.id END,
        r.data_emissao,
        r.categoria_nome, r.descricao_despesa, r.tipo_rateio, r.valor_rateado_centavos,
        r.valor_pago_real_centavos, r.pago_por, r.pago_diretamente, r.data_pagamento, r.status
 FROM rateio_hold r JOIN hold_socios hs ON hs.id=r.socio_id
 JOIN cotista_aeronave ca ON ca.socio_id=hs.id AND ca.aeronave_id=r.aeronave_id;
