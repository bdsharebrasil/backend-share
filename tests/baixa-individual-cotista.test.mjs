import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { contextoBaixaCotista, pagamentosContextoBaixa, settleCotista } from '../src/financeiro/FinanceiroKernel.ts';
import { consolidarRateiosLancamentos } from '../src/financeiro/cotistaDashboard.ts';

function banco(comLancamento = true) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE lancamentos (id TEXT PRIMARY KEY, tipo_caixa TEXT, fluxo TEXT, status TEXT, data_pagamento TEXT, pago_diretamente INTEGER, atualizado_em TEXT, aeronave_id TEXT, origem_id TEXT, origem_tipo TEXT, reembolsavel INTEGER);
    CREATE TABLE cotista_aeronave (id TEXT PRIMARY KEY, aeronave_id TEXT);
    CREATE TABLE rateio_despesas (id TEXT PRIMARY KEY, lancamento_id TEXT, cotista_id TEXT, aeronave_id TEXT, valor_rateado_centavos INTEGER, valor_pago_real_centavos INTEGER, status TEXT, data_pagamento TEXT, pago_por TEXT, pago_diretamente INTEGER, atualizado_em TEXT);
    CREATE TABLE rateio_pagamentos (id TEXT PRIMARY KEY, rateio_id TEXT, conta_receber_id TEXT, tipo_pagador TEXT, pagador_cotista_id TEXT, pagador_holding_id TEXT, valor_centavos INTEGER, data_pagamento TEXT, conta_bancaria_id TEXT, comprovante_url TEXT, forma_pagamento TEXT, observacoes TEXT, status TEXT, idempotency_key TEXT UNIQUE, criado_por TEXT);
    CREATE TABLE financeiro_baixa_revisoes (chave TEXT PRIMARY KEY, revisao INTEGER NOT NULL);
    CREATE TABLE contas_areceber (id TEXT, lancamentos_id TEXT, recibos_saida_id TEXT, nf_saida_id TEXT, status TEXT);
    CREATE TABLE reembolsos (conta_receber_id TEXT, lancamento_cliente_id TEXT);
    CREATE TABLE envio_despesas (id TEXT PRIMARY KEY, lancamento_id TEXT, tipo TEXT, tipo_caixa TEXT, descricao TEXT, aeronave_id TEXT, status TEXT, atualizado_em TEXT);
    INSERT INTO cotista_aeronave VALUES ('a','av'), ('b','av');
    INSERT INTO rateio_despesas (id,lancamento_id,cotista_id,aeronave_id,valor_rateado_centavos,valor_pago_real_centavos,status) VALUES ('ra','l','a','av',500000,NULL,'EM_ABERTO'), ('rb','l','b','av',500000,NULL,'EM_ABERTO');
  `);
  if (comLancamento) sqlite.exec("INSERT INTO lancamentos (id,tipo_caixa,fluxo,status,aeronave_id) VALUES ('l','CLIENTE','SAIDA','EM_ABERTO','av')");
  else sqlite.exec("INSERT INTO envio_despesas (id,lancamento_id,tipo,tipo_caixa,aeronave_id,status) VALUES ('envio','l','cliente','CLIENTE','av','EMAIL_ENVIADO')");
  const prepare = (sql, values = []) => ({
    bind(...v) { return prepare(sql,v); },
    async first() { return sqlite.prepare(sql).get(...values) || null; },
    async all() { return {results:sqlite.prepare(sql).all(...values)}; },
    async run() { return sqlite.prepare(sql).run(...values); },
  });
  return { sqlite, prepare, async batch(stmts) { sqlite.exec('BEGIN'); try { const result=[];for(const s of stmts)result.push(await s.run());sqlite.exec('COMMIT');return result; }catch(e){sqlite.exec('ROLLBACK');throw e;} } };
}
const baixa = (cotista, valor=500000, extra={}) => ({pagamentos:[{idempotency_key:`pagamento-${cotista}-${valor}`,tipo_pagador:'COTISTA',pagador_cotista_id:cotista,valor_centavos:valor,data_pagamento:cotista==='a'?'2026-11-01':'2026-11-08',forma_pagamento:'PIX',comprovante_url:`https://documentos.test/${cotista}.pdf`,rateios:[{rateio_id:`r${cotista}`,valor_centavos:valor}],...extra}]});

