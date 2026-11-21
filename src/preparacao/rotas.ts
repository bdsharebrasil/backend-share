import { notifyChecklistAbastecimento } from './notificacoes';
import { Hono } from 'hono';
import type { Env } from '../types/env';
import { authenticatedColaborador, requireFlightOperationAccess, requireFlightCrewOrOperationsWriteAccess } from '../lib/auth';
import { salvarArquivoShareBrasil, shareBrasilBucket } from '../lib/storage';
import { consultar, gravar, abastecimentosDoVoo } from './servico';
import { cafeDaManha, SECOES, ESTADOS, TIPOS_SERVICO } from './dominio';
import { gerarBriefing } from './pdf';
export const preparacaoRoutes = new Hono<{ Bindings: Env }>();
const root='/api/interno/agendamento/:id/preparacao';
const uuid=()=>crypto.randomUUID();
const txt=(v:unknown)=>String(v??'').trim();
const dataValida=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
function idVoo(c:any):string{const id=c.req.param('id');if(!id)throw Error('voo_nao_encontrado');return id;}
const erro=(e:any)=>String(e?.message||'falha_preparacao');
async function acesso(c:any){if(!await requireFlightOperationAccess(c,idVoo(c)))return c.json({error:'sem_permissao'},403);}
async function usuario(c:any){const u=await authenticatedColaborador(c);if(!u)throw Error('nao_autorizado');return {id:u.id,nome:u.nome_exibicao||u.nome_completo||'Colaborador'};}
async function estado(c:any){const s=await consultar(c.env.SHARE_DB,idVoo(c));if(!s)throw Error('voo_nao_encontrado');return s;}
async function extras(db:any,id:string){const [rs,an,ab]=await Promise.all([
 db.prepare('SELECT id,escala_id,servico_id,reserva_id,status,enviado_em,criado_em FROM preparacao_voo_reservas WHERE solicitacao_id=? ORDER BY criado_em DESC').bind(id).all(),
 db.prepare('SELECT id,servico_id,nome,mime,tamanho,criado_em FROM preparacao_voo_anexos WHERE solicitacao_id=? ORDER BY criado_em DESC').bind(id).all(),
 abastecimentosDoVoo(db,id),
]);return{reservas:rs.results||[],anexos:an.results||[],abastecimentos:ab};}
preparacaoRoutes.onError((e,c)=>{
 const code=erro(e);console.error('[preparacao]',code);
 if(/no such table|no such column|schema/i.test(code))return c.json({error:'preparacao_atualizando'},503);
 const status=code==='versao_desatualizada'?409:code==='nao_autorizado'?401:code==='voo_nao_encontrado'?404:code==='voo_encerrado'?409:code.includes('inval')?400:500;
 return c.json({error:status===500?'falha_preparacao':code},status as any);
});
preparacaoRoutes.get(root,async c=>{
 const negado=await acesso(c);if(negado)return negado;
 const s=await estado(c);return c.json({...s,...await extras(c.env.SHARE_DB,idVoo(c)),secoes:SECOES,estados:ESTADOS,tipos_servico:TIPOS_SERVICO});
});
preparacaoRoutes.get(root+'/opcoes',async c=>{
 const negado=await acesso(c);if(negado)return negado;await estado(c);
 const db=c.env.SHARE_DB;
 const [h,f,fc,ff,diario]=await Promise.all([
  db.prepare('SELECT id,nome,telefone,telefone_reservas,endereco,cidade,uf,email,email_comercial,preco_single,preco_duplo,cafe_manha,convenio,observacoes FROM hoteis ORDER BY nome').all(),
  db.prepare('SELECT * FROM agenda_contatos_fornecedores ORDER BY empresa,nome_contato_responsavel').all(),
  db.prepare('SELECT * FROM fornecedores_combustivel ORDER BY nome_fornecedor').all(),
  db.prepare('SELECT * FROM fornecedores_favoritos ORDER BY nome_completo').all(),
  db.prepare('SELECT id,data_registro AS data,aerodromo_partida AS origem,aerodromo_chegada AS destino FROM lancamentos_diario_bordo WHERE aeronave_id=(SELECT aeronave_id FROM solicitacoes_reserva_voo WHERE id=?) ORDER BY data_registro DESC,numero_sequencial DESC LIMIT 1').bind(idVoo(c)).first(),
 ]);
 // Contrato mínimo para a operação: não envia dados bancários ou fiscais dos cadastros.
 return c.json({ultimo_diario:diario,hoteis:(h.results||[]).map((x:any)=>({...x,cafe:cafeDaManha(x.cafe_manha)})),
  fornecedores:[...(f.results||[]).map((x:any)=>({id:x.id,origem:'agenda',nome:x.empresa||x.nome_contato_responsavel,contato:x.nome_contato_responsavel,telefone:x.telefone,email:x.email,endereco:x.endereco,cidade:x.cidade,uf:x.uf,codigo_icao:x.codigo_icao,categoria:x.categoria,gpu:x.gpu,transfer:x.transfer,valor_gpu:x.valor_gpu,valor_transfer:x.valor_transfer,ar_condicionado:x.ar_condicionado,pernoite:x.pernoite,atendimento_pista:x.atendimento_pista,observacoes:x.observacoes})),
   ...(fc.results||[]).map((x:any)=>({id:x.id,origem:'combustivel',nome:x.nome_fornecedor,cidade:x.nome_cidade,codigo_icao:x.codigo_icao,telefone:x.telefone,contato:x.pessoa_contato,preco_jet:x.preco_jet,preco_avgas:x.preco_avgas,categoria:'COMBUSTIVEL'})),
   ...(ff.results||[]).map((x:any)=>({id:x.id,origem:'favoritos',nome:x.nome_completo,cidade:x.cidade,codigo_icao:x.codigo_icao,telefone:x.telefone,contato:x.pessoa_contato,preco_jet:x.preco_jet,preco_avgas:x.preco_avgas,categoria:'COMBUSTIVEL'}))]});
});
for(const [suffix,concluir]of [['',false],['/concluir',true]] as const)preparacaoRoutes.post(root+suffix,async c=>{
 const negado=await acesso(c);if(negado)return negado;const u=await usuario(c);const body=await c.req.json<any>();
 if(JSON.stringify(body).length>250000)return c.json({error:'dados_muito_grandes'},413);
 const result=await gravar(c.env.SHARE_DB,idVoo(c),body,u,concluir);return c.json({...result,...await extras(c.env.SHARE_DB,idVoo(c))});
});
preparacaoRoutes.get(root+'/versoes',async c=>{
 const negado=await acesso(c);if(negado)return negado;await estado(c);
 const r=await c.env.SHARE_DB.prepare('SELECT versao,tipo,criado_em FROM preparacao_voo_versoes WHERE solicitacao_id=? ORDER BY versao DESC LIMIT 100').bind(idVoo(c)).all();return c.json(r.results||[]);
});
preparacaoRoutes.post(root+'/emitir',async c=>{
 const negado=await acesso(c);if(negado)return negado;const s=await estado(c),u=await usuario(c),db=c.env.SHARE_DB;
 const body=await c.req.json<any>();
 if(body.versao!==s.versao)return c.json({error:'versao_desatualizada'},409);
 if(s.somente_leitura)return c.json({versao:s.versao});
 const novo=await gravar(db,idVoo(c),{versao:s.versao,dados:s.dados},u);
 return c.json({versao:novo.versao});
});
preparacaoRoutes.get(root+'/pdf',async c=>{
 // PDF contém dados privados de tripulação e fornecedores: acesso restrito
 // à equipe operacional ou à tripulação vinculada ao voo.
 if (!(await requireFlightCrewOrOperationsWriteAccess(c, idVoo(c)))) return c.json({error:'sem_permissao'},403);
 const atual=await estado(c),db=c.env.SHARE_DB;
 const v=Number(c.req.query('versao'));if(!Number.isInteger(v)||v<0)return c.json({error:'versao_invalida'},400);
 let snapshot:any;
 if(v===0&&atual.versao===0)snapshot={...atual,...await extras(db,idVoo(c))};
 else {const row=await db.prepare('SELECT snapshot_json FROM preparacao_voo_versoes WHERE solicitacao_id=? AND versao=?').bind(idVoo(c),v).first<any>();if(!row)return c.notFound();snapshot=JSON.parse(row.snapshot_json);}
 const bytes=await gerarBriefing(snapshot,snapshot.reservas||[],snapshot.anexos||[],snapshot.abastecimentos||[]);
 return new Response(bytes as any,{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="briefing-${String(atual.voo.numero_voo||'voo').replace(/[^a-z0-9-]/gi,'-')}-v${v}.pdf"`,'Cache-Control':'private, no-store'}});
});
preparacaoRoutes.post(root+'/reservar-hotel',async c=>{
 const negado=await acesso(c);if(negado)return negado;const u=await usuario(c),s=await estado(c),db=c.env.SHARE_DB;
 if(s.somente_leitura)return c.json({error:'voo_encerrado'},409);
 const b=await c.req.json<any>();if(!/^[a-zA-Z0-9-]{8,100}$/.test(txt(b.requisicao_id)))return c.json({error:'requisicao_invalida'},400);
 const e=s.dados.escalas.find(e=>e.id===b.escala_id),serv=e?.servicos.find(x=>x.id===b.servico_id&&x.tipo==='HOTEL');
 if(!serv)return c.json({error:'servico_invalido'},400);
 let envio=await db.prepare('SELECT * FROM preparacao_voo_reservas WHERE requisicao_id=?').bind(b.requisicao_id).first<any>();
 if(envio&&(envio.solicitacao_id!==idVoo(c)||envio.servico_id!==serv.id))return c.json({error:'requisicao_invalida'},400);
 if(envio?.status==='ENVIADO')return c.json({id:envio.reserva_id,enviado:true,repetido:true});
 if(!envio){
  if(b.versao!==s.versao)return c.json({error:'versao_desatualizada'},409);
  const d=serv.dados;
  const hotel=await db.prepare('SELECT id,nome,email,email_comercial FROM hoteis WHERE id=?').bind(serv.cadastro_id).first<any>();
  if(!hotel)return c.json({error:'hotel_invalido'},400);
  const destino=txt(hotel.email||hotel.email_comercial);if(!destino)return c.json({error:'hotel_sem_email'},422);
  const qtd=Number(d.quantidade_hospedes||1);
  if(!dataValida(d.checkin||'')||!dataValida(d.checkout||'')||d.checkout<=d.checkin||!txt(d.hospedes)||!txt(d.telefone_hospede)||!Number.isInteger(qtd)||qtd<1)return c.json({error:'reserva_incompleta'},400);
  const payload:Record<string,any>={...d,hotel_id:hotel.id,nome:hotel.nome,destinatario:destino,observacao:serv.observacao,numero_voo:s.voo.numero_voo,escala:e!.icao};
  const chaves=Object.keys(payload).filter(k=>k!=='cadastro_copiado_em').sort();
  const canonico=Object.fromEntries(chaves.map(k=>[k,k==='observacao'&&payload[k]==='Solicitação enviada; aguardando confirmação do hotel.'?'':payload[k]]));
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonico)));
  const assinatura=Array.from(new Uint8Array(digest)).map(n=>n.toString(16).padStart(2,'0')).join('');
  const envioId=uuid(),reservaId=uuid();
  await db.prepare('INSERT INTO preparacao_voo_reservas(id,solicitacao_id,escala_id,servico_id,requisicao_id,assinatura,reserva_id,payload_json,criado_por) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(envioId,idVoo(c),e!.id,serv.id,b.requisicao_id,assinatura,reservaId,JSON.stringify(payload),u.id).run();
  envio=await db.prepare('SELECT * FROM preparacao_voo_reservas WHERE requisicao_id=? OR (solicitacao_id=? AND servico_id=? AND assinatura=?)').bind(b.requisicao_id,idVoo(c),serv.id,assinatura).first<any>();
 }
 if(envio?.status==='ENVIADO')return c.json({id:envio.reserva_id,enviado:true,repetido:true});
 if(!c.env.RESEND_API_KEY||!c.env.EMAIL_FROM)return c.json({error:'email_indisponivel'},503);
 const d=JSON.parse(envio.payload_json);const esc=(x:any)=>String(x??'').replace(/[&<>"']/g,(ch:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
 const cafe:any={INCLUIDO:'Incluído na diária',A_PARTE:'Pago à parte',NAO_OFERECE:'Não oferece',A_CONFIRMAR:'A confirmar'};
 const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${c.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`preparacao-reserva-${envio.id}`},body:JSON.stringify({from:c.env.EMAIL_FROM,to:[d.destinatario],subject:`Solicitação de reserva — ${d.nome} — Voo ${d.numero_voo||''}`,html:`<h2>Solicitação de reserva Share Brasil</h2>${Object.entries({'Hotel':d.nome,'Voo':d.numero_voo,'Escala':d.escala,'Check-in':d.checkin,'Check-out':d.checkout,'Tipo de quarto':d.tipo_quarto,'Quartos':d.quartos,'Hóspedes':d.hospedes,'Quantidade de hóspedes':d.quantidade_hospedes||1,'Telefone do hóspede':d.telefone_hospede,'Café da manhã':`${cafe[d.cafe_estado]||'A confirmar'}${d.cafe_valor?' - R$ '+d.cafe_valor:''}`,'Valor acordado':d.valor_acordado,'Observações':d.observacao}).map(([k,v])=>`<p><strong>${esc(k)}:</strong> ${esc(v||'Não informado')}</p>`).join('')}`})});
 if(!response.ok){await db.prepare("UPDATE preparacao_voo_reservas SET status='FALHA',erro='falha_envio' WHERE id=?").bind(envio.id).run();return c.json({error:'falha_email_reserva'},502);}
 await db.batch([
  db.prepare("INSERT INTO reservas_hoteis(id,hotel_id,criado_por,data_checkin,data_checkout,tipo_quarto,quantidade_hospedes,hospede_nome,hospede_telefone,hospede_email,observacoes,destinatario_email,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(envio.reserva_id,d.hotel_id,envio.criado_por,d.checkin,d.checkout,d.tipo_quarto||null,Number(d.quantidade_hospedes||1),d.hospedes,d.telefone_hospede,d.email_hospede||null,d.observacao||null,d.destinatario,'SOLICITADA'),
  db.prepare("UPDATE preparacao_voo_reservas SET status='ENVIADO',enviado_em=COALESCE(enviado_em,CURRENT_TIMESTAMP),erro=NULL WHERE id=?").bind(envio.id),
 ]);
 return c.json({id:envio.reserva_id,enviado:true,destinatario:d.destinatario},201);
});
preparacaoRoutes.post(root+'/anexos',async c=>{
 const negado=await acesso(c);if(negado)return negado;const u=await usuario(c),s=await estado(c);if(s.somente_leitura)return c.json({error:'voo_encerrado'},409);
 const form=await c.req.formData(),f:unknown=form.get('arquivo'),servico=txt(form.get('servico_id'));
 if(!s.dados.escalas.some(e=>e.servicos.some(s=>s.id===servico)))return c.json({error:'servico_invalido'},400);
 if(!(f instanceof File)||!f.size||f.size>10*1024*1024||!['application/pdf','image/jpeg','image/png','image/webp'].includes(f.type))return c.json({error:'anexo_invalido'},400);
 const caminho=await salvarArquivoShareBrasil(c,u.id,f,'share/preparacao_voo/'+idVoo(c));
 const id=uuid();try{await c.env.SHARE_DB.prepare('INSERT INTO preparacao_voo_anexos(id,solicitacao_id,servico_id,nome,caminho,mime,tamanho,criado_por) VALUES(?,?,?,?,?,?,?,?)').bind(id,idVoo(c),servico,f.name,caminho,f.type,f.size,u.id).run();}catch(e){await shareBrasilBucket(c).delete(caminho);throw e;}
 return c.json({id,nome:f.name,servico_id:servico},201);
});
preparacaoRoutes.get(root+'/anexos/:anexo',async c=>{
 const negado=await acesso(c);if(negado)return negado;
 const row=await c.env.SHARE_DB.prepare('SELECT * FROM preparacao_voo_anexos WHERE id=? AND solicitacao_id=?').bind(c.req.param('anexo'),idVoo(c)).first<any>();if(!row)return c.notFound();
 const f=await shareBrasilBucket(c).get(row.caminho);if(!f)return c.notFound();return new Response(f.body,{headers:{'Content-Type':row.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(row.nome)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
});
preparacaoRoutes.post(root+'/abastecimento-realizado',async c=>{
 const negado=await acesso(c);if(negado)return negado;const u=await usuario(c),s=await estado(c),db=c.env.SHARE_DB;
 if(s.somente_leitura)return c.json({error:'voo_encerrado'},409);
 const b=await c.req.json<any>(),e=s.dados.escalas.find(e=>e.id===b.escala_id);if(!e)return c.json({error:'escala_invalida'},400);
 const existente=await db.prepare('SELECT abastecimento_id FROM preparacao_voo_abastecimentos WHERE solicitacao_id=? AND escala_id=?').bind(idVoo(c),e.id).first<any>();
 if(existente)return c.json({id:existente.abastecimento_id,repetido:true});
 const litros=Number(b.litros),unit=Number(b.valor_unitario),desconto=Number(b.desconto||0);
 const data=txt(b.data),valida=dataValida(data);
 if(!valida||!txt(b.valor_unitario)||!txt(b.tipo_combustivel)||!Number.isFinite(litros)||litros<=0||!Number.isFinite(unit)||unit<0||!Number.isFinite(desconto)||desconto<0||desconto>litros*unit)return c.json({error:'abastecimento_invalido'},400);
 const aeroporto=await db.prepare('SELECT designativo_icao FROM aerodromo WHERE upper(designativo_icao)=?').bind(e.icao).first<any>();if(!aeroporto)return c.json({error:'aerodromo_nao_cadastrado'},400);
 const cadastro=await db.prepare('SELECT id FROM fornecedores_combustivel WHERE id=? UNION SELECT id FROM fornecedores_favoritos WHERE id=?').bind(txt(b.fornecedor_id),txt(b.fornecedor_id)).first<any>();if(!cadastro)return c.json({error:'fornecedor_invalido'},400);
 const anterior=await db.prepare('SELECT a.id FROM abastecimentos a JOIN checklists_pre_voo c ON c.abastecimento_id=a.id WHERE c.solicitacao_id=? AND upper(a.local)=?').bind(idVoo(c),e.icao).first<any>();
 if(anterior)return c.json({id:anterior.id,repetido:true,legado:true});
 let pagador={cliente_id:s.voo.cliente_id||null,socio_id:s.voo.socio_id||null};
 if(b.lancamento_diario_id){const diario=await db.prepare('SELECT cliente_id,socio_id FROM lancamentos_diario_bordo WHERE id=? AND aeronave_id=?').bind(txt(b.lancamento_diario_id),s.voo.aeronave_id).first<any>();if(!diario)return c.json({error:'trecho_diario_invalido'},400);pagador=diario;}
 const id=uuid(),controle=uuid();
 try{await db.batch([
  db.prepare('INSERT INTO preparacao_voo_abastecimentos(id,solicitacao_id,escala_id,abastecimento_id,criado_por) VALUES(?,?,?,?,?)').bind(controle,idVoo(c),e.id,id,u.id),
  db.prepare(`INSERT INTO abastecimentos(id,cliente_id,socio_id,aeronave_id,data,tipo_combustivel,trecho,local,numero_comanda,numero_nf,litros,valor_unitario,valor_total,desconto,fornecedor_id,status,criado_por,voo_emprestado,numero_voo,lancamento_diario_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,pagador.cliente_id,pagador.socio_id,s.voo.aeronave_id,b.data,b.tipo_combustivel,s.dados.trechos.map(t=>`${t.origem} X ${t.destino}`).join(' / '),aeroporto.designativo_icao,txt(b.numero_comanda)||null,txt(b.numero_nf)||null,litros,unit,litros*unit-desconto,desconto,cadastro.id,'gerado pré voo',u.id,s.voo.voo_emprestado==='sim'?1:0,s.voo.numero_voo||null,txt(b.lancamento_diario_id)||null),
 ]);}catch(error){const retry=await db.prepare('SELECT abastecimento_id FROM preparacao_voo_abastecimentos WHERE solicitacao_id=? AND escala_id=?').bind(idVoo(c),e.id).first<any>();if(retry)return c.json({id:retry.abastecimento_id,repetido:true});throw error;}
 await notifyChecklistAbastecimento(db,id,u.id,s.voo.numero_voo,e.icao).catch(error=>console.error('[preparacao] falha_notificacao_abastecimento',error));
 return c.json({id},201);
});
