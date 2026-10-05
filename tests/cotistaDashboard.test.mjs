import test from 'node:test'
import assert from 'node:assert/strict'
import { resumirHoldings } from '../src/financeiro/cotistaDashboard.ts'

const members = [
  { holdingId: 'H1', holdingName: 'Holding Um', bankAccount: 'Banco Alfa · 123', socioId: 'S1', socioName: 'Ana', percentage: 60 },
  { holdingId: 'H1', holdingName: 'Holding Um', bankAccount: 'Banco Alfa · 123', socioId: 'S2', socioName: 'Bruno', percentage: 40 },
]

test('saldo bancário inclui somente movimentos liquidados e rateia saídas pagas por sócio', () => {
  const result = resumirHoldings(members, [
    { id: 'deposito-ana', holding_id: 'H1', socio_id: 'S1', fluxo: 'APORTE', status: 'RECEBIDO', valor_centavos: 100_000 },
    { id: 'deposito-bruno', holding_id: 'H1', socio_id: 'S2', fluxo: 'ENTRADA', status: 'RECEBIDO', valor_centavos: 50_000 },
    { id: 'despesa-paga', holding_id: 'H1', socio_id: 'S1', fluxo: 'SAIDA', status: 'PAGO', valor_centavos: 60_000 },
    { id: 'despesa-pendente', holding_id: 'H1', socio_id: 'S2', fluxo: 'SAIDA', status: 'EM_ABERTO', valor_centavos: 20_000 },
    { id: 'despesa-direta', holding_id: 'H1', socio_id: 'S1', fluxo: 'SAIDA', status: 'PAGO', pago_diretamente: 1, valor_centavos: 10_000 },
    { id: 'despesa-cancelada', holding_id: 'H1', socio_id: 'S1', fluxo: 'SAIDA', status: 'CANCELADO', valor_centavos: 99_000 },
  ], [
    { movimento_id: 'despesa-paga', socio_id: 'S1', status: 'PAGO', pago_diretamente: 0, valor_rateado_centavos: 36_000, valor_pago_real_centavos: 36_000 },
    { movimento_id: 'despesa-paga', socio_id: 'S2', status: 'PAGO', pago_diretamente: 0, valor_rateado_centavos: 24_000, valor_pago_real_centavos: 24_000 },
    { movimento_id: null, socio_id: 'S1', status: 'PAGO', pago_diretamente: 1, valor_rateado_centavos: 10_000, valor_pago_real_centavos: 10_000 },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0].saldoContaCentavos, 90_000)
  assert.deepEqual(result[0].socios.map(({ cotistaId, totalDepositadoCentavos, totalConsumidoCentavos, despesasPagasDiretamenteCentavos, saldoCentavos }) => ({ cotistaId, totalDepositadoCentavos, totalConsumidoCentavos, despesasPagasDiretamenteCentavos, saldoCentavos })), [
    { cotistaId: 'S1', totalDepositadoCentavos: 100_000, totalConsumidoCentavos: 36_000, despesasPagasDiretamenteCentavos: 10_000, saldoCentavos: 64_000 },
    { cotistaId: 'S2', totalDepositadoCentavos: 50_000, totalConsumidoCentavos: 24_000, despesasPagasDiretamenteCentavos: 0, saldoCentavos: 26_000 },
  ])
})

test('despesa holding sem rateio vinculado reduz o caixa e é atribuída ao sócio do movimento', () => {
  const [holding] = resumirHoldings(members, [
    { id: 'aporte', holding_id: 'H1', socio_id: 'S2', fluxo: 'APORTE', status: 'RECEBIDO', valor_centavos: 45_000 },
    { id: 'saque-sem-rateio', holding_id: 'H1', socio_id: 'S2', fluxo: 'SAIDA', status: 'PAGO', valor_centavos: 5_000 },
  ], [])

  assert.equal(holding.saldoContaCentavos, 40_000)
  assert.equal(holding.socios.find((socio) => socio.cotistaId === 'S2').saldoCentavos, 40_000)
})
