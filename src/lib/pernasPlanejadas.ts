export type PernaPlanejada = {
  id: string; solicitacao_id: string; data_prevista: string; origem: string; destino: string;
  horario_previsto: string | null; numero_passageiros: number; status: 'PLANEJADA' | 'INICIADA' | 'CANCELADA';
  perna_jornada_id: string | null; criado_em: string; atualizado_em: string;
}

export async function listarPernasPlanejadas(db: D1Database, inicio: string, fim: string, tabelaOpcional = false) {
  try {
    const rows = await db.prepare(`SELECT p.* FROM pernas_planejadas_voo p
      JOIN solicitacoes_reserva_voo s ON s.id = p.solicitacao_id
      WHERE p.status = 'PLANEJADA' AND p.data_prevista BETWEEN ?1 AND ?2
        AND s.excluida_em IS NULL AND lower(s.status) NOT IN ('encerrada', 'concluida', 'cancelada', 'reprovada')
      ORDER BY p.data_prevista, p.horario_previsto, p.criado_em, p.id`).bind(inicio, fim).all<PernaPlanejada>()
    return rows.results || []
  } catch (error) {
    if (tabelaOpcional && String(error).includes('no such table: pernas_planejadas_voo')) return []
    throw error
  }
}

export function buscarPernaPlanejada(db: D1Database, id: string, solicitacaoId: string) {
  return db.prepare('SELECT * FROM pernas_planejadas_voo WHERE id = ?1 AND solicitacao_id = ?2')
    .bind(id, solicitacaoId).first<PernaPlanejada>()
}

export function vincularPernaPlanejada(db: D1Database, id: string, solicitacaoId: string, pernaId: string) {
  return db.prepare(`UPDATE pernas_planejadas_voo SET status = 'INICIADA', perna_jornada_id = ?1, atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ?2 AND solicitacao_id = ?3 AND status = 'PLANEJADA'
      AND EXISTS (SELECT 1 FROM pernas_jornada_voo WHERE id = ?1)`)
    .bind(pernaId, id, solicitacaoId)
}
