import test from 'node:test'
import assert from 'node:assert/strict'
import { calcularMediasCotista, calcularMediasCotistaPorMes } from '../src/financeiro/mediasCotista.ts'

test('calcula as médias operacionais sem arredondar horas antes das divisões', () => {
  const resultado = calcularMediasCotista([
    { data_registro: '2026-01-05', tempo_total: 2.5, pousos_total: 3 },
    { data_registro: '2026-01-06', tempo_total: 1.25, pousos_total: 2 },
    { data_registro: '2026-02-07', tempo_total: 0.25, pousos_total: 1 },
  ], 40000)

  assert.deepEqual(resultado, {
    horas_voadas: 4,
    total_voos: 3,
    total_pousos: 6,
    custo_por_hora_centavos: 10000,
    dia_mais_utilizado: 'Segunda-feira',
    media_mensal_horas: 2,
    custo_medio_por_voo_centavos: 13333,
  })
})

test('não inventa custo ou dia quando não existem voos', () => {
  assert.deepEqual(calcularMediasCotista([], 99999), {
    horas_voadas: 0,
    total_voos: 0,
    total_pousos: 0,
    custo_por_hora_centavos: 0,
    dia_mais_utilizado: null,
    media_mensal_horas: 0,
    custo_medio_por_voo_centavos: 0,
  })
})

test('separa médias operacionais e custos por mês, incluindo custo sem voo', () => {
  const resultado = calcularMediasCotistaPorMes([
    { data_registro: '2026-01-05', tempo_total: 2, pousos_total: 2 },
    { data_registro: '2026-02-07', tempo_total: 1, pousos_total: 1 },
  ], new Map([['2026-01', 20000], ['2026-02', 40000], ['2026-03', 7000]]))

  assert.deepEqual(resultado.map(({ mes, horas_voadas, total_voos, custo_por_hora_centavos, custo_medio_por_voo_centavos }) => ({ mes, horas_voadas, total_voos, custo_por_hora_centavos, custo_medio_por_voo_centavos })), [
    { mes: '2026-01', horas_voadas: 2, total_voos: 1, custo_por_hora_centavos: 10000, custo_medio_por_voo_centavos: 20000 },
    { mes: '2026-02', horas_voadas: 1, total_voos: 1, custo_por_hora_centavos: 40000, custo_medio_por_voo_centavos: 40000 },
    { mes: '2026-03', horas_voadas: 0, total_voos: 0, custo_por_hora_centavos: 0, custo_medio_por_voo_centavos: 0 },
  ])
})
