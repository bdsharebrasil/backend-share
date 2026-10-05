export async function requireCaixaShareAccess(c: any): Promise<Response | null> {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare(`
    SELECT 1 FROM user_profiles p
     WHERE p.id = ? AND lower(replace(replace(trim(COALESCE(p.tipo_user, '')), ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster')
    UNION ALL
    SELECT 1 FROM usuarios_funcoes f
     WHERE f.user_id = ? AND lower(replace(replace(trim(COALESCE(f.funcao, '')), ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster')
    LIMIT 1`).bind(userId, userId).first()
  return row ? null : c.json({ error: 'caixa_share_nao_autorizado' }, 403)
}