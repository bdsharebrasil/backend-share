export function selecionarAnexosEnvioPagamento(valor: unknown, ids: string[], cotistaId: string): Array<Record<string, unknown>> {
  let anexos: unknown = valor
  if (typeof anexos === 'string') {
    try { anexos = JSON.parse(anexos) } catch { return [] }
  }
  if (!Array.isArray(anexos)) return []
  const idsSelecionados = new Set(ids)
  return anexos.filter((anexo): anexo is Record<string, unknown> =>
    Boolean(anexo && typeof anexo === 'object') &&
    idsSelecionados.has(String((anexo as Record<string, unknown>).id ?? '')) &&
    (!String((anexo as Record<string, unknown>).cotista_id ?? '') || !cotistaId || String((anexo as Record<string, unknown>).cotista_id) === cotistaId),
  )
}
