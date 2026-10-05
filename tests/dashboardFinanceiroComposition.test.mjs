import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/financeiroRoutes.ts', import.meta.url), 'utf8')
const start = source.indexOf("financeiroRoutes.get('/cotista/dashboard'")
const end = source.indexOf("financeiroRoutes.get('/cotista/voos-emprestimos'", start)
const dashboard = source.slice(start, end)

test('dashboard usa o valor já rateado sem recalcular a parcela', () => {
  assert.match(dashboard, /r\.valor_rateado_centavos AS valor_centavos/)
  assert.match(dashboard, /r\.valor_rateado_centavos AS valor_rateado_centavos/)
  assert.doesNotMatch(dashboard, /r\.valor_total_centavos\s*\/|valor_total_centavos.*percentual/)
})

test('UNION do dashboard usa ordenação por posições compatível com SQLite/D1', () => {
  assert.match(dashboard, /ORDER BY 4 DESC, 1 DESC LIMIT 1000/)
  assert.doesNotMatch(dashboard, /ORDER BY data DESC, id DESC LIMIT 1000/)
})

test('rateio de despesas identifica o cliente na própria parcela', () => {
  assert.match(dashboard, /FROM rateio_despesas r/)
  assert.doesNotMatch(dashboard, /JOIN lancamentos l ON l\.id = r\.lancamento_id/)
  assert.match(dashboard, /LEFT JOIN cotista_aeronave ca ON ca\.id = r\.cotista_id/)
  assert.match(dashboard, /LEFT JOIN cliente cl ON cl\.id = ca\.cliente_id/)
  assert.match(dashboard, /COALESCE\(cl\.razao_social, ca\.codigo_cliente, r\.cotista_id\)/)
})

test('rateio_hold compõe o balanço sem eliminar movimentos do extrato bancário', () => {
  assert.match(dashboard, /FROM rateio_hold r[\s\S]*WHERE \$\{\[\.\.\.filtrosHolding/)
  assert.match(dashboard, /FROM movimentos_holding mh[\s\S]*movimentoHoldingSemRateio/)
  assert.match(dashboard, /rh\.\$\{holdingColumn\} = mh\.id/)
  assert.match(dashboard, /WHERE \$\{filtrosMovimento\.join\(' AND '\)\}[\s\S]*ORDER BY date\(mh\.data_emissao\)/)
  assert.match(dashboard, /'APORTE'[\s\S]*escopo_financeiro/)
  assert.match(dashboard, /paramsMovimento\.push\(cotistaSocioId\)/)
  assert.doesNotMatch(dashboard, /paramsMovimento\.push\(cotistaId\)/)
  assert.match(dashboard, /movimentos_holding: extratoHolding/)
  assert.match(dashboard, /const holdings = resumirHoldings\(/)
})

test('lançamento sem rateio é fallback e não duplica parcela rateada', () => {
  assert.match(dashboard, /FROM lancamentos l[\s\S]*lancamentoSemRateio/)
  assert.match(dashboard, /rd\.lancamento_id = l\.id/)
  assert.match(dashboard, /'lancamentos' AS origem_rateio/)
})

const rateioOpcoes = source.slice(source.indexOf("financeiroRoutes.get('/dashboard/financeiro/movimentacoes/:origemTipo/:origemId/rateio-opcoes'"))

test('opções de rateio retornam vencimento e periodicidade gravados na origem', () => {
  assert.match(rateioOpcoes, /origem\.source\.data_vencimento/)
  assert.match(rateioOpcoes, /origem\.source\.periodicidade/)
  assert.match(rateioOpcoes, /data_vencimento:/)
  assert.match(rateioOpcoes, /periodicidade:/)
})

const painelFinanceiro = source.slice(source.indexOf("financeiroRoutes.get('/dashboard/financeiro',"), source.indexOf("async function origemRateio"))

test('painel financeiro exibe parcelas de rateio_despesas e exclui o lançamento original', () => {
  assert.match(painelFinanceiro, /FROM rateio_despesas rd/)
  assert.match(painelFinanceiro, /rd\.valor_rateado_centavos AS rateio_valor_centavos/)
  assert.match(painelFinanceiro, /rateio_cotista_id/)
  assert.match(painelFinanceiro, /lancamentosComRateio/)
  assert.match(painelFinanceiro, /lancamentosComFornecedor\.filter\(\(row\) => !lancamentosComRateio\.has/)
})

test('painel financeiro exibe parcelas de rateio_hold e exclui o movimento original', () => {
  assert.match(painelFinanceiro, /FROM rateio_hold rh/)
  assert.match(painelFinanceiro, /rh\.valor_rateado_centavos AS rateio_valor_centavos/)
  assert.match(painelFinanceiro, /movimentosHoldingComRateio/)
  assert.match(painelFinanceiro, /movimentosHoldingComFornecedor\.filter\(\(row\) => !movimentosHoldingComRateio\.has/)
})
