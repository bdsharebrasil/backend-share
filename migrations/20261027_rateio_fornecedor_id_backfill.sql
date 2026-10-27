-- Backfill de fornecedor_id vazio em envio_despesas, lancamentos e rateio_despesas.
-- Preenche somente quando o fornecedor já está registrado em
-- fornecedores_favoritos ou fornecedores_combustivel (herdando o id do
-- envio/lançamento/conta/abastecimento ou casando pelo nome registrado).
-- Idempotente: pode ser executado mais de uma vez.
--
-- Aplicação: npx wrangler d1 execute bd_sharebrasil --remote --file=./migrations/20261027_rateio_fornecedor_id_backfill.sql

-- 1) envio_despesas: casa o nome do fornecedor com o cadastro existente.
UPDATE envio_despesas
SET fornecedor_id = COALESCE(
  (SELECT f.id FROM fornecedores_favoritos f
    WHERE lower(trim(COALESCE(f.nome_completo, ''))) = lower(trim(envio_despesas.fornecedor))
       OR lower(trim(COALESCE(f.apelido, ''))) = lower(trim(envio_despesas.fornecedor))
    LIMIT 1),
  (SELECT fc.id FROM fornecedores_combustivel fc
    WHERE lower(trim(fc.nome_fornecedor)) = lower(trim(envio_despesas.fornecedor))
    LIMIT 1)
)
WHERE (envio_despesas.fornecedor_id IS NULL OR NULLIF(TRIM(envio_despesas.fornecedor_id), '') = '')
  AND NULLIF(TRIM(COALESCE(envio_despesas.fornecedor, '')), '') IS NOT NULL;

-- 2) lancamentos: mesma casação pelo nome do fornecedor.
UPDATE lancamentos
SET fornecedores_favoritos_id = COALESCE(
  (SELECT f.id FROM fornecedores_favoritos f
    WHERE lower(trim(COALESCE(f.nome_completo, ''))) = lower(trim(lancamentos.fornecedor_nome))
       OR lower(trim(COALESCE(f.apelido, ''))) = lower(trim(lancamentos.fornecedor_nome))
    LIMIT 1),
  (SELECT fc.id FROM fornecedores_combustivel fc
    WHERE lower(trim(fc.nome_fornecedor)) = lower(trim(lancamentos.fornecedor_nome))
    LIMIT 1)
)
WHERE (lancamentos.fornecedores_favoritos_id IS NULL OR NULLIF(TRIM(lancamentos.fornecedores_favoritos_id), '') = '')
  AND NULLIF(TRIM(COALESCE(lancamentos.fornecedor_nome, '')), '') IS NOT NULL;

-- 3) rateio_despesas: herda o fornecedor_id do envio, do lançamento, da conta
--    a pagar ou do abastecimento de origem, nessa ordem.
UPDATE rateio_despesas
SET fornecedor_id = COALESCE(
  (SELECT e.fornecedor_id FROM envio_despesas e
    WHERE e.id = rateio_despesas.lancamento_id
      AND NULLIF(TRIM(COALESCE(e.fornecedor_id, '')), '') IS NOT NULL
    LIMIT 1),
  (SELECT l.fornecedores_favoritos_id FROM lancamentos l
    WHERE l.id = rateio_despesas.lancamento_id
      AND NULLIF(TRIM(COALESCE(l.fornecedores_favoritos_id, '')), '') IS NOT NULL
    LIMIT 1),
  (SELECT cp.fornecedor_id FROM contas_apagar cp
    WHERE cp.lancamentos_id = rateio_despesas.lancamento_id
      AND NULLIF(TRIM(COALESCE(cp.fornecedor_id, '')), '') IS NOT NULL
    LIMIT 1),
  (SELECT a.fornecedor_id FROM abastecimentos a
    WHERE rateio_despesas.origem_tipo = 'ABASTECIMENTO'
      AND a.id = rateio_despesas.origem_id
      AND NULLIF(TRIM(COALESCE(a.fornecedor_id, '')), '') IS NOT NULL
    LIMIT 1)
)
WHERE (rateio_despesas.fornecedor_id IS NULL OR NULLIF(TRIM(rateio_despesas.fornecedor_id), '') = '');

-- Conferência (executar separadamente): rateios que continuaram sem fornecedor.
-- SELECT COUNT(*) FROM rateio_despesas
--  WHERE (fornecedor_id IS NULL OR NULLIF(TRIM(fornecedor_id), '') = '')
--    AND UPPER(COALESCE(status, '')) <> 'CANCELADO';
