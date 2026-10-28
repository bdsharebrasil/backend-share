import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calcularTotaisDespesasTripulante,
  dataFimProvisoriaVoo,
  normalizarDespesasTripulante,
} from '../src/relatorioDespesaViagemTripulante.ts'

test('normaliza o pagador Eu para a posição autenticada e preserva a posição explícita', () => {
  const despesas = normalizarDespesasTripulante([
    { id: 'despesa-a', categoria: 'Alimentação', data: '2026-10-27', valor: '12,35', pago_por: 'Eu' },
    { id: 'despesa-b', categoria: 'combustível', data: '2026-10-27', valor: 8.1, pago_por: 'Tripulante 1' },
    { id: 'despesa-c', categoria: 'Outros', data: '2026-10-27', valor: 4, pago_por: 'Cliente' },
  ], 2, true)
  assert.deepEqual(despesas.map((despesa) => despesa.pago_por), ['tripulante_2', 'tripulante_1', 'cliente'])
  assert.equal(despesas[0].valor, 12.35)
})

test('calcula os totais por categoria e pagador usando centavos', () => {
  const despesas = normalizarDespesasTripulante([
    { id: 'a', categoria: 'Combustível', data: '2026-10-27', valor: 10.1, pago_por: 'tripulante_1' },
    { id: 'b', categoria: 'Hospedagem', data: '2026-10-27', valor: 20.2, pago_por: 'tripulante_2' },
    { id: 'c', categoria: 'Alimentação', data: '2026-10-27', valor: 30.3, pago_por: 'Cliente' },
    { id: 'd', categoria: 'Transporte', data: '2026-10-27', valor: 40.4, pago_por: 'Share Brasil' },
    { id: 'e', categoria: 'Outros', data: '2026-10-27', valor: 1.01, pago_por: 'Eu' },
  ], 1, true)
  assert.deepEqual(calcularTotaisDespesasTripulante(despesas), {
    total_valor: 102.01,
    total_combustivel: 10.1,
    total_hospedagem: 20.2,
    total_alimentacao: 30.3,
    total_transporte: 40.4,
    total_outros: 1.01,
    total_tripulacao: 31.31,
    total_tripulante_1: 11.11,
    total_tripulante_2: 20.2,
    total_cliente: 30.3,
    total_sharebrasil: 40.4,
  })
})

test('rejeita despesas inválidas, IDs duplicados e pagador do copiloto inexistente', () => {
  assert.throws(() => normalizarDespesasTripulante([{ id: 'a', categoria: 'Taxa', data: '2026-10-27', valor: 2, pago_por: 'Cliente' }], 1, false), /categoria/)
  assert.throws(() => normalizarDespesasTripulante([
    { id: 'a', categoria: 'Outros', data: '2026-10-27', valor: 2, pago_por: 'Cliente' },
    { id: 'a', categoria: 'Outros', data: '2026-10-27', valor: 3, pago_por: 'Cliente' },
  ], 1, false), /id_despesa/)
  assert.throws(() => normalizarDespesasTripulante([{ id: 'a', categoria: 'Outros', data: '2026-10-27', valor: 2, pago_por: 'Tripulante 2' }], 1, false), /segundo_tripulante/)
  assert.throws(() => normalizarDespesasTripulante([{ id: 'a', categoria: 'Outros', data: '2026-02-30', valor: 2, pago_por: 'Cliente' }], 1, false), /data/)
})

test('calcula a data provisória usando a duração do voo sem preencher zero dias', () => {
  assert.equal(dataFimProvisoriaVoo('2026-10-28', 3), '2026-10-30')
  assert.equal(dataFimProvisoriaVoo('2026-10-28', 0), '2026-10-28')
})
