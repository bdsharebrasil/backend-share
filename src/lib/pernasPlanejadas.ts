export type PernaPlanejada = {
  id: string; solicitacao_id: string; data_prevista: string; origem: string; destino: string;
  horario_previsto: string | null; numero_passageiros: number; status: 'PLANEJADA' | 'INICIADA' | 'CANCELADA';
  criado_em: string; atualizado_em: string;
}

export const colunasPlanejamento = `id, solicitacao_origem_id AS solicitacao_id, data_agendada AS data_prevista,
  origem, destino, horario_previsto_agendamento AS horario_previsto, numero_passageiros, numero_voo,
  CASE lower(status) WHEN 'aprovada' THEN 'PLANEJADA' WHEN 'cancelada' THEN 'CANCELADA' ELSE 'INICIADA' END AS status,
  criado_em, atualizado_em`

export function buscarPernaPlanejada(db: D1Database, id: string, solicitacaoId: string) {
  return db.prepare(`SELECT ${colunasPlanejamento} FROM solicitacoes_reserva_voo
    WHERE id = ?1 AND solicitacao_origem_id = ?2 AND excluida_em IS NULL`)
    .bind(id, solicitacaoId).first<PernaPlanejada & { numero_voo: string }>()
}

export function vincularPernaPlanejada(db: D1Database, id: string, solicitacaoId: string, fase: string) {
  return db.prepare(`UPDATE solicitacoes_reserva_voo SET status = ?1, atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ?2 AND solicitacao_origem_id = ?3 AND lower(status) = 'aprovada' AND excluida_em IS NULL
      AND EXISTS (SELECT 1 FROM pernas_jornada_voo WHERE id = ?2)`)
    .bind(fase, id, solicitacaoId)
}

/** O mesmo pedido de gravação recebe o mesmo ID, com escopo na solicitação original. */
export async function idAgendamentoPlanejado(solicitacaoId: string, chave: string) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([solicitacaoId, chave]))))
  hash[6] = (hash[6] & 0x0f) | 0x80
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = Array.from(hash.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
