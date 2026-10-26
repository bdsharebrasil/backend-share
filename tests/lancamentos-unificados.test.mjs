import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalStatus, lancamentosUnificadosRoutes, toCents } from '../src/financeiro/lancamentosUnificadosRoutes.ts'

test('normaliza situação física para o status de negócio sem apagar atraso', () => {
  assert.equal(canonicalStatus('EM_ABERTO', '2026-10-01', '2026-10-26'), 'ATRASADO')
  assert.equal(canonicalStatus('PAGO', '2026-10-01', '2026-10-26'), 'PAGO')
  assert.equal(canonicalStatus('CANCELADO', '2026-10-01', '2026-10-26'), 'CANCELADO')
  assert.equal(canonicalStatus('EM_ABERTO', '2026-10-30', '2026-10-26'), 'PENDENTE')
})

test('converte valores brasileiros e centavos sem aceitar valores inválidos', () => {
  assert.equal(toCents({ valor: '1.234,56' }), 123456)
  assert.equal(toCents({ valor: 12.5 }), 1250)
  assert.equal(toCents({ valor_centavos: 725 }), 725)
  assert.equal(toCents({ valor: '0,00' }), null)
  assert.equal(toCents({ valor: 'invalido' }), null)
})

test('endpoint lista a página solicitada e rejeita filtros inválidos', async () => {
  const queries = []
  const db = {
    prepare(sql) {
      const entry = { sql, params: [] }
      queries.push(entry)
      const statement = {
        bind(...params) { entry.params = params; return this },
        async first() { return { total: 1 } },
        async all() { return { results: [{ id: 'l1', status: 'PENDENTE', data_vencimento: '2099-01-01' }] } },
      }
      return statement
    },
  }
  const ok = await lancamentosUnificadosRoutes.request('/lancamentos-unificados?pagina=2&limite=10&fluxo=SAIDA', {}, { SHARE_DB: db })
  assert.equal(ok.status, 200)
  const payload = await ok.json()
  assert.equal(payload.total, 1)
  assert.equal(payload.pagina, 2)
  assert.equal(payload.por_pagina, 10)
  assert.equal(payload.lancamentos[0].situacao, 'PENDENTE')
  assert.match(queries[1].sql, /LIMIT \? OFFSET \?/)
  assert.deepEqual(queries[1].params, ['SAIDA', 10, 10])

  const invalid = await lancamentosUnificadosRoutes.request('/lancamentos-unificados?fluxo=OUTRO', {}, { SHARE_DB: db })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error, 'fluxo_invalido')
})
