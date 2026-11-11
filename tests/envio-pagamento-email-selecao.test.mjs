import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { destinatariosSelecionadosEmail, reconciliarEmailRascunho } from '../src/financeiro/envioPagamentoEmail.ts';
const dados = { form: { cotista_ids: ['a'] }, envioId: 'envio-existente', cotistasEmail: [{id:'a'},{id:'b'}], statusEmailCotista:{} };
const registros = [{cotista_id:'a',status:'ENVIADO',email_id:'email-confirmado'},{cotista_id:'b',status:'PENDENTE',email_id:null}];

test('um cotista selecionado conclui o e-mail sem exigir os demais da aeronave',()=>{
  assert.deepEqual(destinatariosSelecionadosEmail(dados),['a']);
  const resultado=reconciliarEmailRascunho(JSON.stringify(dados),registros);
  assert.equal(resultado.total,1);assert.equal(resultado.enviados,1);assert.equal(resultado.concluido,true);
  assert.equal(resultado.dados.statusEmailCotista.a,'ENVIADO');assert.equal(resultado.destinatarios.length,1);
});
test('envio_id e um status no JSON não comprovam entrega do e-mail',()=>{
  assert.equal(reconciliarEmailRascunho(dados,[]).concluido,false);
  const resultado=reconciliarEmailRascunho({...dados,statusEmailCotista:{a:'ENVIADO'}},[{cotista_id:'a',status:'FALHOU',email_id:null}]);
  assert.equal(resultado.concluido,false);assert.equal(resultado.enviados,0);assert.equal(resultado.dados.statusEmailCotista.a,'FALHOU');
});
test('múltiplos selecionados permanecem pendentes até a confirmação de todos',()=>{
  const resultado=reconciliarEmailRascunho({...dados,form:{cotista_ids:['a','b']}},registros);
  assert.equal(resultado.total,2);assert.equal(resultado.enviados,1);assert.equal(resultado.concluido,false);
});
test('rascunhos antigos usam os destinatários salvos sem inferir pela aeronave ou pelos anexos',()=>{
  assert.deepEqual(destinatariosSelecionadosEmail({cotistasEmail:[{id:'a'},{id:'a'},{id:'b'}]}),['a','b']);
  assert.deepEqual(destinatariosSelecionadosEmail({form:{cotista_ids:[]},cotistasEmail:[{id:'a'}]}),[]);
});
test('autosave atrasado não reabre um rascunho concluído no banco',()=>{
  const fonte=readFileSync(new URL('../src/financeiro/enviosPagamentoRoutes.ts',import.meta.url),'utf8');
  const sql=fonte.match(/`(UPDATE envio_pagamento_rascunhos SET tipo_envio = \?[\s\S]*?WHERE id = \? AND criado_por = \?)`/)[1];
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE envio_pagamento_rascunhos(id TEXT,criado_por TEXT,tipo_envio TEXT,etapa_atual INTEGER,dados_json TEXT,envio_id TEXT,status TEXT,atualizado_em TEXT);INSERT INTO envio_pagamento_rascunhos(id,criado_por,status)VALUES('r','u','CONCLUIDO')");
  db.prepare(sql).run('reembolso',0,JSON.stringify(dados),'envio-existente','EMAIL_PENDENTE','r','u');
  assert.equal(db.prepare('SELECT status FROM envio_pagamento_rascunhos').get().status,'CONCLUIDO');
});
