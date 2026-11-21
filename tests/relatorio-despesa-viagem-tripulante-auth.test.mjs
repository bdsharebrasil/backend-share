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

test('colaborador ativo acessa somente os novos caminhos próprios do lançamento de despesas', async (t) => {
  const fetchOriginal = globalThis.fetch
  t.after(() => { globalThis.fetch = fetchOriginal })
  globalThis.fetch = async () => Response.json({ id: 'tripulante-teste' })
  const caminhosPermitidos = [
    ['GET', '/api/financeiro/relatorios-despesa-viagem/meus-voos'],
    ['POST', '/api/financeiro/relatorios-despesa-viagem/iniciar-do-voo'],
    ['POST', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/finalizar'],
    ['GET', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/pdf'],
    ['PUT', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/despesas-tripulante'],
    ['POST', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/anexos-tripulante'],
    ['DELETE', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/anexos-tripulante/anexo-1'],
    ['GET', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/anexos-tripulante/anexo-1/arquivo'],
  ]
  for (const [metodo, caminho] of caminhosPermitidos) {
    const acesso = await autorizarRequisicaoFinanceira(contextoAtivo(), caminho, metodo)
    assert.deepEqual(acesso, { autorizado: true, userId: 'tripulante-teste' }, `${metodo} ${caminho}`)
  }
})

test('a nova permissão não libera rotas financeiras anteriores para colaborador sem papel', async (t) => {
  const fetchOriginal = globalThis.fetch
  t.after(() => { globalThis.fetch = fetchOriginal })
  globalThis.fetch = async () => Response.json({ id: 'tripulante-teste' })
  for (const [metodo, caminho] of [
    ['GET', '/api/financeiro/relatorios-despesa-viagem/relatorio-1'],
    ['PATCH', '/api/financeiro/relatorios-despesa-viagem/relatorio-1'],
    ['POST', '/api/financeiro/relatorios-despesa-viagem/relatorio-1/anexos'],
  ]) {
    const acesso = await autorizarRequisicaoFinanceira(contextoAtivo(), caminho, metodo)
    assert.deepEqual(acesso, { autorizado: false, status: 403 }, `${metodo} ${caminho}`)
  }
})
