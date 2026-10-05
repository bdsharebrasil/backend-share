type FinanceiroAuthDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>
    }
  }
}

type FinanceiroAuthContext = {
  env: {
    SHARE_DB: FinanceiroAuthDb
    SUPABASE_URL?: string
    SUPABASE_ANON_KEY?: string
    SUPABASE_SERVICE_ROLE_KEY?: string
    VITE_SUPABASE_PUBLISHABLE_KEY?: string
  }
  req: { header(name: string): string | undefined }
}

const PAPEIS_FINANCEIROS = [
  'admin', 'administrador', 'gestor_master', 'gestormaster',
  'financeiro_master', 'financeiromaster', 'financeiro_admin',
  'financeiro', 'administrativo',
]

const PAPEIS_FINANCEIROS_GESTAO = [
  'admin', 'administrador', 'gestor_master', 'gestormaster',
  'financeiro_master', 'financeiromaster', 'financeiro_admin',
]

const normalizarPapelSql = (coluna: string) =>
  `lower(replace(replace(trim(COALESCE(${coluna}, '')), ' ', '_'), '-', '_'))`

export async function usuarioTemPapel(
  db: FinanceiroAuthDb,
  userId: string,
  papeis: readonly string[],
): Promise<boolean> {
  if (!papeis.length) return false
  const placeholders = papeis.map(() => '?').join(', ')
  const row = await db.prepare(`
    SELECT 1 FROM user_profiles p
     WHERE p.id = ?
       AND (p.status IS NULL OR lower(p.status) IN ('ativo', 'active'))
       AND (
         ${normalizarPapelSql('p.tipo_user')} IN (${placeholders})
         OR ${normalizarPapelSql('p.departamento')} IN (${placeholders})
         OR EXISTS (
           SELECT 1 FROM usuarios_funcoes f
            WHERE f.user_id = p.id
              AND ${normalizarPapelSql('f.funcao')} IN (${placeholders})
         )
       )
     LIMIT 1
  `).bind(userId, ...papeis, ...papeis, ...papeis).first()
  return Boolean(row)
}

async function usuarioAtivo(db: FinanceiroAuthDb, userId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 FROM user_profiles
     WHERE id = ? AND (status IS NULL OR lower(status) IN ('ativo', 'active'))
     LIMIT 1
  `).bind(userId).first()
  return Boolean(row)
}

async function validarUsuarioSupabase(c: FinanceiroAuthContext): Promise<string | null> {
  const authorization = c.req.header('authorization')
  const supabaseUrl = c.env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  const apiKey = c.env.SUPABASE_ANON_KEY
    || c.env.VITE_SUPABASE_PUBLISHABLE_KEY
    || c.env.SUPABASE_SERVICE_ROLE_KEY
    || c.req.header('apikey')
  if (!authorization?.startsWith('Bearer ') || !supabaseUrl || !apiKey) return null

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: apiKey, Authorization: authorization },
    })
    if (!response.ok) return null
    const user = await response.json() as { id?: unknown }
    return typeof user.id === 'string' && user.id.trim() ? user.id : null
  } catch {
    return null
  }
}

function colaboradorPodeSolicitar(path: string, method: string): boolean {
  if (method === 'POST' && ['/envios-pagamento', '/envios-pagamento/anexos'].includes(path)) return true
  if (method !== 'GET') return false
  return path === '/envios-pagamento/opcoes'
    || /^\/envios-pagamento\/aeronave\/[^/]+\/cotistas$/.test(path)
}

export async function autorizarRequisicaoFinanceira(
  c: FinanceiroAuthContext,
  pathname: string,
  method: string,
): Promise<{ autorizado: true; userId: string } | { autorizado: false; status: 401 | 403 }> {
  const userId = await validarUsuarioSupabase(c)
  if (!userId) return { autorizado: false, status: 401 }

  const path = pathname.replace(/^\/api\/financeiro/, '') || '/'
  if (path === '/pagamentos-folha' || path.startsWith('/pagamentos-folha/')) {
    return { autorizado: true, userId }
  }

  if (colaboradorPodeSolicitar(path, method)) {
    return await usuarioAtivo(c.env.SHARE_DB, userId)
      ? { autorizado: true, userId }
      : { autorizado: false, status: 403 }
  }

  return await usuarioTemPapel(c.env.SHARE_DB, userId, PAPEIS_FINANCEIROS)
    ? { autorizado: true, userId }
    : { autorizado: false, status: 403 }
}