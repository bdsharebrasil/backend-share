import { listar } from './d1'

export async function enriquecerFornecedores(
  db: D1Database,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (!rows.length) return rows
  const cotistaIds = [...new Set(rows.map(row => String(row.cotista_aeronave_id ?? row.cotista_id ?? '').trim()).filter(Boolean))]
  const fornecedorIds = [...new Set(rows.map(row => String(row.fornecedor_id ?? row.fornecedores_favoritos_id ?? '').trim()).filter(Boolean))]
  const porCotista = new Map<string, string>()
  const porFornecedor = new Map<string, string>()

  if (cotistaIds.length) {
    const placeholders = cotistaIds.map(() => '?').join(', ')
    const cotistas = await listar(db, `SELECT ca.id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome
      FROM cotista_aeronave ca
      LEFT JOIN cliente cl ON cl.id = ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
      WHERE ca.id IN (${placeholders})`, ...cotistaIds)
    cotistas.forEach(row => { if (row.id && row.nome) porCotista.set(String(row.id), String(row.nome)) })
  }

  if (fornecedorIds.length) {
    const placeholders = fornecedorIds.map(() => '?').join(', ')
    const fornecedores = await listar(db, `SELECT id, nome_completo FROM fornecedores_favoritos WHERE id IN (${placeholders})`, ...fornecedorIds)
    fornecedores.forEach(row => { if (row.id && row.nome_completo) porFornecedor.set(String(row.id), String(row.nome_completo)) })
  }

  return rows.map(row => {
    const fornecedorId = String(row.fornecedor_id ?? row.fornecedores_favoritos_id ?? '').trim()
    const cotistaId = String(row.cotista_aeronave_id ?? row.cotista_id ?? '').trim()
    const fornecedorNome = row.fornecedor_nome ?? row.fornecedor ?? porFornecedor.get(fornecedorId) ?? porCotista.get(cotistaId) ?? null
    return { ...row, fornecedor_id: row.fornecedor_id ?? row.fornecedores_favoritos_id ?? null, fornecedor_nome: fornecedorNome }
  })
}