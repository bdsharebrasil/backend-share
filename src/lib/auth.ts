export type Colaborador = {
  id: string; email: string; email_envio?: string | null; nome_completo: string; nome_exibicao: string | null
  url_avatar: string | null; endereco: string | null; cidade: string | null; uf: string | null; telefone: string | null
  data_criacao: string; data_atualizacao: string; data_nascimento: string | null; data_admissao: string | null
  cpf: string | null; rg: string | null; canac: string | null; status: string; nome_banco: string | null
  tipo_conta: string | null; conta_numero: string | null; agencia_numero: string | null; tipo_chave_pix: string | null
  pix: string | null; tipo_user: string | null; departamento: string | null; departamentos_email?: string | null; cliente_id: string | null
}
type AuthContext = {
  req: { header(name: string): string | undefined }
  env: {
    SUPABASE_URL?: string
    SUPABASE_ANON_KEY?: string
    SUPABASE_SERVICE_ROLE_KEY?: string
    VITE_SUPABASE_PUBLISHABLE_KEY?: string
    INTERNAL_TOKEN?: string
    SHARE_DB: D1Database
  }
}
type JwtClaims = { exp?: unknown }
type CachedToken = { userId: string; expiresAt: number }
const VERIFIED_TOKEN_TTL_MS = 30_000
const verifiedTokenCache = new Map<string, CachedToken>()
const tokenValidationRequests = new Map<string, Promise<string | null>>()

function tokenExpiration(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))) as JwtClaims
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null
  } catch { return null }
}

function supabaseApiKeys(c: AuthContext): string[] {
  return [...new Set([
    c.env.SUPABASE_ANON_KEY,
    c.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    c.req.header('apikey'),
    c.env.SUPABASE_SERVICE_ROLE_KEY,
  ].map((key) => key?.trim()).filter((key): key is string => Boolean(key)))]
}

async function validateWithSupabase(supabaseUrl: string, token: string, apiKeys: string[]): Promise<string | null> {
  for (const apiKey of apiKeys) {
    let response: Response
    try {
      response = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: apiKey, Authorization: `Bearer ${token}` },
      })
    } catch {
      return null
    }
    if (response.ok) {
      try {
        const user = await response.json() as { id?: unknown }
        return typeof user?.id === 'string' && user.id.trim() ? user.id.trim() : null
      } catch {
        return null
      }
    }
    // A public API key may have rotated; retry only credential errors with
    // another configured/public key. Transient upstream failures fail closed.
    if (response.status !== 401 && response.status !== 403) return null
  }
  return null
}

function cacheVerifiedToken(cacheKey: string, token: string, userId: string): void {
  const now = Date.now()
  const expiration = tokenExpiration(token)
  // The JWT payload is used only to bound the cache; Supabase Auth remains the
  // authority that verifies the signature, issuer, expiry, and user status.
  const expiresAt = expiration === null ? now : Math.min(now + VERIFIED_TOKEN_TTL_MS, expiration)
  if (expiresAt <= now) return
  if (verifiedTokenCache.size >= 1000) {
    const oldestKey = verifiedTokenCache.keys().next().value
    if (oldestKey) verifiedTokenCache.delete(oldestKey)
  }
  verifiedTokenCache.set(cacheKey, { userId, expiresAt })
}

export async function getAuthenticatedUserId(c: AuthContext, tokenOverride?: string): Promise<string | null> {
  const authorization = tokenOverride ? `Bearer ${tokenOverride.trim()}` : c.req.header('authorization')
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i)
  const token = match?.[1]
  const supabaseUrl = c.env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  const apiKeys = supabaseApiKeys(c)
  if (!token || !supabaseUrl || !apiKeys.length) return null

  const cacheKey = `${supabaseUrl}\u0000${token}`
  const cached = verifiedTokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.userId
  if (cached) verifiedTokenCache.delete(cacheKey)
  const inFlight = tokenValidationRequests.get(cacheKey)
  if (inFlight) return inFlight

  const validation = validateWithSupabase(supabaseUrl, token, apiKeys)
    .then((userId) => {
      if (userId) cacheVerifiedToken(cacheKey, token, userId)
      return userId
    })
    .catch(() => null)
    .finally(() => { tokenValidationRequests.delete(cacheKey) })
  tokenValidationRequests.set(cacheKey, validation)
  return validation
}

export async function requireAuthenticatedUser(c: AuthContext): Promise<boolean> { return Boolean(await getAuthenticatedUserId(c)) }
async function timingSafeTokenMatch(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [hashA, hashB] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))])
  // @ts-ignore Cloudflare Workers exposes timingSafeEqual as a Web Crypto extension.
  return crypto.subtle.timingSafeEqual(hashA, hashB)
}
export async function checkInternalAuth(c: AuthContext): Promise<boolean> {
  const token = c.req.header('x-internal-token'); const expected = c.env.INTERNAL_TOKEN
  return Boolean(expected && token) && timingSafeTokenMatch(token!, expected!)
}
export function extractSupabaseUserId(c: Pick<AuthContext, 'req'>): string | null {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  try {
    const payload = authorization.slice(7).split('.')[1]
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))?.sub ?? null
  } catch { return null }
}
export async function authenticatedColaborador(c: AuthContext): Promise<Colaborador | null> {
  const userId = await getAuthenticatedUserId(c)
  return userId ? c.env.SHARE_DB.prepare('SELECT * FROM user_profiles WHERE id = ? LIMIT 1').bind(userId).first<Colaborador>() : null
}
export async function authenticatedColaboradorToken(c: AuthContext, token: string): Promise<Colaborador | null> {
  const userId = await getAuthenticatedUserId(c, token)
  return userId ? c.env.SHARE_DB.prepare('SELECT * FROM user_profiles WHERE id = ? LIMIT 1').bind(userId).first<Colaborador>() : null
}
export async function requireShareInternal(c: AuthContext): Promise<boolean> { return Boolean(await getAuthenticatedUserId(c)) || checkInternalAuth(c) }
export async function shareBrasilUser(c: AuthContext): Promise<Colaborador | null> { return authenticatedColaborador(c) }
export function isTaskManager(user: Colaborador): boolean {
  const role = (user.tipo_user || '').toLowerCase().replace(/[\s-]+/g, '_')
  return ['admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster'].includes(role)
}
export async function isColaboradorManager(c: AuthContext, user: Colaborador): Promise<boolean> {
  const result = await c.env.SHARE_DB.prepare("SELECT 1 FROM user_profiles WHERE id = ?1 AND lower(replace(replace(trim(COALESCE(tipo_user, '')), ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'financeiro_master', 'gestor_master', 'rh') UNION ALL SELECT 1 FROM usuarios_funcoes WHERE user_id = ?1 AND lower(replace(replace(trim(funcao), ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'financeiro_master', 'gestor_master', 'rh') LIMIT 1").bind(user.id).first()
  return Boolean(result)
}
