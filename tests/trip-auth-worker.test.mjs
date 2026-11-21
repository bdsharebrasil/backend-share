import test from 'node:test'
import assert from 'node:assert/strict'
import {tripAuthRoutes} from '../src/routes/tripAuthRoutes.ts'
const env=(perfil={id:'piloto',status:'ATIVO'},allowed=true)=>({
  SUPABASE_URL:'https://auth.example',SUPABASE_ANON_KEY:'public-configured-key',
  RATE_LIMITER:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json({allowed})})},
  SHARE_DB:{prepare:sql=>({bind:id=>({first:async()=>{assert.match(sql,/user_profiles WHERE id = \?1/);assert.equal(id,'piloto');return perfil}})})},
})
const req=(action,body,headers={})=>new Request(`https://worker.test/api/trip/auth/${action}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
const session=()=>({access_token:'access',refresh_token:'refresh',expires_in:3600,user:{id:'piloto',email:'upstream@example.com',user_metadata:{private:'not returned'}}})
test('login usa provedor configurado somente no servidor e devolve identidade vinculada ao D1',async t=>{
  const original=fetch;t.after(()=>globalThis.fetch=original);let captured;
  globalThis.fetch=async(url,init)=>{captured={url,init};return Response.json(session())};
  const res=await tripAuthRoutes.fetch(req('login',{usuario:' Piloto ',senha:'password'}),env());
  assert.equal(res.status,200);assert.match(res.headers.get('cache-control'),/no-store/);
  assert.equal(captured.url,'https://auth.example/auth/v1/token?grant_type=password');
  assert.deepEqual(JSON.parse(captured.init.body),{email:'piloto@share-brasil.com',password:'password'});
  const body=await res.json();assert.deepEqual(body.user,{id:'piloto'});assert.ok(!JSON.stringify(body).includes('private'));assert.equal(body.access_token,'access');
})
test('refresh renova pelo Worker e aplica cadastro ativo novamente',async t=>{
  const original=fetch;t.after(()=>globalThis.fetch=original);globalThis.fetch=async(url,init)=>{assert.match(url,/grant_type=refresh_token$/);assert.deepEqual(JSON.parse(init.body),{refresh_token:'old'});return Response.json(session())};
  assert.equal((await tripAuthRoutes.fetch(req('refresh',{refresh_token:'old'}),env())).status,200);
  assert.equal((await tripAuthRoutes.fetch(req('refresh',{refresh_token:'old'}),env({id:'piloto',status:'BLOQUEADO'}))).status,403);
  assert.equal((await tripAuthRoutes.fetch(req('refresh',{refresh_token:'old'}),env(null))).status,403);
})
test('credenciais inválidas, erro upstream, limite e corpo grande não expõem detalhes',async t=>{
  const original=fetch;t.after(()=>globalThis.fetch=original);let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({error:'detalhe interno'},{status:400})};
  const invalid=await tripAuthRoutes.fetch(req('login',{usuario:'piloto',senha:'errada'}),env());assert.equal(invalid.status,401);assert.deepEqual(await invalid.json(),{error:'usuario_ou_senha_incorretos'});
  assert.equal((await tripAuthRoutes.fetch(req('login',{usuario:'x@outside.com',senha:'x'}),env())).status,400);
  assert.equal((await tripAuthRoutes.fetch(req('login',{usuario:'piloto',senha:'x'}),env(undefined,false))).status,429);
  assert.equal((await tripAuthRoutes.fetch(req('login',{usuario:'piloto',senha:'x'.repeat(5000)}),env())).status,413);
  assert.equal(calls,1);
  globalThis.fetch=async()=>{throw new Error('rede')};assert.equal((await tripAuthRoutes.fetch(req('refresh',{refresh_token:'token'}),env())).status,503);
})
test('logout revoga somente a sessão corrente e não recebe chave do cliente',async t=>{
  const original=fetch;t.after(()=>globalThis.fetch=original);const seen=[];
  globalThis.fetch=async(url,init)=>{seen.push({url,init});return url.endsWith('/user')?Response.json({id:'piloto'}):new Response(null,{status:204})};
  const res=await tripAuthRoutes.fetch(req('logout',{}, {authorization:'Bearer logout-trip-worker-test'}),env());
  assert.equal(res.status,200);assert.match(seen[1].url,/logout\?scope=local$/);assert.equal(new Headers(seen[1].init.headers).get('authorization'),'Bearer logout-trip-worker-test');
})
