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

test('rateio de despesas identifica o cliente na própria parcela', () => {
  assert.match(dashboard, /FROM rateio_despesas r[\s\S]*JOIN|LEFT JOIN lancamentos l ON l\.id = r\.lancamento_id/)
  assert.match(dashboard, /LEFT JOIN cotista_aeronave ca ON ca\.id = r\.cotista_id/)
  assert.match(dashboard, /LEFT JOIN cliente cl ON cl\.id = ca\.cliente_id/)
  assert.match(dashboard, /COALESCE\(cl\.razao_social, ca\.codigo_cliente, r\.cotista_id\)/)
})

test('rateio_hold tem precedência sobre o movimento holding original', () => {
  assert.match(dashboard, /FROM rateio_hold r[\s\S]*WHERE \$\{\[\.\.\.filtrosHolding/)
  assert.match(dashboard, /FROM movimentos_holding mh[\s\S]*movimentoHoldingSemRateio/)
  assert.match(dashboard, /rh\.\$\{holdingColumn\} = mh\.id/)
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
