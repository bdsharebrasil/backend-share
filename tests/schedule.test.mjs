import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calcularDiasPeriodoAgendamento, normalizarHorarioAgendamento } from '../src/lib/schedule.ts'

test('normaliza horário de Brasília em UTC sem perder HH:MM', () => {
	assert.equal(normalizarHorarioAgendamento('2026-10-13', '09:25'), '2026-10-13T12:25:00.000Z')
  assert.equal(normalizarHorarioAgendamento('2026-10-13', '2026-10-13T09:25:00.000Z'), '2026-10-13T09:25:00.000Z')
  assert.equal(normalizarHorarioAgendamento('2026-10-13', 'inválido'), null)
})

test('calcula os dias do período de voo e rejeita datas inválidas', () => {
  assert.equal(calcularDiasPeriodoAgendamento('2026-10-13', '2026-10-13'), 1)
  assert.equal(calcularDiasPeriodoAgendamento('2026-10-13', '2026-10-15'), 3)
  assert.equal(calcularDiasPeriodoAgendamento('2026-10-15', '2026-10-13'), null)
  assert.equal(calcularDiasPeriodoAgendamento('2026-02-30', '2026-03-01'), null)
})
