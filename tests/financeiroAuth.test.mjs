import assert from 'node:assert/strict'
import test from 'node:test'
import { autorizarRequisicaoFinanceira } from '../src/financeiro/financeiroAuth.ts'
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
jwk.kid = 'test-key'; jwk.alg = 'RS256'
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
async function token(userId) {
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })
  const claims = encode({ iss: 'https://auth.example/auth/v1', aud: 'authenticated', sub: userId, email: `${userId}@example.com`, exp: Math.floor(Date.now() / 1000) + 3600 })
  const input = `${header}.${claims}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(input))
  return `${input}.${Buffer.from(signature).toString('base64url')}`
}
class AuthDatabase {
  constructor({ active = true, finance = false } = {}) { this.active = active; this.finance = finance; this.bindings = [] }
  prepare(sql) { return { bind: (...values) => ({ first: async () => { this.bindings.push(values); if (sql.includes('FROM user_profiles p')) return this.finance ? { allowed: 1 } : null; if (sql.includes('FROM user_profiles')) return this.active ? { active: 1 } : null; return null } }) } }
}
async function context(db, userId = 'usuario-validado') {
  const jwt = await token(userId)
  return { env: { SHARE_DB: db, SUPABASE_URL: 'https://auth.example' }, req: { header: (name) => name.toLowerCase() === 'authorization' ? `Bearer ${jwt}` : undefined } }
}
async function withJwks(t, response = Response.json({ keys: [jwk] })) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => response
  t.after(() => { globalThis.fetch = originalFetch })
}
test('nega token sem assinatura/JWKS disponível', async (t) => {
  await withJwks(t, Response.json({ message: 'invalid token' }, { status: 401 }))
  const result = await autorizarRequisicaoFinanceira(await context(new AuthDatabase({ finance: true })), '/api/financeiro/configuracoes', 'GET')
  assert.deepEqual(result, { autorizado: false, status: 401 })
})
test('usa o sub do JWT assinado e não chama /auth/v1/user', async (t) => {
  await withJwks(t)
  const db = new AuthDatabase({ finance: true })
  const result = await autorizarRequisicaoFinanceira(await context(db, 'usuario-validado'), '/api/financeiro/configuracoes', 'GET')
  assert.deepEqual(result, { autorizado: true, userId: 'usuario-validado' })
  assert.equal(db.bindings[0][0], 'usuario-validado')
})
test('exige papel financeiro para rotas de caixa', async (t) => { await withJwks(t); assert.deepEqual(await autorizarRequisicaoFinanceira(await context(new AuthDatabase()), '/api/financeiro/contas-apagar', 'GET'), { autorizado: false, status: 403 }) })
test('permite a colaborador ativo submeter a própria solicitação', async (t) => { await withJwks(t); assert.deepEqual(await autorizarRequisicaoFinanceira(await context(new AuthDatabase({ active: true })), '/api/financeiro/envios-pagamento', 'POST'), { autorizado: true, userId: 'usuario-validado' }) })
test('delega autorização da folha para o guard próprio, inclusive na rota base', async (t) => { await withJwks(t); assert.deepEqual(await autorizarRequisicaoFinanceira(await context(new AuthDatabase()), '/api/financeiro/pagamentos-folha', 'GET'), { autorizado: true, userId: 'usuario-validado' }) })
