import { listar } from './d1'

export async function enriquecerFornecedores(
  db: D1Database,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (!rows.length) return rows
  const fornecedorIds = [...new Set(rows.map(row => String(row.fornecedor_id ?? row.fornecedores_favoritos_id ?? '').trim()).filter(Boolean))]
  const porFornecedor = new Map<string, string>()

  if (fornecedorIds.length) {
    const placeholders = fornecedorIds.map(() => '?').join(', ')
    const fornecedores = await listar(db, `SELECT id, nome_completo FROM fornecedores_favoritos WHERE id IN (${placeholders})`, ...fornecedorIds)
    fornecedores.forEach(row => { if (row.id && row.nome_completo) porFornecedor.set(String(row.id), String(row.nome_completo)) })
  }

  return rows.map(row => {
    const fornecedorId = String(row.fornecedor_id ?? row.fornecedores_favoritos_id ?? '').trim()
    const fornecedorNome = row.fornecedor_nome ?? row.fornecedor ?? porFornecedor.get(fornecedorId) ?? null
    return { ...row, fornecedor_id: row.fornecedor_id ?? row.fornecedores_favoritos_id ?? null, fornecedor_nome: fornecedorNome }
  })
}
