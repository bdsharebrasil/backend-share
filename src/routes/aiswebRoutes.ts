import { codigoAerodromoValido } from "../lib/aerodromo"
import { Hono, Context } from "hono"
import { cachedFetch, checkRateLimit, clientIp } from "../lib/cache"
import { fetchAisweb } from "../lib/aiswebClient"
import { haversineKm, numericValue, parseCoord } from "../lib/geo"

type Bindings = { AISWEB_API_KEY: string; AISWEB_API_PASS: string; CACHE_KV: KVNamespace; RATE_LIMITER: DurableObjectNamespace; SHARE_DB: D1Database }
type Variables = Record<string, never>
interface Airport { icao: string; name: string; lat: number; lon: number; distKm: number }

export const aiswebRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const log = { debug: (...args: unknown[]) => console.debug(...args), warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) }
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
  const source = data?.routesp ?? data?.routes ?? data?.rotas ?? data
  const candidates = typeof source === 'string' ? [source] : collectionItems(source)
  return candidates
    .map((item: any) => {
      const nested = item?.route ?? item?.rota ?? item?.route_preferencial ?? item?.rota_preferencial
      const route = typeof item === 'string' ? item : typeof nested === 'string' ? nested : typeof nested?.route === 'string' ? nested.route : typeof nested?.rota === 'string' ? nested.rota : item?.Route ?? item?.ROUTE ?? ''
      return {
        route: String(route).replace(/\s+/g, ' ').trim(),
        level: item?.nivel ?? item?.level ?? item?.fl ?? '',
        type: item?.tipo ?? item?.type ?? '',
        remarks: item?.rmk ?? item?.obs ?? item?.remarks ?? '',
      }
    })
    .filter(item => item.route)
    .map(item => ({ ...item, adep, ades }))
}

/**
 * Aplica rate limit por IP às rotas públicas (sem autenticação) que fazem
 * proxy da AISWEB. Protege sua cota da API do DECEA contra abuso vindo de
 * qualquer origem, já que o CORS dessas rotas é aberto por padrão.
 */
async function requireAiswebRateLimit(c: Context<{ Bindings: Bindings; Variables: Variables }>): Promise<boolean> {
  return checkRateLimit(c, `aisweb-public:${clientIp(c)}`, 60)
}

// ─── Geo Helpers ──────────────────────────────────────────────────────────────

function metarNumber(value: string): number | null {
  if (!value) return null
  const normalized = value.startsWith('M') ? `-${value.slice(1)}` : value
  const number = Number(normalized)
  return Number.isFinite(number) ? number : null
}

function decodeMetar(metar: string): Record<string, any> {
  const tokens = metar.trim().split(/\s+/).filter(Boolean)
  const fenomenos = tokens.filter(token => /^[-+]?(?:VC)?(?:MI|BC|PR|DR|BL|SH|TS)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP)$/.test(token))
  const weatherCondition = fenomenos.some(token => /TS/.test(token)) ? 'storm' : fenomenos.some(token => /RA|DZ/.test(token)) ? 'rain' : fenomenos.some(token => /SN|SG|IC|PL|GR|GS/.test(token)) ? 'snow' : tokens.some(token => /^(?:BKN|OVC)/.test(token)) ? 'cloudy' : 'clear'
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
    weather_condition: weatherCondition,
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
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
    list.push({ icao, name: item?.nome ?? item?.name ?? icao, lat, lon, distKm: Math.round(haversineKm(userLat, userLon, lat, lon)) })
  }
  return list
}

function normalizeAirportKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
}

function airportField(source: Record<string, any>, aliases: string[]): any {
  const keys = new Set(aliases.map(normalizeAirportKey))
  const key = Object.keys(source).find((candidate) => keys.has(normalizeAirportKey(candidate)))
  return key ? source[key] : null
}

function airportCollection(value: any): any[] {
  if (value == null || value === '') return []
  if (Array.isArray(value)) return value
  return [value]
}

