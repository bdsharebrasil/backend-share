import test from 'node:test'
import assert from 'node:assert/strict'
import {importarAvatarLegado} from '../src/lib/avatarLegado.ts'
test('avatar legado permitido é salvo em R2 e substituído no D1 sem redirect',async t=>{
  const original=fetch;t.after(()=>globalThis.fetch=original);const saved=[];
  globalThis.fetch=async(url,init)=>{assert.equal(init.redirect,'error');return new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}})};
  const bucket={put:async(...args)=>saved.push(args),delete:async()=>{}};
  const db={prepare:sql=>({bind:(key,userId,old)=>({run:async()=>{assert.match(sql,/AND url_avatar = \?3/);assert.equal(userId,'piloto');assert.match(old,/storage/);assert.match(key,/^avatar_profiles\/piloto\//);return {meta:{changes:1}}}})})};
  const result=await importarAvatarLegado(db,bucket,'piloto','https://auth.example/storage/v1/object/public/avatar/a.png','https://auth.example');
  assert.equal(saved.length,1);assert.equal(result.mime,'image/png');assert.equal(result.bytes.length,4);
})
test('recusa host externo e redirecionamento sem acesso à rede interna',async t=>{
  const original=fetch;t.after(()=>globalThis.fetch=original);let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('redirect rejeitado')};
  await assert.rejects(importarAvatarLegado({}, {},'piloto','https://internal.example/storage/v1/object/public/avatar/a.png','https://auth.example'),/origem_avatar/);
  assert.equal(calls,0);
  await assert.rejects(importarAvatarLegado({}, {},'piloto','https://auth.example/storage/v1/object/public/avatar/a.png','https://auth.example'),/redirect/);
})
