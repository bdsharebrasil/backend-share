import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { XMLParser } from 'fast-xml-parser'

// ─── Types ────────────────────────────────────────────────────────────────────

type Bindings = {
  AISWEB_API_KEY: string
  AISWEB_API_PASS: string
  CACHE_KV: KVNamespace
  AI: any
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

// ─── Logger ───────────────────────────────────────────────────────────────────

const isDev = true // troque para false em produção
const log = {
  debug: (...a: any[]) => isDev && console.log('[DEBUG]', ...a),
  warn:  (...a: any[]) => console.warn('[WARN]',  ...a),
  error: (...a: any[]) => console.error('[ERROR]', ...a),
}

// ─── XML Parser ───────────────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['item', 'notam', 'carta', 'sol'].includes(name),
})

// ─── Constants ────────────────────────────────────────────────────────────────

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
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/xml,application/xml,*/*',
      },
      // @ts-ignore — Cloudflare Workers specific
      cf: { cacheTtl: 300, cacheEverything: true },
    })
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`Timeout após ${timeout}ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ─── Cache KV com Lock (evita thundering herd) ────────────────────────────────

async function cachedFetch(
  c: Context<{ Bindings: Bindings }>,
  key: string,
  ttl: number,
  fetcher: () => Promise<any>
): Promise<any> {
  const kv = c.env.CACHE_KV

  // 1. Cache hit
  const hit = await kv.get(key)
  if (hit) return JSON.parse(hit)

  // 2. Lock: evita múltiplas requisições simultâneas ao mesmo key
  const lockKey = `${key}:lock`
  const locked  = await kv.get(lockKey)

  if (locked) {
    // Aguarda e tenta novamente após outro worker popular o cache
    await new Promise(r => setTimeout(r, 500))
    const retry = await kv.get(key)
    if (retry) return JSON.parse(retry)
  }

  await kv.put(lockKey, '1', { expirationTtl: 15 })

  try {
    const data = await fetcher()
    await kv.put(key, JSON.stringify(data), { expirationTtl: ttl })
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

  if (!apiKey?.trim() || !apiPass?.trim()) {
    throw new Error('Credenciais AISWEB ausentes')
  }

  const query = new URLSearchParams({ apiKey, apiPass, area })
  Object.entries(params).forEach(([k, v]) => v && query.append(k, v))

  const url = `${AISWEB_BASE_URL}?${query.toString()}`
  log.debug(`fetchAisweb area=${area}`, params)

  const res = await fetchWithTimeout(url, 10_000)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const text = await res.text()
  if (!text) throw new Error('Resposta vazia da AISWEB')

  // JSON direto (ex: endpoints novos da DECEA)
  try { return JSON.parse(text) } catch {}

  // Parse XML
  const parsed = parser.parse(text)
  const root   = parsed['aisweb'] ?? parsed
  const node   = AREA_NODE_MAP[area]

  if (!node) {
    log.warn(`Área "${area}" sem mapeamento de node — retornando objeto raiz`)
    return root
  }

  if (!root[node]) {
    log.warn(
      `Node "${node}" ausente para area="${area}". ` +
      `Chaves: [${Object.keys(root).join(', ')}]. ` +
      `XML (300 chars): ${text.slice(0, 300)}`
    )
    return {}
  }

  log.debug(`✓ area=${area} node="${node}" encontrado`)
  return root[node]
}

// ─── Geo Helpers ──────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
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

// ─── Normalizadores ───────────────────────────────────────────────────────────

/**
 * Normaliza o nó "met" da AISWEB para shape previsível.
 * Cobre os casos: objeto aninhado, string plana e rawOb.
 */
function normalizeMet(data: any, icao: string): Record<string, any> {
  if (!data || typeof data !== 'object') return { loc: icao, metar: '', taf: '' }

  const metarStr =
    (typeof data.rawOb === 'string'              ? data.rawOb              : null) ??
    (typeof data.metar === 'string'              ? data.metar              : null) ??
    (typeof data.metar?.metar === 'string'       ? data.metar.metar        : null) ??
    (typeof data.metar?.raw === 'string'         ? data.metar.raw          : null) ??
    ''

  const tafStr =
    (typeof data.taf === 'string'                ? data.taf                : null) ??
    (typeof data.taf?.taf === 'string'           ? data.taf.taf            : null) ??
    (typeof data.taf?.raw === 'string'           ? data.taf.raw            : null) ??
    ''

  return {
    loc:   data.metar?.loc ?? data.loc ?? icao,
    metar: metarStr,
    taf:   tafStr,
    ...(isDev ? { _raw: data } : {}), // só em dev
  }
}

