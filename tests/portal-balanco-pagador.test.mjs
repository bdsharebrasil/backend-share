import assert from 'node:assert/strict'
import { test } from 'node:test'
import { portalClienteExtrasRoutes } from '../src/routes/portalClienteExtrasRoutes.ts'

const segredo = 'segredo-teste-pagador'
const b64url = bytes => Buffer.from(bytes).toString('base64url')

async function tokenPortal({ cliente_id, socio_id }) {
  const payload = b64url(JSON.stringify({
    id: 'usuario-1',
    login: 'cotista.teste',
    nome_exibicao: 'Cotista Teste',
    url_avatar: null,
    cliente_id,
    socio_id,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const assinatura = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
  return `${payload}.${assinatura}`
}

class FakeD1 {
  constructor(nomePagador, identidade) {
    this.nomePagador = nomePagador
    this.identidade = identidade
    this.queries = []
  }

  prepare(sql) {
    const db = this
    const statement = {
      values: [],
      bind(...values) { this.values = values; return this },
      first: async () => {
        if (sql.includes('FROM portal_sessoes_revogadas')) return null
        if (sql.includes('FROM user_cliente u JOIN cotista_aeronave ca')) {
          return { id: 'cota-1', aeronave_id: 'aeronave-1' }
        }
        if (sql.includes('FROM user_cliente u')) {
          return { id: 'usuario-1', login: 'cotista.teste', ...db.identidade }
        }
        return null
      },
      all: async () => {
        if (sql.includes('pragma_table_info')) {
          return { results: ['cotista_id', 'principal_id', 'permissoes'].map(name => ({ name })) }
        }
        db.queries.push(sql)
        if (sql.includes('FROM abastecimentos ab')) return { results: [{ id: 'abast-1', status: 'PENDENTE' }] }
        return { results: sql.includes('SELECT r.id,') ? [{ id: 'rateio-1', pago_por: db.nomePagador }] : [] }
      },
    }
    return statement
  }
}

async function consultarBalanco({ cliente_id, socio_id }, nomePagador) {
  const db = new FakeD1(nomePagador, { cliente_id, socio_id })
  const token = await tokenPortal({ cliente_id, socio_id })
  const response = await portalClienteExtrasRoutes.request(
    '/api/portal/balanco?meses=2026-10',
    { headers: { Authorization: `Bearer ${token}` } },
    { SHARE_DB: db, CLIENT_SESSION_SECRET: segredo },
  )
  assert.equal(response.status, 200)
  return { body: await response.json(), queries: db.queries }
}

test('balanço de cliente resolve o UUID do pagador para a razão social', async () => {
  const { body, queries } = await consultarBalanco({ cliente_id: 'cliente-1', socio_id: null }, 'Empresa Exemplo Ltda.')
  assert.equal(body.lancamentos[0].pago_por, 'Empresa Exemplo Ltda.')
  assert.ok(queries.some(sql => sql.includes('LEFT JOIN cliente pagador_cliente') && sql.includes('pagador_cliente.razao_social')))
  assert.ok(queries.some(sql => sql.includes('LEFT JOIN cotista_aeronave ca_pagador ON ca_pagador.id = r.pago_por')))
  assert.ok(queries.some(sql => sql.includes('r.cotista_id = ?1 AND r.aeronave_id = ?2')))
  assert.ok(queries.some(sql => sql.includes('substr(r.data_emissao, 1, 7)')))
  assert.equal(body.conciliacao?.status, 'PRELIMINAR')
})

test('balanço de sócio resolve o UUID do pagador para o nome', async () => {
  const { body, queries } = await consultarBalanco({ cliente_id: null, socio_id: 'socio-1' }, 'Sócio Exemplo')
  assert.equal(body.lancamentos[0].pago_por, 'Sócio Exemplo')
  assert.ok(queries.some(sql => sql.includes('LEFT JOIN hold_socios pagador_socio') && sql.includes('pagador_socio.nome')))
  assert.ok(queries.some(sql => sql.includes('LEFT JOIN cotista_aeronave ca_pagador ON ca_pagador.id = r.pago_por')))
})

test('abastecimentos expõe somente os estados PAGO e PENDENTE', async () => {
  const db = new FakeD1('', { cliente_id: 'cliente-1', socio_id: null })
  const token = await tokenPortal({ cliente_id: 'cliente-1', socio_id: null })
  const response = await portalClienteExtrasRoutes.request(
    '/api/portal/abastecimentos?meses=2026-10',
    { headers: { Authorization: `Bearer ${token}` } },
    { SHARE_DB: db, CLIENT_SESSION_SECRET: segredo },
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.abastecimentos[0].status, 'PENDENTE')
  assert.match(db.queries[0], /CASE WHEN UPPER\(TRIM\(COALESCE\(ab\.status, ''\)\)\) IN \('PAGO', 'PAGO_DIRETAMENTE', 'REEMBOLSADO'\) THEN 'PAGO' ELSE 'PENDENTE' END AS status/)
})
