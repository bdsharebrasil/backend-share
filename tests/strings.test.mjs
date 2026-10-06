import test from 'node:test'
import assert from 'node:assert/strict'
import { dateValue, isIsoDate } from '../src/lib/strings.ts'

test('aceita datas ISO válidas e timestamps ISO, mantendo somente a data', () => {
  assert.equal(isIsoDate('2026-10-05'), true)
  assert.equal(isIsoDate('2026-10-05T22:39:23-03:00'), true)
  assert.equal(dateValue('2026-10-05T22:39:23-03:00', '2000-01-01'), '2026-10-05')
})

test('rejeita datas ISO impossíveis e usa fallback determinístico', () => {
  assert.equal(isIsoDate('2026-02-30'), false)
  assert.equal(isIsoDate('2026-13-01'), false)
  assert.equal(dateValue('2026-02-30', '2026-10-05'), '2026-10-05')
  assert.equal(dateValue('31/12/2026', '2026-10-05'), '2026-10-05')
})
