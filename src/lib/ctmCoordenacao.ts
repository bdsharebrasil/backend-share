import { percentualVooCotistaPortal, temposVooPortal, type CotaVooPortal, type VooPortal } from '../financeiro/portalHoras'

export type Linha = Record<string, any>
export function ratear(ordem: Linha, cotas: Array<CotaVooPortal & {nome:string}>, voos: VooPortal[]) {
  const uso = ordem.tipo_rateio === 'horas'
  if (!uso && ordem.tipo_rateio !== 'percentual') return {aviso:'Selecione cota fixa ou uso na OAS.'}
  if (ordem.total_pecas == null && ordem.total_mao_obra == null) return {aviso:'Informe o custo da manutenção.'}
  if (uso && (!ordem.relatorio_voo_de || !ordem.relatorio_voo_ate || ordem.relatorio_voo_de > ordem.relatorio_voo_ate)) return {aviso:'Revise o período de uso na OAS.'}
  const ativas = cotas.filter(c => ['', 'ATIVO', 'ATIVA'].includes(String(c.status || '').trim().toUpperCase()))
  const bases = ativas.map(c => ({id:c.id, nome:c.nome, base:uso ? 0 : Number(c.percentual_sociedade)}))
  if (uso) for (const voo of voos) {
    const minutos = temposVooPortal(voo).minutosVoo
    const partes = ativas.map(c => percentualVooCotistaPortal(voo,c,ativas))
    if (minutos == null || Math.abs(partes.reduce((a,b)=>a+b,0)-100)>0.001) return {aviso:'Há voo sem duração ou sem atribuição completa.'}
    bases.forEach((c,i)=>{ c.base += minutos * partes[i] / 100 })
  }
  const soma = bases.reduce((a,b)=>a+b.base,0)
  if (!(soma>0) || bases.some(c=>!Number.isFinite(c.base) || c.base<0) || (!uso && Math.abs(soma-100)>0.05)) return {aviso:uso?'Sem horas atribuídas no período.':'Confira as cotas da matrícula.'}
  const total = Math.round(Number(ordem.total_pecas||0)*100)+Math.round(Number(ordem.total_mao_obra||0)*100)
  const linhas = bases.map(c => {
    const valor=total*c.base/soma
    return {...c, percentual:100*c.base/soma, centavos:Math.floor(valor), resto:valor-Math.floor(valor)}
  })
  const sobra=total-linhas.reduce((a,b)=>a+b.centavos,0)
  linhas.sort((a,b)=>b.resto-a.resto || a.id.localeCompare(b.id)).slice(0,sobra).forEach(l=>l.centavos++)
  return {linhas, total, uso}
}

export function prever(r:Linha, componente:boolean, horas:number|null, horasDia:number|null, hoje:string) {
  const datas:Array<{data:string; estimada:boolean}>=[]
  let saldo:number|null=null
  if (componente) {
    if (r.data_de_vencimento) datas.push({data:r.data_de_vencimento,estimada:false})
    if (r.total_horas_de_vida>0 && r.horas_de_vida_atuais!=null) saldo=r.total_horas_de_vida-r.horas_de_vida_atuais
  } else {
    if (r.intervalo_meses>0 && r.ultima_execucao_data) {
      const base=new Date(String(r.ultima_execucao_data).slice(0,10)+'T00:00:00Z')
      const limite=new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth()+Number(r.intervalo_meses)+1,0))
      limite.setUTCDate(Math.min(base.getUTCDate(),limite.getUTCDate()))
      if (Number.isFinite(+limite)) datas.push({data:limite.toISOString().slice(0,10),estimada:false})
    }
    if (r.intervalo_horas>0 && r.ultima_execucao_horas!=null && horas!=null) saldo=Number(r.ultima_execucao_horas)+Number(r.intervalo_horas)-horas
  }
  const referencia=componente?r.data_leitura:hoje
  if (referencia && saldo!=null && horasDia && horasDia>0) {
    const data=new Date(Date.parse(referencia)+Math.max(0,Math.ceil(saldo/horasDia))*86400000)
    if (Number.isFinite(+data)) datas.push({data:data.toISOString().slice(0,10),estimada:true})
  }
  datas.sort((a,b)=>a.data.localeCompare(b.data))
  return {item:r.item||r.nome, saldo, ...datas[0],
    ciclos:componente && r.ciclos_de_vida_totais!=null && r.ciclos_de_vida_atuais!=null?r.ciclos_de_vida_totais-r.ciclos_de_vida_atuais:null,
    limite_ciclos:r.intervalo_ciclos>0 && r.ultima_execucao_ciclos!=null?Number(r.ultima_execucao_ciclos)+Number(r.intervalo_ciclos):null,
    limite_pousos:r.intervalo_pousos>0 && r.ultima_execucao_pousos!=null?Number(r.ultima_execucao_pousos)+Number(r.intervalo_pousos):null}
}

