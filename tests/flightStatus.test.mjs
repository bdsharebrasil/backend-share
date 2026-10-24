import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { statusAgendamentoComJornadaSql } from '../src/lib/flightStatus.ts'

function criarBancoStatus() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE solicitacoes_reserva_voo (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE jornadas_voo (
      id TEXT PRIMARY KEY, solicitacao_id TEXT, jornada_principal_id TEXT,
      numero_jornada INTEGER, horario_acionamento TEXT, horario_pouso TEXT,
      criado_em TEXT, status TEXT
    );
    CREATE TABLE pernas_jornada_voo (
      id TEXT PRIMARY KEY, jornada_id TEXT, numero INTEGER,
      horario_ac TEXT, horario_dep TEXT, horario_pouso TEXT, status TEXT
    );
  `)
  return db
}

function faseAtual(db, id = 'sol') {
  const sql = statusAgendamentoComJornadaSql(true)
  return db.prepare(`SELECT ${sql} AS status FROM solicitacoes_reserva_voo s WHERE s.id = ?`).get(id).status
}

test('status efetivo segue a fase da última perna, mesmo com pouso anterior na mesma jornada', () => {
  const db = criarBancoStatus()
  db.exec(`
    INSERT INTO solicitacoes_reserva_voo VALUES ('sol', 'aprovada');
    INSERT INTO jornadas_voo VALUES ('j', 'sol', NULL, 1, '2026-10-24T11:42:00Z', NULL, '2026-10-24T11:00:00Z', 'em_solo');
    INSERT INTO pernas_jornada_voo VALUES ('p1', 'j', 1, '2026-10-24T12:12:00Z', NULL, NULL, 'programada');
  `)
  assert.equal(faseAtual(db), 'acionado')

  db.prepare("UPDATE pernas_jornada_voo SET horario_dep = '2026-10-24T12:20:00Z', status = 'em_voo' WHERE id = 'p1'").run()
  assert.equal(faseAtual(db), 'decolado')

  db.prepare("UPDATE pernas_jornada_voo SET horario_pouso = '2026-10-24T13:00:00Z', status = 'pousado' WHERE id = 'p1'").run()
  assert.equal(faseAtual(db), 'em_solo')

  db.prepare("INSERT INTO pernas_jornada_voo VALUES ('p2', 'j', 2, '2026-10-24T13:30:00Z', NULL, NULL, 'programada')").run()
  assert.equal(faseAtual(db), 'acionado')

  db.prepare("UPDATE solicitacoes_reserva_voo SET status = 'cancelada' WHERE id = 'sol'").run()
  assert.equal(faseAtual(db), 'cancelada')
  db.close()
})

test('fase AC também é derivada do resumo da jornada quando ainda não existe perna associada', () => {
  const db = criarBancoStatus()
  db.exec(`
    INSERT INTO solicitacoes_reserva_voo VALUES ('sol', 'aprovada');
    INSERT INTO jornadas_voo VALUES ('j', 'sol', NULL, 1, '2026-10-24T11:42:00Z', NULL, '2026-10-24T11:00:00Z', 'em_solo');
  `)
  assert.equal(faseAtual(db), 'acionado')
  db.close()
})

test('fallback continua funcionando quando as tabelas de jornada não estão disponíveis', () => {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE solicitacoes_reserva_voo (id TEXT PRIMARY KEY, status TEXT); INSERT INTO solicitacoes_reserva_voo VALUES ('sol', 'aprovada')")
  const sql = statusAgendamentoComJornadaSql(false)
  assert.equal(db.prepare(`SELECT ${sql} AS status FROM solicitacoes_reserva_voo s WHERE s.id = ?`).get('sol').status, 'aprovada')
  db.close()
})
