import { Hono } from 'hono'
import { shareBrasilUser, type Colaborador } from '../lib/auth'
import { temposVooPortal, type CotaVooPortal } from '../financeiro/portalHoras'
import { campoData, campoNumerico, encerrado, modulos, opcoes, prever, ratear } from '../lib/ctmCoordenacao'

export const coordenacao=new Hono<{Bindings:{SHARE_DB:D1Database};Variables:{usuario:Colaborador}}>()
export function podeEditar(user:Colaborador) {
  return !['INATIVO','BLOQUEADO','DESATIVADO'].includes(String(user.status).trim().toUpperCase()) && (String(user.departamento).trim().toUpperCase()==='CTM' || ['admin','administrador','gestor_master','gestormaster'].includes(String(user.tipo_user).trim().toLowerCase().replace(/[ -]/g,'_')))
}
coordenacao.use('*',async(c,next)=>{
  const user=await shareBrasilUser(c)
  if (!user || ['INATIVO','BLOQUEADO','DESATIVADO'].includes(String(user.status).toUpperCase())) return c.json({error:'Acesso restrito.'},403)
  if(c.req.method!=='GET' && !podeEditar(user)) return c.json({error:'Edição restrita à coordenação do CTM.'},403)
  c.set('usuario',user)
  await next()
})
export function ativo(modulo:string,tabela:string) {
  return `NOT EXISTS (SELECT 1 FROM ctm_historico h WHERE h.modulo='${modulo}' AND h.registro_id=${tabela}.id AND h.acao='ARQUIVAR')`
}
const inicio='/aeronaves/:aeronave'
coordenacao.get('/reportes',async c=>{
  const dados=await c.env.SHARE_DB.prepare(`SELECT r.*,a.matricula_registro,
    (SELECT COUNT(*) FROM ctm_historico h WHERE h.modulo='reportes' AND h.registro_id=r.id) AS versao
    FROM ctm_reports_mobile r JOIN aeronave a ON a.id=r.aeronave_id
    ORDER BY (r.status='resolved'),CASE r.severidade WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,r.criado_em DESC`).all()
  return c.json({registros:dados.results,podeEditar:podeEditar(c.get('usuario'))})
})
coordenacao.get(inicio+'/historico/:modulo',async c=>{
  const rows=await c.env.SHARE_DB.prepare(`SELECT h.*,COALESCE(u.nome_completo,h.autor) AS responsavel FROM ctm_historico h LEFT JOIN user_profiles u ON u.id=h.autor
    WHERE modulo=? AND aeronave_id=? ORDER BY h.data DESC,h.versao DESC`).bind(c.req.param('modulo'),c.req.param('aeronave')).all()
  return c.json({eventos:rows.results})
})
const caminho=inicio+'/registros/:modulo'
coordenacao.get(caminho,async c=>{
  const modulo=c.req.param('modulo')||'', aeronave=c.req.param('aeronave')||''
  if (!Object.prototype.hasOwnProperty.call(modulos,modulo)) return c.notFound()
  const {tabela,campos,obrigatorios}=modulos[modulo]
  const db=c.env.SHARE_DB
  const schema=(await db.prepare(`PRAGMA table_info(${tabela})`).all<{name:string;notnull:number;dflt_value:unknown}>()).results
  const escopo=modulo==='pecas'?'ordem_servico_id IN (SELECT id FROM ctm_ras WHERE aeronave_id=?)':'aeronave_id=?'
  const registros=(await db.prepare(`SELECT t.*,(SELECT COUNT(*) FROM ctm_historico h WHERE h.modulo=? AND h.registro_id=t.id) AS versao FROM ${tabela} t WHERE ${escopo} AND ${ativo(modulo,'t')} ORDER BY id`).bind(modulo,aeronave).all()).results
  return c.json({campos:campos.filter(k=>schema.some(col=>col.name===k)).map(k=>({nome:k,tipo:campoData(k)?'date':campoNumerico(k)?'number':'text',opcoes:opcoes[k],obrigatorio:obrigatorios.includes(k)||schema.some(col=>col.name===k && col.notnull && col.dflt_value==null)})),registros:registros.map(r=>({...r,bloqueado:encerrado(r,modulo)})),podeEditar:podeEditar(c.get('usuario'))})
})
coordenacao.on(['POST','PATCH','DELETE'],[caminho,caminho+'/:id'],async c=>{
  const modulo=c.req.param('modulo')||'', aeronave=c.req.param('aeronave')||'', id=c.req.param('id')
  const novo=c.req.method==='POST', arquivo=c.req.method==='DELETE'
  if (novo===Boolean(id)) return c.notFound()
  const reporte=modulo==='reportes'
  if (reporte ? novo||arquivo : !Object.prototype.hasOwnProperty.call(modulos,modulo)) return c.notFound()
  const tabela=reporte?'ctm_reports_mobile':modulos[modulo].tabela
  const db=c.env.SHARE_DB
  const escopo=modulo==='pecas'?'ordem_servico_id IN (SELECT id FROM ctm_ras WHERE aeronave_id=?)':'aeronave_id=?'
  const antes=id?await db.prepare(`SELECT * FROM ${tabela} WHERE id=? AND ${escopo} AND ${ativo(modulo,tabela)}`).bind(id,aeronave).first():null
  if (id && !antes || !await db.prepare('SELECT id FROM aeronave WHERE id=?').bind(aeronave).first()) return c.notFound()
  const body=await c.req.json().catch(()=>null)
  const motivo=String(body?.motivo||'').trim()
  if (!body || id && (!motivo || motivo.length>5000 || !Number.isSafeInteger(body.versao))) return c.json({error:'Informe o motivo e a versão atual.'},400)
  if (!reporte && antes && encerrado(antes,modulo)) return c.json({error:'Registro encerrado.'},409)
  const registro=id||crypto.randomUUID()
  const atual=await db.prepare('SELECT COUNT(*) AS n FROM ctm_historico WHERE modulo=? AND registro_id=?').bind(modulo,registro).first<{n:number}>()
  if (id && atual?.n!==body.versao) return c.json({error:'Registro alterado. Atualize a página.'},409)
  const valores:Record<string,string|number|null>={}
  if(reporte){
    const transicoes:Record<string,string[]>={open:['in_analysis'],in_analysis:['in_analysis','in_maintenance','resolved'],in_maintenance:['in_analysis','in_maintenance','resolved'],resolved:['in_analysis']}
    if (!transicoes[String(antes?.status)]?.includes(body.status)) return c.json({error:'Mudança de situação inválida.'},409)
    valores.status=body.status; valores.acao_corretiva=motivo
    valores.atualizado_em=new Date().toISOString()
  } else if (!arquivo){
    const config=modulos[modulo]
    const dados=body.dados||{}
    for(const k of config.campos){
      const raw=dados[k]
      if (raw==null || raw==='') {
        if(config.obrigatorios.includes(k)) return c.json({error:'Campo obrigatório: '+k},400)
        if(k in dados) valores[k]=null
        continue
      }
      const valor=String(raw).trim()
      if (!valor || valor.length>5000 || opcoes[k] && !opcoes[k].includes(valor) ||
          campoNumerico(k) && (!Number.isFinite(Number(valor)) || Number(valor)<0) ||
          campoData(k) && (!/^\d{4}-\d{2}-\d{2}$/.test(valor) || !Number.isFinite(Date.parse(valor)) || new Date(valor).toISOString().slice(0,10)!==valor)) return c.json({error:'Valor inválido: '+k},400)
      valores[k]=campoNumerico(k)?Number(valor):valor
    }
    if (modulo==='oas' && (valores.total_pecas!=null || valores.total_mao_obra!=null)) {
      const colunas=await db.prepare('PRAGMA table_info(ctm_ordem_acompanhamento_servico)').all<{name:string}>()
      if(colunas.results.some(c=>c.name==='total_geral')) valores.total_geral=Number(valores.total_pecas||0)+Number(valores.total_mao_obra||0)
    }
    if (modulo==='pecas' && (!Number.isInteger(valores.quantidade) || Number(valores.quantidade)<1)) return c.json({error:'Informe uma quantidade positiva.'},400)
    if (modulo==='pecas' && !await db.prepare(`SELECT id FROM ctm_ras WHERE id=? AND aeronave_id=? AND data_saida IS NULL AND ${ativo('ras','ctm_ras')}`).bind(valores.ordem_servico_id,aeronave).first()) return c.json({error:'Selecione um RAS aberto desta matrícula.'},400)
    if (valores.data_saida && (String(valores.data_saida)<String(valores.data_entrada) || modulo==='oas' && (!valores.os_oficina || !valores.oficina_nome || !valores.observacoes))) return c.json({error:'Confira as datas, a oficina, a OS e a descrição do serviço.'},400)
    if (valores.tipo_rateio==='horas' && (!valores.relatorio_voo_de || !valores.relatorio_voo_ate || valores.relatorio_voo_de>valores.relatorio_voo_ate)) return c.json({error:'Informe o período do rateio por uso.'},400)
    if (valores.status==='complied' && (!valores.metodo_de_conformidade||!valores.data_de_conformidade)) return c.json({error:'Informe a referência e a data do cumprimento.'},400)
  }
  if (modulo==='pecas' && antes) {
    const pai=await db.prepare('SELECT * FROM ctm_ras WHERE id=? AND aeronave_id=?').bind(antes.ordem_servico_id,aeronave).first()
    if (!pai || encerrado(pai,'ras')) return c.json({error:'O RAS desta peça está encerrado.'},409)
  }
  if (modulo==='ras' && arquivo && await db.prepare(`SELECT id FROM ctm_pecas_trocadas WHERE ordem_servico_id=? AND ${ativo('pecas','ctm_pecas_trocadas')} LIMIT 1`).bind(registro).first()) return c.json({error:'RAS com peças vinculadas.'},409)
  const cmds:D1PreparedStatement[]=[]
  if(novo){
    valores.id=registro
    if(modulo!=='pecas') valores.aeronave_id=aeronave
    cmds.push(db.prepare(`INSERT INTO ${tabela} (${Object.keys(valores)}) VALUES (${Object.keys(valores).map(()=>'?')})`).bind(...Object.values(valores)))
  } else if (!arquivo) {
    cmds.push(db.prepare(`UPDATE ${tabela} SET ${Object.keys(valores).map(k=>k+'=?')} WHERE id=? AND ${escopo}`).bind(...Object.values(valores),registro,aeronave))
  }
  cmds.push(db.prepare('INSERT INTO ctm_historico(modulo,registro_id,aeronave_id,versao,acao,autor,motivo,anterior,posterior) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(modulo,registro,aeronave,(atual?.n||0)+1,novo?'CRIAR':arquivo?'ARQUIVAR':'EDITAR',c.get('usuario').id,motivo||null,antes?JSON.stringify(antes):null,JSON.stringify({...antes,...valores})))
  try { await db.batch(cmds) } catch(e){
    if (/constraint/i.test(String(e))) return c.json({error:'Conflito de versão ou dados incompatíveis com o cadastro.'},409)
    throw e
  }
  return c.json({id:registro},novo?201:200)
})
coordenacao.get(inicio+'/rateio/:id',async c=>{
  const db=c.env.SHARE_DB, id=c.req.param('aeronave')
  const o=await db.prepare(`SELECT * FROM ctm_ordem_acompanhamento_servico WHERE aeronave_id=? AND id=? AND ${ativo('oas','ctm_ordem_acompanhamento_servico')}`).bind(id,c.req.param('id')).first()
  if(!o) return c.notFound()
  const cotas=await db.prepare(`SELECT ca.id,ca.cliente_id,ca.socio_id,ca.status,ca.percentual_sociedade,COALESCE(s.nome,cl.razao_social,ca.id) nome FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id=ca.cliente_id LEFT JOIN hold_socios s ON s.id=ca.socio_id WHERE ca.aeronave_id=?`).bind(id).all<CotaVooPortal & {nome:string}>()
  const voos=o.tipo_rateio==='horas'?await db.prepare('SELECT * FROM lancamentos_diario_bordo WHERE aeronave_id=? AND date(data_registro) BETWEEN ? AND ?').bind(id,o.relatorio_voo_de??null,o.relatorio_voo_ate??null).all():{results:[]}
  return c.json(ratear(o,cotas.results,voos.results))
})
coordenacao.get(inicio+'/financeiro',async c=>{
  const r=await c.env.SHARE_DB.prepare(`SELECT v.competencia,v.categoria_nome,v.descricao_despesa,v.valor_rateado_centavos,v.dominio,v.status,COALESCE(s.nome,cl.razao_social,v.participante_id) cotista FROM vw_balanco_rateios v LEFT JOIN cotista_aeronave ca ON ca.id=v.participante_id LEFT JOIN cliente cl ON cl.id=ca.cliente_id LEFT JOIN hold_socios s ON s.id=ca.socio_id WHERE v.aeronave_id=? AND UPPER(COALESCE(v.status,'')) NOT IN ('CANCELADO','CANCELADA','ESTORNO','ESTORNADO') ORDER BY v.competencia DESC`).bind(c.req.param('aeronave')).all()
  return c.json({registros:r.results})
})
coordenacao.get(inicio+'/previsoes',async c=>{
  const db=c.env.SHARE_DB, id=c.req.param('aeronave'), hoje=new Date().toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'})
  const [d,voos,programa,componentes]=await Promise.all([
    db.prepare('SELECT * FROM diario_mes WHERE aeronave_id=? ORDER BY ano DESC,mes DESC LIMIT 1').bind(id).first(),
    db.prepare("SELECT tempo_ac,tempo_cor,tempo_dep,tempo_pou,tempo_voo,tempo_total FROM lancamentos_diario_bordo WHERE aeronave_id=? AND date(data_registro) BETWEEN date(?,'-89 days') AND date(?)").bind(id,hoje,hoje).all(),
    db.prepare(`SELECT * FROM ctm_programa_manutencao WHERE aeronave_id=? AND ${ativo('programa','ctm_programa_manutencao')}`).bind(id).all(),
    db.prepare(`SELECT * FROM ctm_mapa_componente WHERE aeronave_id=? AND ${ativo('componentes','ctm_mapa_componente')}`).bind(id).all()])
  const porVoo=d?.modo_celula==='tvoo'
  const leitura=porVoo?d?.celula_atual_tvoo:d?.celula_atual_ttotal
  const horas=leitura==null?null:Number(leitura)
  const tempos=voos.results.map(v=>porVoo?temposVooPortal(v).minutosVoo:temposVooPortal(v).minutosOperacionais)
  const media=d && tempos.length && tempos.every(v=>v!=null)?tempos.reduce<number>((a,b)=>a+Number(b),0)/5400:null
  const itens=[...programa.results.map(r=>prever(r,false,horas,media,hoje)),...componentes.results.map(r=>prever(r,true,horas,media,hoje))]
  return c.json({horas,media,itens:itens.sort((a,b)=>(a.data||'9999').localeCompare(b.data||'9999'))})
})
