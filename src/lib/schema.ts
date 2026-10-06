export type WorkerSchemaRequirement = { table: string; columns?: string[] }

type SchemaContext = {
  env: {
    SHARE_DB: D1Database
  }
}

export async function validateWorkerSchema(
  c: SchemaContext,
  requirements: WorkerSchemaRequirement[],
): Promise<void> {
  const db = c.env.SHARE_DB
  const missing: string[] = []

  for (const requirement of requirements) {
    const query = await db.prepare('SELECT name FROM pragma_table_info(?)')
      .bind(requirement.table)
      .all<{ name: string }>()
    const columns = new Set((query.results || []).map(column => String(column.name)))

    if (!columns.size) {
      missing.push(`tabela ${requirement.table}`)
      continue
    }

    for (const column of requirement.columns || []) {
      if (!columns.has(column)) missing.push(`${requirement.table}.${column}`)
    }
  }

  if (missing.length) {
    throw new Error(`Schema incompatível; aplique a migration D1 correspondente. Ausências: ${missing.join(', ')}`)
  }
}
