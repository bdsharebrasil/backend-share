type ResultadoExclusaoAgendamento = {
  excluido: boolean
  anexos: string[]
}

/**
 * Retira a solicitação das listas operacionais sem apagar o registro-pai.
 * Os dados de jornada, preparação, escala e anexos continuam vinculados e auditáveis.
 */
export async function excluirAgendamentoDoBanco(db: any, id: string): Promise<ResultadoExclusaoAgendamento> {
  const resultado = await db.prepare(`
    UPDATE solicitacoes_reserva_voo
    SET status_antes_exclusao = status,
        status = 'excluida',
        excluida_em = CURRENT_TIMESTAMP
    WHERE id = ?1 AND excluida_em IS NULL
  `).bind(id).run()

  return {
    excluido: Number(resultado?.meta?.changes || 0) > 0,
    anexos: [],
  }
}
