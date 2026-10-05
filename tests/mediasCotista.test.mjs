import test from 'node:test'
import assert from 'node:assert/strict'
import { calcularMediasCotista } from '../src/financeiro/mediasCotista.ts'

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
