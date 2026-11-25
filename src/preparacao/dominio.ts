import { SECOES_CHECKLIST } from './estrutura';
export const ESTADOS = ['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDO', 'NAO_REALIZADO', 'NAO_APLICAVEL'] as const;
export type Estado = typeof ESTADOS[number];
export type Resposta = { estado: Estado; observacao: string; atualizado_em?: string; responsavel?: string };
export type ItemResposta = Resposta & { valor_acordado_tipo?: 'PESSOA' | 'TOTAL' };
export type Servico = Resposta & { id: string; tipo: string; cadastro_id?: string; origem?: string; dados: Record<string, string> };
export type Escala = { id: string; icao: string; cidade: string; servicos: Servico[] };
export type Trecho = { id: string; origem: string; destino: string; data: string; horario: string; fuso: string; pernoite: boolean; origem_escala_id: string; destino_escala_id: string };
export type Preparacao = { modelo: 1; itens: Record<string, ItemResposta>; nivel_oleo: string; observacoes: string; trechos: Trecho[]; escalas: Escala[] };
export const TIPOS_SERVICO = [
  { id: 'COMBUSTIVEL', nome: 'Combustível previsto / acionamento' },
  { id: 'HOTEL', nome: 'Hospedagem da tripulação' },
  { id: 'HANGAR', nome: 'Pátio / pernoite da aeronave' },
  { id: 'GPU', nome: 'GPU' }, { id: 'AR_CONDICIONADO', nome: 'Ar-condicionado' },
  { id: 'TRANSFER', nome: 'Transfer' }, { id: 'BALIZAMENTO', nome: 'Balizamento' },
  { id: 'PLANO_VOO', nome: 'Plano de voo / apresentação' },
  { id: 'METEO_NOTAM', nome: 'Meteorologia e NOTAM' },
];
export const SECOES = SECOES_CHECKLIST.map(s => ({ ...s, segmento: s.id === 'coordenacao' ? 'tripulacao' : 'aeronave', itens: s.itens.filter(i => i.id !== 'documentacao_aeronave') }));
SECOES.find(s => s.id === 'seguranca')!.itens.unshift({ id: 'documentacao_aeronave', label: 'Documentação da aeronave atualizada', tipo: 'documentos' });
export const ROTULOS: Record<string, string> = { PENDENTE:'Pendente', EM_ANDAMENTO:'Em andamento', CONCLUIDO:'Confirmado / realizado', NAO_REALIZADO:'Não realizado', NAO_APLICAVEL:'Não se aplica' };
const texto = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0,max);
export function novoServico(escala: string, tipo: string): Servico { return { id: `${escala}:${tipo}`, tipo, estado:'PENDENTE', observacao:'', dados:{} }; }
export function novaEscala(id: string, icao: string): Escala { return { id, icao, cidade:'', servicos:TIPOS_SERVICO.map(t => novoServico(id,t.id)) }; }
export function inicial(voo: any, legado: any): Preparacao {
  let respostas: any = legado?.itens || {};
  if(typeof legado?.respostas==='string')try{respostas=JSON.parse(legado.respostas||'{}');}catch{respostas={};}
  const itens: Preparacao['itens'] = {};
  for(const secao of SECOES) for(const i of secao.itens) {
    const r = respostas[i.id];
    const valorAcordadoTipo=i.id==='comissaria'?texto(r?.valor_acordado_tipo,10):'';
    itens[i.id] = { estado:r?.status === 'feito' ? 'CONCLUIDO' : r?.status === 'alerta' ? 'EM_ANDAMENTO' : r?.status === 'nao_feito' ? 'NAO_REALIZADO' : 'PENDENTE', observacao:r?.observacao || '', ...(i.id==='comissaria'&&['PESSOA','TOTAL'].includes(valorAcordadoTipo)?{valor_acordado_tipo:valorAcordadoTipo as 'PESSOA'|'TOTAL'}:{}) };
  }
  const previsto=String(voo.horario_previsto_agendamento||'');
  const comFuso=/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(previsto)&&Number.isFinite(Date.parse(previsto));
  const instante=comFuso?new Date(previsto).toISOString():null;
  const data=instante?instante.slice(0,10):String(voo.data_agendada||'').slice(0,10);
  const horario=instante?instante.slice(11,16):((previsto.match(/(?:T|^)(\d{2}:\d{2})/)||[])[1]||'');
  return { modelo:1,itens,nivel_oleo:legado?.nivel_oleo || '',observacoes:legado?.observacoes || '',
    trechos:[{ id:'t1',origem_escala_id:'e1',destino_escala_id:'e2',origem:voo.origem || '',destino:voo.destino || '',data,horario,fuso:comFuso?'UTC':'',pernoite:Number(voo.dias_duracao)>1 }],
    escalas:[novaEscala('e1',voo.origem || ''),novaEscala('e2',voo.destino || '')] };
}
function resposta(v: any): Resposta {
  if(!v || !ESTADOS.includes(v.estado)) throw new Error('estado_invalido');
  return { estado:v.estado,observacao:texto(v.observacao),atualizado_em:texto(v.atualizado_em,40),responsavel:texto(v.responsavel,160) };
}
export function validarDados(v: any): Preparacao {
  if(!v || v.modelo !== 1 || !Array.isArray(v.trechos) || !v.trechos.length || v.trechos.length>30 || !Array.isArray(v.escalas) || v.escalas.length>40) throw new Error('preparacao_invalida');
  const ids = new Set<string>();
  const itens: Preparacao['itens'] = {};
  for(const sec of SECOES) for(const item of sec.itens) {
    const r=v.itens?.[item.id],normalizada=resposta(r||{estado:'PENDENTE'});
    const valorAcordadoTipo=item.id==='comissaria'?texto(r?.valor_acordado_tipo,10):'';
    itens[item.id]={...normalizada,...(item.id==='comissaria'&&['PESSOA','TOTAL'].includes(valorAcordadoTipo)?{valor_acordado_tipo:valorAcordadoTipo as 'PESSOA'|'TOTAL'}:{})};
  }
  const trechos = v.trechos.map((t:any) => {
    const id=texto(t.id,80); if(!id || ids.has('t:'+id))throw new Error('trecho_invalido'); ids.add('t:'+id);
    const origem=texto(t.origem,100).toUpperCase(),destino=texto(t.destino,100).toUpperCase();
    if((origem && !/^[A-Z0-9]{4}$/.test(origem)) || (destino && !/^[A-Z0-9]{4}$/.test(destino))) throw new Error('icao_invalido');
    const data=texto(t.data,10); if(data && (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isFinite(Date.parse(data+'T12:00:00Z')) || new Date(data+'T12:00:00Z').toISOString().slice(0,10)!==data)) throw new Error('data_invalida');
    const horario=texto(t.horario,5);if(horario && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(horario))throw new Error('horario_invalido');
    const fuso=texto(t.fuso,80);if(fuso)try{new Intl.DateTimeFormat('pt-BR',{timeZone:fuso});}catch{throw new Error('fuso_invalido');}
    return {id,origem,destino,data,horario,fuso,pernoite:t.pernoite===true,origem_escala_id:texto(t.origem_escala_id,80),destino_escala_id:texto(t.destino_escala_id,80)};
  });
  const escalas=v.escalas.map((e:any)=>{
    const id=texto(e.id,80),icao=texto(e.icao,100).toUpperCase();
    if(!id || ids.has('e:'+id) || (icao && !/^[A-Z0-9]{4}$/.test(icao)))throw new Error('escala_invalida');ids.add('e:'+id);
    return {id,icao,cidade:texto(e.cidade,160),servicos:TIPOS_SERVICO.map(tipo=>{
      const s=(e.servicos||[]).find((s:any)=>s.tipo===tipo.id)||novoServico(id,tipo.id);
      const dados: Record<string,string>={};
      for(const [k,value] of Object.entries(s.dados||{})) { if(/^[a-z0-9_]{1,60}$/.test(k))dados[k]=texto(value); }
      const valorAcordadoTipo=texto(dados.valor_acordado_tipo,10);
      if(tipo.id==='HOTEL'&&['PESSOA','TOTAL'].includes(valorAcordadoTipo))dados.valor_acordado_tipo=valorAcordadoTipo;
      else delete dados.valor_acordado_tipo;
      return {...resposta(s),id:`${id}:${tipo.id}`,tipo:tipo.id,cadastro_id:texto(s.cadastro_id,100),origem:texto(s.origem,50),dados};
    })};
  });
  for(const t of trechos)for(const lado of ['origem','destino'] as const){const e=escalas.find((e:any)=>e.id===t[lado+'_escala_id']);if(!e||e.icao!==t[lado])throw new Error('roteiro_escalas_invalidos');}
  return {modelo:1,itens,nivel_oleo:texto(v.nivel_oleo,160),observacoes:texto(v.observacoes,8000),trechos,escalas};
}
export function cafeDaManha(value: unknown) {
  const t=texto(value,80).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  if(t==='INCLUIDO')return {estado:'INCLUIDO',valor:''};
  if(['NAO','NAO_OFERECE'].includes(t))return {estado:'NAO_OFERECE',valor:''};
  if(t==='A_PARTE')return {estado:'A_PARTE',valor:''};
  const n=Number(t.replace(',','.'));if(t && Number.isFinite(n)&&n>0)return{estado:'A_PARTE',valor:n.toFixed(2)};
  return {estado:'A_CONFIRMAR',valor:'',oferece:t==='SIM'};
}
export function resumo(dados: Preparacao) {
  const linhas: any[]=[];
  for(const secao of SECOES)for(const i of secao.itens)linhas.push({grupo:secao.segmento,secao:secao.titulo,item:i.label,...dados.itens[i.id]});
  for(const e of dados.escalas)for(const s of e.servicos)linhas.push({grupo:'tripulacao',secao:e.icao,item:TIPOS_SERVICO.find(t=>t.id===s.tipo)?.nome,...s});
  for(const e of dados.escalas)for(const s of e.servicos)if(s.tipo==='HOTEL'&&s.estado==='CONCLUIDO'&&!['INCLUIDO','A_PARTE','NAO_OFERECE'].includes(s.dados.cafe_estado))linhas.push({grupo:'tripulacao',secao:e.icao,item:'Café da manhã: condição a confirmar',estado:'PENDENTE',observacao:'Confirmar se o café está incluído, é cobrado à parte ou não é oferecido.'});
  // Óleo omitido é uma pendência visível, nunca um impedimento à conclusão.
  if(!dados.nivel_oleo.trim())linhas.push({grupo:'aeronave',secao:'Check externo',item:'Nível de óleo',estado:'PENDENTE',observacao:''});
  const pendencias=linhas.filter(l=>!['CONCLUIDO','NAO_APLICAVEL'].includes(l.estado));
  return {total:linhas.length,resolvidos:linhas.length-pendencias.length,pendencias:pendencias.length,linhas};
}
export function carimbar(anterior: Preparacao, novo: Preparacao, nome: string, agora: string) {
  for(const [id,r] of Object.entries(novo.itens)) {
    const old=anterior.itens[id];if(!old || old.estado!==r.estado || old.observacao!==r.observacao){r.atualizado_em=agora;r.responsavel=nome;}else {r.atualizado_em=old.atualizado_em;r.responsavel=old.responsavel;}
  }
  for(const e of novo.escalas)for(const s of e.servicos){
    const anteriorEscala=anterior.escalas.find(x=>x.id===e.id);
    const contexto=(p:Preparacao)=>JSON.stringify(p.trechos.filter(t=>t.origem_escala_id===e.id||t.destino_escala_id===e.id).map(t=>[t.id,t.data,t.horario,t.fuso,t.pernoite]));
    if(anteriorEscala&&(anteriorEscala.icao!==e.icao||contexto(anterior)!==contexto(novo))&&s.estado==='CONCLUIDO'){s.estado='EM_ANDAMENTO';s.observacao=[s.observacao,'Roteiro alterado; reconfirmar este serviço.'].filter(Boolean).join(' ');}
    const old=anterior.escalas.find(x=>x.id===e.id)?.servicos.find(x=>x.id===s.id);
    if(!old || JSON.stringify([old.estado,old.observacao,old.dados,old.cadastro_id||'',old.origem||''])!==JSON.stringify([s.estado,s.observacao,s.dados,s.cadastro_id||'',s.origem||''])){s.atualizado_em=agora;s.responsavel=nome;}else {s.atualizado_em=old.atualizado_em;s.responsavel=old.responsavel;}
  }
  return novo;
}
