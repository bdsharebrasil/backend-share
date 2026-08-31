import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { XMLParser } from 'fast-xml-parser'

// ─── Types ────────────────────────────────────────────────────────────────────

type Bindings = {
  AISWEB_API_KEY: string
  AISWEB_API_PASS: string
  CACHE_KV: KVNamespace
  FILES: R2Bucket
  SHARE_FILES?: R2Bucket
  DB: D1Database
  SHARE_DB: D1Database
  RESEND_API_KEY: string
  INTERNAL_TOKEN: string
  EMAIL_FROM: string // ex: "Financeiro Share Brasil <financeiro@seudominio.com>"
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_ROLE_KEY: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string // usado só para diagnóstico em log; não substitui SUPABASE_ANON_KEY
  WINSOCK_VALUATION_URL: string   // https://windsock.ai/api/v3/valuations
  WINSOCK_API_KEY: string
  WINSOCK_AUTH_HEADER?: string    // default: 'X-API-Key'
  WINSOCK_AUTH_PREFIX?: string    // default: '' (sem prefixo)
  ANTHROPIC_API_KEY: string       // usado no OCR de demonstrativos (Claude Vision/Document)
  ALLOWED_ORIGINS?: string        // opcional: lista separada por vírgula de origens permitidas no CORS. Se ausente, libera '*'.
  TELEGRAM_BOT_TOKEN?: string
  CLIENT_SESSION_SECRET?: string
  CLIENT_SESSION_TTL_SECONDS?: string
  CLOUDFLARE_TURN_KEY_ID?: string
  CLOUDFLARE_TURN_API_TOKEN?: string
}

interface Airport { icao: string; name: string; lat: number; lon: number; distKm: number }

interface ReservationRequest {
  hotelId: string
  dataCheckin: string
  dataCheckout: string
  tipoQuarto?: string
  quantidadeHospedes: number
  hospedeNome: string
  hospedeTelefone: string
  hospedeEmail?: string
  observacoes?: string
  userId?: string
}

interface HotelReservationHotel {
  id: string
  nome: string
  endereco: string | null
  cidade: string | null
  uf: string | null
  email: string | null
  email_reservas: string | null
  telefone: string | null
  telefone_reservas: string | null
}

// ─── App & Logger ─────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', async (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean)
  const corsMiddleware = cors({
    origin: allowed && allowed.length > 0 ? allowed : '*',
  })
  return corsMiddleware(c, next)
})

const isDev = false
const log = {
  debug: (...a: any[]) => isDev && console.log('[DEBUG]', ...a),
  warn: (...a: any[]) => console.warn('[WARN]', ...a),
  error: (...a: any[]) => console.error('[ERROR]', ...a),
}

// ─── XML Parser & Constants ───────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['item', 'notam', 'carta', 'sol'].includes(name),
})

const AISWEB_BASE_URL = 'https://api.decea.mil.br/aisweb/'
const WINSOCK_VALUATION_CACHE_TTL = 86_400
const WINSOCK_N_NUMBER = /^N[0-9A-Z]{1,5}$/i

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[char]!)
}

/**
 * Valida o Bearer token do Supabase chamando /auth/v1/user.
 * Inclui logs de diagnóstico (log.debug só imprime com isDev=true — ver nota no final do arquivo).
 */
async function requireAuthenticatedUser(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  const authorization = c.req.header('authorization')
  log.debug('[auth] Authorization header present:', Boolean(authorization))
  const { SUPABASE_URL, SUPABASE_ANON_KEY, VITE_SUPABASE_PUBLISHABLE_KEY } = c.env
  // Aceita a chave anon legada ou a chave pública publicada no projeto Supabase.
  // A autorização continua sendo feita pelo Bearer do colaborador; a chave apenas
  // identifica o projeto na chamada /auth/v1/user.
  const supabaseApiKey = SUPABASE_ANON_KEY || VITE_SUPABASE_PUBLISHABLE_KEY

  if (!authorization?.startsWith('Bearer ')) {
    log.debug('[auth] missing Bearer token')
    return false
  }
  if (!SUPABASE_URL) {
    log.warn('[auth] SUPABASE_URL não definido')
    return false
  }
  if (!supabaseApiKey) {
    log.warn('[auth] nenhuma chave pública do Supabase configurada (SUPABASE_ANON_KEY/VITE_SUPABASE_PUBLISHABLE_KEY)')
    return false
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: supabaseApiKey,
        Authorization: authorization,
      },
    })
    log.debug('[auth] supabase /auth/v1/user status:', res.status)
    return res.ok
  } catch (err: any) {
    log.error('[auth] erro ao validar token no Supabase:', err?.message ?? err)
    return false
  }
}

function valuationCacheKey(aircraft: Record<string, unknown>): string {
  const identity = [
    aircraft.id,
    aircraft.registration,
    aircraft.serial_number,
    aircraft.model,
    aircraft.year,
    aircraft.cell_hours_current,
    aircraft.horimeter_end,
  ].map(value => String(value ?? '')).join('|')

  return `windsock-valuation:${identity}`
}

function marketEstimateCacheKey(model: string, year?: number, hours?: number, registration?: string): string {
  const reg = registration?.trim().toUpperCase() ?? ''
  return `windsock-market-estimate:${reg || model.trim().toLowerCase()}|${year ?? ''}|${hours ?? ''}`
}

// ─── Rate limit genérico (KV, best-effort) ────────────────────────────────────
// Usado tanto para Windsock/Claude (buckets pesados) quanto para as rotas
// públicas de proxy da AISWEB (bucket por IP, ver clientBucket()).

async function checkRateLimit(
  c: Context<{ Bindings: Bindings }>,
  bucket: string,
  perMinute: number
): Promise<boolean> {
  const minuteWindow = Math.floor(Date.now() / 60_000)
  const key = `rl:${bucket}:${minuteWindow}`
  const kv = c.env.CACHE_KV
  const current = parseInt((await kv.get(key)) ?? '0', 10)
  if (current >= perMinute) return false
  await kv.put(key, String(current + 1), { expirationTtl: 70 })
  return true
}

/** Identifica o cliente para limitar por IP as rotas públicas (sem auth) que fazem proxy da AISWEB. */
function clientIp(c: Context<{ Bindings: Bindings }>): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
}

// ─── Windsock: resolver make_model_id a partir de texto livre ────────────────

async function resolveMakeModelId(
  c: Context<{ Bindings: Bindings }>,
  modelText: string
): Promise<number | null> {
  const trimmed = modelText.trim()
  if (!trimmed) return null

  const cacheKey = `windsock-makemodel:${trimmed.toLowerCase()}`

  return cachedFetch(c, cacheKey, 30 * 86_400, async () => {
    const allowed = await checkRateLimit(c, 'windsock:reference', 60)
    if (!allowed) throw new Error('Limite de requisições de referência à Windsock atingido')

    const url = `https://windsock.ai/api/v3/references/make-models?q=${encodeURIComponent(trimmed)}&limit=1`
    const res = await fetch(url, { headers: { 'X-API-Key': c.env.WINSOCK_API_KEY } })
    if (!res.ok) throw new Error(`make-models HTTP ${res.status}`)
    const json = await res.json<any>()
    const row = json?.data?.[0]
    return row?.id ?? null
  })
}

// ─── Windsock: montar request e normalizar resposta ───────────────────────────

function buildWindsockRequestBody(aircraft: Record<string, unknown>, makeModelId: number | null) {
  const registration = typeof aircraft.registration === 'string' ? aircraft.registration.trim() : ''
  const isFaaTail = WINSOCK_N_NUMBER.test(registration)

  const aircraft_info: Record<string, unknown> = {}
  if (typeof aircraft.year === 'number') aircraft_info.year = aircraft.year
  const aftt = aircraft.horimeter_end ?? aircraft.cell_hours_current
  if (typeof aftt === 'number') aircraft_info.aftt = aftt

  const body: Record<string, unknown> = { aircraft_info }

  if (isFaaTail) {
    body.registration = registration // aeronave americana de fato — usa o N-number direto
  } else {
    if (!makeModelId) {
      throw new Error('Não foi possível resolver o make/model da aeronave na Windsock (matrícula brasileira precisa de make_model_id)')
    }
    body.make_model_id = makeModelId
  }

  return body
}

/**
 * Normaliza a resposta da Windsock.
 *
 * Formato real da API (v3/valuations):
 * {
 *   data: {
 *     as_of / as_of_date: string,
 *     valuation_mode: string,
 *     valuation: {
 *       prediction_data: { predicted_price, uncertainty, tbo_depreciation, ... },
 *       confidence: number,        // 0-100, IRMÃO de prediction_data (não está dentro dele)
 *       residual: number,
 *       explanation: { summary, key_drivers, by_category, base_value, ... }
 *     }
 *   }
 * }
 *
 * Bug corrigido: o código antigo lia `valuation.prediction_data.confidence`,
 * mas `confidence` fica em `valuation.confidence` — por isso sempre voltava null.
 */
function normalizeWindsockValuation(data: Record<string, any>): Record<string, any> {
  const root = data?.data ?? data
  const valuation = root?.valuation ?? data?.valuation ?? data
  const predicted = valuation?.prediction_data?.predicted_price

  if (typeof predicted !== 'number') {
    throw new Error('Resposta da Windsock sem prediction_data.predicted_price')
  }

  const explanation = valuation?.explanation ?? null

  return {
    estimated_market_value: predicted,
    // confidence vem em escala 0-100 na Windsock; normalizamos de forma defensiva
    // caso algum modo de valuation volte a mandar em fração 0-1.
    confidence: normalizeConfidencePercent(valuation?.confidence),
    uncertainty: valuation?.prediction_data?.uncertainty ?? null,
    as_of: root?.as_of ?? root?.as_of_date ?? null,
    valuation_mode: root?.valuation_mode ?? null,
    // dados extras da explicação — antes descartados, úteis para a UI
    explanation_summary: explanation?.summary ?? null,
    key_drivers: Array.isArray(explanation?.key_drivers) ? explanation.key_drivers : null,
    base_value: explanation?.base_value ?? null,
    total_adjustment: explanation?.total_adjustment ?? null,
    updated_at: new Date().toISOString(),
  }
}

function normalizeConfidencePercent(raw: unknown): number | null {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return null
  // se algum dia vier em fração (0-1), converte para percentual; se já vier 0-100, mantém.
  return raw <= 1 ? raw * 100 : raw
}

async function callWindsockValuationApi(
  c: Context<{ Bindings: Bindings }>,
  body: Record<string, unknown>
): Promise<Record<string, any>> {
  const {
    WINSOCK_VALUATION_URL,
    WINSOCK_API_KEY,
    WINSOCK_AUTH_HEADER = 'X-API-Key',
    WINSOCK_AUTH_PREFIX = '',
  } = c.env

  if (!WINSOCK_VALUATION_URL || !WINSOCK_API_KEY) throw new Error('Integração Windsock não configurada')

  const allowed = await checkRateLimit(c, 'windsock:compute_heavy', 6)
  if (!allowed) throw new Error('Limite de requisições à Windsock atingido (6/min no plano Free) — tente novamente em instantes')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  try {
    const response = await fetch(WINSOCK_VALUATION_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        [WINSOCK_AUTH_HEADER]: `${WINSOCK_AUTH_PREFIX}${WINSOCK_API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      throw new Error(`Rate limit da Windsock excedido${retryAfter ? ` (retry-after: ${retryAfter}s)` : ''}`)
    }

    if (!response.ok) {
      log.error(`[windsock] HTTP ${response.status}:`, (await response.text()).slice(0, 500))
      throw new Error('Falha ao consultar a avaliação da Windsock')
    }

    return normalizeWindsockValuation(await response.json())
  } catch (error: any) {
    if (error.name === 'AbortError') throw new Error('Tempo limite ao consultar a Windsock')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWindsockValuation(
  c: Context<{ Bindings: Bindings }>,
  aircraft: Record<string, unknown>
): Promise<Record<string, any>> {
  const registration = typeof aircraft.registration === 'string' ? aircraft.registration.trim() : ''
  const isFaaTail = WINSOCK_N_NUMBER.test(registration)
  const makeModelId = isFaaTail ? null : await resolveMakeModelId(c, String(aircraft.model ?? ''))

  return callWindsockValuationApi(c, buildWindsockRequestBody(aircraft, makeModelId))
}

async function estimateUsMarketValue(
  c: Context<{ Bindings: Bindings }>,
  input: { model?: string; year?: number; hours?: number; registration?: string }
): Promise<Record<string, any>> {
  const registration = input.registration?.trim() ?? ''
  const isFaaTail = WINSOCK_N_NUMBER.test(registration)
  const aircraft_info: Record<string, unknown> = {}

  if (typeof input.year === 'number') aircraft_info.year = input.year
  if (typeof input.hours === 'number') aircraft_info.aftt = input.hours

  const body: Record<string, unknown> = { aircraft_info }

  if (isFaaTail) {
    body.registration = registration
  } else {
    if (!input.model?.trim()) {
      throw new Error('Informe "model" (ex: "Cessna 172S", "King Air 350") ou uma matrícula americana (N-number)')
    }

    const makeModelId = await resolveMakeModelId(c, input.model)
    if (!makeModelId) throw new Error(`Não foi possível localizar o modelo "${input.model}" na base da Windsock`)
    body.make_model_id = makeModelId
  }

  return callWindsockValuationApi(c, body)
}

const AREA_NODE_MAP: Record<string, string> = {
  met: 'met',
  cartas: 'cartas',
  notam: 'notam',
  infotemp: 'infotemp',
  sol: 'sol',
  // `routesp` é mantido como integração opcional: não é listado na documentação
  // pública atual da AISWEB e pode retornar vazio mesmo com credenciais válidas.
  routesp: 'routesp',
  waypoints: 'waypoints',
  rotaer: 'rotaer',
  pub: 'pub',
  suplementos: 'suplementos',
  geiloc: 'geiloc',
}

// ─── Fetch com Timeout + Edge Cache ──────────────────────────────────────────

async function fetchWithTimeout(url: string, timeout = 10_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ShareBrasil/1.0 (aplicativo aviacao civil; contato@sharebrasil.com.br)',
        'Accept': 'text/xml,application/xml,*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      // @ts-ignore — Cloudflare Workers specific
      cf: { cacheTtl: 300, cacheEverything: true },
    })
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`Timeout na AISWEB após ${timeout}ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ─── Cache SWR + Lock ─────────────────────────────────────────────────────────

async function cachedFetch(
  c: Context<{ Bindings: Bindings }>,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<any>
): Promise<any> {
  const kv = c.env.CACHE_KV
  const raw = await kv.get(key, { type: 'json' }) as any
  const now = Date.now()

  const isNewFormat = raw !== null && typeof raw === 'object' && 'fetchedAt' in raw && 'data' in raw
  const fetchedAt = isNewFormat ? (raw.fetchedAt as number) : 0
  const cachedData = isNewFormat ? raw.data : raw
  const ageSeconds = (now - fetchedAt) / 1000
  const hasCachedData = cachedData !== null && cachedData !== undefined
  const isFresh = hasCachedData && ageSeconds < ttlSeconds
  const isStale = hasCachedData && ageSeconds >= ttlSeconds

  const save = async (data: any) => {
    const payload = JSON.stringify({ data, fetchedAt: Date.now() })
    await kv.put(key, payload, { expirationTtl: ttlSeconds * 4 })
    return data
  }

  if (isFresh) {
    log.debug(`[kv] FRESH key="${key}" age=${Math.round(ageSeconds)}s`)
    return cachedData
  }

  const lockKey = `${key}:lock`

  if (isStale) {
    log.debug(`[kv] STALE key="${key}" — background refresh`)
    const locked = await kv.get(lockKey)
    if (!locked) {
      c.executionCtx.waitUntil(
        (async () => {
          await kv.put(lockKey, '1', { expirationTtl: 60 })
          try {
            await save(await fetcher())
            log.debug(`[kv] Refresh OK key="${key}"`)
          } catch (err: any) {
            log.error(`[kv] Refresh FAIL key="${key}":`, err.message)
          } finally {
            await kv.delete(lockKey)
          }
        })()
      )
    }
    return cachedData
  }

  log.debug(`[kv] MISS key="${key}" — buscando na DECEA`)

  // Se já existe alguém buscando essa chave, tenta aguardar o resultado em vez
  // de disparar um segundo fetch concorrente. Faz até 3 tentativas (~2.1s) antes
  // de desistir de esperar.
  let locked = await kv.get(lockKey)
  if (locked) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 700))
      const retry = await kv.get(key, { type: 'json' }) as any
      if (retry && 'data' in retry) return retry.data
      if (retry) return retry
      locked = await kv.get(lockKey)
      if (!locked) break
    }
  }

  // FIX (race condition): antes, se o lock ainda estivesse ocupado após as
  // tentativas de espera, `acquiredLock` virava `false` e o código pulava o
  // `kv.put` do lock — mas chamava `fetcher()` mesmo assim, sem proteção
  // nenhuma. Isso permitia duas (ou mais) requisições concorrentes disparando
  // fetch pra mesma chave em cache-miss, cada uma pensando que a outra ainda
  // estava "esperando".
  //
  // Agora o lock é SEMPRE marcado antes de chamar fetcher() — mesmo que
  // estivéssemos esperando um lock alheio e ele não tenha liberado a tempo
  // (nesse caso assumimos que o holder anterior pode ter travado/caído e
  // tomamos a vez, mas sob nosso próprio lock) — e SEMPRE liberado no
  // finally. Isso fecha a janela em que um fetch ficava "solto" sem lock.
  await kv.put(lockKey, '1', { expirationTtl: 60 })

  try {
    const data = await fetcher()
    await save(data)
    return data
  } finally {
    await kv.delete(lockKey)
  }
}

