type Database = D1Database

/**
 * Cria mensagens internas para o usuário que originou a operação.
 * A função retorna statements para ser incluída no mesmo batch da operação.
 */
export function mensagemFinanceiraStatements(
  db: Database,
  destinatarioId: string | null,
  remetenteId: string | null,
  assunto: string,
  conteudo: string,
): D1PreparedStatement[] {
  if (!destinatarioId || !remetenteId || destinatarioId === remetenteId) return []
  const mensagemId = crypto.randomUUID()
  return [
    db.prepare(`
      INSERT INTO mensagens (id, remetente_id, destinatario_id, assunto, conteudo, lida)
      VALUES (?, ?, ?, ?, ?, 0)
    `).bind(mensagemId, remetenteId, destinatarioId, assunto, conteudo),
    db.prepare(`
      INSERT OR IGNORE INTO mensagens_usuario (mensagem_id, usuario_id, papel, lida)
      VALUES (?, ?, 'remetente', 1)
    `).bind(mensagemId, remetenteId),
    db.prepare(`
      INSERT OR IGNORE INTO mensagens_usuario (mensagem_id, usuario_id, papel, lida)
      VALUES (?, ?, 'destinatario', 0)
    `).bind(mensagemId, destinatarioId),
  ]
}
