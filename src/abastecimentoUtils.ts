export type TitularAbastecimento = {
  cliente_id: string | null
  socio_id: string | null
}

type DiarioTitularAbastecimento = {
  cliente_id?: string | null
  socio_id?: string | null
  cliente_tomador_emprestimo_id?: string | null
  socio_tomador_emprestimo_id?: string | null
} | null | undefined

export function normalizarVooEmprestado(valor: unknown, valorPadrao: unknown = false): boolean {
  const valorEfetivo = valor === null || valor === undefined ? valorPadrao : valor
  if (typeof valorEfetivo === 'boolean') return valorEfetivo
  if (typeof valorEfetivo === 'number') return valorEfetivo === 1
  return ['1', 'true', 'sim', 'yes'].includes(String(valorEfetivo).trim().toLowerCase())
}

export function resolverTitularAbastecimento(
  vooEmprestado: boolean,
  diario: DiarioTitularAbastecimento,
  titularInformado: TitularAbastecimento,
): TitularAbastecimento {
  if (!diario) return titularInformado

  const titularDiario = vooEmprestado
    ? {
        cliente_id: diario.cliente_tomador_emprestimo_id || null,
        socio_id: diario.socio_tomador_emprestimo_id || null,
      }
    : {
        cliente_id: diario.cliente_id || null,
        socio_id: diario.socio_id || null,
      }

  return titularDiario.cliente_id || titularDiario.socio_id
    ? titularDiario
    : titularInformado
}