function normalizeRotaerAirport(item: any, fallbackIcao = ''): Record<string, any> {
  const source = item?.aerodrome ?? item?.airport ?? item?.rotaer ?? item ?? {}
  const rawCoordinates = source.coordinates ?? source.coordenadas
  const lat = parseCoord(rawCoordinates?.lat ?? rawCoordinates?.latitude ?? source.latitude ?? source.lat)
  const lng = parseCoord(rawCoordinates?.lng ?? rawCoordinates?.lon ?? rawCoordinates?.longitude ?? source.longitude ?? source.lng ?? source.lon)
  const runways = source.runways ?? source.pistas ?? source.runway ?? []
  const frequencies = source.frequencies ?? source.frequencias ?? source.frequency ?? []
  const restrictions = source.restrictions ?? source.restricoes ?? source.observacoes ?? []
  const operational = {
    opea: airportField(source, ['opea', 'procedimentos_operacionais', 'operational_procedures', 'operational_area']),
    obstacles: airportCollection(airportField(source, ['obstaculos', 'obstacles', 'obstacle'])),
    other_lighting: airportField(source, ['outras_iluminacoes', 'other_lighting', 'other_lighting_systems', 'other_lights']),
    secondary_power: airportField(source, ['fonte_de_energia_secundaria', 'energia_secundaria', 'secondary_power', 'secondary_energy']),
    local_regulations: airportField(source, ['regulamentos_locais_de_aerodromo', 'regulamentos_locais', 'local_regulations', 'local_rules']),
  }
  return {
    ...source,
    icao: rotaerIcao(source) || fallbackIcao,
    name: source.name ?? source.nome ?? source.designacao ?? source.AerodromeName ?? fallbackIcao,
    city: source.city ?? source.cidade ?? source.municipio,
    state: source.state ?? source.uf ?? source.estado,
    elevation: source.elevation ?? source.elevacao ?? source.altitude ?? source.Elev,
    coordinates: lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat: Number(lat), lng: Number(lng) } : null,
    runways: Array.isArray(runways) ? runways : [runways].filter(Boolean),
    frequencies: Array.isArray(frequencies) ? frequencies : [frequencies].filter(Boolean),
    restrictions: Array.isArray(restrictions) ? restrictions : [restrictions].filter(Boolean),
    operational,
    opea: operational.opea,
    obstacles: operational.obstacles,
    other_lighting: operational.other_lighting,
    secondary_power: operational.secondary_power,
    local_regulations: operational.local_regulations,
    contact: source.contact ?? source.contato ?? {
      phone: source.phone ?? source.telefone ?? source.tel,
      email: source.email,
    },
    raw_data: source,
  }
}
async function enriquecerRotaerComPublicacao(c: Context<{ Bindings: Bindings; Variables: Variables }>, airport: Record<string, any>, icao: string): Promise<Record<string, any>> {
  try {
    const publication = await cachedFetch(c, `pub-ad-${icao}`, 3600, () => fetchAisweb(c, 'pub', { icaoCode: icao }))
    const publicationItems = collectionItems(publication)
    const publicationItem = publicationItems.find((item) => rotaerIcao(item) === icao) ?? publicationItems[0]
    const merged = publicationItem && typeof publicationItem === 'object' ? { ...(airport.raw_data || airport), ...publicationItem } : airport.raw_data || airport
    const enriched = normalizeRotaerAirport(merged, icao)
    return { ...enriched, publications: publication, raw_data: { rotaer: airport.raw_data || airport, pub: publication } }
  } catch (error: any) {
    log.warn(`[pub] publicação AIP indisponível para ${icao}: ${error.message}`)
    return airport
  }
}

async function fetchRotaerByIcao(c: Context<{ Bindings: Bindings; Variables: Variables }>, icao: string): Promise<any> {
  const normalizedIcao = icao.trim().toUpperCase()
  try {
    const detail = await cachedFetch(c, `rotaer-detail-${normalizedIcao}`, 1800,
      () => fetchAisweb(c, 'rotaer', { icaoCode: normalizedIcao }))
    const detailItem = rotaerItems(detail).find(item => rotaerIcao(item) === normalizedIcao) ?? rotaerItems(detail)[0]
    if (detailItem) return enriquecerRotaerComPublicacao(c, normalizeRotaerAirport(detailItem, normalizedIcao), normalizedIcao)
  } catch (error: any) {
    log.warn(`[rotaer] ficha detalhada indisponível para ${normalizedIcao}: ${error.message}`)
  }
  const data = await cachedFetch(c, 'rotaer-all', 1800, () => fetchAisweb(c, 'rotaer', {}))
  const airport = rotaerItems(data).find(item => rotaerIcao(item) === normalizedIcao)
  if (!airport) throw new Error(`Aeródromo ${normalizedIcao} não encontrado no ROTAER/AISWEB`)
  return enriquecerRotaerComPublicacao(c, normalizeRotaerAirport(airport, normalizedIcao), normalizedIcao)
}

// ─── Nearby helper: tenta geiloc (4s), fallback para rotaer-all ──────────────

