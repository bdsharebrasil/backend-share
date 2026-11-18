const TABELAS_FILHAS_AGENDAMENTO = [
  'preparacao_voo_versoes',
  'preparacao_voo_reservas',
  'preparacao_voo_abastecimentos',
  'preparacao_voo_anexos',
  'preparacoes_voo',
  'escala_tripulacao',
] as const

type ResultadoExclusaoAgendamento = {
  excluido: boolean
  anexos: string[]
}

export async function excluirAgendamentoDoBanco(db: any, id: string): Promise<ResultadoExclusaoAgendamento> {
  const tabelas = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABELAS_FILHAS_AGENDAMENTO.map(() => '?').join(', ')})`,
  ).bind(...TABELAS_FILHAS_AGENDAMENTO).all()
  const existentes = new Set<string>((tabelas.results || []).map((linha: { name: string }) => linha.name))
  const anexos = existentes.has('preparacao_voo_anexos')
    ? await db.prepare('SELECT caminho FROM preparacao_voo_anexos WHERE solicitacao_id = ?1').bind(id).all()
    : { results: [] }
  const caminhos = (anexos.results || []).map((linha: { caminho: string }) => linha.caminho).filter(Boolean)
  const comandos = TABELAS_FILHAS_AGENDAMENTO
    .filter((tabela) => existentes.has(tabela))
    .map((tabela) => db.prepare(`DELETE FROM ${tabela} WHERE solicitacao_id = ?1`).bind(id))
  comandos.push(db.prepare('DELETE FROM solicitacoes_reserva_voo WHERE id = ?1').bind(id))
  const resultado = await db.batch(comandos)
  const exclusaoPrincipal = resultado[resultado.length - 1]

  return {
    excluido: Number(exclusaoPrincipal?.meta?.changes || 0) > 0,
    anexos: caminhos,
  }
}
