import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { requireFlightCrewOrOperationsWriteAccess } from '../src/lib/auth.ts'

let counter = 0
const originalFetch = globalThis.fetch

function context(profile, allowed = []) {
  const token = 'verified-session-' + ++counter
  const calls = []
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              calls.push({ sql, params })
              if (sql.includes('FROM user_profiles')) return profile?.id === params[0] ? profile : null
              if (sql.includes('FROM solicitacoes_reserva_voo s')) {
                return allowed.includes(params[0]) && params[1] === profile?.id ? { ok: 1 } : null
              }
              throw new Error('Unexpected SQL query')
            },
          }
        },
      }
    },
  }
  return {
    calls,
    ctx: {
      req: { header: (name) => name.toLowerCase() === 'authorization' ? 'Bearer ' + token : undefined },
      env: { SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'public-anon', SHARE_DB: db },
    },
  }
}

test('escalado pode operar apenas o próprio voo', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'u-tripulante' }), { status: 200 })
  try {
    const { ctx, calls } = context({ id: 'u-tripulante', canac: '123456', status: 'ATIVO', departamento: 'Tripulação', tipo_user: 'tripulante' }, ['voo-permitido'])
    assert.equal(await requireFlightCrewOrOperationsWriteAccess(ctx, 'voo-permitido'), true)
    assert.equal(await requireFlightCrewOrOperationsWriteAccess(ctx, 'voo-alheio'), false)
    const membership = calls.filter(x => x.sql.includes('FROM solicitacoes_reserva_voo s'))
    assert.equal(membership.length, 2)
    assert.deepEqual(membership[0].params, ['voo-permitido', 'u-tripulante', '123456'])
    assert.match(membership[0].sql, /s\.piloto_id = t\.id OR s\.copiloto_id = t\.id/)
    assert.match(membership[0].sql, /t\.user_id = \?2/)
    assert.match(membership[0].sql, /t\.user_id IS NULL/)
  } finally { globalThis.fetch = originalFetch }
})

test('equipe de operações acessa voos e usuário sem perfil é negado', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'u-operacoes' }), { status: 200 })
  try {
    const manager = context({ id: 'u-operacoes', canac: null, status: 'ATIVO', tipo_user: 'colaborador', departamento: 'Operações' })
    assert.equal(await requireFlightCrewOrOperationsWriteAccess(manager.ctx, 'voo-qualquer'), true)
    const outsider = context({ id: 'u-outro', canac: null, status: 'ATIVO', tipo_user: 'colaborador', departamento: 'Comercial' })
    assert.equal(await requireFlightCrewOrOperationsWriteAccess(outsider.ctx, 'voo-qualquer'), false)
    const missing = context(null)
    assert.equal(await requireFlightCrewOrOperationsWriteAccess(missing.ctx, 'voo-qualquer'), false)
  } finally { globalThis.fetch = originalFetch }
})

test('alterações de jornada e briefing PDF passam pela permissão restrita', async () => {
  const routes = await readFile(new URL('../src/routes/jornadasRoutes.ts', import.meta.url), 'utf8')
  const pdf = await readFile(new URL('../src/preparacao/rotas.ts', import.meta.url), 'utf8')
  const sections = [
    ["jornadasRoutes.post('/api/interno/agendamento/:id/jornada'", "jornadasRoutes.patch('/api/interno/jornadas/:id'"],
    ["jornadasRoutes.patch('/api/interno/jornadas/:id'", "jornadasRoutes.delete('/api/interno/jornadas/:id'"],
    ["jornadasRoutes.post('/api/interno/jornadas/:id/pernas'", "jornadasRoutes.patch('/api/interno/jornadas/:jornadaId/pernas/:pernaId'"],
    ["jornadasRoutes.patch('/api/interno/jornadas/:jornadaId/pernas/:pernaId'", ''],
  ]
  for (const [start, end] of sections) {
    const first = routes.indexOf(start)
    const next = end ? routes.indexOf(end, first + 1) : routes.length
    assert.notEqual(first, -1)
    assert.match(routes.slice(first, next), /requireFlightCrewOrOperationsWriteAccess\(c,/)
  }
  const pdfRoute = pdf.slice(pdf.indexOf("preparacaoRoutes.get(root+'/pdf'"), pdf.indexOf("preparacaoRoutes.post(root+'/reservar-hotel'"))
  assert.match(pdfRoute, /requireFlightCrewOrOperationsWriteAccess\(c, idVoo\(c\)\)/)
  assert.match(pdfRoute, /Content-Type':'application\/pdf/)
})