async function fetchNearby(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
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


aiswebRoutes.get('/api/weather/:icao', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const icao = c.req.param('icao').toUpperCase()
  try {
    const data = await cachedFetch(c, `metar-${icao}`, 300, () => fetchAisweb(c, 'met', { icaoCode: icao }))
    return c.json(normalizeMet(data, icao))
  } catch (e: any) {
    log.error(`[weather] ${icao}:`, e.message)
    throw e
  }
})

aiswebRoutes.get('/api/notam/:icao', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const icao = c.req.param('icao').trim().toUpperCase()
  if (!codigoAerodromoValido(icao)) return c.json({ error: 'ICAO inválido' }, 400)
  try {
    const data = await cachedFetch(c, `notam-${icao}`, 600, () => fetchAisweb(c, 'notam', { icaoCode: icao }))
    return c.json({ icao, notams: normalizeNotamItems(data, icao), fetched_at: new Date().toISOString(), source: 'AISWEB/DECEA' })
  } catch (e: any) {
    log.error(`[notam] ${icao}:`, e.message)
    return c.json({ icao, notams: [], error: e.message }, 502)
  }
})

aiswebRoutes.get('/api/charts/preview', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const rawUrl = c.req.query('url')
  if (!rawUrl) return c.json({ error: 'url é obrigatória' }, 400)
  let chartUrl: URL
  try {
    chartUrl = new URL(rawUrl)
  } catch {
    return c.json({ error: 'URL da carta inválida' }, 400)
  }
  if (chartUrl.protocol !== 'https:' || chartUrl.hostname !== 'aisweb.decea.mil.br') return c.json({ error: 'Domínio da carta não autorizado' }, 400)
  try {
    const response = await fetch(chartUrl)
    if (!response.ok || !response.body) return c.json({ error: `Não foi possível carregar a carta (${response.status})` }, 502)
    const headers = new Headers()
    headers.set('Content-Type', response.headers.get('content-type') || 'application/pdf')
    headers.set('Content-Disposition', c.req.query('download') === '1' ? 'attachment' : 'inline')
    headers.set('Cache-Control', 'private, max-age=300')
    return new Response(response.body, { status: 200, headers })
  } catch (e: any) {
    log.error('[charts/preview]:', e.message)
    return c.json({ error: 'Não foi possível carregar a carta' }, 502)
  }
})

aiswebRoutes.get('/api/charts/:icao', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const icao = c.req.param('icao').toUpperCase()
  const especie = c.req.query('especie'), tipo = c.req.query('tipo')
  try {
    const data = await cachedFetch(c, `charts-${icao}-${especie ?? ''}-${tipo ?? ''}`, 3600,
      () => fetchAisweb(c, 'cartas', { icaoCode: icao, especie, tipo }))
    return c.json(normalizeCharts(data))
  } catch (e: any) {
    throw e
  }
})

async function getRotaer(c: Context<{ Bindings: Bindings; Variables: Variables }>, icaoParam?: string) {
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
    throw e
  }
}

aiswebRoutes.get('/api/rotaer', (c) => getRotaer(c))
aiswebRoutes.get('/api/rotaer/:icao', (c) => getRotaer(c, c.req.param('icao')))

aiswebRoutes.get('/api/routes', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const adep = c.req.query('adep')?.trim().toUpperCase()
  const ades = c.req.query('ades')?.trim().toUpperCase()
  if (!codigoAerodromoValido(adep) || !codigoAerodromoValido(ades)) return c.json({ error: 'Informe origem e destino com quatro letras ou números.' }, 400)
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

aiswebRoutes.get('/api/solar/:icao', async (c) => {
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
    throw e
  }
})


aiswebRoutes.get('/api/nearest', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const lat = parseFloat(c.req.query('lat') ?? ''), lon = parseFloat(c.req.query('lon') ?? '')
  if (isNaN(lat) || isNaN(lon)) return c.json({ error: 'lat/lon inválidos' }, 400)
  try {
    const airports = (await fetchNearby(c, lat, lon)).sort((a, b) => a.distKm - b.distKm)
    return c.json({ nearest: airports[0] ?? null, alternates: airports.slice(0, 5) })
  } catch (e: any) {
    throw e
  }
})

aiswebRoutes.get('/api/geiloc/nearby', async (c) => {
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
    throw e
  }
})

// ─── /api/flightplan ─────────────────────────────────────────────────────────

