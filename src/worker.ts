import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { XMLParser } from 'fast-xml-parser'

// ─── Types ────────────────────────────────────────────────────────────────────

type Bindings = {
  AISWEB_API_KEY: string
  AISWEB_API_PASS: string
  CACHE_KV: KVNamespace
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
},      // @ts-ignore — Cloudflare Workers specific
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

function normalizeAirportList(data: any, userLat: number, userLon: number): Airport[] {
  const src   = data?.item ?? data
  const items = Array.isArray(src) ? src : [src]
  const list: Airport[] = []
  for (const item of items) {
    const icao = item?.icaoCode ?? item?.icao ?? item?.CodICAO
    if (!icao) continue
    const lat = parseCoord(item?.latitude ?? item?.lat)
    const lon = parseCoord(item?.longitude ?? item?.lon)
    if (lat == null || lon == null) continue
    list.push({ icao, name: item?.nome ?? icao, lat, lon, distKm: Math.round(haversineKm(userLat, userLon, lat, lon)) })
  }
  return list
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

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (c) => c.text('ShareBrasil API 🚀'))

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
    return c.json(data)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/rotaer', async (c) => {
  const adep = c.req.query('adep')?.toUpperCase()
  const ades = c.req.query('ades')?.toUpperCase()
  try {
    const data = await cachedFetch(c, `rotaer-${adep ?? ''}-${ades ?? ''}`, 1800,
      () => fetchAisweb(c, 'rotaer', { adep, ades }))
    return c.json(data)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

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
    const [dep, des] = await Promise.all([
      fetchAisweb(c, 'rotaer', { icaoCode: adep }),
      fetchAisweb(c, 'rotaer', { icaoCode: ades }),
    ])

    const depItem = dep?.item?.[0], desItem = des?.item?.[0]
    if (!depItem || !desItem) return c.json({ error: 'Aeródromo não encontrado' }, 404)

    const lat1 = parseCoord(depItem.latitude ?? depItem.lat)
    const lon1 = parseCoord(depItem.longitude ?? depItem.lon)
    const lat2 = parseCoord(desItem.latitude ?? desItem.lat)
    const lon2 = parseCoord(desItem.longitude ?? desItem.lon)
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
