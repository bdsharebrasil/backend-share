import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateReceiptNumber } from '../src/financeiro/reciboAgents.ts'

function sequenceDb(initial = 1) {
  let next = initial
  return {
    prepare(sql) {
      assert.match(sql, /ON CONFLICT\(codigo_cliente, ano\)/)
      return {
        bind(...values) {
          return {
            async first() {
              const number = next
              next += 1
              return { numero: number }
            },
          }
        },
      }
    },
  }
}

test('aloca recibo sem cotista e mantém a sequência', async () => {
  const db = sequenceDb(1)
  assert.equal(await allocateReceiptNumber(db, null, 'share', '2026'), 'REC-SHARE001/26')
  assert.equal(await allocateReceiptNumber(db, null, 'share', '2026'), 'REC-SHARE002/26')
})

test('retorna números distintos em alocações concorrentes', async () => {
  const db = sequenceDb(17)
  const numbers = await Promise.all(Array.from({ length: 20 }, () => allocateReceiptNumber(db, null, 'CLI', '2026')))
  assert.equal(new Set(numbers).size, 20)
  assert.equal(numbers[0], 'REC-CLI017/26')
  assert.equal(numbers.at(-1), 'REC-CLI036/26')
})
