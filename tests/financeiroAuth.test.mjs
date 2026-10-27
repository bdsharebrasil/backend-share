import assert from 'node:assert/strict'
import test from 'node:test'
import { autorizarRequisicaoFinanceira } from '../src/financeiro/financeiroAuth.ts'

function contexto(method = 'GET') {
  return {
    req: {
      header(nome) {
        return nome.toLowerCase() === 'authorization' ? 'Bearer dashboard-read-token' : undefined
      },
    },
    env: {
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_ANON_KEY: 'supabase-test-key',
      SHARE_DB: {
        prepare() {
          throw new Error('a consulta do dashboard não deve consultar papéis')
        },
      },
    },
    method,
  }
}

test('usuário autenticado pode consultar o dashboard financeiro sem papel financeiro', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ id: 'user-dashboard' })

  for (const path of ['/api/financeiro/dashboard/financeiro', '/api/financeiro/dashboard/financeiro/movimentacoes']) {
    const acesso = await autorizarRequisicaoFinanceira(contexto(), path, 'GET')
    assert.deepEqual(acesso, { autorizado: true, userId: 'user-dashboard' })
  }
})

test('consulta do dashboard não libera operações financeiras', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ id: 'user-dashboard-write' })
  const db = {
    prepare() {
      return { bind() { return this }, async first() { return null } }
    },
  }
  const c = contexto('POST')
  c.env.SHARE_DB = db
  const acesso = await autorizarRequisicaoFinanceira(c, '/api/financeiro/dashboard/financeiro/movimentacoes', 'POST')
  assert.deepEqual(acesso, { autorizado: false, status: 403 })
})

test('colaborador ativo pode excluir rascunhos, mas não outros recursos por DELETE', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ id: 'user-colaborador' })
  const c = contexto('DELETE')
  c.env.SHARE_DB = {
    prepare(sql) {
      return {
        bind() { return this },
        async first() {
          return sql.includes('SELECT status FROM user_profiles') ? { status: 'ativo' } : null
        },
      }
    },
  }

  const acessoRascunho = await autorizarRequisicaoFinanceira(c, '/api/financeiro/envios-pagamento/rascunhos/rascunho-1', 'DELETE')
  const acessoOutroRecurso = await autorizarRequisicaoFinanceira(c, '/api/financeiro/envios-pagamento/cotistas/cotista-1', 'DELETE')
  assert.deepEqual(acessoRascunho, { autorizado: true, userId: 'user-colaborador' })
  assert.deepEqual(acessoOutroRecurso, { autorizado: false, status: 403 })
})
