export type Colaborador = {
  id: string; email: string; email_envio?: string | null; nome_completo: string; nome_exibicao: string | null
  url_avatar: string | null; endereco: string | null; cidade: string | null; uf: string | null; telefone: string | null
  data_criacao: string; data_atualizacao: string; data_nascimento: string | null; data_admissao: string | null
  cpf: string | null; rg: string | null; canac: string | null; status: string; nome_banco: string | null
  tipo_conta: string | null; conta_numero: string | null; agencia_numero: string | null; tipo_chave_pix: string | null
  pix: string | null; tipo_user: string | null; departamento: string | null; departamentos_email?: string | null; cliente_id: string | null
}
type AuthContext = { req: { header(name: string): string | undefined }; env: { SUPABASE_URL?: string; INTERNAL_TOKEN?: string; SHARE_DB: D1Database } }
type JwtClaims = { sub?: unknown; email?: unknown; iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown }
type CachedJwks = { issuer: string; keys: JsonWebKey[]; expiresAt: number }
const JWKS_TTL_MS = 5 * 60_000
const TOKEN_TTL_MS = 60_000
let jwksCache: CachedJwks | null = null
let jwksRequest: Promise<CachedJwks> | null = null
const validTokenCache = new Map<string, { userId: string; expiresAt: number }>()
function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
function parseJwt(token: string): { header: Record<string, unknown>; claims: JwtClaims; signingInput: string; signature: Uint8Array } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return { header: JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0]))), claims: JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1]))), signingInput: `${parts[0]}.${parts[1]}`, signature: base64UrlBytes(parts[2]) }
  } catch { return null }
}
function audienceMatches(aud: unknown): boolean {
  return typeof aud === 'string' ? aud === 'authenticated' : Array.isArray(aud) && aud.includes('authenticated')
}
async function loadJwks(supabaseUrl: string): Promise<CachedJwks> {
  const issuer = `${supabaseUrl}/auth/v1`
  if (jwksCache?.issuer === issuer && jwksCache.expiresAt > Date.now()) return jwksCache
  if (!jwksRequest) {
    jwksRequest = fetch(`${issuer}/.well-known/jwks.json`, { headers: { Accept: 'application/json' } }).then(async (response) => {
      if (!response.ok) throw new Error(`JWKS status ${response.status}`)
      const payload = await response.json() as { keys?: JsonWebKey[] }
      if (!Array.isArray(payload.keys) || !payload.keys.length) throw new Error('JWKS sem chaves')
      const result = { issuer, keys: payload.keys, expiresAt: Date.now() + JWKS_TTL_MS }
      jwksCache = result
      return result
    }).finally(() => { jwksRequest = null })
  }
  return jwksRequest
}
async function verifyToken(token: string, supabaseUrl: string): Promise<string | null> {
  const cached = validTokenCache.get(token)
  if (cached && cached.expiresAt > Date.now()) return cached.userId
  const parsed = parseJwt(token)
  if (!parsed || typeof parsed.header.alg !== 'string' || typeof parsed.header.kid !== 'string') return null
  const algorithm = parsed.header.alg
  const cryptoAlgorithm: any = algorithm === 'RS256'
    ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
    : algorithm === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : undefined
  if (!cryptoAlgorithm) return null
  const jwks = await loadJwks(supabaseUrl)
  const jwk = jwks.keys.find((key) => (key as JsonWebKey & { kid?: string; alg?: string }).kid === parsed.header.kid && (key as JsonWebKey & { kid?: string; alg?: string }).alg === algorithm)
  if (!jwk) return null
  const key = await crypto.subtle.importKey('jwk', jwk, cryptoAlgorithm, false, ['verify'])
  const verified = await crypto.subtle.verify(algorithm === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : cryptoAlgorithm, key, parsed.signature, new TextEncoder().encode(parsed.signingInput))
  const now = Math.floor(Date.now() / 1000)
  if (!verified || parsed.claims.iss !== jwks.issuer || !audienceMatches(parsed.claims.aud) || typeof parsed.claims.exp !== 'number' || parsed.claims.exp <= now || (typeof parsed.claims.nbf === 'number' && parsed.claims.nbf > now + 60)) return null
  const userId = typeof parsed.claims.sub === 'string' ? parsed.claims.sub.trim() : ''
  if (!userId) return null
  if (validTokenCache.size >= 1000) validTokenCache.delete(validTokenCache.keys().next().value as string)
  validTokenCache.set(token, { userId, expiresAt: Date.now() + TOKEN_TTL_MS })
  return userId
}
export async function getAuthenticatedUserId(c: AuthContext, tokenOverride?: string): Promise<string | null> {
  const authorization = tokenOverride ? `Bearer ${tokenOverride}` : c.req.header('authorization')
  const supabaseUrl = c.env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  if (!authorization?.startsWith('Bearer ') || !supabaseUrl) return null
  try { return await verifyToken(authorization.slice(7).trim(), supabaseUrl) } catch { return null }
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
  const authorization = c.req.header('authorization'); const parsed = authorization?.startsWith('Bearer ') ? parseJwt(authorization.slice(7).trim()) : null
  return typeof parsed?.claims.sub === 'string' ? parsed.claims.sub : null
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
