import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/financeiroRoutes.ts', import.meta.url), 'utf8')
const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')
const start = source.indexOf("financeiroRoutes.get('/cotista/dashboard'")
const end = source.indexOf("financeiroRoutes.get('/cotista/voos-emprestimos'", start)
const dashboard = source.slice(start, end)

test('rotas financeiras de cotista validam sessão Supabase antes de retornar dados', () => {
  const guardStart = worker.indexOf("app.use('/api/financeiro/cotista/*'")
  const guardEnd = worker.indexOf("app.route('/api/financeiro'", guardStart)
  const guard = worker.slice(guardStart, guardEnd)
  assert.notEqual(guardStart, -1)
  assert.match(guard, /requireAuthenticatedUser\(c\)/)
  assert.match(guard, /c\.json\(\{ error: 'nao_autorizado' \}, 401\)/)
})

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
  assert.match(dashboard, /LEFT JOIN lancamentos l ON l\.id = r\.lancamento_id/)
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

test('dashboard cotista só projeta documentos de rateio_hold que existem no schema', () => {
  const inicio = dashboard.indexOf('UNION ALL\n      SELECT r.id, r.aeronave_id, r.socio_id')
  const fim = dashboard.indexOf('UNION ALL\n      SELECT l.id', inicio)
  const rateioHolding = dashboard.slice(inicio, fim)
  assert.notEqual(inicio, -1)
  assert.notEqual(fim, -1)
  assert.match(rateioHolding, /selecionarColunaOpcional\(schema, 'rateio_hold', 'r', \['numero_nf'/)
  assert.match(rateioHolding, /\['url_doc', 'documento_url'\], 'url_doc'/)
  assert.match(rateioHolding, /r\.\$\{holdingColumn\}/)
  assert.doesNotMatch(rateioHolding, /r\.(numero_nf|numero_recibo|numero_boleto|numero_demonstrativo|url_nf|url_recibo|url_boleto|url_demonstrativo|url_doc)\b/)
})

test('dashboard cotista inclui médias por mês e voos empréstimos respeitam o intervalo', () => {
  assert.match(dashboard, /calcularMediasCotistaPorMes\(voosMedias as VooMediasCotista\[\], custosPorMes\)/)
  assert.match(dashboard, /medias_mensais: mediasMensais/)
  const inicioVoos = source.indexOf("financeiroRoutes.get('/cotista/voos-emprestimos'")
  const fimVoos = source.indexOf("financeiroRoutes.get('/balanco'", inicioVoos)
  const rotaVoos = source.slice(inicioVoos, fimVoos)
  assert.match(rotaVoos, /date\(a\.data\) >= date\(\?\)/)
  assert.match(rotaVoos, /date\(a\.data\) <= date\(\?\)/)
})

test('saldos por cotista usam somente participantes vinculados à aeronave selecionada', () => {
  assert.match(dashboard, /participantesPermitidos/)
  assert.match(dashboard, /SELECT id, socio_id FROM cotista_aeronave WHERE aeronave_id = \?/)
  assert.match(dashboard, /calcularCompensacaoBalanco\(rows, participantesPermitidos\)/)
})
test('lançamentos econômicos expõem ações de edição, cancelamento e baixa', () => {
  assert.match(source, /financeiroRoutes\.patch\('\/lancamentos\/:id'/)
  assert.match(source, /financeiroRoutes\.delete\('\/lancamentos\/:id'/)
  assert.match(source, /financeiroRoutes\.post\('\/lancamentos\/:id\/baixa'/)
  assert.match(source, /entidadeLancamentoFinanceiro/)
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

test('parcelas de rateio preservam todos os números documentais e o caixa do fluxo', () => {
  assert.match(painelFinanceiro, /e\.tipo_caixa AS envio_tipo_caixa/)
  assert.match(painelFinanceiro, /rd\.numero_nf AS rateio_numero_nf/)
  assert.match(painelFinanceiro, /rd\.numero_recibo AS rateio_numero_recibo/)
  assert.match(painelFinanceiro, /rd\.numero_boleto AS rateio_numero_boleto/)
  assert.match(painelFinanceiro, /rd\.numero_demonstrativo AS rateio_numero_demonstrativo/)
  assert.match(painelFinanceiro, /rd\.numero_doc AS rateio_numero_doc/)
  assert.match(painelFinanceiro, /camposDocumentaisRateioHolding\(schema, 'rh', 'rateio_'\)/)
  assert.doesNotMatch(painelFinanceiro, /rh\.(numero_nf|numero_recibo|numero_boleto|numero_demonstrativo|url_nf|url_recibo|url_boleto|url_demonstrativo|url_doc)\s+AS/)
  assert.match(painelFinanceiro, /e\.tipo_caixa AS envio_tipo_caixa[\s\S]*LEFT JOIN envio_despesas e ON e\.movimentos_holding_id = mh\.id/)
  assert.match(painelFinanceiro, /row\.rateio_numero_nf \?\? row\.numero_nf/)
  assert.match(painelFinanceiro, /row\.rateio_numero_recibo \?\? row\.numero_recibo/)
  assert.match(painelFinanceiro, /row\.rateio_numero_boleto \?\? row\.numero_boleto/)
  assert.match(painelFinanceiro, /row\.rateio_numero_demonstrativo \?\? row\.numero_demonstrativo/)
  assert.match(painelFinanceiro, /row\.tipo_caixa \?\? row\.envio_tipo_caixa/)
  assert.doesNotMatch(painelFinanceiro, /tipo_caixa: 'CLIENTE'/)
  assert.doesNotMatch(painelFinanceiro, /tipo_caixa: 'HOLD'/)
})
