import test from 'node:test'
import assert from 'node:assert/strict'
import { timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { registrarSinal, lerHistorico } from '../src/lib/rastreioHistorico.ts'
import { carregarVoosRastreio, selecionarAgendamentosParaRastreio, vooFinalizadoPorCorte, rastreioRoutes } from '../src/routes/rastreioRoutes.ts'

const migration = await readFile(new URL('../migrations/20261111_rastreio_historico.sql', import.meta.url), 'utf8')
function banco() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(migration)
  sqlite.exec(migration) // Migração também funciona com a tabela de posições já existente.
  const db = {
    prepare(sql) {
      const criar = (args = []) => ({
        bind: (...params) => criar(params),
        all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true }),
        first: async () => sqlite.prepare(sql).get(...args) || null,
        run: async () => ({ results: [], success: true, meta: sqlite.prepare(sql).run(...args) }),
      })
      return criar()
    },
    async batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.all())
        sqlite.exec('COMMIT')
        return results
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
  }
  return { sqlite, db }
}
const t0 = Date.parse('2026-11-11T12:00:00Z')
const posicao = { hex: 'ABC123', matricula: 'PT-BIC', lat: -15, lon: -56, alt_ft: 8000, no_solo: false, visto_ha_s: 5, rumo_graus: 120 }

test('salva aparição, perda e retorno com horários do sinal; preserva o trajeto após nova perna e após três dias', async () => {
  const { db, sqlite } = banco()
  await registrarSinal(db, 'voo1', 'voo1', posicao, false, t0)
  await registrarSinal(db, 'voo1', 'voo1', posicao, false, t0 + 1000)
  await registrarSinal(db, 'voo1', 'perna1', { ...posicao, lat: -16 }, false, t0 + 60_000)
  await registrarSinal(db, 'voo1', 'perna1', null, false, t0 + 200_000)
  await registrarSinal(db, 'voo1', 'perna1', null, false, t0 + 210_000)
  await registrarSinal(db, 'voo1', 'perna2', { ...posicao, lat: -17 }, false, t0 + 300_000)
  await registrarSinal(db, 'voo2', 'voo2', { ...posicao, lat: -18 }, false, t0 + 4 * 86400_000)
  const historico = await lerHistorico(db, 'voo1')
  assert.equal(historico.disponivel, true)
  assert.equal(historico.trilha.length, 3)
  assert.deepEqual(historico.trilha.map(p => p.trilha_id), ['voo1', 'perna1', 'perna2'])
  assert.deepEqual(historico.eventos.map(e => e.tipo), ['SINAL_RECEBIDO', 'SINAL_PERDIDO', 'SINAL_RECEBIDO'])
  assert.equal(historico.eventos[0].ocorrido_em, '2026-11-11T11:59:55.000Z')
  assert.equal(historico.eventos[1].ocorrido_em, '2026-11-11T12:00:55.000Z')
  assert.equal(historico.eventos[1].detectado_em, '2026-11-11T12:03:20.000Z')
  assert.equal((await lerHistorico(db, 'voo2')).trilha.length, 1)
  sqlite.close()
})

test('indisponibilidade do provedor não cria perda de sinal nem pouso; solo explícito gera evento separado', async () => {
  const { db, sqlite } = banco()
  await registrarSinal(db, 'voo', 'p', posicao, false, t0)
  await registrarSinal(db, 'voo', 'p', null, true, t0 + 180_000)
  assert.equal((await lerHistorico(db, 'voo')).eventos.length, 1)
  await registrarSinal(db, 'voo', 'p', { ...posicao, no_solo: true }, false, t0 + 60_000)
  const historico = await lerHistorico(db, 'voo')
  assert.deepEqual(historico.eventos.map(e => e.tipo), ['SINAL_RECEBIDO', 'EM_SOLO_ADSB'])
  sqlite.close()
})

