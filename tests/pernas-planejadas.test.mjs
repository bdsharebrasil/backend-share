import test from 'node:test'
import assert from 'node:assert/strict'
import { planejamentoFixture } from './fixtures/planejamentoVooDb.mjs'

const root = '/api/interno/agendamento/solicitacao-teste'
const plano = { data_prevista: '2026-11-24', origem: 'SBGR', destino: 'SBRJ', numero_passageiros: 5, chave_reenvio: 'planejamento-1' }
const ac = { data: '2026-11-24', origem: 'SBGR', destino: 'SBRJ', numero_passageiros: 5,
  horario_acionamento: '2026-11-24T10:00:00Z', horario_apresentacao: '2026-11-24T09:30:00Z' }

async function setup(t) {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ id: 'gestor-teste' })
  t.after(() => { globalThis.fetch = original })
  const fixture = await planejamentoFixture()
  t.after(() => fixture.sqlite.close())
  return fixture
}

test('grava a próxima perna como agendamento confirmado com o número original e sem iniciar jornada', async t => {
  const { sqlite, request } = await setup(t)
  const response = await request('POST', root + '/pernas-planejadas', plano)
  const body = await response.json()
  assert.equal(response.status, 201, JSON.stringify(body))
  assert.equal(body.solicitacao_id, 'solicitacao-teste')
  assert.equal(body.status, 'PLANEJADA')
  assert.equal(body.horario_previsto, null)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM pernas_jornada_voo').get().n, 1)
  const saved = sqlite.prepare('SELECT * FROM solicitacoes_reserva_voo WHERE id = ?').get(body.id)
  assert.equal(saved.solicitacao_origem_id, 'solicitacao-teste')
  assert.equal(saved.status, 'aprovada')
  assert.equal(saved.numero_voo, 'TST-001')
  assert.equal(saved.data_agendada, plano.data_prevista)
  assert.equal(saved.piloto_id, 'p1')
  assert.equal(saved.aprovado_por, 'gestor-teste')
  assert.ok(saved.aprovado_em)
  assert.equal(sqlite.prepare("SELECT status FROM solicitacoes_reserva_voo WHERE id = 'solicitacao-teste'").get().status, 'em_solo')
  const segunda = await request('POST', root + '/pernas-planejadas', { ...plano, data_prevista: '2026-11-25', origem: 'SBRJ', destino: 'SBBH', chave_reenvio: 'planejamento-2' })
  assert.equal(segunda.status, 201)
  assert.equal((await (await request('GET', root + '/pernas-planejadas')).json()).pernas.length, 2)
  const consulta = await request('GET', root + '/jornada')
  assert.equal(consulta.status, 200)
  assert.equal((await consulta.json()).status, 'encerrada')
})

test('reenvio não duplica planejamento e quantidade zero é preservada', async t => {
  const { sqlite, request } = await setup(t)
  const body = { ...plano, numero_passageiros: 0 }
  assert.equal((await request('POST', root + '/pernas-planejadas', body)).status, 201)
  const retry = await request('POST', root + '/pernas-planejadas', body)
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).numero_passageiros, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM solicitacoes_reserva_voo WHERE solicitacao_origem_id IS NOT NULL').get().n, 1)
  assert.equal((await request('POST', root + '/pernas-planejadas', { ...body, destino: 'SBSP' })).status, 409)
})

test('acionamento inicia a jornada e vincula exatamente uma perna ao planejamento original', async t => {
  const { sqlite, request } = await setup(t)
  const planned = await (await request('POST', root + '/pernas-planejadas', plano)).json()
  const response = await request('POST', root + '/jornada', { ...ac, perna_planejada_id: planned.id })
  const body = await response.json()
  assert.equal(response.status, 201, JSON.stringify(body))
  assert.equal(body.solicitacao_id, 'solicitacao-teste')
  assert.equal(body.pernas.length, 1)
  const saved = sqlite.prepare('SELECT * FROM solicitacoes_reserva_voo WHERE id = ?').get(planned.id)
  assert.equal(saved.status, 'acionado')
  assert.equal(saved.id, body.pernas[0].id)
  assert.equal((await request('POST', root + '/jornada', { ...ac, perna_planejada_id: planned.id })).status, 409)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM solicitacoes_reserva_voo').get().n, 2)
})

