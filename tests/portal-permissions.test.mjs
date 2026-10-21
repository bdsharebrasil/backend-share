import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { portalClienteExtrasRoutes } from '../src/routes/portalClienteExtrasRoutes.ts'
import { portalFeatureForPath, portalHasFeature, portalRoutes } from '../src/routes/portalRoutes.ts'

const usuarioSecundario = (permissoes) => ({ id: 'secundario-1', principal_id: 'principal-1', permissoes })

 test('login principal e configuração não definida mantêm todos os módulos abertos', () => {
  assert.equal(portalHasFeature({ id: 'principal-1', principal_id: null, permissoes: [] }, 'financeiro'), true)
  assert.equal(portalHasFeature(usuarioSecundario(null), 'manutencao'), true)
})

test('acesso secundário só vê módulos explicitamente liberados', () => {
  const user = usuarioSecundario(['financeiro', 'manutencao'])
  assert.equal(portalHasFeature(user, 'financeiro'), true)
  assert.equal(portalHasFeature(user, 'manutencao'), true)
  assert.equal(portalHasFeature(user, 'aeronave'), false)
  assert.equal(portalHasFeature(usuarioSecundario([]), 'agendamento'), false)
})

test('rotas de dados e ações são associadas ao módulo protegido correspondente', () => {
  assert.equal(portalFeatureForPath('/api/portal/disponibilidade'), 'agendamento')
  assert.equal(portalFeatureForPath('/api/portal/solicitacoes/abc'), 'agendamento')
  assert.equal(portalFeatureForPath('/api/portal/diario-bordo'), 'agendamento')
  assert.equal(portalFeatureForPath('/api/portal/financeiro'), 'financeiro')
  assert.equal(portalFeatureForPath('/api/portal/comprovantes'), 'financeiro')
  assert.equal(portalFeatureForPath('/api/portal/aeronave/abc/dashboard'), 'aeronave')
  assert.equal(portalFeatureForPath('/api/portal/manutencao'), 'manutencao')
  assert.equal(portalFeatureForPath('/api/portal/contexto'), null)
})

test('middleware das rotas complementares deixa o endpoint de login seguir sem token', async () => {
  const app = new Hono()
  app.route('/', portalClienteExtrasRoutes)
  app.route('/', portalRoutes)
  const env = {
    RATE_LIMITER: {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }) }),
    },
  }
  const response = await app.request('/api/portal/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, env)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'login_e_senha_obrigatorios' })
})
