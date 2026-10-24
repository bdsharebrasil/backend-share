import assert from 'node:assert/strict'
import { test } from 'node:test'
import { portalClienteExtrasRoutes } from '../src/routes/portalClienteExtrasRoutes.ts'

const segredo = 'segredo-teste-diario'
const b64url = (bytes) => Buffer.from(bytes).toString('base64url')
async function tokenPortal() {
  const payload = b64url(JSON.stringify({
    id: 'usuario-1',
    login: 'cotista.teste',
    nome_exibicao: 'Cotista Teste',
    url_avatar: null,
    cliente_id: 'cliente-1',
    socio_id: null,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const assinatura = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
  return `${payload}.${assinatura}`
}

class FakeD1 {
  prepare(sql) {
    const db = this
    const statement = {
      values: [],
      bind(...values) { this.values = values; return this },
      first: async () => {
        if (sql.includes('FROM portal_sessoes_revogadas')) return null
        if (sql.includes('FROM user_cliente u')) {
          return { id: 'usuario-1', login: 'cotista.teste', cliente_id: 'cliente-1', socio_id: null }
        }
        return null
      },
      all: async () => {
        db.lastSql = sql
        db.lastValues = statement.values
        if (sql.includes('pragma_table_info')) {
          return { results: ['cotista_id', 'principal_id', 'permissoes'].map(name => ({ name })) }
        }
        return { results: [{
          id: 'voo-1',
          data_registro: '2026-10-18',
          aerodromo_partida: 'SBSP',
          aerodromo_chegada: 'SBBH',
          tempo_voo: 1.5,
          tempo_total: 1.6,
          pousos_total: 1,
          matricula_registro: 'PT-ABC',
        }] }
      },
    }
    return statement
  }
}

test('diário lista lançamentos vinculados à aeronave do cotista e mantém o período solicitado', async () => {
  const db = new FakeD1()
  const token = await tokenPortal()
  const response = await portalClienteExtrasRoutes.request(
    '/api/portal/diario-bordo?de=2026-10-01&ate=2026-10-31',
    { headers: { Authorization: `Bearer ${token}` } },
    { SHARE_DB: db, CLIENT_SESSION_SECRET: segredo },
  )

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.de, '2026-10-01')
  assert.equal(body.ate, '2026-10-31')
  assert.equal(body.voos.length, 1)
  assert.equal(body.voos[0].id, 'voo-1')
  assert.match(db.lastSql, /EXISTS\s*\(\s*SELECT 1 FROM cotista_aeronave ca/i)
  assert.match(db.lastSql, /ca\.aeronave_id = l\.aeronave_id\s+AND lower\(trim\(COALESCE\(ca\.status, ''\)\)\) = 'ativo'/)
  assert.deepEqual(db.lastValues, ['cliente-1', null, '2026-10-01', '2026-10-31'])
})
