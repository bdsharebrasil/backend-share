import { instanteUtc, numeroMinutos } from './jornadaTempo'

export const LIMITES_SISTEMA_JORNADA = { dia: 540, semana: 2640, mes: 10560, posCorte: 30 } as const
export type FonteCalculoJornada = {
  horario_apresentacao?: string | null
  horario_corte?: string | null
  minutos_pos_corte?: number | string | null
  minutos_jornada?: number | string | null
  status?: string
  data?: string
  pernas?: Array<{ horario_ac?: string | null; horario_corte?: string | null; numero?: number }>
}
export function posCorteJornada(jornada: FonteCalculoJornada): number {
  return numeroMinutos(jornada.minutos_pos_corte) ?? LIMITES_SISTEMA_JORNADA.posCorte
}
export function minutosIntervalo(inicio: string | null | undefined, fim: string | null | undefined): number | null {
  const a = instanteUtc(inicio); const b = instanteUtc(fim)
  return a !== null && b !== null && b >= a ? Math.round((b - a) / 60_000) : null
}
export function calcularMinutosJornada(jornada: FonteCalculoJornada, fimPrevisto?: string | null, agora = new Date().toISOString()): number | null {
  // O valor salvo é a fonte do histórico. Uma simulação explícita recalcula.
  if (jornada.status === 'encerrada' && !fimPrevisto) {
    const salvo = numeroMinutos(jornada.minutos_jornada)
    if (salvo !== null) return salvo
  }
  const pernas = [...(jornada.pernas || [])].sort((a, b) => (a.numero || 0) - (b.numero || 0))
  const ultima = pernas[pernas.length - 1]
  const corte = pernas.length ? ultima?.horario_corte : jornada.horario_corte
  const fim = fimPrevisto || corte || (jornada.status !== 'encerrada' ? agora : null)
  // AC não substitui apresentação. POU não substitui COR no histórico.
  const intervalo = minutosIntervalo(jornada.horario_apresentacao, fim)
  return intervalo === null ? null : intervalo + posCorteJornada(jornada)
}
export function referenciaJornada(jornada: FonteCalculoJornada, fimPrevisto?: string | null, agora = new Date().toISOString()): string {
  const pernas = jornada.pernas || []
  const corte = fimPrevisto || (pernas.length ? pernas[pernas.length - 1]?.horario_corte : jornada.horario_corte)
  const instante = instanteUtc(corte)
  if (instante !== null) return new Date(instante + posCorteJornada(jornada) * 60_000).toISOString()
  if (jornada.status === 'encerrada') {
    const apresentacao = instanteUtc(jornada.horario_apresentacao)
    if (apresentacao !== null) return new Date(apresentacao).toISOString()
    const data = instanteUtc(`${jornada.data?.slice(0, 10)}T23:59:59Z`)
    if (data !== null) return new Date(data).toISOString()
  }
  return agora
}

export type RegistroAcumulacao = FonteCalculoJornada & {
  id: string; tripulante_id?: string | null; jornada_principal_id?: string | null; data: string
}
export function somarAcumuladosRegistrados(registros: RegistroAcumulacao[], data: string, referencia: string, ignorarId = '') {
  const dia = instanteUtc(`${data.slice(0, 10)}T00:00:00Z`)
  const ref = instanteUtc(referencia)
  if (dia === null || ref === null) return { semana: 0, mes: 0, registros_incompletos: 1 }
  const inicioSemana = dia - 6 * 86_400_000
  const mesAlvo = data.slice(0, 7)
  const porRaiz = new Map<string, RegistroAcumulacao>()
  const ignorado = registros.find((registro) => registro.id === ignorarId)
  const raizIgnorada = ignorado?.jornada_principal_id || ignorado?.id
  for (const registro of registros) {
    if (registro.id === ignorarId || registro.status !== 'encerrada') continue
    const raiz = registro.jornada_principal_id || registro.id
    if (raizIgnorada && raiz === raizIgnorada) continue
    const chave = `${registro.tripulante_id || ''}:${raiz}`
    if (!porRaiz.has(chave) || registro.id === raiz) porRaiz.set(chave, registro)
  }
  let semana = 0; let mes = 0; let incompletos = 0
  for (const registro of porRaiz.values()) {
    const diaRegistro = instanteUtc(`${registro.data.slice(0, 10)}T00:00:00Z`)
    if (diaRegistro === null) { incompletos++; continue }
    if (diaRegistro > dia) continue
    const naSemana = diaRegistro >= inicioSemana
    const noMes = registro.data.slice(0, 7) === mesAlvo
    if (!naSemana && !noMes) continue
    const corte = instanteUtc(registro.horario_corte)
    const fim = corte !== null ? corte + posCorteJornada(registro) * 60_000 : null
    if (fim !== null && fim > ref) continue
    const minutos = numeroMinutos(registro.minutos_jornada)
    if (minutos === null) { incompletos++; continue }
    if (fim === null) incompletos++
    if (naSemana) semana += minutos
    if (noMes) mes += minutos
  }
  return { semana, mes, registros_incompletos: incompletos }
}
