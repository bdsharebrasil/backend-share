import { portalBaixasRoutes } from '../src/financeiro/portalBaixasRoutes.ts';
import { parcelasDoRateio } from '../src/financeiro/baixasRateio.ts';
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
    ALTER TABLE rateio_despesas ADD COLUMN baixas_json TEXT NOT NULL DEFAULT '[]';
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
  const historico=db.sqlite.prepare(`SELECT rateio_id,data_pagamento,comprovante_url FROM ${parcelasDoRateio('rateio_despesas')} ORDER BY rateio_id`).all();
  assert.deepEqual(historico.map(r=>({...r})),[{rateio_id:'ra',data_pagamento:'2026-11-01',comprovante_url:'https://documentos.test/a.pdf'},{rateio_id:'rb',data_pagamento:'2026-11-08',comprovante_url:'https://documentos.test/b.pdf'}]);
  const registros = await pagamentosContextoBaixa(db, await contextoBaixaCotista(db,'ra'));
  assert.equal(registros.length,1); assert.equal(registros[0].rateio_id,'ra'); assert.equal(registros[0].comprovante_url,'https://documentos.test/a.pdf');
  assert.equal((await pagamentosContextoBaixa(db, await contextoBaixaCotista(db,'l'))).length,2);
  assert.equal((await settleCotista(db,'l',baixa('b'),'usuario')).idempotent,true);
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${parcelasDoRateio('rateio_despesas')}`).get().n,2);
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
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${parcelasDoRateio('rateio_despesas')}`).get().n,1);
  assert.equal(db.sqlite.prepare("SELECT status FROM lancamentos WHERE id='l'").get().status,'EM_ABERTO');
});

test('complementar um rateio anterior conserva o valor, a data e o pagador originais', async () => {
  const db = banco();
  db.sqlite.exec("UPDATE rateio_despesas SET valor_pago_real_centavos=200000, data_pagamento='2026-10-20', pago_diretamente=1, pago_por='b' WHERE id='ra'");
  await settleCotista(db, 'ra', baixa('a', 300000), 'usuario');
  const parcelas = await pagamentosContextoBaixa(db, await contextoBaixaCotista(db, 'ra'));
  assert.deepEqual(parcelas.map(p => [p.pagador_cotista_id, p.valor_centavos, p.data_pagamento]), [
    ['b', 200000, '2026-10-20'], ['a', 300000, '2026-11-01'],
  ]);
});

test('conferência de comprovante do portal quita só o rateio enviado e aceita repetição', async () => {
  const db = banco();
  db.sqlite.exec(`ALTER TABLE rateio_despesas ADD COLUMN descricao_despesa TEXT;
    ALTER TABLE rateio_despesas ADD COLUMN data_vencimento TEXT;
    ALTER TABLE cotista_aeronave ADD COLUMN cliente_id TEXT;
    ALTER TABLE cotista_aeronave ADD COLUMN socio_id TEXT;
    ALTER TABLE cotista_aeronave ADD COLUMN codigo_cliente TEXT;
    CREATE TABLE cliente(id TEXT, razao_social TEXT);
    CREATE TABLE hold_socios(id TEXT, nome TEXT);
    CREATE TABLE aeronave(id TEXT, matricula_registro TEXT);`);
  const prova = { id: 'prova', status: 'PENDENTE', forma_pagamento: 'COMPROVANTE_PORTAL', valor_centavos: 500000,
    pagador_cotista_id: 'a', comprovante_url: 'portal-cliente/comprovantes/rateio/ra/prova.pdf' };
  db.sqlite.prepare("UPDATE rateio_despesas SET baixas_json=? WHERE id='ra'").run(JSON.stringify([prova]));
  const aprovar = () => portalBaixasRoutes.request('/solicitacoes-baixa-portal/prova/aprovar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data_pagamento: '2026-11-24' }),
  }, { SHARE_DB: db });
  assert.equal((await aprovar()).status, 200);
  assert.equal((await (await aprovar()).json()).idempotent, true);
  const pendentes = await portalBaixasRoutes.request('/solicitacoes-baixa-portal', {}, { SHARE_DB: db });
  assert.deepEqual((await pendentes.json()).solicitacoes, []);
  assert.equal(db.sqlite.prepare("SELECT status FROM rateio_despesas WHERE id='rb'").get().status, 'EM_ABERTO');
  const pagamentos = await pagamentosContextoBaixa(db, await contextoBaixaCotista(db, 'ra'));
  assert.equal(pagamentos.length, 1);
  assert.equal(pagamentos[0].comprovante_url, prova.comprovante_url);
});
