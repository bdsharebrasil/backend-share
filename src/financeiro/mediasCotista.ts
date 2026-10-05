export type VooMediasCotista = {
  data_registro: string | null
  tempo_total: number | string | null
  pousos_total: number | string | null
}

export type MediasCotista = {
  horas_voadas: number
  total_voos: number
  total_pousos: number
  custo_por_hora_centavos: number
  dia_mais_utilizado: string | null
  media_mensal_horas: number
  custo_medio_por_voo_centavos: number
}

export type MediasCotistaMensais = MediasCotista & { mes: string }

const DIAS_SEMANA = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado']

function numero(valor: number | string | null | undefined): number {
  const resultado = Number(valor ?? 0)
  return Number.isFinite(resultado) ? resultado : 0
}

export function calcularMediasCotista(voos: VooMediasCotista[], custoCentavos: number): MediasCotista {
  const horasVoadas = voos.reduce((total, voo) => total + Math.max(0, numero(voo.tempo_total)), 0)
  const totalPousos = voos.reduce((total, voo) => total + Math.max(0, numero(voo.pousos_total)), 0)
  const meses = new Set<string>()
  const dias = new Map<number, number>()

  for (const voo of voos) {
    const data = String(voo.data_registro ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) continue
    meses.add(data.slice(0, 7))
    const dia = new Date(`${data}T00:00:00Z`).getUTCDay()
    dias.set(dia, (dias.get(dia) ?? 0) + 1)
  }

  const diaMaisUtilizado = dias.size
    ? DIAS_SEMANA[[...dias.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]]
    : null
  const custo = Math.max(0, numero(custoCentavos))

  return {
    horas_voadas: Number(horasVoadas.toFixed(2)),
    total_voos: voos.length,
    total_pousos: Math.round(totalPousos),
    custo_por_hora_centavos: horasVoadas > 0 ? Math.round(custo / horasVoadas) : 0,
    dia_mais_utilizado: diaMaisUtilizado,
    media_mensal_horas: meses.size ? Number((horasVoadas / meses.size).toFixed(2)) : 0,
    custo_medio_por_voo_centavos: voos.length ? Math.round(custo / voos.length) : 0,
  }
}

export function calcularMediasCotistaPorMes(
  voos: VooMediasCotista[],
  custosPorMes: ReadonlyMap<string, number>,
): MediasCotistaMensais[] {
  const voosPorMes = new Map<string, VooMediasCotista[]>()
  for (const voo of voos) {
    const data = String(voo.data_registro ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) continue
    const mes = data.slice(0, 7)
    const itens = voosPorMes.get(mes) ?? []
    itens.push(voo)
    voosPorMes.set(mes, itens)
  }

  const meses = new Set([...voosPorMes.keys(), ...custosPorMes.keys()])
  return [...meses].sort().map((mes) => ({
    mes,
    ...calcularMediasCotista(voosPorMes.get(mes) ?? [], custosPorMes.get(mes) ?? 0),
  }))
}
