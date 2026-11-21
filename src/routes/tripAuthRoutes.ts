import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { checkRateLimit, clientIp } from '../lib/cache'
import { getAuthenticatedUserId } from '../lib/auth'

type Bindings = {
  SHARE_DB: D1Database; CACHE_KV: KVNamespace; RATE_LIMITER: DurableObjectNamespace;
  SUPABASE_URL?: string; SUPABASE_ANON_KEY?: string; VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}
export const tripAuthRoutes = new Hono<{ Bindings: Bindings }>()
tripAuthRoutes.use('/api/trip/auth/*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'requisicao_muito_grande' }, 413) }))
tripAuthRoutes.use('/api/trip/auth/*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  try {
    if (!await checkRateLimit(c, `trip-auth:${clientIp(c)}`, 20)) return c.json({ error: 'muitas_tentativas_tente_novamente' }, 429)
  } catch { return c.json({ error: 'autenticacao_temporariamente_indisponivel' }, 503) }
  await next()
})

async function trocarCredenciais(c: Context<{ Bindings: Bindings }>, refresh: boolean) {
  const base = c.env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  const key = c.env.SUPABASE_ANON_KEY?.trim() || c.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  if (!base || !key) return c.json({ error: 'autenticacao_nao_configurada' }, 503)
  if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json_obrigatorio' }, 415)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'dados_invalidos' }, 400)
  const usuario = typeof body.usuario === 'string' ? body.usuario.trim().toLowerCase() : ''
  const senha = typeof body.senha === 'string' ? body.senha : ''
  const token = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : ''
  if (refresh ? !token || token.length > 2048 : !/^[a-z0-9._-]{1,100}$/.test(usuario) || !senha || senha.length > 1024)
    return c.json({ error: 'dados_invalidos' }, 400)
  try {
    const response = await fetch(`${base}/auth/v1/token?grant_type=${refresh ? 'refresh_token' : 'password'}`, {
      method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(refresh ? { refresh_token: token } : { email: `${usuario}@share-brasil.com`, password: senha }),
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) {
      if (response.status === 429) return c.json({ error: 'muitas_tentativas_tente_novamente' }, 429)
      return response.status >= 500 ? c.json({ error: 'autenticacao_temporariamente_indisponivel' }, 503)
        : c.json({ error: refresh ? 'sessao_expirada' : 'usuario_ou_senha_incorretos' }, 401)
    }
    const data = await response.json() as Record<string, any>
    if (typeof data.user?.id !== 'string' || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string')
      return c.json({ error: 'resposta_de_autenticacao_invalida' }, 502)
    const perfil = await c.env.SHARE_DB.prepare('SELECT id, status FROM user_profiles WHERE id = ?1 LIMIT 1').bind(data.user.id).first<{ id: string; status: string }>()
    if (!perfil || ['INATIVO', 'DESATIVADO', 'BLOQUEADO'].includes(String(perfil.status || '').trim().toUpperCase()))
      return c.json({ error: 'acesso_nao_autorizado' }, 403)
    const expiresAt = Number(data.expires_at) || Math.floor(Date.now() / 1000) + Number(data.expires_in)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) return c.json({ error: 'resposta_de_autenticacao_invalida' }, 502)
    return c.json({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt, user: { id: perfil.id } })
  } catch { return c.json({ error: 'autenticacao_temporariamente_indisponivel' }, 503) }
}
tripAuthRoutes.post('/api/trip/auth/login', c => trocarCredenciais(c, false))
tripAuthRoutes.post('/api/trip/auth/refresh', c => trocarCredenciais(c, true))
tripAuthRoutes.post('/api/trip/auth/logout', async c => {
  const userId = await getAuthenticatedUserId(c)
  if (!userId) return c.json({ error: 'nao_autorizado' }, 401)
  const key = c.env.SUPABASE_ANON_KEY || c.env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!key) return c.json({ error: 'autenticacao_nao_configurada' }, 503)
  try {
    const res = await fetch(`${c.env.SUPABASE_URL?.replace(/\/+$/, '')}/auth/v1/logout?scope=local`, {
      method: 'POST', headers: { apikey: key, Authorization: c.req.header('authorization')! }, signal: AbortSignal.timeout(12000),
    })
    if (!res.ok && res.status !== 401) return c.json({ error: 'falha_ao_encerrar_sessao_remota' }, 503)
    return c.json({ sucesso: true })
  } catch { return c.json({ error: 'falha_ao_encerrar_sessao_remota' }, 503) }
})
