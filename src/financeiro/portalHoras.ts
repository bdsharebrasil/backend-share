import { minutosEntreHorarios } from './balancoOperacional'

/**
 * Mesma regra do Fechamento Balanço da Share Brasil:
 * tempo operacional AC→COR; voo DEP→POU; fallback nos tempos decimais
 * próprios (nunca trocar o denominador operacional pelo de voo).
 * TR/VT: uma etapa física dividida igualmente entre cotistas ativos.
 * Empréstimo: atribuir exclusivamente ao tomador identificado.
 */
export type VooPortal = Record<string, unknown> & { mes?: string; percentualAtribuido?: number }
export type CotaVooPortal = {
  id: string
  cliente_id: string | null
  socio_id: string | null
  percentual_sociedade: number | null
  status: string | null
}

const normalizar = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim()
const texto = (v: unknown) => String(v ?? '').trim()
const numero = (v: unknown): number | null => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
const verdadeiro = (v: unknown) => v === true || Number(v) === 1 || String(v).toLowerCase() === 'true'
const horasDecimais = (v: unknown) => {
  const n = numero(v)
  return n === null || n < 0 ? null : n * 60
}

export const vooCompartilhadoPortal = (v: VooPortal) =>
  !verdadeiro(v.voo_emprestado) && ['TR - TRASLADO', 'VT - VOO TESTE'].includes(normalizar(v.natureza_voo))

export function temposVooPortal(v: VooPortal) {
  return {
    minutosOperacionais: minutosEntreHorarios(v.tempo_ac, v.tempo_cor) ?? horasDecimais(v.tempo_total),
    minutosVoo: minutosEntreHorarios(v.tempo_dep, v.tempo_pou) ?? horasDecimais(v.tempo_voo),
  }
}

/** A base é o vínculo exato da sessão, não apenas um cliente com várias aeronaves. */
export function percentualVooCotistaPortal(
  voo: VooPortal,
  cotista: Pick<CotaVooPortal, 'id' | 'cliente_id' | 'socio_id'>,
  ativos: readonly CotaVooPortal[],
): number {
  if (vooCompartilhadoPortal(voo)) {
    const participantes = ativos.filter(c =>
      (c.status === null || ['ATIVO', 'ATIVA'].includes(normalizar(c.status)))
      && Number(c.percentual_sociedade) > 0)
    return participantes.some(c => c.id === cotista.id) ? 100 / participantes.length : 0
  }
  const emprestado = verdadeiro(voo.voo_emprestado)
  // Mesmo voo emprestado com tomador não identificado NÃO volta ao cedente.
  const clienteVoo = texto(emprestado ? voo.cliente_tomador_emprestimo_id : voo.cliente_id)
  const socioVoo = texto(emprestado ? voo.socio_tomador_emprestimo_id : voo.socio_id)
  if (!clienteVoo && !socioVoo) return 0
  return (clienteVoo && cotista.cliente_id === clienteVoo)
    || (socioVoo && cotista.socio_id === socioVoo) ? 100 : 0
}

export function voosDoCotistaPortal(
  voos: readonly VooPortal[],
  cotista: CotaVooPortal,
  ativos: readonly CotaVooPortal[],
): VooPortal[] {
  return voos.flatMap(v => {
    const porcentagem = percentualVooCotistaPortal(v, cotista, ativos)
    return porcentagem > 0 ? [{ ...v, percentualAtribuido: porcentagem }] : []
  })
}
