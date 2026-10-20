/** Valores em centavos. Custos por competência; pagamentos até a data de corte.
 * Não usa lançamentos de caixa como despesas e não considera zero como ausente.
 */
export type ParticipanteBalanco = { id: string; nome: string; dominio: string }
export type RateioBalanco = {
  id: string; participanteId: string; dominio: string; origemChave: string;
  competencia: string; categoria: string; descricao: string; tipo: string;
  devido: number; pagoReal: number; pagadorId: string | null;
  direto: boolean; dataPagamento: string | null; status: string;
}
export type PagamentoBalanco = {
  id: string; rateioId: string; pagadorId: string | null;
  valor: number; data: string; status: string; tipoPagador?: string;
}
export type AjusteBalanco = {
  id: string; origemRateioId: string; destinoRateioId: string; valor: number; motivo: string;
}
function centavos(n: number) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Valor deve ser inteiro não negativo em centavos')
  return n
}
const ativos = (s: string) => !['CANCELADO', 'ESTORNO'].includes(s.toUpperCase())
export function calcularBalancoMensal(
  participantes: ParticipanteBalanco[], rateios: RateioBalanco[], pagamentos: PagamentoBalanco[],
  ajustes: AjusteBalanco[], inicio: string, fim: string, meses?: string[],
) {
  const avisos = new Set<string>()
  const cad = new Map(participantes.map(p => [p.id, p]))
  const todas = new Map(rateios.filter(r => ativos(r.status)).map(r => [r.id, { ...r, devido: centavos(r.devido) }]))
  for (const a of ajustes) {
    const de = todas.get(a.origemRateioId), para = todas.get(a.destinoRateioId)
    if (!de || !para || de.origemChave.startsWith('SEM_VINCULO:') || de.origemChave !== para.origemChave || de.dominio !== para.dominio || de.competencia !== para.competencia) {
      throw new Error(`Ajuste incompatível: ${a.id}`)
    }
    const valor = centavos(a.valor)
    if (valor > de.devido) throw new Error(`Ajuste supera o devido: ${a.id}`)
    de.devido -= valor; para.devido += valor
  }
  if ([...todas.values()].some(r => !/^\d{4}-\d{2}-\d{2}$/.test(r.competencia))) avisos.add('Rateio sem competência válida: não incluído; corrigir antes de fechar.')
  const chaves = new Set<string>()
  for (const r of todas.values()) {
    const chave = `${r.origemChave}|${r.participanteId}|${r.competencia}`
    if (chaves.has(chave)) avisos.add('Mesma despesa repetida para o cotista: revisar origem, cobrança e espelho de reembolso.')
    chaves.add(chave)
  }
  const linhas = [...todas.values()].filter(r => r.competencia >= inicio && r.competencia <= fim && (!meses || meses.includes(r.competencia.slice(0, 7))))
  if (linhas.some(r => r.origemChave.startsWith('SEM_VINCULO:'))) avisos.add('Rateio sem origem identificada ou com referência ambígua: conferir lançamento/envio/movimento; ajuste entre cotistas bloqueado.')
  const saldos = new Map(participantes.map(p => [p.id, { ...p, devidoCentavos: 0, pagoCentavos: 0, saldoCentavos: 0 }]))
  const matrizBruta: Record<string, Record<string, number>> = {}
  const grupos = new Map<string, typeof linhas>()
  const credito = (id: string | null, valor: number, dominio: string) => {
    if (!id || cad.get(id)?.dominio !== dominio) {
      if (valor) avisos.add('Pagamento sem cotista identificável no mesmo grupo: revisar pagador; caixa conjunto não é pagamento pessoal.')
      return false
    }
    saldos.get(id)!.pagoCentavos += valor; return true
  }
  const atribuir = (pagador: string, beneficiario: string, valor: number) => {
    if (pagador === beneficiario || !valor) return
    matrizBruta[pagador] ??= {}; matrizBruta[pagador][beneficiario] = (matrizBruta[pagador][beneficiario] || 0) + valor
  }
  for (const r of linhas) {
    if (!saldos.has(r.participanteId)) throw new Error(`Rateio sem cotista: ${r.id}`)
    saldos.get(r.participanteId)!.devidoCentavos += r.devido
    const chave = `${r.dominio}|${r.origemChave}`
    const grupo = grupos.get(chave) || []; grupo.push(r); grupos.set(chave, grupo)
  }
  const ledgerPorRateio = new Map<string, PagamentoBalanco[]>()
  for (const p of pagamentos) {
    // A presença de histórico impede reutilizar o agregado legado, inclusive após estorno.
    const arr = ledgerPorRateio.get(p.rateioId) || []; arr.push(p); ledgerPorRateio.set(p.rateioId, arr)
  }
  const despesas: Array<{ chave: string; dominio: string; competencia: string; descricao: string; categoria: string; tipo: string; totalCentavos: number; pagoCentavos: number; pendenteCentavos: number; excessoCentavos: number; rateios: Array<{ id: string; participanteId: string; valorCentavos: number; percentual: number }>; pagamentos: Array<{ pagadorId: string; valorCentavos: number }>; cobertura: Array<{ pagadorId: string; beneficiarioId: string; valorCentavos: number }> }> = []
  for (const grupo of grupos.values()) {
    const comLedger = grupo.filter(r => ledgerPorRateio.has(r.id))
    if (comLedger.length && comLedger.length !== grupo.length && grupo.some(r => !ledgerPorRateio.has(r.id) && r.pagoReal > 0)) {
      avisos.add('Despesa mistura pagamentos por evento e campos legados; conciliar antes de fechar.')
    }
    const pagos = new Map<string, number>()
    const registrar = (pagador: string | null, v: number, dominio: string) => {
      if (credito(pagador, v, dominio)) pagos.set(pagador!, (pagos.get(pagador!) || 0) + v)
    }
    // A fonte de dinheiro é o evento; o beneficiário econômico vem do rateio
    // ajustado. Pagamentos parciais cobrem proporcionalmente o custo da despesa.
    for (const r of comLedger) for (const p of ledgerPorRateio.get(r.id)!) {
      if (p.status.toUpperCase() !== 'CONFIRMADO' || p.data > fim) continue
      // SHARE/HOLDING são fontes coletivas conhecidas: não são desembolso pessoal
      // nem inconsistência de identidade. O ledger também impede fallback legado.
      if (['SHARE', 'HOLDING'].includes(String(p.tipoPagador || '').toUpperCase())) continue
      registrar(p.pagadorId, centavos(p.valor), r.dominio)
    }
    for (const r of grupo.filter(r => !ledgerPorRateio.has(r.id))) {
      const v = centavos(r.pagoReal)
      if (!v) continue
      if (!r.dataPagamento) { avisos.add('Pagamento legado sem data: não incluído no corte.'); continue }
      if (r.dataPagamento > fim) continue
      // Pagamentos não diretos são liquidados por caixa comum; não são crédito pessoal.
      if (!r.direto) continue
      registrar(r.pagadorId, v, r.dominio)
    }
    const totalPago = [...pagos.values()].reduce((s, v) => s + v, 0)
    const totalDevido = grupo.reduce((s, r) => s + r.devido, 0)
    const detalhe = { chave: `${grupo[0].dominio}|${grupo[0].origemChave}`, dominio: grupo[0].dominio, competencia: grupo[0].competencia, descricao: grupo[0].descricao, categoria: grupo[0].categoria, tipo: grupo[0].tipo, totalCentavos: totalDevido, pagoCentavos: totalPago, pendenteCentavos: Math.max(0, totalDevido-totalPago), excessoCentavos: Math.max(0, totalPago-totalDevido), rateios: grupo.map(r => ({ id: r.id, participanteId: r.participanteId, valorCentavos: r.devido, percentual: totalDevido ? r.devido/totalDevido*100 : 0 })), pagamentos: [...pagos].map(([pagadorId, valorCentavos]) => ({ pagadorId, valorCentavos })), cobertura: [] as Array<{ pagadorId: string; beneficiarioId: string; valorCentavos: number }> }
    despesas.push(detalhe)
    const idsPagadores = [...pagos.keys()]
    const cobertura = totalDevido ? distribuirCentavos(Math.min(totalPago, totalDevido), [...pagos.values()]) : idsPagadores.map(() => 0)
    for (const [indice, pagador] of idsPagadores.entries()) {
      const v = cobertura[indice]
      if (!totalDevido) { avisos.add('Pagamento sem custo correspondente.'); continue }
      const partes = distribuirCentavos(v, grupo.map(r => r.devido))
      grupo.forEach((r, i) => { atribuir(pagador, r.participanteId, partes[i]); detalhe.cobertura.push({pagadorId: pagador, beneficiarioId: r.participanteId, valorCentavos: partes[i]}) })
    }
    if (totalPago > totalDevido) avisos.add('Pagamento supera o custo: revisar duplicidade ou adiantamento.')
    if (grupo.some(r => r.origemChave.startsWith('SEM_VINCULO:')) && grupo.some(r => r.pagoReal > r.devido)) {
      avisos.add('Pagamento integral sem referência válida de origem: vincular todos os rateios à mesma origem antes de compensar.')
    }
  }
  const resultado = [...saldos.values()].map(s => ({ ...s, saldoCentavos: s.pagoCentavos - s.devidoCentavos }))
  const compensacoes: Array<{ deId: string; paraId: string; valorCentavos: number }> = []
  // Compensação bilateral conserva a relação por despesa, como ANÁL. BAL do Excel.
  const ids = [...cad.keys()].sort()
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i], b = ids[j]
    if (cad.get(a)?.dominio !== 'CLIENTES' || cad.get(b)?.dominio !== 'CLIENTES') continue
    const liquido = (matrizBruta[a]?.[b] || 0) - (matrizBruta[b]?.[a] || 0)
    if (liquido) compensacoes.push({ deId: liquido > 0 ? b : a, paraId: liquido > 0 ? a : b, valorCentavos: Math.abs(liquido) })
  }
  const custoTotalCentavos = resultado.reduce((s, r) => s + r.devidoCentavos, 0)
  const pagoPessoalCentavos = resultado.reduce((s, r) => s + r.pagoCentavos, 0)
  return {
    inicio, fim, saldos: resultado, linhas, ajustes, matrizBruta, compensacoes, despesas,
    custoTotalCentavos, pagoPessoalCentavos,
    diferencaCustoPagamentoCentavos: custoTotalCentavos - pagoPessoalCentavos,
    avisos: [...avisos], status: 'PRELIMINAR' as const,
  }
}
/** Rateio por cotas, horas ou percentuais: pesos não negativos; soma exata. */
export function distribuirCentavos(total: number, pesos: number[]): number[] {
  centavos(total)
  if (pesos.some(p => !Number.isFinite(p) || p < 0)) throw new Error('Pesos inválidos')
  const soma = pesos.reduce((s, n) => s + n, 0)
  if (!soma) { if (total) throw new Error('Sem base de rateio: informar percentual ou horas'); return pesos.map(() => 0) }
  const valores = pesos.map(p => total * p / soma)
  const partes = valores.map(Math.floor)
  const ordem = valores.map((v, i) => ({ i, resto: v - partes[i] })).sort((a, b) => b.resto - a.resto || a.i - b.i)
  const sobra = total - partes.reduce((s, n) => s + n, 0)
  for (let k = 0; k < sobra; k++) partes[ordem[k].i]++
  return partes
}