// ─── AISWEB Core Fetch ────────────────────────────────────────────────────────

async function fetchAisweb(
  c: Context<{ Bindings: Bindings }>,
  area: string,
  params: Record<string, string | undefined>
): Promise<any> {
  const { AISWEB_API_KEY: apiKey, AISWEB_API_PASS: apiPass } = c.env
  if (!apiKey?.trim() || !apiPass?.trim()) throw new Error('Credenciais AISWEB ausentes')

  const query = new URLSearchParams({ apiKey, apiPass, area })
  Object.entries(params).forEach(([k, v]) => v && query.append(k, v))

  const url = `${AISWEB_BASE_URL}?${query.toString()}`
  const res = await fetchWithTimeout(url, 12_000)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const text = await res.text()
  if (!text) throw new Error('Resposta vazia da AISWEB')

  // ─── Detecta HTML de erro (bloqueio, auth, página de manutenção) ──────────
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<html') || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype')) {
    throw new Error(`AISWEB retornou HTML em vez de XML (bloqueio ou erro de auth): ${text.slice(0, 200)}`)
  }

  try { return JSON.parse(text) } catch { }

  const parsed = parser.parse(text)
  const root = parsed?.aisweb ?? parsed
  const node = AREA_NODE_MAP[area]

  if (!node) return root
  // A AISWEB pode responder tanto com <aisweb><notam>...</notam></aisweb>
  // quanto com JSON/XML já desembrulhado (<notam>...</notam> ou <item>...</item>).
  if (root?.[node] != null) return root[node]
  if (parsed?.[node] != null) return parsed[node]
  if (root?.item != null || Array.isArray(root)) return root

  log.warn(`Node "${node}" ausente para area="${area}". Chaves: [${Object.keys(root ?? {}).join(', ')}]`)
  return root ?? {}
}

/** Converte envelopes AISWEB (`item`, `notam`, `data`) em uma lista plana. */
function collectionItems(value: any): any[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.flatMap(collectionItems)
  if (value.item != null) return collectionItems(value.item)
  if (value.notam != null) return collectionItems(value.notam)
  if (value.data != null && typeof value.data === 'object') return collectionItems(value.data)
  return typeof value === 'object' ? [value] : []
}

function normalizeNotamItems(data: any, icao: string): Record<string, any>[] {
  return collectionItems(data)
    .map((item: any) => ({
      id: String(item?.id ?? item?.['@_id'] ?? `${icao}-${item?.n ?? item?.number ?? crypto.randomUUID()}`),
      icao: String(item?.loc ?? item?.icao ?? item?.icaoairport_id ?? icao).toUpperCase(),
      number: item?.n ?? item?.number ?? item?.cod ?? null,
      type: item?.tp ?? item?.type ?? 'NOTAM',
      category: item?.cat ?? item?.category ?? null,
      message: String(item?.e ?? item?.texto ?? item?.text ?? item?.descricao ?? item?.notam ?? '').trim(),
      start: item?.b ?? item?.startDate ?? null,
      end: item?.c ?? item?.endDate ?? null,
      schedule: item?.d ?? null,
      lower: item?.f ?? item?.lower ?? null,
      upper: item?.g ?? item?.upper ?? null,
      scope: item?.s ?? item?.scope ?? null,
      traffic: item?.traffic ?? null,
      purpose: item?.purpose ?? null,
      coordinates: item?.geo ?? item?.coordinates ?? null,
      source: item?.origem ?? 'AISWEB/DECEA',
    }))
    .filter(item => item.message || item.number)
}

function normalizeRouteItems(data: any, adep: string, ades: string): Record<string, any>[] {
  return collectionItems(data)
    .map((item: any) => ({
      route: String(item?.rota ?? item?.route ?? item?.Route ?? '').trim(),
      level: item?.nivel ?? item?.level ?? item?.fl ?? '',
      type: item?.tipo ?? item?.type ?? '',
      remarks: item?.rmk ?? item?.obs ?? item?.remarks ?? '',
    }))
    .filter(item => item.route)
    .map(item => ({ ...item, adep, ades }))
}

/**
 * Aplica rate limit por IP às rotas públicas (sem autenticação) que fazem
 * proxy da AISWEB. Protege sua cota da API do DECEA contra abuso vindo de
 * qualquer origem, já que o CORS dessas rotas é aberto por padrão.
 */
async function requireAiswebRateLimit(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  return checkRateLimit(c, `aisweb-public:${clientIp(c)}`, 60)
}

// ─── Geo Helpers ──────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function parseCoord(raw: any): number | null {
  if (raw == null) return null
  if (typeof raw === 'number') return raw
  const s = String(raw).trim()
  if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s)
  const gms = s.match(/^(\d{2,3})(\d{2})(\d{2})([NSEW])$/i)
  if (gms) {
    const dec = parseInt(gms[1]) + parseInt(gms[2]) / 60 + parseInt(gms[3]) / 3600
    return ['S', 'W'].includes(gms[4].toUpperCase()) ? -dec : dec
  }
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

function metarNumber(value: string): number | null {
  if (!value) return null
  const normalized = value.startsWith('M') ? `-${value.slice(1)}` : value
  const number = Number(normalized)
  return Number.isFinite(number) ? number : null
}

function decodeMetar(metar: string): Record<string, any> {
  const tokens = metar.trim().split(/\s+/).filter(Boolean)
  const windToken = tokens.find(token => /^(VRB|\d{3})\d{2,3}(G\d{2,3})?KT$/.test(token))
  const temperatureToken = tokens.find(token => /^M?\d{2}/.test(token) && token.includes('/'))
  const qnhToken = tokens.find(token => /^Q\d{4}$/.test(token) || /^A\d{4}$/.test(token))
  const timeToken = tokens.find(token => /^\d{6}Z$/.test(token))
  const windMatch = windToken?.match(/^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?KT$/)
  const temperatureMatch = temperatureToken?.match(/^(M?\d{2})\/(M?\d{2}|XX)$/)
  const qnhMatch = qnhToken?.match(/^([QA])(\d{4})$/)
  const windDirection = windMatch?.[1] === 'VRB' ? null : Number(windMatch?.[1])
  const qnh = qnhMatch ? (qnhMatch[1] === 'Q' ? Number(qnhMatch[2]) : Math.round(Number(qnhMatch[2]) * 33.8639)) : null
  return {
    observed_at: timeToken ?? null,
    temperature_c: temperatureMatch ? metarNumber(temperatureMatch[1]) : null,
    dew_point_c: temperatureMatch && temperatureMatch[2] !== 'XX' ? metarNumber(temperatureMatch[2]) : null,
    qnh_hpa: qnh,
    wind: windMatch ? {
      direction_deg: windDirection,
      speed_kt: Number(windMatch[2]),
      gust_kt: windMatch[3] ? Number(windMatch[3]) : null,
      variable: windMatch[1] === 'VRB',
    } : null,
  }
}

function normalizeMet(data: any, icao: string): Record<string, any> {
  if (!data || typeof data !== 'object') return { loc: icao, metar: '', taf: '', ...decodeMetar('') }

  const metarStr =
    (typeof data.rawOb === 'string' ? data.rawOb : null) ??
    (typeof data.metar === 'string' ? data.metar : null) ??
    (typeof data.metar?.metar === 'string' ? data.metar.metar : null) ??
    (typeof data.metar?.raw === 'string' ? data.metar.raw : null) ??
    ''

  const tafStr =
    (typeof data.taf === 'string' ? data.taf : null) ??
    (typeof data.taf?.taf === 'string' ? data.taf.taf : null) ??
    (typeof data.taf?.raw === 'string' ? data.taf.raw : null) ??
    ''

  log.debug(`[MET RAW] ${icao}:`, JSON.stringify(data).slice(0, 500))

  if (!metarStr && !tafStr) {
    throw new Error(`METAR/TAF vazio para ${icao}`)
  }

  return {
    loc: data.metar?.loc ?? data.loc ?? icao,
    metar: metarStr,
    taf: tafStr,
    ...decodeMetar(metarStr),
    source: 'AISWEB/DECEA',
  }
}

function rotaerItems(data: any): any[] {
  const items = data?.item ?? data
  return Array.isArray(items) ? items : (items ? [items] : [])
}

function rotaerIcao(item: any): string {
  return String(item?.AeroCode ?? item?.IcaoCode ?? item?.icaoCode ?? item?.icao ?? item?.CodICAO ?? '').toUpperCase()
}

function normalizeCharts(data: any): Record<string, any> {
  const item = Array.isArray(data?.item) ? data.item : (data?.item ? [data.item] : [])
  return {
    ...data,
    item,
    charts: item.map((chart: any) => ({
      title: chart?.nome ?? chart?.title ?? '',
      tipo: chart?.tipo_descr ?? chart?.tipo ?? '',
      descricao: chart?.especie ?? chart?.descricao ?? '',
      url: typeof chart?.link === 'string' ? chart.link.replaceAll('&amp;', '&') : (chart?.url ?? ''),
    })),
  }
}

function normalizeAirportList(data: any, userLat: number, userLon: number): Airport[] {
  const list: Airport[] = []
  for (const item of rotaerItems(data)) {
    const icao = rotaerIcao(item)
    if (!icao) continue
    const lat = parseCoord(item?.latitude ?? item?.lat)
    const lon = parseCoord(item?.longitude ?? item?.lng ?? item?.lon)
    if (lat == null || lon == null) continue
    list.push({ icao, name: item?.nome ?? item?.name ?? icao, lat, lon, distKm: Math.round(haversineKm(userLat, userLon, lat, lon)) })
  }
  return list
}

function normalizeRotaerAirport(item: any, fallbackIcao = ''): Record<string, any> {
  const source = item?.aerodrome ?? item?.airport ?? item?.rotaer ?? item ?? {}
  const rawCoordinates = source.coordinates ?? source.coordenadas
  const lat = rawCoordinates?.lat ?? rawCoordinates?.latitude ?? parseCoord(source.latitude ?? source.lat)
  const lng = rawCoordinates?.lng ?? rawCoordinates?.lon ?? rawCoordinates?.longitude ?? parseCoord(source.longitude ?? source.lng ?? source.lon)
  const runways = source.runways ?? source.pistas ?? source.runway ?? []
  const frequencies = source.frequencies ?? source.frequencias ?? source.frequency ?? []
  const restrictions = source.restrictions ?? source.restricoes ?? source.observacoes ?? []
  return {
    ...source,
    icao: rotaerIcao(source) || fallbackIcao,
    name: source.name ?? source.nome ?? source.designacao ?? source.AerodromeName ?? fallbackIcao,
    city: source.city ?? source.cidade ?? source.municipio,
    state: source.state ?? source.uf ?? source.estado,
    elevation: source.elevation ?? source.elevacao ?? source.altitude ?? source.Elev,
    coordinates: lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null,
    runways: Array.isArray(runways) ? runways : [runways].filter(Boolean),
    frequencies: Array.isArray(frequencies) ? frequencies : [frequencies].filter(Boolean),
    restrictions: Array.isArray(restrictions) ? restrictions : [restrictions].filter(Boolean),
    contact: source.contact ?? source.contato ?? {
      phone: source.phone ?? source.telefone ?? source.tel,
      email: source.email,
    },
    raw_data: source,
  }
}
async function fetchRotaerByIcao(c: Context<{ Bindings: Bindings }>, icao: string): Promise<any> {
  const normalizedIcao = icao.trim().toUpperCase()
  try {
    const detail = await cachedFetch(c, `rotaer-detail-${normalizedIcao}`, 1800,
      () => fetchAisweb(c, 'rotaer', { icaoCode: normalizedIcao }))
    const detailItem = rotaerItems(detail).find(item => rotaerIcao(item) === normalizedIcao) ?? rotaerItems(detail)[0]
    if (detailItem) return normalizeRotaerAirport(detailItem, normalizedIcao)
  } catch (error: any) {
    log.warn(`[rotaer] ficha detalhada indisponível para ${normalizedIcao}: ${error.message}`)
  }
  const data = await cachedFetch(c, 'rotaer-all', 1800, () => fetchAisweb(c, 'rotaer', {}))
  const airport = rotaerItems(data).find(item => rotaerIcao(item) === normalizedIcao)
  if (!airport) throw new Error(`Aeródromo ${normalizedIcao} não encontrado no ROTAER/AISWEB`)
  return normalizeRotaerAirport(airport, normalizedIcao)
}

// ─── Nearby helper: tenta geiloc (4s), fallback para rotaer-all ──────────────

async function fetchNearby(
  c: Context<{ Bindings: Bindings }>,
  lat: number,
  lon: number
): Promise<Airport[]> {
  const cacheKey = `geiloc-${Math.round(lat * 10)}-${Math.round(lon * 10)}`

  try {
    const data = await cachedFetch(c, cacheKey, 1800, () =>
      Promise.race([
        fetchAisweb(c, 'geiloc', { lat: String(lat), lon: String(lon) }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('geiloc timeout interno')), 4_000)),
      ])
    )
    const list = normalizeAirportList(data, lat, lon)
    if (list.length > 0) return list
    throw new Error('geiloc retornou lista vazia')
  } catch (err: any) {
    log.warn(`[nearby] geiloc falhou (${err.message}), usando rotaer como fallback`)
    const data = await cachedFetch(c, 'rotaer-all', 1800, () => fetchAisweb(c, 'rotaer', {}))
    return normalizeAirportList(data, lat, lon)
  }
}

// ─── Helpers: arquivos, short links e auth ────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID()
}

function shortCode(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8)
}

/**
 * Compara dois tokens em tempo constante para evitar timing attacks.
 *
 * Importante: NÃO retornamos cedo quando os tamanhos diferem — isso vazaria
 * o tamanho do token via timing (o caso "tamanhos diferentes" seria sempre
 * mais rápido que o caso "tamanhos iguais mas conteúdo diferente"). Em vez
 * disso, aplicamos SHA-256 nos dois valores antes de comparar: hash sempre
 * tem tamanho fixo (32 bytes), então `crypto.subtle.timingSafeEqual` nunca
 * lança exceção por tamanho e o tempo de execução não varia com o input.
 *
 * `crypto.subtle.timingSafeEqual` é uma extensão não padrão do runtime do
 * Cloudflare Workers (não faz parte da Web Crypto API padrão) — só funciona
 * nesse ambiente.
 */
async function timingSafeTokenMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  // @ts-ignore — extensão do runtime Cloudflare Workers, não faz parte do lib.dom.d.ts
  return crypto.subtle.timingSafeEqual(hashA, hashB)
}

/** Protege rotas sensíveis (upload, envio de email, OCR). Chamado no início de cada handler. */
async function checkInternalAuth(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  const token = c.req.header('x-internal-token')
  const expected = c.env.INTERNAL_TOKEN
  if (!expected || !token) return false
  return timingSafeTokenMatch(token, expected)
}

/**
 * Extrai o user_id (sub) do JWT do Supabase enviado pelo front, SEM validar assinatura.
 * Serve só para rastreabilidade (quem disparou o envio) — a autorização real
 * é feita pelo x-internal-token. Se quiser validar a assinatura de verdade,
 * dá pra usar a JWKS do Supabase (GET /auth/v1/.well-known/jwks.json) com jose.
 *
 * IMPORTANTE: como a assinatura não é validada aqui, o valor retornado só é
 * confiável quando a requisição também passou por `requireAuthenticatedUser`
 * (que valida o token contra o Supabase). Em rotas liberadas só por
 * `checkInternalAuth` (chamada servidor-a-servidor), um JWT arbitrário pode
 * ser anexado e o `sub` pode ser forjado — por isso não deve ser usado como
 * valor de auditoria nesse caminho (ver uso em /api/send-email).
 */
function extractSupabaseUserId(c: Context<{ Bindings: Bindings }>): string | null {
  const authHeader = c.req.header('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  try {
    const token = authHeader.slice(7)
    const payloadB64 = token.split('.')[1]
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
    return payload?.sub ?? null
  } catch {
    return null
  }
}

type Colaborador = {
  id: string
  email: string
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
  cliente_id: string | null
}

type ColaboradorClaims = { id: string; email: string }

