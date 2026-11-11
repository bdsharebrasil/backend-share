import test from 'node:test'
import assert from 'node:assert/strict'
import { timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { registrarSinal, lerHistorico } from '../src/lib/rastreioHistorico.ts'
import { carregarVoosRastreio, selecionarAgendamentosParaRastreio, rastreioRoutes } from '../src/routes/rastreioRoutes.ts'

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
    CREATE TABLE solicitacoes_reserva_voo (id TEXT, numero_voo TEXT, status TEXT, aeronave_id TEXT, origem TEXT, destino TEXT, data_agendada TEXT, horario_previsto_agendamento TEXT, dias_duracao INTEGER, socio_id TEXT, cliente_id TEXT, piloto_id TEXT, copiloto_id TEXT, criado_em TEXT);
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
    const resposta = await rastreioRoutes.request('/api/interno/solicitacoes/sem-horarios/rastreio', {}, env)
    assert.equal(resposta.status, 401)
  } finally { globalThis.fetch = fetchAnterior; crypto.subtle.timingSafeEqual = igualdadeAnterior; sqlite.close() }
})
