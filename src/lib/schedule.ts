export function normalizarHorarioAgendamento(data: string, valor: unknown): string | null {
  const texto = String(valor ?? '').trim()
  if (!texto) return null
  if (/^\d{4}-\d{2}-\d{2}T/.test(texto)) {
    const instante = new Date(texto)
    return Number.isFinite(instante.getTime()) ? instante.toISOString() : null
  }
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(texto)) return null
  const instante = new Date(`${data}T${texto.length === 5 ? `${texto}:00` : texto}Z`)
  return Number.isFinite(instante.getTime()) ? instante.toISOString() : null
}