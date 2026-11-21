import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { sincronizarDiarioDaPerna } from '../src/lib/diarioAutomatico.ts'

function createDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE aeronave (id TEXT PRIMARY KEY, consumo_combustivel REAL);
    CREATE TABLE tripulacao (id TEXT PRIMARY KEY, user_id TEXT, nome_completo TEXT, canac TEXT);
    CREATE TABLE tripulacao_freelancer (id TEXT PRIMARY KEY, nome_completo TEXT, canac TEXT);
    CREATE TABLE cliente (id TEXT PRIMARY KEY);
    CREATE TABLE holdings (id TEXT PRIMARY KEY);
    CREATE TABLE hold_socios (id TEXT PRIMARY KEY);
    CREATE TABLE solicitacoes_reserva_voo
      (id TEXT PRIMARY KEY, aeronave_id TEXT, cliente_id TEXT, socio_id TEXT,
       numero_voo TEXT, piloto_id TEXT, copiloto_id TEXT);
    CREATE TABLE jornadas_voo
      (id TEXT PRIMARY KEY, solicitacao_id TEXT, data TEXT, horario_apresentacao TEXT);
    CREATE TABLE diario_mes
      (id TEXT PRIMARY KEY, aeronave_id TEXT, ano INTEGER, mes INTEGER, fechado INTEGER DEFAULT 0,
       celula_anterior_ttotal REAL DEFAULT 0, celula_atual_ttotal REAL DEFAULT 0,
       celula_prox_revisao_ttotal REAL DEFAULT 0, celula_disponivel_ttotal REAL DEFAULT 0,
       horimetro_inicio REAL DEFAULT 0, horimetro_final REAL DEFAULT 0, horimetro_ativo REAL DEFAULT 0,
       aerodromo_base TEXT, tarifa_diaria REAL, consumo_combustivel TEXT, tem_tarifa_diaria INTEGER,
       celula_atual_tvoo REAL DEFAULT 0, celula_disponivel_tvoo REAL DEFAULT 0,
       celula_anterior_tvoo REAL DEFAULT 0, celula_prox_revisao_tvoo REAL DEFAULT 0,
       modo_celula TEXT);
    CREATE TABLE lancamentos_diario_bordo (
      id TEXT PRIMARY KEY, diario_mes_id TEXT, numero_sequencial INTEGER, aeronave_id TEXT,
      numero_voo TEXT, jornada_id TEXT, cliente_id TEXT, holding_id TEXT, socio_id TEXT,
      data_registro TEXT, aerodromo_partida TEXT, aerodromo_chegada TEXT, trecho TEXT,
      pic_canac TEXT, pic_nome TEXT, sic_canac TEXT, sic_nome TEXT,
      tripulacao_checkin_hora TEXT, tempo_ac TEXT, tempo_dep TEXT, tempo_pou TEXT, tempo_cor TEXT,
      tempo_voo REAL, tempo_total REAL, tempo_ifr REAL DEFAULT 0, horas_diurnas REAL, horas_noturnas REAL,
      pousos_total INTEGER, passageiros INTEGER, natureza_voo TEXT, consumo_combustivel_voo REAL,
      consumo_combustivel_total REAL, confirmado INTEGER DEFAULT 0, assinado_pic TEXT,
      data_assinatura TEXT, criado_por TEXT, celula REAL, celula_tvoo REAL);
    CREATE TABLE pernas_jornada_voo (
      id TEXT PRIMARY KEY, jornada_id TEXT, numero INTEGER, origem TEXT, destino TEXT,
      horario_ac TEXT, horario_dep TEXT, horario_pouso TEXT, horario_corte TEXT,
      passageiros INTEGER, lancamento_diario_id TEXT REFERENCES lancamentos_diario_bordo(id));
    INSERT INTO aeronave (id, consumo_combustivel) VALUES ('a1', 110);
    INSERT INTO tripulacao VALUES ('pic1','u1','Comandante Teste','123456');
    INSERT INTO tripulacao VALUES ('sic1','u2','Copiloto Teste','654321');
    INSERT INTO cliente VALUES ('cliente1');
    INSERT INTO solicitacoes_reserva_voo VALUES ('sol1','a1','cliente1',NULL,'E-2026-003','pic1','sic1');
    INSERT INTO jornadas_voo VALUES ('j1','sol1','2026-11-21','2026-11-21T09:30:00.000Z');
    INSERT INTO pernas_jornada_voo VALUES ('perna1','j1',1,'SBSP','SBRJ',
      '2026-11-21T10:00:00.000Z',NULL,NULL,NULL,3,NULL);
  `)
  const wrap = (sql) => ({
    bind(...params) { return {
      first: async () => sqlite.prepare(sql).get(...params) || null,
      all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
      run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...params).changes } }),
    } },
  })
  const db = {
    prepare: wrap,
    batch: async (statements) => {
      sqlite.exec('BEGIN')
      try {
        const out = []
        for (const statement of statements) out.push(await statement.run())
        sqlite.exec('COMMIT')
        return out
      } catch (e) { sqlite.exec('ROLLBACK'); throw e }
    },
  }
  return { db, sqlite }
}

test('primeiro AC gera rascunho na aeronave, cliente, competência e rota exatos', async () => {
  const { db, sqlite } = createDb()
  try {
    const result = await sincronizarDiarioDaPerna(db, 'perna1', 'u1')
    assert.equal(result.status, 'rascunho')
    assert.equal(result.lancamento_id, 'perna1')
    const row = sqlite.prepare('SELECT * FROM lancamentos_diario_bordo').get()
    assert.equal(row.numero_voo, 'E-2026-003')
    assert.equal(row.aeronave_id, 'a1')
    assert.equal(row.cliente_id, 'cliente1')
    assert.equal(row.data_registro, '2026-11-21')
    assert.equal(row.aerodromo_partida, 'SBSP')
    assert.equal(row.aerodromo_chegada, 'SBRJ')
    assert.equal(row.pic_canac, '123456')
    assert.equal(row.sic_canac, '654321')
    assert.equal(row.tempo_ac, '10:00')
    assert.equal(row.tempo_dep, null)
    assert.equal(row.confirmado, 0)
    assert.equal(row.assinado_pic, null)
    const month = sqlite.prepare('SELECT aeronave_id, ano, mes, fechado, modo_celula FROM diario_mes').get()
    assert.deepEqual({ ...month }, { aeronave_id: 'a1', ano: 2026, mes: 11, fechado: 0, modo_celula: 'tempo_total' })
    assert.equal(sqlite.prepare('SELECT lancamento_diario_id FROM pernas_jornada_voo').get().lancamento_diario_id, 'perna1')
  } finally { sqlite.close() }
})

test('DEP POU COR atualizam o mesmo rascunho, preservando complementos e impedindo duplicação', async () => {
  const { db, sqlite } = createDb()
  try {
    await sincronizarDiarioDaPerna(db, 'perna1', 'u1')
    sqlite.exec("UPDATE lancamentos_diario_bordo SET natureza_voo = 'EX - Executivo', tempo_ifr = 0.5 WHERE id = 'perna1'")
    sqlite.exec("UPDATE pernas_jornada_voo SET horario_dep='2026-11-21T10:15:00.000Z', horario_pouso='2026-11-21T11:45:00.000Z', horario_corte='2026-11-21T12:00:00.000Z' WHERE id='perna1'")
    const second = await sincronizarDiarioDaPerna(db, 'perna1', 'u2')
    assert.equal(second.status, 'rascunho')
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lancamentos_diario_bordo').get().n, 1)
    const row = sqlite.prepare('SELECT * FROM lancamentos_diario_bordo').get()
    assert.equal(row.tempo_dep, '10:15')
    assert.equal(row.tempo_pou, '11:45')
    assert.equal(row.tempo_cor, '12:00')
    assert.equal(row.tempo_voo, 1.5)
    assert.equal(row.tempo_total, 2)
    assert.equal(row.natureza_voo, 'EX - Executivo')
    assert.equal(row.tempo_ifr, 0.5)
    const month = sqlite.prepare('SELECT celula_atual_ttotal, celula_atual_tvoo FROM diario_mes').get()
    assert.equal(month.celula_atual_ttotal, 2)
    assert.equal(month.celula_atual_tvoo, 1.5)
    await sincronizarDiarioDaPerna(db, 'perna1', 'u2')
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lancamentos_diario_bordo').get().n, 1)
    sqlite.exec("UPDATE lancamentos_diario_bordo SET confirmado=1, assinado_pic='Comandante Teste' WHERE id='perna1'")
    sqlite.exec("UPDATE pernas_jornada_voo SET horario_pouso='2026-11-21T11:55:00.000Z' WHERE id='perna1'")
    const signed = await sincronizarDiarioDaPerna(db, 'perna1', 'u2')
    assert.equal(signed.status, 'assinado')
    assert.equal(sqlite.prepare("SELECT tempo_pou FROM lancamentos_diario_bordo WHERE id='perna1'").get().tempo_pou, '11:45')
  } finally { sqlite.close() }
})

test('sem AC não cria lançamento; mês fechado não recebe rascunho', async () => {
  const { db, sqlite } = createDb()
  try {
    sqlite.exec("UPDATE pernas_jornada_voo SET horario_ac=NULL WHERE id='perna1'")
    assert.equal((await sincronizarDiarioDaPerna(db, 'perna1', 'u1')).status, 'aguardando_ac')
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lancamentos_diario_bordo').get().n, 0)
    sqlite.exec("UPDATE pernas_jornada_voo SET horario_ac='2026-11-21T10:00:00.000Z' WHERE id='perna1'")
    sqlite.exec("INSERT INTO diario_mes(id,aeronave_id,ano,mes,fechado) VALUES('m-fechado','a1',2026,11,1)")
    assert.equal((await sincronizarDiarioDaPerna(db, 'perna1', 'u1')).status, 'mes_fechado')
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lancamentos_diario_bordo').get().n, 0)
  } finally { sqlite.close() }
})

test('rotas exigem PIC autenticado para assinatura e têm proteção contra mudança após assinatura', async () => {
  const routes = await readFile(new URL('../src/routes/diarioTripulacaoRoutes.ts', import.meta.url), 'utf8')
  const jornadas = await readFile(new URL('../src/routes/jornadasRoutes.ts', import.meta.url), 'utf8')
  assert.match(routes, /assinatura_exclusiva_comandante/)
  assert.match(routes, /confirmar_assinatura !== true/)
  assert.match(routes, /assinado_pic_user_id = \?3/)
  assert.match(routes, /UPDATE lancamentos_diario_bordo/)
  assert.match(jornadas, /sincronizarRascunhoSemPerderHorarios/)
  assert.match(jornadas, /diario_ja_assinado/)
})
