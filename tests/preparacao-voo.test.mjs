import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const temp=await mkdtemp(path.join((await import('node:os')).tmpdir(),'preparacao-voo-'));
after(()=>rm(temp,{recursive:true,force:true}));
const out=path.join(temp,'rotas.mjs');
await build({stdin:{contents:"export {preparacaoRoutes} from './rotas';export {hospedagensDoVoo} from './hospedagens';",resolveDir:new URL('../src/preparacao/',import.meta.url).pathname},outfile:out,bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'ambiente-teste',setup(b){
 b.onResolve({filter:/^pdf-lib$/},()=>({path:require.resolve('pdf-lib/dist/pdf-lib.esm.js')}));
 b.onResolve({filter:/^hono$/},()=>({path:'hono',namespace:'teste'}));
 b.onLoad({filter:/.*/,namespace:'teste'},()=>({contents:`export class Hono{routes=[];error;get(p,f){this.routes.push({method:'GET',p,f});return this;}post(p,f){this.routes.push({method:'POST',p,f});return this;}onError(f){this.error=f;return this;}}`}));
 b.onResolve({filter:/\/lib\/auth$/},()=>({path:'auth',namespace:'auth'}));b.onLoad({filter:/.*/,namespace:'auth'},()=>({contents:`export const authenticatedColaborador=async c=>c.testUser;export const requireFlightOperationAccess=async c=>Boolean(c.testUser);`}));
 b.onResolve({filter:/\/lib\/storage$/},()=>({path:'storage',namespace:'storage'}));b.onLoad({filter:/.*/,namespace:'storage'},()=>({contents:`export const salvarArquivoShareBrasil=async(c,u,f,p)=>{let key=p+'/'+crypto.randomUUID();c.env.bucket.set(key,{body:await f.arrayBuffer()});return key;};export const shareBrasilBucket=c=>({get:async k=>c.env.bucket.get(k),delete:async k=>c.env.bucket.delete(k)});`}));
}}]});
const {preparacaoRoutes:router,hospedagensDoVoo}=await import(out);
const root='/api/interno/agendamento/:id/preparacao';
const migration=await readFile(new URL('../migrations/20261118_preparacao_voo.sql',import.meta.url),'utf8');
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE solicitacoes_reserva_voo(id TEXT PRIMARY KEY,numero_voo TEXT,aeronave_id TEXT,piloto_id TEXT,copiloto_id TEXT,origem TEXT,destino TEXT,data_agendada TEXT,horario_previsto_agendamento TEXT,dias_duracao INT,numero_passageiros INT,status TEXT,cliente_id TEXT,socio_id TEXT,voo_emprestado TEXT);
 CREATE TABLE aeronave(id TEXT,matricula_registro TEXT,modelo TEXT);CREATE TABLE tripulacao(id TEXT,nome_completo TEXT);CREATE TABLE tripulacao_freelancer(id TEXT,nome_completo TEXT);
 CREATE TABLE checklists_pre_voo(id TEXT PRIMARY KEY,solicitacao_id TEXT,aeronave_id TEXT,respostas TEXT,nivel_oleo TEXT,observacoes TEXT,executado_por TEXT,executado_por_nome TEXT,status TEXT,concluido_em TEXT,criado_em TEXT,atualizado_em TEXT,numero_voo TEXT,criado_por TEXT,abastecimento_id TEXT);
 CREATE TABLE hoteis(id TEXT PRIMARY KEY,nome TEXT,email TEXT,email_comercial TEXT,cafe_manha TEXT,telefone TEXT,telefone_reservas TEXT,endereco TEXT,cidade TEXT,uf TEXT,preco_single REAL,preco_duplo REAL,convenio INT,observacoes TEXT);
 CREATE TABLE agenda_contatos_fornecedores(id TEXT PRIMARY KEY,empresa TEXT,nome_contato_responsavel TEXT,telefone TEXT,email TEXT,endereco TEXT,cidade TEXT,uf TEXT,codigo_icao TEXT,categoria TEXT,gpu TEXT,transfer TEXT,valor_gpu TEXT,valor_transfer TEXT,ar_condicionado TEXT,pernoite TEXT,atendimento_pista TEXT,observacoes TEXT);
 CREATE TABLE fornecedores_combustivel(id TEXT PRIMARY KEY,nome_fornecedor TEXT,nome_cidade TEXT,codigo_icao TEXT,pessoa_contato TEXT,telefone TEXT,preco_jet REAL,preco_avgas REAL);
 CREATE TABLE fornecedores_favoritos(id TEXT PRIMARY KEY,nome_completo TEXT,cidade TEXT,codigo_icao TEXT,pessoa_contato TEXT,telefone TEXT,preco_jet REAL,preco_avgas REAL);
 CREATE TABLE aerodromo(id TEXT PRIMARY KEY,designativo_icao TEXT);
 CREATE TABLE abastecimentos(id TEXT PRIMARY KEY,cliente_id TEXT,socio_id TEXT,aeronave_id TEXT,data TEXT,tipo_combustivel TEXT,trecho TEXT,local TEXT,numero_comanda TEXT,numero_nf TEXT,litros REAL,valor_unitario REAL,valor_total REAL,desconto REAL,fornecedor_id TEXT,status TEXT,criado_por TEXT,voo_emprestado INT,numero_voo TEXT,lancamento_diario_id TEXT);
 CREATE TABLE lancamentos_diario_bordo(id TEXT,cliente_id TEXT,socio_id TEXT,aeronave_id TEXT,data_registro TEXT,aerodromo_partida TEXT,aerodromo_chegada TEXT,numero_sequencial INT);
 CREATE TABLE user_profiles(id TEXT,status TEXT,tipo_user TEXT,departamento TEXT);CREATE TABLE usuarios_funcoes(user_id TEXT,funcao TEXT);CREATE TABLE notificacoes(id TEXT,id_from TEXT,departamento_destinatario TEXT,status TEXT,mensagem TEXT);
 CREATE TABLE reservas_hoteis(id TEXT PRIMARY KEY,hotel_id TEXT,criado_por TEXT,data_checkin TEXT,data_checkout TEXT,tipo_quarto TEXT,quantidade_hospedes INT,hospede_nome TEXT,hospede_telefone TEXT,hospede_email TEXT,observacoes TEXT,destinatario_email TEXT,status TEXT,criado_em TEXT DEFAULT CURRENT_TIMESTAMP);`);
 db.exec(migration);db.exec(migration);
 db.prepare('INSERT INTO solicitacoes_reserva_voo(id,numero_voo,aeronave_id,origem,destino,data_agendada,dias_duracao,numero_passageiros,status,piloto_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run('voo1','SB-001','a1','SBCY','SBIL','2026-11-18',3,4,'aprovada','t1');
 db.exec("INSERT INTO aeronave VALUES('a1','PT-ABC','Modelo');INSERT INTO tripulacao VALUES('t1','Piloto Teste');INSERT INTO hoteis(id,nome,email,cafe_manha,preco_single) VALUES('h1','Hotel Teste','reservas@example.test','SIM',200);INSERT INTO aerodromo VALUES('aer','SBIL');INSERT INTO fornecedores_combustivel(id,nome_fornecedor,codigo_icao) VALUES('f1','Fornecedor Teste','SBIL');");
 const bucket=new Map();
 const adapter={prepare(sql){let values=[];const stmt={bind(...v){values=v;return stmt;},async first(){return db.prepare(sql).get(...values)||null;},async all(){return{results:db.prepare(sql).all(...values)};},async run(){const r=db.prepare(sql).run(...values);return{meta:{changes:r.changes}};}};return stmt;},async batch(cmds){db.exec('BEGIN');try{const r=[];for(const cmd of cmds)r.push(await cmd.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
 async function call(method,suffix='',body={},extra={}){
  const route=router.routes.find(r=>r.method===method&&r.p===root+suffix);assert.ok(route,`${method} ${suffix}`);
  const c={env:{SHARE_DB:adapter,RESEND_API_KEY:'fake',EMAIL_FROM:'Share <teste@example.test>',bucket},testUser:{id:'coord',nome_completo:'Coordenação'},req:{param:k=>k==='id'?'voo1':extra.anexo,json:async()=>body,query:k=>k==='versao'?String(extra.versao):undefined,formData:async()=>body},json:(body,status=200)=>({body,status}),notFound:()=>({status:404}),...extra};
  try{return await route.f(c);}catch(e){return router.error(e,c);}
 }
 return{db,adapter,call,bucket,close:()=>db.close()};
}
test('conclui com todos os itens pendentes, preserva motivos e libera contrato legado sem gerar gastos',async()=>{
 const t=setup();try{const r=await t.call('GET');assert.equal(r.status,200);const dados=r.body.dados;dados.itens.plano_voo.observacao='Aguardando protocolo';const result=await t.call('POST','/concluir',{versao:0,dados});assert.equal(result.status,200);assert.ok(result.body.resumo.pendencias>0);assert.ok(result.body.finalizado_em);assert.equal(result.body.dados.itens.plano_voo.responsavel,'Coordenação');assert.equal(t.db.prepare('SELECT status FROM checklists_pre_voo').get().status,'concluido');assert.equal(t.db.prepare('SELECT count(*) n FROM abastecimentos').get().n,0);assert.equal(t.db.prepare('SELECT count(*) n FROM preparacao_voo_versoes').get().n,1);}finally{t.close();}
});
test('conflito de versão não sobrescreve edição nem duplica histórico',async()=>{
 const t=setup();try{const {dados}= (await t.call('GET')).body;assert.equal((await t.call('POST','',{versao:0,dados})).status,200);dados.observacoes='Outro editor';assert.equal((await t.call('POST','',{versao:0,dados})).status,409);assert.equal(t.db.prepare('SELECT count(*) n FROM preparacao_voo_versoes').get().n,1);assert.equal(JSON.parse(t.db.prepare('SELECT dados_json FROM preparacoes_voo').get().dados_json).observacoes,'');}finally{t.close();}
});
test('serviços sem informação e café legado não são tratados como confirmados',async()=>{
 const t=setup();try{const r=await t.call('GET','/opcoes');assert.equal(r.body.hoteis[0].cafe.estado,'A_CONFIRMAR');const base=(await t.call('GET')).body;assert.ok(base.dados.escalas.every(e=>e.servicos.every(s=>s.estado==='PENDENTE')));}finally{t.close();}
});
test('edição após conclusão cria nova versão e preserva o snapshot anterior',async()=>{
 const t=setup();try{let r=(await t.call('GET')).body;const antigo=await t.call('POST','/concluir',{versao:0,dados:r.dados});r=antigo.body;r.dados.itens.reservas.estado='CONCLUIDO';r.dados.itens.reservas.observacao='Hotel respondeu';assert.equal((await t.call('POST','',{versao:r.versao,dados:r.dados})).status,200);const rows=t.db.prepare('SELECT * FROM preparacao_voo_versoes ORDER BY versao').all();assert.equal(rows.length,2);assert.equal(JSON.parse(rows[0].snapshot_json).dados.itens.reservas.estado,'PENDENTE');assert.equal(JSON.parse(rows[1].snapshot_json).dados.itens.reservas.estado,'CONCLUIDO');}finally{t.close();}
});
test('reserva envia e-mail uma vez, mantém situação pendente e vincula o voo independente do usuário',async()=>{
 const t=setup(),original=globalThis.fetch;let emails=[];globalThis.fetch=async(url,init)=>{emails.push(JSON.parse(init.body));assert.ok(init.headers['Idempotency-Key']);return new Response('{}',{status:200});};try{
  let r=(await t.call('GET')).body;let hotel=r.dados.escalas[1].servicos.find(s=>s.tipo==='HOTEL');hotel.cadastro_id='h1';hotel.dados={checkin:'2026-11-18',checkout:'2026-11-20',hospedes:'Piloto Teste',telefone_hospede:'65999999999',cafe_estado:'A_PARTE',cafe_valor:'25',quartos:'1'};
  r=(await t.call('POST','',{versao:0,dados:r.dados})).body;
  const payload={versao:r.versao,escala_id:'e2',servico_id:'e2:HOTEL',requisicao_id:'uuid-teste-1234'};
  assert.equal((await t.call('POST','/reservar-hotel',payload)).status,201);assert.equal((await t.call('POST','/reservar-hotel',payload)).status,200);assert.equal((await t.call('POST','/reservar-hotel',{...payload,requisicao_id:'outra-coordenacao-123'})).status,200);assert.equal(emails.length,1);assert.match(emails[0].html,/Pago à parte/);assert.match(emails[0].html,/25/);assert.equal(t.db.prepare('SELECT status FROM reservas_hoteis').get().status,'SOLICITADA');assert.equal(t.db.prepare('SELECT solicitacao_id FROM preparacao_voo_reservas').get().solicitacao_id,'voo1');
 }finally{globalThis.fetch=original;t.close();}
});
test('falha no envio não aparece como reserva confirmada e preserva requisição para repetição',async()=>{
 const t=setup(),old=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:502});try{let r=(await t.call('GET')).body;const s=r.dados.escalas[0].servicos.find(s=>s.tipo==='HOTEL');s.cadastro_id='h1';s.dados={checkin:'2026-11-18',checkout:'2026-11-20',hospedes:'Piloto',telefone_hospede:'123'};r=(await t.call('POST','',{versao:0,dados:r.dados})).body;const b={versao:r.versao,escala_id:'e1',servico_id:'e1:HOTEL',requisicao_id:'uuid-teste-5678'};assert.equal((await t.call('POST','/reservar-hotel',b)).status,502);assert.equal(t.db.prepare('SELECT status FROM preparacao_voo_reservas').get().status,'FALHA');assert.equal(t.db.prepare('SELECT count(*) n FROM reservas_hoteis').get().n,0);globalThis.fetch=async()=>new Response('{}');assert.equal((await t.call('POST','/reservar-hotel',b)).status,201);}finally{globalThis.fetch=old;t.close();}
});
test('abastecimento só é criado em ação explícita e repetição não duplica despesa',async()=>{
 const t=setup();try{const dados=(await t.call('GET')).body.dados;dados.escalas[1].servicos[0].dados={litros:'500',cotacao:'9.60'};await t.call('POST','/concluir',{versao:0,dados});assert.equal(t.db.prepare('SELECT count(*) n FROM abastecimentos').get().n,0);const b={escala_id:'e2',data:'2026-11-18',tipo_combustivel:'Jet A-1',litros:500,valor_unitario:9.6,fornecedor_id:'f1'};const a=await t.call('POST','/abastecimento-realizado',b),c=await t.call('POST','/abastecimento-realizado',b);assert.equal(a.status,201);assert.equal(a.body.id,c.body.id);assert.equal(t.db.prepare('SELECT count(*) n FROM abastecimentos').get().n,1);assert.equal(t.db.prepare('SELECT valor_total FROM abastecimentos').get().valor_total,4800);}finally{t.close();}
});
test('PDF é real e versão anterior mantém snapshot após atualizar hotel',async()=>{
 const t=setup();try{const d=(await t.call('GET')).body.dados;d.escalas[0].servicos.find(s=>s.tipo==='HOTEL').dados={nome:'Hotel Inicial',cafe_estado:'A_PARTE',cafe_valor:'30'};let r=(await t.call('POST','/concluir',{versao:0,dados:d})).body;const versao=(await t.call('POST','/emitir',{versao:r.versao})).body.versao;const pdf=await t.call('GET','/pdf',{}, {versao});assert.equal(pdf.status,200);assert.equal(pdf.headers.get('Content-Type'),'application/pdf');const bytes=Buffer.from(await pdf.arrayBuffer());assert.match(bytes.subarray(0,5).toString(),/%PDF-/);if(process.env.PDF_EXEMPLO)await writeFile(process.env.PDF_EXEMPLO,bytes);r=(await t.call('GET')).body;r.dados.escalas[0].servicos.find(s=>s.tipo==='HOTEL').dados.nome='Hotel Novo';await t.call('POST','',{versao:r.versao,dados:r.dados});assert.equal(JSON.parse(t.db.prepare('SELECT snapshot_json FROM preparacao_voo_versoes WHERE versao=?').get(versao).snapshot_json).dados.escalas[0].servicos.find(s=>s.tipo==='HOTEL').dados.nome,'Hotel Inicial');}finally{t.close();}
});
test('consulta e escrita exigem autenticação; voo encerrado é consulta',async()=>{
 const t=setup();try{assert.equal((await t.call('GET','',{}, {testUser:null})).status,403);t.db.exec("UPDATE solicitacoes_reserva_voo SET status='encerrada'");const r=(await t.call('GET')).body;assert.ok(r.somente_leitura);assert.equal((await t.call('POST','/concluir',{versao:0,dados:r.dados})).status,409);}finally{t.close();}
});

test('alterar o roteiro mantém identidade da escala e exige reconfirmar serviços, sem impedir conclusão',async()=>{
 const t=setup();try{let r=(await t.call('GET')).body;r.dados.escalas[1].servicos[1].estado='CONCLUIDO';r=(await t.call('POST','',{versao:0,dados:r.dados})).body;r.dados.trechos[0].destino='SBBR';r.dados.escalas[1].icao='SBBR';const a=await t.call('POST','/concluir',{versao:r.versao,dados:r.dados});assert.equal(a.status,200);assert.equal(a.body.dados.escalas[1].servicos[1].estado,'EM_ANDAMENTO');assert.match(a.body.dados.escalas[1].servicos[1].observacao,/reconfirmar/);assert.ok(a.body.finalizado_em);r=a.body;r.dados.trechos[0].destino='SBGL';assert.equal((await t.call('POST','',{versao:r.versao,dados:r.dados})).status,400);}finally{t.close();}
});
test('comprovantes aceitam imagem e PDF, recusam formatos indevidos e isolam anexos por voo',async()=>{
 const t=setup();try{const form=new FormData();form.set('servico_id','e1:HOTEL');form.set('arquivo',new File(['imagem'],'confirmacao.png',{type:'image/png'}));const a=await t.call('POST','/anexos',form);assert.equal(a.status,201);const file=await t.call('GET','/anexos/:anexo',{}, {anexo:a.body.id});assert.equal(file.status,200);assert.equal(file.headers.get('Content-Type'),'image/png');assert.equal((await t.call('GET','/anexos/:anexo',{}, {anexo:'inexistente'})).status,404);form.set('arquivo',new File(['x'],'arquivo.exe',{type:'application/octet-stream'}));assert.equal((await t.call('POST','/anexos',form)).status,400);assert.equal(t.bucket.size,1);let r=(await t.call('GET')).body;await t.call('POST','/concluir',{versao:0,dados:r.dados});const historico=JSON.parse(t.db.prepare('SELECT snapshot_json FROM preparacao_voo_versoes').get().snapshot_json);assert.equal(historico.anexos[0].nome,'confirmacao.png');}finally{t.close();}
});
test('datas impossíveis e preço vazio não criam despesa; diário válido preserva pagador e notifica financeiro',async()=>{
 const t=setup();try{const b={escala_id:'e2',data:'2026-02-30',tipo_combustivel:'Jet A-1',litros:10,valor_unitario:9,fornecedor_id:'f1'};assert.equal((await t.call('POST','/abastecimento-realizado',b)).status,400);b.data='2026-11-18';b.valor_unitario='';assert.equal((await t.call('POST','/abastecimento-realizado',b)).status,400);b.valor_unitario=9;b.lancamento_diario_id='d1';t.db.exec("INSERT INTO lancamentos_diario_bordo VALUES('d1','cliente-anterior','cotista-anterior','a1','2026-11-17','SBCY','SBIL',1);INSERT INTO user_profiles VALUES('fin','ativo','financeiro','');");const a=await t.call('POST','/abastecimento-realizado',b);assert.equal(a.status,201);assert.equal(t.db.prepare('SELECT socio_id FROM abastecimentos').get().socio_id,'cotista-anterior');assert.equal(t.db.prepare('SELECT count(*) n FROM notificacoes').get().n,1);}finally{t.close();}
});
test('abastecimento legado permanece consultável e não é duplicado na mesma escala',async()=>{
 const t=setup();try{t.db.exec("INSERT INTO abastecimentos(id,aeronave_id,local,data,litros,valor_unitario) VALUES('antigo','a1','SBIL','2026-11-18',100,9);INSERT INTO checklists_pre_voo(id,solicitacao_id,abastecimento_id,respostas,status) VALUES('legado','voo1','antigo','{}','concluido');");let r=(await t.call('GET')).body;assert.equal(r.abastecimentos[0].id,'antigo');const b={escala_id:'e2',data:'2026-11-18',tipo_combustivel:'Jet',litros:100,valor_unitario:9,fornecedor_id:'f1'};assert.equal((await t.call('POST','/abastecimento-realizado',b)).body.id,'antigo');r=(await t.call('POST','',{versao:0,dados:r.dados})).body;t.db.exec("UPDATE solicitacoes_reserva_voo SET status='encerrada'");assert.equal((await t.call('POST','/emitir',{versao:r.versao})).status,200);assert.equal(t.db.prepare('SELECT count(*) n FROM abastecimentos').get().n,1);}finally{t.close();}
});

test('tripulante recebe hotel solicitado pela coordenação, sem reservas de outros voos ou usuários',async()=>{
 const t=setup(),old=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');try{
 let r=(await t.call('GET')).body;const h=r.dados.escalas[1].servicos[1];h.cadastro_id='h1';h.dados={checkin:'2026-11-18',checkout:'2026-11-20',hospedes:'Piloto',telefone_hospede:'123',nome:'Hotel Teste',telefone:'7333333333',cafe_estado:'INCLUIDO'};r=(await t.call('POST','',{versao:0,dados:r.dados})).body;await t.call('POST','/reservar-hotel',{versao:r.versao,escala_id:'e2',servico_id:h.id,requisicao_id:'reserva-vinculada-voo'});
 t.db.exec("INSERT INTO reservas_hoteis(id,hotel_id,criado_por,data_checkin,data_checkout) VALUES('outro','h1','outra-pessoa','2026-11-18','2026-11-20');INSERT INTO reservas_hoteis(id,hotel_id,criado_por,data_checkin,data_checkout) VALUES('outro-voo','h1','piloto-user','2026-11-18','2026-11-20');INSERT INTO preparacao_voo_reservas(id,solicitacao_id,escala_id,servico_id,requisicao_id,assinatura,reserva_id,payload_json,criado_por) VALUES('link','voo2','e1','h','outro-id-1','hash-outro','outro-voo','{}','piloto-user');");
 const hotels=await hospedagensDoVoo(t.adapter,{id:'voo1',data_agendada:'2026-11-18',data_fim:'2026-11-20'},'piloto-user');assert.equal(hotels.results.length,1);assert.equal(hotels.results[0].cafe_estado,'INCLUIDO');assert.equal(hotels.results[0].hotel_telefone,'7333333333');assert.equal(hotels.results[0].status,'SOLICITADA');assert.ok(!('preparacao_snapshot' in hotels.results[0]));
 }finally{globalThis.fetch=old;t.close();}
});

test('horário ISO do agendamento conserva o instante UTC inclusive ao trocar o dia',async()=>{
 const t=setup();try{t.db.exec("UPDATE solicitacoes_reserva_voo SET horario_previsto_agendamento='2026-11-18T23:30:00-03:00'");let r=(await t.call('GET')).body;assert.equal(r.dados.trechos[0].data,'2026-11-19');assert.equal(r.dados.trechos[0].horario,'02:30');assert.equal(r.dados.trechos[0].fuso,'UTC');assert.equal((await t.call('POST','/concluir',{versao:0,dados:r.dados})).status,200);}finally{t.close();}
});
