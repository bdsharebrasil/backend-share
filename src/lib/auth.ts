export type Colaborador = {
  id: string
  email: string
  email_envio?: string | null
  nome_completo: string
  nome_exibicao: string | null
  url_avatar: string | null
  endereco: string | null
  cidade: string | null
  uf: string | null
  telefone: string | null
  data_criacao: string
  data_atualizacao: string
  data_nascimento: string | null
  data_admissao: string | null
  cpf: string | null
  rg: string | null
  canac: string | null
  status: string
  nome_banco: string | null
  tipo_conta: string | null
  conta_numero: string | null
  agencia_numero: string | null
  tipo_chave_pix: string | null
  pix: string | null
  tipo_user: string | null
  departamento: string | null
  departamentos_email?: string | null
  cliente_id: string | null
}

type AuthContext = {
  req: {
    header(name: string): string | undefined
  }
  env: {
    SUPABASE_URL?: string
    SUPABASE_ANON_KEY?: string
    SUPABASE_SERVICE_ROLE_KEY?: string
    VITE_SUPABASE_PUBLISHABLE_KEY?: string
    INTERNAL_TOKEN?: string
    SHARE_DB: D1Database
  }
}

type ColaboradorClaims = { id: string; email: string }

const log = {
  debug: (..._args: unknown[]) => undefined,
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
}

export async function requireAuthenticatedUser(c: AuthContext): Promise<boolean> {
  const authorization = c.req.header('authorization')
  log.debug('[auth] Authorization header present:', Boolean(authorization))
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_PUBLISHABLE_KEY } = c.env
  const supabaseApiKey = SUPABASE_ANON_KEY || VITE_SUPABASE_PUBLISHABLE_KEY || SUPABASE_SERVICE_ROLE_KEY || c.req.header('apikey')

  if (!authorization?.startsWith('Bearer ')) {
    log.debug('[auth] missing Bearer token')
    return false
  }
  if (!SUPABASE_URL) {
    log.warn('[auth] SUPABASE_URL não definido')
    return false
  }
  if (!supabaseApiKey) {
    log.warn('[auth] nenhuma chave pública do Supabase configurada')
    return false
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: supabaseApiKey, Authorization: authorization },
    })
    log.debug('[auth] supabase /auth/v1/user status:', response.status)
    return response.ok
  } catch (error: any) {
    log.error('[auth] erro ao validar token no Supabase:', error?.message ?? error)
    return false
  }
}

async function timingSafeTokenMatch(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ])
  // @ts-ignore Cloudflare Workers exposes timingSafeEqual as a Web Crypto extension.
  return crypto.subtle.timingSafeEqual(hashA, hashB)
}

export async function checkInternalAuth(c: AuthContext): Promise<boolean> {
  const token = c.req.header('x-internal-token')
  const expected = c.env.INTERNAL_TOKEN
  if (!expected || !token) return false
  return timingSafeTokenMatch(token, expected)
}

export function extractSupabaseUserId(c: Pick<AuthContext, 'req'>): string | null {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  try {
    const payload = authorization.slice(7).split('.')[1]
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))?.sub ?? null
  } catch {
    return null
  }
}

function claimsFromBearerToken(token: string): ColaboradorClaims | null {
  try {
    const payload = token.split('.')[1]
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    const id = typeof claims?.sub === 'string' ? claims.sub : ''
    const email = typeof claims?.email === 'string' ? claims.email.toLowerCase() : ''
    return id && email ? { id, email } : null
  } catch {
    return null
  }
}

function extractSupabaseClaims(c: Pick<AuthContext, 'req'>): ColaboradorClaims | null {
  const authorization = c.req.header('authorization')
  return authorization?.startsWith('Bearer ') ? claimsFromBearerToken(authorization.slice(7)) : null
}

export async function authenticatedColaborador(c: AuthContext): Promise<Colaborador | null> {
  if (!(await requireAuthenticatedUser(c))) return null
  const claims = extractSupabaseClaims(c)
  if (!claims) return null
  return c.env.SHARE_DB.prepare('SELECT * FROM user_profiles WHERE id = ?1 OR lower(email) = ?2 LIMIT 1')
    .bind(claims.id, claims.email).first<Colaborador>()
}

export async function authenticatedColaboradorToken(c: AuthContext, token: string): Promise<Colaborador | null> {
  const normalizedToken = token.trim()
  if (!normalizedToken || !c.env.SUPABASE_URL) return null
  const apiKey = c.env.SUPABASE_ANON_KEY || c.env.VITE_SUPABASE_PUBLISHABLE_KEY || c.env.SUPABASE_SERVICE_ROLE_KEY
  if (!apiKey) return null
  const response = await fetch(`${c.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: apiKey, Authorization: `Bearer ${normalizedToken}` },
  }).catch(() => null)
  if (!response?.ok) return null
  const claims = claimsFromBearerToken(normalizedToken)
  if (!claims) return null
  return c.env.SHARE_DB.prepare('SELECT * FROM user_profiles WHERE id = ?1 OR lower(email) = ?2 LIMIT 1')
    .bind(claims.id, claims.email).first<Colaborador>()
}

export async function requireShareInternal(c: AuthContext): Promise<boolean> {
  return await requireAuthenticatedUser(c) || checkInternalAuth(c)
}

export async function shareBrasilUser(c: AuthContext): Promise<Colaborador | null> {
  return authenticatedColaborador(c)
}

export function isTaskManager(user: Colaborador): boolean {
  const role = (user.tipo_user || '').toLowerCase().replace(/[\s-]+/g, '_')
  return ['admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster'].includes(role)
}

export async function isColaboradorManager(c: AuthContext, user: Colaborador): Promise<boolean> {
  const result = await c.env.SHARE_DB.prepare("SELECT 1 FROM user_profiles WHERE id = ?1 AND lower(replace(replace(trim(COALESCE(tipo_user, '')), ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'financeiro_master', 'gestor_master', 'rh') UNION ALL SELECT 1 FROM usuarios_funcoes WHERE user_id = ?1 AND lower(replace(replace(trim(funcao), ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'financeiro_master', 'gestor_master', 'rh') LIMIT 1")
    .bind(user.id).first()
  return Boolean(result)
}