import { Hono, type Context } from 'hono'
import { checkRateLimit, clientIp } from '../lib/cache'

type Bindings = {
  RATE_LIMITER: DurableObjectNamespace
}

type Layer = { name: string; title: string; family: 'alta' | 'baixa' }
type Catalog = { layers: Layer[]; supports3857: boolean; fetchedAt: string }

const GEOAISWEB_WMS = 'https://geoaisweb.decea.mil.br/geoserver/wms'
const CAPABILITIES_CACHE = 'https://worker-cache.share-brasil.invalid/geoaisweb/capabilities'
const MAX_ZOOM = 18
const WORLD_HALF = 20037508.342789244
const TILE_CACHE_SECONDS = 300
const routes = new Hono<{ Bindings: Bindings }>()

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim()
}

export function parseCatalog(xml: string): Catalog {
  if (!/<(?:\w+:)?WMS_Capabilities\b|<(?:\w+:)?WMT_MS_Capabilities\b/i.test(xml)) {
    throw new Error('O serviço oficial não retornou um documento WMS GetCapabilities válido')
  }
  const layers: Layer[] = []
  const blocks = xml.match(/<(?:\w+:)?Layer(?:\s[^>]*)?>(?:(?!<(?:\w+:)?Layer\b)[\s\S])*?<\/(?:\w+:)?Layer>/gi) ?? []
  for (const block of blocks) {
    const name = decodeXml(block.match(/<(?:\w+:)?Name>([\s\S]*?)<\/(?:\w+:)?Name>/i)?.[1] ?? '')
    const title = decodeXml(block.match(/<(?:\w+:)?Title>([\s\S]*?)<\/(?:\w+:)?Title>/i)?.[1] ?? '')
    if (!name) continue
    const normalized = `${name} ${title}`.toUpperCase().replace(/[^A-Z0-9]/g, '')
    const family = normalized.includes('ENRCH') ? 'alta' : normalized.includes('ENRCL') ? 'baixa' : null
    if (family && !layers.some(layer => layer.name === name)) layers.push({ name, title: title || name, family })
  }
  const supports3857 = /<(?:\w+:)?SRS>\s*EPSG:3857\s*<\/(?:\w+:)?SRS>|<(?:\w+:)?CRS>\s*EPSG:3857\s*<\/(?:\w+:)?CRS>/i.test(xml)
  return { layers, supports3857, fetchedAt: new Date().toISOString() }
}

async function getCatalog(): Promise<Catalog> {
  const cache = caches.default
  const cacheKey = new Request(CAPABILITIES_CACHE)
  const cached = await cache.match(cacheKey)
  if (cached) return cached.json<Catalog>()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const url = new URL(GEOAISWEB_WMS)
    url.search = new URLSearchParams({ service: 'WMS', version: '1.1.1', request: 'GetCapabilities' }).toString()
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/xml,application/xml' } })
    if (!response.ok) throw new Error(`GeoServer GetCapabilities respondeu HTTP ${response.status}`)
    const catalog = parseCatalog(await response.text())
    if (!catalog.supports3857) throw new Error('O catálogo oficial não declara suporte a EPSG:3857')
    const payload = new Response(JSON.stringify(catalog), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } })
    await cache.put(cacheKey, payload)
    return catalog
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Timeout ao consultar o GeoServer oficial após 8000ms')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function xyzBbox(z: number, x: number, y: number): string {
  const span = (WORLD_HALF * 2) / 2 ** z
  const minX = -WORLD_HALF + x * span
  const maxX = minX + span
  const maxY = WORLD_HALF - y * span
  const minY = maxY - span
  return `${minX},${minY},${maxX},${maxY}`
}

