import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { validarPontosGps } from '../src/lib/gpsTripulante.ts';
import { rastreioRoutes } from '../src/routes/rastreioRoutes.ts';
const now=Date.now();
const p={id:'gps-1',lat:-15.4,lon:-56.1,registrado_em:new Date(now).toISOString(),precisao_m:10,alt_ft:14000,gs_kt:200,rumo_graus:90};
test('validação rejeita coordenadas, datas, lotes e sensores inválidos sem converter null em zero',()=>{
 assert.equal(validarPontosGps([p],now)[0].lat,-15.4);
 for(const v of [[],Array(101).fill(p),[{...p,lat:null}],[{...p,lat:91}],[{...p,gs_kt:-1}],[{...p,precisao_m:500}],[{...p,registrado_em:new Date(now+120000).toISOString()}],[{...p,registrado_em:new Date(now-8*86400000).toISOString()}]])assert.throws(()=>validarPontosGps(v,now));
});
test('fila GPS é autorizada por voo, idempotente e isolada dos sinais ADS-B',async()=>{
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec("CREATE TABLE solicitacoes_reserva_voo(id TEXT PRIMARY KEY);CREATE TABLE user_profiles(id TEXT PRIMARY KEY);INSERT INTO solicitacoes_reserva_voo VALUES('own');INSERT INTO user_profiles VALUES('u-live')");
 const migration=await readFile(new URL('../migrations/20261122_rastreio_gps_tripulante.sql',import.meta.url),'utf8');sqlite.exec(migration);sqlite.exec(migration);
 const db={prepare(sql){return {bind(...params){return {first:async()=>sql.includes('FROM user_profiles')?{id:'u-live',status:'ATIVO',departamento:'Tripulação',canac:'123',tipo_user:'colaborador'}:sql.includes('FROM solicitacoes_reserva_voo s')?(params[0]==='own'?{ok:1}:null):null,run:async()=>sqlite.prepare(sql).run(...params)}}}},batch:async statements=>{sqlite.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());sqlite.exec('COMMIT');return r}catch(e){sqlite.exec('ROLLBACK');throw e}}};
 const env={SHARE_DB:db,SUPABASE_URL:'https://auth.live.example',SUPABASE_ANON_KEY:'public',RATE_LIMITER:{idFromName:x=>x,get:()=>({fetch:async()=>new Response(JSON.stringify({allowed:true}))})}};
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({id:'u-live'}));
 const headers={Authorization:'Bearer gps-live-test', 'Content-Type':'application/json'};
 const request=(id,body)=>rastreioRoutes.request(`/api/colaborador/meus-voos/${id}/posicoes-gps`,{method:'POST',headers,body:JSON.stringify(body)},env);
 try{
 assert.equal((await rastreioRoutes.request('/api/colaborador/meus-voos/own/posicoes-gps',{method:'POST'},env)).status,401);
 assert.equal((await request('other',{pontos:[p]})).status,403);
 assert.equal((await rastreioRoutes.request('/api/colaborador/meus-voos/other/acompanhamento',{headers},env)).status,403);
 for(let i=0;i<2;i++){const r=await request('own',{pontos:[p]});assert.equal(r.status,200);assert.deepEqual((await r.json()).recebidos,['gps-1'])}
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM rastreio_gps_tripulante').get().n,1);
 assert.equal(sqlite.prepare('SELECT user_id FROM rastreio_gps_tripulante').get().user_id,'u-live');
 assert.equal((await request('own',{pontos:[{...p,lat:'bad'}]})).status,400);
 assert.equal((await request('own',{pontos:[],extra:'x'.repeat(65000)})).status,413);
 }finally{globalThis.fetch=original;sqlite.close()}
});
