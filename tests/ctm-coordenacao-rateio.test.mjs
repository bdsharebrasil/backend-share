import test from 'node:test'
import assert from 'node:assert/strict'
import { ratear, prever } from '../src/lib/ctmCoordenacao.ts'
const cotas=['a','b','c'].map(id=>({id,nome:id,cliente_id:id,socio_id:null,status:'ATIVO',percentual_sociedade:33.33}))
test('cota fixa preserva centavos com três cotas de 33,33%',()=>{
  const r=ratear({tipo_rateio:'percentual',total_pecas:100},cotas,[])
  assert.deepEqual(r.linhas.map(l=>l.centavos),[3334,3333,3333])
})
test('uso considera apenas duração atribuída e não distribui voos sem identificação',()=>{
  const o={tipo_rateio:'horas',total_pecas:100,relatorio_voo_de:'2026-10-01',relatorio_voo_ate:'2026-10-31'}
  assert.deepEqual(ratear(o,cotas,[{cliente_id:'a',tempo_voo:1},{cliente_id:'b',tempo_voo:3}]).linhas.map(l=>l.centavos),[2500,7500,0])
  assert.ok(ratear(o,cotas,[{tempo_voo:2}]).aviso)
})
test('escolhe a primeira previsão conhecida e preserva ausência de leitura',()=>{
  const r={item:'Inspeção',ultima_execucao_data:'2026-01-31',intervalo_meses:1,intervalo_horas:25,ultima_execucao_horas:100}
  assert.equal(prever(r,false,120,1,'2026-02-01').data,'2026-02-06')
  assert.equal(prever(r,false,null,null,'2026-02-01').data,'2026-02-28')
})

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { ctmRoutes } from '../src/routes/ctmRoutes.ts'
import { modulos } from '../src/lib/ctmCoordenacao.ts'

function ambiente(t) {
  const sqlite=new DatabaseSync(':memory:')
  sqlite.exec("CREATE TABLE aeronave(id TEXT PRIMARY KEY,matricula_registro TEXT); INSERT INTO aeronave VALUES ('a','PT-AAA'),('b','PT-BBB'); CREATE TABLE user_profiles(id TEXT PRIMARY KEY,departamento TEXT,nome_completo TEXT,status TEXT); INSERT INTO user_profiles VALUES ('u','CTM','Coordenação','ATIVO')")
  for(const arq of ['20261124_ctm_coordenacao.sql','20261119_ctm_reports_mobile.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+arq,import.meta.url),'utf8'))
  const prepare=(sql,args=[])=>({bind(...v){return prepare(sql,v)},async first(){return sqlite.prepare(sql).get(...args)||null},async all(){return {results:sqlite.prepare(sql).all(...args)}},async run(){return {meta:sqlite.prepare(sql).run(...args)}}})
  const env={SHARE_DB:{prepare,async batch(stmts){sqlite.exec('BEGIN');try{for(const stmt of stmts)await stmt.run();sqlite.exec('COMMIT')}catch(e){sqlite.exec('ROLLBACK');throw e}}},SUPABASE_URL:'https://auth.example',SUPABASE_ANON_KEY:'teste'}
  t.mock.method(globalThis,'fetch',async()=>Response.json({id:'u'}))
  const req=(path,method='GET',body)=>ctmRoutes.request('/api/ctm/coordenacao'+path,{method,headers:{Authorization:'Bearer teste','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)},env)
  return {sqlite,req}
}
test('aviso do Trip Share mantém autoria, histórico e versão por matrícula',async t=>{
  const {req,sqlite}=ambiente(t)
  sqlite.exec("INSERT INTO ctm_reports_mobile(id,aeronave_id,data_relatorio,descricao,criado_por,criado_por_nome) VALUES ('r','a','2026-11-20','Ruído','u','Piloto')")
  const path='/aeronaves/a/registros/reportes/r'
  for (const [versao,status] of ['in_analysis','in_maintenance','resolved','in_analysis'].entries()) {
    const resp=await req(path,'PATCH',{status,versao,motivo:'Avaliação registrada'})
    assert.equal(resp.status,200,await resp.text())
  }
  assert.equal((await req(path,'PATCH',{status:'resolved',versao:0,motivo:'Versão antiga'})).status,409)
  assert.equal((await req(path.replace('/a/','/b/'),'PATCH',{status:'resolved',versao:4,motivo:'Matrícula incorreta'})).status,404)
  const lista=await (await req('/reportes')).json()
  assert.equal(lista.registros[0].criado_por_nome,'Piloto')
  assert.equal(lista.registros[0].status,'in_analysis')
  assert.equal((await (await req('/aeronaves/a/historico/reportes')).json()).eventos.length,4)
})
test('cadastros criam, atualizam e arquivam com controle de versão',async t=>{
  const {req,sqlite}=ambiente(t)
  for(const [mod,c] of Object.entries(modulos)) sqlite.exec('CREATE TABLE '+c.tabela+'(id TEXT PRIMARY KEY,'+(mod==='pecas'?'':'aeronave_id TEXT,')+c.campos.map(k=>'"'+k+'" TEXT').join(',')+')')
  sqlite.exec("INSERT INTO ctm_ras(id,aeronave_id) VALUES ('ras','a')")
  for(const [mod,c] of Object.entries(modulos)) {
    const op={tipo_manutencao:'PREVENTIVA',tipo_rateio:'percentual',tipo:'AD',status:'pending',categoria:'PREVENTIVA_PROGRAMADA',tipo_controle:'horas',ordem_servico_id:'ras',quantidade:1}
    const dados=Object.fromEntries(c.obrigatorios.map(k=>[k,op[k]??(k.startsWith('data_')?'2026-11-01':'Cadastro')]))
    const path='/aeronaves/a/registros/'+mod
    const criado=await req(path,'POST',{dados})
    assert.equal(criado.status,201,mod+': '+await criado.clone().text())
    const {id}=await criado.json()
    assert.equal((await req(path+'/'+id,'PATCH',{dados,versao:1,motivo:'Conferência'})).status,200)
    assert.equal((await req(path+'/'+id,'DELETE',{versao:1,motivo:'Duplicado'})).status,409)
    assert.equal((await req(path+'/'+id,'DELETE',{versao:2,motivo:'Duplicado'})).status,200)
    assert.equal((await (await req(path)).json()).registros.some(r=>r.id===id),false)
  }
})