interface Airport {
  icao:   string
  name:   string
  lat:    number
  lon:    number
  distKm: number
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

    list.push({
      icao,
      name:   item?.nome ?? icao,
      lat,
      lon,
      distKm: Math.round(haversineKm(userLat, userLon, lat, lon)),
    })
  }

  return list
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (c) => c.text('ShareBrasil API 🚀'))

// ── WEATHER (METAR/TAF) ──────────────────────────────────────────────────────
app.get('/api/weather/:icao', async (c) => {
  const icao = c.req.param('icao').toUpperCase()
  try {
    const data = await cachedFetch(c, `metar-${icao}`, 300,
      () => fetchAisweb(c, 'met', { icaoCode: icao })
    )
    return c.json(normalizeMet(data, icao))
  } catch (e: any) {
    log.error(`[weather] ${icao}:`, e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── NOTAM ────────────────────────────────────────────────────────────────────
app.get('/api/notam/:icao', async (c) => {
  const icao = c.req.param('icao').toUpperCase()
  try {
    const data = await cachedFetch(c, `notam-${icao}`, 600,
      () => fetchAisweb(c, 'notam', { icaoCode: icao })
    )
    return c.json(data)
  } catch (e: any) {
    log.error(`[notam] ${icao}:`, e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── CARTAS (CHARTS) ──────────────────────────────────────────────────────────
app.get('/api/charts/:icao', async (c) => {
  const icao    = c.req.param('icao').toUpperCase()
  const especie = c.req.query('especie')
  const tipo    = c.req.query('tipo')
  try {
    const data = await cachedFetch(c, `charts-${icao}-${especie ?? ''}-${tipo ?? ''}`, 3600,
      () => fetchAisweb(c, 'cartas', { icaoCode: icao, especie, tipo })
    )
    return c.json(data)
  } catch (e: any) {
    log.error(`[charts] ${icao}:`, e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── ROTAER ────────────────────────────────────────────────────────────────────
app.get('/api/rotaer', async (c) => {
  const adep = c.req.query('adep')?.toUpperCase()
  const ades = c.req.query('ades')?.toUpperCase()
  try {
    const cacheKey = `rotaer-${adep ?? ''}-${ades ?? ''}`
    const data = await cachedFetch(c, cacheKey, 1800,
      () => fetchAisweb(c, 'rotaer', { adep, ades })
    )
    return c.json(data)
  } catch (e: any) {
    log.error(`[rotaer] adep=${adep} ades=${ades}:`, e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── ROTAS PREFERENCIAIS ──────────────────────────────────────────────────────
app.get('/api/routes', async (c) => {
  const adep = c.req.query('adep')?.toUpperCase()
  const ades = c.req.query('ades')?.toUpperCase()
  if (!adep || !ades) return c.json({ error: 'adep e ades são obrigatórios' }, 400)

  try {
    const data = await cachedFetch(c, `routes-${adep}-${ades}`, 3600,
      () => fetchAisweb(c, 'routesp', { adep, ades })
    )
    const raw   = data?.item
    const items = Array.isArray(raw) ? raw : (raw ? [raw] : [])

    return c.json({
      adep,
      ades,
      routes: items.map((r: any) => ({
        route:   r?.rota    ?? r?.route   ?? '',
        level:   r?.nivel   ?? r?.level   ?? '',
        remarks: r?.rmk     ?? r?.remarks ?? '',
      })),
    })
  } catch (e: any) {
    log.error(`[routes] ${adep}→${ades}:`, e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── SOLAR ─────────────────────────────────────────────────────────────────────
app.get('/api/solar/:icao', async (c) => {
  const icao = c.req.param('icao').toUpperCase()
  const date = c.req.query('date') // YYYYMMDD; opcional

  try {
    const today    = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const cacheKey = `solar-${icao}-${date ?? today}`

    const data = await cachedFetch(c, cacheKey, 86400,
      () => fetchAisweb(c, 'sol', { icaoCode: icao, ...(date ? { date } : {}) })
    )

    const days = Array.isArray(data) ? data : (data?.sol ?? [data])

    return c.json({
      icao,
      solar: days.map((d: any) => ({
        date:                 d?.date    ?? d?.data    ?? '',
        sunrise:              d?.nascer  ?? d?.sunrise ?? '',
        sunset:               d?.poente  ?? d?.sunset  ?? '',
        civil_twilight_begin: d?.crepusculo_manha ?? '',
        civil_twilight_end:   d?.crepusculo_tarde ?? '',
      })),
    })
  } catch (e: any) {
    log.error(`[solar] ${icao}:`, e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── FLIGHT CALCULATIONS (sem AISWEB) ─────────────────────────────────────────
app.post('/api/flight-calculations', async (c) => {
  try {
    const body = await c.req.json()

    const {
      distance_nm,
      speed_kts   = 120,
      fuel_burn   = 32,  // L/h
      reserve_min = 45,
      wind_kts    = 0,   // positivo = headwind, negativo = tailwind
      taxi_min    = 10,
    } = body

    if (!distance_nm || isNaN(Number(distance_nm))) {
      return c.json({ error: 'distance_nm é obrigatório' }, 400)
    }

    const dist     = Number(distance_nm)
    const gs       = Math.max(Number(speed_kts) - Number(wind_kts), 1) // ground speed
    const flightH  = dist / gs
    const reserveH = Number(reserve_min) / 60
    const taxiH    = Number(taxi_min) / 60

    const tripFuel    = flightH  * Number(fuel_burn)
    const reserveFuel = reserveH * Number(fuel_burn)
    const taxiFuel    = taxiH    * Number(fuel_burn)
    const totalFuel   = tripFuel + reserveFuel + taxiFuel

    const totalMin = Math.round(flightH * 60)
    const hours    = Math.floor(totalMin / 60)
    const minutes  = totalMin % 60

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
    log.error('[flight-calculations]:', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── NEAREST AIRPORT ───────────────────────────────────────────────────────────
app.get('/api/nearest', async (c) => {
  const lat = parseFloat(c.req.query('lat') ?? '')
  const lon = parseFloat(c.req.query('lon') ?? '')
  if (isNaN(lat) || isNaN(lon)) return c.json({ error: 'lat/lon inválidos' }, 400)

  try {
    const raw = await cachedFetch(c, 'rotaer-all', 1800,
      () => fetchAisweb(c, 'rotaer', {})
    )
    const airports = normalizeAirportList(raw, lat, lon)
    airports.sort((a, b) => a.distKm - b.distKm)

    return c.json({
      nearest:    airports[0] ?? null,
      alternates: airports.slice(0, 5),
    })
  } catch (e: any) {
    log.error('[nearest]:', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── GEILOC NEARBY ─────────────────────────────────────────────────────────────
app.get('/api/geiloc/nearby', async (c) => {
  const lat = parseFloat(c.req.query('lat') ?? '')
  const lon = parseFloat(c.req.query('lon') ?? '')
  if (isNaN(lat) || isNaN(lon)) return c.json({ error: 'lat/lon inválidos' }, 400)

  try {
    const raw = await cachedFetch(c,
      `geiloc-${Math.round(lat * 10)}-${Math.round(lon * 10)}`,
      1800,
      () => fetchAisweb(c, 'rotaer', {})
    )
    const airports = normalizeAirportList(raw, lat, lon)
    airports.sort((a, b) => a.distKm - b.distKm)

    return c.json({
      alternates: airports.filter(a => a.distKm < 200).slice(0, 10),
    })
  } catch (e: any) {
    log.error('[geiloc/nearby]:', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── FLIGHT PLAN ───────────────────────────────────────────────────────────────
app.get('/api/flightplan', async (c) => {
  const adep       = c.req.query('adep')?.toUpperCase()
  const ades       = c.req.query('ades')?.toUpperCase()
  const speed      = parseInt(c.req.query('speed')      ?? '120')
  const burn       = parseFloat(c.req.query('fuel_burn') ?? '32')
  const reserveMin = parseInt(c.req.query('reserve')    ?? '45')

  if (!adep || !ades) return c.json({ error: 'adep e ades são obrigatórios' }, 400)

  try {
    // Dados dos aeródromos em paralelo
    const [dep, des] = await Promise.all([
      fetchAisweb(c, 'rotaer', { icaoCode: adep }),
      fetchAisweb(c, 'rotaer', { icaoCode: ades }),
    ])

    const depItem = dep?.item?.[0]
    const desItem = des?.item?.[0]
    if (!depItem || !desItem) return c.json({ error: 'Aeródromo não encontrado' }, 404)

    const lat1 = parseCoord(depItem.latitude ?? depItem.lat)
    const lon1 = parseCoord(depItem.longitude ?? depItem.lon)
    const lat2 = parseCoord(desItem.latitude ?? desItem.lat)
    const lon2 = parseCoord(desItem.longitude ?? desItem.lon)

    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
      return c.json({ error: 'Coordenadas inválidas' }, 500)
    }

    const distanceKm  = haversineKm(lat1, lon1, lat2, lon2)
    const distanceNm  = distanceKm * 0.539957
    const flightHours = distanceNm / speed
    const reserveH    = reserveMin / 60

    const hours   = Math.floor(flightHours)
    const minutes = Math.round((flightHours - hours) * 60)

    const tripFuel    = flightHours * burn
    const reserveFuel = reserveH * burn
    const taxiFuel    = burn * (10 / 60) // 10 min taxi
    const totalFuel   = tripFuel + reserveFuel + taxiFuel

    // Rota preferencial (não bloqueia se falhar)
    let routeStr = `${adep} DCT ${ades}`
    try {
      const routePref = await fetchAisweb(c, 'routesp', { adep, ades })
      routeStr = routePref?.item?.[0]?.rota ?? routeStr
    } catch {}

    // Alternados próximos ao destino + NOTAMs em paralelo
    const [rawAirports, notamDep, notamDes] = await Promise.all([
      cachedFetch(c, `geiloc-${Math.round(lat2 * 10)}-${Math.round(lon2 * 10)}`, 1800,
        () => fetchAisweb(c, 'rotaer', {})
      ),
      fetchAisweb(c, 'notam', { icaoCode: adep }),
      fetchAisweb(c, 'notam', { icaoCode: ades }),
    ])

    const airports   = normalizeAirportList(rawAirports, lat2, lon2)
    const alternates = airports
      .filter(a => a.icao !== ades && a.distKm < 150)
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 3)

    const toItems = (n: any) => Array.isArray(n?.item) ? n.item : (n?.item ? [n.item] : [])
    const notamAlerts = [...toItems(notamDep), ...toItems(notamDes)]
      .map((n: any) => n?.texto ?? n?.notam)
      .filter(Boolean)
      .slice(0, 5)

    // Briefing via Workers AI (não bloqueia se indisponível)
    let briefing = 'Briefing indisponível'
    try {
      const ai = await c.env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: [
          {
            role: 'system',
            content: 'Você é um despachante de voo brasileiro. Seja objetivo e use terminologia aeronáutica.',
          },
          {
            role: 'user',
            content:
              `Plano de voo\n` +
              `Origem: ${adep} | Destino: ${ades}\n` +
              `Distância: ${Math.round(distanceNm)} NM\n` +
              `Tempo estimado: ${hours}h${String(minutes).padStart(2, '0')}m\n` +
              `Combustível total: ${Math.round(totalFuel)} L\n` +
              `NOTAMs ativos: ${notamAlerts.length}`,
          },
        ],
      })
      briefing = ai.response
    } catch (aiErr) {
      log.warn('[flightplan] AI briefing indisponível:', aiErr)
    }

    return c.json({
      flightplan: {
        adep,
        ades,
        route:          routeStr,
        distance_nm:    Math.round(distanceNm),
        estimated_time: `${hours}h${String(minutes).padStart(2, '0')}m`,
        cruise_speed:   speed,
      },
      fuel: {
        burn_lh:        burn,
        trip_liters:    Math.round(tripFuel),
        reserve_liters: Math.round(reserveFuel),
        taxi_liters:    Math.round(taxiFuel),
        total_required: Math.round(totalFuel),
      },
      alternates: alternates.map(a => ({
        icao:        a.icao,
        name:        a.name,
        distance_km: a.distKm,
      })),
      notam_alerts: notamAlerts,
      briefing,
    })
  } catch (e: any) {
    log.error(`[flightplan] ${adep}→${ades}:`, e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ─── 404 ──────────────────────────────────────────────────────────────────────

app.notFound((c) =>
  c.json({
    error: 'Rota não encontrada',
    path:  c.req.path,
    available: [
      'GET  /api/weather/:icao',
      'GET  /api/notam/:icao',
      'GET  /api/charts/:icao',
      'GET  /api/rotaer?adep=&ades=',
      'GET  /api/routes?adep=&ades=',
      'GET  /api/solar/:icao',
      'POST /api/flight-calculations',
      'GET  /api/flightplan?adep=&ades=',
      'GET  /api/nearest?lat=&lon=',
      'GET  /api/geiloc/nearby?lat=&lon=',
    ],
  }, 404)
)

// ─── Exports (fetch + cron prefetch) ─────────────────────────────────────────

const PREFETCH_ICAOS = ['SBGR', 'SBSP', 'SBRJ', 'SBKP']
const WORKER_URL     = 'https://api-workers.sharebrasil.workers.dev'

export default {
  fetch: app.fetch,

  async scheduled(_event: any, _env: Bindings, ctx: ExecutionContext) {
    // Aquece o cache dos principais aeródromos a cada cron
    const tasks = PREFETCH_ICAOS.flatMap(icao => [
      fetch(`${WORKER_URL}/api/weather/${icao}`),
      fetch(`${WORKER_URL}/api/notam/${icao}`),
    ])
    ctx.waitUntil(Promise.allSettled(tasks))
  },
}