function extractSupabaseClaims(c: Context<{ Bindings: Bindings }>): ColaboradorClaims | null {
  const authHeader = c.req.header('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  try {
    const token = authHeader.slice(7)
    const payloadB64 = token.split('.')[1]
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
    const id = typeof payload?.sub === 'string' ? payload.sub : ''
    const email = typeof payload?.email === 'string' ? payload.email.toLowerCase() : ''
    return id && email ? { id, email } : null
  } catch {
    return null
  }
}

async function authenticatedColaborador(c: Context<{ Bindings: Bindings }>): Promise<Colaborador | null> {
  if (!(await requireAuthenticatedUser(c))) return null
  const claims = extractSupabaseClaims(c)
  if (!claims) return null
  return portalDb(c).prepare('SELECT * FROM user_profiles WHERE id = ?1 OR lower(email) = ?2 LIMIT 1').bind(claims.id, claims.email).first<Colaborador>()
}

function colaboradorExtensao(file: File): string {
  return file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
}

function bucketColaborador(c: Context<{ Bindings: Bindings }>): R2Bucket {
  return c.env.SHARE_FILES || c.env.FILES
}

function bucketParaChaveColaborador(c: Context<{ Bindings: Bindings }>, key: string): R2Bucket {
  return key.startsWith('avatar_profiles/') || key.startsWith('documentos_colaboradores/') ? bucketColaborador(c) : c.env.FILES
}

async function salvarArquivoColaborador(c: Context<{ Bindings: Bindings }>, userId: string, file: File, pasta: 'avatar_profiles' | 'documentos_colaboradores'): Promise<string> {
  if (!file.size) throw new Error('arquivo_vazio')
  if (file.size > 10 * 1024 * 1024) throw new Error('arquivo_excede_10mb')
  const key = `${pasta}/${userId}/${Date.now()}-${uuid().slice(0, 8)}.${colaboradorExtensao(file)}`
  await bucketColaborador(c).put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } })
  return key
}

function documentoColaborador(row: Record<string, unknown>) {
  return {
    id: row.id,
    tipo_documento: row.categoria || 'documentos',
    nome_arquivo: row.nome_arquivo,
    mime_type: row.tipo_arquivo,
    tamanho_bytes: row.tamanho_arquivo || 0,
    status: 'em_analise',
    criado_em: row.criado_em,
    atualizado_em: row.criado_em,
    arquivo_url: `/api/colaborador/documentos/${row.id}/arquivo`,
  }
}

/**
 * Converte um ArrayBuffer (conteúdo lido do R2) para base64, em chunks para
 * não estourar o limite de argumentos do String.fromCharCode em arquivos grandes.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000 // evita estourar o limite de argumentos do String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

const MAX_ATTACHMENT_TOTAL_SIZE = 25 * 1024 * 1024 // 25MB (limite comum de provedores de email)

// ═══════════════════════════════════════════════════════════════════════════
// Demonstrativo OCR (Claude Vision / Document) — versão revisada
// ═══════════════════════════════════════════════════════════════════════════
// Substitui a antiga Supabase Edge Function "demonstrativo-ocr" do Lovable e
// o worker separado que usava Groq Vision para extração + rateio.
//
// Pontos endurecidos em relação à primeira versão:
// - Suporte real a PDF (bloco `type: 'document'`) além de imagem — a
//   primeira versão só funcionava com imagem, e PDF é o formato mais comum
//   de demonstrativo INFRAERO/DECEA.
// - Modelo atualizado para claude-sonnet-5.
// - Validação de tamanho (5MB imagem / 32MB PDF) antes de gastar chamada de API.
// - Retry automático se a resposta truncar por max_tokens.
// - Sanity check: soma dos itens vs. valor_total extraído, sinalizando
//   `_meta.precisa_revisao_manual` quando divergem.
// - Não descarta mais itens com valor 0 (ex: operações isentas).
// - NOVO: extração de origem/destino por trecho (quando o documento traz),
//   usada pela rota /api/demonstrativo-rateio para casar cada operação com o
//   diário de bordo (Supabase) e apurar o responsável (cliente ou sócio) —
//   função que antes vivia em um worker Groq separado.

type TipoDemo = 'INFRAERO' | 'DECEA' | 'POUSO'
const TIPOS_VALIDOS: TipoDemo[] = ['INFRAERO', 'DECEA', 'POUSO']

const DEMO_TIPO_CONTEXT: Record<TipoDemo, string> = {
  INFRAERO: 'um demonstrativo de Tarifa INFRAERO (tarifas aeroportuárias cobradas pela INFRAERO)',
  DECEA: 'um demonstrativo de Tarifa DECEA (tarifas de navegação aérea cobradas pelo DECEA)',
  POUSO: 'um demonstrativo de Tarifa de Pouso',
}

const DEMO_OCR_SYSTEM_PROMPT = (tipo: TipoDemo) => `Você é um especialista em leitura de demonstrativos financeiros da aviação civil brasileira.
O documento enviado é ${DEMO_TIPO_CONTEXT[tipo]}.

Extraia os dados e responda APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, no seguinte formato exato:

{
  "tipo": "${tipo}",
  "numero_documento": string ou null,
  "competencia": string ou null (formato MM/YYYY se disponível),
  "data_faturamento": string ou null (formato DD/MM/YYYY),
  "aeronave_matricula": string ou null,
  "cliente_nome": string ou null,
  "valor_total": number ou null,
  "itens": [
    {
      "data": string (formato DD/MM/YYYY),
      "hora": string ou omitido,
      "operacao": string ou omitido (ex: código ICAO do aeródromo, quando a linha só cita um local),
      "origem": string ou omitido (código ICAO de origem do trecho — preencha quando o documento listar origem e destino separados, o que é comum em demonstrativos DECEA),
      "destino": string ou omitido (código ICAO de destino do trecho),
      "matricula": string ou omitido (matrícula da aeronave daquela linha, se vier por linha),
      "valor": number
    }
  ]
}

Regras importantes:
- Extraia TODAS as linhas/operações listadas no documento, uma por item em "itens", mesmo que o documento tenha várias páginas.
- Se a linha trouxer origem e destino separados, preencha "origem" e "destino" (não preencha "operacao" nesse caso). Se trouxer só um aeródromo, preencha "operacao" e omita origem/destino.
- Valores monetários devem ser números (ponto decimal, sem "R$", sem separador de milhar).
- Inclua itens com valor 0 (ex: operações isentas) — não os omita.
- "valor_total" deve ser o total exatamente como impresso no documento. Se não houver um total explícito, use null.
- Se um campo não existir no documento, use null (campos do topo) ou omita a chave (campos opcionais dos itens).
- Nunca invente dados que não estejam visíveis no documento.
- Responda SOMENTE com o JSON, nada mais.`

function extractJsonFromText(text: string): any {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('Resposta da IA não contém JSON válido')
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch (err: any) {
    throw new Error(`JSON inválido na resposta da IA (possível truncamento): ${err.message}`)
  }
}

// ─── Validação e montagem do bloco de conteúdo (imagem OU PDF) ────────────

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const SUPPORTED_DOC_TYPES = new Set(['application/pdf'])
const MAX_IMAGE_BYTES = 5 * 1024 * 1024   // limite da Anthropic p/ imagem
const MAX_PDF_BYTES = 32 * 1024 * 1024    // limite da Anthropic p/ PDF

function base64ByteLength(b64: string): number {
  const clean = b64.replace(/=+$/, '')
  return Math.floor((clean.length * 3) / 4)
}

function buildContentBlock(dataBase64: string, mimeType: string): Record<string, any> {
  if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    const size = base64ByteLength(dataBase64)
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(`Imagem excede o limite de 5MB (${(size / 1024 / 1024).toFixed(1)}MB) — comprima ou envie como PDF`)
    }
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data: dataBase64 } }
  }

  if (SUPPORTED_DOC_TYPES.has(mimeType)) {
    const size = base64ByteLength(dataBase64)
    if (size > MAX_PDF_BYTES) {
      throw new Error(`PDF excede o limite de 32MB (${(size / 1024 / 1024).toFixed(1)}MB)`)
    }
    return { type: 'document', source: { type: 'base64', media_type: mimeType, data: dataBase64 } }
  }

  throw new Error(`mimeType não suportado: "${mimeType}" (use image/jpeg, image/png, image/gif, image/webp ou application/pdf)`)
}

// ─── Chamada à Anthropic, com retry em caso de truncamento ────────────────

const CLAUDE_MODEL = 'claude-sonnet-5'

async function callClaudeExtraction(
  c: Context<{ Bindings: Bindings }>,
  dataBase64: string,
  mimeType: string,
  tipo: TipoDemo
): Promise<any> {
  const { ANTHROPIC_API_KEY } = c.env
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY não configurada')

  const contentBlock = buildContentBlock(dataBase64, mimeType)

  const request = async (maxTokens: number) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: maxTokens,
          system: DEMO_OCR_SYSTEM_PROMPT(tipo),
          messages: [
            {
              role: 'user',
              content: [
                contentBlock,
                { type: 'text', text: 'Extraia os dados deste demonstrativo conforme as instruções.' },
              ],
            },
          ],
        }),
      })

      if (!response.ok) {
        const errText = await response.text()
        log.error('[demonstrativo-ocr] Claude HTTP', response.status, errText.slice(0, 500))
        throw new Error(`Falha ao consultar IA (HTTP ${response.status})`)
      }

      return await response.json<any>()
    } catch (error: any) {
      if (error.name === 'AbortError') throw new Error('Tempo limite ao consultar a IA')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  let data = await request(8192)

  // Se cortou por limite de tokens (documento com muitas linhas), refaz uma vez com mais espaço
  if (data?.stop_reason === 'max_tokens') {
    log.warn('[demonstrativo-ocr] resposta truncada (max_tokens=8192), refazendo com 16384')
    data = await request(16384)
    if (data?.stop_reason === 'max_tokens') {
      throw new Error('Demonstrativo grande demais para extrair em uma única chamada — considere dividir em páginas menores')
    }
  }

  const textBlock = data?.content?.find((b: any) => b.type === 'text')
  if (!textBlock?.text) throw new Error('Resposta da IA sem conteúdo de texto')

  return extractJsonFromText(textBlock.text)
}

// ─── Normalização + sanity check (soma dos itens vs. total extraído) ──────

interface ItemDemonstrativo {
  data: string
  hora?: string
  operacao?: string
  origem?: string
  destino?: string
  matricula?: string
  valor: number
}

function normalizeDemoResult(raw: any, tipo: TipoDemo): Record<string, any> {
  const itensRaw = Array.isArray(raw?.itens) ? raw.itens : []

  const itens: ItemDemonstrativo[] = itensRaw
    .map((it: any) => ({
      data: String(it?.data ?? ''),
      hora: it?.hora ? String(it.hora) : undefined,
      operacao: it?.operacao ? String(it.operacao) : undefined,
      origem: it?.origem ? String(it.origem).toUpperCase() : undefined,
      destino: it?.destino ? String(it.destino).toUpperCase() : undefined,
      matricula: it?.matricula ? String(it.matricula).toUpperCase() : undefined,
      valor: typeof it?.valor === 'number'
        ? it.valor
        : parseFloat(String(it?.valor ?? '').replace(',', '.')),
    }))
    // mantém itens com valor 0 (ex: operações isentas); só descarta linha sem data ou com valor inválido
    .filter((it: ItemDemonstrativo) => it.data && !Number.isNaN(it.valor))

  const somaItens = itens.reduce((s: number, i: ItemDemonstrativo) => s + i.valor, 0)
  const valorTotalExtraido = typeof raw?.valor_total === 'number' ? raw.valor_total : null
  const valorTotal = valorTotalExtraido ?? (itens.length ? somaItens : null)

  const divergencia = valorTotalExtraido != null && itens.length
    ? Math.abs(valorTotalExtraido - somaItens)
    : 0

  return {
    tipo,
    numero_documento: raw?.numero_documento ?? null,
    competencia: raw?.competencia ?? null,
    data_faturamento: raw?.data_faturamento ?? null,
    aeronave_matricula: raw?.aeronave_matricula ?? null,
    cliente_nome: raw?.cliente_nome ?? null,
    valor_total: valorTotal,
    itens,
    _meta: {
      soma_itens: itens.length ? Math.round(somaItens * 100) / 100 : null,
      precisa_revisao_manual: divergencia > 0.05, // mais de 5 centavos de diferença
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Rateio por cliente/sócio — casa cada item do demonstrativo com o diário de
// bordo (Supabase) para descobrir o responsável e somar o total por pessoa.
// ═══════════════════════════════════════════════════════════════════════════
// Migrado do worker separado que usava Groq Vision: aqui reaproveitamos a
// extração via Claude (callClaudeExtraction) e o SUPABASE_URL/SUPABASE_ANON_KEY
// que o worker já usa para autenticação — não precisa de nenhum secret novo.
//
// IMPORTANTE: essa consulta usa SUPABASE_ANON_KEY (chave pública) para ler
// `lancamentos_diario_bordo` via PostgREST. Isso só é seguro se a Row Level
// Security dessa tabela estiver configurada para restringir corretamente o
// que o papel `anon` pode enxergar — vale confirmar isso no painel do
// Supabase, já que os dados aqui são financeiros/pessoais.

interface ItemRateio extends ItemDemonstrativo {
  responsavel: string
}

const RATEIO_SEM_MATCH = 'Não Identificado / Traslado'

/** Converte "DD/MM/YYYY" (formato do OCR) para "YYYY-MM-DD" (formato esperado pelo Postgres/PostgREST). */
function brDateToIso(brDate: string): string | null {
  const m = brDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  const [, dd, mm, yyyy] = m
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Busca em `lancamentos_diario_bordo` o trecho que bate com matrícula + data +
 * aeródromo de partida/chegada, e devolve o nome do cliente ou sócio responsável.
 * Usa a REST API do Supabase (PostgREST) diretamente, como o worker Groq original.
 */
async function buscarResponsavelLancamento(
  c: Context<{ Bindings: Bindings }>,
  item: Pick<ItemDemonstrativo, 'data' | 'origem' | 'destino' | 'matricula'>
): Promise<string> {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = c.env
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Supabase não configurado (SUPABASE_URL/SUPABASE_ANON_KEY)')
  if (!item.matricula || !item.origem || !item.destino) return RATEIO_SEM_MATCH

  const dataRegistro = brDateToIso(item.data)
  if (!dataRegistro) return RATEIO_SEM_MATCH

  const queryParams = new URLSearchParams({
    select: 'id, clientes_id, clientes(nome), socios_id, socios(nome), aeronave!inner(matricula)',
    'aeronave.matricula': `eq.${item.matricula}`,
    data_registro: `eq.${dataRegistro}`,
    aerodromo_partida: `eq.${item.origem}`,
    aerodromo_chegada: `eq.${item.destino}`,
    limit: '1',
  })

  const url = `${SUPABASE_URL}/rest/v1/lancamentos_diario_bordo?${queryParams.toString()}`

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    log.warn(`[rateio] falha ao consultar lancamentos_diario_bordo (HTTP ${res.status}) para ${item.matricula} ${item.origem}-${item.destino} em ${item.data}`)
    return RATEIO_SEM_MATCH
  }

  const rows = await res.json<any[]>()
  const trecho = rows?.[0]
  if (!trecho) return RATEIO_SEM_MATCH

  return trecho.clientes?.nome ?? trecho.socios?.nome ?? RATEIO_SEM_MATCH
}

/**
 * Monta o relatório de rateio por perna + total por cliente/sócio.
 * Sequencial de propósito: o volume típico de um demonstrativo mensal (dezenas
 * de linhas) não justifica paralelizar contra a REST API do Supabase.
 */
async function montarRelatorioRateio(
  c: Context<{ Bindings: Bindings }>,
  itens: ItemDemonstrativo[]
): Promise<{ relatorio: ItemRateio[]; totalPorCliente: Record<string, number> }> {
  const relatorio: ItemRateio[] = []
  const totalPorCliente: Record<string, number> = {}

  for (const item of itens) {
    const responsavel = await buscarResponsavelLancamento(c, item)
    relatorio.push({ ...item, responsavel })
    totalPorCliente[responsavel] = Math.round(((totalPorCliente[responsavel] ?? 0) + item.valor) * 100) / 100
  }

  return { relatorio, totalPorCliente }
}

// ─── Routes: AISWEB (existentes) ──────────────────────────────────────────────

app.get('/', (c) => c.text('ShareBrasil API 🚀'))

/**
 * Handler compartilhado de valuation, registrado em /api/valuation (singular)
 * e /api/valuations (plural) — mesma lógica, duas rotas.
 *
 * Aceita tanto um usuário Supabase autenticado quanto o x-internal-token
 * (checkInternalAuth), para permitir chamadas internas/servidor-a-servidor
 * sem sessão de usuário.
 */
