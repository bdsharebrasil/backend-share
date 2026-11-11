import test from 'node:test'
import assert from 'node:assert/strict'
import { carregarBalancoOperacional, minutosEntreHorarios } from '../src/financeiro/balancoOperacional.ts'

test('horários HH:MM e HH:MM:SS preservam minutos exatos, inclusive meia-noite', () => {
  assert.equal(minutosEntreHorarios('12:11', '12:36'), 25)
  assert.equal(minutosEntreHorarios('18:08:00', '18:30:00'), 22)
  assert.equal(minutosEntreHorarios('23:55', '00:20'), 25)
  assert.equal(minutosEntreHorarios('12:00:10', '12:01:40'), 1.5)
  assert.equal(minutosEntreHorarios('12:00', '12:00'), 0)
  for (const valor of [null, '', '24:00', '12:60', '12:00:60', 'abc', '0:00']) {
    assert.equal(minutosEntreHorarios(valor, '12:30'), null)
    assert.equal(minutosEntreHorarios('12:30', valor), null)
  }
})

test('seis etapas reais da PT-JPK: 174 minutos totais e 110 de voo, sem somar decimais arredondados', async () => {
  // Extrato fornecido em 11/11/2026; somente campos operacionais, sem dados pessoais.
  const linhas = [
    ['2026-01-14', '18:08:00', '18:13:00', '18:28:00', '18:30:00', 0.37, 0.25, 'VT - Voo Teste'],
    ['2026-01-30', '19:55:00', '20:05:00', '20:42:00', '20:43:00', 0.80, 0.62, 'TR - Traslado'],
    ['2026-02-27', '21:05:00', '21:15:00', '21:29:00', '21:30:00', 0.42, 0.23, 'VT - Voo Teste'],
    ['2026-05-11', '19:55:00', '20:05:00', '20:20:00', '20:22:00', 0.45, 0.25, 'TR - Traslado'],
    ['2026-08-28', '12:11', '12:20', '12:34', '12:36', 0.42, 0.23, 'VT - Voo Teste'],
    ['2026-09-16', '18:35', '18:45', '19:00', '19:02', 0.45, 0.25, 'VT - Voo Teste'],
  ].map(([data, tempo_ac, tempo_dep, tempo_pou, tempo_cor, tempo_total, tempo_voo, natureza], index) => ({
    id: `jpk-etapa-${index + 1}`, data, tempo_ac, tempo_dep, tempo_pou, tempo_cor, tempo_total, tempo_voo, natureza,
    cliente_id: null, socio_id: null, holding_id: null,
  }))
  const db = { prepare(sql) { return {
    bind() { return this },
    async all() { return { results: sql.includes('FROM lancamentos_diario_bordo v') ? linhas : [] } },
  } } }
  const schema = new Map([['lancamentos_diario_bordo', new Set(['id', 'aeronave_id', 'data_registro', 'tempo_total'])]])
  const op = await carregarBalancoOperacional(db, schema, 'jpk', '2026-01-01', '2026-09-30')
  assert.equal(op.voos.length, 6)
  assert.equal(op.voos.reduce((s, v) => s + v.minutosTotal, 0), 174)
  assert.equal(op.voos.reduce((s, v) => s + v.minutosVoo, 0), 110)
  assert.deepEqual(op.voos.map((v) => v.minutosTotal), [22, 48, 25, 27, 25, 27])
  assert.equal(op.voos[4].horas, 0.42, 'valor originalmente gravado permanece disponível')
  assert.equal(op.voos[4].minutosTotal, 25, 'fechamento recebe precisão para calcular 25/60 h')
  assert.equal(op.voos.filter((v) => v.natureza === 'VT - Voo Teste').length, 4)
})
