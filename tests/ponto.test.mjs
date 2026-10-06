import test from 'node:test'
import assert from 'node:assert/strict'

import { getPontoServerTimestamp } from '../src/lib/ponto.ts'

test('converte o instante do servidor para data e hora de São Paulo', () => {
  const now = new Date('2026-10-06T00:30:00.000Z')

  assert.deepEqual(getPontoServerTimestamp(now), {
    data: '2026-10-05',
    hora: '21:30',
  })
})

test('calcula a data e a hora exclusivamente no servidor', () => {
  const now = new Date('2026-10-06T23:59:00.000Z')
  const timestamp = getPontoServerTimestamp(now)

  assert.deepEqual(timestamp, { data: '2026-10-06', hora: '20:59' })
})
