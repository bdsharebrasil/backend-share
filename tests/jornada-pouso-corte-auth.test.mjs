import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { jornadasRoutes } from '../src/routes/jornadasRoutes.ts'

const jornadaId = 'defa1cf1-6043-4aa9-8245-9f6cf7def701'
const pernaId = '00b98947-8c1e-4077-b44f-d444fb39e962'
const payload = {
  numero_passageiros: 5,
  horario_pouso: '2026-11-19T18:37:00.000Z',
  horario_corte: '2026-11-19T18:40:00.000Z',
  tempo_pou: '2026-11-19T18:37:00.000Z',
  tempo_cor: '2026-11-19T18:40:00.000Z',
}

function fixture(funcao = 'Gestor Master', signed = false) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, tipo_user TEXT, status TEXT, departamento TEXT, departamentos_email TEXT, canac TEXT);
    CREATE TABLE usuarios_funcoes (user_id TEXT, funcao TEXT);
    CREATE TABLE tripulacao (id TEXT, user_id TEXT, canac TEXT, nome_completo TEXT);
    CREATE TABLE tripulacao_freelancer (id TEXT, canac TEXT, nome_completo TEXT);
    CREATE TABLE aeronave (id TEXT, consumo_combustivel REAL);
    CREATE TABLE solicitacoes_reserva_voo (id TEXT PRIMARY KEY, status TEXT, piloto_id TEXT, copiloto_id TEXT, atualizado_em TEXT, aeronave_id TEXT, cliente_id TEXT, socio_id TEXT, numero_voo TEXT);
    CREATE TABLE jornadas_voo (id TEXT PRIMARY KEY, solicitacao_id TEXT, aeronave_id TEXT, data TEXT, horario_acionamento TEXT, horario_apresentacao TEXT, horario_decolagem TEXT, horario_pouso TEXT, horario_corte TEXT, tripulante_id TEXT, funcao_tripulante TEXT, jornada_principal_id TEXT, status TEXT, minutos_jornada INTEGER, minutos_pos_corte INTEGER, numero_jornada INTEGER, criado_em TEXT, atualizado_em TEXT);
    CREATE TABLE pernas_jornada_voo (id TEXT PRIMARY KEY, jornada_id TEXT, numero INTEGER, origem TEXT, destino TEXT, horario_programado TEXT, horario_ac TEXT, horario_dep TEXT, horario_pouso TEXT, horario_corte TEXT, horario_ac_user_id TEXT, horario_dep_user_id TEXT, horario_pouso_user_id TEXT, horario_corte_user_id TEXT, passageiros INTEGER, status TEXT, lancamento_diario_id TEXT);
    CREATE TABLE lancamentos_diario_bordo (id TEXT PRIMARY KEY, confirmado INTEGER, assinado_pic TEXT);
    INSERT INTO user_profiles VALUES ('gestor-teste', 'colaborador', 'ATIVO', NULL, NULL, NULL);
    INSERT INTO solicitacoes_reserva_voo (id, status, piloto_id, numero_voo) VALUES ('solicitacao-teste', 'decolado', 'outro-piloto', 'TST-001');
  `)
  sqlite.prepare('INSERT INTO usuarios_funcoes VALUES (?, ?)').run('gestor-teste', funcao)
  sqlite.prepare(`INSERT INTO jornadas_voo (id, solicitacao_id, data, horario_acionamento, horario_apresentacao, status, minutos_pos_corte, numero_jornada)
    VALUES (?, 'solicitacao-teste', '2026-11-19', '2026-11-19T17:00:00.000Z', '2026-11-19T16:30:00.000Z', 'em_rota', 30, 1)`).run(jornadaId)
  sqlite.prepare(`INSERT INTO pernas_jornada_voo (id, jornada_id, numero, origem, destino, horario_ac, horario_dep, passageiros, status, lancamento_diario_id)
    VALUES (?, ?, 1, 'SBBH', 'SBGR', '2026-11-19T17:00:00.000Z', '2026-11-19T17:15:00.000Z', 3, 'em_voo', ?)`).run(pernaId, jornadaId, signed ? 'diario-assinado' : null)
  if (signed) sqlite.exec("INSERT INTO lancamentos_diario_bordo VALUES ('diario-assinado', 1, 'Comandante')")

  const wrap = (sql, params = []) => ({
    bind(...values) { return wrap(sql, values) },
    first: async () => sqlite.prepare(sql).get(...params) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...params).changes } }),
  })
  const env = {
    SUPABASE_URL: 'https://jornada-auth.example', SUPABASE_ANON_KEY: 'public-test-key',
    SHARE_DB: { prepare: wrap, batch: async statements => {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    } },
  }
  const token = `test.${Buffer.from(JSON.stringify({ sub: 'gestor-teste' })).toString('base64url')}.signature`
  const request = (authenticated = true) => jornadasRoutes.request(`/api/interno/jornadas/${jornadaId}/pernas/${pernaId}`, {
    method: 'PATCH', headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, env)
  return { sqlite, request }
}

test('qualquer colaborador autenticado pode salvar pouso e corte sem vínculo com a tripulação', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ id: 'gestor-teste' })
  for (const funcao of ['Administrador', 'Gestor Master', 'financeiro', 'Comercial', 'tripulante', null]) {
    const { sqlite, request } = fixture(funcao)
    t.after(() => sqlite.close())
    const response = await request()
    const body = await response.json()
    assert.equal(response.status, 200, `${funcao}: ${JSON.stringify(body)}`)
    assert.equal(body.horario_pouso, payload.horario_pouso)
    assert.equal(body.horario_corte, payload.horario_corte)
    assert.equal(body.numero_passageiros, 5)
    assert.equal(body.status_agendamento, 'em_solo')
    const perna = sqlite.prepare('SELECT * FROM pernas_jornada_voo WHERE id = ?').get(pernaId)
    assert.equal(perna.horario_pouso_user_id, 'gestor-teste')
    assert.equal(perna.horario_corte_user_id, 'gestor-teste')
    assert.equal(perna.status, 'cortado')
  }
})

test('alteração de horários exige autenticação e não grava requisições anônimas', async t => {
  const { sqlite, request } = fixture('tripulante')
  t.after(() => sqlite.close())
  const response = await request(false)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'internal_auth_required' })
  assert.equal(sqlite.prepare('SELECT horario_pouso FROM pernas_jornada_voo').get().horario_pouso, null)
})

test('administrador continua impedido de alterar horários de diário já assinado', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ id: 'gestor-teste' })
  const { sqlite, request } = fixture('Administrador', true)
  t.after(() => sqlite.close())
  const response = await request()
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'diario_ja_assinado')
  assert.equal(sqlite.prepare('SELECT horario_corte FROM pernas_jornada_voo').get().horario_corte, null)
})