test('duas baixas diretas têm datas e comprovantes individuais; nulo mantém pai em aberto', async () => {
  const db=banco();
  assert.equal((await contextoBaixaCotista(db,'l')).rateios.length,2);
  await settleCotista(db,'l',baixa('a'),'usuario');
  assert.equal(db.sqlite.prepare("SELECT status FROM lancamentos WHERE id='l'").get().status,'EM_ABERTO');
  assert.equal(db.sqlite.prepare("SELECT status FROM rateio_despesas WHERE id='rb'").get().status,'EM_ABERTO');
  assert.equal(db.sqlite.prepare("SELECT valor_pago_real_centavos FROM rateio_despesas WHERE id='rb'").get().valor_pago_real_centavos,null);
  await settleCotista(db,'l',baixa('b'),'usuario');
  assert.equal(db.sqlite.prepare("SELECT status FROM lancamentos WHERE id='l'").get().status,'PAGO');
  const historico=db.sqlite.prepare('SELECT rateio_id,data_pagamento,comprovante_url FROM rateio_pagamentos ORDER BY rateio_id').all();
  assert.deepEqual(historico.map(r=>({...r})),[{rateio_id:'ra',data_pagamento:'2026-11-01',comprovante_url:'https://documentos.test/a.pdf'},{rateio_id:'rb',data_pagamento:'2026-11-08',comprovante_url:'https://documentos.test/b.pdf'}]);
  const registros = await pagamentosContextoBaixa(db, await contextoBaixaCotista(db,'ra'));
  assert.equal(registros.length,1); assert.equal(registros[0].rateio_id,'ra'); assert.equal(registros[0].comprovante_url,'https://documentos.test/a.pdf');
  assert.equal((await pagamentosContextoBaixa(db, await contextoBaixaCotista(db,'l'))).length,2);
  assert.equal((await settleCotista(db,'l',baixa('b'),'usuario')).idempotent,true);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM rateio_pagamentos').get().n,2);
});

test('pagamento parcial preserva saldo, rejeita excesso e respeita seleção de rateio', async () => {
  const db=banco();await settleCotista(db,'ra',baixa('a',200000),'usuario');
  assert.equal(db.sqlite.prepare("SELECT status FROM rateio_despesas WHERE id='ra'").get().status,'EM_ABERTO');
  await assert.rejects(settleCotista(db,'ra',baixa('a',400000),'usuario'),e=>e.code==='rateio_excedido');
  await assert.rejects(settleCotista(db,'ra',baixa('b'),'usuario'),e=>e.code==='rateio_fora_da_conta');
  await settleCotista(db,'ra',baixa('a',300000),'usuario');
  assert.equal(db.sqlite.prepare("SELECT status FROM lancamentos WHERE id='l'").get().status,'EM_ABERTO');
});

test('envio sem lançamento só conclui após os dois cotistas, inclusive saldo nulo', async () => {
  const db=banco(false);await settleCotista(db,'l',baixa('a'),'usuario');
  assert.equal(db.sqlite.prepare('SELECT status FROM envio_despesas').get().status,'EMAIL_ENVIADO');
  await settleCotista(db,'l',baixa('b'),'usuario');assert.equal(db.sqlite.prepare('SELECT status FROM envio_despesas').get().status,'CONCLUIDO');
});

for(const ordem of [false,true])test(`agrupamento não herda status pago do primeiro cotista (ordem=${ordem})`,()=>{
  const rows=[{id:'a',origem_rateio:'rateio_despesas',lancamento_id:'l',status:'PAGO_DIRETAMENTE',data_pagamento:'2026-11-01',valor_rateado_centavos:500000,valor_pago_real_centavos:500000},{id:'b',origem_rateio:'rateio_despesas',lancamento_id:'l',status:'EM_ABERTO',valor_rateado_centavos:500000,valor_pago_real_centavos:null}];
  if(ordem)rows.reverse();const [grupo]=consolidarRateiosLancamentos(rows);assert.equal(grupo.status,'EM_ABERTO');assert.equal(grupo.data_pagamento,null);assert.equal(grupo.valor_pago_real_centavos,500000);
  rows.forEach(r=>{r.status='PAGO_DIRETAMENTE';r.valor_pago_real_centavos=500000;});assert.equal(consolidarRateiosLancamentos(rows)[0].status,'PAGO');
});

test('duas confirmações concorrentes não baixam a mesma parcela duas vezes', async () => {
  const db=banco();
  const resultados=await Promise.allSettled([settleCotista(db,'l',baixa('a'),'usuario'),settleCotista(db,'l',baixa('a',500000,{idempotency_key:'outra-tentativa'}),'usuario')]);
  assert.equal(resultados.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(resultados.filter(r=>r.status==='rejected').length,1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM rateio_pagamentos').get().n,1);
  assert.equal(db.sqlite.prepare("SELECT status FROM lancamentos WHERE id='l'").get().status,'EM_ABERTO');
});
