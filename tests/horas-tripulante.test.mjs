import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { PDFDocument } from 'pdf-lib'
import { consultarHoras, filtrosHoras, pdfHoras } from '../src/lib/horasTripulante.ts'
import { diarioTripulacaoRoutes } from '../src/routes/diarioTripulacaoRoutes.ts'

function setup() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE tripulacao (id TEXT, user_id TEXT, canac TEXT);
    CREATE TABLE aeronave (id TEXT, matricula_registro TEXT);
    CREATE TABLE user_profiles (id TEXT, canac TEXT, nome_completo TEXT);
    CREATE TABLE lancamentos_diario_bordo (id TEXT, aeronave_id TEXT, data_registro TEXT, numero_voo TEXT, aerodromo_partida TEXT, aerodromo_chegada TEXT, tempo_voo REAL, tempo_total REAL, confirmado INTEGER, assinado_pic TEXT, pic_canac TEXT, sic_canac TEXT, numero_sequencial INTEGER);
    INSERT INTO tripulacao VALUES ('t1','u1','123'),('t2','u2','456'),('t0','u0',''),('legado',NULL,'789');
    INSERT INTO aeronave VALUES ('a1','PT-AAA'),('a2','PT-BBB');
    INSERT INTO user_profiles VALUES ('u1','123','Piloto Teste');
    INSERT INTO lancamentos_diario_bordo VALUES
      ('r1','a1','2026-11-01','V1','SBSP','SBRJ',1.5,2,0,NULL,'123','456',1),
      ('r2','a1','2026-11-30','V2','SBRJ','SBSP',0.5,1,1,'PIC','t1','456',2),
      ('r3','a2','2026-10-31','V3','SBSP','SBCY',2,3,1,'PIC','456','123',3),
      ('alheio','a2','2026-11-01','V4','SBSP','SBCY',9,10,1,'PIC','456',NULL,4),
      ('vazio','a2','2026-11-01','V5','SBSP','SBCY',9,10,0,NULL,'','',5),
      ('legado','a2','2026-11-01','V6','SBSP','SBCY',1,2,0,NULL,'789',NULL,6);`)
  const db = { prepare(s) { return { bind(...p) { return { all: async () => ({ results: sql.prepare(s).all(...p) }), first: async () => sql.prepare(s).get(...p) || null } } } } }
  return { sql, db }
}

test('soma PIC/SIC uma vez, distingue voo/total e aplica limites inclusivos por data e aeronave', async () => {
  const {sql,db} = setup()
  try {
    const all = await consultarHoras(db, { id:'u1', canac:'123' }, filtrosHoras({}))
    assert.deepEqual(all.resumo, { minutos_voo:240, minutos_totais:360, lancamentos:3, rascunhos:1 })
    assert.equal(all.por_mes.length, 2)
    assert.equal(all.por_aeronave.length, 2)
    const filtered = await consultarHoras(db, { id:'u1', canac:'123' }, filtrosHoras({inicio:'2026-11-01',fim:'2026-11-30',aeronave_id:'a1'}))
    assert.deepEqual(filtered.resumo, { minutos_voo:120, minutos_totais:180, lancamentos:2, rascunhos:1 })
    assert.equal(filtered.aeronaves.length,2)
    assert.deepEqual(filtered.registros.map(r=>r.id),['r2','r1'])
    const empty = await consultarHoras(db, { id:'u1',canac:'123'}, filtrosHoras({inicio:'2027-01-01'}))
    assert.equal(empty.resumo.lancamentos,0)
  } finally { sql.close() }
})

test('vínculo legado funciona, CANAC vazio e CANAC vinculado a outro usuário não ampliam acesso', async () => {
  const {sql,db} = setup()
  try {
    assert.equal((await consultarHoras(db,{id:'u0',canac:''},filtrosHoras({}))).resumo.lancamentos,0)
    assert.equal((await consultarHoras(db,{id:'u3',canac:'789'},filtrosHoras({}))).resumo.lancamentos,1)
    sql.exec("DELETE FROM tripulacao WHERE id = 'legado'")
    assert.equal((await consultarHoras(db,{id:'u3',canac:'789'},filtrosHoras({}))).resumo.lancamentos,1)
    sql.exec("INSERT INTO tripulacao VALUES ('outra','u4','789')")
    assert.equal((await consultarHoras(db,{id:'u3',canac:'789'},filtrosHoras({}))).resumo.lancamentos,0)
    assert.equal((await consultarHoras(db,{id:'intruso',canac:'123'},filtrosHoras({}))).resumo.lancamentos,0)
  } finally { sql.close() }
})

test('datas inválidas ou invertidas são rejeitadas', () => {
  for (const q of [{inicio:'2026-02-30'},{fim:'21/11/2026'},{inicio:'2026-11-30',fim:'2026-11-01'}]) assert.throws(()=>filtrosHoras(q))
})

test('PDF tem paginação para histórico longo e suporta nomes com caracteres fora de WinAnsi', async () => {
  const {sql,db} = setup()
  try {
    const data=await consultarHoras(db,{id:'u1',canac:'123'},filtrosHoras({}))
    data.registros=Array.from({length:120},()=>data.registros[0])
    const bytes=await pdfHoras(data,'Piloto ✈️ de Teste')
    assert.equal(Buffer.from(bytes).subarray(0,5).toString(),'%PDF-')
    const pdf=await PDFDocument.load(bytes)
    assert.ok(pdf.getPageCount()>3)
  } finally { sql.close() }
})

test('rotas de horas e PDF exigem sessão e ignoram usuário arbitrário no filtro', async () => {
  const {sql,db}=setup(); const original=globalThis.fetch
  try {
    const env={SHARE_DB:db,SUPABASE_URL:'https://auth.horas.example',SUPABASE_ANON_KEY:'public'}
    for (const path of ['/api/colaborador/minhas-horas','/api/colaborador/minhas-horas/pdf']) {
      const res=await diarioTripulacaoRoutes.request(path,{},env);assert.equal(res.status,401)
    }
    globalThis.fetch=async()=>new Response(JSON.stringify({id:'u1'}))
    const headers={Authorization:'Bearer horas-test-u1'}
    const result=await diarioTripulacaoRoutes.request('/api/colaborador/minhas-horas?user_id=u2&inicio=2026-11-01',{headers},env)
    assert.equal(result.status,200)
    assert.equal((await result.json()).resumo.minutos_voo,120)
    const invalid=await diarioTripulacaoRoutes.request('/api/colaborador/minhas-horas?fim=bad',{headers},env);assert.equal(invalid.status,400)
    const pdf=await diarioTripulacaoRoutes.request('/api/colaborador/minhas-horas/pdf?inicio=2026-11-01',{headers},env)
    assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf');assert.equal(pdf.headers.get('cache-control'),'private, no-store')
  } finally {sql.close();globalThis.fetch=original}
})
