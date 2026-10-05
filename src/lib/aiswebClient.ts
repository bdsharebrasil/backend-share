import { XMLParser } from 'fast-xml-parser'

const AISWEB_BASE_URL = 'https://api.decea.mil.br/aisweb/'
const AREA_NODE_MAP: Record<string, string> = {
  met: 'met',
  cartas: 'cartas',
  notam: 'notam',
  infotemp: 'infotemp',
  sol: 'sol',
  routesp: 'routesp',
  waypoints: 'waypoints',
  rotaer: 'rotaer',
  pub: 'pub',
  suplementos: 'suplementos',
  geiloc: 'geiloc',
}
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: name => ['item', 'notam', 'carta', 'sol'].includes(name),
})

export async function fetchWithTimeout(url: string, timeout = 10_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ShareBrasil/1.0 (aplicativo aviacao civil; contato@sharebrasil.com.br)',
        Accept: 'text/xml,application/xml,*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      // @ts-ignore Cloudflare Workers-specific fetch option.
      cf: { cacheTtl: 300, cacheEverything: true },
    })
  } catch (error: any) {
    if (error.name === 'AbortError') throw new Error(`Timeout na AISWEB após ${timeout}ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

type AiswebContext = {
  env: {
    AISWEB_API_KEY?: string
    AISWEB_API_PASS?: string
  }
}

export async function fetchAisweb(
  c: AiswebContext,
  area: string,
  params: Record<string, string | undefined>,
): Promise<any> {
  const { AISWEB_API_KEY: apiKey, AISWEB_API_PASS: apiPass } = c.env
  if (!apiKey?.trim() || !apiPass?.trim()) throw new Error('Credenciais AISWEB ausentes')

  const query = new URLSearchParams({ apiKey, apiPass, area })
  Object.entries(params).forEach(([key, value]) => value && query.append(key, value))

  const response = await fetchWithTimeout(`${AISWEB_BASE_URL}?${query.toString()}`, 12_000)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()
  if (!text) throw new Error('Resposta vazia da AISWEB')

  const trimmed = text.trimStart()
  if (trimmed.startsWith('<html') || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype')) {
    throw new Error(`AISWEB retornou HTML em vez de XML (bloqueio ou erro de auth): ${text.slice(0, 200)}`)
  }

  try { return JSON.parse(text) } catch { }

  const parsed = parser.parse(text)
  const root = parsed?.aisweb ?? parsed
  const node = AREA_NODE_MAP[area]
  if (!node) return root
  if (root?.[node] != null) return root[node]
  if (parsed?.[node] != null) return parsed[node]
  if (root?.item != null || Array.isArray(root)) return root

  console.warn(`[AISWEB] node "${node}" ausente para area="${area}". Chaves: [${Object.keys(root ?? {}).join(', ')}]`)
  return root ?? {}
}
