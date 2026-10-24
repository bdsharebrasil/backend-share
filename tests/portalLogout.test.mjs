import assert from 'node:assert/strict'
import { test } from 'node:test'
import { portalRoutes } from '../src/routes/portalRoutes.ts'

const secret = 'portal-logout-test-secret'

async function token(nonce) {
  const payload = Buffer.from(JSON.stringify({
    id: 'user-1', login: 'cotista', exp: Math.floor(Date.now() / 1000) + 3600, nonce,
  })).toString('base64url')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))).toString('base64url')
  return `${payload}.${signature}`
}

class FakeD1 {
  revoked = new Map()

  prepare(sql) {
    const db = this
    return {
      values: [],
      bind(...values) { this.values = values; return this },
      async all() {
        return { results: ['cotista_id', 'principal_id', 'permissoes'].map(name => ({ name })) }
      },
      async first() {
        if (sql.includes('FROM portal_sessoes_revogadas')) {
          return db.revoked.has(this.values[0]) ? { token_hash: this.values[0] } : null
        }
        if (sql.includes('FROM user_cliente')) {
          return { id: 'user-1', login: 'cotista', cliente_id: 'cliente-1', socio_id: null }
        }
        return null
      },
      async run() {
        if (sql.startsWith('INSERT INTO portal_sessoes_revogadas')) {
          db.revoked.set(this.values[0], this.values[1])
        }
        return { success: true }
      },
    }
  }
}

test('logout revoga apenas o Bearer utilizado e grava somente o hash', async () => {
  const db = new FakeD1()
  const env = { SHARE_DB: db, CLIENT_SESSION_SECRET: secret }
  const bearer = await token('primeira-sessao')
  const outraSessao = await token('segunda-sessao')
  const chamar = (rota, metodo, valor) => portalRoutes.request(`/api/portal/${rota}`, {
    method: metodo,
    headers: { authorization: `Bearer ${valor}` },
  }, env)

  assert.equal((await chamar('me', 'GET', bearer)).status, 200)
  assert.equal((await chamar('logout', 'POST', bearer)).status, 204)
  assert.equal((await chamar('me', 'GET', bearer)).status, 401)
  assert.equal((await chamar('me', 'GET', outraSessao)).status, 200)
  assert.equal(db.revoked.size, 1)
  assert.ok(!db.revoked.has(bearer), 'o banco não deve armazenar o token bruto')
})

test('logout sem Bearer é recusado', async () => {
  const response = await portalRoutes.request('/api/portal/logout', { method: 'POST' }, {
    SHARE_DB: new FakeD1(),
    CLIENT_SESSION_SECRET: secret,
  })
  assert.equal(response.status, 401)
})
