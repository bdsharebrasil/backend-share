import assert from 'node:assert/strict'
import test from 'node:test'
import { autorizarRequisicaoFinanceira } from '../src/financeiro/financeiroAuth.ts'

class AuthDatabase {
  constructor({ active = true, finance = false } = {}) {
    this.active = active
    this.finance = finance
    this.bindings = []
  }

  prepare(sql) {
    return {
      bind: (...values) => ({
        first: async () => {
          this.bindings.push(values)
          if (sql.includes('FROM user_profiles p')) return this.finance ? { allowed: 1 } : null
          if (sql.includes('FROM user_profiles')) return this.active ? { active: 1 } : null
          return null
        },
      }),
    }
  }
}

function context(db, authorization = 'Bearer token-validado') {
  return {
    env: { SHARE_DB: db, SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'public-key' },
    req: { header: (name) => name.toLowerCase() === 'authorization' ? authorization : undefined },
  }
}

test('nega token rejeitado pelo endpoint de autenticação Supabase', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ message: 'invalid token' }, { status: 401 })
  t.after(() => { globalThis.fetch = originalFetch })

  const db = new AuthDatabase({ finance: true })
  const result = await autorizarRequisicaoFinanceira(context(db), '/api/financeiro/configuracoes', 'GET')
  assert.deepEqual(result, { autorizado: false, status: 401 })
  assert.equal(db.bindings.length, 0)
})

test('usa o ID retornado pelo Supabase e não o sub decodificado do token', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ id: 'usuario-validado' })
  t.after(() => { globalThis.fetch = originalFetch })

  const db = new AuthDatabase({ finance: true })
  const result = await autorizarRequisicaoFinanceira(context(db, 'Bearer token-com-sub-forjado'), '/api/financeiro/configuracoes', 'GET')
  assert.deepEqual(result, { autorizado: true, userId: 'usuario-validado' })
  assert.equal(db.bindings[0][0], 'usuario-validado')
})

test('exige papel financeiro para rotas de caixa', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ id: 'colaborador' })
  t.after(() => { globalThis.fetch = originalFetch })

  const result = await autorizarRequisicaoFinanceira(context(new AuthDatabase()), '/api/financeiro/contas-apagar', 'GET')
  assert.deepEqual(result, { autorizado: false, status: 403 })
})

test('permite a colaborador ativo submeter a própria solicitação', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ id: 'colaborador' })
  t.after(() => { globalThis.fetch = originalFetch })

  const db = new AuthDatabase({ active: true })
  const result = await autorizarRequisicaoFinanceira(context(db), '/api/financeiro/envios-pagamento', 'POST')
  assert.deepEqual(result, { autorizado: true, userId: 'colaborador' })
})

test('delega autorização da folha para o guard próprio, inclusive na rota base', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ id: 'rh-user' })
  t.after(() => { globalThis.fetch = originalFetch })

  const result = await autorizarRequisicaoFinanceira(context(new AuthDatabase()), '/api/financeiro/pagamentos-folha', 'GET')
  assert.deepEqual(result, { autorizado: true, userId: 'rh-user' })
})