test('aeronave compartilhada não duplica o mesmo sinal entre dois agendamentos', () => {
  const itens = [
    { id: 'antigo', aeronave_id: 'a', data_agendada: '2026-11-11', horario_previsto_agendamento: '2026-11-11T08:00:00Z' },
    { id: 'atual', aeronave_id: 'a', data_agendada: '2026-11-11', horario_previsto_agendamento: '2026-11-11T12:00:00Z' },
    { id: 'outra', aeronave_id: 'b', data_agendada: '2026-11-11', horario_previsto_agendamento: null },
  ]
  assert.deepEqual(selecionarAgendamentosParaRastreio(itens, t0).map(i => i.id), ['atual', 'outra'])
})

test('agendamento aprovado sem jornada e sem hex entra ao vivo pela matrícula e mantém histórico depois de encerrado', async () => {
  const { db, sqlite } = banco()
  sqlite.exec(`
    CREATE TABLE solicitacoes_reserva_voo (id TEXT, numero_voo TEXT, status TEXT, excluida_em TEXT, status_antes_exclusao TEXT, aeronave_id TEXT, origem TEXT, destino TEXT, data_agendada TEXT, horario_previsto_agendamento TEXT, dias_duracao INTEGER, socio_id TEXT, cliente_id TEXT, piloto_id TEXT, copiloto_id TEXT, criado_em TEXT);
    CREATE TABLE aeronave (id TEXT, matricula_registro TEXT, modelo TEXT);
    CREATE TABLE hold_socios (id TEXT, nome TEXT);
    CREATE TABLE cliente (id TEXT, razao_social TEXT);
    CREATE TABLE tripulacao (id TEXT, nome_completo TEXT);
    CREATE TABLE tripulacao_freelancer (id TEXT, nome_completo TEXT);
    CREATE TABLE aerodromo (designativo_icao TEXT, coordenadas TEXT);
    INSERT INTO aeronave VALUES ('a', 'PT-ZXY', 'Cheyenne II');
    INSERT INTO solicitacoes_reserva_voo (id, status, aeronave_id, data_agendada, dias_duracao) VALUES ('sem-horarios', 'aprovada', 'a', date('now'), 1);
  `)
  const fetchAnterior = globalThis.fetch
  const igualdadeAnterior = crypto.subtle.timingSafeEqual
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b))
  let consultas = 0
  globalThis.fetch = async () => { consultas++; return Response.json({ ac: [{ hex: 'ABC987', r: 'PTZXY', lat: -15, lon: -56, alt_baro: 8000, seen_pos: 5 }] }) }
  try {
    const env = { SHARE_DB: db, INTERNAL_TOKEN: 'teste-rastreio', RATE_LIMITER: { idFromName: () => 'rastreio', get: () => ({ fetch: async () => Response.json({ allowed: true }) }) } }
    const voos = await carregarVoosRastreio(env)
    assert.equal(voos.length, 1)
    assert.equal(voos[0].status, 'em_voo')
    assert.equal(voos[0].perna_atual, null)
    assert.equal(voos[0].trilha.length, 1)
    assert.equal(voos[0].eventos_rastreio[0].tipo, 'SINAL_RECEBIDO')
    const painel = await rastreioRoutes.request('/api/interno/voos-em-operacao', { headers: { 'x-internal-token': 'teste-rastreio' } }, env)
    assert.equal(painel.status, 200)
    assert.equal((await painel.json()).voos[0].id, 'sem-horarios')
    const mobile = await rastreioRoutes.request('/api/colaborador/meus-voos/sem-horarios/acompanhamento', { headers: { 'x-internal-token': 'teste-rastreio' } }, env)
    assert.equal(mobile.status, 200)
    const live = await mobile.json()
    assert.equal(live.rastreio_status, 'ao_vivo')
    assert.equal(live.rastreio.matricula, 'PTZXY')
    assert.ok(Date.now() - Date.parse(live.observado_em) < 30000)
    sqlite.exec("UPDATE solicitacoes_reserva_voo SET status = 'encerrada'")
    const ended = await rastreioRoutes.request('/api/colaborador/meus-voos/sem-horarios/acompanhamento', { headers: { 'x-internal-token': 'teste-rastreio' } }, env)
    assert.equal((await ended.json()).rastreio, null, 'voo encerrado hoje não recebe sinal de outra operação')
    sqlite.exec("UPDATE solicitacoes_reserva_voo SET status = 'encerrada', data_agendada = '2020-01-01'")
    const antes = consultas
    const [historico] = await carregarVoosRastreio(env, 'sem-horarios')
    assert.equal(historico.status, 'encerrada')
    assert.equal(historico.trilha.length, 1)
    assert.equal(consultas, antes, 'consulta do histórico não depende do provedor')
    const respostaHistorico = await rastreioRoutes.request('/api/interno/solicitacoes/sem-horarios/rastreio', { headers: { 'x-internal-token': 'teste-rastreio' } }, env)
    assert.equal(respostaHistorico.status, 200)
    assert.equal((await respostaHistorico.json()).trilha.length, 1)
    assert.equal((await carregarVoosRastreio(env)).length, 0)
    sqlite.exec("UPDATE solicitacoes_reserva_voo SET status = 'excluida', status_antes_exclusao = 'encerrada', excluida_em = CURRENT_TIMESTAMP, data_agendada = date('now')")
    assert.equal((await carregarVoosRastreio(env)).length, 0, 'solicitações removidas não entram no monitoramento ao vivo')
    const [historicoArquivado] = await carregarVoosRastreio(env, 'sem-horarios')
    assert.equal(historicoArquivado.trilha.length, 1, 'o histórico vinculado permanece disponível por ID')
    const resposta = await rastreioRoutes.request('/api/interno/solicitacoes/sem-horarios/rastreio', {}, env)
    assert.equal(resposta.status, 401)
  } finally { globalThis.fetch = fetchAnterior; crypto.subtle.timingSafeEqual = igualdadeAnterior; sqlite.close() }
})


