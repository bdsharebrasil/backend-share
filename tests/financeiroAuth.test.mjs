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

test('qualquer usuário autenticado pode criar envios e manter seus rascunhos', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ id: 'user-inativo' })
  const c = contexto('POST')
  c.env.SHARE_DB = {
    prepare() {
      return { bind() { return this }, async first() { return { status: 'inativo' } } }
    },
  }

  for (const [path, method] of [
    ['/api/financeiro/envios-pagamento', 'POST'],
    ['/api/financeiro/envios-pagamento/anexos', 'POST'],
    ['/api/financeiro/envios-pagamento/rascunhos', 'POST'],
    ['/api/financeiro/envios-pagamento/rascunhos/rascunho-1', 'GET'],
    ['/api/financeiro/envios-pagamento/rascunhos/rascunho-1', 'DELETE'],
  ]) {
    const acesso = await autorizarRequisicaoFinanceira(c, path, method)
    assert.deepEqual(acesso, { autorizado: true, userId: 'user-inativo' }, `${method} ${path}`)
  }
})

test('liberação de criação não permite usuário inativo aprovar ou alterar solicitações', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ id: 'user-inativo-gestao' })
  const c = contexto('POST')
  c.env.SHARE_DB = {
    prepare() {
      return { bind() { return this }, async first() { return null } }
    },
  }

  for (const [path, method] of [
    ['/api/financeiro/envios-pagamento/envio-1/aprovar', 'POST'],
    ['/api/financeiro/envios-pagamento/envio-1', 'PATCH'],
    ['/api/financeiro/envios-pagamento/cotistas/cotista-1', 'DELETE'],
  ]) {
    const acesso = await autorizarRequisicaoFinanceira(c, path, method)
    assert.deepEqual(acesso, { autorizado: false, status: 403 }, `${method} ${path}`)
  }
})

test('criação de envio continua exigindo autenticação', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ message: 'invalid token' }, { status: 401 })

  const acesso = await autorizarRequisicaoFinanceira(contexto('POST'), '/api/financeiro/envios-pagamento', 'POST')
  assert.deepEqual(acesso, { autorizado: false, status: 401 })
})

test('usuário autenticado pode consultar o histórico de envios pessoais', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ id: 'user-historico' })

  const acesso = await autorizarRequisicaoFinanceira(contexto('GET'), '/api/financeiro/envios-pagamento', 'GET')
  assert.deepEqual(acesso, { autorizado: true, userId: 'user-historico' })
})
