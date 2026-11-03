import { listar } from './d1'

export async function enriquecerFornecedores(
  db: D1Database,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (!rows.length) return rows
  const fornecedorIds = [...new Set(rows.map(row => String(row.fornecedor_id ?? row.fornecedores_favoritos_id ?? '').trim()).filter(Boolean))]
  const lancamentoIds = [...new Set(rows.map(row => String(row.lancamentos_id ?? '').trim()).filter(Boolean))]
  const porFornecedor = new Map<string, string>()
  const fornecedorPorLancamento = new Map<string, string>()

  if (fornecedorIds.length) {
    const placeholders = fornecedorIds.map(() => '?').join(', ')
    const fornecedores = await listar(db, `SELECT id, nome_completo FROM fornecedores_favoritos WHERE id IN (${placeholders})`, ...fornecedorIds)
    fornecedores.forEach(row => { if (row.id && row.nome_completo) porFornecedor.set(String(row.id), String(row.nome_completo)) })
  }

  if (lancamentoIds.length) {
    const placeholders = lancamentoIds.map(() => '?').join(', ')
    const lancamentos = await listar(db, `SELECT id, fornecedor_nome FROM lancamentos WHERE id IN (${placeholders})`, ...lancamentoIds)
    lancamentos.forEach(row => { if (row.id && row.fornecedor_nome) fornecedorPorLancamento.set(String(row.id), String(row.fornecedor_nome)) })
  }

  return rows.map(row => {
    const fornecedorId = String(row.fornecedor_id ?? row.fornecedores_favoritos_id ?? '').trim()
    const lancamentoId = String(row.lancamentos_id ?? '').trim()
    const nomeDireto = String(row.fornecedor_nome ?? row.fornecedor ?? '').trim()
    const fornecedorNome = nomeDireto || fornecedorPorLancamento.get(lancamentoId) || porFornecedor.get(fornecedorId) || null
    return { ...row, fornecedor_id: row.fornecedor_id ?? row.fornecedores_favoritos_id ?? null, fornecedor_nome: fornecedorNome }
  })
}