test('legado sem horários é recusado antes de qualquer escrita em jornadas', async t => {
  const { sqlite, request } = await setup(t)
  const response = await request('POST', root + '/jornada', { data: plano.data_prevista, origem: plano.origem, destino: plano.destino, aguardar_horarios: true })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'planejamento_nao_cria_jornada')
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
})

test('cancelamento retira somente a perna planejada e não altera o histórico operacional', async t => {
  const { sqlite, request } = await setup(t)
  const planned = await (await request('POST', root + '/pernas-planejadas', plano)).json()
  assert.equal((await request('DELETE', root + '/pernas-planejadas/' + planned.id)).status, 200)
  assert.equal((await (await request('GET', root + '/pernas-planejadas')).json()).pernas.length, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
})

test('falha na primeira perna desfaz a jornada inteira e mantém o planejamento pendente', async t => {
  const { sqlite, request } = await setup(t)
  const planned = await (await request('POST', root + '/pernas-planejadas', plano)).json()
  sqlite.exec("CREATE TRIGGER falhar_perna BEFORE INSERT ON pernas_jornada_voo BEGIN SELECT RAISE(ABORT, 'falha simulada'); END")
  const response = await request('POST', root + '/jornada', { ...ac, perna_planejada_id: planned.id })
  assert.equal(response.status, 500)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
  assert.equal(sqlite.prepare('SELECT status FROM solicitacoes_reserva_voo WHERE id = ?').get(planned.id).status, 'aprovada')
})

test('perna planejada pode iniciar na jornada aberta e exige acionamento real', async t => {
  const { sqlite, request } = await setup(t)
  sqlite.exec("UPDATE jornadas_voo SET status = 'em_solo', horario_corte = NULL, horario_pouso = NULL")
  const planned = await (await request('POST', root + '/pernas-planejadas', { ...plano, data_prevista: '2026-11-19' })).json()
  const path = '/api/interno/jornadas/defa1cf1-6043-4aa9-8245-9f6cf7def701/pernas'
  assert.equal((await request('POST', path, { perna_planejada_id: planned.id, horario_programado: '2026-11-19T19:00:00Z' })).status, 400)
  assert.equal(sqlite.prepare('SELECT status FROM solicitacoes_reserva_voo WHERE id = ?').get(planned.id).status, 'aprovada')
  const response = await request('POST', path, { perna_planejada_id: planned.id, horario_ac: '2026-11-19T19:00:00Z' })
  const body = await response.json()
  assert.equal(response.status, 201, JSON.stringify(body))
  assert.equal(body.origem, plano.origem)
  assert.equal(body.destino, plano.destino)
  assert.equal(body.numero_passageiros, plano.numero_passageiros)
  assert.equal(body.numero, 2)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
  assert.equal(planned.id, body.id)
  assert.equal((await request('POST', path, { perna_planejada_id: planned.id, horario_ac: '2026-11-19T19:00:00Z' })).status, 409)
})

test('planejamento de outra solicitação não pode ser iniciado nesta operação', async t => {
  const { sqlite, request } = await setup(t)
  const planned = await (await request('POST', root + '/pernas-planejadas', plano)).json()
  sqlite.exec("INSERT INTO solicitacoes_reserva_voo (id, status) VALUES ('outra-solicitacao', 'em_solo')")
  sqlite.prepare("UPDATE solicitacoes_reserva_voo SET solicitacao_origem_id = 'outra-solicitacao' WHERE id = ?").run(planned.id)
  assert.equal((await request('POST', root + '/jornada', { ...ac, perna_planejada_id: planned.id })).status, 409)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
})

test('o agendamento vinculado não abre jornada independente e acompanha os horários da perna', async t => {
  const { sqlite, request } = await setup(t)
  const planned = await (await request('POST', root + '/pernas-planejadas', plano)).json()
  const independent = await request('POST', '/api/interno/agendamento/' + planned.id + '/jornada', ac)
  assert.equal(independent.status, 409)
  assert.equal((await independent.json()).solicitacao_id, 'solicitacao-teste')
  const started = await request('POST', root + '/jornada', { ...ac, perna_planejada_id: planned.id })
  assert.equal(started.status, 201)
  sqlite.prepare("UPDATE pernas_jornada_voo SET horario_corte = '2026-11-24T12:00:00Z' WHERE id = ?").run(planned.id)
  assert.equal(sqlite.prepare('SELECT status FROM solicitacoes_reserva_voo WHERE id = ?').get(planned.id).status, 'concluida')
})
