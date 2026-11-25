export async function abastecimentosDoVoo(db:any,id:string) {
  const r=await db.prepare(`SELECT p.escala_id,a.* FROM preparacao_voo_abastecimentos p JOIN abastecimentos a ON a.id=p.abastecimento_id WHERE p.solicitacao_id=?
    UNION ALL SELECT NULL AS escala_id,a.* FROM abastecimentos a WHERE a.id IN (SELECT abastecimento_id FROM checklists_pre_voo WHERE solicitacao_id=? AND abastecimento_id IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM preparacao_voo_abastecimentos p WHERE p.abastecimento_id=a.id) ORDER BY data`).bind(id,id).all();return r.results||[];
}
import { inicial, validarDados, carimbar, resumo, type Preparacao } from './dominio';
export async function consultar(db: any, id: string) {
  const voo = await db.prepare(`SELECT s.*, a.matricula_registro, a.modelo,
    COALESCE(p.nome_completo,pf.nome_completo) piloto_nome, COALESCE(cp.nome_completo,cf.nome_completo) copiloto_nome
    FROM solicitacoes_reserva_voo s LEFT JOIN aeronave a ON a.id=s.aeronave_id
    LEFT JOIN tripulacao p ON p.id=s.piloto_id LEFT JOIN tripulacao_freelancer pf ON pf.id=s.piloto_id
    LEFT JOIN tripulacao cp ON cp.id=s.copiloto_id LEFT JOIN tripulacao_freelancer cf ON cf.id=s.copiloto_id WHERE s.id=?`).bind(id).first();
  if(!voo) return null;
  const atual=await db.prepare('SELECT * FROM preparacoes_voo WHERE solicitacao_id=?').bind(id).first();
  const legado=await db.prepare('SELECT * FROM checklists_pre_voo WHERE solicitacao_id=? ORDER BY criado_em DESC LIMIT 1').bind(id).first();
  const dados: Preparacao=atual?JSON.parse(atual.dados_json):inicial(voo,legado);
  const finalizado=atual?.finalizado_em || (legado?.status==='concluido'?legado.concluido_em:null);
  return { voo, dados, versao:atual?.versao || 0, finalizado_em:finalizado,
    atualizado_em:atual?.atualizado_em || legado?.atualizado_em || null,
    atualizado_por_nome:atual?.atualizado_por_nome || legado?.executado_por_nome || '',
    resumo:resumo(dados), legado:!atual && Boolean(legado),
    somente_leitura:['encerrada','concluida','cancelada','rejeitada'].includes(String(voo.status).toLowerCase()) };
}
export async function gravar(db:any, id:string, body:any, usuario:{id:string;nome:string}, concluir=false) {
  const atual=await consultar(db,id); if(!atual)throw new Error('voo_nao_encontrado');
  if(atual.somente_leitura)throw new Error('voo_encerrado');
  if(!Number.isInteger(body.versao)||body.versao!==atual.versao)throw new Error('versao_desatualizada');
  const agora=new Date().toISOString(), comando=crypto.randomUUID(), versao=atual.versao+1;
  const dados=carimbar(atual.dados,validarDados(body.dados),usuario.nome,agora);
  const finalizado=concluir?agora:atual.finalizado_em;
  const sum=resumo(dados);
  const [rs,an,ab]=await Promise.all([
    db.prepare('SELECT id,escala_id,servico_id,reserva_id,status,enviado_em,criado_em FROM preparacao_voo_reservas WHERE solicitacao_id=? ORDER BY criado_em DESC').bind(id).all(),
    db.prepare('SELECT id,servico_id,nome,mime,tamanho,criado_em FROM preparacao_voo_anexos WHERE solicitacao_id=? ORDER BY criado_em DESC').bind(id).all(),
    abastecimentosDoVoo(db,id),
  ]);
  const snapshot={reservas:rs.results||[],anexos:an.results||[],abastecimentos:ab,...atual, dados,versao,finalizado_em:finalizado,resumo:sum,atualizado_em:agora,atualizado_por_nome:usuario.nome};
  const json=JSON.stringify(dados),snapshotJson=JSON.stringify(snapshot);
  const cmd=atual.versao===0
    ?db.prepare('INSERT INTO preparacoes_voo(solicitacao_id,versao,comando_id,dados_json,finalizado_em,atualizado_por,atualizado_por_nome,atualizado_em) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(solicitacao_id) DO NOTHING').bind(id,versao,comando,json,finalizado,usuario.id,usuario.nome,agora)
    :db.prepare('UPDATE preparacoes_voo SET versao=?,comando_id=?,dados_json=?,finalizado_em=?,atualizado_por=?,atualizado_por_nome=?,atualizado_em=? WHERE solicitacao_id=? AND versao=?').bind(versao,comando,json,finalizado,usuario.id,usuario.nome,agora,id,atual.versao);
  const batch=[cmd,db.prepare('INSERT INTO preparacao_voo_versoes(id,solicitacao_id,versao,tipo,snapshot_json,criado_por,criado_em) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM preparacoes_voo WHERE solicitacao_id=? AND comando_id=?)').bind(crypto.randomUUID(),id,versao,concluir?'CONCLUSAO':'ATUALIZACAO',snapshotJson,usuario.id,agora,id,comando)];
  // Compatibilidade com a lista de voos e o início de jornada existentes. Não cria gastos.
  const respostas:any={};
  for(const [key,r] of Object.entries(dados.itens)) {
    const valorAcordadoTipo=key==='comissaria'?String(r.valor_acordado_tipo||'').trim().slice(0,10):'';
    respostas[key]={status:['CONCLUIDO','NAO_APLICAVEL'].includes(r.estado)?'feito':r.estado==='EM_ANDAMENTO'?'alerta':'nao_feito',observacao:r.observacao,...(key==='comissaria'&&['PESSOA','TOTAL'].includes(valorAcordadoTipo)?{valor_acordado_tipo:valorAcordadoTipo}:{})};
  }
  respostas._preparacao={pendencias:sum.pendencias,versao,finalizado:Boolean(finalizado)};
  const status=finalizado?'concluido':'rascunho', respostaJson=JSON.stringify(respostas);
  batch.push(db.prepare(`UPDATE checklists_pre_voo SET respostas=?,nivel_oleo=?,observacoes=?,executado_por=?,executado_por_nome=?,status=?,concluido_em=?,atualizado_em=? WHERE id=(SELECT id FROM checklists_pre_voo WHERE solicitacao_id=? ORDER BY criado_em DESC LIMIT 1) AND EXISTS(SELECT 1 FROM preparacoes_voo WHERE solicitacao_id=? AND comando_id=?)`).bind(respostaJson,dados.nivel_oleo,dados.observacoes,usuario.id,usuario.nome,status,finalizado,agora,id,id,comando));
  batch.push(db.prepare(`INSERT INTO checklists_pre_voo(id,solicitacao_id,aeronave_id,respostas,nivel_oleo,observacoes,executado_por,executado_por_nome,status,concluido_em,criado_em,atualizado_em,numero_voo,criado_por) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM checklists_pre_voo WHERE solicitacao_id=?) AND EXISTS(SELECT 1 FROM preparacoes_voo WHERE solicitacao_id=? AND comando_id=?)`).bind(crypto.randomUUID(),id,atual.voo.aeronave_id,respostaJson,dados.nivel_oleo,dados.observacoes,usuario.id,usuario.nome,status,finalizado,agora,agora,atual.voo.numero_voo,usuario.id,id,id,comando));
  const result=await db.batch(batch);
  if(!result[0]?.meta?.changes)throw new Error('versao_desatualizada');
  return snapshot;
}
