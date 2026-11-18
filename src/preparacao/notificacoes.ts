async function notificar(db:D1Database, recipients:string[],id:string,mensagem:string){if(!recipients.length)return;await db.batch(recipients.map(u=>db.prepare("INSERT INTO notificacoes (id,id_from,departamento_destinatario,status,mensagem) VALUES (?,?,?,'nao_lida',?)").bind(crypto.randomUUID(),id,u,mensagem)));}
export async function notifyChecklistAbastecimento(db: D1Database, abastecimentoId: string, criadoPor: string | null, numeroVoo: string | null, local: string | null): Promise<void> {
  const recipients = await db.prepare(`SELECT id FROM user_profiles
    WHERE id <> ?1 AND (status IS NULL OR lower(status) IN ('ativo', 'active')) AND (
      lower(replace(replace(trim(COALESCE(tipo_user, '')), ' ', '_'), '-', '_')) IN ('financeiro', 'financeiro_admin', 'financeiroadmin', 'financeiro_master', 'financeiromaster', 'admin', 'administrador')
      OR lower(replace(replace(trim(COALESCE(departamento, '')), ' ', '_'), '-', '_')) IN ('financeiro', 'financeiro_admin', 'financeiroadmin', 'financeiro_master', 'financeiromaster', 'admin', 'administrador', 'administrativo')
      OR id IN (SELECT user_id FROM usuarios_funcoes WHERE lower(replace(replace(trim(funcao), ' ', '_'), '-', '_')) IN ('financeiro', 'financeiro_admin', 'financeiroadmin', 'financeiro_master', 'financeiromaster', 'admin', 'administrador'))
    )`).bind(criadoPor || '').all<{ id: string }>()
  const uniqueRecipients = [...new Set((recipients.results || []).map((recipient) => recipient.id).filter(Boolean))]
  if (!uniqueRecipients.length) return
  const voo = numeroVoo ? ` do voo ${numeroVoo}` : ''
  const aeroporto = local ? ` em ${local}` : ''
  await notificar(db, uniqueRecipients, `abastecimento/${abastecimentoId}`, `Novo abastecimento${voo}${aeroporto} criado pelo checklist pré-voo. É necessário completar os dados fiscais e finalizar o registro no financeiro.`)
}
