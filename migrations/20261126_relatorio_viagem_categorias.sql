-- Corrige somente a classificação dos registros originados em relatórios de viagem.
-- Valores, status, datas de pagamento, comprovantes e vínculos permanecem intactos.
-- Reexecutável: só atualiza classificações divergentes.
UPDATE lancamentos
SET categoria_share_id = '64fb90ae-dc29-4468-a2b3-1578f5c9bd06',
    categoria_nome = 'RELATORIO DE VIAGEM',
    grupo_categoria = 'DESPESAS REEMBOLSÁVEIS'
WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
  AND tipo_caixa = 'SHARE' AND fluxo = 'SAIDA'
  AND EXISTS (SELECT 1 FROM categoria_movimentacao_share WHERE id = '64fb90ae-dc29-4468-a2b3-1578f5c9bd06')
  AND (categoria_share_id IS NOT '64fb90ae-dc29-4468-a2b3-1578f5c9bd06'
    OR categoria_nome IS NOT 'RELATORIO DE VIAGEM' OR grupo_categoria IS NOT 'DESPESAS REEMBOLSÁVEIS');

UPDATE lancamentos
SET categoria_cliente_id = 'b4016b98-7b4c-4f18-9f8d-d7b03cd4d300',
    categoria_nome = 'DESPESAS DE VIAGEM',
    grupo_categoria = 'DESPESAS DE VIAGEM'
WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
  AND tipo_caixa = 'CLIENTE' AND fluxo = 'SAIDA'
  AND EXISTS (SELECT 1 FROM categoria_movimentacao_cliente WHERE id = 'b4016b98-7b4c-4f18-9f8d-d7b03cd4d300')
  AND (categoria_cliente_id IS NOT 'b4016b98-7b4c-4f18-9f8d-d7b03cd4d300'
    OR categoria_nome IS NOT 'DESPESAS DE VIAGEM' OR grupo_categoria IS NOT 'DESPESAS DE VIAGEM');

UPDATE lancamentos
SET categoria_share_id = 'a7555994-103d-4739-96a5-001c3bec1424',
    categoria_nome = 'REEMBOLSO RELATORIO DE DESPESA DE VIAGENS recebido'
WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
  AND tipo_caixa = 'SHARE' AND fluxo = 'ENTRADA'
  AND EXISTS (SELECT 1 FROM categoria_movimentacao_share WHERE id = 'a7555994-103d-4739-96a5-001c3bec1424')
  AND (categoria_share_id IS NOT 'a7555994-103d-4739-96a5-001c3bec1424'
    OR categoria_nome IS NOT 'REEMBOLSO RELATORIO DE DESPESA DE VIAGENS recebido');

UPDATE contas_apagar
SET categoria_nome = 'RELATORIO DE VIAGEM'
WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
  AND categoria_nome IS NOT 'RELATORIO DE VIAGEM';

UPDATE contas_areceber
SET categoria_id = 'a7555994-103d-4739-96a5-001c3bec1424',
    categoria_nome = 'REEMBOLSO RELATORIO DE DESPESA DE VIAGENS recebido'
WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
  AND EXISTS (SELECT 1 FROM categoria_movimentacao_share WHERE id = 'a7555994-103d-4739-96a5-001c3bec1424')
  AND (categoria_id IS NOT 'a7555994-103d-4739-96a5-001c3bec1424'
    OR categoria_nome IS NOT 'REEMBOLSO RELATORIO DE DESPESA DE VIAGENS recebido');

UPDATE rateio_despesas
SET categoria_id = 'b4016b98-7b4c-4f18-9f8d-d7b03cd4d300', categoria_nome = 'DESPESAS DE VIAGEM'
WHERE (origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
    OR lancamento_id IN (SELECT id FROM lancamentos WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND tipo_caixa = 'CLIENTE' AND fluxo = 'SAIDA'))
  AND EXISTS (SELECT 1 FROM categoria_movimentacao_cliente WHERE id = 'b4016b98-7b4c-4f18-9f8d-d7b03cd4d300')
  AND (categoria_id IS NOT 'b4016b98-7b4c-4f18-9f8d-d7b03cd4d300' OR categoria_nome IS NOT 'DESPESAS DE VIAGEM');