async function valuationHandler(c: Context<{ Bindings: Bindings }>) {
  try {
    const authOk = (await requireAuthenticatedUser(c)) || (await checkInternalAuth(c))
    if (!authOk) {
      log.debug('[valuation] auth failed; authorization present:', Boolean(c.req.header('authorization')))
      return c.json({ error: 'Não autorizado' }, 401)
    }

    const aircraft = await c.req.json<Record<string, unknown>>()
    if (!aircraft || typeof aircraft !== 'object' || Array.isArray(aircraft)) {
      return c.json({ error: 'Dados da aeronave inválidos' }, 400)
    }

    const hasIdentity = ['id', 'registration', 'serial_number'].some(key => typeof aircraft[key] === 'string' && aircraft[key].trim())
    if (!hasIdentity) return c.json({ error: 'Informe id, registration ou serial_number da aeronave' }, 400)

    const valuation = await cachedFetch(
      c,
      valuationCacheKey(aircraft),
      WINSOCK_VALUATION_CACHE_TTL,
      () => fetchWindsockValuation(c, aircraft)
    )

    return c.json(valuation)
  } catch (error: any) {
    log.error('[windsock]', error?.message ?? error)
    return c.json({ error: error?.message === 'Integração Windsock não configurada' ? error.message : 'Não foi possível obter a avaliação da aeronave' }, 502)
  }
}

app.post('/api/valuation', valuationHandler)
app.post('/api/valuations', valuationHandler)

app.post('/api/us-aircraft-estimate', async (c) => {
  try {
    if (!(await requireAuthenticatedUser(c))) return c.json({ error: 'Não autorizado' }, 401)

    const input = await c.req.json<{ model?: string; year?: number; hours?: number; registration?: string }>()
    if (!input.model?.trim() && !input.registration?.trim()) {
      return c.json({ error: 'Informe "model" ou "registration"' }, 400)
    }

    const estimate = await cachedFetch(
      c,
      marketEstimateCacheKey(input.model ?? '', input.year, input.hours, input.registration),
      WINSOCK_VALUATION_CACHE_TTL,
      () => estimateUsMarketValue(c, input)
    )

    return c.json({ query: input, ...estimate })
  } catch (error: any) {
    log.error('[windsock-market-estimate]', error.message)
    return c.json({ error: error.message }, 502)
  }
})

app.get('/api/turn/ice-servers', async (c) => {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ') || !(await requireAuthenticatedUser(c))) {
    return c.json({ error: 'Não autorizado' }, 401)
  }
  const keyId = c.env.CLOUDFLARE_TURN_KEY_ID
  const apiToken = c.env.CLOUDFLARE_TURN_API_TOKEN
  if (!keyId || !apiToken) {
    return c.json({ error: 'TURN Cloudflare ainda não está configurado no Worker.' }, 503)
  }
  const ttlRaw = Number(c.req.query('ttl') ?? 3600)
  const ttl = Number.isFinite(ttlRaw) ? Math.min(Math.max(Math.floor(ttlRaw), 600), 86_400) : 3600
  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }),
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) {
      log.warn(`[turn] Cloudflare respondeu ${response.status}`)
      return c.json({ error: 'Não foi possível gerar credenciais TURN temporárias.' }, 502)
    }
    return c.json({ ...payload, ttl, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), provider: 'cloudflare' })
  } catch (error: any) {
    log.error('[turn] erro ao gerar credenciais:', error?.message ?? error)
    return c.json({ error: 'Falha de comunicação com o serviço TURN.' }, 502)
  }
})

app.get('/api/aerodromos', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const query = (c.req.query('q') ?? '').trim().toUpperCase()
  try {
    const data = await cachedFetch(c, 'rotaer-all', 1800, () => fetchAisweb(c, 'rotaer', {}))
    const aerodromos = rotaerItems(data)
      .map(item => ({
        id: rotaerIcao(item),
        label: `${rotaerIcao(item)} · ${item?.nome ?? item?.name ?? item?.cidade ?? rotaerIcao(item)}`,
        name: item?.nome ?? item?.name ?? item?.cidade ?? rotaerIcao(item),
        city: item?.cidade ?? item?.city ?? null,
      }))
      .filter(item => item.id && (!query || `${item.id} ${item.label}`.includes(query)))
      .slice(0, 100)
    return c.json({ aerodromos, source: 'AISWEB/DECEA' })
  } catch (e: any) {
    return c.json({ error: e.message }, 502)
  }
})

app.get('/api/weather/:icao', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const icao = c.req.param('icao').toUpperCase()
  try {
    const data = await cachedFetch(c, `metar-${icao}`, 300, () => fetchAisweb(c, 'met', { icaoCode: icao }))
    return c.json(normalizeMet(data, icao))
  } catch (e: any) {
    log.error(`[weather] ${icao}:`, e.message)
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/notam/:icao', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const icao = c.req.param('icao').trim().toUpperCase()
  if (!/^[A-Z]{4}$/.test(icao)) return c.json({ error: 'ICAO inválido' }, 400)
  try {
    const data = await cachedFetch(c, `notam-${icao}`, 600, () => fetchAisweb(c, 'notam', { icaoCode: icao }))
    return c.json({ icao, notams: normalizeNotamItems(data, icao), fetched_at: new Date().toISOString(), source: 'AISWEB/DECEA' })
  } catch (e: any) {
    log.error(`[notam] ${icao}:`, e.message)
    return c.json({ icao, notams: [], error: e.message }, 502)
  }
})