/** Simulação de uma NOVA despesa integralmente paga. Não grava nem troca responsabilidades. */
export function simularProximaDespesa(
  balanco: ReturnType<typeof calcularBalancoMensal>, valor: number,
  pesos: Array<{ id: string; peso: number }>,
) {
  centavos(valor)
  const clientes = balanco.saldos.filter(s => s.dominio === 'CLIENTES')
  const ids = new Set(clientes.map(s => s.id))
  if (new Set(pesos.map(p => p.id)).size !== pesos.length || pesos.some(p => !ids.has(p.id))) throw new Error('Participantes inválidos')
  if (balanco.avisos.length) throw new Error('Concilie os avisos antes de simular')
  const partes = distribuirCentavos(valor, pesos.map(p => p.peso))
  const devido = new Map(pesos.map((p,i) => [p.id, partes[i]]))
  const custoAtual = balanco.compensacoes.reduce((s,c) => s+c.valorCentavos,0)
  const cenarios = clientes.map(pagador => {
    const compensacoes: Array<{deId:string;paraId:string;valorCentavos:number}> = []
    for (let i=0;i<clientes.length;i++) for(let j=i+1;j<clientes.length;j++) {
      const a=clientes[i].id,b=clientes[j].id
      const liquido=(balanco.matrizBruta[a]?.[b]||0)-(balanco.matrizBruta[b]?.[a]||0)
        +(pagador.id===a?(devido.get(b)||0):0)-(pagador.id===b?(devido.get(a)||0):0)
      if(liquido) compensacoes.push({deId:liquido>0?b:a,paraId:liquido>0?a:b,valorCentavos:Math.abs(liquido)})
    }
    const totalAcertoCentavos=compensacoes.reduce((s,c)=>s+c.valorCentavos,0)
    return {pagadorId:pagador.id,nome:pagador.nome,totalAcertoCentavos,reducaoCentavos:custoAtual-totalAcertoCentavos,compensacoes,
      saldos:clientes.map(s=>({...s,devidoCentavos:s.devidoCentavos+(devido.get(s.id)||0),pagoCentavos:s.pagoCentavos+(s.id===pagador.id?valor:0),saldoCentavos:s.saldoCentavos+(s.id===pagador.id?valor:0)-(devido.get(s.id)||0)}))}
  }).sort((a,b)=>a.totalAcertoCentavos-b.totalAcertoCentavos||a.nome.localeCompare(b.nome))
  return {custoAtualCentavos:custoAtual,rateios:pesos.map((p,i)=>({id:p.id,valorCentavos:partes[i]})),cenarios}
}
