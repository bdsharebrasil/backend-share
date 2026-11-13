type EstadoRelatorio = {
  status?: unknown
  status_aprovacao_tripulante?: unknown
  status_aprovacao_tripulante_2?: unknown
  token_aprovacao_tripulante_1?: unknown
  token_aprovacao_tripulante_2?: unknown
  aprovado_tripulante_em?: unknown
  aprovado_tripulante_1_em?: unknown
  aprovado_tripulante_2_em?: unknown
}
type RelatorioAtual = EstadoRelatorio & {
  id: string
  numero_relatorio: string | null
  pdf_path: string | null
}
const normalizar = (valor: unknown) =>
  String(valor ?? '')
    .trim()
    .toLowerCase()

export function podeRetornarRelatorioRascunho(
  relatorio: EstadoRelatorio,
): boolean {
  if (normalizar(relatorio.status_aprovacao_tripulante) === 'pendente')
    return true
  // Compatibilidade com finalizados antigos que ainda não iniciaram aprovação.
  return (
    normalizar(relatorio.status) === 'finalizado' &&
    !normalizar(relatorio.status_aprovacao_tripulante) &&
    ['', 'pendente', 'nao_aplicavel'].includes(
      normalizar(relatorio.status_aprovacao_tripulante_2),
    ) &&
    !normalizar(relatorio.token_aprovacao_tripulante_1) &&
    !normalizar(relatorio.token_aprovacao_tripulante_2) &&
    !relatorio.aprovado_tripulante_em &&
    !relatorio.aprovado_tripulante_1_em &&
    !relatorio.aprovado_tripulante_2_em
  )
}

// Mesma comparação na reabertura e nas decisões: uma requisição que leu a
// aprovação antiga não pode restaurar o status depois do retorno a rascunho.
export const CONCORRENCIA_RELATORIO_SQL = `status IS ?
  AND status_aprovacao_tripulante IS ? AND status_aprovacao_tripulante_2 IS ?
  AND token_aprovacao_tripulante_1 IS ? AND token_aprovacao_tripulante_2 IS ?`
export function valoresConcorrenciaRelatorio(relatorio: EstadoRelatorio) {
  return [
    relatorio.status ?? null,
    relatorio.status_aprovacao_tripulante ?? null,
    relatorio.status_aprovacao_tripulante_2 ?? null,
    relatorio.token_aprovacao_tripulante_1 ?? null,
    relatorio.token_aprovacao_tripulante_2 ?? null,
  ]
}

export async function retornarRelatorioRascunho(db: D1Database, id: string) {
  const atual = await db
    .prepare(
      `SELECT id, status, numero_relatorio, pdf_path,
    status_aprovacao_tripulante, status_aprovacao_tripulante_2,
    token_aprovacao_tripulante_1, token_aprovacao_tripulante_2,
    aprovado_tripulante_em, aprovado_tripulante_1_em, aprovado_tripulante_2_em
    FROM relatorio_despesa_viagem WHERE id = ?1`,
    )
    .bind(id)
    .first<RelatorioAtual>()
  if (!atual) return { status: 404 as const, error: 'relatorio_nao_encontrado' }
  if (normalizar(atual.status) === 'rascunho')
    return { status: 200 as const, atual, alterado: false }
  if (!podeRetornarRelatorioRascunho(atual))
    return {
      status: 409 as const,
      error: 'relatorio_aprovacao_tripulante_nao_pendente',
    }
  const resultado = await db
    .prepare(
      `UPDATE relatorio_despesa_viagem SET status = 'rascunho',
    token_aprovacao_tripulante_1 = NULL, token_aprovacao_tripulante_2 = NULL,
    aprovado_tripulante_1_em = NULL, aprovado_tripulante_2_em = NULL, aprovado_tripulante_em = NULL,
    enviado_para_tripulante_em = NULL, enviado_para_tripulante_2_em = NULL, enviado_para_cliente_em = NULL,
    status_aprovacao_tripulante = 'pendente', status_aprovacao_tripulante_2 = NULL,
    motivo_reprovacao_tripulante_1 = NULL, motivo_reprovacao_tripulante_2 = NULL,
    pdf_url = NULL, pdf_path = NULL, atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ? AND ${CONCORRENCIA_RELATORIO_SQL} AND pdf_path IS ?`,
    )
    .bind(id, ...valoresConcorrenciaRelatorio(atual), atual.pdf_path)
    .run()
  if (!resultado.meta.changes)
    return { status: 409 as const, error: 'relatorio_alterado_concorrente' }
  return { status: 200 as const, atual, alterado: true }
}
