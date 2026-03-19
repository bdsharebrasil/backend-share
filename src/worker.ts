import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { XMLParser } from 'fast-xml-parser'

type Bindings = {
  AISWEB_API_KEY: string
  AISWEB_API_PASS: string
  CACHE_KV: KVNamespace
  AI: any
}

const app = new Hono<{ Bindings: Bindings }>()

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ['item','notam','carta','sol'].includes(name),
})

app.use('*', cors())

const AISWEB_BASE_URL = 'https://api.decea.mil.br/aisweb/'

const AREA_NODE_MAP: Record<string,string> = {
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

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function cachedFetch(
  c: Context<{ Bindings: Bindings }>,
  key: string,
  ttl: number,
  fetcher: () => Promise<any>
) {
  const hit = await c.env.CACHE_KV.get(key)
  if (hit) return JSON.parse(hit)

  const data = await fetcher()
  await c.env.CACHE_KV.put(key, JSON.stringify(data), { expirationTtl: ttl })
  return data
}

// ─── AISWEB core fetch ────────────────────────────────────────────────────────

const fetchAisweb = async (
  c: Context<{ Bindings: Bindings }>,
  area: string,
  params: Record<string, string | undefined>
) => {
  const apiKey  = c.env.AISWEB_API_KEY?.trim()
  const apiPass = c.env.AISWEB_API_PASS?.trim()

  if (!apiKey || !apiPass) throw new Error('Credenciais AISWEB ausentes')

  const parts: string[] = [
    `apiKey=${apiKey}`,
    `apiPass=${apiPass}`,
    `area=${area}`,
  ]

  Object.entries(params).forEach(([k, v]) => { if (v) parts.push(`${k}=${v}`) })

  const url = `${AISWEB_BASE_URL}?${parts.join('&')}`

  console.log(`[aisweb] → area=${area} params=${JSON.stringify(params)}`)

  const res  = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/xml,application/xml,*/*' },
  })

  const text = await res.text()

  if (!res.ok)  throw new Error(`HTTP ${res.status}`)
  if (!text)    throw new Error('Resposta vazia da AISWEB')

  // Se já for JSON válido, devolver direto
  try { return JSON.parse(text) } catch {}

  // Parse XML
  const parsed  = parser.parse(text)
  const aisweb  = parsed['aisweb'] ?? parsed
  const node    = AREA_NODE_MAP[area]

  // ── Validação + log antes de retornar ──────────────────────────────────────
  if (node) {
    if (!aisweb[node]) {
      console.warn(
        `[aisweb] Node "${node}" ausente na resposta para area="${area}". ` +
        `Chaves disponíveis: [${Object.keys(aisweb).join(', ')}]. ` +
        `XML bruto (300 chars): ${text.slice(0, 300)}`
      )
      // Retorna objeto vazio tipado para o node esperado, evita vazar estrutura inteira
      return {}
    }

    console.log(`[aisweb] ✓ area=${area} node="${node}" encontrado`)
    return aisweb[node]
  }

  // Área sem node mapeado: retorna aisweb inteiro
  console.warn(`[aisweb] Área "${area}" sem mapeamento de node — retornando objeto raiz`)
  return aisweb
}

// ─── Geo helpers ──────────────────────────────────────────────────────────────

function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
) {
  const R    = 6371
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

  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s)

  const gms = s.match(/^(\d{2,3})(\d{2})(\d{2})([NSEW])$/i)
  if (gms) {
    const dec = parseInt(gms[1]) + parseInt(gms[2]) / 60 + parseInt(gms[3]) / 3600
    return gms[4].toUpperCase() === 'S' || gms[4].toUpperCase() === 'W' ? -dec : dec
  }

  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

interface Airport {
  icao:    string
  name:    string
  lat:     number
  lon:     number
  distKm:  number
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

// ── WEATHER (METAR) ──────────────────────────────────────────────────────────
app.get('/api/weather/:icao', async (c) => {
  const icao = c.req.param('icao').toUpperCase()

  try {
    const data = await cachedFetch(
      c,
      `metar-${icao}`,
      300, // 5 min
      () => fetchAisweb(c, 'met', { icaoCode: icao })
    )

    // Normaliza a estrutura para o frontend sempre receber o mesmo shape:
    // { metar: string, taf: string, loc: string }
    const normalized = normalizeMet(data, icao)

    return c.json(normalized)
  } catch (err: any) {
    console.error(`[weather] ${icao}:`, err.message)
    return c.json({ error: err.message }, 500)
  }
})

/**
 * Normaliza a resposta do nó "met" da AISWEB para um shape previsível.
 * O XML da DECEA pode retornar a string METAR em vários níveis de aninhamento.
 *
 * Shape garantido:
 *   { loc: string, metar: string, taf: string }
 */
function normalizeMet(data: any, icao: string): Record<string, any> {
  if (!data || typeof data !== 'object') {
    return { loc: icao, metar: '', taf: '' }
  }

  // Casos observados na AISWEB:
  // 1. data = { metar: { loc:'SBSP', metar:'SBSP 191800Z...' }, taf:{...} }  (mais comum)
  // 2. data = { metar: 'SBSP 191800Z ...', taf: '...' }                      (simplificado)
  // 3. data = 'SBSP 191800Z ...'                                              (string direta — raro)

  const metarStr =
    (typeof data.metar === 'string'        ? data.metar              : null) ??
    (typeof data.metar?.metar === 'string' ? data.metar.metar        : null) ??
    (typeof data.metar?.raw === 'string'   ? data.metar.raw          : null) ??
    ''

  const tafStr =
    (typeof data.taf === 'string'        ? data.taf              : null) ??
    (typeof data.taf?.taf === 'string'   ? data.taf.taf          : null) ??
    (typeof data.taf?.raw === 'string'   ? data.taf.raw          : null) ??
    ''

  const loc =
    data.metar?.loc ??
    data.loc        ??
    icao

  return {
    loc,
    metar: metarStr,
    taf:   tafStr,
    // Mantém dados brutos para debug em dev
    _raw: data,
  }
}

// ── NOTAM ────────────────────────────────────────────────────────────────────
app.get('/api/notam/:icao', async (c) => {
  const icao = c.req.param('icao').toUpperCase()

  try {
    const data = await cachedFetch(
      c,
      `notam-${icao}`,
      600, // 10 min
      () => fetchAisweb(c, 'notam', { icaoCode: icao })
    )

    return c.json(data)
  } catch (err: any) {
    console.error(`[notam] ${icao}:`, err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ── CARTAS (CHARTS) ──────────────────────────────────────────────────────────
app.get('/api/charts/:icao', async (c) => {
  const icao    = c.req.param('icao').toUpperCase()
  const especie = c.req.query('especie')
  const tipo    = c.req.query('tipo')

  try {
    const params: Record<string, string | undefined> = { icaoCode: icao }
    if (especie) params.especie = especie
    if (tipo)    params.tipo    = tipo

    const data = await cachedFetch(
      c,
      `charts-${icao}-${especie || ''}-${tipo || ''}`,
      3600, // 1h — cartas mudam pouco
      () => fetchAisweb(c, 'cartas', params)
    )

    return c.json(data)
  } catch (err: any) {
    console.error(`[charts] ${icao}:`, err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ── ROTAER (dados do aeródromo) ───────────────────────────────────────────────
app.get('/api/rotaer', async (c) => {
  const adep = c.req.query('adep')?.toUpperCase()
  const ades = c.req.query('ades')?.toUpperCase()

  try {
    const params: Record<string, string | undefined> = {}
    if (adep) params.adep = adep
    if (ades) params.ades = ades

    const cacheKey = adep && ades ? `rotaer-${adep}-${ades}`
                   : adep         ? `rotaer-${adep}`
                   : ades         ? `rotaer-${ades}`
                   : 'rotaer-all'

    const data = await cachedFetch(
      c,
      cacheKey,
      1800, // 30 min
      () => fetchAisweb(c, 'rotaer', params)
    )

    return c.json(data)
  } catch (err: any) {
    console.error(`[rotaer] adep=${adep} ades=${ades}:`, err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ── ROTAS PREFERENCIAIS (/api/routes) ────────────────────────────────────────
// Equivalente ao endpoint "routesp" da AISWEB.
// Frontend chama: /api/routes?adep=SBSP&ades=SBBR
app.get('/api/routes', async (c) => {
  const adep = c.req.query('adep')?.toUpperCase()
  const ades = c.req.query('ades')?.toUpperCase()

  if (!adep || !ades) {
    return c.json({ error: 'adep e ades são obrigatórios' }, 400)
  }

  try {
    const data = await cachedFetch(
      c,
      `routes-${adep}-${ades}`,
      3600, // 1h — rotas mudam raramente
      () => fetchAisweb(c, 'routesp', { adep, ades })
    )

    // Normaliza: garante array de rotas mesmo quando AISWEB retorna objeto único
    const items = data?.item
      ? (Array.isArray(data.item) ? data.item : [data.item])
      : []

    return c.json({
      adep,
      ades,
      routes: items.map((r: any) => ({
        route:    r?.rota    ?? r?.route    ?? '',
        level:    r?.nivel   ?? r?.level    ?? '',
        remarks:  r?.rmk     ?? r?.remarks  ?? '',
      })),
    })
  } catch (err: any) {
    console.error(`[routes] ${adep}→${ades}:`, err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ── SOLAR / PÔR DO SOL (/api/solar/:icao) ─────────────────────────────────────
// Usa a área "sol" da AISWEB que retorna horários de nascer/pôr do sol.
app.get('/api/solar/:icao', async (c) => {
  const icao = c.req.param('icao').toUpperCase()
  const date = c.req.query('date') // formato YYYYMMDD; se omitido, usa hoje

  try {
    const params: Record<string, string | undefined> = { icaoCode: icao }
    if (date) params.date = date

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const cacheKey = `solar-${icao}-${date ?? today}`

    const data = await cachedFetch(
      c,
      cacheKey,
      86400, // 24h — dados solares não mudam no dia
      () => fetchAisweb(c, 'sol', params)
    )

    // Normaliza shape: AISWEB retorna array de dias (isArray: ['sol'])
    const days = Array.isArray(data) ? data : (data?.sol ?? [data])

    const normalized = days.map((d: any) => ({
      date:    d?.date   ?? d?.data   ?? '',
      sunrise: d?.nascer ?? d?.sunrise ?? '',
      sunset:  d?.poente ?? d?.sunset  ?? '',
      civil_twilight_begin: d?.crepusculo_manha ?? '',
      civil_twilight_end:   d?.crepusculo_tarde ?? '',
    }))

    return c.json({ icao, solar: normalized })
  } catch (err: any) {
    console.error(`[solar] ${icao}:`, err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ── FLIGHT CALCULATIONS (/api/flight-calculations) ───────────────────────────
// Endpoint de cálculos de voo sem necessidade de consulta à AISWEB.
// Recebe distância/velocidade e devolve tempo, combustível e vento corrigido.
app.post('/api/flight-calculations', async (c) => {
  try {
    const body = await c.req.json()

    const {
      distance_nm,
      speed_kts   = 120,
      fuel_burn   = 32,    // litros/hora
      reserve_min = 45,
      wind_kts    = 0,     // vento de frente positivo, cauda negativo
      taxi_min    = 10,
    } = body

    if (!distance_nm || isNaN(Number(distance_nm))) {
      return c.json({ error: 'distance_nm é obrigatório' }, 400)
    }

    const dist     = Number(distance_nm)
    const gs       = Math.max(Number(speed_kts) + Number(wind_kts), 1) // ground speed
    const flightH  = dist / gs
    const reserveH = Number(reserve_min) / 60
    const taxiH    = Number(taxi_min)    / 60

    const tripFuel    = flightH  * Number(fuel_burn)
    const reserveFuel = reserveH * Number(fuel_burn)
    const taxiFuel    = taxiH    * Number(fuel_burn)
    const totalFuel   = tripFuel + reserveFuel + taxiFuel

    const totalMin = Math.round(flightH * 60)
    const hours    = Math.floor(totalMin / 60)
    const minutes  = totalMin % 60

    return c.json({
      inputs: { distance_nm: dist, speed_kts, fuel_burn, reserve_min, wind_kts, taxi_min },
      results: {
        ground_speed_kts:  Math.round(gs),
        flight_time:       `${hours}h${String(minutes).padStart(2, '0')}m`,
        flight_minutes:    totalMin,
        trip_fuel_liters:   Math.round(tripFuel),
        reserve_fuel_liters: Math.round(reserveFuel),
        taxi_fuel_liters:   Math.round(taxiFuel),
        total_fuel_liters:  Math.round(totalFuel),
      },
    })
  } catch (err: any) {
    console.error('[flight-calculations]:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ── NEAREST AIRPORT ───────────────────────────────────────────────────────────
app.get('/api/nearest', async (c) => {
  const lat = parseFloat(c.req.query('lat') || '')
  const lon = parseFloat(c.req.query('lon') || '')

  if (isNaN(lat) || isNaN(lon)) {
    return c.json({ error: 'lat/lon inválidos' }, 400)
  }

  try {
    const raw = await cachedFetch(
      c,
      'rotaer-all',
      1800,
      () => fetchAisweb(c, 'rotaer', {})
    )

    const airports = normalizeAirportList(raw, lat, lon)
    airports.sort((a, b) => a.distKm - b.distKm)

    return c.json({
      nearest:   airports[0],
      alternates: airports.slice(0, 5),
    })
  } catch (err: any) {
    console.error('[nearest]:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ── GEILOC NEARBY ─────────────────────────────────────────────────────────────
app.get('/api/geiloc/nearby', async (c) => {
  const lat = parseFloat(c.req.query('lat') || '')
  const lon = parseFloat(c.req.query('lon') || '')

  if (isNaN(lat) || isNaN(lon)) {
    return c.json({ error: 'lat/lon inválidos' }, 400)
  }

  try {
    const raw = await cachedFetch(
      c,
      `geiloc-${Math.round(lat * 10)}-${Math.round(lon * 10)}`,
      1800,
      () => fetchAisweb(c, 'rotaer', {})
    )

    const airports = normalizeAirportList(raw, lat, lon)
    airports.sort((a, b) => a.distKm - b.distKm)

    return c.json({
      alternates: airports.filter(a => a.distKm < 200).slice(0, 10),
    })
  } catch (err: any) {
    console.error('[geiloc/nearby]:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ── FLIGHT PLAN ───────────────────────────────────────────────────────────────
app.get('/api/flightplan', async (c) => {
  const adep       = c.req.query('adep')?.toUpperCase()
  const ades       = c.req.query('ades')?.toUpperCase()
  const speed      = parseInt(c.req.query('speed')      ?? '120')
  const burn       = parseFloat(c.req.query('fuel_burn') ?? '32')
  const reserveMin = parseInt(c.req.query('reserve')    ?? '45')

  if (!adep || !ades) {
    return c.json({ error: 'adep e ades são obrigatórios' }, 400)
  }

  try {
    const [dep, des] = await Promise.all([
      fetchAisweb(c, 'rotaer', { icaoCode: adep }),
      fetchAisweb(c, 'rotaer', { icaoCode: ades }),
    ])

    const depItem = dep?.item?.[0]
    const desItem = des?.item?.[0]

    if (!depItem || !desItem) {
      return c.json({ error: 'Aeródromo não encontrado' }, 404)
    }

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
    const taxiFuel    = burn * 0.1
    const totalFuel   = tripFuel + reserveFuel + taxiFuel

    // Rota preferencial
    let routePref = null
    try {
      routePref = await fetchAisweb(c, 'routesp', { adep, ades })
    } catch {}
    const route = routePref?.item?.[0]?.rota ?? `${adep} DCT ${ades}`

    // Alternados próximos ao destino
    const rawAirports = await cachedFetch(
      c,
      `geiloc-${Math.round(lat2 * 10)}-${Math.round(lon2 * 10)}`,
      1800,
      () => fetchAisweb(c, 'rotaer', {})
    )
    const airports  = normalizeAirportList(rawAirports, lat2, lon2)
    const alternates = airports
      .filter(a => a.icao !== ades && a.distKm < 150)
      .slice(0, 3)

    // NOTAMs de origem e destino em paralelo
    const [notamDep, notamDes] = await Promise.all([
      fetchAisweb(c, 'notam', { icaoCode: adep }),
      fetchAisweb(c, 'notam', { icaoCode: ades }),
    ])

    const depItems = Array.isArray(notamDep?.item) ? notamDep.item : [notamDep?.item]
    const desItems = Array.isArray(notamDes?.item) ? notamDes.item : [notamDes?.item]

    const notamAlerts = [...depItems, ...desItems]
      .map(n => n?.texto ?? n?.notam)
      .filter(Boolean)
      .slice(0, 5)

    // Briefing via Workers AI (opcional)
    let briefing = 'Briefing indisponível'
    try {
      const ai = await c.env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: [
          { role: 'system', content: 'Você é um despachante de voo brasileiro. Seja objetivo e use terminologia aeronáutica.' },
          {
            role: 'user',
            content:
              `Plano de voo\n` +
              `Origem: ${adep}\n` +
              `Destino: ${ades}\n` +
              `Distância: ${Math.round(distanceNm)} NM\n` +
              `Tempo estimado: ${hours}h${String(minutes).padStart(2, '0')}m\n` +
              `Combustível total: ${Math.round(totalFuel)} L`,
          },
        ],
      })
      briefing = ai.response
    } catch (aiErr) {
      console.warn('[flightplan] AI briefing indisponível:', aiErr)
    }

    return c.json({
      flightplan: {
        adep,
        ades,
        route,
        distance_nm:    Math.round(distanceNm),
        estimated_time: `${hours}h${String(minutes).padStart(2, '0')}m`,
        cruise_speed:   speed,
      },
      fuel: {
        burn_lh:          burn,
        trip_liters:      Math.round(tripFuel),
        reserve_liters:   Math.round(reserveFuel),
        taxi_liters:      Math.round(taxiFuel),
        total_required:   Math.round(totalFuel),
      },
      alternates: alternates.map(a => ({
        icao:        a.icao,
        name:        a.name,
        distance_km: a.distKm,
      })),
      notam_alerts: notamAlerts,
      briefing,
    })
  } catch (err: any) {
    console.error(`[flightplan] ${adep}→${ades}:`, err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ─── 404 catch-all ────────────────────────────────────────────────────────────
app.notFound((c) => {
  const available = [
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
  ]
  return c.json({
    error:     'Rota não encontrada',
    path:      c.req.path,
    available,
  }, 404)
})

export default { fetch: app.fetch }
