export function normalizarHorarioAgendamento(data: string, valor: unknown): string | null {
  const texto = String(valor ?? '').trim()
  if (!texto) return null
  if (/^\d{4}-\d{2}-\d{2}T/.test(texto)) {
    const instante = new Date(texto)
    return Number.isFinite(instante.getTime()) ? instante.toISOString() : null
  }
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(texto)) return null
  // O portal recebe o horário civil de Brasília (UTC-03:00) e a coluna
  // armazena um instante ISO em Zulu, inclusive quando cruza a meia-noite.
  const hora = texto.length === 5 ? `${texto}:00` : texto
  const instante = new Date(`${data}T${hora}-03:00`)
  return Number.isFinite(instante.getTime()) ? instante.toISOString() : null
}

export function calcularDiasPeriodoAgendamento(inicio: string, fim: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fim) || fim < inicio) return null
  const inicioMs = Date.parse(`${inicio}T00:00:00Z`)
  const fimMs = Date.parse(`${fim}T00:00:00Z`)
  if (!Number.isFinite(inicioMs) || !Number.isFinite(fimMs)) return null
  if (new Date(inicioMs).toISOString().slice(0, 10) !== inicio || new Date(fimMs).toISOString().slice(0, 10) !== fim) return null
  return Math.floor((fimMs - inicioMs) / 86_400_000) + 1
}
