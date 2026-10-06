import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { allocateCentsByPercentages } from '../src/financeiro/FinanceiroKernel.ts'

test('distribui R$ 100,01 entre três cotistas sem perder centavo', () => {
  const parcelas = allocateCentsByPercentages(10001, [33.33, 33.33, 33.33])
  assert.deepEqual(parcelas, [3335, 3333, 3333])
  assert.equal(parcelas.reduce((total, valor) => total + valor, 0), 10001)
})

test('aceita soma percentual dentro da tolerância e normaliza em basis points', () => {
  const parcelas = allocateCentsByPercentages(10001, [33.333, 33.333, 33.333])
  assert.equal(parcelas.reduce((total, valor) => total + valor, 0), 10001)
  assert.ok(parcelas.every(Number.isInteger))
})

test('fila distingue FinanceError permanente de falha transitória e agenda backoff', async () => {
  const source = await readFile(new URL('../src/financeiro/FinanceiroKernel.ts', import.meta.url), 'utf8')
  assert.match(source, /const permanent = error instanceof FinanceError/)
  assert.match(source, /status = CASE WHEN \? = 1 OR tentativas >= 5 THEN 'ERRO' ELSE 'PENDENTE'/)
  assert.match(source, /proxima_tentativa_em = CASE WHEN \? = 1 OR tentativas >= 5 THEN NULL ELSE datetime/)
  const migration = await readFile(new URL('../migrations/20261006_financeiro_fila_retry.sql', import.meta.url), 'utf8')
  assert.match(migration, /ADD COLUMN proxima_tentativa_em TEXT/i)
})
