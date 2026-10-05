export async function listar(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<Record<string, unknown>[]> {
  const statement = db.prepare(sql)
  const result = params.length
    ? await statement.bind(...params).all<Record<string, unknown>>()
    : await statement.all<Record<string, unknown>>()
  return result.results ?? []
}

export async function listarTodos(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<Record<string, unknown>[]> {
  const pageSize = 500
  const rows: Record<string, unknown>[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await listar(db, `${sql} LIMIT ? OFFSET ?`, ...params, pageSize, offset)
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}