async function tile(c: Context<{ Bindings: Bindings }>, family: 'alta' | 'baixa') {
  const zRaw = c.req.param('z')
  const xRaw = c.req.param('x')
  const yRaw = c.req.param('y')
  if (![zRaw, xRaw, yRaw].every(value => /^\d{1,2}$/.test(value ?? ''))) return c.json({ error: 'Parâmetros z, x e y devem ser inteiros não negativos' }, 400)
  const z = Number(zRaw), x = Number(xRaw), y = Number(yRaw)
  const limit = 2 ** z
  if (z > MAX_ZOOM || x >= limit || y >= limit) return c.json({ error: 'Coordenadas XYZ fora dos limites suportados' }, 400)
  try {
    if (!(await checkRateLimit(c as any, `geoaisweb:${clientIp(c as any)}`, 120))) return c.json({ error: 'Limite de tiles excedido' }, 429)
    const catalog = await getCatalog()
    const layers = catalog.layers.filter(layer => layer.family === family)
    if (!layers.length) return c.json({ error: `O catálogo oficial não publica camada ENRC-${family === 'alta' ? 'H' : 'L'}` }, 404)
    const query = new URLSearchParams({
      SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', LAYERS: layers.map(layer => layer.name).join(','),
      STYLES: '', SRS: 'EPSG:3857', BBOX: xyzBbox(z, x, y), WIDTH: '256', HEIGHT: '256', FORMAT: 'image/png', TRANSPARENT: 'TRUE',
    })
    const cacheUrl = new URL(`/api/cartas/enrc/${family}/${z}/${x}/${y}`, 'https://worker-cache.share-brasil.invalid')
    const cacheKey = new Request(cacheUrl)
    const cached = await caches.default.match(cacheKey)
    if (cached) return new Response(cached.body, { status: cached.status, headers: cached.headers })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    let upstream: Response
    try {
      upstream = await fetch(`${GEOAISWEB_WMS}?${query.toString()}`, { signal: controller.signal, headers: { Accept: 'image/png' } })
    } finally {
      clearTimeout(timeout)
    }
    if (!upstream.ok) return c.json({ error: `GeoServer GetMap respondeu HTTP ${upstream.status}` }, 502)
    const contentType = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (contentType !== 'image/png' || !upstream.body) return c.json({ error: 'GeoServer não retornou um tile PNG válido; a resposta não foi cacheada' }, 502)
    const response = new Response(upstream.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': `public, max-age=${TILE_CACHE_SECONDS}`, 'X-Map-Source': 'GeoAISWEB/DECEA', 'X-Chart-Family': family } })
    await caches.default.put(cacheKey, response.clone())
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha desconhecida ao consultar GeoAISWEB'
    console.error(`[geoaisweb:${family}]`, message)
    return c.json({ error: 'Fonte oficial de cartas temporariamente indisponível', detail: message }, 502)
  }
}

routes.get('/api/cartas/camadas', async c => {
  try {
    if (!(await checkRateLimit(c as any, `geoaisweb:catalog:${clientIp(c as any)}`, 30))) return c.json({ error: 'Limite de consultas excedido' }, 429)
    const catalog = await getCatalog()
    return c.json({ source: 'GeoAISWEB/DECEA WMS', endpoint: GEOAISWEB_WMS, authRequired: false, supports3857: catalog.supports3857, updatedAt: catalog.fetchedAt, validity: null, layers: { alta: catalog.layers.filter(layer => layer.family === 'alta'), baixa: catalog.layers.filter(layer => layer.family === 'baixa') }, available: { alta: catalog.layers.some(layer => layer.family === 'alta'), baixa: catalog.layers.some(layer => layer.family === 'baixa') } })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Falha desconhecida ao consultar GeoAISWEB'
    console.error('[geoaisweb:catalog]', detail)
    return c.json({ error: 'Não foi possível consultar as camadas oficiais do GeoAISWEB', detail }, 502)
  }
})
routes.get('/api/cartas/enrc/alta/:z/:x/:y', c => tile(c, 'alta'))
routes.get('/api/cartas/enrc/baixa/:z/:x/:y', c => tile(c, 'baixa'))

export const geoaiswebRoutes = routes
