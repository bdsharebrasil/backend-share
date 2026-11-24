import assert from 'node:assert/strict'
import test from 'node:test'
import { autorizarRequisicaoFinanceira } from '../src/financeiro/financeiroAuth.ts'

function contextoAtivo() {
  return {
    req: { header(nome) { return nome.toLowerCase() === 'authorization' ? 'Bearer teste-tripulante' : undefined } },
    env: {
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_ANON_KEY: 'chave-teste',
      SHARE_DB: { prepare(sql) { return { bind() { return this }, async first() { return sql.includes('SELECT status FROM user_profiles') ? { status: 'ativo' } : null } } } },
    },
  }
}

test('usuário autenticado acessa as consultas do relatório, inclusive sem ser tripulante', async (t) => {
  const fetchOriginal = globalThis.fetch
  t.after(() => { globalThis.fetch = fetchOriginal })
  globalThis.fetch = async () => Response.json({ id: 'tripulante-teste' })
  const caminhosPermitidos = [
    ['GET', '/api/financeiro/relatorios-despesa-viagem/opcoes'],
    ['GET', '/api/financeiro/relatorios-despesa-viagem'],
    ['GET', '/api/financeiro/relatorios-despesa-viagem/relatorio-1'],
    ['GET', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/pdf'],
    ['GET', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/anexos/anexo-1/arquivo'],
    ['GET', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/anexos-tripulante/anexo-1/arquivo'],
    ['GET', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/anexos-rejeicao/anexo-1/arquivo'],
    ['GET', '/api/financeiro/relatorios-despesa-viagem/meus-voos'],
    ['GET', '/api/financeiro/relatorios-despesa-viagem/minhas'],
  ]
  for (const [metodo, caminho] of caminhosPermitidos) {
    const acesso = await autorizarRequisicaoFinanceira(contextoAtivo(), caminho, metodo)
    assert.deepEqual(acesso, { autorizado: true, userId: 'tripulante-teste' }, `${metodo} ${caminho}`)
  }
})

test('usuário autenticado não recebe permissões de alteração por causa da leitura', async (t) => {
  const fetchOriginal = globalThis.fetch
  t.after(() => { globalThis.fetch = fetchOriginal })
  globalThis.fetch = async () => Response.json({ id: 'tripulante-teste' })
  for (const [metodo, caminho] of [
    ['PATCH', '/api/financeiro/relatorios-despesa-viagem/relatorio-1'],
    ['POST', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/anexos'],
  ]) {
    const acesso = await autorizarRequisicaoFinanceira(contextoAtivo(), caminho, metodo)
    assert.deepEqual(acesso, { autorizado: false, status: 403 }, `${metodo} ${caminho}`)
  }
})
