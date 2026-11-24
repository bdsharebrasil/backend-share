import test from 'node:test'
import assert from 'node:assert/strict'
import { planejamentoFixture } from './fixtures/planejamentoVooDb.mjs'
import { listarPernasPlanejadas } from '../src/lib/pernasPlanejadas.ts'

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

test('planeja futuras pernas da mesma solicitação sem criar jornada, perna executada ou outra solicitação', async t => {
  const { sqlite, request, db } = await setup(t)
  const response = await request('POST', root + '/pernas-planejadas', plano)
  const body = await response.json()
  assert.equal(response.status, 201, JSON.stringify(body))
  assert.equal(body.solicitacao_id, 'solicitacao-teste')
  assert.equal(body.status, 'PLANEJADA')
  assert.equal(body.horario_previsto, null)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM pernas_jornada_voo').get().n, 1)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM solicitacoes_reserva_voo').get().n, 1)
  assert.equal(sqlite.prepare('SELECT numero_voo FROM solicitacoes_reserva_voo').get().numero_voo, 'TST-001')
  const segunda = await request('POST', root + '/pernas-planejadas', { ...plano, data_prevista: '2026-11-25', origem: 'SBRJ', destino: 'SBBH', chave_reenvio: 'planejamento-2' })
  assert.equal(segunda.status, 201)
  assert.equal((await listarPernasPlanejadas(db, '2026-11-24', '2026-11-25')).length, 2)
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
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM pernas_planejadas_voo').get().n, 1)
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
  const saved = sqlite.prepare('SELECT * FROM pernas_planejadas_voo').get()
  assert.equal(saved.status, 'INICIADA')
  assert.equal(saved.perna_jornada_id, body.pernas[0].id)
  assert.equal((await request('POST', root + '/jornada', { ...ac, perna_planejada_id: planned.id })).status, 409)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM solicitacoes_reserva_voo').get().n, 1)
})

test('legado sem horários é recusado antes de qualquer escrita em jornadas', async t => {
  const { sqlite, request } = await setup(t)
  const response = await request('POST', root + '/jornada', { data: plano.data_prevista, origem: plano.origem, destino: plano.destino, aguardar_horarios: true })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'planejamento_nao_cria_jornada')
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
})

test('cancelamento retira somente a perna planejada e não altera o histórico operacional', async t => {
  const { sqlite, request, db } = await setup(t)
  const planned = await (await request('POST', root + '/pernas-planejadas', plano)).json()
  assert.equal((await request('DELETE', root + '/pernas-planejadas/' + planned.id)).status, 200)
  assert.equal((await listarPernasPlanejadas(db, '2026-11-24', '2026-11-25')).length, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
})

test('falha na primeira perna desfaz a jornada inteira e mantém o planejamento pendente', async t => {
  const { sqlite, request } = await setup(t)
  const planned = await (await request('POST', root + '/pernas-planejadas', plano)).json()
  sqlite.exec("CREATE TRIGGER falhar_perna BEFORE INSERT ON pernas_jornada_voo BEGIN SELECT RAISE(ABORT, 'falha simulada'); END")
  const response = await request('POST', root + '/jornada', { ...ac, perna_planejada_id: planned.id })
  assert.equal(response.status, 500)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
  assert.equal(sqlite.prepare('SELECT status FROM pernas_planejadas_voo').get().status, 'PLANEJADA')
})

test('perna planejada pode iniciar na jornada aberta e exige acionamento real', async t => {
  const { sqlite, request } = await setup(t)
  sqlite.exec("UPDATE jornadas_voo SET status = 'em_solo', horario_corte = NULL, horario_pouso = NULL")
  const planned = await (await request('POST', root + '/pernas-planejadas', { ...plano, data_prevista: '2026-11-19' })).json()
  const path = '/api/interno/jornadas/defa1cf1-6043-4aa9-8245-9f6cf7def701/pernas'
  assert.equal((await request('POST', path, { perna_planejada_id: planned.id, horario_programado: '2026-11-19T19:00:00Z' })).status, 400)
  assert.equal(sqlite.prepare('SELECT status FROM pernas_planejadas_voo').get().status, 'PLANEJADA')
  const response = await request('POST', path, { perna_planejada_id: planned.id, horario_ac: '2026-11-19T19:00:00Z' })
  const body = await response.json()
  assert.equal(response.status, 201, JSON.stringify(body))
  assert.equal(body.origem, plano.origem)
  assert.equal(body.destino, plano.destino)
  assert.equal(body.numero_passageiros, plano.numero_passageiros)
  assert.equal(body.numero, 2)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
  assert.equal(sqlite.prepare('SELECT perna_jornada_id FROM pernas_planejadas_voo').get().perna_jornada_id, body.id)
  assert.equal((await request('POST', path, { perna_planejada_id: planned.id, horario_ac: '2026-11-19T19:00:00Z' })).status, 409)
})

test('planejamento de outra solicitação não pode ser iniciado nesta operação', async t => {
  const { sqlite, request } = await setup(t)
  const planned = await (await request('POST', root + '/pernas-planejadas', plano)).json()
  sqlite.exec("INSERT INTO solicitacoes_reserva_voo (id, status) VALUES ('outra-solicitacao', 'em_solo')")
  sqlite.prepare("UPDATE pernas_planejadas_voo SET solicitacao_id = 'outra-solicitacao' WHERE id = ?").run(planned.id)
  assert.equal((await request('POST', root + '/jornada', { ...ac, perna_planejada_id: planned.id })).status, 409)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jornadas_voo').get().n, 1)
})