app.get('/api/charts/:icao', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const icao = c.req.param('icao').toUpperCase()
  const especie = c.req.query('especie'), tipo = c.req.query('tipo')
  try {
    const data = await cachedFetch(c, `charts-${icao}-${especie ?? ''}-${tipo ?? ''}`, 3600,
      () => fetchAisweb(c, 'cartas', { icaoCode: icao, especie, tipo }))
    return c.json(normalizeCharts(data))
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

async function getRotaer(c: Context<{ Bindings: Bindings }>, icaoParam?: string) {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const icaoCode = (icaoParam ?? c.req.query('icaoCode') ?? c.req.query('icao'))?.trim().toUpperCase()
  const adep = c.req.query('adep')?.trim().toUpperCase()
  const ades = c.req.query('ades')?.trim().toUpperCase()

  if (!icaoCode && !adep && !ades) {
    return c.json({ error: 'Informe icaoCode, icao, adep ou ades' }, 400)
  }

  try {
    if (icaoCode) {
      const airport = await fetchRotaerByIcao(c, icaoCode)
      return c.json({ item: [airport], airport, icao: icaoCode, source: 'AISWEB/DECEA' })
    }

    const data = await cachedFetch(c, `rotaer-${adep ?? ''}-${ades ?? ''}`, 1800,
      () => fetchAisweb(c, 'rotaer', { adep, ades }))
    return c.json(data)
  } catch (e: any) {
    log.error(`[rotaer] ${icaoCode ?? `${adep ?? ''}-${ades ?? ''}`}:`, e.message)
    return c.json({ error: e.message }, 500)
  }
}

app.get('/api/rotaer', (c) => getRotaer(c))
app.get('/api/rotaer/:icao', (c) => getRotaer(c, c.req.param('icao')))

app.get('/api/routes', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const adep = c.req.query('adep')?.trim().toUpperCase()
  const ades = c.req.query('ades')?.trim().toUpperCase()
  if (!adep || !ades) return c.json({ error: 'adep e ades são obrigatórios' }, 400)
  if (!/^[A-Z]{4}$/.test(adep) || !/^[A-Z]{4}$/.test(ades)) return c.json({ error: 'adep e ades devem ser códigos ICAO válidos' }, 400)
  try {
    const data = await cachedFetch(c, `routes-${adep}-${ades}`, 3600, () => fetchAisweb(c, 'routesp', { adep, ades }))
    const preferred = normalizeRouteItems(data, adep, ades)
    const routes = preferred.length > 0
      ? preferred.map(({ adep: _adep, ades: _ades, ...route }) => route)
      : [{
          route: `${adep} DCT ${ades}`,
          level: '',
          type: 'DCT',
          remarks: 'Rota direta sugerida; a AISWEB não retornou uma rota preferencial publicada para este trecho.',
          source: 'fallback',
        }]
    return c.json({ adep, ades, routes, preferred_available: preferred.length > 0, source: preferred.length > 0 ? 'AISWEB/DECEA' : 'fallback' })
  } catch (e: any) {
    log.warn(`[routes] ${adep}-${ades}: ${e.message}; usando rota direta`)
    return c.json({
      adep, ades,
      routes: [{ route: `${adep} DCT ${ades}`, level: '', type: 'DCT', remarks: 'Rota direta sugerida; consulta AISWEB indisponível.', source: 'fallback' }],
      preferred_available: false,
      source: 'fallback',
      warning: e.message,
    })
  }
})

app.get('/api/solar/:icao', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const icao = c.req.param('icao').toUpperCase()
  const date = c.req.query('date')
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const cacheKey = `solar-${icao}-${date ?? today}`
    const data = await cachedFetch(c, cacheKey, 86400,
      () => fetchAisweb(c, 'sol', { icaoCode: icao, ...(date ? { date } : {}) }))
    const days = Array.isArray(data) ? data : (data?.sol ?? [data])
    return c.json({
      icao,
      solar: days.map((d: any) => ({
        date: d?.date ?? d?.data ?? '',
        sunrise: d?.nascer ?? d?.sunrise ?? '',
        sunset: d?.poente ?? d?.sunset ?? '',
        civil_twilight_begin: d?.crepusculo_manha ?? '',
        civil_twilight_end: d?.crepusculo_tarde ?? '',
      })),
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/flight-calculations', async (c) => {
  try {
    const body = await c.req.json()
    const { distance_nm, speed_kts = 120, fuel_burn = 32, reserve_min = 45, wind_kts = 0, taxi_min = 10 } = body
    if (!distance_nm || isNaN(Number(distance_nm))) return c.json({ error: 'distance_nm é obrigatório' }, 400)

    const dist = Number(distance_nm), gs = Math.max(Number(speed_kts) - Number(wind_kts), 1)
    const flightH = dist / gs, reserveH = Number(reserve_min) / 60, taxiH = Number(taxi_min) / 60

    const tripFuel = flightH * Number(fuel_burn)
    const reserveFuel = reserveH * Number(fuel_burn)
    const taxiFuel = taxiH * Number(fuel_burn)
    const totalFuel = tripFuel + reserveFuel + taxiFuel

    const totalMin = Math.round(flightH * 60)
    const hours = Math.floor(totalMin / 60), minutes = totalMin % 60

    return c.json({
      inputs: { distance_nm: dist, speed_kts, fuel_burn, reserve_min, wind_kts, taxi_min },
      results: {
        ground_speed_kts: Math.round(gs),
        flight_time: `${hours}h${String(minutes).padStart(2, '0')}m`,
        flight_minutes: totalMin,
        trip_fuel_liters: Math.round(tripFuel),
        reserve_fuel_liters: Math.round(reserveFuel),
        taxi_fuel_liters: Math.round(taxiFuel),
        total_fuel_liters: Math.round(totalFuel),
      },
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/nearest', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const lat = parseFloat(c.req.query('lat') ?? ''), lon = parseFloat(c.req.query('lon') ?? '')
  if (isNaN(lat) || isNaN(lon)) return c.json({ error: 'lat/lon inválidos' }, 400)
  try {
    const airports = (await fetchNearby(c, lat, lon)).sort((a, b) => a.distKm - b.distKm)
    return c.json({ nearest: airports[0] ?? null, alternates: airports.slice(0, 5) })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/geiloc/nearby', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const lat = parseFloat(c.req.query('lat') ?? ''), lon = parseFloat(c.req.query('lon') ?? '')
  if (isNaN(lat) || isNaN(lon)) return c.json({ error: 'lat/lon inválidos' }, 400)
  try {
    const airports = (await fetchNearby(c, lat, lon))
      .sort((a, b) => a.distKm - b.distKm)
      .filter(a => a.distKm < 200)
      .slice(0, 10)
    return c.json({ alternates: airports })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── /api/flightplan ─────────────────────────────────────────────────────────

app.get('/api/flightplan', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const adep = c.req.query('adep')?.toUpperCase()
  const ades = c.req.query('ades')?.toUpperCase()
  const speed = parseInt(c.req.query('speed') ?? '120')
  const burn = parseFloat(c.req.query('fuel_burn') ?? '32')
  const reserveMin = parseInt(c.req.query('reserve') ?? '45')

  if (!adep || !ades) return c.json({ error: 'adep e ades são obrigatórios' }, 400)

  try {
    const [depItem, desItem] = await Promise.all([
      fetchRotaerByIcao(c, adep),
      fetchRotaerByIcao(c, ades),
    ])

    const lat1 = parseCoord(depItem.latitude ?? depItem.lat)
    const lon1 = parseCoord(depItem.longitude ?? depItem.lng ?? depItem.lon)
    const lat2 = parseCoord(desItem.latitude ?? desItem.lat)
    const lon2 = parseCoord(desItem.longitude ?? desItem.lng ?? desItem.lon)
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null)
      return c.json({ error: 'Coordenadas inválidas' }, 500)

    const distanceNm = haversineKm(lat1, lon1, lat2, lon2) * 0.539957
    const flightHours = distanceNm / speed
    const reserveH = reserveMin / 60

    const hours = Math.floor(flightHours)
    const minutes = Math.round((flightHours - hours) * 60)

    const tripFuel = flightHours * burn
    const reserveFuel = reserveH * burn
    const taxiFuel = burn * (10 / 60)
    const totalFuel = tripFuel + reserveFuel + taxiFuel

    let routeStr = `${adep} DCT ${ades}`
    let routeSource: 'AISWEB/DECEA' | 'fallback' = 'fallback'
    try {
      // Reaproveita o cache e normaliza o envelope real da AISWEB.
      const routePref = await cachedFetch(c, `routes-${adep}-${ades}`, 3600, () => fetchAisweb(c, 'routesp', { adep, ades }))
      const preferredRoutes = normalizeRouteItems(routePref, adep, ades)
      if (preferredRoutes[0]?.route) {
        routeStr = preferredRoutes[0].route
        routeSource = 'AISWEB/DECEA'
      }
    } catch (error: any) {
      log.warn(`[flightplan] rota preferencial indisponível: ${error.message}`)
    }

    const [alternates, notamDep, notamDes] = await Promise.all([
      fetchNearby(c, lat2, lon2),
      cachedFetch(c, `notam-${adep}`, 600, () => fetchAisweb(c, 'notam', { icaoCode: adep })),
      cachedFetch(c, `notam-${ades}`, 600, () => fetchAisweb(c, 'notam', { icaoCode: ades })),
    ])

    const nearbyAlts = alternates
      .filter(a => a.icao !== ades && a.distKm < 150)
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 3)

    const notamAlerts = [...normalizeNotamItems(notamDep, adep), ...normalizeNotamItems(notamDes, ades)]
      .slice(0, 20)

    return c.json({
      flightplan: {
        adep,
        ades,
        route: routeStr,
        route_source: routeSource,
        distance_nm: Math.round(distanceNm),
        estimated_time: `${hours}h${String(minutes).padStart(2, '0')}m`,
        flight_minutes: Math.round(flightHours * 60),
        cruise_speed: speed,
      },
      fuel: {
        burn_lh: burn,
        trip_liters: Math.round(tripFuel),
        reserve_liters: Math.round(reserveFuel),
        taxi_liters: Math.round(taxiFuel),
        total_required: Math.round(totalFuel),
        reserve_min: reserveMin,
      },
      departure: {
        icao: adep,
        name: depItem?.nome ?? adep,
        lat: lat1,
        lon: lon1,
      },
      destination: {
        icao: ades,
        name: desItem?.nome ?? ades,
        lat: lat2,
        lon: lon2,
      },
      alternates: nearbyAlts.map(a => ({
        icao: a.icao,
        name: a.name,
        distance_km: a.distKm,
      })),
      notam_alerts: notamAlerts,
      notam_count: notamAlerts.length,
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── Routes: Upload de arquivos (R2 + short link) ────────────────────────────

app.post('/api/upload', async (c) => {
  if (!(await checkInternalAuth(c))) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    const folder = (formData.get('folder') as string) || 'geral'

    if (!file) return c.json({ error: 'Arquivo ausente' }, 400)

    const MAX_SIZE = 25 * 1024 * 1024 // 25MB
    if (file.size > MAX_SIZE) return c.json({ error: 'Arquivo excede 25MB' }, 413)

    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
    const key = `${folder}/${Date.now()}-${uuid().slice(0, 8)}.${ext}`

    await c.env.FILES.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    })

    const code = shortCode()
    await c.env.DB.prepare('INSERT INTO short_links (code, r2_key) VALUES (?, ?)')
      .bind(code, key)
      .run()

    const url = new URL(c.req.url)
    const publicUrl = `${url.protocol}//${url.host}/r/${code}`

    return c.json({ url: publicUrl, key, code })
  } catch (e: any) {
    log.error('[upload]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ─── Route: Servir arquivo via short link (público, sem auth) ───────────────

app.get('/r/:code', async (c) => {
  const code = c.req.param('code')
  try {
    const row = await c.env.DB.prepare('SELECT r2_key FROM short_links WHERE code = ?')
      .bind(code)
      .first<{ r2_key: string }>()

    if (!row) return c.notFound()

    const object = await c.env.FILES.get(row.r2_key)
    if (!object) return c.notFound()

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')

    return new Response(object.body, { headers })
  } catch (e: any) {
    log.error('[serve-file]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ─── Routes: Templates de email (D1) ─────────────────────────────────────────

app.get('/api/templates', async (c) => {
  const authOk = (await requireAuthenticatedUser(c)) || (await checkInternalAuth(c))
  if (!authOk) return c.json({ error: 'Não autorizado' }, 401)
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, tipo, assunto, corpo_html, created_at FROM email_templates ORDER BY tipo'
    ).all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/template/:tipo', async (c) => {
  const authOk = (await requireAuthenticatedUser(c)) || (await checkInternalAuth(c))
  if (!authOk) return c.json({ error: 'Não autorizado' }, 401)
  const tipo = c.req.param('tipo')
  try {
    const row = await c.env.DB.prepare(
      'SELECT id, tipo, assunto, corpo_html FROM email_templates WHERE tipo = ? LIMIT 1'
    ).bind(tipo).first()
    return c.json(row || null)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/templates', async (c) => {
  if (!(await checkInternalAuth(c))) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const { tipo, assunto, corpo_html } = await c.req.json()
    if (!tipo || !assunto || !corpo_html) return c.json({ error: 'Campos obrigatórios faltando' }, 400)

    const id = uuid()
    await c.env.DB.prepare(
      'INSERT INTO email_templates (id, tipo, assunto, corpo_html) VALUES (?, ?, ?, ?)'
    ).bind(id, tipo, assunto, corpo_html).run()

    return c.json({ id, tipo, assunto, corpo_html })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.put('/api/templates/:id', async (c) => {
  if (!(await checkInternalAuth(c))) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const { assunto, corpo_html } = await c.req.json()
    await c.env.DB.prepare(
      'UPDATE email_templates SET assunto = ?, corpo_html = ? WHERE id = ?'
    ).bind(assunto, corpo_html, id).run()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── Routes: Envio de email (Resend) + log em D1 ─────────────────────────────
// Suporta anexos: attachments?: { filename: string; r2_key: string }[]
// Fluxo esperado do frontend:
//   1. Upload do arquivo via POST /api/upload  → retorna { key, url, code }
//   2. Envio do email via POST /api/send-email → passa attachments: [{ filename, r2_key: key }]

app.post('/api/send-email', async (c) => {
  const viaSupabase = await requireAuthenticatedUser(c)
  const viaInternal = !viaSupabase && (await checkInternalAuth(c))
  if (!viaSupabase && !viaInternal) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const { to, cc, subject, html, tipo, reference_type, reference_id, attachments } = await c.req.json()
    if (!to || !subject || !html) return c.json({ error: 'Campos obrigatórios faltando (to, subject, html)' }, 400)

    // Só confiamos no sub do JWT quando ele foi validado de verdade contra o
    // Supabase (viaSupabase) — em chamadas servidor-a-servidor autenticadas
    // só pelo token interno, o JWT anexado não é verificado e não deve virar
    // valor de auditoria (ver nota em extractSupabaseUserId).
    const enviadoPor = viaSupabase ? extractSupabaseUserId(c) : null

    // ─── Monta anexos a partir do R2 ─────────────────────────────────────
    let resolvedAttachments: { filename: string; content: string }[] | undefined

    if (Array.isArray(attachments) && attachments.length > 0) {
      let totalSize = 0
      resolvedAttachments = []

      for (const att of attachments) {
        if (!att?.r2_key || !att?.filename) continue

        const object = await c.env.FILES.get(att.r2_key)
        if (!object) {
          log.warn(`[send-email] anexo não encontrado no R2: ${att.r2_key}`)
          continue
        }

        const buffer = await object.arrayBuffer()
        totalSize += buffer.byteLength
        if (totalSize > MAX_ATTACHMENT_TOTAL_SIZE) {
          return c.json({ error: 'Anexos excedem o limite total de 25MB' }, 413)
        }

        resolvedAttachments.push({
          filename: att.filename,
          content: arrayBufferToBase64(buffer),
        })
      }
    }

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: c.env.EMAIL_FROM,
        to: [to],
        cc: cc || undefined,
        subject,
        html,
        attachments: resolvedAttachments?.length ? resolvedAttachments : undefined,
      }),
    })

    const data = await resp.json()
    const status = resp.ok ? 'enviado' : 'erro'

    await c.env.DB.prepare(
      `INSERT INTO email_envios
         (id, tipo, reference_type, reference_id, destinatario, assunto, status, erro_mensagem, enviado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      uuid(),
      tipo || null,
      reference_type || null,
      reference_id || null,
      to,
      subject,
      status,
      resp.ok ? null : JSON.stringify(data),
      enviadoPor,
    ).run()

    if (!resp.ok) {
      log.error('[send-email] Resend error:', JSON.stringify(data))
      return c.json({ error: 'Falha ao enviar email', details: data }, 500)
    }

    return c.json(data)
  } catch (e: any) {
    log.error('[send-email]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/email-envios', async (c) => {
  if (!(await checkInternalAuth(c))) return c.json({ error: 'Unauthorized' }, 401)
  const referenceId = c.req.query('reference_id')
  try {
    const query = referenceId
      ? c.env.DB.prepare('SELECT * FROM email_envios WHERE reference_id = ? ORDER BY created_at DESC').bind(referenceId)
      : c.env.DB.prepare('SELECT * FROM email_envios ORDER BY created_at DESC LIMIT 100')
    const { results } = await query.all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── Routes: Mensageria Interna (Inbox / D1) ──────────────────────────────────

// 📩 1. Enviar nova mensagem
app.post('/api/mensagens', async (c) => {
  if (!(await requireAuthenticatedUser(c))) {
    return c.json({ error: 'Não autorizado' }, 401)
  }

  const remetenteId = extractSupabaseUserId(c)
  if (!remetenteId) return c.json({ error: 'Sessão inválida' }, 401)

  try {
    const body = await c.req.json<{
      destinatario_id: string
      assunto?: string
      conteudo: string
    }>()

    const { destinatario_id, assunto, conteudo } = body

    if (!destinatario_id || !conteudo?.trim()) {
      return c.json({ error: 'destinatario_id e conteudo são obrigatórios' }, 400)
    }

    const id = uuid()

    await c.env.DB.prepare(
      `INSERT INTO mensagens (id, remetente_id, destinatario_id, assunto, conteudo) 
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(id, remetenteId, destinatario_id, assunto?.trim() ?? null, conteudo.trim())
      .run()

    return c.json({ success: true, id, message: 'Mensagem enviada com sucesso' }, 201)
  } catch (e: any) {
    log.error('[mensagens:send]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// 📬 2. Listar Caixa de Entrada (Inbox)
app.get('/api/mensagens/inbox', async (c) => {
  if (!(await requireAuthenticatedUser(c))) {
    return c.json({ error: 'Não autorizado' }, 401)
  }

  const usuarioId = extractSupabaseUserId(c)
  if (!usuarioId) return c.json({ error: 'Sessão inválida' }, 401)

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, remetente_id, assunto, conteudo, lida, criado_em 
       FROM mensagens 
       WHERE destinatario_id = ? 
       ORDER BY criado_em DESC`
    )
      .bind(usuarioId)
      .all()

    return c.json(results)
  } catch (e: any) {
    log.error('[mensagens:inbox]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// 📤 3. Listar Caixa de Saída (Enviados)
app.get('/api/mensagens/outbox', async (c) => {
  if (!(await requireAuthenticatedUser(c))) {
    return c.json({ error: 'Não autorizado' }, 401)
  }

  const usuarioId = extractSupabaseUserId(c)
  if (!usuarioId) return c.json({ error: 'Sessão inválida' }, 401)

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, destinatario_id, assunto, conteudo, lida, criado_em 
       FROM mensagens 
       WHERE remetente_id = ? 
       ORDER BY criado_em DESC`
    )
      .bind(usuarioId)
      .all()

    return c.json(results)
  } catch (e: any) {
    log.error('[mensagens:outbox]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// 🔔 4. Obter contagem de mensagens NÃO LIDAS (para badges de notificação)
app.get('/api/mensagens/unread-count', async (c) => {
  if (!(await requireAuthenticatedUser(c))) {
    return c.json({ error: 'Não autorizado' }, 401)
  }

  const usuarioId = extractSupabaseUserId(c)
  if (!usuarioId) return c.json({ error: 'Sessão inválida' }, 401)

  try {
    const result = await c.env.DB.prepare(
      `SELECT COUNT(*) as unread FROM mensagens WHERE destinatario_id = ? AND lida = 0`
    )
      .bind(usuarioId)
      .first<{ unread: number }>()

    return c.json({ unread: result?.unread ?? 0 })
  } catch (e: any) {
    log.error('[mensagens:unread-count]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// 🔍 5. Obter uma mensagem específica e marcar como LIDA
app.get('/api/mensagens/:id', async (c) => {
  if (!(await requireAuthenticatedUser(c))) {
    return c.json({ error: 'Não autorizado' }, 401)
  }

  const usuarioId = extractSupabaseUserId(c)
  const id = c.req.param('id')

  try {
    const msg = await c.env.DB.prepare(
      `SELECT * FROM mensagens WHERE id = ? AND (destinatario_id = ? OR remetente_id = ?)`
    )
      .bind(id, usuarioId, usuarioId)
      .first<any>()

    if (!msg) return c.json({ error: 'Mensagem não encontrada' }, 404)

    // Se o usuário atual for o destinatário e a mensagem ainda não foi lida, marca como lida
    if (msg.destinatario_id === usuarioId && msg.lida === 0) {
      c.executionCtx.waitUntil(
        c.env.DB.prepare(`UPDATE mensagens SET lida = 1 WHERE id = ?`).bind(id).run()
      )
      msg.lida = 1
    }

    return c.json(msg)
  } catch (e: any) {
    log.error('[mensagens:get]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// 🗑️ 6. Deletar mensagem
app.delete('/api/mensagens/:id', async (c) => {
  if (!(await requireAuthenticatedUser(c))) {
    return c.json({ error: 'Não autorizado' }, 401)
  }

  const usuarioId = extractSupabaseUserId(c)
  const id = c.req.param('id')

  try {
    const res = await c.env.DB.prepare(
      `DELETE FROM mensagens WHERE id = ? AND (destinatario_id = ? OR remetente_id = ?)`
    )
      .bind(id, usuarioId, usuarioId)
      .run()

    if (res.meta.changes === 0) {
      return c.json({ error: 'Mensagem não encontrada ou sem permissão' }, 404)
    }

    return c.json({ success: true, message: 'Mensagem removida' })
  } catch (e: any) {
    log.error('[mensagens:delete]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ─── Route: Demonstrativo OCR (Claude) ────────────────────────────────────────
// Aceita usuário Supabase autenticado OU x-internal-token (chamadas servidor-a-servidor).
// Aceita imagem (jpeg/png/gif/webp) OU PDF em base64 — ver buildContentBlock.
// Devolve só os dados extraídos e normalizados, sem rateio — use
// /api/demonstrativo-rateio quando também precisar do cruzamento com o diário de bordo.

app.post('/api/demonstrativo-ocr', async (c) => {
  try {
    const authOk = (await requireAuthenticatedUser(c)) || (await checkInternalAuth(c))
    if (!authOk) return c.json({ error: 'Não autorizado' }, 401)

    const allowed = await checkRateLimit(c, 'demo-ocr', 10)
    if (!allowed) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)

    const body = await c.req.json<{ imageBase64?: string; mimeType?: string; tipo?: TipoDemo }>()
    const { imageBase64, mimeType, tipo } = body

    if (!imageBase64 || !mimeType) return c.json({ error: 'imageBase64 e mimeType são obrigatórios' }, 400)
    if (!tipo || !TIPOS_VALIDOS.includes(tipo)) {
      return c.json({ error: 'tipo inválido (use INFRAERO, DECEA ou POUSO)' }, 400)
    }

    const raw = await callClaudeExtraction(c, imageBase64, mimeType, tipo)
    const result = normalizeDemoResult(raw, tipo)

    return c.json(result)
  } catch (error: any) {
    log.error('[demonstrativo-ocr]', error?.message ?? error)
    return c.json({ error: error?.message ?? 'Falha ao processar o demonstrativo' }, 502)
  }
})

// ─── Route: Demonstrativo + Rateio (Claude + Supabase) ────────────────────────
// Une a extração via Claude com o cruzamento contra `lancamentos_diario_bordo`
// no Supabase (antes era um worker Groq separado). Pensada para demonstrativos
// DECEA, que trazem origem/destino por trecho — mas funciona para qualquer tipo;
// itens sem origem/destino/matrícula simplesmente caem em "Não Identificado / Traslado".

app.post('/api/demonstrativo-rateio', async (c) => {
  try {
    const authOk = (await requireAuthenticatedUser(c)) || (await checkInternalAuth(c))
    if (!authOk) return c.json({ error: 'Não autorizado' }, 401)

    const allowed = await checkRateLimit(c, 'demo-ocr', 10)
    if (!allowed) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)

    const body = await c.req.json<{ imageBase64?: string; mimeType?: string; tipo?: TipoDemo }>()
    const { imageBase64, mimeType } = body
    const tipo: TipoDemo = body.tipo ?? 'DECEA'

    if (!imageBase64 || !mimeType) return c.json({ error: 'imageBase64 e mimeType são obrigatórios' }, 400)
    if (!TIPOS_VALIDOS.includes(tipo)) {
      return c.json({ error: 'tipo inválido (use INFRAERO, DECEA ou POUSO)' }, 400)
    }

    const raw = await callClaudeExtraction(c, imageBase64, mimeType, tipo)
    const demonstrativo = normalizeDemoResult(raw, tipo)

    const { relatorio, totalPorCliente } = await montarRelatorioRateio(c, demonstrativo.itens)

    return c.json({
      ...demonstrativo,
      rateio_por_perna: relatorio,
      total_a_faturar_por_cliente: totalPorCliente,
    })
  } catch (error: any) {
    log.error('[demonstrativo-rateio]', error?.message ?? error)
    return c.json({ error: error?.message ?? 'Falha ao processar o rateio do demonstrativo' }, 502)
  }
})

app.post('/api/hotel-reservation', async (c) => {
  try {
    const allowed = await checkRateLimit(c, `hotel-reservation:${clientIp(c)}`, 5)
    if (!allowed) return c.json({ error: 'Limite de solicitações atingido, tente novamente em instantes' }, 429)

    const body = await c.req.json<ReservationRequest>()
    const required: Array<keyof ReservationRequest> = [
      'hotelId',
      'dataCheckin',
      'dataCheckout',
      'quantidadeHospedes',
      'hospedeNome',
      'hospedeTelefone',
    ]
    const missing = required.filter(key => {
      const value = body[key]
      return typeof value === 'string' ? !value.trim() : value == null
    })

    if (missing.length) {
      return c.json({ error: `Campos obrigatórios faltando: ${missing.join(', ')}` }, 400)
    }
    if (!Number.isInteger(body.quantidadeHospedes) || body.quantidadeHospedes < 1) {
      return c.json({ error: 'quantidadeHospedes deve ser um número inteiro maior que zero' }, 400)
    }
    if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_ROLE_KEY || !c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) {
      log.error('[hotel-reservation] configuração de integração ausente')
      return c.json({ error: 'Serviço de reservas indisponível' }, 503)
    }

    const hotelResponse = await fetch(
      `${c.env.SUPABASE_URL}/rest/v1/hoteis?id=eq.${encodeURIComponent(body.hotelId)}&select=id,nome,endereco,cidade,uf,email,email_reservas,telefone,telefone_reservas`,
      {
        headers: {
          apikey: c.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    )

    if (!hotelResponse.ok) {
      log.error('[hotel-reservation] falha ao buscar hotel:', hotelResponse.status)
      return c.json({ error: 'Falha ao consultar hotel' }, 502)
    }

    const hotels = await hotelResponse.json<HotelReservationHotel[]>()
    const hotel = hotels[0]
    if (!hotel) return c.json({ error: 'Hotel não encontrado' }, 404)

    const destinatario = hotel.email_reservas || hotel.email
    if (!destinatario) return c.json({ error: 'Hotel não possui email cadastrado para reservas' }, 422)

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: c.env.EMAIL_FROM,
        to: [destinatario],
        reply_to: body.hospedeEmail || undefined,
        subject: `Solicitação de reserva — ${body.hospedeNome} (${body.dataCheckin} a ${body.dataCheckout})`,
        html: `
          <style>.hotel-reservation-note { font-size: 12px; color: #666; }</style>
          <h2>Nova solicitação de reserva</h2>
          <p><strong>Hotel:</strong> ${escapeHtml(hotel.nome)}</p>
          <p><strong>Check-in:</strong> ${escapeHtml(body.dataCheckin)}</p>
          <p><strong>Check-out:</strong> ${escapeHtml(body.dataCheckout)}</p>
          ${body.tipoQuarto ? `<p><strong>Tipo de quarto:</strong> ${escapeHtml(body.tipoQuarto)}</p>` : ''}
          <p><strong>Hóspede:</strong> ${escapeHtml(body.hospedeNome)}</p>
          <p><strong>Telefone:</strong> ${escapeHtml(body.hospedeTelefone)}</p>
          ${body.hospedeEmail ? `<p><strong>Email:</strong> ${escapeHtml(body.hospedeEmail)}</p>` : ''}
          <p><strong>Nº de hóspedes:</strong> ${escapeHtml(body.quantidadeHospedes)}</p>
          ${body.observacoes ? `<p><strong>Observações:</strong> ${escapeHtml(body.observacoes)}</p>` : ''}
          <hr>
          <p class="hotel-reservation-note">Solicitação gerada automaticamente pelo sistema Share Brasil.</p>
        `,
      }),
    })

    if (!emailResponse.ok) {
      log.error('[hotel-reservation] falha ao enviar email:', emailResponse.status)
      return c.json({ error: 'Falha ao enviar solicitação por email' }, 500)
    }

    const reservationResponse = await fetch(`${c.env.SUPABASE_URL}/rest/v1/hotel_reservas`, {
      method: 'POST',
      headers: {
        apikey: c.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        user_id: body.userId ?? null,
        hotel_id: hotel.id,
        nome_hotel: hotel.nome,
        endereco_hotel: hotel.endereco,
        cidade: hotel.cidade,
        data_checkin: body.dataCheckin,
        data_checkout: body.dataCheckout,
        tipo_quarto: body.tipoQuarto ?? null,
        quantidade_hospedes: body.quantidadeHospedes,
        hospede_nome: body.hospedeNome,
        hospede_telefone: body.hospedeTelefone,
        hospede_email: body.hospedeEmail ?? null,
        observacoes: body.observacoes ?? null,
        status_reserva: 'solicitada',
      }),
    })

    if (!reservationResponse.ok) {
      const detail = await reservationResponse.text()
      log.error('[hotel-reservation] falha ao registrar reserva:', detail)
      return c.json({ success: true, warning: 'Email enviado, mas falha ao salvar registro' })
    }

    const reservas = await reservationResponse.json<unknown[]>()
    return c.json({ success: true, reserva: reservas[0] ?? null })
  } catch (error: any) {
    log.error('[hotel-reservation]', error?.message ?? error)
    return c.json({ error: 'Falha ao processar solicitação de reserva' }, 500)
  }
})

// ─── Portal Cliente e fluxo de reservas Share Brasil ─────────────────────────

type PortalUser = {
  id: string
  login: string
  nome_exibicao: string | null
  url_avatar: string | null
  cliente_id: string | null
  socio_id: string | null
}

type PortalCliente = {
  id: string
  razao_social: string | null
  cnpj: string | null
  inscricao_estadual: string | null
  proprietario: string | null
  endereco: string | null
  cidade: string | null
  uf: string | null
  contato_financeiro: string | null
  telefone_financeiro: string | null
  telefone_cliente: string | null
  telefone_outro: string | null
  email_principal: string | null
  emails: string
  url_logo: string | null
  status: string | null
  holding: number
  codigo_cliente: string | null
  observacoes: string | null
}

type PortalSocio = {
  id: string
  cliente_id: string
  nome: string
  cpf: string
  email_principal: string | null
  emails: string
  endereco: string | null
  cidade: string | null
  uf: string | null
  contato_financeiro: string | null
  telefone_financeiro: string | null
  telefone: string | null
  observacoes: string | null
}

type PortalParticipacao = {
  id: string
  cliente_id: string | null
  socio_id: string | null
  aeronave_id: string
  percentual_sociedade: number
  modelo_aeronave: string | null
  matricula_registro: string | null
  fabricante: string | null
  modelo: string | null
  numero_serie: string | null
  nome_proprietario: string | null
  status: string | null
  ano: string | null
  base: string | null
  preco_hora: string | null
  url_imagem: string | null
  velocidade_cruzeiro: string | null
  tipo_aeronave: string | null
}

type PortalSession = PortalUser & { exp: number }
const portalEncoder = new TextEncoder()
const portalDecoder = new TextDecoder()
const PORTAL_SESSION_TTL = 8 * 60 * 60
// O workerd em produção limita PBKDF2 a 100.000 iterações.
const PORTAL_PBKDF2_ITERATIONS = 100_000

function portalDb(c: Context<{ Bindings: Bindings }>): D1Database {
  return c.env.SHARE_DB ?? c.env.DB
}

function portalBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function portalFromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)
  const binary = atob(normalized)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

async function portalHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', portalEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

async function portalHashPassword(password: string, salt: Uint8Array, iterations = PORTAL_PBKDF2_ITERATIONS): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', portalEncoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)
  return new Uint8Array(bits)
}

function portalEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let result = 0
  for (let index = 0; index < left.length; index += 1) result |= left[index] ^ right[index]
  return result === 0
}

async function portalVerifyPassword(password: string, stored: string): Promise<{ valid: boolean; legacy: boolean }> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    const valid = portalEqual(portalEncoder.encode(stored), portalEncoder.encode(password))
    return { valid, legacy: valid }
  }
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) return { valid: false, legacy: false }
  try {
    const hash = await portalHashPassword(password, portalFromBase64Url(parts[2]), iterations)
    return { valid: portalEqual(hash, portalFromBase64Url(parts[3])), legacy: false }
  } catch {
    return { valid: false, legacy: false }
  }
}

async function portalCreatePasswordHash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2_sha256$${PORTAL_PBKDF2_ITERATIONS}$${portalBase64Url(salt)}$${portalBase64Url(await portalHashPassword(password, salt))}`
}

function portalSessionSecret(c: Context<{ Bindings: Bindings }>): string {
  const secret = c.env.CLIENT_SESSION_SECRET || c.env.INTERNAL_TOKEN
  if (!secret) throw new Error('Segredo de sessão não configurado')
  return secret
}

async function portalCreateSession(user: PortalUser, c: Context<{ Bindings: Bindings }>): Promise<{ token: string; expires_at: string }> {
  const exp = Math.floor(Date.now() / 1000) + Number(c.env.CLIENT_SESSION_TTL_SECONDS || PORTAL_SESSION_TTL)
  const encoded = portalBase64Url(portalEncoder.encode(JSON.stringify({ ...user, exp })))
  const signature = portalBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await portalHmacKey(portalSessionSecret(c)), portalEncoder.encode(encoded))))
  return { token: `${encoded}.${signature}`, expires_at: new Date(exp * 1000).toISOString() }
}

async function portalSession(c: Context<{ Bindings: Bindings }>): Promise<PortalUser | null> {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  const [encoded, signature] = authorization.slice(7).trim().split('.')
  if (!encoded || !signature) return null
  try {
    const valid = await crypto.subtle.verify('HMAC', await portalHmacKey(portalSessionSecret(c)), portalFromBase64Url(signature), portalEncoder.encode(encoded))
    const session = JSON.parse(portalDecoder.decode(portalFromBase64Url(encoded))) as PortalSession
    if (!valid || !session.id || !session.login || session.exp <= Math.floor(Date.now() / 1000)) return null
    return { id: session.id, login: session.login, nome_exibicao: session.nome_exibicao, url_avatar: session.url_avatar, cliente_id: session.cliente_id, socio_id: session.socio_id }
  } catch {
    return null
  }
}

async function portalClientId(c: Context<{ Bindings: Bindings }>, user: PortalUser): Promise<string |null> {
  if (user.cliente_id) return user.cliente_id
  if (!user.socio_id) return null
  const row = await portalDb(c).prepare('SELECT cliente_id FROM hold_socios WHERE id = ?1').bind(user.socio_id).first<{ cliente_id: string | null }>()
  return row?.cliente_id || null
}

async function portalContext(c: Context<{ Bindings: Bindings }>, user: PortalUser) {
  const db = portalDb(c)
  const clienteId = await portalClientId(c, user)
  const [cliente, socio, participacoes] = await Promise.all([
    clienteId
      ? db.prepare('SELECT id, razao_social, cnpj, inscricao_estadual, proprietario, endereco, cidade, uf, contato_financeiro, telefone_financeiro, telefone_cliente, telefone_outro, email_principal, emails, url_logo, status, holding, codigo_cliente, observacoes FROM cliente WHERE id = ?1').bind(clienteId).first<PortalCliente>()
      : Promise.resolve(null),
    user.socio_id
      ? db.prepare('SELECT id, cliente_id, nome, cpf, email_principal, emails, endereco, cidade, uf, contato_financeiro, telefone_financeiro, telefone, observacoes FROM hold_socios WHERE id = ?1').bind(user.socio_id).first<PortalSocio>()
      : Promise.resolve(null),
    db.prepare('SELECT ca.id, ca.cliente_id, ca.socio_id, ca.aeronave_id, ca.percentual_sociedade, ca.modelo_aeronave, a.matricula_registro, a.fabricante, a.modelo, a.numero_serie, a.nome_proprietario, a.status, a.ano, a.base, a.preco_hora, a.url_imagem, a.velocidade_cruzeiro, a.tipo_aeronave FROM cotista_aeronave ca LEFT JOIN aeronave a ON a.id = ca.aeronave_id WHERE ca.cliente_id = ?1 OR ca.socio_id = ?2 ORDER BY ca.criado_em DESC').bind(user.cliente_id, user.socio_id).all<PortalParticipacao>(),
  ])

  return { user, cliente: cliente ?? null, socio: socio ?? null, participacoes: participacoes.results }
}

async function portalTelegram(c: Context<{ Bindings: Bindings }>, message: string): Promise<void> {
  if (!c.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN não configurado')
  const company = await portalDb(c).prepare('SELECT telegram_chat_id FROM empresa ORDER BY criado_em LIMIT 1').first<{ telegram_chat_id: string | null }>()
  const chatId = company?.telegram_chat_id?.trim()
  if (!chatId) throw new Error('telegram_chat_id não configurado')
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(c.env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  })
  const result = await response.json().catch(() => ({})) as { ok?: boolean; error_code?: number; description?: string }
  if (!response.ok || !result.ok) {
    const detail = [result.error_code, result.description].filter(Boolean).join(' - ') || 'resposta inválida'
    throw new Error(`Telegram HTTP ${response.status}: ${detail}`)
  }
}

function portalTelegramText(row: Record<string, unknown>, fallbackName: string): string {
  const value = (key: string, fallback = '—') => String(row[key] ?? fallback).replace(/[&<>\"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[char] || char))
  const aircraft = [row.matricula_registro, row.fabricante, row.modelo].filter(Boolean).join(' · ') || '—'
  return `<b>Nova solicitação de reserva de voo</b>\nCliente: <b>${value('cliente_razao_social', fallbackName)}</b>\nAeronave: ${value('aeronave_label', aircraft)}\nOrigem → destino: ${value('origem')} → ${value('destino')}\nData: ${value('data_agendada')} · Horário: ${value('horario_previsto_agendamento')}\nDuração: ${value('dias_duracao')} dia(s) · Passageiros: ${value('numero_passageiros')}\nVoo de empréstimo: ${value('voo_emprestado')}\nObservações: ${value('observacoes')}\nID: <code>${value('id')}</code>\nAcesse o Sistema Interno Share Brasil para aprovar ou reprovar.`
}

function diasDoPeriodo(dataInicio: string, dataFim: string): number {
  const inicio = new Date(`${dataInicio}T00:00:00Z`)
  const fim = new Date(`${dataFim}T00:00:00Z`)
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime()) || fim < inicio) return 0
  return Math.floor((fim.getTime() - inicio.getTime()) / 86_400_000) + 1
}

app.get('/api/colaborador/perfil', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const db = portalDb(c)
  const [pagamentos, documentos, funcoes, ferias] = await Promise.all([
    db.prepare("SELECT id, descricao, NULL AS competencia, data_pagamento, COALESCE(valor_pago_real, valor_rateado, valor_total, 0) AS valor, status, observacoes FROM movimentacoes WHERE colaborador_id = ?1 AND (lower(status) = 'pago' OR data_pagamento IS NOT NULL) ORDER BY COALESCE(data_pagamento, criado_em) DESC, criado_em DESC").bind(colaborador.id).all(),
    db.prepare('SELECT id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, criado_em, categoria FROM documentos_usuarios WHERE user_id = ?1 ORDER BY criado_em DESC').bind(colaborador.id).all(),
    db.prepare('SELECT id, funcao, criado_em FROM usuarios_funcoes WHERE user_id = ?1 ORDER BY funcao').bind(colaborador.id).all(),
    db.prepare('SELECT id, data_inicio, data_fim, quantidade_dias, status, observacoes, motivo_reprovacao, aprovado_em, criado_em, atualizado_em FROM solicitacoes_ferias WHERE colaborador_id = ?1 ORDER BY data_inicio DESC, criado_em DESC').bind(colaborador.id).all(),
  ])
  const diasUtilizados = (ferias.results as Array<{ quantidade_dias: number; status: string }>)
    .filter(item => item.status === 'aprovada')
    .reduce((total, item) => total + item.quantidade_dias, 0)
  return c.json({
    perfil: { ...colaborador, foto_url: colaborador.url_avatar ? '/api/colaborador/foto' : null, dias_ferias_direito: 30 },
    pagamentos: pagamentos.results,
    documentos: documentos.results.map(row => documentoColaborador(row as Record<string, unknown>)),
    funcoes: funcoes.results,
    ferias: ferias.results,
    resumo_ferias: { dias_direito: 30, dias_utilizados: diasUtilizados, dias_disponiveis: Math.max(0, 30 - diasUtilizados) },
  })
})

app.patch('/api/colaborador/perfil', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'corpo_invalido' }, 400)
  const fields = ['nome_completo', 'cpf', 'telefone'] as const
  const updates = fields.filter(field => body[field] !== undefined).map(field => ({ field, value: body[field] === null ? null : String(body[field]).trim() }))
  if (updates.length === 0) return c.json({ perfil: colaborador })
  const assignments = updates.map(({ field }) => `${field} = ?`).join(', ')
  await portalDb(c).prepare(`UPDATE user_profiles SET ${assignments}, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?`).bind(...updates.map(({ value }) => value), colaborador.id).run()
  const updated = await portalDb(c).prepare('SELECT * FROM user_profiles WHERE id = ?1').bind(colaborador.id).first<Colaborador>()
  return c.json({ perfil: { ...updated, foto_url: updated?.url_avatar ? '/api/colaborador/foto' : null, dias_ferias_direito: 30 } })
})

app.get('/api/colaborador/foto', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador?.url_avatar) return c.notFound()
  const object = await bucketParaChaveColaborador(c, colaborador.url_avatar).get(colaborador.url_avatar)
  if (!object) return c.notFound()
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Cache-Control', 'private, max-age=300')
  return new Response(object.body, { headers })
})

app.post('/api/colaborador/foto', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const formData = await c.req.formData()
  const fileValue = formData.get('foto') as unknown
  if (!fileValue || typeof fileValue !== 'object' || !('type' in fileValue) || typeof fileValue.type !== 'string' || !fileValue.type.startsWith('image/')) return c.json({ error: 'foto_invalida' }, 400)
  const file = fileValue as File
  try {
    const key = await salvarArquivoColaborador(c, colaborador.id, file, 'avatar_profiles')
    await portalDb(c).prepare('UPDATE user_profiles SET url_avatar = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?').bind(key, colaborador.id).run()
    return c.json({ foto_url: '/api/colaborador/foto' })
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_foto' }, 400)
  }
})

app.get('/api/colaborador/documentos', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare('SELECT id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, criado_em, categoria FROM documentos_usuarios WHERE user_id = ?1 ORDER BY criado_em DESC').bind(colaborador.id).all()
  return c.json(result.results.map(row => documentoColaborador(row as Record<string, unknown>)))
})

app.post('/api/colaborador/documentos', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const formData = await c.req.formData()
  const fileValue = formData.get('arquivo') as unknown
  const categoria = String(formData.get('tipo_documento') || '').trim()
  if (!fileValue || typeof fileValue !== 'object' || !('type' in fileValue) || !categoria) return c.json({ error: 'tipo_e_arquivo_obrigatorios' }, 400)
  const file = fileValue as File
  if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return c.json({ error: 'tipo_de_arquivo_nao_permitido' }, 415)
  try {
    const key = await salvarArquivoColaborador(c, colaborador.id, file, 'documentos_colaboradores')
    const id = uuid()
    await portalDb(c).prepare('INSERT INTO documentos_usuarios (id, user_id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, categoria) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, colaborador.id, file.name, key, file.type, file.size, colaborador.id, categoria).run()
    return c.json({ id, tipo_documento: categoria, nome_arquivo: file.name, status: 'em_analise', arquivo_url: `/api/colaborador/documentos/${id}/arquivo` }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_documento' }, 400)
  }
})

app.get('/api/colaborador/documentos/:id/arquivo', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const documento = await portalDb(c).prepare('SELECT caminho_arquivo, tipo_arquivo, nome_arquivo FROM documentos_usuarios WHERE id = ?1 AND user_id = ?2').bind(c.req.param('id'), colaborador.id).first<{ caminho_arquivo: string; tipo_arquivo: string; nome_arquivo: string }>()
  if (!documento) return c.notFound()
  const object = await bucketParaChaveColaborador(c, documento.caminho_arquivo).get(documento.caminho_arquivo)
  if (!object) return c.notFound()
  const headers = new Headers({ 'Content-Type': documento.tipo_arquivo, 'Content-Disposition': `attachment; filename="${documento.nome_arquivo.replace(/[^a-zA-Z0-9._-]/g, '_')}"` })
  return new Response(object.body, { headers })
})

app.get('/api/colaborador/ferias', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare('SELECT id, data_inicio, data_fim, quantidade_dias, status, observacoes, motivo_reprovacao, aprovado_em, criado_em, atualizado_em FROM solicitacoes_ferias WHERE colaborador_id = ?1 ORDER BY data_inicio DESC, criado_em DESC').bind(colaborador.id).all()
  return c.json(result.results)
})

app.post('/api/colaborador/ferias', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ data_inicio?: string; data_fim?: string; observacoes?: string }>().catch(() => null)
  const dataInicio = body?.data_inicio?.trim() || ''
  const dataFim = body?.data_fim?.trim() || ''
  const quantidadeDias = diasDoPeriodo(dataInicio, dataFim)
  if (!quantidadeDias || quantidadeDias > 30) return c.json({ error: 'periodo_de_ferias_invalido' }, 400)
  const saldo = await portalDb(c).prepare("SELECT COALESCE(SUM(quantidade_dias), 0) AS total FROM solicitacoes_ferias WHERE colaborador_id = ?1 AND status IN ('solicitada', 'aprovada')").bind(colaborador.id).first<{ total: number }>()
  if (Number(saldo?.total || 0) + quantidadeDias > 30) return c.json({ error: 'saldo_de_ferias_insuficiente' }, 409)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO solicitacoes_ferias (id, colaborador_id, data_inicio, data_fim, quantidade_dias, observacoes) VALUES (?, ?, ?, ?, ?, ?)').bind(id, colaborador.id, dataInicio, dataFim, quantidadeDias, body?.observacoes?.trim() || null).run()
  return c.json({ id, data_inicio: dataInicio, data_fim: dataFim, quantidade_dias: quantidadeDias, status: 'solicitada' }, 201)
})

app.post('/api/portal/login', async c => {
  try {
    if (!(await checkRateLimit(c, `portal-login:${clientIp(c)}`, 12))) return c.json({ error: 'muitas_tentativas' }, 429)
    const body = await c.req.json<{ login?: string; senha?: string }>().catch(() => null)
    const login = body?.login?.trim().toLowerCase()
    const senha = body?.senha || ''
    if (!login || !senha) return c.json({ error: 'login_e_senha_obrigatorios' }, 400)

    const row = await portalDb(c).prepare('SELECT id, login, senha, nome_exibicao, url_avatar, cliente_id, socio_id FROM user_cliente WHERE lower(login) = ?1 LIMIT 1').bind(login).first<PortalUser & { senha: string }>()
    const verification = row ? await portalVerifyPassword(senha, row.senha) : null
    if (!row || !verification?.valid) return c.json({ error: 'credenciais_invalidas' }, 401)
    if (Boolean(row.cliente_id) === Boolean(row.socio_id)) return c.json({ error: 'vinculo_usuario_invalido' }, 409)
    if (verification.legacy) await portalDb(c).prepare('UPDATE user_cliente SET senha = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(await portalCreatePasswordHash(senha), row.id).run()

    const user: PortalUser = { id: row.id, login: row.login, nome_exibicao: row.nome_exibicao, url_avatar: row.url_avatar, cliente_id: row.cliente_id, socio_id: row.socio_id }
    return c.json({ user, ...(await portalCreateSession(user, c)) })
  } catch (error: any) {
    log.error('[portal/login]', error?.message ?? error)
    return c.json({ error: 'portal_login_indisponivel' }, 500)
  }
})

app.use('/api/portal/*', async (c, next) => {
  if (c.req.path === '/api/portal/login') return next()
  if (!(await portalSession(c))) return c.json({ error: 'client_auth_required' }, 401)
  return next()
})

app.get('/api/portal/me', async c => c.json({ user: await portalSession(c) }))

app.get('/api/portal/contexto', async c => {
  const user = await portalSession(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  return c.json(await portalContext(c, user))
})

app.get('/api/portal/aerodromos', async c => {
  const query = (c.req.query('q') || '').trim().toLowerCase()
  const pattern = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
  const result = await portalDb(c).prepare("SELECT id, nome, designativo_icao FROM aerodromo WHERE lower(nome) LIKE ?1 ESCAPE '\\' OR lower(designativo_icao) LIKE ?1 ESCAPE '\\' ORDER BY designativo_icao LIMIT 50").bind(pattern).all<{ id: string; nome: string; designativo_icao: string }>()
  return c.json({ aerodromos: result.results })
})

app.get('/api/portal/disponibilidade', async c => {
  const from = c.req.query('de') || new Date().toISOString().slice(0, 10)
  const to = c.req.query('ate') || from
  const [aircraft, reservations] = await Promise.all([
    portalDb(c).prepare("SELECT id, matricula_registro, fabricante, modelo, tipo_aeronave, status FROM aeronave WHERE lower(status) = 'ativa' ORDER BY matricula_registro").all(),
    portalDb(c).prepare("SELECT aeronave_id, data_agendada, dias_duracao, status FROM solicitacoes_reserva_voo WHERE data_agendada BETWEEN ?1 AND ?2 AND status IN ('pendente', 'aprovada') ORDER BY data_agendada").bind(from, to).all(),
  ])
  return c.json({ from, to, aeronaves: aircraft.results, reservas: reservations.results })
})

app.get('/api/portal/solicitacoes', async c => {
  const user = await portalSession(c)
  const clientId = user ? await portalClientId(c, user) : null
  if (!clientId) return c.json([])
  const result = await portalDb(c).prepare("SELECT s.id, s.aeronave_id, s.origem, s.destino, s.data_agendada, s.horario_previsto_agendamento, s.dias_duracao, s.numero_passageiros, s.voo_emprestado, s.status, s.motivo_rejeicao, s.numero_voo, s.criado_em, a.matricula_registro, a.modelo FROM solicitacoes_reserva_voo s LEFT JOIN aeronave a ON a.id = s.aeronave_id WHERE s.cliente_id = ?1 ORDER BY s.criado_em DESC").bind(clientId).all()
  return c.json(result.results)
})

app.post('/api/portal/solicitacoes', async c => {
  const user = await portalSession(c)
  const clientId = user ? await portalClientId(c, user) : null
  if (!clientId) return c.json({ error: 'cliente_nao_vinculado' }, 409)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || !body.aeronave_id || !body.origem || !body.destino || !body.data_agendada) return c.json({ error: 'campos_obrigatorios_ausentes' }, 400)
  const aircraft = await portalDb(c).prepare("SELECT id, status FROM aeronave WHERE id = ?1").bind(String(body.aeronave_id)).first<{ id: string; status: string }>()
  if (!aircraft || aircraft.status.toLowerCase() !== 'ativa') return c.json({ error: 'aeronave_indisponivel' }, 409)
  const id = crypto.randomUUID()
  await portalDb(c).prepare("INSERT INTO solicitacoes_reserva_voo (id, cliente_id, aeronave_id, voo_emprestado, origem, destino, data_agendada, horario_previsto_agendamento, dias_duracao, numero_passageiros, status, observacoes, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").bind(id, clientId, String(body.aeronave_id), String(body.voo_emprestado || 'nao'), String(body.origem), String(body.destino), String(body.data_agendada), body.horario_previsto_agendamento ? String(body.horario_previsto_agendamento) : null, Number(body.dias_duracao) || 1, Number(body.numero_passageiros) || 1, body.observacoes ? String(body.observacoes) : null).run()
  const row = await portalDb(c).prepare("SELECT s.*, c.razao_social AS cliente_razao_social, a.matricula_registro, a.fabricante, a.modelo FROM solicitacoes_reserva_voo s LEFT JOIN cliente c ON c.id = s.cliente_id LEFT JOIN aeronave a ON a.id = s.aeronave_id WHERE s.id = ?1").bind(id).first<Record<string, unknown>>()
  let notificationSent = true
  try {
    await portalTelegram(c, portalTelegramText(row || { ...body, id }, user?.nome_exibicao || 'Cliente'))
  } catch (error) {
    notificationSent = false
    log.error('[portal] telegram notification failed after saving request', error)
  }
  return c.json({ success: true, solicitacao_id: id, notification_sent: notificationSent, message: 'Solicitação enviada com sucesso. Aguarde a confirmação da coordenação.' }, 201)
})

/**
 * Autoriza somente o sistema interno.
 *
 * O Portal do Cliente usa `portalSession`, baseada na tabela D1 `user_cliente`,
 * e nunca deve ser aceito nas rotas `/api/interno/*`. Aqui só entram tokens
 * Supabase de colaboradores ou o token técnico entre serviços.
 */
async function requireShareInternal(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  const colaboradorSupabaseAutenticado = await requireAuthenticatedUser(c)
  if (colaboradorSupabaseAutenticado) return true
  return checkInternalAuth(c)
}

app.get('/api/interno/dashboard/operacoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const dataReferencia = c.req.query('data') || new Date().toISOString().slice(0, 10)
  const [resumo, solicitacoes] = await Promise.all([
    portalDb(c).prepare(`SELECT
      SUM(CASE WHEN date(data_agendada) = ?1 THEN 1 ELSE 0 END) AS voos_hoje,
      SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END) AS pendencias,
      COUNT(*) AS reservas_abertas
      FROM solicitacoes_reserva_voo
      WHERE date(data_agendada) >= ?1 AND status IN ('pendente', 'aprovada')`).bind(dataReferencia).first<Record<string, number>>(),
    portalDb(c).prepare(`SELECT s.id, s.cliente_id, s.aeronave_id, s.origem, s.destino, s.data_agendada, s.horario_previsto_agendamento, s.dias_duracao, s.numero_passageiros, s.voo_emprestado, s.status, s.motivo_rejeicao, s.numero_voo, s.criado_em, s.atualizado_em, c.razao_social AS cliente_razao_social, c.codigo_cliente, a.matricula_registro, a.modelo
      FROM solicitacoes_reserva_voo s
      LEFT JOIN cliente c ON c.id = s.cliente_id
      LEFT JOIN aeronave a ON a.id = s.aeronave_id
      WHERE date(s.data_agendada) >= ?1
      ORDER BY date(s.data_agendada), s.horario_previsto_agendamento, s.criado_em
      LIMIT 50`).bind(dataReferencia).all(),
  ])
  const aeronavesAtivas = await portalDb(c).prepare("SELECT COUNT(*) AS total FROM aeronave WHERE lower(status) = 'ativa'").first<{ total: number }>()
  return c.json({ data_referencia: dataReferencia, resumo: { voos_hoje: Number(resumo?.voos_hoje || 0), pendencias: Number(resumo?.pendencias || 0), reservas_abertas: Number(resumo?.reservas_abertas || 0), aeronaves_ativas: Number(aeronavesAtivas?.total || 0) }, solicitacoes: solicitacoes.results })
})

app.get('/api/interno/dashboard/financeiro', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const [resumo, movimentacoes] = await Promise.all([
    portalDb(c).prepare(`SELECT
      COALESCE(SUM(CASE WHEN lower(COALESCE(status, '')) NOT IN ('pago', 'cancelado') THEN COALESCE(valor_rateado, valor_total, 0) ELSE 0 END), 0) AS total_a_receber,
      COALESCE(SUM(CASE WHEN lower(COALESCE(status, '')) = 'pago' OR data_pagamento IS NOT NULL THEN COALESCE(valor_pago_real, valor_rateado, valor_total, 0) ELSE 0 END), 0) AS total_pago,
      SUM(CASE WHEN lower(COALESCE(status, '')) NOT IN ('pago', 'cancelado') THEN 1 ELSE 0 END) AS pendencias,
      SUM(CASE WHEN lower(COALESCE(status, '')) = 'pago' OR data_pagamento IS NOT NULL THEN 1 ELSE 0 END) AS pagamentos_confirmados
      FROM movimentacoes`).first<Record<string, number>>(),
    portalDb(c).prepare(`SELECT id, descricao, status, data_pagamento, COALESCE(valor_pago_real, valor_rateado, valor_total, 0) AS valor, observacoes, criado_em
      FROM movimentacoes
      ORDER BY COALESCE(data_pagamento, criado_em) DESC, criado_em DESC
      LIMIT 20`).all(),
  ])
  return c.json({ resumo: { total_a_receber: Number(resumo?.total_a_receber || 0), total_pago: Number(resumo?.total_pago || 0), pendencias: Number(resumo?.pendencias || 0), pagamentos_confirmados: Number(resumo?.pagamentos_confirmados || 0) }, movimentacoes: movimentacoes.results })
})

type TripulanteDisponivel = {
  id: string
  nome_completo: string
  canac: string
  status: string | null
  tipo_licenca: string | null
  origem: 'tripulacao' | 'freelancer'
}

async function buscarTripulante(c: Context<{ Bindings: Bindings }>, id: string): Promise<TripulanteDisponivel | null> {
  const tripulante = await portalDb(c).prepare('SELECT id, nome_completo, canac, status, tipo_licenca FROM tripulacao WHERE id = ?1').bind(id).first<Omit<TripulanteDisponivel, 'origem'>>()
  if (tripulante) return { ...tripulante, origem: 'tripulacao' }
  const freelancer = await portalDb(c).prepare('SELECT id, nome_completo, canac, status, NULL AS tipo_licenca FROM tripulacao_freelancer WHERE id = ?1').bind(id).first<Omit<TripulanteDisponivel, 'origem'>>()
  return freelancer ? { ...freelancer, origem: 'freelancer' } : null
}

async function garantirTabelaDisponibilidadeTripulacao(c: Context<{ Bindings: Bindings }>) {
  await portalDb(c).prepare(`ALTER TABLE solicitacoes_reserva_voo ADD COLUMN socio_id TEXT NULL`).run().catch(() => undefined)
  await portalDb(c).prepare(`CREATE TABLE IF NOT EXISTS escala_tripulacao (
    id TEXT PRIMARY KEY NOT NULL,
    tripulacao_id TEXT NOT NULL,
    aeronave_id TEXT NULL,
    solicitacao_id TEXT NULL,
    funcao TEXT NOT NULL DEFAULT 'PIC',
    data_inicio TEXT NOT NULL,
    data_fim TEXT NOT NULL,
    status TEXT NULL,
    observacoes TEXT NULL,
    criado_por TEXT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run()
}

async function garantirTabelaPlanosVoo(c: Context<{ Bindings: Bindings }>) {
  await portalDb(c).prepare(`CREATE TABLE IF NOT EXISTS planos_voo (
    id TEXT PRIMARY KEY NOT NULL,
    numero_voo TEXT NULL,
    adep TEXT NOT NULL,
    ades TEXT NOT NULL,
    data_voo TEXT NULL,
    eobt TEXT NULL,
    payload_json TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run()
}

app.get('/api/interno/planos-voo', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaPlanosVoo(c)
  const rows = await portalDb(c).prepare(`SELECT id, numero_voo, adep, ades, data_voo, eobt, payload_json, criado_em AS created_at FROM planos_voo ORDER BY criado_em DESC LIMIT 50`).all<any>()
  return c.json(rows.results.map(row => ({ ...row, payload: JSON.parse(row.payload_json) })))
})

app.post('/api/interno/planos-voo', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => null)
  const flightplan = body?.flightplan
  const adep = String(body?.adep ?? flightplan?.adep ?? '').trim().toUpperCase()
  const ades = String(body?.ades ?? flightplan?.ades ?? '').trim().toUpperCase()
  if (!/^[A-Z]{4}$/.test(adep) || !/^[A-Z]{4}$/.test(ades)) return c.json({ error: 'adep_ades_obrigatorios' }, 400)
  await garantirTabelaPlanosVoo(c)
  const id = uuid()
  const numeroVoo = body?.numero_voo ? String(body.numero_voo).trim() : null
  const dataVoo = body?.data_voo ? String(body.data_voo).trim() : null
  const eobt = body?.eobt ? String(body.eobt).trim() : null
  await portalDb(c).prepare(`INSERT INTO planos_voo (id, numero_voo, adep, ades, data_voo, eobt, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, numeroVoo, adep, ades, dataVoo, eobt, JSON.stringify(body)).run()
  return c.json({ id, created_at: new Date().toISOString() }, 201)
})

app.get('/api/interno/agendamento/opcoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const db = portalDb(c)
  const [clientes, socios, aeronaves, vinculos] = await Promise.all([
    db.prepare("SELECT id, razao_social AS nome, codigo_cliente FROM cliente WHERE lower(COALESCE(status, 'ativo')) NOT IN ('inativo', 'cancelado') ORDER BY razao_social").all(),
    db.prepare("SELECT id, nome, cliente_id FROM hold_socios ORDER BY nome").all(),
    db.prepare("SELECT id, matricula_registro, fabricante, modelo, status, ano, base, url_imagem, tipo_aeronave FROM aeronave WHERE lower(status) = 'ativa' ORDER BY matricula_registro").all(),
    db.prepare(`SELECT ca.id, ca.cliente_id, ca.socio_id, ca.aeronave_id, ca.codigo_cliente, a.matricula_registro, a.modelo
      FROM cotista_aeronave ca LEFT JOIN aeronave a ON a.id = ca.aeronave_id ORDER BY ca.codigo_cliente, a.matricula_registro`).all(),
  ])
  return c.json({ clientes: clientes.results, socios: socios.results, aeronaves: aeronaves.results, vinculos: vinculos.results })
})

app.get('/api/interno/agendamento', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const inicio = c.req.query('inicio') || new Date().toISOString().slice(0, 10)
  const fim = c.req.query('fim') || inicio.slice(0, 7) + '-31'
  const db = portalDb(c)
  await garantirTabelaDisponibilidadeTripulacao(c)
  const [agendamentos, aeronaves, tripulacao, freelancers, disponibilidades] = await Promise.all([
    db.prepare(`SELECT s.id, s.cliente_id, s.socio_id, s.aeronave_id, s.origem, s.destino, s.data_agendada, s.horario_previsto_agendamento, s.dias_duracao, s.numero_passageiros, s.voo_emprestado, s.status, s.observacoes, s.motivo_rejeicao, s.numero_voo, s.criado_em, s.atualizado_em, s.piloto_id, s.copiloto_id, c.razao_social AS cliente_razao_social, so.nome AS socio_nome, COALESCE(c.codigo_cliente, ca.codigo_cliente) AS codigo_cliente, a.matricula_registro, a.modelo, a.status AS status_aeronave
      FROM solicitacoes_reserva_voo s
      LEFT JOIN cliente c ON c.id = s.cliente_id
      LEFT JOIN hold_socios so ON so.id = s.socio_id
      LEFT JOIN cotista_aeronave ca ON (ca.cliente_id = s.cliente_id OR ca.socio_id = s.socio_id) AND ca.aeronave_id = s.aeronave_id
      LEFT JOIN aeronave a ON a.id = s.aeronave_id
      WHERE date(s.data_agendada) BETWEEN ?1 AND ?2
      ORDER BY date(s.data_agendada), s.horario_previsto_agendamento, s.criado_em`).bind(inicio, fim).all(),
    db.prepare("SELECT id, matricula_registro, fabricante, modelo, status, ano, base, url_imagem, tipo_aeronave FROM aeronave WHERE lower(status) = 'ativa' ORDER BY matricula_registro").all(),
    db.prepare("SELECT t.id, t.nome_completo, t.canac, t.status, t.tipo_licenca, up.url_avatar AS url_avatar, 'tripulacao' AS origem FROM tripulacao t LEFT JOIN user_profiles up ON up.id = t.user_id WHERE lower(COALESCE(t.status, 'ativo')) = 'ativo' ORDER BY t.nome_completo").all(),
    db.prepare("SELECT id, nome_completo, canac, status, NULL AS tipo_licenca, url_avatar, 'freelancer' AS origem FROM tripulacao_freelancer WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo").all(),
    db.prepare(`SELECT e.id, e.tripulacao_id AS tripulante_id,
        CASE WHEN EXISTS (SELECT 1 FROM tripulacao t WHERE t.id = e.tripulacao_id) THEN 'tripulacao' ELSE 'freelancer' END AS tripulante_origem,
        e.data_inicio, e.data_fim, e.status, e.observacoes
      FROM escala_tripulacao e
      WHERE date(e.data_inicio) <= date(?2) AND date(e.data_fim) >= date(?1)
      ORDER BY date(e.data_inicio), e.tripulacao_id`).bind(inicio, fim).all(),
  ])
  const tripulantes = [...tripulacao.results, ...freelancers.results]
  const nomes = new Map(tripulantes.map((item: any) => [item.id, item.nome_completo]))
  const escala = agendamentos.results
    .filter((item: any) => item.status === 'aprovada' && (item.piloto_id || item.copiloto_id))
    .map((item: any) => ({
      id: item.id,
      data_agendada: item.data_agendada,
      data_fim: item.dias_duracao > 1 ? new Date(new Date(`${item.data_agendada}T00:00:00Z`).getTime() + (item.dias_duracao - 1) * 86_400_000).toISOString().slice(0, 10) : item.data_agendada,
      numero_voo: item.numero_voo,
      origem: item.origem,
      destino: item.destino,
      piloto_id: item.piloto_id,
      piloto_nome: item.piloto_id ? nomes.get(item.piloto_id) || 'Piloto não localizado' : null,
      copiloto_id: item.copiloto_id,
      copiloto_nome: item.copiloto_id ? nomes.get(item.copiloto_id) || 'Copiloto não localizado' : null,
      status: item.status,
    }))
  return c.json({ inicio, fim, agendamentos: agendamentos.results, aeronaves: aeronaves.results, tripulacao: tripulantes, escala, disponibilidades: disponibilidades.results })
})

app.post('/api/interno/agendamento/disponibilidade', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaDisponibilidadeTripulacao(c)
  const body = await c.req.json<{ tripulante_id?: string; tripulante_origem?: 'tripulacao' | 'freelancer'; data_inicio?: string; data_fim?: string; status?: 'aviso' | 'ferias' | 'disponivel'; observacoes?: string }>().catch(() => null)
  const tripulanteId = body?.tripulante_id?.trim() || ''
  const dataInicio = body?.data_inicio?.trim() || ''
  const dataFim = body?.data_fim?.trim() || dataInicio
  const status = body?.status || 'disponivel'
  if (!tripulanteId || !dataInicio || !dataFim || !['aviso', 'ferias', 'disponivel'].includes(status)) return c.json({ error: 'tripulante_periodo_e_status_obrigatorios' }, 400)
  if (dataFim < dataInicio) return c.json({ error: 'periodo_invalido' }, 400)
  const tripulante = await buscarTripulante(c, tripulanteId)
  if (!tripulante) return c.json({ error: 'tripulante_nao_encontrado' }, 404)
  const id = uuid()
  await portalDb(c).prepare(`INSERT INTO escala_tripulacao (id, tripulacao_id, data_inicio, data_fim, status, observacoes) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, tripulante.id, dataInicio, dataFim, status, body?.observacoes?.trim() || null).run()
  return c.json({ id, ...body, tripulante_origem: tripulante.origem, tripulante_nome: tripulante.nome_completo }, 201)
})

app.post('/api/interno/agendamento', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<{ cliente_id?: string; socio_id?: string; aeronave_id?: string; origem?: string; destino?: string; data_agendada?: string; horario_previsto_agendamento?: string; dias_duracao?: number; numero_passageiros?: number; voo_emprestado?: string; piloto_id?: string; copiloto_id?: string; observacoes?: string }>().catch(() => null)
  const origem = body?.origem?.trim() || ''
  const destino = body?.destino?.trim() || ''
  const dataAgendada = body?.data_agendada?.trim() || ''
  const aeronaveId = body?.aeronave_id?.trim() || ''
  if (!origem || !destino || !dataAgendada || !aeronaveId) return c.json({ error: 'origem_destino_data_e_aeronave_obrigatorios' }, 400)
  const aeronave = await portalDb(c).prepare("SELECT id FROM aeronave WHERE id = ?1 AND lower(status) = 'ativa'").bind(aeronaveId).first<{ id: string }>()
  if (!aeronave) return c.json({ error: 'aeronave_nao_disponivel' }, 409)
  const cliente = body?.cliente_id ? await portalDb(c).prepare('SELECT id, codigo_cliente FROM cliente WHERE id = ?1').bind(body.cliente_id).first<{ id: string; codigo_cliente: string | null }>() : null
  const socio = body?.socio_id ? await portalDb(c).prepare('SELECT id, cliente_id FROM hold_socios WHERE id = ?1').bind(body.socio_id).first<{ id: string; cliente_id: string | null }>() : null
  if (!cliente && !socio) return c.json({ error: 'cliente_ou_socio_obrigatorio' }, 400)
  if (cliente && socio) return c.json({ error: 'selecione_cliente_ou_socio' }, 400)
  const clienteId = cliente?.id || socio?.cliente_id || null
  const vinculo = await portalDb(c).prepare('SELECT codigo_cliente FROM cotista_aeronave WHERE aeronave_id = ?1 AND (cliente_id = ?2 OR socio_id = ?3) AND codigo_cliente IS NOT NULL LIMIT 1').bind(aeronaveId, clienteId, socio?.id || null).first<{ codigo_cliente: string }>()
  const codigoCliente = vinculo?.codigo_cliente?.trim().toUpperCase() || ''
  if (!codigoCliente) return c.json({ error: 'aeronave_sem_codigo_cotista' }, 409)
  const piloto = body?.piloto_id ? await buscarTripulante(c, body.piloto_id.trim()) : null
  const copiloto = body?.copiloto_id ? await buscarTripulante(c, body.copiloto_id.trim()) : null
  if (body?.piloto_id && !piloto) return c.json({ error: 'piloto_nao_encontrado' }, 400)
  if (body?.copiloto_id && !copiloto) return c.json({ error: 'copiloto_nao_encontrado' }, 400)
  if (body?.piloto_id && body?.copiloto_id && body.piloto_id === body.copiloto_id) return c.json({ error: 'tripulantes_iguais' }, 400)
  const id = uuid()
  await portalDb(c).prepare(`INSERT INTO solicitacoes_reserva_voo (id, cliente_id, socio_id, aeronave_id, voo_emprestado, origem, destino, data_agendada, horario_previsto_agendamento, dias_duracao, numero_passageiros, status, observacoes, piloto_id, copiloto_id, numero_voo, aprovado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, clienteId, socio?.id || null, aeronaveId, body?.voo_emprestado?.trim() || 'nao', origem, destino, dataAgendada, body?.horario_previsto_agendamento?.trim() || null, Math.max(1, Number(body?.dias_duracao || 1)), Math.max(1, Number(body?.numero_passageiros || 1)), 'pendente', body?.observacoes?.trim() || null, null, null, null, null).run()
  return c.json({ id, status: 'pendente', numero_voo: null }, 201)
})

app.get('/api/interno/solicitacoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const status = c.req.query('status')
  const query = status ? "SELECT s.*, c.razao_social AS cliente_razao_social, c.codigo_cliente, a.matricula_registro, a.modelo FROM solicitacoes_reserva_voo s LEFT JOIN cliente c ON c.id = s.cliente_id LEFT JOIN aeronave a ON a.id = s.aeronave_id WHERE s.status = ?1 ORDER BY s.data_agendada" : "SELECT s.*, c.razao_social AS cliente_razao_social, c.codigo_cliente, a.matricula_registro, a.modelo FROM solicitacoes_reserva_voo s LEFT JOIN cliente c ON c.id = s.cliente_id LEFT JOIN aeronave a ON a.id = s.aeronave_id ORDER BY s.data_agendada"
  const result = status ? await portalDb(c).prepare(query).bind(status).all() : await portalDb(c).prepare(query).all()
  return c.json(result.results)
})

app.post('/api/interno/seguranca/migrar-senhas', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const rows = await portalDb(c).prepare("SELECT id, senha FROM user_cliente WHERE senha NOT LIKE 'pbkdf2_sha256$%'").all<{ id: string; senha: string }>()
  for (const row of rows.results) await portalDb(c).prepare('UPDATE user_cliente SET senha = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(await portalCreatePasswordHash(row.senha), row.id).run()
  return c.json({ success: true, migrated: rows.results.length })
})

async function portalFlightSequence(c: Context<{ Bindings: Bindings }>, clientCode: string): Promise<string> {
  const sequence = await portalDb(c).prepare('UPDATE voo_sequencia SET ultimo_numero = ultimo_numero + 1 WHERE id = 1 RETURNING ultimo_numero').first<{ ultimo_numero: number }>()
  if (!sequence) throw new Error('flight_sequence_not_initialized')
  const codigo = clientCode.trim().toUpperCase().slice(0, 3)
  const ano = String(new Date().getFullYear()).slice(-2)
  return `${codigo}-${String(sequence.ultimo_numero).padStart(4, '0')}/${ano}`
}

app.post('/api/interno/solicitacoes/:id/aprovar', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const id = c.req.param('id')
  const reservation = await portalDb(c).prepare(`SELECT s.*, COALESCE(c.codigo_cliente, ca.codigo_cliente) AS codigo_cliente
    FROM solicitacoes_reserva_voo s
    LEFT JOIN cliente c ON c.id = s.cliente_id
    LEFT JOIN cotista_aeronave ca ON (ca.cliente_id = s.cliente_id OR ca.socio_id = s.socio_id) AND ca.aeronave_id = s.aeronave_id
    WHERE s.id = ?1`).bind(id).first<{ status: string; codigo_cliente: string | null }>()
  if (!reservation) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  if (reservation.status !== 'pendente') return c.json({ error: 'solicitacao_nao_pendente' }, 409)
  const body = await c.req.json<{ piloto_id?: string; copiloto_id?: string }>().catch(() => ({} as { piloto_id?: string; copiloto_id?: string }))
  if (!body.piloto_id) return c.json({ error: 'piloto_obrigatorio' }, 400)
  if (body.copiloto_id && body.copiloto_id === body.piloto_id) return c.json({ error: 'tripulantes_iguais' }, 400)
  if (!reservation.codigo_cliente) return c.json({ error: 'codigo_cliente_obrigatorio' }, 409)
  const piloto = await buscarTripulante(c, body.piloto_id)
  const copiloto = body.copiloto_id ? await buscarTripulante(c, body.copiloto_id) : null
  if (!piloto) return c.json({ error: 'piloto_nao_encontrado' }, 400)
  if (body.copiloto_id && !copiloto) return c.json({ error: 'copiloto_nao_encontrado' }, 400)
  const flightNumber = await portalFlightSequence(c, reservation.codigo_cliente)
  await portalDb(c).prepare("UPDATE solicitacoes_reserva_voo SET status = 'aprovada', numero_voo = ?, piloto_id = ?, copiloto_id = ?, aprovado_em = CURRENT_TIMESTAMP, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").bind(flightNumber, piloto.id, copiloto?.id || null, id).run()
  return c.json({ success: true, status: 'aprovada', solicitacao_id: id, numero_voo: flightNumber, piloto, copiloto })
})

app.post('/api/interno/solicitacoes/:id/reprovar', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<{ motivo_rejeicao?: string }>().catch(() => ({} as { motivo_rejeicao?: string }))
  if (!body.motivo_rejeicao?.trim()) return c.json({ error: 'motivo_rejeicao_obrigatorio' }, 400)
  const result = await portalDb(c).prepare("UPDATE solicitacoes_reserva_voo SET status = 'reprovada', motivo_rejeicao = ?, aprovado_em = CURRENT_TIMESTAMP, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pendente'").bind(body.motivo_rejeicao.trim(), c.req.param('id')).run()
  if (!result.meta.changes) return c.json({ error: 'solicitacao_nao_pendente' }, 409)
  return c.json({ success: true, status: 'reprovada', solicitacao_id: c.req.param('id') })
})

app.notFound((c) => c.json({ error: 'Rota não encontrada', path: c.req.path }, 404))

// ─── Exports ──────────────────────────────────────────────────────────────────

const PREFETCH_ICAOS = ['SBGR', 'SBSP', 'SBRJ', 'SBCY', 'SBCF', 'SBBR']
const WORKER_URL = 'https://api-workers.sharebrasil.workers.dev'

export default {
  fetch: app.fetch,
  async scheduled(_event: any, _env: Bindings, ctx: ExecutionContext) {
    const tasks = [
      // Aquece weather e notam dos principais aeródromos
      ...PREFETCH_ICAOS.flatMap(icao => [
        fetch(`${WORKER_URL}/api/weather/${icao}`),
        fetch(`${WORKER_URL}/api/notam/${icao}`),
      ]),
      // Aquece o rotaer-all para /nearest e /geiloc/nearby responderem do cache
      fetch(`${WORKER_URL}/api/nearest?lat=-23.5&lon=-46.6`),
    ]
    ctx.waitUntil(Promise.allSettled(tasks))
  },
}
