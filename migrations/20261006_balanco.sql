-- Versão 2: NÃO altera rateio_despesas, rateio_hold ou envio_despesas.
-- Substitui a migração anterior quando ela ainda não foi aplicada.
CREATE TABLE balanco_ajustes (
 id TEXT PRIMARY KEY,
 aeronave_id TEXT NOT NULL REFERENCES aeronave(id),
 competencia TEXT NOT NULL,
 dominio TEXT NOT NULL,
 origem_rateio_id TEXT NOT NULL,
 destino_rateio_id TEXT NOT NULL,
 valor_centavos INTEGER NOT NULL CHECK(valor_centavos > 0),
 motivo TEXT NOT NULL CHECK(length(trim(motivo)) >= 5),
 criado_por TEXT NOT NULL,
 criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 idempotency_key TEXT NOT NULL UNIQUE,
 CHECK(origem_rateio_id <> destino_rateio_id)
);
CREATE INDEX idx_balanco_ajustes_periodo ON balanco_ajustes(aeronave_id, competencia);
-- origem_chave é uma expressão calculada da view, não uma coluna nova do rateio.
-- Prefixos separam namespaces: mesmo ID em tabelas diferentes não significa mesma origem.
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
        COALESCE(NULLIF(r.data_competencia_demonstrativo,''),r.data_emissao) AS competencia,
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
        COALESCE(NULLIF(r.data_competencia_demonstrativo,''),r.data_emissao),
        r.categoria_nome, r.descricao_despesa, r.tipo_rateio, r.valor_rateado_centavos,
        r.valor_pago_real_centavos, r.pago_por, r.pago_diretamente, r.data_pagamento, r.status
 FROM rateio_hold r JOIN hold_socios hs ON hs.id=r.socio_id
 JOIN cotista_aeronave ca ON ca.socio_id=hs.id AND ca.aeronave_id=r.aeronave_id;
CREATE TRIGGER trg_balanco_ajuste_valida BEFORE INSERT ON balanco_ajustes BEGIN
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM vw_balanco_rateios a JOIN vw_balanco_rateios b ON b.id=NEW.destino_rateio_id
   WHERE a.id=NEW.origem_rateio_id AND a.aeronave_id=NEW.aeronave_id
     AND b.aeronave_id=a.aeronave_id AND b.origem_chave=a.origem_chave
     AND a.dominio=NEW.dominio AND b.dominio=a.dominio
     AND a.participante_id<>b.participante_id
     AND a.competencia=NEW.competencia AND b.competencia=a.competencia
     AND a.origem_chave NOT LIKE 'SEM_VINCULO:%'
     AND UPPER(COALESCE(a.status,'')) NOT IN ('CANCELADO','ESTORNO')
     AND UPPER(COALESCE(b.status,'')) NOT IN ('CANCELADO','ESTORNO')
     AND a.valor_rateado_centavos
       + COALESCE((SELECT SUM(valor_centavos) FROM balanco_ajustes WHERE destino_rateio_id=a.id),0)
       - COALESCE((SELECT SUM(valor_centavos) FROM balanco_ajustes WHERE origem_rateio_id=a.id),0)
       >= NEW.valor_centavos
 ) THEN RAISE(ABORT,'ajuste_incompativel_ou_saldo_insuficiente') END;
END;
CREATE TRIGGER trg_balanco_ajuste_imutavel_update BEFORE UPDATE ON balanco_ajustes BEGIN
 SELECT RAISE(ABORT,'ajuste_imutavel_use_ajuste_inverso');
END;
CREATE TRIGGER trg_balanco_ajuste_imutavel_delete BEFORE DELETE ON balanco_ajustes BEGIN
 SELECT RAISE(ABORT,'ajuste_imutavel_use_ajuste_inverso');
END;
-- Índices em tabelas existentes; nenhum campo novo.
-- Se já houver IDs de envio repetidos, conciliar esses registros antes de aplicar.
CREATE UNIQUE INDEX idx_envio_despesas_id_balanco ON envio_despesas(id);
CREATE UNIQUE INDEX idx_vinculo_envio_idempotencia_balanco
 ON financeiro_vinculos(origem_id)
 WHERE origem_tipo='IDEMPOTENCY_KEY' AND destino_tipo='ENVIO_DESPESA' AND tipo_vinculo='IDEMPOTENCIA';
