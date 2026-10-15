-- Pré-condição: conciliar manualmente recebíveis duplicados ativos por relatório e cotista.
-- O índice abaixo falha intencionalmente se ainda houver mais de um recebível ativo
-- para o mesmo relatório/devedor; não escolhe nem apaga registros financeiros.

-- Normaliza as duas chaves históricas e preenche origem_id quando ela ficou vazia.
UPDATE contas_areceber
SET origem_tipo = 'RELATORIO_DESPESA_VIAGEM',
    origem_id = COALESCE(
      NULLIF(trim(origem_id), ''),
      CASE
        WHEN idempotency_key LIKE 'RELATORIO_DESPESA_VIAGEM:%:REEMBOLSO_CLIENTE:CONTA_RECEBER'
          THEN substr(
            idempotency_key,
            length('RELATORIO_DESPESA_VIAGEM:') + 1,
            length(idempotency_key) - length('RELATORIO_DESPESA_VIAGEM:') - length(':REEMBOLSO_CLIENTE:CONTA_RECEBER')
          )
        ELSE substr(
          idempotency_key,
          length('RELATORIO_DESPESA_VIAGEM:') + 1,
          length(idempotency_key) - length('RELATORIO_DESPESA_VIAGEM:') - length(':CONTA_RECEBER')
        )
      END
    ),
    idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || COALESCE(
      NULLIF(trim(origem_id), ''),
      CASE
        WHEN idempotency_key LIKE 'RELATORIO_DESPESA_VIAGEM:%:REEMBOLSO_CLIENTE:CONTA_RECEBER'
          THEN substr(
            idempotency_key,
            length('RELATORIO_DESPESA_VIAGEM:') + 1,
            length(idempotency_key) - length('RELATORIO_DESPESA_VIAGEM:') - length(':REEMBOLSO_CLIENTE:CONTA_RECEBER')
          )
        ELSE substr(
          idempotency_key,
          length('RELATORIO_DESPESA_VIAGEM:') + 1,
          length(idempotency_key) - length('RELATORIO_DESPESA_VIAGEM:') - length(':CONTA_RECEBER')
        )
      END
    ) || ':CONTA_RECEBER'
WHERE idempotency_key LIKE 'RELATORIO_DESPESA_VIAGEM:%:CONTA_RECEBER';

-- Recria somente os vínculos de recebíveis deste fluxo, apontando para os
-- recebíveis ativos sobreviventes após a conciliação manual.
DELETE FROM financeiro_vinculos
WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
  AND destino_tipo = 'CONTA_RECEBER';

INSERT OR IGNORE INTO financeiro_vinculos
  (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
SELECT lower(hex(randomblob(16))),
       cr.origem_tipo,
       cr.origem_id,
       'CONTA_RECEBER',
       cr.id,
       'RELATORIO_CONTA_RECEBER'
FROM contas_areceber cr
WHERE cr.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
  AND cr.origem_id IS NOT NULL
  AND cr.cotista_id IS NOT NULL
  AND UPPER(COALESCE(cr.status, '')) <> 'CANCELADO';

-- Uma cobrança por relatório/devedor. Canceladas são excluídas do índice:
-- não são reabertas nem impedem a criação futura por uma rotina autorizada.
CREATE UNIQUE INDEX idx_contas_areceber_relatorio_devedor_ativo
ON contas_areceber (origem_id, cotista_id)
WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
  AND origem_id IS NOT NULL
  AND cotista_id IS NOT NULL
  AND UPPER(COALESCE(status, '')) <> 'CANCELADO';
