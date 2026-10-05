export type FinanceSchema = ReadonlyMap<string, ReadonlySet<string>>

const IDENTIFICADOR_SQL = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Projeta a primeira coluna existente entre as alternativas, sempre com um alias
 * estável. Isso mantém as consultas compatíveis com bancos D1 em níveis de
 * migração diferentes, sem referenciar colunas que ainda não existem.
 */
export function selecionarColunaOpcional(
  schema: FinanceSchema,
  tabela: string,
  aliasTabela: string,
  alternativas: readonly string[],
  aliasSaida: string,
): string {
  const identificadores = [tabela, aliasTabela, aliasSaida, ...alternativas]
  if (identificadores.some((identificador) => !IDENTIFICADOR_SQL.test(identificador))) {
    throw new Error('identificador_sql_invalido')
  }

  const colunas = schema.get(tabela)
  const disponiveis = alternativas.filter((coluna) => colunas?.has(coluna))
  const expressao = disponiveis.length
    ? disponiveis.length === 1
      ? `${aliasTabela}.${disponiveis[0]}`
      : `COALESCE(${disponiveis.map((coluna) => `${aliasTabela}.${coluna}`).join(', ')})`
    : 'NULL'

  return `${expressao} AS ${aliasSaida}`
}