export const modulos:Record<string,{tabela:string; campos:string[]; obrigatorios:string[]}> = {
  programa:{tabela:'ctm_programa_manutencao',campos:['item','categoria','grupo','base_legal','tipo_controle','intervalo_horas','intervalo_meses','intervalo_pousos','intervalo_ciclos','ultima_execucao_data','ultima_execucao_horas','ultima_execucao_ciclos','ultima_execucao_pousos','observacoes'],obrigatorios:['item','categoria','tipo_controle','base_legal']},
  oas:{tabela:'ctm_ordem_acompanhamento_servico',campos:['numero','objetivo','tipo_manutencao','data_entrada','oficina_nome','os_oficina','periodo','horas_celula','tipo_rateio','relatorio_voo_de','relatorio_voo_ate','total_pecas','total_mao_obra','mecanico_responsavel','observacoes','data_saida'],obrigatorios:['numero','objetivo','tipo_manutencao','data_entrada','tipo_rateio']},
  orcamentos:{tabela:'ctm_orcamentos',campos:['descricao','nome_fornecedor','tipo_fornecedor','valor_total','notas'],obrigatorios:['descricao','nome_fornecedor']},
  componentes:{tabela:'ctm_mapa_componente',campos:['nome','numero_da_peça','numero_de_serie','localizacao','fabricante','data_instalada','data_de_vencimento','data_leitura','total_horas_de_vida','horas_de_vida_atuais','ciclos_de_vida_totais','ciclos_de_vida_atuais','observacoes'],obrigatorios:['nome','data_instalada']},
  diretrizes:{tabela:'ctm_diretrizes',campos:['numero','titulo','tipo','aplicabilidade','data_vencimento','devido_horas','ciclos_devidos','status','metodo_de_conformidade','data_de_conformidade','observacoes'],obrigatorios:['numero','titulo','tipo','status']},
  ras:{tabela:'ctm_ras',campos:['numero','oas_numero','tipo_manutencao','descricao','objetivo','data_entrada','horas_celula_entrada','data_saida'],obrigatorios:['numero','tipo_manutencao','data_entrada']},
  pecas:{tabela:'ctm_pecas_trocadas',campos:['descricao','ordem_servico_id','p_n_removido','s_n_removido','p_n_instalado','s_n_instalado','quantidade','fornecedor','data_troca','valor_unitario','observacoes'],obrigatorios:['ordem_servico_id','descricao','quantidade']},
  oleo:{tabela:'ctm_analise_oleo',campos:['data_analise','ferro','cobre','aluminio','silicio','viscosidade'],obrigatorios:['data_analise']},
}
export const opcoes:Record<string,string[]> = {tipo_rateio:['percentual','horas'],categoria:['PREVENTIVA_PROGRAMADA','REGULATORIO_ANAC','VIDA_LIMITADA','DESGASTE','EMERGENCIA'],tipo_controle:['calendario','horas','pousos','ciclos','misto'],tipo_manutencao:['PREVENTIVA','CORRETIVA','PROGRAMADA','C.V.A'],tipo:['AD','SB'],status:['pending','urgent','complied','not_applicable']}
export const campoNumerico = (k:string) => /horas|intervalo_|ciclos|pousos|^total_|^valor_|^quantidade$|^(ferro|cobre|aluminio|silicio|viscosidade)$/.test(k)
export const campoData = (k:string) => /data_|_data$|relatorio_voo_/.test(k)
export function encerrado(r:Linha,modulo:string) {
  const status=[r.status,modulo==='orcamentos'?r.status_aprovacao:null].map(v=>String(v||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''))
  return Boolean(r.data_saida || r.assinado_em || r.assinatura || status.some(v=>/^(completed|cancelled|closed|complied|approved|resolved|encerrad[ao]|concluid[ao]|finalizad[ao]|aprovad[ao]|cancelad[ao])$/.test(v)))
}