aiswebRoutes.get('/api/flightplan', async (c) => {
  if (!(await requireAiswebRateLimit(c))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  const adep = c.req.query('adep')?.trim().toUpperCase()
  const ades = c.req.query('ades')?.trim().toUpperCase()
  const aircraftId = c.req.query('aeronave_id') || c.req.query('aircraft_id')
  const requestedSpeed = numericValue(c.req.query('speed'))
  const requestedBurn = numericValue(c.req.query('fuel_burn'))
  const reserveMin = numericValue(c.req.query('reserve')) || 45

  if (!codigoAerodromoValido(adep) || !codigoAerodromoValido(ades)) return c.json({ error: 'Informe origem e destino com quatro letras ou números.' }, 400)

  try {
    let aircraftData: any = null
    if (aircraftId) {
      try {
        aircraftData = await c.env.SHARE_DB.prepare(`SELECT a.*, p.categoria AS performance_categoria, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.teto_servico_ft AS performance_teto_servico_ft, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm
          FROM aeronave a
          LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1))
          WHERE a.id = ?1`).bind(aircraftId).first()
      } catch (error: any) {
        log.warn(`[flightplan] performance_aeronave indisponível: ${error.message}`)
        aircraftData = await c.env.SHARE_DB.prepare('SELECT * FROM aeronave WHERE id = ?1').bind(aircraftId).first()
      }
    }
    const speed = requestedSpeed || numericValue(aircraftData?.performance_velocidade_cruzeiro_kt) || numericValue(aircraftData?.velocidade_cruzeiro) || 120
    const burn = requestedBurn || numericValue(aircraftData?.consumo_combustivel) || 32

    const [depItem, desItem] = await Promise.all([
      fetchRotaerByIcao(c, adep),
      fetchRotaerByIcao(c, ades),
    ])

    const lat1 = parseCoord(depItem.coordinates?.lat ?? depItem.latitude ?? depItem.lat)
    const lon1 = parseCoord(depItem.coordinates?.lng ?? depItem.longitude ?? depItem.lng ?? depItem.lon)
    const lat2 = parseCoord(desItem.coordinates?.lat ?? desItem.latitude ?? desItem.lat)
    const lon2 = parseCoord(desItem.coordinates?.lng ?? desItem.longitude ?? desItem.lng ?? desItem.lon)
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null || Math.abs(lat1) > 90 || Math.abs(lat2) > 90 || Math.abs(lon1) > 180 || Math.abs(lon2) > 180)
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

    // A rota, distância e combustível continuam úteis mesmo se serviços
    // acessórios (geilócus/NOTAM) estiverem indisponíveis.
    const [alternates, notamDep, notamDes] = await Promise.all([
      fetchNearby(c, lat2, lon2).catch((error: any) => {
        log.warn(`[flightplan] alternados indisponíveis: ${error.message}`)
        return [] as Airport[]
      }),
      cachedFetch(c, `notam-${adep}`, 600, () => fetchAisweb(c, 'notam', { icaoCode: adep })).catch((error: any) => {
        log.warn(`[flightplan] NOTAM ${adep} indisponível: ${error.message}`)
        return []
      }),
      cachedFetch(c, `notam-${ades}`, 600, () => fetchAisweb(c, 'notam', { icaoCode: ades })).catch((error: any) => {
        log.warn(`[flightplan] NOTAM ${ades} indisponível: ${error.message}`)
        return []
      }),
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
      performance: aircraftData ? {
        source: aircraftData.performance_velocidade_cruzeiro_kt || aircraftData.performance_categoria ? 'performance_aeronave' : 'aeronave',
        fabricante: aircraftData.fabricante ?? null,
        modelo: aircraftData.modelo ?? null,
        tipo_aeronave: aircraftData.tipo_aeronave ?? null,
        velocidade_cruzeiro_kt: numericValue(aircraftData.performance_velocidade_cruzeiro_kt) || numericValue(aircraftData.velocidade_cruzeiro) || speed,
        consumo_combustivel_lh: numericValue(aircraftData.consumo_combustivel) || burn,
        categoria: aircraftData.performance_categoria ?? null,
        teto_servico_ft: aircraftData.performance_teto_servico_ft ?? null,
        taxa_subida_fpm: aircraftData.performance_taxa_subida_fpm ?? null,
        taxa_descida_fpm: aircraftData.performance_taxa_descida_fpm ?? null,
        designador_icao: aircraftData.designador_icao ?? null,
        esteira_turbulencia: aircraftData.esteira_turbulencia ?? null,
        equipamentos_icao: aircraftData.equipamentos_icao ?? null,
        vigilancia_icao: aircraftData.vigilancia_icao ?? null,
        pbn_icao: aircraftData.pbn_icao ?? null,
        autonomia_padrao_minutos: aircraftData.autonomia_padrao_minutos ?? null,
        cor_marcas: aircraftData.cor_marcas ?? null,
      } : null,
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
    throw e
  }
})