test('somente o corte da última perna encerra o acompanhamento no painel', () => {
  assert.equal(vooFinalizadoPorCorte([]), false)
  assert.equal(vooFinalizadoPorCorte([{ horario_corte: null, status: 'em_voo' }]), false)
  assert.equal(vooFinalizadoPorCorte([
    { horario_corte: '2026-11-19T12:00:00Z', status: 'cortado' },
    { horario_corte: null, status: 'em_solo' },
  ]), false, 'a próxima perna permanece em acompanhamento')
  assert.equal(vooFinalizadoPorCorte([
    { horario_corte: null, status: 'em_solo' },
    { horario_corte: '2026-11-19T13:30:00Z', status: 'em_solo' },
  ]), true, 'o último corte encerra a exibição')
  assert.equal(vooFinalizadoPorCorte([{ horario_corte: null, status: 'cortado' }]), true)
})

test('painel resolve nome dos autores e deixa de exibir voo cortado, mantendo o histórico', async () => {
  const { db, sqlite } = banco()
  sqlite.exec(`
    CREATE TABLE solicitacoes_reserva_voo (
      id TEXT, numero_voo TEXT, status TEXT, excluida_em TEXT, aeronave_id TEXT,
      origem TEXT, destino TEXT, data_agendada TEXT, horario_previsto_agendamento TEXT,
      dias_duracao INTEGER, socio_id TEXT, cliente_id TEXT, piloto_id TEXT, copiloto_id TEXT, criado_em TEXT
    );
    CREATE TABLE aeronave (id TEXT, matricula_registro TEXT, modelo TEXT);
    CREATE TABLE hold_socios (id TEXT, nome TEXT);
    CREATE TABLE cliente (id TEXT, razao_social TEXT);
    CREATE TABLE tripulacao (id TEXT, nome_completo TEXT);
    CREATE TABLE tripulacao_freelancer (id TEXT, nome_completo TEXT);
    CREATE TABLE aerodromo (designativo_icao TEXT, coordenadas TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, nome_exibicao TEXT, nome_completo TEXT);
    CREATE TABLE jornadas_voo (
      id TEXT, solicitacao_id TEXT, jornada_principal_id TEXT, numero_jornada INTEGER,
      criado_em TEXT, horario_pouso TEXT, horario_acionamento TEXT, status TEXT
    );
    CREATE TABLE pernas_jornada_voo (
      id TEXT, jornada_id TEXT, numero INTEGER, origem TEXT, destino TEXT, status TEXT,
      horario_ac TEXT, horario_dep TEXT, horario_pouso TEXT, horario_corte TEXT,
      horario_ac_user_id TEXT, horario_dep_user_id TEXT, horario_pouso_user_id TEXT, horario_corte_user_id TEXT
    );
    INSERT INTO aeronave VALUES ('a', 'PT-ZXY', 'Cheyenne II');
    INSERT INTO user_profiles VALUES ('u1', 'Carlos', 'Carlos Silva'), ('u2', ' ', 'Maria Souza');
    INSERT INTO solicitacoes_reserva_voo
      (id, numero_voo, status, aeronave_id, data_agendada, dias_duracao, origem, destino)
      VALUES ('voo-com-pernas', 'V-001', 'decolado', 'a', date('now'), 1, 'SIAQ', 'SJ39');
    INSERT INTO jornadas_voo VALUES ('j1', 'voo-com-pernas', NULL, 1, CURRENT_TIMESTAMP, NULL, NULL, 'em_solo');
    INSERT INTO pernas_jornada_voo
      (id, jornada_id, numero, origem, destino, status, horario_ac, horario_dep, horario_pouso, horario_corte, horario_ac_user_id, horario_dep_user_id, horario_pouso_user_id, horario_corte_user_id)
      VALUES
      ('p1', 'j1', 1, 'SIAQ', 'SJ39', 'cortado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'u1', 'u1', 'u1', 'u1'),
      ('p2', 'j1', 2, 'SJ39', 'SIAQ', 'em_solo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, 'u1', 'u2', 'u2', NULL);
  `)
  const fetchAnterior = globalThis.fetch
  const igualdadeAnterior = crypto.subtle.timingSafeEqual
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b))
  globalThis.fetch = async () => Response.json({ ac: [] })
  const env = {
    SHARE_DB: db, INTERNAL_TOKEN: 'teste-rastreio',
    RATE_LIMITER: { idFromName: () => 'rastreio', get: () => ({ fetch: async () => Response.json({ allowed: true }) }) },
  }
  try {
    const painel = await rastreioRoutes.request('/api/interno/voos-em-operacao', { headers: { 'x-internal-token': 'teste-rastreio' } }, env)
    assert.equal(painel.status, 200)
    const { voos } = await painel.json()
    assert.equal(voos.length, 1, 'a perna seguinte aberta mantém o voo no painel')
    assert.equal(voos[0].pernas[1].horario_ac_usuario_nome, 'Carlos')
    assert.equal(voos[0].pernas[1].horario_dep_usuario_nome, 'Maria Souza')
    assert.equal(voos[0].pernas[1].horario_pouso_usuario_nome, 'Maria Souza')

    sqlite.exec("UPDATE pernas_jornada_voo SET horario_corte = CURRENT_TIMESTAMP, horario_corte_user_id = 'u2', status = 'cortado' WHERE id = 'p2'")
    const terminado = await rastreioRoutes.request('/api/interno/voos-em-operacao', { headers: { 'x-internal-token': 'teste-rastreio' } }, env)
    assert.equal(terminado.status, 200)
    assert.equal((await terminado.json()).voos.length, 0, 'o voo cortado não fica no acompanhamento')

    const historico = await rastreioRoutes.request('/api/interno/solicitacoes/voo-com-pernas/rastreio', { headers: { 'x-internal-token': 'teste-rastreio' } }, env)
    assert.equal(historico.status, 200)
    const concluido = await historico.json()
    assert.equal(concluido.pernas.length, 2, 'o histórico preserva as duas pernas')
    assert.ok(concluido.pernas[1].horario_corte)
    assert.equal(concluido.pernas[1].horario_corte_usuario_nome, 'Maria Souza')
  } finally {
    globalThis.fetch = fetchAnterior
    crypto.subtle.timingSafeEqual = igualdadeAnterior
    sqlite.close()
  }
})
