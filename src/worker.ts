import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { XMLParser } from 'fast-xml-parser'

// ─── Types ────────────────────────────────────────────────────────────────────

type Bindings = {
  AISWEB_API_KEY: string
  AISWEB_API_PASS: string
  CACHE_KV: KVNamespace
  FILES: R2Bucket
  DB: D1Database
  RESEND_API_KEY: string
  INTERNAL_TOKEN: string
  EMAIL_FROM: string // ex: "Financeiro Share Brasil <financeiro@seudominio.com>"
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  WINSOCK_VALUATION_URL: string
  WINSOCK_API_KEY: string
  WINSOCK_AUTH_HEADER?: string
  WINSOCK_AUTH_PREFIX?: string
}

interface Airport { icao: string; name: string; lat: number; lon: number; distKm: number }

// ─── App & Logger ─────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

const isDev = false
const log = {
  debug: (...a: any[]) => isDev && console.log('[DEBUG]', ...a),
  warn:  (...a: any[]) => console.warn('[WARN]',  ...a),
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

async function requireAuthenticatedUser(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  const authorization = c.req.header('authorization')
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = c.env

  if (!authorization?.startsWith('Bearer ') || !SUPABASE_URL || !SUPABASE_ANON_KEY) return false

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: authorization,
    },
  })

  return response.ok
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

function normalizeWindsockValuation(data: Record<string, any>): Record<string, any> {
  const valuation = data.valuation ?? data.data ?? data
  const estimatedMarketValue = valuation.estimated_market_value ?? valuation.estimatedMarketValue ?? valuation.market_value

  if (typeof estimatedMarketValue !== 'number') {
    throw new Error('Resposta da Windsock sem estimated_market_value')
  }

  return {
    ...valuation,
    estimated_market_value: estimatedMarketValue,
    confidence_score: valuation.confidence_score ?? valuation.confidenceScore ?? null,
    updated_at: valuation.updated_at ?? valuation.updatedAt ?? new Date().toISOString(),
  }
}

async function fetchWindsockValuation(c: Context<{ Bindings: Bindings }>, aircraft: Record<string, unknown>): Promise<Record<string, any>> {
  const { WINSOCK_VALUATION_URL, WINSOCK_API_KEY, WINSOCK_AUTH_HEADER = 'Authorization', WINSOCK_AUTH_PREFIX = 'Bearer ' } = c.env

  if (!WINSOCK_VALUATION_URL || !WINSOCK_API_KEY) throw new Error('Integração Windsock não configurada')

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
      body: JSON.stringify(aircraft),
    })

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


const AREA_NODE_MAP: Record<string, string> = {
  met:         'met',
  cartas:      'cartas',
  notam:       'notam',
  infotemp:    'infotemp',
  sol:         'sol',
  routesp:     'routesp',
  waypoints:   'waypoints',
  rotaer:      'rotaer',
  pub:         'pub',
  suplementos: 'suplementos',
  geiloc:      'geiloc',
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
  const kv  = c.env.CACHE_KV
  const raw = await kv.get(key, { type: 'json' }) as any
  const now = Date.now()

  const isNewFormat   = raw !== null && typeof raw === 'object' && 'fetchedAt' in raw && 'data' in raw
  const fetchedAt     = isNewFormat ? (raw.fetchedAt as number) : 0
  const cachedData    = isNewFormat ? raw.data : raw
  const ageSeconds    = (now - fetchedAt) / 1000
  const hasCachedData = cachedData !== null && cachedData !== undefined
  const isFresh       = hasCachedData && ageSeconds < ttlSeconds
  const isStale       = hasCachedData && ageSeconds >= ttlSeconds

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
  const locked = await kv.get(lockKey)
  if (locked) {
    await new Promise(r => setTimeout(r, 800))
    const retry = await kv.get(key, { type: 'json' }) as any
    if (retry?.data) return retry.data
    if (retry)       return retry
  }

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
  const res  = await fetchWithTimeout(url, 12_000)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const text = await res.text()
  if (!text) throw new Error('Resposta vazia da AISWEB')

  // ─── Detecta HTML de erro (bloqueio, auth, página de manutenção) ──────────
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<html') || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype')) {
    throw new Error(`AISWEB retornou HTML em vez de XML (bloqueio ou erro de auth): ${text.slice(0, 200)}`)
  }

  try { return JSON.parse(text) } catch {}

  const parsed = parser.parse(text)
  const root   = parsed['aisweb'] ?? parsed
  const node   = AREA_NODE_MAP[area]

  if (!node) return root
  if (!root[node]) {
    log.warn(`Node "${node}" ausente para area="${area}". Chaves: [${Object.keys(root).join(', ')}]`)
    return {}
  }
  return root[node]
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

