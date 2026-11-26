import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ROTULOS, TIPOS_SERVICO } from './dominio';
const dataBR=(v:unknown)=>/^\d{4}-\d{2}-\d{2}$/.test(String(v))?String(v).split('-').reverse().join('/'):String(v||'');
const normalizar=(s:unknown)=>String(s??'').replace(/[\u0000-\u001f]/g,' ').replace(/[^\u0020-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u20ac]/g,' ');
export async function gerarBriefing(s:any, reservas:any[]=[],anexos:any[]=[],abastecimentos:any[]=[]) {
  const doc=await PDFDocument.create(), regular=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
  let page:any,y=0;const w=595,h=842,margin=42;
  function novaPagina(){page=doc.addPage([w,h]);y=h-margin;page.drawRectangle({x:0,y:h-9,width:w,height:9,color:rgb(.04,.35,.51)});if(doc.getPageCount()>1){page.drawText(`SHARE BRASIL | Voo ${normalizar(s.voo.numero_voo||'')} | Versão ${s.versao}`,{x:margin,y,size:8,font:bold,color:rgb(.3,.4,.5)});y-=24;}}
  function linha(txt:unknown,size=10,forte=false){const font=forte?bold:regular;const words=normalizar(txt).split(/\s+/).flatMap(word=>{const parts=[];let part='';for(const ch of word){if(font.widthOfTextAtSize(part+ch,size)>w-2*margin&&part){parts.push(part);part='';}part+=ch;}if(part)parts.push(part);return parts;});let row='';
    for(const word of words){const next=(row?row+' ':'')+word;if(font.widthOfTextAtSize(next,size)>w-2*margin && row){desenhar(row);row=word;}else row=next;}if(row)desenhar(row);
    function desenhar(value:string){if(y<margin+25)novaPagina();page.drawText(value,{x:margin,y,size,font,color:rgb(.10,.16,.22)});y-=size+5;}
  }
  function secao(t:string){if(y<margin+65)novaPagina();y-=14;linha(t,13,true);y-=3;}
  const cafe:any={INCLUIDO:'Incluído na diária',A_PARTE:'Pago à parte',NAO_OFERECE:'Não oferece',A_CONFIRMAR:'Inclusão a confirmar'};
  novaPagina();linha('SHARE BRASIL | BRIEFING OPERACIONAL',11,true);y-=10;
  linha(`Voo ${s.voo.numero_voo || 'sem número'} | ${s.voo.matricula_registro || ''}`,21,true);
  linha(`Versão ${s.versao} | Atualizado em ${s.atualizado_em ? String(s.atualizado_em).replace('T',' ').replace(/\.\d+Z$/,'').replace(/Z$/,'') : 'registro anterior'} (UTC)`,9);
  linha(s.finalizado_em?(s.resumo.pendencias?`PREPARAÇÃO FINALIZADA COM ${s.resumo.pendencias} PENDÊNCIA(S)`:'PREPARAÇÃO FINALIZADA'):'PREPARAÇÃO EM ANDAMENTO',11,true);
  linha(`Coordenação / última atualização: ${s.atualizado_por_nome || 'Não informado'}`);
  linha(`Comandante: ${s.voo.piloto_nome||'A confirmar'} | Copiloto: ${s.voo.copiloto_nome||'A confirmar'}`);
  linha(`Passageiros: ${s.voo.numero_passageiros ?? 'A confirmar'}`);
  secao('Roteiro planejado');
  for(const t of s.dados.trechos)linha(`${t.origem} > ${t.destino} | ${dataBR(t.data) || 'Data a confirmar'} ${t.horario || 'Horário a confirmar'} | ${t.fuso || 'Fuso a confirmar'}${t.pernoite?' | Pernoite':''}`);
  for(const e of s.dados.escalas){secao(`Coordenação por escala | ${e.icao}${e.cidade?' | '+e.cidade:''}`);
    for(const serv of e.servicos){if(y<margin+70)novaPagina();linha(`${TIPOS_SERVICO.find(t=>t.id===serv.tipo)?.nome}: ${ROTULOS[serv.estado]}`,11,true);
      const dados=serv.dados||{};
      const labels:any={nome:'Fornecedor / hotel',nome_fornecedor:'Fornecedor',codigo_icao:'Código ICAO',telefone:'Telefone',email:'E-mail',endereco:'Endereço',cidade:'Cidade',preco_single:'Diária single de referência',preco_duplo:'Diária dupla de referência',valor:'Valor de referência',valor_acordado:'Valor acordado',disponibilidade:'Disponibilidade cadastrada',contato:'Contato',pessoa_contato:'Pessoa de contato',checkin:'Check-in',checkout:'Check-out',quartos:'Quartos',tipo_quarto:'Tipo de quarto',hospedes:'Hóspedes',preco_jet:'Preço Jet',preco_avgas:'Preço Avgas',quantidade_hospedes:'Quantidade de hóspedes',telefone_hospede:'Telefone do hóspede',cadastro:'Cadastro no fornecedor',acionamento:'Acionamento',protocolo:'Protocolo / confirmação',fuso:'Fuso'};
      for(const [k,label]of Object.entries(labels))if(dados[k])linha(`${label}: ${dados[k]}`);
      if(serv.tipo==='HOTEL')linha(`Café da manhã: ${cafe[dados.cafe_estado]||'A confirmar'}${dados.cafe_valor?' | R$ '+dados.cafe_valor:''}`);
      linha(`Observações: ${serv.observacao||(['CONCLUIDO','NAO_APLICAVEL'].includes(serv.estado)?'Sem observação.':'Motivo não informado.')}`);if(serv.responsavel)linha(`Atualizado por ${serv.responsavel} em ${serv.atualizado_em}`,8);
      for(const r of reservas.filter((r:any)=>r.servico_id===serv.id))linha(`Solicitação de reserva: ${r.status==='ENVIADO'?'E-mail enviado; confirmação conforme situação acima':r.status==='FALHA'?'Falha no envio':'Envio pendente'} | ${r.enviado_em||r.criado_em}`,9);
      for(const a of anexos.filter((a:any)=>a.servico_id===serv.id))linha(`Anexo: ${a.nome}`,9);
    }
  }
  const pendentes=s.resumo.linhas.filter((r:any)=>!['CONCLUIDO','NAO_APLICAVEL'].includes(r.estado));
  if(pendentes.length){secao('Pendências da preparação');
    for(const estado of ['PENDENTE','EM_ANDAMENTO','NAO_REALIZADO']){const total=pendentes.filter((r:any)=>r.estado===estado).length;if(total)linha(`${ROTULOS[estado]}: ${total}`,10,true);}
    linha('Situações e motivos estão detalhados nos registros deste relatório.',9);
    for(const r of pendentes.filter((r:any)=>r.secao==='Roteiro'||r.item==='Nível de óleo'||r.item.startsWith('Café da manhã:'))){linha(`${r.secao} | ${r.item}`,10,true);linha(r.observacao||'Motivo não informado.');}
  }
  secao('Tripulação | conferência geral');
  for(const r of s.resumo.linhas.filter((r:any)=>r.grupo==='tripulacao'&&r.secao==='Coordenação de voo')){if(y<margin+48)novaPagina();linha(`${r.item}: ${ROTULOS[r.estado]}`,10,true);linha(r.observacao||(['CONCLUIDO','NAO_APLICAVEL'].includes(r.estado)?'Sem observação.':'Motivo não informado.'));if(r.responsavel)linha(`${r.responsavel} | ${r.atualizado_em||''}`,8);}
  secao('Aeronave | registro completo');
  for(const r of s.resumo.linhas.filter((r:any)=>r.grupo==='aeronave')){if(y<margin+48)novaPagina();linha(`${r.item}: ${ROTULOS[r.estado]}`,10,true);linha(r.observacao||(['CONCLUIDO','NAO_APLICAVEL'].includes(r.estado)?'Sem observação.':'Motivo não informado.'));if(r.responsavel)linha(`${r.responsavel} | ${r.atualizado_em||''}`,8);}
  linha(`Óleo: ${s.dados.nivel_oleo || 'Não informado'}`);
  secao('Abastecimentos realizados');if(!abastecimentos.length)linha('Nenhum abastecimento realizado registrado nesta preparação.');
  for(const a of abastecimentos)linha(`${a.local} | ${a.data} | ${a.tipo_combustivel} | ${a.litros} L | R$ ${a.valor_unitario}/L | Total R$ ${Number(a.valor_total||0).toFixed(2)} | Comanda ${a.numero_comanda||'não informada'}`);
  secao('Observações gerais');linha(s.dados.observacoes||'Sem observações.');
  const pages=doc.getPages();pages.forEach((p,i)=>p.drawText(`Share Brasil | Voo ${normalizar(s.voo.numero_voo||'')} | V${s.versao} | ${i+1}/${pages.length}`,{x:margin,y:22,size:8,font:regular,color:rgb(.4,.46,.5)}));
  return doc.save();
}