function normalizeMet(data: any, icao: string): Record<string, any> {
  if (!data || typeof data !== 'object') return { loc: icao, metar: '', taf: '' }

  const metarStr =
    (typeof data.rawOb === 'string'        ? data.rawOb        : null) ??
    (typeof data.metar === 'string'        ? data.metar        : null) ??
    (typeof data.metar?.metar === 'string' ? data.metar.metar  : null) ??
    (typeof data.metar?.raw === 'string'   ? data.metar.raw    : null) ??
    ''

  const tafStr =
    (typeof data.taf === 'string'          ? data.taf          : null) ??
    (typeof data.taf?.taf === 'string'     ? data.taf.taf      : null) ??
    (typeof data.taf?.raw === 'string'     ? data.taf.raw      : null) ??
    ''

  log.debug(`[MET RAW] ${icao}:`, JSON.stringify(data).slice(0, 500))

  if (!metarStr && !tafStr) {
    throw new Error(`METAR/TAF vazio para ${icao}`)
  }

  return {
    loc:   data.metar?.loc ?? data.loc ?? icao,
    metar: metarStr,
    taf:   tafStr,
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

async function fetchRotaerByIcao(c: Context<{ Bindings: Bindings }>, icao: string): Promise<any> {
  const data = await cachedFetch(c, 'rotaer-all', 1800, () => fetchAisweb(c, 'rotaer', {}))
  const airport = rotaerItems(data).find(item => rotaerIcao(item) === icao)
  if (!airport) throw new Error(`Aeródromo ${icao} não encontrado no ROTAER`)
  return airport
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

/** Protege rotas sensíveis (upload, envio de email). Chamado no início de cada handler. */
function checkInternalAuth(c: Context<{ Bindings: Bindings }>): boolean {
  return Boolean(c.env.INTERNAL_TOKEN) && c.req.header('x-internal-token') === c.env.INTERNAL_TOKEN
}

/**
 * Extrai o user_id (sub) do JWT do Supabase enviado pelo front, SEM validar assinatura.
 * Serve só para rastreabilidade (quem disparou o envio) — a autorização real
 * é feita pelo x-internal-token. Se quiser validar a assinatura de verdade,
 * dá pra usar a JWKS do Supabase (GET /auth/v1/.well-known/jwks.json) com jose.
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

// ─── Routes: AISWEB (existentes) ──────────────────────────────────────────────

app.get('/', (c) => c.text('ShareBrasil API 🚀'))

app.post('/api/aircraft-valuation', async (c) => {
  try {
    if (!(await requireAuthenticatedUser(c))) return c.json({ error: 'Não autorizado' }, 401)

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
    log.error('[windsock]', error.message)
    return c.json({ error: error.message === 'Integração Windsock não configurada' ? error.message : 'Não foi possível obter a avaliação da aeronave' }, 502)
  }
})

app.get('/api/weather/:icao', async (c) => {
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
  const icao = c.req.param('icao').toUpperCase()
  try {
    const data = await cachedFetch(c, `notam-${icao}`, 600, () => fetchAisweb(c, 'notam', { icaoCode: icao }))
    return c.json(data)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/charts/:icao', async (c) => {
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
  const icaoCode = (icaoParam ?? c.req.query('icaoCode') ?? c.req.query('icao'))?.trim().toUpperCase()
  const adep = c.req.query('adep')?.trim().toUpperCase()
  const ades = c.req.query('ades')?.trim().toUpperCase()

  if (!icaoCode && !adep && !ades) {
    return c.json({ error: 'Informe icaoCode, icao, adep ou ades' }, 400)
  }

  try {
    if (icaoCode) {
      const airport = await fetchRotaerByIcao(c, icaoCode)
      return c.json({ item: [airport] })
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
  const adep = c.req.query('adep')?.toUpperCase()
  const ades = c.req.query('ades')?.toUpperCase()
  if (!adep || !ades) return c.json({ error: 'adep e ades são obrigatórios' }, 400)
  try {
    const data  = await cachedFetch(c, `routes-${adep}-${ades}`, 3600, () => fetchAisweb(c, 'routesp', { adep, ades }))
    const raw   = data?.item
    const items = Array.isArray(raw) ? raw : (raw ? [raw] : [])
    return c.json({
      adep, ades,
      routes: items.map((r: any) => ({
        route:   r?.rota    ?? r?.route   ?? '',
        level:   r?.nivel   ?? r?.level   ?? '',
        remarks: r?.rmk     ?? r?.remarks ?? '',
      })),
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/solar/:icao', async (c) => {
  const icao = c.req.param('icao').toUpperCase()
  const date = c.req.query('date')
  try {
    const today    = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const cacheKey = `solar-${icao}-${date ?? today}`
    const data     = await cachedFetch(c, cacheKey, 86400,
      () => fetchAisweb(c, 'sol', { icaoCode: icao, ...(date ? { date } : {}) }))
    const days = Array.isArray(data) ? data : (data?.sol ?? [data])
    return c.json({
      icao,
      solar: days.map((d: any) => ({
        date:                 d?.date   ?? d?.data   ?? '',
        sunrise:              d?.nascer ?? d?.sunrise ?? '',
        sunset:               d?.poente ?? d?.sunset  ?? '',
        civil_twilight_begin: d?.crepusculo_manha ?? '',
        civil_twilight_end:   d?.crepusculo_tarde ?? '',
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

    const tripFuel    = flightH  * Number(fuel_burn)
    const reserveFuel = reserveH * Number(fuel_burn)
    const taxiFuel    = taxiH    * Number(fuel_burn)
    const totalFuel   = tripFuel + reserveFuel + taxiFuel

    const totalMin = Math.round(flightH * 60)
    const hours    = Math.floor(totalMin / 60), minutes = totalMin % 60

    return c.json({
      inputs:  { distance_nm: dist, speed_kts, fuel_burn, reserve_min, wind_kts, taxi_min },
      results: {
        ground_speed_kts:    Math.round(gs),
        flight_time:         `${hours}h${String(minutes).padStart(2, '0')}m`,
        flight_minutes:      totalMin,
        trip_fuel_liters:    Math.round(tripFuel),
        reserve_fuel_liters: Math.round(reserveFuel),
        taxi_fuel_liters:    Math.round(taxiFuel),
        total_fuel_liters:   Math.round(totalFuel),
      },
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/nearest', async (c) => {
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
  const adep       = c.req.query('adep')?.toUpperCase()
  const ades       = c.req.query('ades')?.toUpperCase()
  const speed      = parseInt(c.req.query('speed')       ?? '120')
  const burn       = parseFloat(c.req.query('fuel_burn') ?? '32')
  const reserveMin = parseInt(c.req.query('reserve')     ?? '45')

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

    const distanceNm  = haversineKm(lat1, lon1, lat2, lon2) * 0.539957
    const flightHours = distanceNm / speed
    const reserveH    = reserveMin / 60

    const hours   = Math.floor(flightHours)
    const minutes = Math.round((flightHours - hours) * 60)

    const tripFuel    = flightHours * burn
    const reserveFuel = reserveH    * burn
    const taxiFuel    = burn        * (10 / 60)
    const totalFuel   = tripFuel + reserveFuel + taxiFuel

    let routeStr = `${adep} DCT ${ades}`
    try {
      const routePref = await fetchAisweb(c, 'routesp', { adep, ades })
      routeStr = routePref?.item?.[0]?.rota ?? routeStr
    } catch {}

    const [alternates, notamDep, notamDes] = await Promise.all([
      fetchNearby(c, lat2, lon2),
      fetchAisweb(c, 'notam', { icaoCode: adep }),
      fetchAisweb(c, 'notam', { icaoCode: ades }),
    ])

    const nearbyAlts = alternates
      .filter(a => a.icao !== ades && a.distKm < 150)
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 3)

    const toItems = (n: any) => Array.isArray(n?.item) ? n.item : (n?.item ? [n.item] : [])
    const notamAlerts = [...toItems(notamDep), ...toItems(notamDes)]
      .map((n: any) => n?.texto ?? n?.notam)
      .filter(Boolean)
      .slice(0, 5)

    return c.json({
      flightplan: {
        adep,
        ades,
        route:          routeStr,
        distance_nm:    Math.round(distanceNm),
        estimated_time: `${hours}h${String(minutes).padStart(2, '0')}m`,
        flight_minutes: Math.round(flightHours * 60),
        cruise_speed:   speed,
      },
      fuel: {
        burn_lh:        burn,
        trip_liters:    Math.round(tripFuel),
        reserve_liters: Math.round(reserveFuel),
        taxi_liters:    Math.round(taxiFuel),
        total_required: Math.round(totalFuel),
        reserve_min:    reserveMin,
      },
      departure: {
        icao: adep,
        name: depItem?.nome ?? adep,
        lat:  lat1,
        lon:  lon1,
      },
      destination: {
        icao: ades,
        name: desItem?.nome ?? ades,
        lat:  lat2,
        lon:  lon2,
      },
      alternates: nearbyAlts.map(a => ({
        icao:        a.icao,
        name:        a.name,
        distance_km: a.distKm,
      })),
      notam_alerts: notamAlerts,
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── Routes: Upload de arquivos (R2 + short link) ────────────────────────────

app.post('/api/upload', async (c) => {
  if (!checkInternalAuth(c)) return c.json({ error: 'Unauthorized' }, 401)

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
  if (!checkInternalAuth(c)) return c.json({ error: 'Unauthorized' }, 401)
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
  if (!checkInternalAuth(c)) return c.json({ error: 'Unauthorized' }, 401)
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
  if (!checkInternalAuth(c)) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const { to, cc, subject, html, tipo, reference_type, reference_id, attachments } = await c.req.json()
    if (!to || !subject || !html) return c.json({ error: 'Campos obrigatórios faltando (to, subject, html)' }, 400)

    const enviadoPor = extractSupabaseUserId(c)

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
  if (!checkInternalAuth(c)) return c.json({ error: 'Unauthorized' }, 401)
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

app.notFound((c) => c.json({ error: 'Rota não encontrada', path: c.req.path }, 404))

// ─── Exports ──────────────────────────────────────────────────────────────────

const PREFETCH_ICAOS = ['SBGR', 'SBSP', 'SBRJ', 'SBCY', 'SBCF', 'SBBR']
const WORKER_URL     = 'https://api-workers.sharebrasil.workers.dev'

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
