import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { XMLParser } from 'fast-xml-parser'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { prepararFinanceiro, normalizarLancamentoInput, FinanceValidationError } from './financeiro/LancamentoService'
import { createExpense, settlePayable, issueRevenue, settleReceivable, createReimbursement, enqueueFinance, processFinanceQueue, FinanceKernelError } from './financeiro/FinanceiroKernel'
import logoShareBytes from './assets/share-signature-logo.png'
import signatureBytes from './assets/assinatura-para-recibo.png'

const SIGNATURE_LOGO_CID = 'share-brasil-signature-logo'
const SIGNATURE_LOGO_BASE64 = arrayBufferBase64(logoShareBytes)
const SIGNATURE_BASE64 = arrayBufferBase64(signatureBytes)

// ─── Types ────────────────────────────────────────────────────────────────────

type Bindings = {
  AISWEB_API_KEY: string
  AISWEB_API_PASS: string
  CACHE_KV: KVNamespace
  FILES: R2Bucket
  SHARE_FILES?: R2Bucket
  SHARE_DB: D1Database
  RESEND_API_KEY: string
  INTERNAL_TOKEN: string
  EMAIL_FROM: string
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_ROLE_KEY: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string
  WINSOCK_VALUATION_URL: string
  WINSOCK_API_KEY: string
  WINSOCK_AUTH_HEADER?: string
  WINSOCK_AUTH_PREFIX?: string
  ANTHROPIC_API_KEY: string
  ALLOWED_ORIGINS?: string
  TELEGRAM_BOT_TOKEN?: string
  CLIENT_SESSION_SECRET?: string
  CLIENT_SESSION_TTL_SECONDS?: string
  CLOUDFLARE_TURN_KEY_ID?: string
  CLOUDFLARE_TURN_API_TOKEN?: string
  MEETING_ROOMS: DurableObjectNamespace
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

// ─── App Initialization ───────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Bindings }>()

// CRUCIAL: O CORS precisa ser o primeiro middleware global executado
app.use('*', async (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean)
  const corsMiddleware = cors({
    origin: allowed && allowed.length > 0 ? allowed : '*',
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  })
  return corsMiddleware(c, next)
})

// ─── MCP transport oficial do SDK (Cloudflare Workers) ───────────────────────

function createMcpServer(db: D1Database): McpServer {
  const server = new McpServer({ name: 'Share Brasil MCP', version: '1.0.0' })

  server.tool(
    'executar_query_d1',
    'Executa comandos SQL de leitura e escrita no banco de dados SHARE_DB',
    { sql: z.string().describe('A query SQL a ser executada no banco de dados') },
    async ({ sql }) => {
      try {
        const consulta = sql.trim()
        if (consulta.includes(';') || !/^(select|with|explain|pragma)\b/i.test(consulta) || /\b(insert|update|delete|drop|alter|create|replace|vacuum|attach|detach)\b/i.test(consulta)) {
          return { content: [{ type: 'text', text: 'Apenas consultas SQL de leitura são permitidas.' }], isError: true }
        }
        const result = await db.prepare(consulta).all()
        return { content: [{ type: 'text', text: JSON.stringify(result.results) }] }
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Erro ao executar query: ${error?.message ?? String(error)}` }],
          isError: true,
        }
      }
    },
  )

  return server
}

// ─── MCP Roteamento oficial do SDK (web-standard transport) ───────────────────

app.use('/mcp', async (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean)
  const corsMiddleware = cors({
    origin: allowed && allowed.length > 0 ? allowed : '*',
    allowHeaders: ['Content-Type', 'Authorization', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
    exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  })
  return corsMiddleware(c, next)
})

app.all('/mcp', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const transport = new WebStandardStreamableHTTPServerTransport()
  const server = createMcpServer(c.env.SHARE_DB)

  try {
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  } catch (error) {
    return c.text(`Erro ao iniciar sessão MCP: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
})

// ─── Outras Configurações & Helpers Originais ──────────────────────────────────

const isDev = false
const log = {
  debug: (...a: any[]) => isDev && console.log('[DEBUG]', ...a),
  warn: (...a: any[]) => console.warn('[WARN]', ...a),
  error: (...a: any[]) => console.error('[ERROR]', ...a),
}

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

async function requireAuthenticatedUser(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  const authorization = c.req.header('authorization')
  log.debug('[auth] Authorization header present:', Boolean(authorization))
  const { SUPABASE_URL, SUPABASE_ANON_KEY, VITE_SUPABASE_PUBLISHABLE_KEY } = c.env
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
    log.warn('[auth] nenhuma chave pública do Supabase configurada')
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

function numericValue(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.'))
  return Number.isFinite(value) && value > 0 ? value : null
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
  email_envio?: string | null
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

function claimsFromBearerToken(token: string): ColaboradorClaims | null {
  try {
    const payloadB64 = token.split('.')[1]
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
    const id = typeof payload?.sub === 'string' ? payload.sub : ''
    const email = typeof payload?.email === 'string' ? payload.email.toLowerCase() : ''
    return id && email ? { id, email } : null
  } catch {
    return null
  }
}

function extractSupabaseClaims(c: Context<{ Bindings: Bindings }>): ColaboradorClaims | null {
  const authHeader = c.req.header('authorization')
  return authHeader?.startsWith('Bearer ') ? claimsFromBearerToken(authHeader.slice(7)) : null
}

async function authenticatedColaborador(c: Context<{ Bindings: Bindings }>): Promise<Colaborador | null> {
  if (!(await requireAuthenticatedUser(c))) return null
  const claims = extractSupabaseClaims(c)
  if (!claims) return null
  return portalDb(c).prepare('SELECT * FROM user_profiles WHERE id = ?1 OR lower(email) = ?2 LIMIT 1').bind(claims.id, claims.email).first<Colaborador>()
}

async function authenticatedColaboradorToken(c: Context<{ Bindings: Bindings }>, token: string): Promise<Colaborador | null> {
  const normalizedToken = token.trim()
  if (!normalizedToken || !c.env.SUPABASE_URL) return null
  const apiKey = c.env.SUPABASE_ANON_KEY || c.env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!apiKey) return null
  const response = await fetch(`${c.env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: apiKey, Authorization: `Bearer ${normalizedToken}` } }).catch(() => null)
  if (!response?.ok) return null
  const claims = claimsFromBearerToken(normalizedToken)
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
  const query = (c.req.query('q') ?? '').trim().toUpperCase()
  try {
    const termo = `%${query}%`
    const result = await portalDb(c).prepare("SELECT id, nome, designativo_icao, coordenadas FROM aerodromo WHERE (?1 = '%%' OR upper(designativo_icao) LIKE ?1 OR upper(nome) LIKE ?1) ORDER BY designativo_icao").bind(termo).all<{ id: string; nome: string; designativo_icao: string; coordenadas: string | null }>()
    const aerodromos = result.results.map(item => ({
      id: item.designativo_icao.trim().toUpperCase(),
      label: `${item.designativo_icao.trim().toUpperCase()} · ${item.nome}`,
      name: item.nome,
      city: null,
      coordenadas: item.coordenadas,
    })).filter(item => item.id)
    return c.json({ aerodromos, source: 'D1/aerodromo' })
  } catch (e: any) {
    log.error('[aerodromos] erro ao consultar D1:', e.message)
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
  const aircraftId = c.req.query('aeronave_id') || c.req.query('aircraft_id')
  const requestedSpeed = numericValue(c.req.query('speed'))
  const requestedBurn = numericValue(c.req.query('fuel_burn'))
  const reserveMin = numericValue(c.req.query('reserve')) || 45

  if (!adep || !ades) return c.json({ error: 'adep e ades são obrigatórios' }, 400)

  try {
    let aircraftData: any = null
    if (aircraftId) {
      try {
        aircraftData = await portalDb(c).prepare(`SELECT a.id, a.fabricante, a.modelo, a.tipo_aeronave, a.consumo_combustivel, a.velocidade_cruzeiro, a.performance_aeronave_id, p.categoria AS performance_categoria, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.teto_servico_ft AS performance_teto_servico_ft, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm
          FROM aeronave a
          LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1))
          WHERE a.id = ?1`).bind(aircraftId).first()
      } catch (error: any) {
        log.warn(`[flightplan] performance_aeronave indisponível: ${error.message}`)
        aircraftData = await portalDb(c).prepare('SELECT id, fabricante, modelo, tipo_aeronave, consumo_combustivel, velocidade_cruzeiro FROM aeronave WHERE id = ?1').bind(aircraftId).first()
      }
    }
    const speed = requestedSpeed || numericValue(aircraftData?.performance_velocidade_cruzeiro_kt) || numericValue(aircraftData?.velocidade_cruzeiro) || 120
    const burn = requestedBurn || numericValue(aircraftData?.consumo_combustivel) || 32

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
    return c.json({ error: e.message }, 500)
  }
})

// ─── Routes: Upload de arquivos (R2 + short link) ────────────────────────────

app.post('/api/upload', async (c) => {
  await garantirTabelasAuxiliares(c)
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
    await portalDb(c).prepare('INSERT INTO short_links (code, r2_key) VALUES (?, ?)')
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
  await garantirTabelasAuxiliares(c)
  const code = c.req.param('code')
  try {
    const row = await portalDb(c).prepare('SELECT r2_key FROM short_links WHERE code = ?')
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
  await garantirTabelasAuxiliares(c)
  const authOk = (await requireAuthenticatedUser(c)) || (await checkInternalAuth(c))
  if (!authOk) return c.json({ error: 'Não autorizado' }, 401)
  try {
    const { results } = await portalDb(c).prepare(
      'SELECT id, tipo, assunto, corpo_html, created_at FROM email_templates ORDER BY tipo'
    ).all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/template/:tipo', async (c) => {
  await garantirTabelasAuxiliares(c)
  const authOk = (await requireAuthenticatedUser(c)) || (await checkInternalAuth(c))
  if (!authOk) return c.json({ error: 'Não autorizado' }, 401)
  const tipo = c.req.param('tipo')
  try {
    const row = await portalDb(c).prepare(
      'SELECT id, tipo, assunto, corpo_html FROM email_templates WHERE tipo = ? LIMIT 1'
    ).bind(tipo).first()
    return c.json(row || null)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/templates', async (c) => {
  await garantirTabelasAuxiliares(c)
  if (!(await checkInternalAuth(c))) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const { tipo, assunto, corpo_html } = await c.req.json()
    if (!tipo || !assunto || !corpo_html) return c.json({ error: 'Campos obrigatórios faltando' }, 400)

    const id = uuid()
    await portalDb(c).prepare(
      'INSERT INTO email_templates (id, tipo, assunto, corpo_html) VALUES (?, ?, ?, ?)'
    ).bind(id, tipo, assunto, corpo_html).run()

    return c.json({ id, tipo, assunto, corpo_html })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.put('/api/templates/:id', async (c) => {
  await garantirTabelasAuxiliares(c)
  if (!(await checkInternalAuth(c))) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const { assunto, corpo_html } = await c.req.json()
    await portalDb(c).prepare(
      'UPDATE email_templates SET assunto = ?, corpo_html = ? WHERE id = ?'
    ).bind(assunto, corpo_html, id).run()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})


function normalizarEmailLocal(nome: string): string {
  return nome.trim().split(/\s+/)[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'colaborador'
}
function gerarEmailColaborador(nome: string, sobrenome?: string): string {
  const primeiro = normalizarEmailLocal(nome)
  const ultimo = sobrenome ? sobrenome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') : ''
  return `${primeiro}${ultimo ? `.${ultimo}` : ''}@sharebrasil.com.br`
}
async function gerarEmailEnvioColaborador(c: Context<{ Bindings: Bindings }>, nome: string): Promise<string> {
  const db = portalDb(c)
  const partes = nome.trim().split(/\s+/)
  const candidatoBase = gerarEmailColaborador(nome)
  const existe = await db.prepare('SELECT id FROM user_profiles WHERE lower(email_envio) = lower(?1) OR lower(email) = lower(?1) LIMIT 1').bind(candidatoBase).first()
  if (!existe) return candidatoBase
  const sobrenome = partes.length > 1 ? partes[partes.length - 1] : ''
  const candidatoSobrenome = gerarEmailColaborador(nome, sobrenome)
  if (!(await db.prepare('SELECT id FROM user_profiles WHERE lower(email_envio) = lower(?1) OR lower(email) = lower(?1) LIMIT 1').bind(candidatoSobrenome).first())) return candidatoSobrenome
  for (let indice = 2; indice < 100; indice++) {
    const candidato = `${normalizarEmailLocal(nome)}.${indice}@sharebrasil.com.br`
    if (!(await db.prepare('SELECT id FROM user_profiles WHERE lower(email_envio) = lower(?1) OR lower(email) = lower(?1) LIMIT 1').bind(candidato).first())) return candidato
  }
  throw new Error('nao_foi_possivel_gerar_email_unico')
}
function assinaturaHtml(assinatura: any): string {
  const esc = (valor: unknown) => escapeHtml(String(valor || ''))
  const logoUrl = String(assinatura.logo_url || '').trim()
  const logoSrc = /^https?:\/\//i.test(logoUrl) ? esc(logoUrl) : `cid:${SIGNATURE_LOGO_CID}`
  const telefone = assinatura.telefone ? `<tr><td aria-hidden="true" style="padding:1px 6px 1px 0;width:14px;font-size:12px;line-height:14px;text-align:center">&#128241;&#65038;</td><td style="padding:1px 0;line-height:14px">${esc(assinatura.telefone)}</td></tr>` : ''
  const endereco = assinatura.endereco ? `<tr><td style="padding:1px 6px 1px 0;width:16px;font-size:14px;line-height:16px">&#8962;</td><td style="padding:1px 0;color:#333;font-size:11px;line-height:14px">${esc(assinatura.endereco)}</td></tr>` : ''
  const logo = `<td style="padding:0 12px 0 0;vertical-align:middle"><img src="${logoSrc}" alt="Share Brasil" width="116" style="display:block;width:116px;height:auto;border:0"></td>`
  return `<br><br><table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;color:#333"><tr>${logo}<td style="padding:0;vertical-align:middle;font-size:13px;line-height:16px"><strong style="display:block;font-size:16px;line-height:19px;color:#111">${esc(assinatura.nome || ASSINATURA_EMPRESA_OPERACIONAL)}</strong>${assinatura.cargo ? `<span style="display:block;font-size:10px;line-height:13px;color:#333">${esc(assinatura.cargo)}</span>` : ''}<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:12px;color:#333;line-height:16px">${telefone}${endereco}</table></td></tr></table>`
}

// ─── Routes: Envio de email (Resend) + log em D1 ─────────────────────────────
// Suporta anexos: attachments?: { filename: string; r2_key: string }[]
// Fluxo esperado do frontend:
//   1. Upload do arquivo via POST /api/upload  → retorna { key, url, code }
//   2. Envio do email via POST /api/send-email → passa attachments: [{ filename, r2_key: key }]

app.post('/api/send-email', async (c) => {
  await garantirTabelasAuxiliares(c)
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

    await portalDb(c).prepare(
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
  await garantirTabelasAuxiliares(c)
  if (!(await checkInternalAuth(c))) return c.json({ error: 'Unauthorized' }, 401)
  const referenceId = c.req.query('reference_id')
  try {
    const query = referenceId
      ? portalDb(c).prepare('SELECT * FROM email_envios WHERE reference_id = ? ORDER BY created_at DESC').bind(referenceId)
      : portalDb(c).prepare('SELECT * FROM email_envios ORDER BY created_at DESC LIMIT 100')
    const { results } = await query.all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── Routes: Mensageria Interna (Inbox / D1) ──────────────────────────────────

// 📩 1. Enviar nova mensagem
app.use('/api/mensagens', async (c, next) => { await garantirTabelasAuxiliares(c); return next() })
app.use('/api/mensagens/*', async (c, next) => { await garantirTabelasAuxiliares(c); return next() })

type PastaMensagem = 'inbox' | 'nao-lidas' | 'favoritas' | 'enviadas' | 'arquivo'

function assinaturaTexto(assinatura: { nome?: string; cargo?: string; telefone?: string; endereco?: string; email?: string }) {
  return ['Atenciosamente,', assinatura.nome, assinatura.cargo, assinatura.telefone, assinatura.endereco, assinatura.email].filter((item) => item && String(item).trim()).join('\n')
}

async function prepararEstadosMensagens(c: Context<{ Bindings: Bindings }>, usuarioId: string) {
  await portalDb(c).prepare(`
    INSERT OR IGNORE INTO mensagens_usuario (mensagem_id, usuario_id, papel, lida)
    SELECT id, ?, CASE WHEN remetente_id = ? THEN 'remetente' ELSE 'destinatario' END,
      CASE WHEN remetente_id = ? THEN 1 ELSE lida END
    FROM mensagens WHERE remetente_id = ? OR destinatario_id = ?
  `).bind(usuarioId, usuarioId, usuarioId, usuarioId, usuarioId).run()
}

async function listarMensagensPasta(c: Context<{ Bindings: Bindings }>, usuarioId: string, pasta: PastaMensagem) {
  await prepararEstadosMensagens(c, usuarioId)
  const filtros: Record<PastaMensagem, string> = {
    inbox: "e.papel = 'destinatario' AND e.arquivada = 0 AND e.excluida = 0",
    'nao-lidas': "e.papel = 'destinatario' AND e.lida = 0 AND e.arquivada = 0 AND e.excluida = 0",
    favoritas: 'e.favorita = 1 AND e.excluida = 0',
    enviadas: "e.papel = 'remetente' AND e.excluida = 0",
    arquivo: 'e.arquivada = 1 AND e.excluida = 0',
  }
  const result = await portalDb(c).prepare(`
    SELECT m.id, m.remetente_id, m.destinatario_id, m.assunto, m.conteudo, m.criado_em,
      e.papel, e.lida, e.favorita, e.arquivada, e.excluida,
      COALESCE(NULLIF(trim(rem.nome_exibicao), ''), NULLIF(trim(rem.nome_completo), ''), rem.email, m.remetente_id) AS remetente_nome,
      COALESCE(NULLIF(trim(dest.nome_exibicao), ''), NULLIF(trim(dest.nome_completo), ''), dest.email, m.destinatario_id) AS destinatario_nome
    FROM mensagens m
    INNER JOIN mensagens_usuario e ON e.mensagem_id = m.id AND e.usuario_id = ?
    LEFT JOIN user_profiles rem ON rem.id = m.remetente_id
    LEFT JOIN user_profiles dest ON dest.id = m.destinatario_id
    WHERE ${filtros[pasta]}
    ORDER BY datetime(m.criado_em) DESC, m.id DESC
  `).bind(usuarioId).all()
  return result.results
}

app.get('/api/mensagens/usuarios', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  try {
    const { results } = await portalDb(c).prepare(
      "SELECT id, COALESCE(NULLIF(trim(nome_exibicao),''), NULLIF(trim(nome_completo),''), email) AS nome, email, departamento FROM user_profiles WHERE id <> ?1 AND lower(COALESCE(status,'ativo')) = 'ativo' ORDER BY nome"
    ).bind(usuarioId).all()
    return c.json({ usuarios: results })
  } catch (e: any) {
    log.error('[mensagens:usuarios]', e.message)
    return c.json({ error: 'Não foi possível carregar os usuários' }, 500)
  }
})

app.post('/api/mensagens', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)

  const remetenteId = user.id
  try {
    const body = await c.req.json<{ destinatario_id?: string; assunto?: string; conteudo?: string }>()
    const destinatarioId = String(body.destinatario_id || '').trim()
    const conteudo = String(body.conteudo || '').trim()
    if (!destinatarioId || !conteudo) return c.json({ error: 'destinatario_id e conteudo são obrigatórios' }, 400)
    if (destinatarioId === remetenteId) return c.json({ error: 'destinatario_invalido' }, 400)

    const destinatario = await portalDb(c).prepare("SELECT id FROM user_profiles WHERE id = ?1 AND lower(COALESCE(status, 'ativo')) = 'ativo'").bind(destinatarioId).first<{ id: string }>()
    if (!destinatario) return c.json({ error: 'destinatario_nao_encontrado' }, 404)

    const id = uuid()
    const assinatura = await assinaturaOperacional(c, user)
    const conteudoFinal = `${conteudo}\n\n${assinaturaTexto(assinatura)}`
    await portalDb(c).batch([
      portalDb(c).prepare('INSERT INTO mensagens (id, remetente_id, destinatario_id, assunto, conteudo) VALUES (?, ?, ?, ?, ?)').bind(id, remetenteId, destinatarioId, String(body.assunto || '').trim() || null, conteudoFinal),
      portalDb(c).prepare("INSERT INTO mensagens_usuario (mensagem_id, usuario_id, papel, lida) VALUES (?, ?, 'remetente', 1)").bind(id, remetenteId),
      portalDb(c).prepare("INSERT INTO mensagens_usuario (mensagem_id, usuario_id, papel, lida) VALUES (?, ?, 'destinatario', 0)").bind(id, destinatarioId),
    ])

    return c.json({ success: true, id, destinatario_id: destinatarioId, message: 'Mensagem enviada com sucesso' }, 201)
  } catch (e: any) {
    log.error('[mensagens:send]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// 📬 2. Listar Caixa de Entrada (Inbox)
app.get('/api/mensagens/inbox', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  try { return c.json(await listarMensagensPasta(c, usuarioId, 'inbox')) }
  catch (e: any) { log.error('[mensagens:inbox]', e.message); return c.json({ error: e.message }, 500) }
})

app.get('/api/mensagens/pasta/:pasta', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  const pasta = c.req.param('pasta') as PastaMensagem
  if (!usuarioId) return c.json({ error: 'Sessão inválida' }, 401)
  if (!['inbox', 'nao-lidas', 'favoritas', 'enviadas', 'arquivo'].includes(pasta)) return c.json({ error: 'pasta_invalida' }, 400)
  try { return c.json(await listarMensagensPasta(c, usuarioId, pasta)) }
  catch (e: any) { log.error('[mensagens:pasta]', e.message); return c.json({ error: e.message }, 500) }
})

// 📤 3. Listar Caixa de Saída (Enviados)
app.get('/api/mensagens/outbox', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  try { return c.json(await listarMensagensPasta(c, usuarioId, 'enviadas')) }
  catch (e: any) { log.error('[mensagens:outbox]', e.message); return c.json({ error: e.message }, 500) }
})

// 🔔 4. Obter contagem de mensagens NÃO LIDAS (para badges de notificação)
app.get('/api/mensagens/unread-count', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  try {
    await prepararEstadosMensagens(c, usuarioId)
    const result = await portalDb(c).prepare("SELECT COUNT(*) AS unread FROM mensagens_usuario WHERE usuario_id = ?1 AND papel = 'destinatario' AND lida = 0 AND excluida = 0 AND arquivada = 0").bind(usuarioId).first<{ unread: number }>()
    return c.json({ unread: Number(result?.unread || 0) })
  } catch (e: any) {
    log.error('[mensagens:unread-count]', e.message)
    return c.json({ error: 'Não foi possível contar as mensagens não lidas' }, 500)
  }
})

app.patch('/api/mensagens/:id/estado', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  const mensagemId = c.req.param('id')
  try {
    await prepararEstadosMensagens(c, usuarioId)
    const estado = await portalDb(c).prepare('SELECT mensagem_id FROM mensagens_usuario WHERE mensagem_id = ?1 AND usuario_id = ?2').bind(mensagemId, usuarioId).first()
    if (!estado) return c.json({ error: 'Mensagem não encontrada ou sem permissão' }, 404)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const campos: string[] = []
    const valores: unknown[] = []
    for (const campo of ['lida', 'favorita', 'arquivada', 'excluida'] as const) {
      if (body[campo] !== undefined) { campos.push(`${campo} = ?`); valores.push(body[campo] ? 1 : 0) }
    }
    if (!campos.length) return c.json({ error: 'nenhuma_atualizacao' }, 400)
    campos.push('atualizado_em = CURRENT_TIMESTAMP')
    await portalDb(c).prepare(`UPDATE mensagens_usuario SET ${campos.join(', ')} WHERE mensagem_id = ? AND usuario_id = ?`).bind(...valores, mensagemId, usuarioId).run()
    return c.json({ success: true, mensagem_id: mensagemId })
  } catch (e: any) {
    log.error('[mensagens:estado]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// 🔍 5. Obter uma mensagem específica e marcar como LIDA
app.get('/api/mensagens/:id', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  const id = c.req.param('id')
  try {
    await prepararEstadosMensagens(c, usuarioId)
    const msg = await portalDb(c).prepare(`
      SELECT m.*, e.papel, e.lida, e.favorita, e.arquivada, e.excluida
      FROM mensagens m INNER JOIN mensagens_usuario e ON e.mensagem_id = m.id AND e.usuario_id = ?
      WHERE m.id = ? AND e.excluida = 0
    `).bind(usuarioId, id).first<any>()
    if (!msg) return c.json({ error: 'Mensagem não encontrada' }, 404)
    if (msg.papel === 'destinatario' && !msg.lida) {
      await portalDb(c).prepare('UPDATE mensagens_usuario SET lida = 1, atualizado_em = CURRENT_TIMESTAMP WHERE mensagem_id = ? AND usuario_id = ?').bind(id, usuarioId).run()
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
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  const id = c.req.param('id')
  try {
    await prepararEstadosMensagens(c, usuarioId)
    const res = await portalDb(c).prepare('UPDATE mensagens_usuario SET excluida = 1, atualizado_em = CURRENT_TIMESTAMP WHERE mensagem_id = ? AND usuario_id = ? AND excluida = 0').bind(id, usuarioId).run()
    if (!res.meta.changes) return c.json({ error: 'Mensagem não encontrada ou sem permissão' }, 404)
    return c.json({ success: true, message: 'Mensagem movida para a lixeira' })
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
  const database = c.env.SHARE_DB
  const ddl = /^\s*(CREATE|ALTER|DROP|RENAME|VACUUM|REINDEX)\b/i
  const blockedStatements = new WeakSet<object>()
  const noopStatement = (): D1PreparedStatement => {
    const statement = {
      bind: (..._values: unknown[]) => statement,
      first: async <T = unknown>() => null as T | null,
      all: async <T = unknown>() => ({ results: [] as T[], success: true, meta: { changes: 0, duration: 0, last_row_id: 0, rows_read: 0, rows_written: 0 } }),
      raw: async <T = unknown[]>() => [] as T,
      run: async () => ({ success: true, meta: { changes: 0, duration: 0, last_row_id: 0, rows_read: 0, rows_written: 0 } }),
      columnNames: async () => [],
    } as unknown as D1PreparedStatement
    blockedStatements.add(statement)
    return statement
  }
  return {
    ...database,
    prepare(query: string) {
      if (ddl.test(query)) return noopStatement()
      return database.prepare(query)
    },
    batch(statements) {
      if (statements.some((statement) => blockedStatements.has(statement))) return Promise.resolve([])
      return database.batch(statements)
    },
    exec(query: string) {
      if (ddl.test(query)) return Promise.resolve({ count: 0, duration: 0 })
      return database.exec(query)
    },
  } as D1Database
}

async function garantirTabelasAuxiliares(c: Context<{ Bindings: Bindings }>): Promise<void> {
  void c
  return
  const db = portalDb(c)
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS short_links (code TEXT PRIMARY KEY NOT NULL, r2_key TEXT NOT NULL, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS email_templates (id TEXT PRIMARY KEY NOT NULL, tipo TEXT NOT NULL, assunto TEXT NOT NULL, corpo_html TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS email_envios (id TEXT PRIMARY KEY NOT NULL, tipo TEXT, reference_type TEXT, reference_id TEXT, destinatario TEXT NOT NULL, assunto TEXT NOT NULL, status TEXT NOT NULL, erro_mensagem TEXT, enviado_por TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS assinaturas_email (id TEXT PRIMARY KEY NOT NULL, usuario_id TEXT NOT NULL UNIQUE, nome TEXT NOT NULL, cargo TEXT, telefone TEXT, endereco TEXT, email TEXT NOT NULL, logo_url TEXT, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS mensagens (id TEXT PRIMARY KEY NOT NULL, remetente_id TEXT NOT NULL, destinatario_id TEXT NOT NULL, assunto TEXT, conteudo TEXT NOT NULL, lida INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS mensagens_usuario (mensagem_id TEXT NOT NULL, usuario_id TEXT NOT NULL, papel TEXT NOT NULL CHECK (papel IN ('remetente', 'destinatario')), lida INTEGER NOT NULL DEFAULT 0, favorita INTEGER NOT NULL DEFAULT 0, arquivada INTEGER NOT NULL DEFAULT 0, excluida INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (mensagem_id, usuario_id))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mensagens_usuario_pasta ON mensagens_usuario (usuario_id, papel, excluida, arquivada, favorita, lida)`),
  ])
  // Migração legada: o D1 não aceita múltiplas instruções em um único prepare.
  await db.prepare('ALTER TABLE user_profiles ADD COLUMN email_envio TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE mensagens ADD COLUMN lida INTEGER NOT NULL DEFAULT 0').run().catch(() => undefined)
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
  return null
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
    db.prepare("SELECT id, descricao, NULL AS competencia, data AS data_pagamento, ROUND(valor_centavos / 100.0, 2) AS valor, status, observacoes FROM lancamentos WHERE (pago_por = ?1 OR criado_por = ?1) AND lower(status) <> 'cancelado' ORDER BY date(data) DESC, criado_em DESC").bind(colaborador.id).all().catch(error => { log.error('[colaborador/perfil] pagamentos indisponíveis', error); return { results: [] } }),
    db.prepare('SELECT id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, criado_em, categoria FROM documentos_usuarios WHERE user_id = ?1 ORDER BY criado_em DESC').bind(colaborador.id).all().catch(error => { log.error('[colaborador/perfil] documentos indisponíveis', error); return { results: [] } }),
    db.prepare('SELECT id, funcao, criado_em FROM usuarios_funcoes WHERE user_id = ?1 ORDER BY funcao').bind(colaborador.id).all().catch(error => { log.error('[colaborador/perfil] funções indisponíveis', error); return { results: [] } }),
    db.prepare('SELECT id, data_inicio, data_fim, quantidade_dias, status, observacoes, motivo_reprovacao, aprovado_em, criado_em, atualizado_em FROM solicitacoes_ferias WHERE colaborador_id = ?1 ORDER BY data_inicio DESC, criado_em DESC').bind(colaborador.id).all().catch(error => { log.error('[colaborador/perfil] férias indisponíveis', error); return { results: [] } }),
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
  return c.json({ from, to, aeronave: aircraft.results, reservas: reservations.results })
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
    portalDb(c).prepare(`SELECT s.id, s.cliente_id, s.socio_id, s.aeronave_id, s.origem, s.destino, s.data_agendada, s.horario_previsto_agendamento, s.dias_duracao, s.numero_passageiros, s.voo_emprestado, s.status, s.motivo_rejeicao, s.numero_voo, s.criado_em, s.atualizado_em, c.razao_social AS cliente_razao_social, hs.nome AS socio_nome, COALESCE((SELECT ca.codigo_cliente FROM cotista_aeronave ca WHERE ca.socio_id = s.socio_id AND ca.codigo_cliente IS NOT NULL AND (ca.aeronave_id = s.aeronave_id OR s.aeronave_id IS NULL) ORDER BY CASE WHEN ca.aeronave_id = s.aeronave_id THEN 0 ELSE 1 END LIMIT 1), c.codigo_cliente) AS codigo_cliente, a.matricula_registro, a.modelo
      FROM solicitacoes_reserva_voo s
      LEFT JOIN cliente c ON c.id = s.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = s.socio_id
      LEFT JOIN aeronave a ON a.id = s.aeronave_id
      WHERE date(s.data_agendada) >= ?1
      ORDER BY date(s.data_agendada), s.horario_previsto_agendamento, s.criado_em
      LIMIT 50`).bind(dataReferencia).all(),
  ])
  const aeronavesAtivas = await portalDb(c).prepare("SELECT COUNT(*) AS total FROM aeronave WHERE lower(status) = 'ativa'").first<{ total: number }>()
  return c.json({ data_referencia: dataReferencia, resumo: { voos_hoje: Number(resumo?.voos_hoje || 0), pendencias: Number(resumo?.pendencias || 0), reservas_abertas: Number(resumo?.reservas_abertas || 0), aeronave_ativas: Number(aeronavesAtivas?.total || 0) }, solicitacoes: solicitacoes.results })
})

// ─── Operações: diário de bordo (D1) ─────────────────────────────────────────
// Estas rotas usam exclusivamente diario_mes e lancamentos_diario_bordo do
// SHARE_DB. O portal antigo usa Supabase e nomes de colunas diferentes; não
// reutilizamos esse contrato aqui para evitar gravar dados em uma tabela/coluna
// que não existe no banco principal.
function diarioNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function diarioDate(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function diarioBoolean(value: unknown): number {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0
}

async function recalcularDiarioMes(c: Context<{ Bindings: Bindings }>, diarioMesId: string): Promise<void> {
  const db = portalDb(c)
  const diario = await db.prepare('SELECT id, celula_anterior_ttotal, celula_prox_revisao_ttotal, celula_anterior_tvoo, celula_prox_revisao_tvoo FROM diario_mes WHERE id = ?1').bind(diarioMesId).first<any>()
  if (!diario) return
  const totais = await db.prepare(`SELECT COALESCE(SUM(tempo_total), 0) AS tempo_total, COALESCE(SUM(tempo_voo), 0) AS tempo_voo
    FROM lancamentos_diario_bordo WHERE diario_mes_id = ?1`).bind(diarioMesId).first<any>()
  const celulaAtualTotal = Number((Number(diario.celula_anterior_ttotal || 0) + Number(totais?.tempo_total || 0)).toFixed(2))
  const celulaAtualVoo = Number((Number(diario.celula_anterior_tvoo || 0) + Number(totais?.tempo_voo || 0)).toFixed(2))
  const disponivelTotal = Number(diario.celula_prox_revisao_ttotal || 0) > 0
    ? Number((Number(diario.celula_prox_revisao_ttotal || 0) - celulaAtualTotal).toFixed(2))
    : 0
  const disponivelVoo = Number(diario.celula_prox_revisao_tvoo || 0) > 0
    ? Number((Number(diario.celula_prox_revisao_tvoo || 0) - celulaAtualVoo).toFixed(2))
    : 0
  await db.prepare('UPDATE diario_mes SET celula_atual_ttotal = ?1, celula_disponivel_ttotal = ?2, celula_atual_tvoo = ?3, celula_disponivel_tvoo = ?4 WHERE id = ?5')
    .bind(celulaAtualTotal, disponivelTotal, celulaAtualVoo, disponivelVoo, diarioMesId).run()
}

app.get('/api/interno/diario-bordo/opcoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirComplianceTripulacao(c)
  const db = portalDb(c)
  const [clientes, socios, tripulacao, freelancers, aerodromos] = await Promise.all([
    db.prepare("SELECT id, razao_social AS nome, codigo_cliente, proprietario FROM cliente WHERE lower(COALESCE(status, 'ativo')) NOT IN ('inativo', 'cancelado') ORDER BY razao_social").all(),
    db.prepare('SELECT id, nome, cotista_id, holding_id FROM hold_socios ORDER BY nome').all(),
    db.prepare("SELECT id, canac, nome_completo, status, 'tripulacao' AS origem FROM tripulacao WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo").all(),
    db.prepare("SELECT id, canac, nome_completo, status, 'freelancer' AS origem FROM tripulacao_freelancer WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo").all(),
    db.prepare('SELECT id, designativo_icao AS designativo, nome FROM aerodromo ORDER BY designativo_icao').all(),
  ])
  return c.json({ clientes: clientes.results, socios: socios.results, tripulantes: [...tripulacao.results, ...freelancers.results], aerodromos: aerodromos.results })
})

app.get('/api/interno/diario-bordo/resumo', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const ano = Number(c.req.query('ano') || new Date().getFullYear())
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return c.json({ error: 'ano_invalido' }, 400)
  const rows = await portalDb(c).prepare(`SELECT a.id, a.matricula_registro, a.fabricante, a.modelo, a.status, a.consumo_combustivel,
      COALESCE((SELECT SUM(l.tempo_total) FROM lancamentos_diario_bordo l WHERE l.aeronave_id = a.id AND strftime('%Y', l.data_registro) = ?1), 0) AS horas_ano,
      COALESCE(dm.celula_atual_ttotal, 0) AS celula_atual_ttotal,
      COALESCE(dm.celula_prox_revisao_ttotal, 0) AS celula_prox_revisao_ttotal,
      COALESCE(dm.mes, 0) AS mes_referencia,
      COALESCE(dm.fechado, 0) AS fechado
    FROM aeronave a
    LEFT JOIN diario_mes dm ON dm.id = (SELECT dm2.id FROM diario_mes dm2 WHERE dm2.aeronave_id = a.id AND dm2.ano = ?1 ORDER BY dm2.mes DESC LIMIT 1)
    WHERE lower(COALESCE(a.status, 'ativa')) LIKE 'ativ%'
    ORDER BY a.matricula_registro`).bind(String(ano)).all<any>()
  return c.json({ ano, aeronave: rows.results.map((row: any) => ({ ...row, horas_ano: Number(row.horas_ano || 0), celula_atual_ttotal: Number(row.celula_atual_ttotal || 0), celula_prox_revisao_ttotal: Number(row.celula_prox_revisao_ttotal || 0), fechado: Number(row.fechado || 0) })) })
})

app.get('/api/interno/diario-bordo/detalhes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const aeronaveId = (c.req.query('aeronave_id') || '').trim()
  const ano = Number(c.req.query('ano') || new Date().getFullYear())
  const mes = Number(c.req.query('mes') || new Date().getMonth() + 1)
  if (!aeronaveId) return c.json({ error: 'aeronave_obrigatoria' }, 400)
  if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 1 || mes > 12) return c.json({ error: 'periodo_invalido' }, 400)
  const db = portalDb(c)
  await garantirTabelaAbastecimentos(c)
  const aeronave = await db.prepare('SELECT id, matricula_registro, fabricante, modelo, status, consumo_combustivel, base FROM aeronave WHERE id = ?1').bind(aeronaveId).first<any>()
  if (!aeronave) return c.json({ error: 'aeronave_nao_encontrada' }, 404)
  const diarioMes = await db.prepare('SELECT * FROM diario_mes WHERE aeronave_id = ?1 AND ano = ?2 AND mes = ?3 LIMIT 1').bind(aeronaveId, ano, mes).first<any>()
  const meses = await db.prepare('SELECT id, ano, mes, fechado, celula_atual_ttotal, celula_prox_revisao_ttotal FROM diario_mes WHERE aeronave_id = ?1 ORDER BY ano DESC, mes DESC').bind(aeronaveId).all<any>()
  if (!diarioMes) return c.json({ aeronave, diario_mes: null, lancamentos: [], meses_disponiveis: meses.results })
  const lancamentos = await db.prepare(`SELECT l.*, c.razao_social AS cliente_nome, c.codigo_cliente AS cliente_codigo, c.proprietario AS cliente_proprietario, s.nome AS socio_nome,
      ct.razao_social AS cliente_tomador_nome, ct.codigo_cliente AS cliente_tomador_codigo, st.nome AS socio_tomador_nome,
      COALESCE(adp.designativo_icao, l.aerodromo_partida) AS aerodromo_partida_icao, COALESCE(adp.nome, l.aerodromo_partida) AS aerodromo_partida_nome,
      COALESCE(adg.designativo_icao, l.aerodromo_chegada) AS aerodromo_chegada_icao, COALESCE(adg.nome, l.aerodromo_chegada) AS aerodromo_chegada_nome,
      COALESCE(NULLIF(l.pic_nome, ''), (SELECT t.nome_completo FROM tripulacao t WHERE upper(t.canac) = upper(l.pic_canac) LIMIT 1), (SELECT f.nome_completo FROM tripulacao_freelancer f WHERE upper(f.canac) = upper(l.pic_canac) LIMIT 1)) AS pic_nome_exibicao,
      COALESCE(NULLIF(l.sic_nome, ''), (SELECT t.nome_completo FROM tripulacao t WHERE upper(t.canac) = upper(l.sic_canac) LIMIT 1), (SELECT f.nome_completo FROM tripulacao_freelancer f WHERE upper(f.canac) = upper(l.sic_canac) LIMIT 1)) AS sic_nome_exibicao,
      COALESCE((SELECT SUM(ab.litros) FROM abastecimentos ab WHERE ab.lancamento_diario_id = l.id), 0) AS abastecimento_litros,
      (SELECT ab.data FROM abastecimentos ab WHERE ab.lancamento_diario_id = l.id ORDER BY date(ab.data) DESC, ab.id DESC LIMIT 1) AS abastecimento_data,
      (SELECT COALESCE(ca.razao_social, so.nome) FROM abastecimentos ab LEFT JOIN cliente ca ON ca.id = ab.cliente_id LEFT JOIN hold_socios so ON so.id = ab.socio_id WHERE ab.lancamento_diario_id = l.id ORDER BY date(ab.data) DESC, ab.id DESC LIMIT 1) AS abastecimento_pagador_nome,
      (SELECT ab.numero_comanda FROM abastecimentos ab WHERE ab.lancamento_diario_id = l.id ORDER BY date(ab.data) DESC, ab.id DESC LIMIT 1) AS abastecimento_comanda,
      (SELECT ab.numero_nf FROM abastecimentos ab WHERE ab.lancamento_diario_id = l.id ORDER BY date(ab.data) DESC, ab.id DESC LIMIT 1) AS abastecimento_nota,
      (SELECT ab.id FROM abastecimentos ab WHERE ab.lancamento_diario_id = l.id ORDER BY date(ab.data) DESC, ab.id DESC LIMIT 1) AS abastecimento_id
    FROM lancamentos_diario_bordo l
    LEFT JOIN cliente c ON c.id = l.cliente_id
    LEFT JOIN hold_socios s ON s.id = l.socio_id
    LEFT JOIN cliente ct ON ct.id = l.cliente_tomador_emprestimo_id
    LEFT JOIN hold_socios st ON st.id = l.socio_tomador_emprestimo_id
    LEFT JOIN aerodromo adp ON upper(adp.designativo_icao) = upper(l.aerodromo_partida)
    LEFT JOIN aerodromo adg ON upper(adg.designativo_icao) = upper(l.aerodromo_chegada)
    WHERE l.diario_mes_id = ?1
    ORDER BY date(l.data_registro), l.numero_sequencial, l.id`).bind(diarioMes.id).all<any>()
  const horasCotistas = await db.prepare(`SELECT COALESCE(l.socio_id, l.cliente_id) AS cotista_id, COALESCE(s.nome, c.razao_social, c.proprietario, 'Cotista não identificado') AS cotista_nome, COALESCE(SUM(l.tempo_voo), 0) AS horas_voo FROM lancamentos_diario_bordo l LEFT JOIN cliente c ON c.id = l.cliente_id LEFT JOIN hold_socios s ON s.id = l.socio_id WHERE l.diario_mes_id = ?1 GROUP BY COALESCE(l.socio_id, l.cliente_id), COALESCE(s.nome, c.razao_social, c.proprietario) ORDER BY horas_voo DESC`).bind(diarioMes.id).all()
  const horasEmprestadas = await db.prepare(`SELECT COALESCE(SUM(e.horas_emprestadas - COALESCE(e.horas_devolvidas, 0)), 0) AS horas_total, COUNT(*) AS quantidade FROM emprestimos_aeronave e LEFT JOIN lancamentos_diario_bordo l ON l.id = e.lancamento_diario_id WHERE l.diario_mes_id = ?1`).bind(diarioMes.id).first<any>()
  return c.json({ aeronave, diario_mes: diarioMes, lancamentos: lancamentos.results, meses_disponiveis: meses.results, horas_cotistas: horasCotistas.results, horas_emprestadas: { horas_total: Number(horasEmprestadas?.horas_total || 0), quantidade: Number(horasEmprestadas?.quantidade || 0) } })
})

app.post('/api/interno/diario-bordo/mes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const aeronaveId = String(body.aeronave_id || '').trim()
  const ano = diarioNumber(body.ano, 0)
  const mes = diarioNumber(body.mes, 0)
  if (!aeronaveId || !Number.isInteger(ano) || ano < 2000 || ano > 2100 || !Number.isInteger(mes) || mes < 1 || mes > 12) return c.json({ error: 'aeronave_e_periodo_obrigatorios' }, 400)
  const db = portalDb(c)
  const aeronave = await db.prepare('SELECT id FROM aeronave WHERE id = ?1').bind(aeronaveId).first()
  if (!aeronave) return c.json({ error: 'aeronave_nao_encontrada' }, 404)
  const existing = await db.prepare('SELECT id FROM diario_mes WHERE aeronave_id = ?1 AND ano = ?2 AND mes = ?3 LIMIT 1').bind(aeronaveId, ano, mes).first<{ id: string }>()
  if (existing) return c.json({ error: 'diario_mes_ja_existe', id: existing.id }, 409)
  const anterior = await db.prepare('SELECT celula_atual_ttotal, celula_atual_tvoo FROM diario_mes WHERE aeronave_id = ?1 AND (ano < ?2 OR (ano = ?2 AND mes < ?3)) ORDER BY ano DESC, mes DESC LIMIT 1').bind(aeronaveId, ano, mes).first<any>()
  const anteriorTotal = diarioNumber(body.celula_anterior_ttotal, diarioNumber(anterior?.celula_atual_ttotal))
  const anteriorVoo = diarioNumber(body.celula_anterior_tvoo, diarioNumber(anterior?.celula_atual_tvoo))
  const id = uuid()
  await db.prepare(`INSERT INTO diario_mes (id, aeronave_id, ano, mes, celula_anterior_ttotal, celula_atual_ttotal, celula_prox_revisao_ttotal, celula_disponivel_ttotal, horimetro_inicio, horimetro_final, horimetro_ativo, fechado, aerodromo_base, tarifa_diaria, consumo_combustivel, tem_tarifa_diaria, celula_atual_tvoo, celula_disponivel_tvoo, celula_anterior_tvoo, celula_prox_revisao_tvoo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    id, aeronaveId, ano, mes, anteriorTotal, anteriorTotal, diarioNumber(body.celula_prox_revisao_ttotal), 0,
    diarioNumber(body.horimetro_inicio), diarioNumber(body.horimetro_final), diarioNumber(body.horimetro_ativo), 0,
    body.aerodromo_base?.trim() || null, diarioNumber(body.tarifa_diaria), body.consumo_combustivel?.trim() || null, diarioBoolean(body.tem_tarifa_diaria ?? true),
    anteriorVoo, 0, anteriorVoo, diarioNumber(body.celula_prox_revisao_tvoo),
  ).run()
  return c.json({ id, aeronave_id: aeronaveId, ano, mes, celula_anterior_ttotal: anteriorTotal, celula_anterior_tvoo: anteriorVoo }, 201)
})

app.patch('/api/interno/diario-bordo/mes/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const id = c.req.param('id')
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const allowed: Record<string, (value: unknown) => unknown> = {
    celula_anterior_ttotal: value => diarioNumber(value), celula_atual_ttotal: value => diarioNumber(value), celula_prox_revisao_ttotal: value => diarioNumber(value), celula_disponivel_ttotal: value => diarioNumber(value),
    horimetro_inicio: value => diarioNumber(value), horimetro_final: value => diarioNumber(value), horimetro_ativo: value => diarioNumber(value), fechado: value => diarioBoolean(value),
    aerodromo_base: value => typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null, tarifa_diaria: value => diarioNumber(value), consumo_combustivel: value => typeof value === 'string' && value.trim() ? value.trim() : null, tem_tarifa_diaria: value => diarioBoolean(value),
    celula_atual_tvoo: value => diarioNumber(value), celula_disponivel_tvoo: value => diarioNumber(value), celula_anterior_tvoo: value => diarioNumber(value), celula_prox_revisao_tvoo: value => diarioNumber(value),
  }
  const updates = Object.keys(allowed).filter(field => body[field] !== undefined)
  if (updates.length === 0) return c.json({ error: 'nenhum_campo_informado' }, 400)
  const result = await portalDb(c).prepare(`UPDATE diario_mes SET ${updates.map(field => `${field} = ?`).join(', ')} WHERE id = ?`).bind(...updates.map(field => allowed[field](body[field])), id).run()
  if (!result.meta.changes) return c.notFound()
  await recalcularDiarioMes(c, id)
  const updated = await portalDb(c).prepare('SELECT * FROM diario_mes WHERE id = ?1').bind(id).first()
  return c.json(updated)
})

const DIARIO_LANCAMENTO_FIELDS = [
  'numero_voo', 'jornada_id', 'cliente_id', 'socio_id', 'voo_emprestado', 'socio_tomador_emprestimo_id', 'cliente_tomador_emprestimo_id', 'data_registro', 'aerodromo_partida', 'aerodromo_chegada', 'trecho', 'pic_canac', 'pic_nome', 'sic_canac', 'sic_nome', 'tripulacao_checkin_hora', 'tempo_ac', 'tempo_dep', 'tempo_pou', 'tempo_cor', 'tempo_ifr', 'tempo_voo', 'tempo_total', 'horas_diurnas', 'horas_noturnas', 'pousos_total', 'distancia_nm', 'diarias', 'consumo_combustivel_voo', 'consumo_combustivel_total', 'litros_combustivel_inicio_voo', 'litros_combustivel_abastecido', 'local_combustivel', 'abastecido', 'celula', 'confirmado', 'confirmado_em', 'assinado_pic', 'data_assinatura', 'passageiros', 'carga_kg', 'natureza_voo', 'ocorrencias', 'discrepancias', 'acoes_corretivas', 'tipo_manutencao_ultima', 'tipo_manutencao_proxima', 'responsavel_aprovacao_manutencao', 'detectado_por',
]

async function nomeAerodromoDiario(c: Context<{ Bindings: Bindings }>, valor: string): Promise<string> {
  const codigo = String(valor || '').trim().toUpperCase()
  if (!codigo) return codigo
  const item = await portalDb(c).prepare('SELECT nome FROM aerodromo WHERE upper(designativo_icao) = ?1 LIMIT 1').bind(codigo).first<{ nome: string }>()
  return item?.nome?.trim() || codigo
}
async function nomeTripulantePorCanac(c: Context<{ Bindings: Bindings }>, canac: string): Promise<string | null> {
  const codigo = String(canac || '').trim().toUpperCase()
  if (!codigo) return null
  const tripulante = await portalDb(c).prepare('SELECT nome_completo FROM tripulacao WHERE upper(canac) = ?1 LIMIT 1').bind(codigo).first<{ nome_completo: string | null }>()
  if (tripulante?.nome_completo) return tripulante.nome_completo
  const freelancer = await portalDb(c).prepare('SELECT nome_completo FROM tripulacao_freelancer WHERE upper(canac) = ?1 LIMIT 1').bind(codigo).first<{ nome_completo: string | null }>()
  return freelancer?.nome_completo || null
}

async function trechoAerodromosDiario(c: Context<{ Bindings: Bindings }>, partida: string, chegada: string): Promise<string> {
  const [nomePartida, nomeChegada] = await Promise.all([nomeAerodromoDiario(c, partida), nomeAerodromoDiario(c, chegada)])
  return `${nomePartida} X ${nomeChegada}`
}

function normalizarLancamentoDiario(body: Record<string, any>, aeronave: any, defaults: { diarioMesId?: string; celula?: number; sequencial?: number; criadoPor?: string | null } = {}): Record<string, unknown> {
  const partida = String(body.aerodromo_partida || '').trim().toUpperCase()
  const chegada = String(body.aerodromo_chegada || '').trim().toUpperCase()
  const data = diarioDate(body.data_registro)
  const tempoVoo = diarioNumber(body.tempo_voo)
  const tempoTotal = diarioNumber(body.tempo_total, tempoVoo)
  const consumoHora = diarioNumber(aeronave?.consumo_combustivel)
  const consumoVoo = diarioNumber(body.consumo_combustivel_voo, Number((tempoVoo * consumoHora).toFixed(2)))
  const consumoTotal = diarioNumber(body.consumo_combustivel_total, Number((tempoTotal * consumoHora).toFixed(2)))
  const row: Record<string, unknown> = {
    numero_voo: body.numero_voo?.trim() || null, jornada_id: body.jornada_id?.trim() || null, diario_mes_id: defaults.diarioMesId || body.diario_mes_id,
    aeronave_id: body.aeronave_id, cliente_id: body.cliente_id || null, socio_id: body.socio_id || null, voo_emprestado: diarioBoolean(body.voo_emprestado), socio_tomador_emprestimo_id: body.socio_tomador_emprestimo_id || null, cliente_tomador_emprestimo_id: body.cliente_tomador_emprestimo_id || null,
    data_registro: data, aerodromo_partida: partida, aerodromo_chegada: chegada, trecho: body.trecho?.trim() || `${partida} X ${chegada}`,
    pic_canac: String(body.pic_canac || '').trim().toUpperCase(), pic_nome: body.pic_nome?.trim() || null, sic_canac: body.sic_canac?.trim()?.toUpperCase() || null, sic_nome: body.sic_nome?.trim() || null, tripulacao_checkin_hora: body.tripulacao_checkin_hora || null,
    tempo_ac: body.tempo_ac || null, tempo_dep: body.tempo_dep || null, tempo_pou: body.tempo_pou || null, tempo_cor: body.tempo_cor || null, tempo_ifr: diarioNumber(body.tempo_ifr), tempo_voo: tempoVoo, tempo_total: tempoTotal,
    horas_diurnas: diarioNumber(body.horas_diurnas, tempoVoo), horas_noturnas: diarioNumber(body.horas_noturnas), pousos_total: Math.max(0, Math.trunc(diarioNumber(body.pousos_total))), distancia_nm: diarioNumber(body.distancia_nm), diarias: body.diarias == null || body.diarias === '' ? null : String(body.diarias),
    consumo_combustivel_voo: consumoVoo, consumo_combustivel_total: consumoTotal, litros_combustivel_inicio_voo: diarioNumber(body.litros_combustivel_inicio_voo), litros_combustivel_abastecido: diarioNumber(body.litros_combustivel_abastecido), local_combustivel: body.local_combustivel?.trim() || null, abastecido: diarioBoolean(body.abastecido),
    celula: diarioNumber(body.celula, defaults.celula || 0), confirmado: diarioBoolean(body.confirmado), confirmado_em: diarioBoolean(body.confirmado) ? (body.confirmado_em || new Date().toISOString()) : null, assinado_pic: body.assinado_pic || null, data_assinatura: body.data_assinatura || null,
    passageiros: Math.max(0, Math.trunc(diarioNumber(body.passageiros))), carga_kg: body.carga_kg == null || body.carga_kg === '' ? null : String(body.carga_kg), natureza_voo: String(body.natureza_voo || '').trim(), ocorrencias: body.ocorrencias?.trim() || null, discrepancias: body.discrepancias?.trim() || null, acoes_corretivas: body.acoes_corretivas?.trim() || null,
    tipo_manutencao_ultima: body.tipo_manutencao_ultima?.trim() || null, tipo_manutencao_proxima: body.tipo_manutencao_proxima?.trim() || null, responsavel_aprovacao_manutencao: body.responsavel_aprovacao_manutencao?.trim() || null, detectado_por: body.detectado_por?.trim() || null,
  }
  if (defaults.sequencial !== undefined) row.numero_sequencial = defaults.sequencial
  if (defaults.criadoPor) row.criado_por = defaults.criadoPor
  return row
}

app.post('/api/interno/diario-bordo/lancamentos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const aeronaveId = String(body.aeronave_id || '').trim()
  const diarioMesId = String(body.diario_mes_id || '').trim()
  const data = diarioDate(body.data_registro)
  if (!aeronaveId || !diarioMesId || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !body.aerodromo_partida?.trim() || !body.aerodromo_chegada?.trim() || !body.pic_canac?.trim() || !body.natureza_voo?.trim()) return c.json({ error: 'campos_obrigatorios_ausentes' }, 400)
  const db = portalDb(c)
  const [aeronave, diario] = await Promise.all([
    db.prepare('SELECT id, consumo_combustivel FROM aeronave WHERE id = ?1').bind(aeronaveId).first<any>(),
    db.prepare('SELECT id, aeronave_id, ano, mes, fechado, celula_atual_ttotal, celula_atual_tvoo FROM diario_mes WHERE id = ?1').bind(diarioMesId).first<any>(),
  ])
  if (!aeronave || !diario || diario.aeronave_id !== aeronaveId) return c.json({ error: 'diario_ou_aeronave_invalido' }, 409)
  if (Number(diario.fechado)) return c.json({ error: 'diario_fechado' }, 409)
  if (data.slice(0, 7) !== `${diario.ano}-${String(diario.mes).padStart(2, '0')}`) return c.json({ error: 'data_fora_do_mes' }, 400)
  const last = await db.prepare('SELECT COALESCE(MAX(numero_sequencial), 0) AS sequencial FROM lancamentos_diario_bordo WHERE diario_mes_id = ?1').bind(diarioMesId).first<{ sequencial: number }>()
  const id = uuid()
  const perfilPic = await db.prepare('SELECT nome_completo FROM user_profiles WHERE id = ?1').bind(extractSupabaseUserId(c)).first<{ nome_completo: string | null }>()
  const [nomePic, nomeSic, trecho] = await Promise.all([nomeTripulantePorCanac(c, body.pic_canac), nomeTripulantePorCanac(c, body.sic_canac), trechoAerodromosDiario(c, body.aerodromo_partida, body.aerodromo_chegada)])
  const row = normalizarLancamentoDiario({ ...body, cliente_id: String(body.cliente_id || '').trim() || null, socio_id: String(body.socio_id || '').trim() || null, pic_nome: nomePic || body.pic_nome || perfilPic?.nome_completo || null, sic_nome: nomeSic || body.sic_nome || null, trecho, aeronave_id: aeronaveId, diario_mes_id: diarioMesId }, aeronave, { diarioMesId, sequencial: Number(last?.sequencial || 0) + 1, celula: diarioNumber(body.celula, diarioNumber(diario.celula_atual_ttotal) + diarioNumber(body.tempo_total)), criadoPor: extractSupabaseUserId(c) })
  const columns = ['id', ...Object.keys(row)]
  await db.prepare(`INSERT INTO lancamentos_diario_bordo (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).bind(id, ...columns.slice(1).map(column => row[column])).run()
  const abastecimento = body.abastecimento && typeof body.abastecimento === 'object' ? body.abastecimento : null
  if (abastecimento && diarioNumber(abastecimento.litros) > 0) {
    await garantirTabelaAbastecimentos(c)
    await db.prepare(`INSERT INTO abastecimentos (id, cliente_id, socio_id, aeronave_id, data, tipo_combustivel, trecho, local, numero_comanda, numero_nf, litros, valor_unitario, valor_total, status, observacao, criado_por, lancamento_diario_id, voo_emprestado, numero_voo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), abastecimento.cliente_id || null, abastecimento.socio_id || null, aeronaveId, abastecimento.data || data, abastecimento.tipo_combustivel || null, abastecimento.trecho || row.trecho, abastecimento.local || row.local_combustivel || String(body.aerodromo_partida || ''), abastecimento.numero_comanda || null, abastecimento.numero_nf || null, diarioNumber(abastecimento.litros), diarioNumber(abastecimento.valor_unitario), diarioNumber(abastecimento.valor_total), abastecimento.status || 'pendente', abastecimento.observacao || 'Criado no Diário de Bordo', extractSupabaseUserId(c), id, diarioBoolean(body.voo_emprestado), row.numero_voo || null).run()
  }
  await recalcularDiarioMes(c, diarioMesId)
  const inserted = await db.prepare('SELECT * FROM lancamentos_diario_bordo WHERE id = ?1').bind(id).first()
  return c.json(inserted, 201)
})

app.patch('/api/interno/diario-bordo/lancamentos/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const id = c.req.param('id')
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const db = portalDb(c)
  const current = await db.prepare(`SELECT l.*, dm.fechado, dm.ano AS diario_ano, dm.mes AS diario_mes FROM lancamentos_diario_bordo l LEFT JOIN diario_mes dm ON dm.id = l.diario_mes_id WHERE l.id = ?1`).bind(id).first<any>()
  if (!current) return c.notFound()
  if (Number(current.fechado)) return c.json({ error: 'diario_fechado' }, 409)
  const aeronave = await db.prepare('SELECT id, consumo_combustivel FROM aeronave WHERE id = ?1').bind(current.aeronave_id).first<any>()
  const merged = { ...current, ...body, aeronave_id: current.aeronave_id, diario_mes_id: current.diario_mes_id,
    consumo_combustivel_voo: body.consumo_combustivel_voo === undefined ? undefined : body.consumo_combustivel_voo,
    consumo_combustivel_total: body.consumo_combustivel_total === undefined ? undefined : body.consumo_combustivel_total }
  const perfilPic = await db.prepare('SELECT nome_completo FROM user_profiles WHERE id = ?1').bind(extractSupabaseUserId(c)).first<{ nome_completo: string | null }>()
  const [nomePic, nomeSic, trecho] = await Promise.all([nomeTripulantePorCanac(c, body.pic_canac || current.pic_canac), nomeTripulantePorCanac(c, body.sic_canac || current.sic_canac), body.aerodromo_partida || body.aerodromo_chegada ? trechoAerodromosDiario(c, body.aerodromo_partida || current.aerodromo_partida, body.aerodromo_chegada || current.aerodromo_chegada) : Promise.resolve(current.trecho)])
  const row = normalizarLancamentoDiario({ ...merged, cliente_id: body.cliente_id !== undefined ? String(body.cliente_id || '').trim() || null : current.cliente_id, socio_id: body.socio_id !== undefined ? String(body.socio_id || '').trim() || null : current.socio_id, trecho, pic_nome: nomePic || body.pic_nome || current.pic_nome || perfilPic?.nome_completo || null, sic_nome: nomeSic || body.sic_nome || current.sic_nome || null }, aeronave, { diarioMesId: current.diario_mes_id, sequencial: current.numero_sequencial, criadoPor: current.criado_por })
  const updates = DIARIO_LANCAMENTO_FIELDS.filter(field => body[field] !== undefined).map(field => [field, row[field]] as const)
  if (body.data_registro !== undefined) updates.push(['data_registro', row.data_registro])
  if (updates.length === 0) return c.json({ error: 'nenhum_campo_informado' }, 400)
  if (body.data_registro !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.data_registro)) || String(row.data_registro).slice(0, 7) !== `${current.diario_ano || ''}-${String(current.diario_mes || '').padStart(2, '0')}`)) return c.json({ error: 'data_fora_do_mes' }, 400)
  const assignments = updates.filter(([field], index, list) => list.findIndex(([candidate]) => candidate === field) === index)
  await db.prepare(`UPDATE lancamentos_diario_bordo SET ${assignments.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`).bind(...assignments.map(([, value]) => value), id).run()
  await recalcularDiarioMes(c, current.diario_mes_id)
  return c.json(await db.prepare('SELECT * FROM lancamentos_diario_bordo WHERE id = ?1').bind(id).first())
})

app.delete('/api/interno/diario-bordo/lancamentos/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const id = c.req.param('id')
  const current = await portalDb(c).prepare('SELECT l.diario_mes_id, dm.fechado FROM lancamentos_diario_bordo l LEFT JOIN diario_mes dm ON dm.id = l.diario_mes_id WHERE l.id = ?1').bind(id).first<{ diario_mes_id: string; fechado: number }>()
  if (!current) return c.notFound()
  if (Number(current.fechado)) return c.json({ error: 'diario_fechado' }, 409)
  const result = await portalDb(c).prepare('DELETE FROM lancamentos_diario_bordo WHERE id = ?1').bind(id).run()
  if (!result.meta.changes) return c.notFound()
  await recalcularDiarioMes(c, current.diario_mes_id)
  return c.json({ success: true })
})

app.get('/api/interno/dashboard/financeiro', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const db = portalDb(c)
  const schema = await db.prepare("SELECT name FROM pragma_table_info('lancamentos')").all<{ name: string }>()
  const colunas = new Set((schema.results || []).map((item) => item.name))
  const caixaColumn = colunas.has('caixa') ? 'caixa' : 'tipo_caixa'
  const dataColumn = colunas.has('data') ? 'data' : colunas.has('data_pagamento') ? 'data_pagamento' : 'data_emissao_nf'
  const [resumo, lancamentos] = await Promise.all([
    db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN lower(COALESCE(status, '')) NOT IN ('pago', 'cancelado') THEN COALESCE(valor_centavos, 0) ELSE 0 END), 0) / 100.0 AS total_a_receber,
      COALESCE(SUM(CASE WHEN lower(COALESCE(status, '')) IN ('pago', 'quitado', 'conciliado') THEN COALESCE(valor_centavos, 0) ELSE 0 END), 0) / 100.0 AS total_pago,
      SUM(CASE WHEN lower(COALESCE(status, '')) NOT IN ('pago', 'cancelado') THEN 1 ELSE 0 END) AS pendencias,
      SUM(CASE WHEN lower(COALESCE(status, '')) IN ('pago', 'quitado', 'conciliado') THEN 1 ELSE 0 END) AS pagamentos_confirmados
      FROM lancamentos WHERE lower(COALESCE(${caixaColumn}, 'share')) = 'share'`).first<Record<string, number>>(),
    db.prepare(`SELECT id, descricao, status, ${dataColumn} AS data_pagamento, ROUND(COALESCE(valor_centavos, 0) / 100.0, 2) AS valor, observacoes, criado_em
      FROM lancamentos
      WHERE lower(COALESCE(${caixaColumn}, 'share')) = 'share'
      ORDER BY date(${dataColumn}) DESC, criado_em DESC
      LIMIT 20`).all(),
  ])
  return c.json({ resumo: { total_a_receber: Number(resumo?.total_a_receber || 0), total_pago: Number(resumo?.total_pago || 0), pendencias: Number(resumo?.pendencias || 0), pagamentos_confirmados: Number(resumo?.pagamentos_confirmados || 0) }, movimentacoes: lancamentos.results || [] })
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
  void c
  return
  await portalDb(c).prepare(`ALTER TABLE solicitacoes_reserva_voo ADD COLUMN socio_id TEXT NULL`).run().catch(() => undefined)
  await portalDb(c).prepare(`ALTER TABLE solicitacoes_reserva_voo ADD COLUMN cliente_emprestimo_id TEXT NULL`).run().catch(() => undefined)
  await portalDb(c).prepare(`ALTER TABLE solicitacoes_reserva_voo ADD COLUMN socio_emprestimo_id TEXT NULL`).run().catch(() => undefined)
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
  void c
  return
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


async function garantirComplianceTripulacao(c: Context<{ Bindings: Bindings }>) {
  await portalDb(c).prepare('ALTER TABLE aeronave ADD COLUMN numero_motores INTEGER NULL').run().catch(() => undefined)
}

async function validarElegibilidadeTripulante(c: Context<{ Bindings: Bindings }>, tripulanteId: string, aeronaveId: string): Promise<string | null> {
  const tripulante = await buscarTripulante(c, tripulanteId)
  if (!tripulante) return 'tripulante_nao_encontrado'
  if (tripulante.origem === 'freelancer') return null
  const hoje = new Date().toISOString().slice(0, 10)
  const habilitacoes = await portalDb(c).prepare('SELECT tipo_habilitacao, data_validade, validade_cma FROM habilitacoes_tripulante WHERE tripulacao_id = ?1').bind(tripulanteId).all<{ tipo_habilitacao: string; data_validade: string | null; validade_cma: string | null }>()
  const cma = habilitacoes.results.find((item) => item.validade_cma)
  if (!cma?.validade_cma || cma.validade_cma < hoje) return 'cma_vencido_ou_nao_cadastrado'
  const aeronave = await portalDb(c).prepare('SELECT numero_motores, modelo FROM aeronave WHERE id = ?1').bind(aeronaveId).first<{ numero_motores: number | null; modelo: string }>()
  if (Number(aeronave?.numero_motores || 0) >= 2) {
    const mlte = habilitacoes.results.find((item) => /(^|[^A-Z])MLTE([^A-Z]|$)/i.test(item.tipo_habilitacao || '') && (!item.data_validade || item.data_validade >= hoje))
    if (!mlte) return 'habilitacao_mlte_necessaria'
  }
  return null
}

app.get('/api/interno/tripulacao/gestao', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirComplianceTripulacao(c)
  const db = portalDb(c)
  const [tripulantes, habilitacoes, freelancers, aeronave] = await Promise.all([
    db.prepare(`SELECT t.id, t.user_id, t.canac, t.nome_completo, t.status, t.tipo_licenca, up.email, up.telefone, up.url_avatar, up.departamento FROM tripulacao t LEFT JOIN user_profiles up ON up.id = t.user_id ORDER BY t.nome_completo`).all(),
    db.prepare('SELECT * FROM habilitacoes_tripulante ORDER BY data_validade, validade_cma').all(),
    db.prepare('SELECT f.*, a.matricula_registro, a.fabricante, a.modelo FROM tripulacao_freelancer f LEFT JOIN aeronave a ON a.id = f.aeronave_id ORDER BY f.nome_completo').all(),
    db.prepare('SELECT id, matricula_registro, fabricante, modelo, tipo_aeronave, numero_motores, status FROM aeronave ORDER BY matricula_registro').all(),
  ])
  return c.json({ tripulantes: tripulantes.results, habilitacoes: habilitacoes.results, freelancers: freelancers.results, aeronave: aeronave.results })
})

app.patch('/api/interno/tripulacao/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<{ canac?: string; nome_completo?: string; status?: string; tipo_licenca?: string }>().catch(() => ({} as any))
  const result = await portalDb(c).prepare('UPDATE tripulacao SET canac = COALESCE(?1, canac), nome_completo = COALESCE(?2, nome_completo), status = COALESCE(?3, status), tipo_licenca = COALESCE(?4, tipo_licenca) WHERE id = ?5').bind(body.canac?.trim() || null, body.nome_completo?.trim() || null, body.status?.trim() || null, body.tipo_licenca?.trim() || null, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.post('/api/interno/tripulacao/:id/habilitacoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<{ tipo_habilitacao?: string; data_validade?: string; classe_cma?: string; validade_cma?: string; fs_rh?: string }>().catch(() => ({} as any))
  if (!body.tipo_habilitacao?.trim()) return c.json({ error: 'tipo_habilitacao_obrigatorio' }, 400)
  const tripulante = await portalDb(c).prepare('SELECT id FROM tripulacao WHERE id = ?1').bind(c.req.param('id')).first()
  if (!tripulante) return c.notFound()
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO habilitacoes_tripulante (id, tripulacao_id, tipo_habilitacao, data_validade, classe_cma, validade_cma, fs_rh) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, c.req.param('id'), body.tipo_habilitacao.trim(), body.data_validade || null, body.classe_cma?.trim() || null, body.validade_cma || null, body.fs_rh?.trim() || null).run()
  return c.json({ id, ...body }, 201)
})

app.patch('/api/interno/tripulacao/habilitacoes/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<{ tipo_habilitacao?: string; data_validade?: string | null; classe_cma?: string | null; validade_cma?: string | null; fs_rh?: string | null }>().catch(() => ({} as any))
  const result = await portalDb(c).prepare('UPDATE habilitacoes_tripulante SET tipo_habilitacao = COALESCE(?1, tipo_habilitacao), data_validade = ?, classe_cma = ?, validade_cma = ?, fs_rh = ? WHERE id = ?6').bind(body.tipo_habilitacao?.trim() || null, body.data_validade || null, body.classe_cma?.trim() || null, body.validade_cma || null, body.fs_rh?.trim() || null, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.post('/api/interno/tripulacao-freelancer', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as any))
  if (!body.nome_completo?.trim() || !body.canac?.trim()) return c.json({ error: 'nome_e_canac_obrigatorios' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO tripulacao_freelancer (id, canac, nome_completo, data_nascimento, url_avatar, status, rg, cpf, endereco, cidade, uf, telefone, aeronave_id, observacao) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.canac.trim(), body.nome_completo.trim(), body.data_nascimento || null, body.url_avatar || null, body.status || 'ativo', body.rg || null, body.cpf || null, body.endereco || null, body.cidade || null, body.uf || null, body.telefone || null, body.aeronave_id || null, body.observacao || null).run()
  return c.json({ id, ...body, origem: 'freelancer' }, 201)
})

app.patch('/api/interno/tripulacao-freelancer/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as any))
  const result = await portalDb(c).prepare('UPDATE tripulacao_freelancer SET canac = COALESCE(?1, canac), nome_completo = COALESCE(?2, nome_completo), telefone = ?, aeronave_id = ?, observacao = ?, status = COALESCE(?6, status) WHERE id = ?7').bind(body.canac?.trim() || null, body.nome_completo?.trim() || null, body.telefone || null, body.aeronave_id || null, body.observacao || null, body.status || null, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.get('/api/interno/tripulacao/horas', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const mes = c.req.query('mes')
  const inicio = c.req.query('inicio') || (/^\d{4}-\d{2}$/.test(mes || '') ? `${mes}-01` : '1900-01-01')
  const fim = c.req.query('fim') || (/^\d{4}-\d{2}$/.test(mes || '') ? `${mes}-31` : '2999-12-31')
  const aircraft = c.req.query('aeronave_id') || ''
  const query = aircraft ? 'SELECT l.*, a.matricula_registro FROM lancamentos_diario_bordo l LEFT JOIN aeronave a ON a.id = l.aeronave_id WHERE date(l.data_registro) BETWEEN ?1 AND ?2 AND l.aeronave_id = ?3 ORDER BY date(l.data_registro) DESC' : 'SELECT l.*, a.matricula_registro FROM lancamentos_diario_bordo l LEFT JOIN aeronave a ON a.id = l.aeronave_id WHERE date(l.data_registro) BETWEEN ?1 AND ?2 ORDER BY date(l.data_registro) DESC'
  const result = aircraft ? await portalDb(c).prepare(query).bind(inicio, fim, aircraft).all<any>() : await portalDb(c).prepare(query).bind(inicio, fim).all<any>()
  const totals = new Map<string, any>(); const voos = result.results.map((row: any) => ({ id: row.id, data_registro: row.data_registro, matricula_registro: row.matricula_registro, pic_canac: row.pic_canac, pic_nome: row.pic_nome, sic_canac: row.sic_canac, sic_nome: row.sic_nome, tempo_voo: Number(row.tempo_voo || row.tempo_total || 0), horas_diurnas: Number(row.horas_diurnas || 0), horas_noturnas: Number(row.horas_noturnas || 0), tempo_ifr: Number(row.tempo_ifr || 0) }))
  const add = (canac: string | null, nome: string | null, role: 'PIC' | 'SIC', row: any) => { if (!canac && !nome) return; const key = `${role}:${canac || nome}`; const current = totals.get(key) || { canac: canac || null, nome: nome || canac || 'Tripulante', funcao: role, horas_totais: 0, horas_pic: 0, horas_sic: 0, horas_diurnas: 0, horas_noturnas: 0, horas_ifr: 0, voos: 0 }; current.horas_totais += row.tempo_voo; current[`horas_${role.toLowerCase()}`] += row.tempo_voo; current.horas_diurnas += row.horas_diurnas; current.horas_noturnas += row.horas_noturnas; current.horas_ifr += row.tempo_ifr; current.voos += 1; totals.set(key, current) }
  for (const row of voos) { add(row.pic_canac, row.pic_nome, 'PIC', row); add(row.sic_canac, row.sic_nome, 'SIC', row) }
  const round = (value: number) => Math.round(value * 100) / 100
  return c.json({ inicio, fim, voos, totais: [...totals.values()].map((item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, typeof value === 'number' ? round(value as number) : value]))) })
})

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
  const [clientes, socios, aeronave, vinculos] = await Promise.all([
    db.prepare("SELECT id, razao_social AS nome, codigo_cliente FROM cliente WHERE lower(COALESCE(status, 'ativo')) NOT IN ('inativo', 'cancelado') ORDER BY razao_social").all(),
    db.prepare("SELECT id, nome, cotista_id, holding_id FROM hold_socios ORDER BY nome").all(),
    db.prepare(`SELECT a.id, a.matricula_registro, a.fabricante, a.modelo, a.status, a.ano, a.base, a.url_imagem, a.tipo_aeronave, a.consumo_combustivel, a.velocidade_cruzeiro, p.categoria AS performance_categoria, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.teto_servico_ft AS performance_teto_servico_ft, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm
      FROM aeronave a
      LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1))
      ORDER BY a.matricula_registro`).all(),
    db.prepare(`SELECT ca.id, ca.cliente_id, ca.socio_id, ca.aeronave_id, ca.codigo_cliente, a.matricula_registro, a.modelo
      FROM cotista_aeronave ca LEFT JOIN aeronave a ON a.id = ca.aeronave_id ORDER BY ca.codigo_cliente, a.matricula_registro`).all(),
  ])
  return c.json({ clientes: clientes.results, socios: socios.results, aeronave: aeronave.results, vinculos: vinculos.results })
})

app.get('/api/interno/agendamento', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const inicio = c.req.query('inicio') || new Date().toISOString().slice(0, 10)
  const fim = c.req.query('fim') || inicio.slice(0, 7) + '-31'
  const db = portalDb(c)
  await garantirTabelaDisponibilidadeTripulacao(c)
  const [agendamentos, aeronave, tripulacao, freelancers, disponibilidades] = await Promise.all([
    db.prepare(`SELECT s.id, s.cliente_id, s.socio_id, s.cliente_emprestimo_id, s.socio_emprestimo_id, s.aeronave_id, s.origem, s.destino, s.data_agendada, date(s.data_agendada, '+' || (COALESCE(s.dias_duracao, 1) - 1) || ' days') AS data_fim, s.horario_previsto_agendamento, s.dias_duracao, s.numero_passageiros, s.voo_emprestado, s.status, s.observacoes, s.motivo_rejeicao, s.numero_voo, s.criado_em, s.atualizado_em, s.piloto_id, s.copiloto_id, c.razao_social AS cliente_razao_social, so.nome AS socio_nome, ce.razao_social AS cliente_emprestimo_nome, se.nome AS socio_emprestimo_nome, COALESCE(ce.codigo_cliente, cae.codigo_cliente, c.codigo_cliente, ca.codigo_cliente) AS codigo_cliente, a.matricula_registro, a.modelo, a.status AS status_aeronave, (SELECT cp.status FROM checklists_pre_voo cp WHERE cp.solicitacao_id = s.id ORDER BY cp.criado_em DESC LIMIT 1) AS checklist_status
      FROM solicitacoes_reserva_voo s
      LEFT JOIN cliente c ON c.id = s.cliente_id
      LEFT JOIN hold_socios so ON so.id = s.socio_id
      LEFT JOIN cliente ce ON ce.id = s.cliente_emprestimo_id
      LEFT JOIN hold_socios se ON se.id = s.socio_emprestimo_id
      LEFT JOIN cotista_aeronave ca ON (ca.cliente_id = s.cliente_id OR ca.socio_id = s.socio_id) AND ca.aeronave_id = s.aeronave_id
      LEFT JOIN cotista_aeronave cae ON (cae.cliente_id = s.cliente_emprestimo_id OR cae.socio_id = s.socio_emprestimo_id OR (se.cliente_id IS NOT NULL AND cae.cliente_id = se.cliente_id)) AND cae.aeronave_id = s.aeronave_id
      LEFT JOIN aeronave a ON a.id = s.aeronave_id
      WHERE date(s.data_agendada) BETWEEN ?1 AND ?2
      ORDER BY date(s.data_agendada), s.horario_previsto_agendamento, s.criado_em`).bind(inicio, fim).all().catch(error => { log.error('[agendamento] lançamentos indisponíveis', error); return { results: [] } }),
    db.prepare(`SELECT a.id, a.matricula_registro, a.fabricante, a.modelo, a.status, a.ano, a.base, a.url_imagem, a.tipo_aeronave, a.consumo_combustivel, a.velocidade_cruzeiro, p.categoria AS performance_categoria, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.teto_servico_ft AS performance_teto_servico_ft, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm
      FROM aeronave a
      LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1))
      ORDER BY a.matricula_registro`).all().catch(error => { log.error('[agendamento] aeronaves indisponíveis', error); return { results: [] } }),
    db.prepare("SELECT t.id, t.nome_completo, t.canac, t.status, t.tipo_licenca, up.url_avatar AS url_avatar, 'tripulacao' AS origem FROM tripulacao t LEFT JOIN user_profiles up ON up.id = t.user_id WHERE lower(COALESCE(t.status, 'ativo')) = 'ativo' ORDER BY t.nome_completo").all().catch(error => { log.error('[agendamento] tripulação indisponível', error); return { results: [] } }),
    db.prepare("SELECT id, nome_completo, canac, status, NULL AS tipo_licenca, url_avatar, 'freelancer' AS origem FROM tripulacao_freelancer WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo").all().catch(error => { log.error('[agendamento] freelancers indisponíveis', error); return { results: [] } }),
    db.prepare(`SELECT e.id, e.tripulacao_id AS tripulante_id,
        CASE WHEN EXISTS (SELECT 1 FROM tripulacao t WHERE t.id = e.tripulacao_id) THEN 'tripulacao' ELSE 'freelancer' END AS tripulante_origem,
        e.data_inicio, e.data_fim, e.status, e.observacoes
      FROM escala_tripulacao e
      WHERE date(e.data_inicio) <= date(?2) AND date(e.data_fim) >= date(?1)
      ORDER BY date(e.data_inicio), e.tripulacao_id`).bind(inicio, fim).all().catch(error => { log.error('[agendamento] disponibilidades indisponíveis', error); return { results: [] } }),
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
  return c.json({ inicio, fim, agendamentos: agendamentos.results, aeronave: aeronave.results, tripulacao: tripulantes, escala, disponibilidades: disponibilidades.results })
})

app.post('/api/interno/agendamento/disponibilidade', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaDisponibilidadeTripulacao(c)
  const body = await c.req.json<{ tripulante_id?: string; tripulante_origem?: 'tripulacao' | 'freelancer'; data_inicio?: string; data_fim?: string; status?: 'aviso' | 'ferias' | 'folga' | 'atestado_medico' | 'treinamento' | 'acompanhando_manutencao' | 'disponivel'; observacoes?: string }>().catch(() => null)
  const tripulanteId = body?.tripulante_id?.trim() || ''
  const dataInicio = body?.data_inicio?.trim() || ''
  const dataFim = body?.data_fim?.trim() || dataInicio
  const status = body?.status || 'disponivel'
  if (!tripulanteId || !dataInicio || !dataFim || !['aviso', 'ferias', 'folga', 'atestado_medico', 'treinamento', 'acompanhando_manutencao', 'disponivel'].includes(status)) return c.json({ error: 'tripulante_periodo_e_status_obrigatorios' }, 400)
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
  await garantirTabelaDisponibilidadeTripulacao(c)
  await garantirComplianceTripulacao(c)
  const body = await c.req.json<{ cliente_id?: string; socio_id?: string; aeronave_id?: string; origem?: string; destino?: string; data_agendada?: string; data_fim?: string; horario_previsto_agendamento?: string; dias_duracao?: number; numero_passageiros?: number; cliente_emprestimo_id?: string; socio_emprestimo_id?: string; voo_emprestado?: string; piloto_id?: string; copiloto_id?: string; observacoes?: string }>().catch(() => null)
  const origem = body?.origem?.trim().toUpperCase() || ''
  const destino = body?.destino?.trim().toUpperCase() || ''
  const dataAgendada = body?.data_agendada?.trim() || ''
  const dataFim = body?.data_fim?.trim() || dataAgendada
  const aeronaveId = body?.aeronave_id?.trim() || ''
  if (!origem || !destino || !dataAgendada || !dataFim || !aeronaveId) return c.json({ error: 'origem_destino_periodo_e_aeronave_obrigatorios' }, 400)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataAgendada) || !/^\d{4}-\d{2}-\d{2}$/.test(dataFim) || dataFim < dataAgendada) return c.json({ error: 'periodo_invalido' }, 400)
  const inicioMs = Date.parse(`${dataAgendada}T00:00:00Z`)
  const fimMs = Date.parse(`${dataFim}T00:00:00Z`)
  const diasDuracao = Math.floor((fimMs - inicioMs) / 86_400_000) + 1
  if (!Number.isFinite(diasDuracao) || diasDuracao < 1) return c.json({ error: 'periodo_invalido' }, 400)
  const aeronave = await portalDb(c).prepare('SELECT id FROM aeronave WHERE id = ?1').bind(aeronaveId).first<{ id: string }>()
  if (!aeronave) return c.json({ error: 'aeronave_nao_disponivel' }, 409)
  const cliente = body?.cliente_id ? await portalDb(c).prepare('SELECT id, codigo_cliente FROM cliente WHERE id = ?1').bind(body.cliente_id).first<{ id: string; codigo_cliente: string | null }>() : null
  const socio = body?.socio_id ? await portalDb(c).prepare('SELECT id, cotista_id, holding_id FROM hold_socios WHERE id = ?1').bind(body.socio_id).first<{ id: string; cotista_id: string; holding_id: string | null }>() : null
  if (!cliente && !socio) return c.json({ error: 'cliente_ou_socio_obrigatorio' }, 400)
  if (cliente && socio) return c.json({ error: 'selecione_cliente_ou_socio' }, 400)
  const clienteId = cliente?.id || null
  const clienteEmprestimoId = body?.cliente_emprestimo_id?.trim() || null
  const socioEmprestimoId = body?.socio_emprestimo_id?.trim() || null
  if (clienteEmprestimoId && socioEmprestimoId) return c.json({ error: 'selecione_apenas_um_cedente' }, 400)
  if (clienteEmprestimoId && clienteEmprestimoId === clienteId) return c.json({ error: 'cedente_deve_ser_diferente_do_titular' }, 400)
  if (socioEmprestimoId && socioEmprestimoId === socio?.id) return c.json({ error: 'cedente_deve_ser_diferente_do_titular' }, 400)
  const cedenteCliente = clienteEmprestimoId ? await portalDb(c).prepare('SELECT id FROM cliente WHERE id = ?1').bind(clienteEmprestimoId).first<{ id: string }>() : null
  const cedenteSocio = socioEmprestimoId ? await portalDb(c).prepare('SELECT id, cotista_id, holding_id FROM hold_socios WHERE id = ?1').bind(socioEmprestimoId).first<{ id: string; cotista_id: string; holding_id: string | null }>() : null
  if (clienteEmprestimoId && !cedenteCliente) return c.json({ error: 'cliente_emprestimo_nao_encontrado' }, 400)
  if (socioEmprestimoId && !cedenteSocio) return c.json({ error: 'socio_emprestimo_nao_encontrado' }, 400)
  const vinculoTitular = await portalDb(c).prepare('SELECT codigo_cliente FROM cotista_aeronave WHERE aeronave_id = ?1 AND (cliente_id = ?2 OR socio_id = ?3) AND codigo_cliente IS NOT NULL LIMIT 1').bind(aeronaveId, clienteId, socio?.id || null).first<{ codigo_cliente: string }>()
  const vinculoCedente = clienteEmprestimoId || socioEmprestimoId
    ? await portalDb(c).prepare('SELECT codigo_cliente FROM cotista_aeronave WHERE aeronave_id = ?1 AND (cliente_id = ?2 OR socio_id = ?3) AND codigo_cliente IS NOT NULL LIMIT 1').bind(aeronaveId, clienteEmprestimoId || null, socioEmprestimoId).first<{ codigo_cliente: string }>()
    : null
  const codigoCliente = (vinculoTitular?.codigo_cliente || vinculoCedente?.codigo_cliente || '').trim().toUpperCase()
  if (!codigoCliente) return c.json({ error: 'aeronave_sem_codigo_cotista' }, 409)
  const vooEmprestado = clienteEmprestimoId || socioEmprestimoId ? 'sim' : 'nao'
  const piloto = body?.piloto_id ? await buscarTripulante(c, body.piloto_id.trim()) : null
  const copiloto = body?.copiloto_id ? await buscarTripulante(c, body.copiloto_id.trim()) : null
  if (body?.piloto_id && !piloto) return c.json({ error: 'piloto_nao_encontrado' }, 400)
  if (body?.copiloto_id && !copiloto) return c.json({ error: 'copiloto_nao_encontrado' }, 400)
  if (body?.piloto_id && body?.copiloto_id && body.piloto_id === body.copiloto_id) return c.json({ error: 'tripulantes_iguais' }, 400)
  for (const assigned of [body?.piloto_id, body?.copiloto_id].filter((value): value is string => Boolean(value))) {
    const eligibility = await validarElegibilidadeTripulante(c, assigned, aeronaveId)
    if (eligibility) return c.json({ error: eligibility, tripulante_id: assigned }, 409)
  }
  const id = uuid()
  await portalDb(c).prepare(`INSERT INTO solicitacoes_reserva_voo (id, cliente_id, socio_id, cliente_emprestimo_id, socio_emprestimo_id, aeronave_id, voo_emprestado, origem, destino, data_agendada, horario_previsto_agendamento, dias_duracao, numero_passageiros, status, observacoes, piloto_id, copiloto_id, numero_voo, aprovado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, clienteId, socio?.id || null, clienteEmprestimoId, socioEmprestimoId, aeronaveId, vooEmprestado, origem, destino, dataAgendada, body?.horario_previsto_agendamento?.trim() || null, diasDuracao, Math.max(1, Number(body?.numero_passageiros || 1)), 'pendente', body?.observacoes?.trim() || null, null, null, null, null).run()
  return c.json({ id, status: 'pendente', numero_voo: null }, 201)
})

app.delete('/api/interno/agendamento/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaDisponibilidadeTripulacao(c)
  const id = c.req.param('id').trim()
  if (!id) return c.json({ error: 'agendamento_id_obrigatorio' }, 400)
  const db = portalDb(c)
  const agendamento = await db.prepare('SELECT cliente_id, socio_id, status, numero_voo FROM solicitacoes_reserva_voo WHERE id = ?1').bind(id).first<{ cliente_id: string | null; socio_id: string | null; status: string | null; numero_voo: string | null }>()
  if (!agendamento) return c.json({ error: 'agendamento_nao_encontrado' }, 404)
  await db.prepare('DELETE FROM escala_tripulacao WHERE solicitacao_id = ?1').bind(id).run().catch(() => undefined)
  const result = await db.prepare('DELETE FROM solicitacoes_reserva_voo WHERE id = ?1').bind(id).run()
  if (!result.meta.changes) return c.json({ error: 'agendamento_nao_encontrado' }, 404)
  if (agendamento.numero_voo) {
    const cotistaKey = agendamento.socio_id ? `socio:${agendamento.socio_id}` : agendamento.cliente_id ? `cliente:${agendamento.cliente_id}` : null
    if (cotistaKey) {
      const restante = await db.prepare(`SELECT id FROM solicitacoes_reserva_voo WHERE numero_voo IS NOT NULL AND status = 'aprovada' AND ((?1 IS NOT NULL AND socio_id = ?1) OR (?1 IS NULL AND socio_id IS NULL AND cliente_id = ?2)) LIMIT 1`).bind(agendamento.socio_id, agendamento.cliente_id).first<{ id: string }>()
      if (!restante) await db.prepare('DELETE FROM voo_sequencia_cotista WHERE cotista_key = ?1').bind(cotistaKey).run().catch(() => undefined)
    }
  }
  return c.json({ success: true, agendamento_id: id, sequencia_cotista_removida: Boolean(agendamento.numero_voo) })
})

async function garantirTabelaChecklist(c: Context<{ Bindings: Bindings }>) {
  void c
  return
  const db = portalDb(c)
  await db.prepare(`CREATE TABLE IF NOT EXISTS checklists_pre_voo (id TEXT PRIMARY KEY NOT NULL, solicitacao_id TEXT NULL, aeronave_id TEXT NULL, cliente_id TEXT NULL, status TEXT NOT NULL DEFAULT 'rascunho', precisa_abastecer INTEGER NULL, abastecimento_id TEXT NULL, respostas TEXT NOT NULL DEFAULT '{}', observacoes TEXT NULL, executado_por TEXT NULL, executado_por_nome TEXT NULL, concluido_em TEXT NULL, criado_por TEXT NULL, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, numero_voo TEXT NULL, nivel_oleo TEXT NULL, alerta_id TEXT NULL)`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS alerta_checklist (id TEXT PRIMARY KEY NOT NULL, checklists_pre_voo_id TEXT NULL, alerta1 TEXT NULL, alerta2 TEXT NULL, alerta3 TEXT NULL, alerta4 TEXT NULL, alerta5 TEXT NULL, alerta6 TEXT NULL, alerta7 TEXT NULL, alerta8 TEXT NULL, alerta9 TEXT NULL, alerta10 TEXT NULL, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
  // Compatibilidade: migra dados da tabela reduzida criada anteriormente, sem usá-la novamente.
  await db.prepare(`INSERT OR IGNORE INTO checklists_pre_voo (id, solicitacao_id, respostas, observacoes, abastecimento_id, status, executado_por, criado_em, atualizado_em, precisa_abastecer, nivel_oleo, alerta_id, concluido_em) SELECT id, solicitacao_id, itens, observacoes, abastecimento_id, status, usuario_id, criado_em, atualizado_em, precisa_abastecer, nivel_oleo, alerta_id, concluido_em FROM checklist_pre_voo`).run().catch(() => undefined)
}

app.get('/api/interno/agendamento/:id/checklist', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaChecklist(c)
  const row = await portalDb(c).prepare('SELECT id, solicitacao_id, respostas AS itens, observacoes, abastecimento_id, status, executado_por AS usuario_id, executado_por_nome, nivel_oleo, alerta_id, concluido_em FROM checklists_pre_voo WHERE solicitacao_id = ? ORDER BY criado_em DESC LIMIT 1').bind(c.req.param('id')).first<any>()
  if (!row) return c.json(null)
  const alertas = row.alerta_id ? await portalDb(c).prepare('SELECT alerta1, alerta2, alerta3, alerta4, alerta5, alerta6, alerta7, alerta8, alerta9, alerta10 FROM alerta_checklist WHERE id = ?').bind(row.alerta_id).first<any>() : null
  const alertasMap = Object.fromEntries(Object.entries(alertas || {}).filter(([key, value]) => key.startsWith('alerta') && String(value || '').trim()).map(([key, value]) => [key.replace(/^alerta/, ''), String(value).trim()]))
  return c.json({
    ...row,
    itens: JSON.parse(row.itens || '{}'),
    alertas: alertasMap,
  })
})
app.post('/api/interno/agendamento/:id/checklist', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaChecklist(c); await garantirTabelaAbastecimentos(c)
  const idAgendamento = c.req.param('id')
  const agendamento = await portalDb(c).prepare('SELECT * FROM solicitacoes_reserva_voo WHERE id = ?').bind(idAgendamento).first<any>()
  if (!agendamento) return c.notFound()
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as any))
  const userId = extractSupabaseUserId(c)
  const executor = userId ? await portalDb(c).prepare('SELECT COALESCE(nome_exibicao, nome_completo, email) AS nome FROM user_profiles WHERE id=?').bind(userId).first<{ nome: string }>() : null
  const userName = executor?.nome || userId || 'Usuário não identificado'
  const existente = await portalDb(c).prepare('SELECT id, abastecimento_id, alerta_id FROM checklists_pre_voo WHERE solicitacao_id = ? ORDER BY criado_em DESC LIMIT 1').bind(idAgendamento).first<{ id: string; abastecimento_id: string | null; alerta_id: string | null }>()
  const status = body.status || 'concluido'
  const precisaAbastecer = body.abastecimento?.necessita_abastecer === true || body.abastecimento?.necessita_abastecer === 'sim'
  const alertas = Object.entries(body.alertas || {}).filter(([, texto]) => String(texto || '').trim()).map(([item, texto]) => `${item}: ${String(texto).trim()}`).slice(0, 10)
  if (status === 'concluido' && alertas.length < Object.values(body.respostas || body.itens || {}).filter((resposta: any) => resposta?.status === 'alerta').length) return c.json({ error: 'justificativa_alerta_obrigatoria', detail: 'Todo item marcado como alerta precisa de uma justificativa.' }, 400)
  const a = body.abastecimento || {}
  if (status === 'concluido' && precisaAbastecer && (!a.data || !a.local || !a.tipo_combustivel || Number(a.litros) <= 0 || Number(a.valor_unitario) < 0)) {
    return c.json({ error: 'abastecimento_incompleto', detail: 'Para concluir o checklist, preencha data, tipo de combustível, local, litros e valor unitário do abastecimento.' }, 400)
  }
  let abastecimentoId = existente?.abastecimento_id || null
  if (precisaAbastecer && a.data && a.local && Number(a.litros) > 0) {
    let pagador = { cliente_id: a.cliente_id || agendamento.cliente_id || null, socio_id: a.socio_id || agendamento.socio_id || null }
    if (a.lancamento_diario_id) {
      const trecho = await portalDb(c).prepare('SELECT cliente_id, socio_id FROM lancamentos_diario_bordo WHERE id = ?1 AND aeronave_id = ?2').bind(a.lancamento_diario_id, agendamento.aeronave_id).first<{ cliente_id: string | null; socio_id: string | null }>()
      if (!trecho) return c.json({ error: 'trecho_diario_invalido', detail: 'O último trecho informado não pertence à aeronave deste agendamento.' }, 400)
      pagador = { cliente_id: trecho.cliente_id, socio_id: trecho.socio_id }
    }
    const prazoDias = Number(a.prazo_envio_cliente_dias || 0)
    const prazoEm = prazoDias > 0 ? new Date(Date.now() + prazoDias * 86400000).toISOString().slice(0, 10) : null
    const valores = [pagador.cliente_id, pagador.socio_id, agendamento.aeronave_id, a.data, a.tipo_combustivel, a.trecho || `${agendamento.origem} X ${agendamento.destino}`, a.local, a.numero_comanda || null, Number(a.litros), Number(a.valor_unitario), Math.max(0, Number(a.litros) * Number(a.valor_unitario) - Number(a.desconto || 0)), Number(a.desconto || 0), a.fornecedor_id || null, 'pendente', null, userId, a.lancamento_diario_id || null, agendamento.voo_emprestado === 'sim' ? 1 : 0, agendamento.numero_voo || null, prazoDias || null, prazoEm]
    const valoresInsert = [pagador.cliente_id, pagador.socio_id, agendamento.aeronave_id, a.data, a.tipo_combustivel, a.trecho || `${agendamento.origem} X ${agendamento.destino}`, a.local, a.numero_comanda || null, null, Number(a.litros), Number(a.valor_unitario), Math.max(0, Number(a.litros) * Number(a.valor_unitario) - Number(a.desconto || 0)), Number(a.desconto || 0), a.fornecedor_id || null, 'pendente', null, userId, a.lancamento_diario_id || null, agendamento.voo_emprestado === 'sim' ? 1 : 0, agendamento.numero_voo || null, prazoDias || null, prazoEm]
    if (abastecimentoId) {
      await portalDb(c).prepare(`UPDATE abastecimentos SET cliente_id=?, socio_id=?, aeronave_id=?, data=?, tipo_combustivel=?, trecho=?, local=?, numero_comanda=?, litros=?, valor_unitario=?, valor_total=?, desconto=?, fornecedor_id=?, status=?, observacao=?, criado_por=?, lancamento_diario_id=?, voo_emprestado=?, numero_voo=?, prazo_envio_cliente_dias=?, prazo_envio_cliente_em=? WHERE id=?`).bind(...valores, abastecimentoId).run()
    } else {
      abastecimentoId = uuid()
      await portalDb(c).prepare(`INSERT INTO abastecimentos (id, cliente_id, socio_id, aeronave_id, data, tipo_combustivel, trecho, local, numero_comanda, numero_nf, litros, valor_unitario, valor_total, desconto, fornecedor_id, status, observacao, criado_por, lancamento_diario_id, voo_emprestado, numero_voo, prazo_envio_cliente_dias, prazo_envio_cliente_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(abastecimentoId, ...valoresInsert).run()
    }
  } else if (status === 'concluido' && precisaAbastecer) {
    return c.json({ error: 'abastecimento_incompleto', detail: 'Salve os dados do abastecimento antes de concluir o checklist.' }, 400)
  }
  const nivelOleo = body.nivel_oleo == null ? null : String(body.nivel_oleo).trim() || null
  const alertaId = alertas.length ? (existente?.alerta_id || uuid()) : null
  if (alertas.length) {
    const campos = alertas.map((_, index) => `alerta${index + 1}`).join(', ')
    const marks = alertas.map(() => '?').join(', ')
    if (existente?.alerta_id) await portalDb(c).prepare(`UPDATE alerta_checklist SET ${alertas.map((_, index) => `alerta${index + 1} = ?`).join(', ')}, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`).bind(...alertas, alertaId).run()
    else await portalDb(c).prepare(`INSERT INTO alerta_checklist (id, checklists_pre_voo_id, ${campos}) VALUES (?, ?, ${marks})`).bind(alertaId, existente?.id || null, ...alertas).run()
  }
  const precisaValor = precisaAbastecer ? 1 : 0
  const concluidoEm = status === 'concluido' ? new Date().toISOString() : null
  if (existente) {
    await portalDb(c).prepare('UPDATE checklists_pre_voo SET executado_por=?, executado_por_nome=?, respostas=?, observacoes=?, abastecimento_id=?, precisa_abastecer=?, nivel_oleo=?, alerta_id=?, status=?, concluido_em=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').bind(userId, userName, JSON.stringify(body.itens || {}), body.observacoes || null, abastecimentoId, precisaValor, nivelOleo, alertaId, status, concluidoEm, existente.id).run()
    return c.json({ id: existente.id, solicitacao_id: idAgendamento, abastecimento_id: abastecimentoId })
  }
  const id = uuid(); if (alertaId) await portalDb(c).prepare('UPDATE alerta_checklist SET checklists_pre_voo_id=? WHERE id=?').bind(id, alertaId).run(); await portalDb(c).prepare('INSERT INTO checklists_pre_voo (id, solicitacao_id, aeronave_id, cliente_id, executado_por, executado_por_nome, respostas, observacoes, abastecimento_id, precisa_abastecer, nivel_oleo, alerta_id, status, concluido_em, numero_voo, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, idAgendamento, agendamento.aeronave_id || null, agendamento.cliente_id || null, userId, userName, JSON.stringify(body.itens || {}), body.observacoes || null, abastecimentoId, precisaValor, nivelOleo, alertaId, status, concluidoEm, agendamento.numero_voo || null, userId).run()
  return c.json({ id, solicitacao_id: idAgendamento, abastecimento_id: abastecimentoId }, 201)
})

async function garantirTabelaJornadas(c: Context<{ Bindings: Bindings }>) {
  void c
  return
  const db = portalDb(c)
  await db.prepare(`CREATE TABLE IF NOT EXISTS jornadas_voo (id TEXT PRIMARY KEY NOT NULL, solicitacao_id TEXT NULL, aeronave_id TEXT NOT NULL, tripulante_id TEXT NULL, data TEXT NOT NULL, horario_acionamento TEXT NULL, horario_apresentacao TEXT NULL, horario_corte_inicio TEXT NULL, horario_corte_final TEXT NULL, status TEXT NOT NULL DEFAULT 'em_rota', observacoes TEXT NULL, criado_por TEXT NULL, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP, numero_jornada INTEGER NOT NULL DEFAULT 1, data_jornada TEXT NOT NULL DEFAULT '', apresentacao_em TEXT NOT NULL DEFAULT '', inicio_em TEXT NULL, fim_em TEXT NULL, minutos_pos_corte INTEGER NOT NULL DEFAULT 45, nivel_alerta_jornada TEXT NOT NULL DEFAULT 'normal')`).run()
  for (const column of ['tripulante_id TEXT NULL', 'data TEXT NULL', 'horario_acionamento TEXT NULL', 'horario_apresentacao TEXT NULL', 'horario_corte_inicio TEXT NULL', 'horario_corte_final TEXT NULL']) await db.prepare(`ALTER TABLE jornadas_voo ADD COLUMN ${column}`).run().catch(() => undefined)
  await db.prepare(`CREATE TABLE IF NOT EXISTS pernas_jornada_voo (id TEXT PRIMARY KEY NOT NULL, jornada_id TEXT NOT NULL, numero INTEGER NOT NULL, origem TEXT NOT NULL, destino TEXT NOT NULL, horario_ac TEXT NULL, horario_dep TEXT NULL, horario_pouso TEXT NULL, horario_corte TEXT NULL, status TEXT NOT NULL DEFAULT 'em_voo', lancamento_diario_id TEXT NULL, criado_em TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
}
function minutosEntre(inicio: string | null, fim: string | null): number { if (!inicio || !fim) return 0; const a = new Date(inicio).getTime(), b = new Date(fim).getTime(); return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b-a)/60000) : 0 }
function normalizarHorarioJornada(data: string, valor: unknown): string | null {
  const texto = String(valor || '').trim()
  if (!texto) return null
  const iso = new Date(texto)
  if (/^\d{4}-\d{2}-\d{2}T/.test(texto) && Number.isFinite(iso.getTime())) return iso.toISOString()
  if (/^\d{2}:\d{2}(?::\d{2})?$/.test(texto)) {
    const dataIso = new Date(`${data}T${texto.length === 5 ? `${texto}:00` : texto}`)
    if (Number.isFinite(dataIso.getTime())) return dataIso.toISOString()
  }
  return null
}
app.get('/api/interno/agendamento/:id/jornada', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401); await garantirTabelaJornadas(c)
  const jornada = await portalDb(c).prepare('SELECT * FROM jornadas_voo WHERE solicitacao_id = ? ORDER BY criado_em DESC LIMIT 1').bind(c.req.param('id')).first<any>()
  if (!jornada) return c.json(null); const pernas = await portalDb(c).prepare('SELECT * FROM pernas_jornada_voo WHERE jornada_id = ? ORDER BY numero').bind(jornada.id).all<any>(); return c.json({ ...jornada, pernas: pernas.results })
})
app.post('/api/interno/agendamento/:id/jornada', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401); await garantirTabelaJornadas(c); const idSolicitacao=c.req.param('id'); const body=await c.req.json<Record<string,any>>().catch(() => ({} as Record<string, any>)); const voo=await portalDb(c).prepare('SELECT aeronave_id, piloto_id, data_agendada FROM solicitacoes_reserva_voo WHERE id=?').bind(idSolicitacao).first<any>(); if(!voo) return c.notFound()
  const data=String(body.data||voo.data_agendada||''); const acionamento=normalizarHorarioJornada(data, body.horario_acionamento); if(!/^\d{4}-\d{2}-\d{2}$/.test(data)||!acionamento) return c.json({error:'data_e_acionamento_obrigatorios'},400)
  const apresentacao=normalizarHorarioJornada(data, body.horario_apresentacao) || new Date(new Date(acionamento).getTime()-30*60000).toISOString(); const corteInicio=normalizarHorarioJornada(data, body.horario_corte_inicio); const id=uuid(); const numero=await portalDb(c).prepare('SELECT COALESCE(MAX(numero_jornada),0)+1 AS proximo FROM jornadas_voo WHERE solicitacao_id=?').bind(idSolicitacao).first<{ proximo: number }>(); await portalDb(c).prepare('INSERT INTO jornadas_voo (id, solicitacao_id, aeronave_id, numero_jornada, data_jornada, apresentacao_em, inicio_em, minutos_pos_corte, status, observacoes, criado_por, tripulante_id, data, horario_acionamento, horario_apresentacao, horario_corte_inicio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id,idSolicitacao,voo.aeronave_id,Number(numero?.proximo||1),data,apresentacao,acionamento,45,'em_rota',body.observacoes||null,extractSupabaseUserId(c),body.tripulante_id||voo.piloto_id||null,data,acionamento,apresentacao,corteInicio).run(); return c.json({id,status:'em_rota',data,horario_acionamento:acionamento,horario_apresentacao:apresentacao,pernas:[]},201)
})
app.patch('/api/interno/jornadas/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({error:'internal_auth_required'},401); await garantirTabelaJornadas(c); const id=c.req.param('id'); const body=await c.req.json<Record<string,any>>().catch(() => ({} as Record<string, any>)); const atual=await portalDb(c).prepare('SELECT * FROM jornadas_voo WHERE id=?').bind(id).first<any>(); if(!atual) return c.notFound(); const fim=body.horario_corte_final||atual.horario_corte_final; if(body.status==='encerrada' && !fim) return c.json({error:'corte_final_obrigatorio'},400); if(body.status==='encerrada' && minutosEntre(atual.horario_apresentacao||atual.horario_acionamento,fim)>540) return c.json({error:'limite_jornada_9_horas_excedido',detail:'A jornada ultrapassa o limite de 9 horas.'},409); if (body.status === 'encerrada' && atual.tripulante_id) { const db=portalDb(c); const minutos= minutosEntre(atual.horario_apresentacao||atual.horario_acionamento,fim); const semana=await db.prepare("SELECT COALESCE(SUM((julianday(horario_corte_final)-julianday(horario_apresentacao))*1440),0) minutos FROM jornadas_voo WHERE tripulante_id=? AND status='encerrada' AND date(data)>=date(?,'-6 days') AND date(data)<=date(?)").bind(atual.tripulante_id,atual.data,atual.data).first<any>(); const mes=await db.prepare("SELECT COALESCE(SUM((julianday(horario_corte_final)-julianday(horario_apresentacao))*1440),0) minutos FROM jornadas_voo WHERE tripulante_id=? AND status='encerrada' AND strftime('%Y-%m',data)=strftime('%Y-%m',?)").bind(atual.tripulante_id,atual.data).first<any>(); if(Number(semana?.minutos||0)+minutos>2640) return c.json({error:'limite_jornada_semanal_excedido',detail:'O tripulante ultrapassaria 44 horas na semana.'},409); if(Number(mes?.minutos||0)+minutos>10560) return c.json({error:'limite_jornada_mensal_excedido',detail:'O tripulante ultrapassaria 176 horas no mês.'},409); } await portalDb(c).prepare('UPDATE jornadas_voo SET horario_acionamento=?, horario_apresentacao=?, horario_corte_inicio=?, horario_corte_final=?, data=?, status=?, observacoes=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').bind(body.horario_acionamento||atual.horario_acionamento,body.horario_apresentacao||atual.horario_apresentacao,body.horario_corte_inicio||atual.horario_corte_inicio,fim,body.data||atual.data,body.status||atual.status,body.observacoes||atual.observacoes,id).run(); return c.json(await portalDb(c).prepare('SELECT * FROM jornadas_voo WHERE id=?').bind(id).first())
})
app.post('/api/interno/jornadas/:id/pernas', async c => {
  if (!(await requireShareInternal(c))) return c.json({error:'internal_auth_required'},401); await garantirTabelaJornadas(c); const id=c.req.param('id'); const jornada=await portalDb(c).prepare('SELECT * FROM jornadas_voo WHERE id=?').bind(id).first<any>(); if(!jornada) return c.notFound(); const b=await c.req.json<Record<string,any>>().catch(() => ({} as Record<string, any>)); const data=String(b.data||jornada.data); if(data!==String(jornada.data) && !b.virada_hora) return c.json({error:'perna_data_diferente_jornada',detail:'Uma nova perna precisa ocorrer no mesmo dia da jornada, salvo virada de hora autorizada.'},409); if(!b.origem||!b.destino||!b.horario_ac||!b.horario_dep) return c.json({error:'origem_destino_ac_dep_obrigatorios'},400); const last=await portalDb(c).prepare('SELECT COALESCE(MAX(numero),0) n FROM pernas_jornada_voo WHERE jornada_id=?').bind(id).first<any>(); const pernaId=uuid(); await portalDb(c).prepare('INSERT INTO pernas_jornada_voo (id,jornada_id,numero,origem,destino,horario_ac,horario_dep,horario_pouso,horario_corte,status) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(pernaId,id,Number(last?.n||0)+1,b.origem,b.destino,b.horario_ac,b.horario_dep,b.horario_pouso||null,b.horario_corte||null,b.horario_corte?'pousado':'em_voo').run(); return c.json({id:pernaId,status:b.horario_corte?'pousado':'em_voo'},201)
})
app.patch('/api/interno/jornadas/:jornadaId/pernas/:pernaId', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaJornadas(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const perna = await portalDb(c).prepare('SELECT * FROM pernas_jornada_voo WHERE id = ? AND jornada_id = ?').bind(c.req.param('pernaId'), c.req.param('jornadaId')).first<any>()
  if (!perna) return c.notFound()
  const campos: Record<string, string> = { origem: 'origem', destino: 'destino', horario_ac: 'horario_ac', horario_dep: 'horario_dep', horario_pouso: 'horario_pouso', horario_corte: 'horario_corte' }
  const updates = Object.entries(campos).filter(([campo]) => body[campo] !== undefined)
  if (!updates.length) return c.json({ id: perna.id, status: perna.status })
  const valores = updates.map(([campo]) => body[campo] || null)
  const horarioCorte = body.horario_corte !== undefined ? body.horario_corte || null : perna.horario_corte
  const status = body.status || (horarioCorte ? 'pousado' : perna.status)
  await portalDb(c).prepare(`UPDATE pernas_jornada_voo SET ${updates.map(([, coluna]) => `${coluna} = ?`).join(', ')}, status = ? WHERE id = ? AND jornada_id = ?`).bind(...valores, status, perna.id, c.req.param('jornadaId')).run()
  return c.json(await portalDb(c).prepare('SELECT * FROM pernas_jornada_voo WHERE id = ?').bind(perna.id).first())
})
app.get('/api/interno/solicitacoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaChecklist(c)
  const status = c.req.query('status')
  const query = status ? "SELECT s.*, c.razao_social AS cliente_razao_social, c.codigo_cliente, a.matricula_registro, a.modelo, (SELECT cp.status FROM checklists_pre_voo cp WHERE cp.solicitacao_id = s.id ORDER BY cp.criado_em DESC LIMIT 1) AS checklist_status FROM solicitacoes_reserva_voo s LEFT JOIN cliente c ON c.id = s.cliente_id LEFT JOIN aeronave a ON a.id = s.aeronave_id WHERE s.status = ?1 ORDER BY s.data_agendada" : "SELECT s.*, c.razao_social AS cliente_razao_social, c.codigo_cliente, a.matricula_registro, a.modelo, (SELECT cp.status FROM checklists_pre_voo cp WHERE cp.solicitacao_id = s.id ORDER BY cp.criado_em DESC LIMIT 1) AS checklist_status FROM solicitacoes_reserva_voo s LEFT JOIN cliente c ON c.id = s.cliente_id LEFT JOIN aeronave a ON a.id = s.aeronave_id ORDER BY s.data_agendada"
  const result = status ? await portalDb(c).prepare(query).bind(status).all() : await portalDb(c).prepare(query).all()
  return c.json(result.results)
})

app.post('/api/interno/seguranca/migrar-senhas', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const rows = await portalDb(c).prepare("SELECT id, senha FROM user_cliente WHERE senha NOT LIKE 'pbkdf2_sha256$%'").all<{ id: string; senha: string }>()
  for (const row of rows.results) await portalDb(c).prepare('UPDATE user_cliente SET senha = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(await portalCreatePasswordHash(row.senha), row.id).run()
  return c.json({ success: true, migrated: rows.results.length })
})

async function garantirTabelaSequenciaVoos(c: Context<{ Bindings: Bindings }>): Promise<void> {
  void c
  return
  await portalDb(c).prepare(`CREATE TABLE IF NOT EXISTS voo_sequencia_cotista (cotista_key TEXT PRIMARY KEY NOT NULL, ultimo_numero INTEGER NOT NULL DEFAULT 0)`).run()
}
async function portalFlightSequence(c: Context<{ Bindings: Bindings }>, clientCode: string, cotistaKey: string): Promise<string> {
  const sequence = await portalDb(c).prepare(`INSERT INTO voo_sequencia_cotista (cotista_key, ultimo_numero) VALUES (?1, 1)
    ON CONFLICT(cotista_key) DO UPDATE SET ultimo_numero = ultimo_numero + 1
    RETURNING ultimo_numero`).bind(cotistaKey).first<{ ultimo_numero: number }>()
  if (!sequence) throw new Error('flight_sequence_not_initialized')
  const codigo = clientCode.trim().toUpperCase().slice(0, 3)
  const ano = String(new Date().getFullYear()).slice(-2)
  return `${codigo}-${String(sequence.ultimo_numero).padStart(4, '0')}/${ano}`
}
function portalAircraftSuffix(registration: string | null | undefined): string {
  const normalized = String(registration ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return normalized.replace(/^PR/, '').slice(-3) || 'AER'
}
function portalLoanFlightNumber(clientCode: string, registration: string | null | undefined, sequence: number): string {
  const codigo = clientCode.trim().toUpperCase().slice(0, 3)
  const ano = String(new Date().getFullYear()).slice(-2)
  return `${codigo}-${portalAircraftSuffix(registration)}${String(sequence).padStart(3, '0')}/${ano}`
}
async function portalLoanFlightSequence(c: Context<{ Bindings: Bindings }>, clientCode: string, registration: string | null | undefined, cotistaKey: string): Promise<string> {
  const sequence = await portalDb(c).prepare(`INSERT INTO voo_sequencia_cotista (cotista_key, ultimo_numero) VALUES (?1, 1)
    ON CONFLICT(cotista_key) DO UPDATE SET ultimo_numero = ultimo_numero + 1
    RETURNING ultimo_numero`).bind(cotistaKey).first<{ ultimo_numero: number }>()
  if (!sequence) throw new Error('flight_sequence_not_initialized')
  return portalLoanFlightNumber(clientCode, registration, sequence.ultimo_numero)
}

app.post('/api/interno/solicitacoes/:id/aprovar', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaDisponibilidadeTripulacao(c)
  await garantirComplianceTripulacao(c)
  const id = c.req.param('id')
  await garantirTabelaSequenciaVoos(c)
  const reservation = await portalDb(c).prepare(`SELECT s.*, a.matricula_registro
    FROM solicitacoes_reserva_voo s
    LEFT JOIN aeronave a ON a.id = s.aeronave_id
    WHERE s.id = ?1`).bind(id).first<{ status: string; cliente_id: string | null; socio_id: string | null; matricula_registro: string | null; aeronave_id: string; cliente_emprestimo_id: string | null; socio_emprestimo_id: string | null; voo_emprestado: string | null }>()
  if (!reservation) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  if (reservation.status !== 'pendente') return c.json({ error: 'solicitacao_nao_pendente' }, 409)
  const body = await c.req.json<{ piloto_id?: string; copiloto_id?: string }>().catch(() => ({} as { piloto_id?: string; copiloto_id?: string }))
  if (!body.piloto_id) return c.json({ error: 'piloto_obrigatorio' }, 400)
  if (body.copiloto_id && body.copiloto_id === body.piloto_id) return c.json({ error: 'tripulantes_iguais' }, 400)
  const piloto = await buscarTripulante(c, body.piloto_id)
  const copiloto = body.copiloto_id ? await buscarTripulante(c, body.copiloto_id) : null
  if (!piloto) return c.json({ error: 'piloto_nao_encontrado' }, 400)
  if (body.copiloto_id && !copiloto) return c.json({ error: 'copiloto_nao_encontrado' }, 400)
  for (const assigned of [body.piloto_id, body.copiloto_id].filter((value): value is string => Boolean(value))) {
    const eligibility = await validarElegibilidadeTripulante(c, assigned, (reservation as any).aeronave_id)
    if (eligibility) return c.json({ error: eligibility, tripulante_id: assigned }, 409)
  }
  const isLoan = Boolean(reservation.cliente_emprestimo_id || reservation.socio_emprestimo_id) || ['sim', 'true', '1'].includes(String(reservation.voo_emprestado).toLowerCase())
  const cotistaQuery = isLoan
    ? `SELECT ca.codigo_cliente, ca.socio_id
       FROM cotista_aeronave ca
       WHERE ca.codigo_cliente IS NOT NULL
         AND (ca.socio_id = ?1 OR ca.cliente_id = ?2)
       ORDER BY CASE WHEN ca.socio_id = ?1 THEN 0 WHEN ca.cliente_id = ?2 THEN 1 ELSE 2 END
       LIMIT 1`
    : `SELECT ca.codigo_cliente, ca.socio_id
       FROM cotista_aeronave ca
       WHERE ca.aeronave_id = ?3 AND ca.codigo_cliente IS NOT NULL
         AND (ca.socio_id = ?1 OR ca.cliente_id = ?2)
       ORDER BY CASE WHEN ca.socio_id = ?1 THEN 0 WHEN ca.cliente_id = ?2 THEN 1 ELSE 2 END
       LIMIT 1`
  const cotistaStatement = portalDb(c).prepare(cotistaQuery)
  const cotista = isLoan
    ? await cotistaStatement.bind(reservation.socio_id, reservation.cliente_id).first<{ codigo_cliente: string; socio_id: string | null }>()
    : await cotistaStatement.bind(reservation.socio_id, reservation.cliente_id, reservation.aeronave_id).first<{ codigo_cliente: string; socio_id: string | null }>()
  if (!cotista?.codigo_cliente?.trim()) return c.json({ error: 'codigo_cotista_nao_encontrado', detail: isLoan ? 'Voo emprestado: nenhum codigo_cliente foi encontrado para o cotista tomador, independentemente da aeronave cedida.' : 'Nenhum registro em cotista_aeronave possui codigo_cliente para esta aeronave e este cliente/socio.', solicitacao_id: id, cliente_id: reservation.cliente_id, socio_id: reservation.socio_id, aeronave_id: reservation.aeronave_id, voo_emprestado: isLoan }, 409)
  const cotistaKey = cotista.socio_id ? `socio:${cotista.socio_id}` : `cliente:${reservation.cliente_id}`
  const flightNumber = isLoan
    ? await portalLoanFlightSequence(c, cotista.codigo_cliente, reservation.matricula_registro, cotistaKey)
    : await portalFlightSequence(c, cotista.codigo_cliente, cotistaKey)
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




// ─── Operações: abastecimentos ─────────────────────────────────────────────
async function garantirTabelaAbastecimentos(c: Context<{ Bindings: Bindings }>) {
  void c
  return
  await portalDb(c).prepare(`CREATE TABLE IF NOT EXISTS abastecimentos (
    id TEXT PRIMARY KEY NOT NULL,
    cliente_id TEXT NULL, socio_id TEXT NULL, aeronave_id TEXT NULL,
    data TEXT NOT NULL, tipo_combustivel TEXT NULL, trecho TEXT NULL, local TEXT NOT NULL,
    numero_comanda TEXT NULL, numero_nf TEXT NULL, litros REAL NOT NULL DEFAULT 0,
    valor_unitario REAL NOT NULL DEFAULT 0, valor_total REAL NOT NULL DEFAULT 0, desconto REAL NULL,
    comanda_url TEXT NULL, nota_url TEXT NULL, boleto_url TEXT NULL, fornecedor_id TEXT NULL,
    status TEXT NULL, observacao TEXT NULL, forma_pagamento TEXT NULL, data_vencimento_boleto TEXT NULL,
    criado_por TEXT NULL, lancamento_diario_id TEXT NULL, data_pagamento TEXT NULL, banco TEXT NULL,
    voo_emprestado INTEGER NOT NULL DEFAULT 0, numero_voo TEXT NULL
  )`).run()
  await portalDb(c).prepare('ALTER TABLE abastecimentos ADD COLUMN prazo_envio_cliente_dias INTEGER NULL').run().catch(() => undefined)
  await portalDb(c).prepare('ALTER TABLE abastecimentos ADD COLUMN prazo_envio_cliente_em TEXT NULL').run().catch(() => undefined)
}

async function garantirTabelaRelatorioDespesaViagem(c: Context<{ Bindings: Bindings }>) {
  void c
  return
  await portalDb(c).prepare(`CREATE TABLE IF NOT EXISTS relatorio_despesa_viagem_anexos (
    id TEXT PRIMARY KEY NOT NULL,
    relatorio_despesa_viagem_id TEXT NOT NULL,
    indice_despesa INTEGER NOT NULL DEFAULT 0,
    nome_arquivo TEXT NOT NULL,
    caminho_arquivo TEXT NOT NULL,
    url_arquivo TEXT NOT NULL,
    tipo_arquivo TEXT,
    tamanho_arquivo INTEGER,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run()
  await portalDb(c).prepare(`CREATE TABLE IF NOT EXISTS relatorio_despesa_viagem (
    id TEXT PRIMARY KEY NOT NULL,
    numero_relatorio TEXT NOT NULL,
    numero_voo TEXT,
    cliente_id TEXT,
    socio_id TEXT,
    aeronave_id TEXT,
    rota TEXT,
    data_inicio TEXT NOT NULL,
    data_fim TEXT NOT NULL,
    quantidade_dias INTEGER NOT NULL DEFAULT 1,
    tripulacao_id TEXT,
    nome_tripulante TEXT,
    tripulante_id_2 TEXT,
    nome_tripulante_2 TEXT,
    despesas TEXT NOT NULL DEFAULT '[]',
    total_valor REAL NOT NULL DEFAULT 0,
    observacoes TEXT,
    status TEXT NOT NULL DEFAULT 'rascunho',
    pdf_url TEXT,
    criado_por TEXT,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run()
  await portalDb(c).prepare('ALTER TABLE relatorio_despesa_viagem ADD COLUMN socio_id TEXT').run().catch(() => undefined)
  await portalDb(c).prepare('ALTER TABLE relatorio_despesa_viagem ADD COLUMN tripulante_id_2 TEXT').run().catch(() => undefined)
  await portalDb(c).prepare('ALTER TABLE relatorio_despesa_viagem ADD COLUMN nome_tripulante_2 TEXT').run().catch(() => undefined)
  await portalDb(c).prepare('ALTER TABLE relatorio_despesa_viagem ADD COLUMN pdf_url TEXT').run().catch(() => undefined)
}

function despesasRelatorioViagem(valor: unknown) {
  if (Array.isArray(valor)) return valor
  try { const parsed = JSON.parse(String(valor || '[]')); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}

function statusRelatorioViagem(valor: unknown) {
  const normalizado = String(valor || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_')
  const validos = new Set(['rascunho', 'finalizado', 'aguardando_aprovacao', 'ajuste_necessario', 'aprovado', 'enviado_cliente'])
  return validos.has(normalizado) ? normalizado : String(valor || 'rascunho')
}

function numeroRelatorioViagem() {
  return `RV-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
}

async function buscarRelatorioViagemComNomes(c: Context<{ Bindings: Bindings }>, id: string): Promise<(Record<string, any> & { despesas: any[] }) | null> {
  const row = await portalDb(c).prepare(`SELECT r.*,
      c.razao_social AS cliente_nome,
      a.matricula_registro AS aeronave_matricula,
      COALESCE(NULLIF(r.nome_tripulante, ''), t1.nome_completo, f1.nome_completo) AS nome_tripulante,
      COALESCE(NULLIF(r.nome_tripulante_2, ''), t2.nome_completo, f2.nome_completo) AS nome_tripulante_2
    FROM relatorio_despesa_viagem r
    LEFT JOIN cliente c ON c.id = r.cliente_id
    LEFT JOIN aeronave a ON a.id = r.aeronave_id
    LEFT JOIN tripulacao t1 ON t1.id = r.tripulacao_id
    LEFT JOIN tripulacao_freelancer f1 ON f1.id = r.tripulacao_id
    LEFT JOIN tripulacao t2 ON t2.id = r.tripulante_id_2
    LEFT JOIN tripulacao_freelancer f2 ON f2.id = r.tripulante_id_2
    WHERE r.id = ?1`).bind(id).first<Record<string, any>>()
  return row ? { ...row, status: statusRelatorioViagem(row.status), despesas: despesasRelatorioViagem(row.despesas) } : null
}

app.get('/api/financeiro/relatorios-despesa-viagem/opcoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const db = portalDb(c)
  const [clientes, aeronave, tripulacao, freelancers, voos, socios] = await Promise.all([
    db.prepare("SELECT id, razao_social, codigo_cliente FROM cliente WHERE lower(COALESCE(status, 'ativo')) NOT IN ('inativo', 'cancelado') ORDER BY razao_social").all(),
    db.prepare("SELECT id, matricula_registro, fabricante, modelo, status FROM aeronave WHERE lower(COALESCE(status, 'ativo')) NOT IN ('inativa', 'cancelada') ORDER BY matricula_registro").all(),
    db.prepare("SELECT id, nome_completo, canac, status, 'tripulacao' AS origem FROM tripulacao WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo").all(),
    db.prepare("SELECT id, nome_completo, canac, status, 'freelancer' AS origem FROM tripulacao_freelancer WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo").all(),
    db.prepare('SELECT numero_voo, MAX(data_registro) AS data_agendada FROM lancamentos_diario_bordo WHERE numero_voo IS NOT NULL AND trim(numero_voo) <> \'\' GROUP BY numero_voo ORDER BY data_agendada DESC LIMIT 200').all(),
    db.prepare('SELECT id, nome FROM hold_socios ORDER BY nome').all(),
  ])
  return c.json({ clientes: clientes.results, aeronave: aeronave.results, tripulantes: [...tripulacao.results, ...freelancers.results], voos: voos.results, socios: socios.results })
})

app.get('/api/financeiro/relatorios-despesa-viagem', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const rows = await portalDb(c).prepare(`SELECT r.*, c.razao_social AS cliente_nome, a.matricula_registro AS aeronave_matricula,
      COALESCE(NULLIF(r.nome_tripulante, ''), t1.nome_completo, f1.nome_completo) AS nome_tripulante,
      COALESCE(NULLIF(r.nome_tripulante_2, ''), t2.nome_completo, f2.nome_completo) AS nome_tripulante_2
    FROM relatorio_despesa_viagem r
    LEFT JOIN cliente c ON c.id = r.cliente_id
    LEFT JOIN aeronave a ON a.id = r.aeronave_id
    LEFT JOIN tripulacao t1 ON t1.id = r.tripulacao_id
    LEFT JOIN tripulacao_freelancer f1 ON f1.id = r.tripulacao_id
    LEFT JOIN tripulacao t2 ON t2.id = r.tripulante_id_2
    LEFT JOIN tripulacao_freelancer f2 ON f2.id = r.tripulante_id_2
    ORDER BY r.atualizado_em DESC, r.criado_em DESC`).all()
  return c.json({ relatorios: (rows.results as any[]).map((row) => ({ ...row, status: statusRelatorioViagem(row.status), despesas: despesasRelatorioViagem(row.despesas) })) })
})

app.get('/api/financeiro/relatorios-despesa-viagem/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const row = await buscarRelatorioViagemComNomes(c, c.req.param('id'))
  return row ? c.json({ relatorio: row }) : c.notFound()
})

app.post('/api/financeiro/relatorios-despesa-viagem', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const inicio = String(body.data_inicio || '').trim(); const fim = String(body.data_fim || inicio).trim()
  if (!inicio || !fim || !body.cliente_id || !body.aeronave_id) return c.json({ error: 'cliente_aeronave_e_periodo_obrigatorios' }, 400)
  const despesas = despesasRelatorioViagem(body.despesas)
  const total = despesas.reduce((soma: number, item: any) => soma + (Number(item.valor) || 0), 0)
  const id = uuid(); const numero = String(body.numero_relatorio || '').trim() || numeroRelatorioViagem()
  await portalDb(c).prepare(`INSERT INTO relatorio_despesa_viagem (id, numero_relatorio, numero_voo, cliente_id, socio_id, aeronave_id, rota, data_inicio, data_fim, quantidade_dias, tripulacao_id, nome_tripulante, tripulante_id_2, nome_tripulante_2, despesas, total_valor, observacoes, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, numero, body.numero_voo || null, body.cliente_id, body.socio_id || null, body.aeronave_id, body.rota || null, inicio, fim, Number(body.quantidade_dias || 1), body.tripulacao_id || null, body.nome_tripulante || null, body.tripulante_id_2 || null, body.nome_tripulante_2 || null, JSON.stringify(despesas), total, body.observacoes || null, user.id).run()
  return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, id) }, 201)
})

app.patch('/api/financeiro/relatorios-despesa-viagem/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const current = await buscarRelatorioViagemComNomes(c, c.req.param('id'))
  if (!current) return c.notFound()
  if (['aguardando_aprovacao', 'aprovado', 'enviado_cliente'].includes(String(current.status))) return c.json({ error: 'relatorio_bloqueado' }, 409)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const despesas = despesasRelatorioViagem(body.despesas ?? current.despesas)
  const total = despesas.reduce((soma: number, item: any) => soma + (Number(item.valor) || 0), 0)
  await portalDb(c).prepare(`UPDATE relatorio_despesa_viagem SET numero_relatorio = ?, numero_voo = ?, cliente_id = ?, socio_id = ?, aeronave_id = ?, rota = ?, data_inicio = ?, data_fim = ?, quantidade_dias = ?, tripulacao_id = ?, nome_tripulante = ?, tripulante_id_2 = ?, nome_tripulante_2 = ?, despesas = ?, total_valor = ?, observacoes = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(body.numero_relatorio ?? current.numero_relatorio, body.numero_voo ?? current.numero_voo, body.cliente_id ?? current.cliente_id, body.socio_id ?? current.socio_id, body.aeronave_id ?? current.aeronave_id, body.rota ?? current.rota, body.data_inicio ?? current.data_inicio, body.data_fim ?? current.data_fim, Number(body.quantidade_dias ?? current.quantidade_dias ?? 1), body.tripulacao_id ?? current.tripulacao_id, body.nome_tripulante ?? current.nome_tripulante, body.tripulante_id_2 ?? current.tripulante_id_2, body.nome_tripulante_2 ?? current.nome_tripulante_2, JSON.stringify(despesas), total, body.observacoes ?? current.observacoes, c.req.param('id')).run()
  return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, c.req.param('id')) })
})

app.post('/api/financeiro/relatorios-despesa-viagem/:id/finalizar', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const result = await portalDb(c).prepare("UPDATE relatorio_despesa_viagem SET status = 'finalizado', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('rascunho', 'ajuste_necessario')").bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.json({ error: 'relatorio_nao_pode_ser_finalizado' }, 409)
  return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, c.req.param('id')) })
})

app.post('/api/financeiro/relatorios-despesa-viagem/:id/enviar-aprovacao', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const body = await c.req.json<{ tripulante_pos?: number }>().catch(() => ({} as { tripulante_pos?: number }))
  const result = await portalDb(c).prepare("UPDATE relatorio_despesa_viagem SET status = 'aguardando_aprovacao', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('finalizado', 'ajuste_necessario')").bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.json({ error: 'relatorio_nao_pode_ser_enviado' }, 409)
  return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, c.req.param('id')), enviado_para: body.tripulante_pos || 1 })
})

app.post('/api/financeiro/relatorios-despesa-viagem/:id/aprovacao', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const body = await c.req.json<{ aprovado?: boolean; observacoes?: string }>().catch(() => ({} as { aprovado?: boolean; observacoes?: string }))
  const status = body.aprovado ? 'aprovado' : 'ajuste_necessario'
  await portalDb(c).prepare('UPDATE relatorio_despesa_viagem SET status = ?, observacoes = COALESCE(?, observacoes), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(status, body.observacoes || null, c.req.param('id')).run()
  return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, c.req.param('id')) })
})

app.post('/api/financeiro/relatorios-despesa-viagem/:id/enviar-cliente', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const id = c.req.param('id')
  const atual = await buscarRelatorioViagemComNomes(c, id)
  if (!atual) return c.notFound()
  if (String(atual.status) === 'enviado_cliente') return c.json({ success: true, status: 'enviado_cliente', message: 'Relatório já enviado ao cliente.' })
  if (String(atual.status) !== 'aprovado') return c.json({ error: 'relatorio_nao_aprovado' }, 409)
  const result = await portalDb(c).prepare("UPDATE relatorio_despesa_viagem SET status = 'enviado_cliente', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = 'aprovado'").bind(id).run()
  if (!result.meta.changes) return c.json({ error: 'relatorio_nao_pode_ser_enviado' }, 409)
  return c.json({ success: true, status: 'enviado_cliente', message: 'Relatório enviado ao cliente.', relatorio: await buscarRelatorioViagemComNomes(c, id) })
})

app.post('/api/financeiro/relatorios-despesa-viagem/:id/pdf', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const reportId = c.req.param('id')
  const report = await portalDb(c).prepare('SELECT id FROM relatorio_despesa_viagem WHERE id = ?').bind(reportId).first()
  if (!report) return c.notFound()
  const form = await c.req.parseBody(); const file = form.arquivo
  if (!(file instanceof File) || !file.size || file.type !== 'application/pdf') return c.json({ error: 'pdf_obrigatorio' }, 400)
  const key = await salvarArquivoShareBrasil(c, user.id, file, 'relatorio_despesa_viagem/pdf')
  const fileUrl = new URL(`/api/financeiro/relatorios-despesa-viagem/${encodeURIComponent(reportId)}/pdf/arquivo`, c.req.url)
  await portalDb(c).prepare('UPDATE relatorio_despesa_viagem SET pdf_url = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(fileUrl.toString(), reportId).run()
  await portalDb(c).prepare('INSERT OR REPLACE INTO relatorio_despesa_viagem_anexos (id, relatorio_despesa_viagem_id, indice_despesa, nome_arquivo, caminho_arquivo, url_arquivo, tipo_arquivo, tamanho_arquivo) VALUES (?, ?, -1, ?, ?, ?, ?, ?)').bind(`pdf:${reportId}`, reportId, file.name, key, fileUrl.toString(), file.type, file.size).run()
  return c.json({ pdf_url: fileUrl.toString(), pdf_path: key })
})

app.get('/api/financeiro/relatorios-despesa-viagem/:id/pdf/arquivo', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const row = await portalDb(c).prepare("SELECT caminho_arquivo, nome_arquivo, tipo_arquivo FROM relatorio_despesa_viagem_anexos WHERE relatorio_despesa_viagem_id = ? AND indice_despesa = -1").bind(c.req.param('id')).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string | null }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo || 'application/pdf', 'Content-Disposition': `inline; filename="${shareBrasilFileName(row.nome_arquivo)}"` } })
})

app.post('/api/financeiro/relatorios-despesa-viagem/:id/anexos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const reportId = c.req.param('id')
  const report = await portalDb(c).prepare('SELECT id FROM relatorio_despesa_viagem WHERE id = ?').bind(reportId).first()
  if (!report) return c.notFound()
  const form = await c.req.parseBody(); const file = form.arquivo
  if (!(file instanceof File) || !file.size) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return c.json({ error: 'tipo_de_arquivo_nao_permitido' }, 415)
  const indice = Number(form.indice_despesa || 0); const id = uuid(); const key = await salvarArquivoShareBrasil(c, user.id, file, 'relatorio_despesa_viagem/anexos_notas')
  const fileUrl = new URL(`/api/financeiro/relatorios-despesa-viagem/${encodeURIComponent(reportId)}/anexos/${encodeURIComponent(id)}/arquivo`, c.req.url)
  await portalDb(c).prepare('INSERT INTO relatorio_despesa_viagem_anexos (id, relatorio_despesa_viagem_id, indice_despesa, nome_arquivo, caminho_arquivo, url_arquivo, tipo_arquivo, tamanho_arquivo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, reportId, Number.isFinite(indice) ? indice : 0, file.name, key, fileUrl.toString(), file.type, file.size).run()
  return c.json({ anexo: { id, relatorio_despesa_viagem_id: reportId, indice_despesa: Number.isFinite(indice) ? indice : 0, nome_arquivo: file.name, caminho_arquivo: key, url_arquivo: fileUrl.toString(), tipo_arquivo: file.type, tamanho_arquivo: file.size } }, 201)
})

app.delete('/api/financeiro/relatorios-despesa-viagem/:id/anexos/:anexoId', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const row = await portalDb(c).prepare('SELECT caminho_arquivo FROM relatorio_despesa_viagem_anexos WHERE id = ? AND relatorio_despesa_viagem_id = ?').bind(c.req.param('anexoId'), c.req.param('id')).first<{ caminho_arquivo: string }>()
  if (!row) return c.notFound()
  await shareBrasilBucket(c).delete(row.caminho_arquivo).catch(() => undefined)
  await portalDb(c).prepare('DELETE FROM relatorio_despesa_viagem_anexos WHERE id = ?').bind(c.req.param('anexoId')).run()
  return c.json({ success: true })
})

app.get('/api/financeiro/relatorios-despesa-viagem/:id/anexos/:anexoId/arquivo', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaRelatorioDespesaViagem(c)
  const row = await portalDb(c).prepare('SELECT caminho_arquivo, nome_arquivo, tipo_arquivo FROM relatorio_despesa_viagem_anexos WHERE id = ? AND relatorio_despesa_viagem_id = ?').bind(c.req.param('anexoId'), c.req.param('id')).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string | null }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo || 'application/octet-stream', 'Content-Disposition': `inline; filename="${shareBrasilFileName(row.nome_arquivo)}"` } })
})

app.get('/api/interno/abastecimentos/opcoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  const db = portalDb(c)
  const aeronaveId = c.req.query('aeronave_id') || ''
  const [clientes, socios, aeronave, fornecedores, diarios] = await Promise.all([
    db.prepare("SELECT id, razao_social AS nome, codigo_cliente FROM cliente WHERE lower(COALESCE(status, 'ativo')) NOT IN ('inativo', 'cancelado') ORDER BY razao_social").all(),
    db.prepare('SELECT id, nome, cotista_id, holding_id FROM hold_socios ORDER BY nome').all(),
    db.prepare('SELECT id, matricula_registro, fabricante, modelo, status FROM aeronave ORDER BY matricula_registro').all(),
    db.prepare('SELECT * FROM fornecedores_favoritos ORDER BY COALESCE(apelido, nome_completo), nome_completo').all(),
    aeronaveId
      ? db.prepare('SELECT l.id, l.data_registro, l.numero_voo, l.aeronave_id, l.cliente_id, l.socio_id, l.aerodromo_partida, l.aerodromo_chegada, c.razao_social AS cliente_nome, s.nome AS socio_nome FROM lancamentos_diario_bordo l LEFT JOIN cliente c ON c.id = l.cliente_id LEFT JOIN hold_socios s ON s.id = l.socio_id WHERE l.aeronave_id = ?1 ORDER BY date(l.data_registro) DESC, l.id DESC LIMIT 1').bind(aeronaveId).all()
      : db.prepare('SELECT id, data_registro, numero_voo, aeronave_id, cliente_id, socio_id, aerodromo_partida, aerodromo_chegada FROM lancamentos_diario_bordo ORDER BY date(data_registro) DESC LIMIT 100').all(),
  ])
  return c.json({ clientes: clientes.results, socios: socios.results, aeronave: aeronave.results, fornecedores: fornecedores.results, diarios: diarios.results })
})

app.get('/api/fornecedores-favoritos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const fornecedores = await portalDb(c).prepare('SELECT * FROM fornecedores_favoritos ORDER BY COALESCE(apelido, nome_completo), nome_completo').all()
  return c.json(fornecedores.results || [])
})

app.post('/api/interno/abastecimentos/fornecedores', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => null)
  if (!body?.nome_completo?.trim()) return c.json({ error: 'nome_fornecedor_obrigatorio' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO fornecedores_favoritos (id, nome_completo, endereco, cidade, uf, codigo_icao, pessoa_contato, preco_avgas, preco_jet, telefone, documento, apelido, conta_pagamento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.nome_completo.trim(), body.endereco || null, body.cidade || null, body.uf || null, body.codigo_icao || null, body.pessoa_contato || null, Number(body.preco_avgas || 0), Number(body.preco_jet || 0), body.telefone || null, body.documento || null, body.apelido || null, body.conta_pagamento || null).run()
  return c.json({ id, success: true }, 201)
})

app.patch('/api/interno/abastecimentos/fornecedores/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as any))
  if (!String(body.nome_completo || '').trim()) return c.json({ error: 'nome_fornecedor_obrigatorio' }, 400)
  const result = await portalDb(c).prepare('UPDATE fornecedores_favoritos SET nome_completo = ?, apelido = ?, cidade = ?, uf = ?, codigo_icao = ?, telefone = ?, preco_avgas = ?, preco_jet = ?, pessoa_contato = ?, conta_pagamento = ? WHERE id = ?').bind(String(body.nome_completo).trim(), body.apelido || null, body.cidade || null, body.uf || null, body.codigo_icao || null, body.telefone || null, Number(body.preco_avgas || 0), Number(body.preco_jet || 0), body.pessoa_contato || null, body.conta_pagamento || null, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true, id: c.req.param('id') })
})
app.delete('/api/interno/abastecimentos/fornecedores/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const result = await portalDb(c).prepare('DELETE FROM fornecedores_favoritos WHERE id = ?').bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})
app.get('/api/interno/abastecimentos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  const inicio = c.req.query('inicio') || '1900-01-01'; const fim = c.req.query('fim') || '2999-12-31'
  const aeronaveId = c.req.query('aeronave_id') || ''; const clienteId = c.req.query('cliente_id') || ''; const fornecedorId = c.req.query('fornecedor_id') || ''; const status = c.req.query('status') || ''; const valorMin = c.req.query('valor_min') || ''; const valorMax = c.req.query('valor_max') || ''; const busca = (c.req.query('busca') || '').trim()
  const conditions = ['date(a.data) BETWEEN ?1 AND ?2']; const binds: unknown[] = [inicio, fim]; let index = 3
  if (aeronaveId) { conditions.push(`a.aeronave_id = ?${index++}`); binds.push(aeronaveId) }
  if (clienteId) { conditions.push(`a.cliente_id = ?${index++}`); binds.push(clienteId) }
  if (fornecedorId) { conditions.push(`a.fornecedor_id = ?${index++}`); binds.push(fornecedorId) }
  if (status) { conditions.push(`lower(COALESCE(a.status, '')) = lower(?${index++})`); binds.push(status) }
  if (valorMin && Number.isFinite(Number(valorMin))) { conditions.push(`a.valor_total >= ?${index++}`); binds.push(Number(valorMin)) }
  if (valorMax && Number.isFinite(Number(valorMax))) { conditions.push(`a.valor_total <= ?${index++}`); binds.push(Number(valorMax)) }
  if (busca) { conditions.push(`(lower(COALESCE(a.local, '')) LIKE ?${index} OR lower(COALESCE(a.trecho, '')) LIKE ?${index} OR lower(COALESCE(a.numero_comanda, '')) LIKE ?${index} OR lower(COALESCE(a.numero_nf, '')) LIKE ?${index})`); binds.push(`%${busca.toLowerCase()}%`); index++ }
  const result = await portalDb(c).prepare(`SELECT a.*, c.razao_social AS cliente_nome, s.nome AS socio_nome, ar.matricula_registro, ar.fabricante, ar.modelo, f.nome_completo AS fornecedor_nome, f.apelido AS fornecedor_apelido, u.nome_completo AS criado_por_nome FROM abastecimentos a LEFT JOIN cliente c ON c.id = a.cliente_id LEFT JOIN hold_socios s ON s.id = a.socio_id LEFT JOIN aeronave ar ON ar.id = a.aeronave_id LEFT JOIN fornecedores_favoritos f ON f.id = a.fornecedor_id LEFT JOIN user_profiles u ON u.id = a.criado_por WHERE ${conditions.join(' AND ')} ORDER BY date(a.data) DESC, a.id DESC`).bind(...binds).all()
  return c.json({ abastecimentos: result.results })
})

app.post('/api/interno/abastecimentos', async c => {
  const authenticated = await authenticatedColaborador(c)
  if (!authenticated && !checkInternalAuth(c)) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  const body = await c.req.json<Record<string, any>>().catch(() => null)
  const data = String(body?.data || '').trim(); const local = String(body?.local || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !local) return c.json({ error: 'data_e_local_obrigatorios' }, 400)
  const id = uuid(); const litros = Number(body?.litros || 0); const valorUnitario = Number(body?.valor_unitario || 0); const valorTotal = Number(body?.valor_total ?? litros * valorUnitario)
  await portalDb(c).prepare(`INSERT INTO abastecimentos (id, cliente_id, socio_id, aeronave_id, data, tipo_combustivel, trecho, local, numero_comanda, numero_nf, litros, valor_unitario, valor_total, desconto, fornecedor_id, status, observacao, forma_pagamento, data_vencimento_boleto, criado_por, lancamento_diario_id, data_pagamento, banco, voo_emprestado, numero_voo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, body?.cliente_id || null, body?.socio_id || null, body?.aeronave_id || null, data, body?.tipo_combustivel || null, body?.trecho || null, local, body?.numero_comanda || null, body?.numero_nf || null, Number.isFinite(litros) ? litros : 0, Number.isFinite(valorUnitario) ? valorUnitario : 0, Number.isFinite(valorTotal) ? valorTotal : 0, body?.desconto == null ? null : Number(body.desconto), body?.fornecedor_id || null, body?.status || 'pendente', body?.observacao || null, body?.forma_pagamento || null, body?.data_vencimento_boleto || null, authenticated?.id || extractSupabaseUserId(c) || null, body?.lancamento_diario_id || null, body?.data_pagamento || null, body?.banco || null, body?.voo_emprestado ? 1 : 0, body?.numero_voo || null).run()
  return c.json({ id, success: true }, 201)
})

app.patch('/api/interno/abastecimentos/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c); const body = await c.req.json<Record<string, any>>().catch(() => ({} as any)); const id = c.req.param('id')
  const result = await portalDb(c).prepare(`UPDATE abastecimentos SET cliente_id = ?, socio_id = ?, aeronave_id = ?, data = ?, tipo_combustivel = ?, trecho = ?, local = ?, numero_comanda = ?, numero_nf = ?, litros = ?, valor_unitario = ?, valor_total = ?, desconto = ?, fornecedor_id = ?, status = ?, observacao = ?, forma_pagamento = ?, data_vencimento_boleto = ?, lancamento_diario_id = ?, data_pagamento = ?, banco = ?, voo_emprestado = ?, numero_voo = ? WHERE id = ?`).bind(body.cliente_id || null, body.socio_id || null, body.aeronave_id || null, body.data, body.tipo_combustivel || null, body.trecho || null, body.local, body.numero_comanda || null, body.numero_nf || null, Number(body.litros || 0), Number(body.valor_unitario || 0), Number(body.valor_total || 0), body.desconto == null ? null : Number(body.desconto), body.fornecedor_id || null, body.status || null, body.observacao || null, body.forma_pagamento || null, body.data_vencimento_boleto || null, body.lancamento_diario_id || null, body.data_pagamento || null, body.banco || null, body.voo_emprestado ? 1 : 0, body.numero_voo || null, id).run()
  if (!result.meta.changes) return c.notFound(); return c.json({ success: true, id })
})

app.delete('/api/interno/abastecimentos/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const result = await portalDb(c).prepare('DELETE FROM abastecimentos WHERE id = ?1').bind(c.req.param('id')).run(); if (!result.meta.changes) return c.notFound(); return c.json({ success: true })
})

app.post('/api/interno/abastecimentos/:id/arquivo', async c => {
  const authenticated = await authenticatedColaborador(c)
  if (!authenticated && !checkInternalAuth(c)) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c); const id = c.req.param('id'); const form = await c.req.parseBody(); const file = form.arquivo; const tipo = String(form.tipo || 'comanda')
  if (!(file instanceof File) || !file.size) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  if (!['comanda', 'nota', 'boleto'].includes(tipo)) return c.json({ error: 'tipo_arquivo_invalido' }, 400)
  const pasta = tipo === 'nota' ? 'abastecimentos/nota fiscal' : tipo === 'boleto' ? 'abastecimentos/boleto' : 'abastecimentos/comanda'
  const objectKey = await salvarArquivoShareBrasil(c, authenticated?.id || extractSupabaseUserId(c) || 'interno', file, pasta)
  const column = tipo === 'nota' ? 'nota_url' : tipo === 'boleto' ? 'boleto_url' : 'comanda_url'
  const arquivoUrl = new URL(`/api/interno/abastecimentos/${encodeURIComponent(id)}/arquivo/${tipo}`, c.req.url)
  arquivoUrl.searchParams.set('key', objectKey)
  await portalDb(c).prepare(`UPDATE abastecimentos SET ${column} = ? WHERE id = ?`).bind(arquivoUrl.toString(), id).run()
  return c.json({ success: true, caminho_arquivo: objectKey, url: arquivoUrl.toString() })
})

app.get('/api/interno/abastecimentos/:id/arquivo/:tipo', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const tipo = c.req.param('tipo'); const column = tipo === 'nota' ? 'nota_url' : tipo === 'boleto' ? 'boleto_url' : 'comanda_url'
  const row = await portalDb(c).prepare(`SELECT ${column} AS caminho FROM abastecimentos WHERE id = ?`).bind(c.req.param('id')).first<{ caminho: string | null }>(); if (!row?.caminho) return c.notFound()
  let objectKey = row.caminho
  try { const storedUrl = new URL(row.caminho); objectKey = storedUrl.searchParams.get('key') || row.caminho } catch { /* compatibilidade com registros antigos que armazenavam a chave */ }
  const object = await shareBrasilBucket(c).get(objectKey); if (!object) return c.notFound(); return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Content-Disposition': `inline; filename="${objectKey.split('/').pop() || 'abastecimento'}"` } })
})

// ─── Share Brasil: ponto, documentos, senhas e contatos ─────────────────────
async function shareBrasilUser(c: Context<{ Bindings: Bindings }>): Promise<Colaborador | null> {
  return authenticatedColaborador(c)
}

function shareBrasilBucket(c: Context<{ Bindings: Bindings }>): R2Bucket {
  return c.env.SHARE_FILES || c.env.FILES
}

function shareBrasilFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)
}
const DOCUMENTOS_CLIENTE_CATEGORIAS: Record<string, string> = {
  'avatar_logo': 'avatar_logo',
  'cartao-cnpj': 'cartao-cnpj',
  'comprovante-endereco': 'comprovante-endereco',
  'contrato-share': 'contrato-share',
  'contrato-social': 'contrato-social',
  'documentos-pessoais': 'documentos-pessoais',
  'inscricao-estadual': 'inscricao-estadual',
  'geral': 'documentos-pessoais',
}
function categoriaDocumentoCliente(value: unknown): string {
  const normalized = String(value || 'geral').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_\s]+/g, '-')
  return DOCUMENTOS_CLIENTE_CATEGORIAS[normalized] || 'documentos-pessoais'
}
async function salvarArquivoShareBrasil(c: Context<{ Bindings: Bindings }>, userId: string, file: File, pasta: string): Promise<string> {
  if (!file.size) throw new Error('arquivo_vazio')
  if (file.size > 25 * 1024 * 1024) throw new Error('arquivo_excede_25mb')
  const key = `${pasta}/${userId}/${Date.now()}-${uuid().slice(0, 8)}-${shareBrasilFileName(file.name)}`
  await shareBrasilBucket(c).put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } })
  return key
}

function shareBrasilMonth(value: string | undefined): { inicio: string; fim: string } {
  const month = /^\d{4}-\d{2}$/.test(value || '') ? value! : new Date().toISOString().slice(0, 7)
  return { inicio: `${month}-01`, fim: `${month}-31` }
}

function horasEntre(inicio: string | null, fim: string | null): number | null {
  if (!inicio || !fim) return null
  const [ih, im] = inicio.split(':').map(Number)
  const [fh, fm] = fim.split(':').map(Number)
  if (![ih, im, fh, fm].every(Number.isFinite)) return null
  const total = ((fh * 60 + fm) - (ih * 60 + im)) / 60
  return total >= 0 ? Math.round(total * 100) / 100 : null
}

app.get('/api/sharebrasil/ponto', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const { inicio, fim } = shareBrasilMonth(c.req.query('mes'))
  const db = portalDb(c)
  const [lancamentos, anexos, justificativas, correcoes] = await Promise.all([
    db.prepare('SELECT * FROM lancamento_ponto WHERE user_id = ?1 AND date(data_entrada) BETWEEN ?2 AND ?3 ORDER BY data_entrada DESC').bind(user.id, inicio, fim).all(),
    db.prepare('SELECT * FROM lancamento_ponto_anexos WHERE user_id = ?1 AND date(data_entrada) BETWEEN ?2 AND ?3 ORDER BY criado_em DESC').bind(user.id, inicio, fim).all(),
    db.prepare('SELECT * FROM justificativa_ausencia WHERE id_usuario = ?1 AND date(data_registro) BETWEEN ?2 AND ?3 ORDER BY data_registro DESC').bind(user.id, inicio, fim).all(),
    db.prepare('SELECT * FROM solicitacoes_correcao_ponto WHERE user_id = ?1 AND date(data_entrada) BETWEEN ?2 AND ?3 ORDER BY data_entrada DESC, criado_em DESC').bind(user.id, inicio, fim).all(),
  ])
  return c.json({ mes: inicio.slice(0, 7), lancamentos: lancamentos.results, anexos: anexos.results.map((item: any) => ({ ...item, arquivo_url: `/api/sharebrasil/ponto/anexos/${item.id}/arquivo` })), justificativas: justificativas.results, correcoes: correcoes.results })
})

app.post('/api/sharebrasil/ponto/marcar', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ acao?: string; data?: string; hora?: string }>().catch(() => ({} as { acao?: string; data?: string; hora?: string }))
  const acao = body.acao || ''
  const data = /^\d{4}-\d{2}-\d{2}$/.test(body.data || '') ? body.data! : new Date().toISOString().slice(0, 10)
  const hora = /^\d{2}:\d{2}(:\d{2})?$/.test(body.hora || '') ? body.hora!.slice(0, 5) : new Date().toISOString().slice(11, 16)
  const columns: Record<string, { campo: string; status: string }> = {
    entrada: { campo: 'entrada_hora', status: 'working' },
    inicio_almoco: { campo: 'inicio_almoco', status: 'lunch' },
    fim_almoco: { campo: 'fim_almoco', status: 'working' },
    pausa: { campo: 'inicio_almoco', status: 'paused' },
    saida: { campo: 'saida_hora', status: 'finished' },
    encerrar: { campo: 'saida_hora', status: 'finished' },
  }
  const target = columns[acao]
  if (!target) return c.json({ error: 'acao_invalida' }, 400)
  const db = portalDb(c)
  let row = await db.prepare('SELECT * FROM lancamento_ponto WHERE user_id = ?1 AND data_entrada = ?2 LIMIT 1').bind(user.id, data).first<any>()
  if (!row) {
    const id = uuid()
    await db.prepare('INSERT INTO lancamento_ponto (id, user_id, data_entrada, status) VALUES (?, ?, ?, ?)').bind(id, user.id, data, target.status).run()
    row = { id, user_id: user.id, data_entrada: data }
  }
  const entrada = target.campo === 'entrada_hora' ? hora : row.entrada_hora
  const saida = target.campo === 'saida_hora' ? hora : row.saida_hora
  const total = horasEntre(entrada, saida)
  await db.prepare(`UPDATE lancamento_ponto SET ${target.campo} = ?, status = ?, horas_totais = COALESCE(?, horas_totais), atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`).bind(hora, target.status, total, row.id, user.id).run()
  return c.json({ success: true, id: row.id, data_entrada: data, campo: target.campo, hora, status: target.status, horas_totais: total })
})

app.post('/api/sharebrasil/ponto/correcao', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ data_entrada?: string; lancamento_ponto_id?: string; tipo_correcao?: string; tempo_original?: string; tempo_corrigido?: string; justificativa?: string }>().catch(() => ({} as any))
  if (!body.data_entrada || !body.tipo_correcao || !body.tempo_corrigido || !body.justificativa?.trim()) return c.json({ error: 'campos_obrigatorios' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO solicitacoes_correcao_ponto (id, user_id, data_entrada, lancamento_ponto_id, tipo_correcao, tempo_original, tempo_corrigido, justificativa) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, user.id, body.data_entrada, body.lancamento_ponto_id || null, body.tipo_correcao, body.tempo_original || null, body.tempo_corrigido, body.justificativa.trim()).run()
  return c.json({ id, status: 'pending' }, 201)
})

app.post('/api/sharebrasil/ponto/justificativa', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const form = await c.req.formData()
  const data = String(form.get('data_registro') || '').trim()
  const justificativa = String(form.get('justificativa') || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !justificativa) return c.json({ error: 'data_e_justificativa_obrigatorias' }, 400)
  const id = uuid()
  let key: string | null = null
  const fileValue = form.get('arquivo') as unknown
  try {
    if (fileValue && typeof fileValue === 'object' && 'size' in fileValue && Number(fileValue.size) > 0) key = await salvarArquivoShareBrasil(c, user.id, fileValue as File, 'anexos_ponto')
    await portalDb(c).prepare('INSERT INTO justificativa_ausencia (id, id_usuario, data_registro, justificativa, url_documento) VALUES (?, ?, ?, ?, ?)').bind(id, user.id, data, justificativa, key).run()
    if (key) {
      const lancamento = await portalDb(c).prepare('SELECT id FROM lancamento_ponto WHERE user_id = ?1 AND data_entrada = ?2 LIMIT 1').bind(user.id, data).first<{ id: string }>()
      await portalDb(c).prepare('INSERT INTO lancamento_ponto_anexos (id, lancamento_ponto_id, user_id, data_entrada, caminho_arquivo, nome_arquivo, tipo_arquivo, tipo_justificativa, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(uuid(), lancamento?.id || null, user.id, data, key, (fileValue as File).name, (fileValue as File).type || null, 'medical', justificativa).run()
    }
    return c.json({ id, status: 'pendente', url_documento: key }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_justificativa' }, 400)
  }
})

app.get('/api/sharebrasil/ponto/anexos/:id/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await portalDb(c).prepare('SELECT caminho_arquivo, nome_arquivo, tipo_arquivo FROM lancamento_ponto_anexos WHERE id = ?1 AND user_id = ?2').bind(c.req.param('id'), user.id).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string | null }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${shareBrasilFileName(row.nome_arquivo)}"` } })
})

app.get('/api/sharebrasil/documentos/pastas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare('SELECT * FROM pastas_documentos ORDER BY nome').all()
  return c.json(result.results)
})

app.post('/api/sharebrasil/documentos/pastas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ nome?: string; pasta_pai_id?: string }>().catch(() => ({} as any))
  if (!body.nome?.trim()) return c.json({ error: 'nome_obrigatorio' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO pastas_documentos (id, nome, pasta_pai_id, criado_por) VALUES (?, ?, ?, ?)').bind(id, body.nome.trim(), body.pasta_pai_id || null, user.id).run()
  return c.json({ id, nome: body.nome.trim(), pasta_pai_id: body.pasta_pai_id || null }, 201)
})

app.get('/api/sharebrasil/documentos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const pastaId = c.req.query('pasta_id') || null
  const result = pastaId ? await portalDb(c).prepare('SELECT * FROM documentos_internos WHERE pasta_id = ?1 ORDER BY criado_em DESC').bind(pastaId).all() : await portalDb(c).prepare('SELECT * FROM documentos_internos ORDER BY criado_em DESC').all()
  return c.json(result.results.map((item: any) => ({ ...item, arquivo_url: `/api/sharebrasil/documentos/${item.id}/arquivo` })))
})

app.post('/api/sharebrasil/documentos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const form = await c.req.formData()
  const fileValue = form.get('arquivo') as unknown
  const pastaId = String(form.get('pasta_id') || '').trim() || null
  if (!fileValue || typeof fileValue !== 'object' || !('size' in fileValue) || Number(fileValue.size) <= 0) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const file = fileValue as File
  try {
    const key = await salvarArquivoShareBrasil(c, user.id, file, 'documentos_internos')
    const id = uuid()
    await portalDb(c).prepare('INSERT INTO documentos_internos (id, pasta_id, nome, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, pastaId, file.name, key, file.type || 'application/octet-stream', file.size, user.id).run()
    const documento = await portalDb(c).prepare('SELECT id, pasta_id, nome, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, criado_em FROM documentos_internos WHERE id = ?').bind(id).first()
    return c.json({ ...documento, arquivo_url: `/api/sharebrasil/documentos/${id}/arquivo` }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_documento' }, 400)
  }
})

app.get('/api/sharebrasil/documentos/:id/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await portalDb(c).prepare('SELECT caminho_arquivo, nome, tipo_arquivo FROM documentos_internos WHERE id = ?1').bind(c.req.param('id')).first<{ caminho_arquivo: string; nome: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo, 'Content-Disposition': `attachment; filename="${shareBrasilFileName(row.nome)}"` } })
})

app.get('/api/sharebrasil/senhas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare('SELECT id, titulo, site, login, observacoes, criado_por, criado_em, atualizado_em, setor FROM senhas ORDER BY titulo').all()
  return c.json(result.results)
})

app.get('/api/sharebrasil/senhas/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await portalDb(c).prepare('SELECT id, titulo, site, login, senha, observacoes, criado_por, criado_em, atualizado_em, setor FROM senhas WHERE id = ?1').bind(c.req.param('id')).first()
  if (!row) return c.notFound()
  return c.json(row)
})

app.post('/api/sharebrasil/senhas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ titulo?: string; site?: string; login?: string; senha?: string; observacoes?: string; setor?: string }>().catch(() => ({} as any))
  if (!body.titulo?.trim() || !body.site?.trim() || !body.login?.trim() || !body.senha) return c.json({ error: 'campos_obrigatorios' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO senhas (id, titulo, site, login, senha, observacoes, criado_por, setor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.titulo.trim(), body.site.trim(), body.login.trim(), body.senha, body.observacoes?.trim() || null, user.id, body.setor?.trim() || null).run()
  return c.json({ id, titulo: body.titulo.trim() }, 201)
})

app.patch('/api/sharebrasil/senhas/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ titulo?: string; site?: string; login?: string; senha?: string; observacoes?: string; setor?: string }>().catch(() => ({} as any))
  const result = await portalDb(c).prepare('UPDATE senhas SET titulo = COALESCE(?, titulo), site = COALESCE(?, site), login = COALESCE(?, login), senha = COALESCE(?, senha), observacoes = ?, setor = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(body.titulo?.trim() || null, body.site?.trim() || null, body.login?.trim() || null, body.senha || null, body.observacoes?.trim() || null, body.setor?.trim() || null, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.delete('/api/sharebrasil/senhas/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare('DELETE FROM senhas WHERE id = ?1').bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.get('/api/sharebrasil/contatos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare('SELECT * FROM agenda_contatos ORDER BY nome').all()
  return c.json(result.results)
})

app.post('/api/sharebrasil/contatos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, string>>().catch(() => ({} as Record<string, string>))
  if (!body.nome?.trim()) return c.json({ error: 'nome_obrigatorio' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO agenda_contatos (id, nome, telefone, email, empresa, cargo, observacoes, endereco, uf, cidade, categoria) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.nome.trim(), body.telefone || null, body.email || null, body.empresa || null, body.cargo || null, body.observacoes || null, body.endereco || null, body.uf || null, body.cidade || null, body.categoria || null).run()
  return c.json({ id }, 201)
})

app.patch('/api/sharebrasil/contatos/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, string>>().catch(() => ({} as Record<string, string>))
  const result = await portalDb(c).prepare('UPDATE agenda_contatos SET nome = COALESCE(?, nome), telefone = ?, email = ?, empresa = ?, cargo = ?, observacoes = ?, endereco = ?, uf = ?, cidade = ?, categoria = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(body.nome?.trim() || null, body.telefone || null, body.email || null, body.empresa || null, body.cargo || null, body.observacoes || null, body.endereco || null, body.uf || null, body.cidade || null, body.categoria || null, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.delete('/api/sharebrasil/contatos/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare('DELETE FROM agenda_contatos WHERE id = ?1').bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

async function garantirForeignKeyCotistas(c: Context<{ Bindings: Bindings }>) {
  void c
  return
  const db = portalDb(c)
  const foreignKeys = await db.prepare("SELECT \"from\" AS column_name, \"table\" AS foreign_table_name FROM pragma_foreign_key_list('hold_socios')").all<any>().catch(() => ({ results: [] as any[] }))
  if (!(foreignKeys.results || []).some((row: any) => row.column_name === 'cotista_id' && row.foreign_table_name === 'cotista_aeronave')) return
  await db.prepare(`CREATE TABLE IF NOT EXISTS hold_socios_corrigida (id TEXT PRIMARY KEY NOT NULL, cotista_id TEXT, nome TEXT NOT NULL, cpf TEXT NOT NULL, email_principal TEXT, emails TEXT NOT NULL DEFAULT '[]', endereco TEXT, cidade TEXT, uf TEXT, contato_financeiro TEXT, telefone_financeiro TEXT, telefone TEXT, observacoes TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP, holding_id TEXT NOT NULL REFERENCES holdings(id))`).run()
  await db.prepare(`INSERT OR IGNORE INTO hold_socios_corrigida SELECT id, cotista_id, nome, cpf, email_principal, emails, endereco, cidade, uf, contato_financeiro, telefone_financeiro, telefone, observacoes, criado_em, atualizado_em, holding_id FROM hold_socios`).run()
  await db.prepare('DROP TABLE hold_socios').run()
  await db.prepare('ALTER TABLE hold_socios_corrigida RENAME TO hold_socios').run()
}
app.get('/api/sharebrasil/clientes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = portalDb(c)
  await garantirForeignKeyCotistas(c).catch((error) => log.error('[clientes] migração de cotistas ignorada:', error?.message || error))
  const [clientes, holdings, socios, vinculos, documentos, documentosSocios, aeronave] = await Promise.all([
    db.prepare('SELECT * FROM cliente ORDER BY razao_social').all().catch(() => ({ results: [] as any[] })),
    db.prepare('SELECT * FROM holdings WHERE ativo = 1 ORDER BY nome').all().catch(() => ({ results: [] as any[] })),
    db.prepare('SELECT * FROM hold_socios ORDER BY nome').all().catch(() => ({ results: [] as any[] })),
    db.prepare('SELECT ca.*, a.matricula_registro, a.fabricante, a.modelo FROM cotista_aeronave ca LEFT JOIN aeronave a ON a.id = ca.aeronave_id ORDER BY ca.aeronave_id').all().catch(() => ({ results: [] as any[] })),
    db.prepare('SELECT * FROM documentos_cliente ORDER BY criado_em DESC').all().catch(() => ({ results: [] as any[] })),
    db.prepare('SELECT * FROM documentos_socio ORDER BY criado_em DESC').all().catch(() => ({ results: [] as any[] })),
    db.prepare('SELECT id, matricula_registro, fabricante, modelo, status FROM aeronave ORDER BY matricula_registro').all().catch(() => ({ results: [] as any[] })),
  ])
  return c.json({ clientes: clientes.results, holdings: holdings.results, socios: socios.results, vinculos: vinculos.results, aeronave: aeronave.results, documentos: documentos.results.map((item: any) => ({ ...item, arquivo_url: `/api/sharebrasil/clientes/documentos/${item.id}/arquivo` })), documentos_socios: documentosSocios.results.map((item: any) => ({ ...item, arquivo_url: `/api/sharebrasil/socios/documentos/${item.id}/arquivo` })) })
})

app.post('/api/sharebrasil/holdings', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const nome = String(body.nome || '').trim()
  if (!nome) return c.json({ error: 'nome_holding_obrigatorio' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO holdings (id, nome, conta_bancaria, ativo) VALUES (?, ?, ?, 1)').bind(id, nome, body.conta_bancaria || null).run()
  return c.json({ id, nome }, 201)
})
app.post('/api/sharebrasil/holdings/:id/socios', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const nome = String(body.nome || '').trim(); const cpf = String(body.cpf || '').trim()
  if (!nome || !cpf) return c.json({ error: 'nome_e_cpf_obrigatorios' }, 400)
  const holding = await portalDb(c).prepare('SELECT id FROM holdings WHERE id = ?1 AND ativo = 1').bind(c.req.param('id')).first()
  if (!holding) return c.notFound()
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO hold_socios (id, cotista_id, nome, cpf, email_principal, emails, endereco, cidade, uf, contato_financeiro, telefone_financeiro, telefone, observacoes, holding_id) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, nome, cpf, body.email_principal || null, JSON.stringify(body.emails || []), body.endereco || null, body.cidade || null, body.uf || null, body.contato_financeiro || null, body.telefone_financeiro || null, body.telefone || null, body.observacoes || null, c.req.param('id')).run()
  return c.json({ id, holding_id: c.req.param('id'), nome }, 201)
})
app.post('/api/sharebrasil/socios/:id/aeronave', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ aeronave_id?: string; percentual_sociedade?: number }>().catch(() => ({} as any))
  const percentual = Number(body.percentual_sociedade)
  if (!body.aeronave_id) return c.json({ error: 'aeronave_obrigatoria' }, 400)
  if (!Number.isFinite(percentual) || percentual < 0 || percentual > 100) return c.json({ error: 'percentual_invalido' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO cotista_aeronave (id, socio_id, aeronave_id, percentual_sociedade) VALUES (?, ?, ?, ?)').bind(id, c.req.param('id'), body.aeronave_id, percentual).run()
  return c.json({ id }, 201)
})
app.post('/api/sharebrasil/clientes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  if (!body.razao_social?.trim()) return c.json({ error: 'razao_social_obrigatoria' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO cliente (id, razao_social, cnpj, inscricao_estadual, proprietario, endereco, cidade, uf, contato_financeiro, telefone_financeiro, telefone_cliente, telefone_outro, email_principal, emails, status, holding, codigo_cliente, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.razao_social.trim(), body.cnpj || null, body.inscricao_estadual || null, body.proprietario || null, body.endereco || null, body.cidade || null, body.uf || null, body.contato_financeiro || null, body.telefone_financeiro || null, body.telefone_cliente || null, body.telefone_outro || null, body.email_principal || null, JSON.stringify(body.emails || []), body.status || 'ativo', body.holding ? 1 : 0, body.codigo_cliente || null, body.observacoes || null).run()
  return c.json({ id }, 201)
})

app.patch('/api/sharebrasil/clientes/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const fields = ['razao_social','cnpj','inscricao_estadual','proprietario','endereco','cidade','uf','contato_financeiro','telefone_financeiro','telefone_cliente','telefone_outro','email_principal','status','codigo_cliente','observacoes']
  const values = fields.map((field) => body[field] ?? null)
  const result = await portalDb(c).prepare(`UPDATE cliente SET ${fields.map((field) => `${field} = COALESCE(?, ${field})`).join(', ')}, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(...values, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.patch('/api/sharebrasil/socios/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const fields = ['nome', 'cpf', 'email_principal', 'telefone', 'endereco', 'cidade', 'uf', 'observacoes']
  const provided = fields.filter((field) => body[field] !== undefined)
  if (!provided.length) return c.json({ error: 'nenhum_campo_informado' }, 400)
  const values = provided.map((field) => body[field] ?? null)
  const result = await portalDb(c).prepare(`UPDATE hold_socios SET ${provided.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`).bind(...values, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})
app.post('/api/sharebrasil/clientes/:id/aeronave', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ aeronave_id?: string; percentual_sociedade?: number; codigo_cliente?: string }>().catch(() => ({} as any))
  if (!body.aeronave_id) return c.json({ error: 'aeronave_obrigatoria' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO cotista_aeronave (id, cliente_id, aeronave_id, percentual_sociedade, codigo_cliente) VALUES (?, ?, ?, ?, ?)').bind(id, c.req.param('id'), body.aeronave_id, Number(body.percentual_sociedade || 100), body.codigo_cliente || null).run()
  return c.json({ id }, 201)
})

app.post('/api/sharebrasil/clientes/:id/logo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const form = await c.req.formData()
  const fileValue = form.get('arquivo') as unknown
  if (!fileValue || typeof fileValue !== 'object' || !('size' in fileValue)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const file = fileValue as File
  if (!file.type.startsWith('image/')) return c.json({ error: 'logo_deve_ser_imagem' }, 415)
  try {
    const key = await salvarArquivoShareBrasil(c, user.id, file, `documentos_cliente/avatar_logo/${c.req.param('id')}`)
    await portalDb(c).prepare('UPDATE cliente SET url_logo = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(key, c.req.param('id')).run()
    return c.json({ url_logo: `/api/sharebrasil/clientes/${c.req.param('id')}/logo/arquivo` })
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_logo' }, 400)
  }
})

app.get('/api/sharebrasil/clientes/:id/logo/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await portalDb(c).prepare('SELECT url_logo FROM cliente WHERE id = ?1').bind(c.req.param('id')).first<{ url_logo: string | null }>()
  if (!row?.url_logo) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.url_logo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': 'image/*', 'Cache-Control': 'private, max-age=300' } })
})

app.post('/api/sharebrasil/clientes/:id/documentos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const form = await c.req.formData()
  const fileValue = form.get('arquivo') as unknown
  if (!fileValue || typeof fileValue !== 'object' || !('size' in fileValue)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const file = fileValue as File
  try {
    const categoria = categoriaDocumentoCliente(form.get('categoria'))
    const key = await salvarArquivoShareBrasil(c, user.id, file, `documentos_cliente/${categoria}/${c.req.param('id')}`)
    const id = uuid()
    await portalDb(c).prepare('INSERT INTO documentos_cliente (id, cliente_id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, categoria) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, c.req.param('id'), file.name, key, file.type || 'application/octet-stream', file.size, user.id, categoria).run()
    return c.json({ id, arquivo_url: `/api/sharebrasil/clientes/documentos/${id}/arquivo` }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_documento_cliente' }, 400)
  }
})

app.get('/api/sharebrasil/clientes/documentos/:id/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await portalDb(c).prepare('SELECT caminho_arquivo, nome_arquivo, tipo_arquivo FROM documentos_cliente WHERE id = ?1').bind(c.req.param('id')).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo, 'Content-Disposition': `attachment; filename="${shareBrasilFileName(row.nome_arquivo)}"` } })
})



app.post('/api/sharebrasil/socios/:id/documentos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = portalDb(c)
  const socio = await db.prepare('SELECT id, cotista_id, holding_id FROM hold_socios WHERE id = ?1').bind(c.req.param('id')).first<{ id: string; cotista_id: string; holding_id: string | null }>()
  if (!socio) return c.notFound()
  const form = await c.req.formData()
  const fileValue = form.get('arquivo') as unknown
  if (!fileValue || typeof fileValue !== 'object' || !('size' in fileValue)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const file = fileValue as File
  try {
    const categoria = categoriaDocumentoCliente(form.get('categoria'))
    const holdingPath = socio.holding_id || 'sem-holding'
    const key = await salvarArquivoShareBrasil(c, user.id, file, `documentos_holding/${categoria}/${holdingPath}/socios/${socio.id}`)
    const id = uuid()
    await db.prepare('INSERT INTO documentos_socio (id, socio_id, cliente_id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, categoria) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, socio.id, null, file.name, key, file.type || 'application/octet-stream', file.size, user.id, categoria).run()
    return c.json({ id, arquivo_url: `/api/sharebrasil/socios/documentos/${id}/arquivo` }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_documento_socio' }, 400)
  }
})
app.get('/api/sharebrasil/socios/documentos/:id/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await portalDb(c).prepare('SELECT caminho_arquivo, nome_arquivo, tipo_arquivo FROM documentos_socio WHERE id = ?1').bind(c.req.param('id')).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo, 'Content-Disposition': `attachment; filename="${shareBrasilFileName(row.nome_arquivo)}"` } })
})
// ─── Share Brasil: tarefas, notificações e calendário ─────────────────────────
function isTaskManager(user: Colaborador): boolean {
  const role = (user.tipo_user || '').toLowerCase().replace(/[\s-]+/g, '_')
  return ['admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster'].includes(role)
}

async function isMeetingManager(c: Context<{ Bindings: Bindings }>, user: Colaborador): Promise<boolean> {
  if (isTaskManager(user)) return true
  const result = await portalDb(c).prepare("SELECT 1 FROM usuarios_funcoes WHERE user_id = ?1 AND lower(replace(replace(funcao, ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster') LIMIT 1").bind(user.id).first()
  return Boolean(result)
}

app.get('/api/interno/aerodromos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const q = (c.req.query('q') || '').trim().toUpperCase(); const termo = `%${q}%`
  const rows = await portalDb(c).prepare("SELECT id, nome, designativo_icao, coordenadas FROM aerodromo WHERE (?1 = '%%' OR upper(designativo_icao) LIKE ?1 OR upper(nome) LIKE ?1) ORDER BY designativo_icao").bind(termo).all()
  return c.json({ aerodromos: rows.results })
})
app.post('/api/interno/aerodromos', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !(await isMeetingManager(c, user))) return c.json({ error: 'permissao_necessaria' }, 403)
  const body = await c.req.json<{ nome?: string; designativo_icao?: string; coordenadas?: string }>().catch(() => ({} as any)); const nome = body.nome?.trim() || ''; const icao = body.designativo_icao?.trim().toUpperCase() || ''
  if (!nome || !/^[A-Z0-9]{4}$/.test(icao)) return c.json({ error: 'nome_e_icao_obrigatorios' }, 400)
  const id = uuid(); await portalDb(c).prepare('INSERT INTO aerodromo (id, nome, designativo_icao, coordenadas) VALUES (?, ?, ?, ?)').bind(id, nome, icao, body.coordenadas?.trim() || null).run()
  return c.json({ id, nome, designativo_icao: icao, coordenadas: body.coordenadas?.trim() || null }, 201)
})
app.patch('/api/interno/aerodromos/:id', async c => {
  const user = await shareBrasilUser(c); if (!user || !(await isMeetingManager(c, user))) return c.json({ error: 'permissao_necessaria' }, 403)
  const body = await c.req.json<{ nome?: string; designativo_icao?: string; coordenadas?: string }>().catch(() => ({} as any)); const nome = body.nome?.trim() || ''; const icao = body.designativo_icao?.trim().toUpperCase() || ''
  if (!nome || !/^[A-Z0-9]{4}$/.test(icao)) return c.json({ error: 'nome_e_icao_obrigatorios' }, 400)
  const result = await portalDb(c).prepare('UPDATE aerodromo SET nome = ?, designativo_icao = ?, coordenadas = ? WHERE id = ?').bind(nome, icao, body.coordenadas?.trim() || null, c.req.param('id')).run(); if (!result.meta.changes) return c.notFound(); return c.json({ success: true })
})
app.delete('/api/interno/aerodromos/:id', async c => {
  const user = await shareBrasilUser(c); if (!user || !(await isMeetingManager(c, user))) return c.json({ error: 'permissao_necessaria' }, 403)
  const result = await portalDb(c).prepare('DELETE FROM aerodromo WHERE id = ?').bind(c.req.param('id')).run(); if (!result.meta.changes) return c.notFound(); return c.json({ success: true })
})

async function isColaboradorManager(c: Context<{ Bindings: Bindings }>, user: Colaborador): Promise<boolean> {
  const result = await portalDb(c).prepare("SELECT 1 FROM usuarios_funcoes WHERE user_id = ?1 AND lower(replace(replace(trim(funcao), ' ', '_'), '-', '_')) IN ('admin', 'financeiro_master', 'gestor_master', 'rh_master', 'rh') LIMIT 1").bind(user.id).first()
  return Boolean(result)
}

app.get('/api/gestor/gestao-colaborador', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const result = await portalDb(c).prepare("SELECT id, email, nome_completo, nome_exibicao, telefone, cidade, uf, data_nascimento, data_admissao, cpf, rg, canac, status, tipo_user, departamento, data_criacao, data_atualizacao FROM user_profiles WHERE lower(COALESCE(tipo_user, 'colaborador')) = 'colaborador' ORDER BY COALESCE(nome_exibicao, nome_completo), email").all()
  return c.json(result.results)
})

app.post('/api/gestor/gestao-colaborador', async c => {
  const creator = await shareBrasilUser(c)
  if (!creator || !await isColaboradorManager(c, creator)) return c.json({ error: 'permissao_necessaria' }, 403)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const email = String(body.email || '').trim().toLowerCase()
  const senha = String(body.senha || '')
  const nome = String(body.nome_completo || '').trim()
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || senha.length < 6 || !nome) return c.json({ error: 'nome_email_e_senha_validos_sao_obrigatorios' }, 400)
  const emailEnvio = await gerarEmailEnvioColaborador(c, nome)
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_ROLE_KEY) return c.json({ error: 'supabase_admin_nao_configurado' }, 503)
  const authResponse = await fetch(`${c.env.SUPABASE_URL}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: c.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senha, email_confirm: true, user_metadata: { nome_completo: nome, tipo_user: 'colaborador' } }) })
  const authData = await authResponse.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  if (!authResponse.ok || !authData.id) return c.json({ error: authData.msg || authData.message || 'nao_foi_possivel_criar_usuario_supabase' }, authResponse.status === 422 ? 409 : 502)
  const id = String(authData.id)
  try {
    await portalDb(c).prepare(`INSERT INTO user_profiles (id, email, email_envio, nome_completo, nome_exibicao, telefone, cidade, uf, data_nascimento, data_admissao, cpf, rg, canac, status, tipo_user, departamento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo', 'colaborador', ?)`).bind(id, email, emailEnvio, nome, body.nome_exibicao || nome, body.telefone || null, body.cidade || null, body.uf || null, body.data_nascimento || null, body.data_admissao || null, body.cpf || null, body.rg || null, body.canac || null, body.departamento || null).run()
    const funcao = String(body.funcao || 'colaborador').trim().toLowerCase().replace(/[\s-]+/g, '_')
    await portalDb(c).prepare('INSERT INTO usuarios_funcoes (id, user_id, funcao) VALUES (?, ?, ?)').bind(uuid(), id, funcao).run()
    await portalDb(c).prepare('INSERT INTO assinaturas_email (id, usuario_id, nome, cargo, telefone, endereco, email) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(uuid(), id, nome, body.cargo || body.departamento || null, body.telefone || null, null, emailEnvio).run()
  } catch (error) {
    await portalDb(c).prepare('DELETE FROM usuarios_funcoes WHERE user_id = ?1').bind(id).run().catch(() => undefined)
    await portalDb(c).prepare('DELETE FROM user_profiles WHERE id = ?1').bind(id).run().catch(() => undefined)
    await fetch(`${c.env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { apikey: c.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}` } }).catch(() => undefined)
    log.error('[gestao-colaborador] falha ao inserir perfil ou função D1:', error)
    return c.json({ error: 'usuario_criado_no_supabase_mas_falha_ao_salvar_perfil_d1' }, 500)
  }
  return c.json(await portalDb(c).prepare('SELECT id, email, nome_completo, nome_exibicao, telefone, cidade, uf, data_nascimento, data_admissao, cpf, rg, canac, status, tipo_user, departamento, data_criacao, data_atualizacao FROM user_profiles WHERE id = ?1').bind(id).first(), 201)
})

app.patch('/api/gestor/gestao-colaborador/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const id = c.req.param('id'); const current = await portalDb(c).prepare('SELECT id FROM user_profiles WHERE id = ?1 AND lower(COALESCE(tipo_user, \'colaborador\')) = \'colaborador\'').bind(id).first()
  if (!current) return c.notFound()
  const fields = ['nome_completo', 'nome_exibicao', 'telefone', 'cidade', 'uf', 'data_nascimento', 'data_admissao', 'cpf', 'rg', 'canac', 'departamento', 'status']
  const updates = fields.filter(field => body[field] !== undefined)
  if (!updates.length) return c.json({ error: 'nenhum_campo_informado' }, 400)
  await portalDb(c).prepare(`UPDATE user_profiles SET ${updates.map(field => `${field} = ?`).join(', ')}, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?`).bind(...updates.map(field => body[field] || null), id).run()
  return c.json(await portalDb(c).prepare('SELECT * FROM user_profiles WHERE id = ?1').bind(id).first())
})

app.get('/api/gestor/gestao-colaborador/:id/ficha', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const id = c.req.param('id')
  const db = portalDb(c)
  const perfil = await db.prepare('SELECT id, email, nome_completo, nome_exibicao, telefone, endereco, cidade, uf, data_nascimento, data_admissao, cpf, rg, canac, status, tipo_user, departamento, data_criacao, data_atualizacao FROM user_profiles WHERE id = ?1 AND lower(COALESCE(tipo_user, \'colaborador\')) = \'colaborador\'').bind(id).first()
  if (!perfil) return c.notFound()
  const [documentos, funcoes, ferias, recebimentos, lancamentos] = await Promise.all([
    db.prepare('SELECT id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, criado_em, categoria FROM documentos_usuarios WHERE user_id = ?1 ORDER BY criado_em DESC').bind(id).all().catch(() => ({ results: [] })),
    db.prepare('SELECT id, funcao, criado_em FROM usuarios_funcoes WHERE user_id = ?1 ORDER BY funcao').bind(id).all().catch(() => ({ results: [] })),
    db.prepare('SELECT id, data_inicio, data_fim, quantidade_dias, status, observacoes, motivo_reprovacao, aprovado_em, criado_em, atualizado_em FROM solicitacoes_ferias WHERE colaborador_id = ?1 ORDER BY data_inicio DESC, criado_em DESC').bind(id).all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, tipo, descricao, valor, data_despesa, vencimento, status, observacoes, pago_por, criado_em FROM envio_despesas WHERE tipo IN ('share', 'reembolso') AND (pago_por = ?1 OR fornecedor = ?1) ORDER BY COALESCE(data_despesa, criado_em) DESC LIMIT 200").bind(id).all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, descricao, ROUND(valor_centavos / 100.0, 2) AS valor, data, status, observacoes, pago_por, criado_em FROM lancamentos WHERE pago_por = ?1 ORDER BY date(data) DESC, criado_em DESC LIMIT 200").bind(id).all().catch(() => ({ results: [] })),
  ])
  return c.json({ perfil, documentos: documentos.results, funcoes: funcoes.results, ferias: ferias.results, recebimentos: [...recebimentos.results, ...lancamentos.results] })
})

app.get('/api/gestor/ferias', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const inicio = c.req.query('inicio') || new Date().toISOString().slice(0, 10)
  const db = portalDb(c)
  const registros = await db.prepare(`SELECT f.id, f.colaborador_id, f.data_inicio, f.data_fim, f.quantidade_dias, f.status, f.observacoes, f.motivo_reprovacao, f.aprovado_em, f.criado_em, p.nome_completo, p.nome_exibicao, p.email, p.departamento, p.data_admissao
    FROM solicitacoes_ferias f LEFT JOIN user_profiles p ON p.id = f.colaborador_id
    ORDER BY CASE f.status WHEN 'solicitada' THEN 1 WHEN 'aprovada' THEN 2 ELSE 3 END, date(f.data_inicio), p.nome_completo`).all().catch(() => ({ results: [] }))
  const vencidas = await db.prepare("SELECT COUNT(*) AS total FROM solicitacoes_ferias WHERE status = 'aprovada' AND date(data_fim) < date(?1)").bind(inicio).first<{ total: number }>().catch(() => ({ total: 0 }))
  const ativas = await db.prepare("SELECT COUNT(*) AS total FROM solicitacoes_ferias WHERE status = 'aprovada' AND date(data_inicio) <= date(?1) AND date(data_fim) >= date(?1)").bind(inicio).first<{ total: number }>().catch(() => ({ total: 0 }))
  const solicitadas = await db.prepare("SELECT COUNT(*) AS total FROM solicitacoes_ferias WHERE status = 'solicitada'").first<{ total: number }>().catch(() => ({ total: 0 }))
  return c.json({ inicio, registros: registros.results, resumo: { ativas: Number(ativas?.total || 0), solicitadas: Number(solicitadas?.total || 0), vencidas: Number(vencidas?.total || 0) } })
})

function jsonArray(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [])
}

async function visibleTask(c: Context<{ Bindings: Bindings }>, user: Colaborador, id: string): Promise<any | null> {
  const manager = isTaskManager(user)
  const sql = manager
    ? 'SELECT * FROM tarefas WHERE id = ?1 AND origem = \'KANBAN\''
    : 'SELECT * FROM tarefas WHERE id = ?1 AND origem = \'KANBAN\' AND (criado_por = ?2 OR publico = 1 OR EXISTS (SELECT 1 FROM json_each(COALESCE(atribuido_para, \'[]\')) WHERE json_each.value = ?2))'
  return manager ? portalDb(c).prepare(sql).bind(id).first() : portalDb(c).prepare(sql).bind(id, user.id).first()
}

async function notifyTask(c: Context<{ Bindings: Bindings }>, taskId: string, recipients: string[], mensagem: string, status?: string): Promise<void> {
  const unique = [...new Set(recipients.filter(Boolean))]
  if (!unique.length) return
  const db = portalDb(c)
  for (const recipient of unique) {
    await db.prepare('INSERT INTO tarefas_notificacoes (id, id_da_tarefa, user_id, mensagem, status_alterado_para) VALUES (?, ?, ?, ?, ?)').bind(uuid(), taskId, recipient, mensagem, status || null).run()
  }
}

app.get('/api/sharebrasil/tarefas/usuarios', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !isTaskManager(user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const result = await portalDb(c).prepare("SELECT id, nome_completo, nome_exibicao, email, tipo_user, departamento FROM user_profiles WHERE status IS NULL OR lower(status) IN ('ativo', 'active') ORDER BY COALESCE(nome_exibicao, nome_completo), email").all()
  return c.json(result.results)
})

app.get('/api/sharebrasil/tarefas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const manager = isTaskManager(user)
  const sql = manager
    ? "SELECT * FROM tarefas WHERE origem = 'KANBAN' ORDER BY CASE status WHEN 'ABERTO' THEN 1 WHEN 'EM_ANDAMENTO' THEN 2 WHEN 'CONCLUIDA' THEN 3 ELSE 4 END, prazo IS NULL, prazo, criado_em DESC"
    : "SELECT * FROM tarefas WHERE origem = 'KANBAN' AND (criado_por = ?1 OR publico = 1 OR EXISTS (SELECT 1 FROM json_each(COALESCE(atribuido_para, '[]')) WHERE json_each.value = ?1)) ORDER BY prazo IS NULL, prazo, criado_em DESC"
  const tasks = manager ? await portalDb(c).prepare(sql).all() : await portalDb(c).prepare(sql).bind(user.id).all()
  const taskIds = tasks.results.map((row: any) => row.id)
  const comments: any[] = []
  for (const taskId of taskIds) {
    const result = await portalDb(c).prepare('SELECT c.*, COALESCE(u.nome_exibicao, u.nome_completo, u.email) AS usuario_nome FROM tarefas_comentarios c LEFT JOIN user_profiles u ON u.id = c.usuario_id WHERE c.tarefa_id = ?1 ORDER BY c.criado_em ASC').bind(taskId).all()
    comments.push(...result.results)
  }
  const notifications = await portalDb(c).prepare('SELECT * FROM tarefas_notificacoes WHERE user_id = ?1 ORDER BY criado_em DESC LIMIT 50').bind(user.id).all()
  return c.json({ tarefas: tasks.results.map((task: any) => ({ ...task, atribuido_para: JSON.parse(task.atribuido_para || '[]'), comentarios: comments.filter((item) => item.tarefa_id === task.id) })), notificacoes: notifications.results })
})

app.post('/api/sharebrasil/tarefas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ titulo?: string; descricao?: string; prioridade?: string; prazo?: string; publico?: boolean; atribuido_para?: string[] }>().catch(() => ({} as any))
  if (!body.titulo?.trim()) return c.json({ error: 'titulo_obrigatorio' }, 400)
  const assigned = Array.isArray(body.atribuido_para) ? body.atribuido_para : []
  if ((assigned.length || body.publico) && !isTaskManager(user)) return c.json({ error: 'somente_admin_ou_gestor_master_pode_atribuir' }, 403)
  const id = uuid(); const publico = body.publico ? 1 : 0; const assignedJson = jsonArray(assigned)
  await portalDb(c).prepare("INSERT INTO tarefas (id, titulo, descricao, status, prioridade, criado_por, prazo, publico, origem, atribuido_para, progresso) VALUES (?, ?, ?, 'ABERTO', ?, ?, ?, ?, 'KANBAN', ?, 0)").bind(id, body.titulo.trim(), body.descricao?.trim() || null, body.prioridade || 'MEDIA', user.id, body.prazo || null, publico, assignedJson).run()
  await notifyTask(c, id, assigned, `Nova tarefa atribuída: ${body.titulo.trim()}`)
  return c.json({ id, titulo: body.titulo.trim(), status: 'ABERTO', publico, atribuido_para: assigned }, 201)
})

app.patch('/api/sharebrasil/tarefas/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const task = await visibleTask(c, user, c.req.param('id')) as any
  if (!task) return c.notFound()
  const body = await c.req.json<{ titulo?: string; descricao?: string; status?: string; prioridade?: string; prazo?: string | null; progresso?: number; publico?: boolean; atribuido_para?: string[] }>().catch(() => ({} as any))
  const assigned = body.atribuido_para === undefined ? JSON.parse(task.atribuido_para || '[]') : body.atribuido_para
  if ((body.atribuido_para !== undefined || body.publico !== undefined) && !isTaskManager(user)) return c.json({ error: 'somente_admin_ou_gestor_master_pode_atribuir' }, 403)
  const status = body.status || task.status
  const progress = body.progresso == null ? (status === 'CONCLUIDA' ? 100 : task.progresso) : Math.max(0, Math.min(100, Number(body.progresso)))
  await portalDb(c).prepare('UPDATE tarefas SET titulo = COALESCE(?, titulo), descricao = COALESCE(?, descricao), status = ?, prioridade = COALESCE(?, prioridade), prazo = ?, progresso = ?, publico = COALESCE(?, publico), atribuido_para = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(body.titulo?.trim() || null, body.descricao?.trim() || null, status, body.prioridade || null, body.prazo === undefined ? task.prazo : body.prazo, progress, body.publico === undefined ? null : (body.publico ? 1 : 0), jsonArray(assigned), task.id).run()
  if (status === 'CONCLUIDA' && task.status !== 'CONCLUIDA' && task.criado_por && task.criado_por !== user.id) await notifyTask(c, task.id, [task.criado_por], `A tarefa foi concluída: ${task.titulo}`, 'CONCLUIDA')
  if (body.atribuido_para) await notifyTask(c, task.id, assigned, `A tarefa foi atualizada: ${body.titulo || task.titulo}`)
  return c.json({ success: true, status, progresso: progress, atribuido_para: assigned })
})

app.post('/api/sharebrasil/tarefas/:id/comentarios', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const task = await visibleTask(c, user, c.req.param('id')) as any
  if (!task) return c.notFound()
  const body = await c.req.json<{ comentario?: string }>().catch(() => ({} as any))
  if (!body.comentario?.trim()) return c.json({ error: 'comentario_obrigatorio' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO tarefas_comentarios (id, tarefa_id, usuario_id, comentario) VALUES (?, ?, ?, ?)').bind(id, task.id, user.id, body.comentario.trim()).run()
  const recipients = [task.criado_por, ...JSON.parse(task.atribuido_para || '[]')].filter((recipient: string) => recipient && recipient !== user.id)
  await notifyTask(c, task.id, recipients, `Novo comentário na tarefa: ${task.titulo}`)
  return c.json({ id, tarefa_id: task.id, comentario: body.comentario.trim() }, 201)
})

app.patch('/api/sharebrasil/notificacoes/:id/lida', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare('UPDATE tarefas_notificacoes SET lido = 1, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2').bind(c.req.param('id'), user.id).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.get('/api/sharebrasil/calendario/categorias', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare('SELECT * FROM categorias_calendario WHERE usuario_id = ?1 ORDER BY nome').bind(user.id).all()
  return c.json(result.results)
})

app.post('/api/sharebrasil/calendario/categorias', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ nome?: string; cor?: string }>().catch(() => ({} as any))
  if (!body.nome?.trim()) return c.json({ error: 'nome_obrigatorio' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO categorias_calendario (id, usuario_id, nome, cor) VALUES (?, ?, ?, ?)').bind(id, user.id, body.nome.trim(), body.cor || '#2fb9a7').run()
  return c.json({ id, nome: body.nome.trim(), cor: body.cor || '#2fb9a7' }, 201)
})

app.get('/api/sharebrasil/calendario', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const inicio = c.req.query('inicio') || '1900-01-01'; const fim = c.req.query('fim') || '2999-12-31'
  const result = await portalDb(c).prepare("SELECT l.*, c.nome AS categoria_nome, c.cor AS categoria_cor FROM lembretes_calendario l LEFT JOIN categorias_calendario c ON c.id = l.cor_categoria_id WHERE l.data BETWEEN ?1 AND ?2 AND (l.visibilidade = 'TODOS' OR l.usuario_id = ?3) ORDER BY l.data, l.hora").bind(inicio, fim, user.id).all()
  return c.json(result.results)
})

app.post('/api/sharebrasil/calendario', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ titulo?: string; descricao?: string; data?: string; hora?: string; visibilidade?: 'PRIVADO' | 'TODOS'; cor_categoria_id?: string }>().catch(() => ({} as any))
  if (!body.titulo?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(body.data || '')) return c.json({ error: 'titulo_e_data_obrigatorios' }, 400)
  const visibility = body.visibilidade === 'TODOS' ? 'TODOS' : 'PRIVADO'
  const calendarId = uuid(); const taskId = uuid()
  await portalDb(c).prepare("INSERT INTO tarefas (id, titulo, descricao, status, prioridade, criado_por, prazo, publico, origem, atribuido_para, progresso) VALUES (?, ?, ?, 'ABERTO', 'MEDIA', ?, ?, ?, 'CALENDARIO', ?, 0)").bind(taskId, body.titulo.trim(), body.descricao?.trim() || null, user.id, body.data, visibility === 'TODOS' ? 1 : 0, jsonArray([user.id])).run()
  await portalDb(c).prepare('INSERT INTO lembretes_calendario (id, usuario_id, titulo, descricao, data, hora, visibilidade, cor_categoria_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(calendarId, user.id, body.titulo.trim(), body.descricao?.trim() || null, body.data, body.hora || null, visibility, body.cor_categoria_id || null).run()
  const users = visibility === 'TODOS' ? await portalDb(c).prepare("SELECT id FROM user_profiles WHERE status IS NULL OR lower(status) IN ('ativo', 'active')").all() : { results: [{ id: user.id }] }
  await notifyTask(c, taskId, users.results.map((item: any) => item.id), `Novo evento no calendário: ${body.titulo.trim()}`)
  return c.json({ id: calendarId, titulo: body.titulo.trim(), data: body.data, hora: body.hora || null, visibilidade: visibility }, 201)
})



// ─── Hotéis Share Brasil: contatos, CRUD e reservas por email ─────────────────
async function garantirTabelaHoteis(c: Context<{ Bindings: Bindings }>) {
  void c
  return
  await portalDb(c).prepare(`CREATE TABLE IF NOT EXISTS hoteis (
    id TEXT PRIMARY KEY NOT NULL, nome TEXT NOT NULL, telefone TEXT, endereco TEXT, uf TEXT, cidade TEXT,
    preco_single REAL, preco_duplo REAL, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    estrelas INTEGER, convenio INTEGER NOT NULL DEFAULT 0, email TEXT, telefone_reservas TEXT, contato_comercial TEXT,
    telefone_comercial TEXT, email_comercial TEXT, observacoes TEXT
  )`).run()
  await portalDb(c).prepare(`CREATE TABLE IF NOT EXISTS reservas_hoteis (
    id TEXT PRIMARY KEY NOT NULL, hotel_id TEXT NOT NULL, criado_por TEXT, data_checkin TEXT NOT NULL, data_checkout TEXT NOT NULL,
    tipo_quarto TEXT, quantidade_hospedes INTEGER NOT NULL, hospede_nome TEXT NOT NULL, hospede_telefone TEXT NOT NULL,
    hospede_email TEXT, observacoes TEXT, destinatario_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'SOLICITADA', criado_em TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run()
}

function hotelPayload(row: Record<string, any>) {
  return { ...row, convenio: Boolean(row.convenio), estrelas: Number(row.estrelas || 0), preco_single: row.preco_single == null ? null : Number(row.preco_single), preco_duplo: row.preco_duplo == null ? null : Number(row.preco_duplo) }
}

app.get('/api/sharebrasil/hoteis', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaHoteis(c)
  const busca = (c.req.query('q') || '').trim()
  const ordem = c.req.query('ordem') === 'cidade' ? 'cidade, nome' : c.req.query('ordem') === 'estrelas' ? 'estrelas DESC, nome' : 'nome'
  const query = busca ? `SELECT * FROM hoteis WHERE nome LIKE ?1 OR cidade LIKE ?1 OR contato_comercial LIKE ?1 OR email LIKE ?1 ORDER BY ${ordem}` : `SELECT * FROM hoteis ORDER BY ${ordem}`
  const result = busca ? await portalDb(c).prepare(query).bind(`%${busca}%`).all() : await portalDb(c).prepare(query).all()
  return c.json(result.results.map(row => hotelPayload(row as Record<string, any>)))
})

app.post('/api/sharebrasil/hoteis', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!await isColaboradorManager(c, user)) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await garantirTabelaHoteis(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const nome = String(body.nome || '').trim()
  if (!nome) return c.json({ error: 'nome_obrigatorio' }, 400)
  const id = uuid()
  await portalDb(c).prepare(`INSERT INTO hoteis (id, nome, telefone, endereco, uf, cidade, preco_single, preco_duplo, estrelas, convenio, email, telefone_reservas, contato_comercial, telefone_comercial, email_comercial, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, nome, body.telefone || null, body.endereco || null, body.uf || null, body.cidade || null, body.preco_single == null || body.preco_single === '' ? null : Number(body.preco_single), body.preco_duplo == null || body.preco_duplo === '' ? null : Number(body.preco_duplo), Math.max(0, Math.min(5, Math.trunc(Number(body.estrelas) || 0))), body.convenio ? 1 : 0, body.email || null, body.telefone_reservas || null, body.contato_comercial || null, body.telefone_comercial || null, body.email_comercial || null, body.observacoes || null).run()
  return c.json(hotelPayload(await portalDb(c).prepare('SELECT * FROM hoteis WHERE id = ?1').bind(id).first<Record<string, any>>() || { id, nome }), 201)
})

app.patch('/api/sharebrasil/hoteis/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!await isColaboradorManager(c, user)) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await garantirTabelaHoteis(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const current = await portalDb(c).prepare('SELECT * FROM hoteis WHERE id = ?1').bind(c.req.param('id')).first<Record<string, any>>()
  if (!current) return c.notFound()
  const value = (key: string) => body[key] === undefined ? current[key] : body[key]
  await portalDb(c).prepare('UPDATE hoteis SET nome=?, telefone=?, endereco=?, uf=?, cidade=?, preco_single=?, preco_duplo=?, estrelas=?, convenio=?, email=?, telefone_reservas=?, contato_comercial=?, telefone_comercial=?, email_comercial=?, observacoes=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').bind(String(value('nome') || '').trim(), value('telefone') || null, value('endereco') || null, value('uf') || null, value('cidade') || null, value('preco_single') === '' || value('preco_single') == null ? null : Number(value('preco_single')), value('preco_duplo') === '' || value('preco_duplo') == null ? null : Number(value('preco_duplo')), Math.max(0, Math.min(5, Math.trunc(Number(value('estrelas')) || 0))), value('convenio') ? 1 : 0, value('email') || null, value('telefone_reservas') || null, value('contato_comercial') || null, value('telefone_comercial') || null, value('email_comercial') || null, value('observacoes') || null, current.id).run()
  return c.json(hotelPayload(await portalDb(c).prepare('SELECT * FROM hoteis WHERE id = ?1').bind(current.id).first<Record<string, any>>() || current))
})

app.delete('/api/sharebrasil/hoteis/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!await isColaboradorManager(c, user)) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await garantirTabelaHoteis(c)
  const result = await portalDb(c).prepare('DELETE FROM hoteis WHERE id = ?1').bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.post('/api/sharebrasil/hoteis/:id/reservar', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaHoteis(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const hotel = await portalDb(c).prepare('SELECT * FROM hoteis WHERE id = ?1').bind(c.req.param('id')).first<Record<string, any>>()
  if (!hotel) return c.notFound()
  const destinatario = String(hotel.email || hotel.email_comercial || '').trim()
  if (!destinatario) return c.json({ error: 'hotel_sem_email' }, 422)
  const checkin = String(body.data_checkin || '').trim(); const checkout = String(body.data_checkout || '').trim(); const hospede = String(body.hospede_nome || '').trim(); const telefone = String(body.hospede_telefone || '').trim(); const quantidade = Number(body.quantidade_hospedes || 1)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout) || !hospede || !telefone || !Number.isInteger(quantidade) || quantidade < 1) return c.json({ error: 'dados_da_reserva_invalidos' }, 400)
  if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) return c.json({ error: 'email_nao_configurado' }, 503)
  const emailResponse = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: c.env.EMAIL_FROM, to: [destinatario], reply_to: body.hospede_email || undefined, subject: `Solicitação de reserva — ${hotel.nome} (${checkin} a ${checkout})`, html: `<h2>Solicitação de reserva</h2><p><strong>Hotel:</strong> ${escapeHtml(hotel.nome)}</p><p><strong>Check-in:</strong> ${escapeHtml(checkin)}</p><p><strong>Check-out:</strong> ${escapeHtml(checkout)}</p><p><strong>Quarto:</strong> ${escapeHtml(body.tipo_quarto || 'Não informado')}</p><p><strong>Hóspede:</strong> ${escapeHtml(hospede)}</p><p><strong>Telefone:</strong> ${escapeHtml(telefone)}</p><p><strong>Quantidade:</strong> ${escapeHtml(quantidade)}</p><p><strong>Observações:</strong> ${escapeHtml(body.observacoes || '—')}</p>` }) })
  if (!emailResponse.ok) return c.json({ error: 'falha_ao_enviar_email' }, 502)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO reservas_hoteis (id, hotel_id, criado_por, data_checkin, data_checkout, tipo_quarto, quantidade_hospedes, hospede_nome, hospede_telefone, hospede_email, observacoes, destinatario_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, hotel.id, user.id, checkin, checkout, body.tipo_quarto || null, quantidade, hospede, telefone, body.hospede_email || null, body.observacoes || null, destinatario).run()
  return c.json({ success: true, id, destinatario_email: destinatario }, 201)
})

// ─── Centro de Treinamento: tutoriais, treinamentos e salas colaborativas ────
async function ensureTrainingTables(c: Context<{ Bindings: Bindings }>) {
  const db = portalDb(c)
  await db.prepare(`CREATE TABLE IF NOT EXISTS centro_reunioes (
    id TEXT PRIMARY KEY NOT NULL,
    titulo TEXT NOT NULL,
    descricao TEXT,
    status TEXT NOT NULL DEFAULT 'ATIVA',
    criado_por TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    encerrado_em TEXT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS manual_tutoriais (
    id TEXT PRIMARY KEY NOT NULL,
    titulo TEXT NOT NULL,
    descricao TEXT NOT NULL DEFAULT '',
    video_url TEXT,
    conteudo_html TEXT,
    categoria TEXT NOT NULL DEFAULT 'TUTORIAL',
    ordem INTEGER NOT NULL DEFAULT 0,
    criado_por TEXT,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    tema TEXT,
    arquivo_url TEXT,
    tipo_arquivo TEXT,
    tamanho_arquivo INTEGER,
    publicado INTEGER NOT NULL DEFAULT 1
  )`).run()
  await db.prepare('ALTER TABLE manual_tutoriais ADD COLUMN tema TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE manual_tutoriais ADD COLUMN arquivo_url TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE manual_tutoriais ADD COLUMN tipo_arquivo TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE manual_tutoriais ADD COLUMN tamanho_arquivo INTEGER').run().catch(() => undefined)
  await db.prepare('ALTER TABLE manual_tutoriais ADD COLUMN publicado INTEGER NOT NULL DEFAULT 1').run().catch(() => undefined)
}

function trainingPayload(row: Record<string, any>) {
  return { ...row, publicado: Boolean(row.publicado), arquivo_url: row.arquivo_url ? `/api/sharebrasil/centro-treinamento/materiais/${row.id}/arquivo` : null }
}

app.get('/api/sharebrasil/centro-treinamento/materiais', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await ensureTrainingTables(c)
  const categoria = (c.req.query('categoria') || '').trim().toUpperCase()
  const query = categoria ? 'SELECT * FROM manual_tutoriais WHERE publicado = 1 AND upper(categoria) = ?1 ORDER BY ordem, criado_em DESC' : 'SELECT * FROM manual_tutoriais WHERE publicado = 1 ORDER BY categoria, ordem, criado_em DESC'
  const result = categoria ? await portalDb(c).prepare(query).bind(categoria).all() : await portalDb(c).prepare(query).all()
  return c.json(result.results.map(row => trainingPayload(row as Record<string, any>)))
})

app.post('/api/sharebrasil/centro-treinamento/materiais', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!await isColaboradorManager(c, user)) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await ensureTrainingTables(c)
  const form = await c.req.formData()
  const titulo = String(form.get('titulo') || '').trim()
  const descricao = String(form.get('descricao') || '').trim()
  const categoria = String(form.get('categoria') || 'TUTORIAL').trim().toUpperCase()
  const tema = String(form.get('tema') || '').trim() || null
  const videoUrl = String(form.get('video_url') || '').trim() || null
  const conteudoHtml = String(form.get('conteudo_html') || '').trim() || null
  const ordem = Number(form.get('ordem') || 0)
  const fileValue = form.get('arquivo')
  if (!titulo || !['TUTORIAL', 'TREINAMENTO'].includes(categoria)) return c.json({ error: 'titulo_e_categoria_obrigatorios' }, 400)
  let arquivoUrl: string | null = null
  let tipoArquivo: string | null = null
  let tamanhoArquivo: number | null = null
  try {
    if (fileValue && typeof fileValue === 'object' && 'type' in fileValue) {
      const file = fileValue as File
      const extensao = file.name.toLowerCase().split('.').pop() || ''
      const tipoDetectado = file.type || (extensao === 'html' || extensao === 'htm' ? 'text/html' : '')
      const allowed = ['video/mp4', 'video/webm', 'application/pdf', 'text/html']
      if (!allowed.includes(tipoDetectado)) return c.json({ error: 'tipo_de_arquivo_nao_permitido' }, 415)
      if (file.size > 100 * 1024 * 1024) return c.json({ error: 'arquivo_excede_100mb' }, 413)
      arquivoUrl = await salvarArquivoShareBrasil(c, user.id, file, 'manual_tutoriais')
      tipoArquivo = tipoDetectado
      tamanhoArquivo = file.size
    }
    const id = uuid()
    await portalDb(c).prepare('INSERT INTO manual_tutoriais (id, titulo, descricao, video_url, conteudo_html, categoria, ordem, criado_por, tema, arquivo_url, tipo_arquivo, tamanho_arquivo, publicado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').bind(id, titulo, descricao, videoUrl, conteudoHtml, categoria, Number.isFinite(ordem) ? ordem : 0, user.id, tema, arquivoUrl, tipoArquivo, tamanhoArquivo).run()
    const row = await portalDb(c).prepare('SELECT * FROM manual_tutoriais WHERE id = ?1').bind(id).first<Record<string, any>>()
    return c.json(trainingPayload(row || { id, titulo, descricao, categoria }), 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_material' }, 400)
  }
})

app.patch('/api/sharebrasil/centro-treinamento/materiais/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!await isColaboradorManager(c, user)) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await ensureTrainingTables(c)
  const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const current = await portalDb(c).prepare('SELECT * FROM manual_tutoriais WHERE id = ?1').bind(c.req.param('id')).first<Record<string, any>>()
  if (!current) return c.notFound()
  const categoria = body.categoria == null ? current.categoria : String(body.categoria).toUpperCase()
  if (!['TUTORIAL', 'TREINAMENTO'].includes(categoria)) return c.json({ error: 'categoria_invalida' }, 400)
  await portalDb(c).prepare('UPDATE manual_tutoriais SET titulo = ?, descricao = ?, categoria = ?, tema = ?, video_url = ?, conteudo_html = ?, ordem = ?, publicado = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(String(body.titulo ?? current.titulo).trim(), String(body.descricao ?? current.descricao).trim(), categoria, body.tema == null ? current.tema : String(body.tema), body.video_url == null ? current.video_url : String(body.video_url), body.conteudo_html == null ? current.conteudo_html : String(body.conteudo_html), Number(body.ordem ?? current.ordem) || 0, body.publicado == null ? current.publicado : (body.publicado ? 1 : 0), current.id).run()
  const row = await portalDb(c).prepare('SELECT * FROM manual_tutoriais WHERE id = ?1').bind(current.id).first<Record<string, any>>()
  return c.json(trainingPayload(row || current))
})

app.delete('/api/sharebrasil/centro-treinamento/materiais/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!await isColaboradorManager(c, user)) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await ensureTrainingTables(c)
  const row = await portalDb(c).prepare('SELECT arquivo_url FROM manual_tutoriais WHERE id = ?1').bind(c.req.param('id')).first<{ arquivo_url: string | null }>()
  if (!row) return c.notFound()
  await portalDb(c).prepare('DELETE FROM manual_tutoriais WHERE id = ?1').bind(c.req.param('id')).run()
  if (row.arquivo_url) await shareBrasilBucket(c).delete(row.arquivo_url).catch(() => undefined)
  return c.json({ success: true })
})

app.get('/api/sharebrasil/centro-treinamento/materiais/:id/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await ensureTrainingTables(c)
  const row = await portalDb(c).prepare('SELECT arquivo_url, tipo_arquivo, titulo FROM manual_tutoriais WHERE id = ?1').bind(c.req.param('id')).first<{ arquivo_url: string | null; tipo_arquivo: string | null; titulo: string }>()
  if (!row?.arquivo_url) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.arquivo_url)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo || 'application/octet-stream', 'Content-Disposition': `inline; filename="${shareBrasilFileName(row.titulo)}"`, 'Cache-Control': 'private, max-age=3600' } })
})

app.get('/api/sharebrasil/centro-treinamento/reunioes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await ensureTrainingTables(c)
  const result = await portalDb(c).prepare(`SELECT r.*, COALESCE(u.nome_exibicao, u.nome_completo, u.email) AS criado_por_nome FROM centro_reunioes r LEFT JOIN user_profiles u ON u.id = r.criado_por WHERE r.status = 'ATIVA' ORDER BY r.criado_em DESC`).all()
  return c.json(result.results)
})

app.post('/api/sharebrasil/centro-treinamento/reunioes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!(await isMeetingManager(c, user))) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await ensureTrainingTables(c)
  const body = await c.req.json<{ titulo?: string; descricao?: string }>().catch(() => ({} as { titulo?: string; descricao?: string }))
  const titulo = body.titulo?.trim() || ''
  if (!titulo) return c.json({ error: 'titulo_obrigatorio' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO centro_reunioes (id, titulo, descricao, criado_por) VALUES (?, ?, ?, ?)').bind(id, titulo, body.descricao?.trim() || null, user.id).run()
  return c.json({ id, titulo, descricao: body.descricao?.trim() || null, status: 'ATIVA' }, 201)
})

app.post('/api/sharebrasil/centro-treinamento/reunioes/:id/encerrar', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!(await isMeetingManager(c, user))) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await ensureTrainingTables(c)
  await portalDb(c).prepare("UPDATE centro_reunioes SET status = 'ENCERRADA', encerrado_em = CURRENT_TIMESTAMP WHERE id = ?1").bind(c.req.param('id')).run()
  return c.json({ success: true })
})

app.get('/api/sharebrasil/centro-treinamento/turn', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const fallback = [{ urls: 'stun:stun.cloudflare.com:3478' }]
  if (!c.env.CLOUDFLARE_TURN_KEY_ID || !c.env.CLOUDFLARE_TURN_API_TOKEN) return c.json({ ice_servers: fallback, turn_configurado: false })
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(c.env.CLOUDFLARE_TURN_KEY_ID)}/credentials/generate`, { method: 'POST', headers: { Authorization: `Bearer ${c.env.CLOUDFLARE_TURN_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86_400, customIdentifier: user.id }) }).catch(() => null)
  if (!response?.ok) return c.json({ ice_servers: fallback, turn_configurado: false })
  const data = await response.json() as { iceServers?: unknown }
  return c.json({ ice_servers: data.iceServers || fallback, turn_configurado: true })
})

app.get('/api/sharebrasil/centro-treinamento/reunioes/:id/ws', async c => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: 'websocket_obrigatorio' }, 426)
  const token = c.req.query('access_token') || ''
  const user = await authenticatedColaboradorToken(c, token)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await ensureTrainingTables(c)
  const room = await portalDb(c).prepare("SELECT id, criado_por FROM centro_reunioes WHERE id = ?1 AND status = 'ATIVA'").bind(c.req.param('id')).first<{ id: string; criado_por: string }>()
  if (!room) return c.notFound()
  const roomId = c.env.MEETING_ROOMS.idFromName(c.req.param('id'))
  const stub = c.env.MEETING_ROOMS.get(roomId)
  const target = new URL('https://meeting-room/websocket')
  target.searchParams.set('user_id', user.id)
  target.searchParams.set('name', user.nome_exibicao || user.nome_completo || user.email)
  target.searchParams.set('participant_id', c.req.query('participant_id') || uuid())
  target.searchParams.set('host_user_id', room.criado_por)
  return stub.fetch(new Request(target, { headers: { Upgrade: 'websocket' } }))
})

// ─── Recados compartilhados entre dashboards ─────────────────────────────────
app.get('/api/colaborador/recados/departamentos', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare("SELECT DISTINCT trim(departamento) AS departamento FROM user_profiles WHERE departamento IS NOT NULL AND trim(departamento) <> '' ORDER BY departamento").all()
  return c.json(result.results)
})

app.get('/api/colaborador/recados', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await portalDb(c).prepare("SELECT r.id, r.criado_em, r.atualizado_em, r.autor_id, r.mensagem, r.fixado, r.departamento_id, r.lido_por, COALESCE(a.nome_exibicao, a.nome_completo, a.email) AS autor_nome, uf.funcao AS departamento FROM recados r LEFT JOIN user_profiles a ON a.id = r.autor_id LEFT JOIN usuarios_funcoes uf ON uf.id = r.departamento_id WHERE r.departamento_id IS NULL OR lower(COALESCE(uf.funcao, '')) = lower(COALESCE(?1, '')) ORDER BY r.fixado DESC, r.criado_em DESC LIMIT 100").bind(user.departamento || null).all()
  return c.json(result.results.map((item: any) => ({ ...item, fixado: Boolean(item.fixado), lido: JSON.parse(item.lido_por || '[]').includes(user.id) })))
})

app.post('/api/colaborador/recados', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ mensagem?: string; departamento?: string | null; fixado?: boolean }>().catch(() => ({} as any))
  if (!body.mensagem?.trim()) return c.json({ error: 'mensagem_obrigatoria' }, 400)
  let departamentoId: string | null = null
  const departamento = body.departamento?.trim()
  if (departamento) {
    const target = await portalDb(c).prepare('SELECT id FROM usuarios_funcoes WHERE lower(funcao) = lower(?1) LIMIT 1').bind(departamento).first<{ id: string }>()
    if (!target) return c.json({ error: 'departamento_nao_encontrado' }, 400)
    departamentoId = target.id
  }
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO recados (id, autor_id, mensagem, fixado, departamento_id) VALUES (?, ?, ?, ?, ?)').bind(id, user.id, body.mensagem.trim(), body.fixado ? 1 : 0, departamentoId).run()
  return c.json({ id, mensagem: body.mensagem.trim(), departamento: departamento || null, fixado: Boolean(body.fixado) }, 201)
})

app.patch('/api/colaborador/recados/:id/lido', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await portalDb(c).prepare("SELECT r.id, r.lido_por FROM recados r LEFT JOIN usuarios_funcoes uf ON uf.id = r.departamento_id WHERE r.id = ?1 AND (r.departamento_id IS NULL OR lower(COALESCE(uf.funcao, '')) = lower(COALESCE(?2, '')))").bind(c.req.param('id'), user.departamento || null).first<{ id: string; lido_por: string }>()
  if (!row) return c.notFound()
  const readers = JSON.parse(row.lido_por || '[]') as unknown
  const lidoPor = Array.isArray(readers) ? [...new Set([...readers.filter((item): item is string => typeof item === 'string'), user.id])] : [user.id]
  await portalDb(c).prepare('UPDATE recados SET lido_por = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(lidoPor), row.id).run()
  return c.json({ success: true, lido: true })
})

export class MeetingRoom {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 400 })
    const url = new URL(request.url)
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    const userId = url.searchParams.get('user_id') || ''
    const attachment = { id: url.searchParams.get('participant_id') || crypto.randomUUID(), userId, isHost: userId !== '' && userId === (url.searchParams.get('host_user_id') || ''), name: url.searchParams.get('name') || 'Participante' }
    this.state.acceptWebSocket(server)
    server.serializeAttachment(attachment)
    server.send(JSON.stringify({ type: 'room_state', participants: this.participants(), whiteboard: await this.state.storage.get<unknown[]>('whiteboard') || [] }))
    this.broadcast({ type: 'participant_joined', participant: attachment }, server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(sender: WebSocket, message: string | ArrayBuffer) {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
    let data: Record<string, any>
    try { data = JSON.parse(raw) } catch { return }
    const senderAttachment = sender.deserializeAttachment() as { id: string; userId: string; isHost?: boolean; name: string } | null
    if (!senderAttachment) return
    if (data.type === 'whiteboard' && data.action && !senderAttachment.isHost) return
    if (data.type === 'whiteboard' && data.action) {
      const board = await this.state.storage.get<any[]>('whiteboard') || []
      board.push({ ...data.action, author: senderAttachment.name, createdAt: Date.now() })
      await this.state.storage.put('whiteboard', board.slice(-1000))
    }
    const outgoing = { ...data, from: senderAttachment.id, fromName: senderAttachment.name }
    if (data.to) this.sendTo(String(data.to), outgoing)
    else this.broadcast(outgoing, sender)
  }

  async webSocketClose(sender: WebSocket) {
    const attachment = sender.deserializeAttachment() as { id: string; name: string } | null
    if (attachment) this.broadcast({ type: 'participant_left', participantId: attachment.id, name: attachment.name }, sender)
  }

  async webSocketError(sender: WebSocket) { await this.webSocketClose(sender) }

  private participants() {
    return this.state.getWebSockets().map((socket) => socket.deserializeAttachment()).filter(Boolean)
  }

  private sendTo(participantId: string, data: Record<string, any>) {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { id?: string } | null
      if (attachment?.id === participantId && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data))
    }
  }

  private broadcast(data: Record<string, any>, except?: WebSocket) {
    const serialized = JSON.stringify(data)
    for (const socket of this.state.getWebSockets()) if (socket !== except && socket.readyState === WebSocket.OPEN) socket.send(serialized)
  }
}


// ─── Financeiro: envio de despesas para programação ─────────────────────────
async function garantirTabelaEnvioDespesas(c: Context<{ Bindings: Bindings }>) {
  void c
}
async function garantirCategoriasCliente(c: Context<{ Bindings: Bindings }>) {
  void c
}
async function garantirColunasLancamentoEnvio(c: Context<{ Bindings: Bindings }>) {
  void c
}
function regraFinanceira(tipo: string, grupoInformado?: string) {
  const gruposShare = ['FOLHA DE PAGAMENTO', 'DESPESAS EMPRESA', 'DESPESAS EMPRESA-BANCO', 'DESPESAS EMPRESA - BANCO', 'DESPESAS PARTICULARES', 'IMPOSTOS', 'RECEITAS OPERACIONAIS']
  if (tipo === 'cliente') return { grupo: 'CAIXA CLIENTE', caixa: 'CLIENTE', rateio: true, pagoDiretamente: 1, reembolsavel: 0 }
  if (tipo === 'reembolso') return { grupo: 'DESPESAS REEMBOLSÁVEIS', caixa: 'SHARE', rateio: true, pagoDiretamente: 0, reembolsavel: 1 }
  return { grupo: gruposShare.includes(String(grupoInformado)) ? String(grupoInformado) : 'DESPESAS EMPRESA', caixa: 'SHARE', rateio: false, pagoDiretamente: 0, reembolsavel: 0 }
}
async function inserirLancamentoFinanceira(c: Context<{ Bindings: Bindings }>, body: Record<string, any>, user: any, envioId: string, regra: ReturnType<typeof regraFinanceira>) {
  if (regra.pagoDiretamente === 1) return null
  const resultado = await createExpense(portalDb(c), {
    ...body,
    descricao: body.descricao,
    valorCentavos: Math.round(Number(body.valor) * 100),
    data: body.data_despesa || new Date().toISOString().slice(0, 10),
    data_vencimento: body.vencimento || null,
    fornecedor: body.fornecedor || null,
    categoria: body.categoria_nome || regra.grupo,
    grupo_categoria: regra.grupo,
    fluxo: 'SAIDA',
    caixa: regra.caixa,
    pago_diretamente: regra.pagoDiretamente === 1,
    pago_por: body.pago_por || (body.tipo === 'cliente' ? body.cotista_id : 'SHARE'),
    aeronave_id: body.aeronave_id || null,
    origem_tipo: 'ENVIO_DESPESA',
    origem_id: envioId,
    idempotencyKey: `envio-despeza:${envioId}`,
    observacoes: [body.observacoes, `envio_despesa:${envioId}`].filter(Boolean).join(' | ') || null,
  }, user?.id || null)
  return resultado.id
}
async function inserirRateioFinanceiro(c: Context<{ Bindings: Bindings }>, body: Record<string, any>, user: any, lancamentoId: string | null, regra: ReturnType<typeof regraFinanceira>) {
  if (!regra.rateio) return null
  const id = uuid(); const cotistas = Array.isArray(body.cotista_ids) && body.cotista_ids.length ? body.cotista_ids : [body.cotista_id]
  const valor = Number(body.valor); const aeronave = body.aeronave_id ? await portalDb(c).prepare('SELECT matricula_registro FROM aeronave WHERE id=?').bind(body.aeronave_id).first<any>() : null
  const rows = await portalDb(c).prepare(`SELECT ca.id, ca.socio_id, hs.holding_id, hs.cotista_id, ca.percentual_sociedade, COALESCE(cl.razao_social, hs.nome) nome FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id=ca.cliente_id LEFT JOIN hold_socios hs ON hs.id=ca.socio_id WHERE ca.id IN (${cotistas.map(() => '?').join(',')})`).bind(...cotistas).all<any>()
  if (!rows.results.length) throw new Error('cotistas_invalidos_para_aeronave')
  const linhasInformadas = Array.isArray(body.rateio_linhas) ? body.rateio_linhas : []
  const percentuais = new Map(linhasInformadas.map((linha: any) => [String(linha.cotista_id), Math.max(0, Number(linha.percentual) || 0)]))
  const base = rows.results.map((r: any) => percentuais.has(String(r.id)) ? Number(percentuais.get(String(r.id))) : Number(r.percentual_sociedade || 0))
  const totalBase = base.reduce((n: number, item: number) => n + item, 0) || 100
  const percentuaisNormalizados = base.map((item: number) => +(item / totalBase * 100).toFixed(6))
  const diferenca = +(100 - percentuaisNormalizados.reduce((n: number, item: number) => n + item, 0)).toFixed(6)
  if (percentuaisNormalizados.length) percentuaisNormalizados[percentuaisNormalizados.length - 1] = +(percentuaisNormalizados[percentuaisNormalizados.length - 1] + diferenca).toFixed(6)
  const ids: string[] = []
  for (const [index, row] of (rows.results as any[]).entries()) { const rateioLinhaId = uuid(); ids.push(rateioLinhaId); const pct = cotistas.length === 1 ? 100 : percentuaisNormalizados[index]; const subcategoria = body.subcategoria_1 || null; await portalDb(c).prepare(`INSERT INTO rateio_despesas (id,lancamento_id,categoria_nome,categoria_custo_id,cotista_id,cotista_nome,aeronave_id,aeronave_registro,tipo_rateio,data_vencimento,data_emissao_nf,numero_voo,subcategoria_1,subcategoria_2,subcategoria_3,subcategoria_4,descricao_despesa,pago_por,pago_diretamente,percentual_sociedade,percentual_uso,valor_total,valor_rateado,status,observacoes,conferido_por,lancamentos_id,anexos_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(rateioLinhaId,lancamentoId,body.categoria_nome || regra.grupo,body.categoria_id || null,row.id,row.nome,body.aeronave_id || null,aeronave?.matricula_registro || null,body.tipo_rateio || 'FIXO',body.vencimento || null,body.data_despesa || null,body.numero_voo || null,subcategoria,body.subcategoria_2 || null,body.subcategoria_3 || null,body.subcategoria_4 || null,body.descricao,body.tipo === 'cliente' ? row.id : (body.pago_por || 'SHARE'),regra.pagoDiretamente,Number(row.percentual_sociedade || 0),pct,valor,+(valor*pct/100).toFixed(2),'pendente',body.observacoes || null,user.id,lancamentoId,JSON.stringify(body.anexos || [])).run() }
  if (body.tipo === 'cliente') {
    for (const [index, row] of (rows.results as any[]).entries()) if (row.holding_id && row.socio_id) {
      const movimentoId = uuid();
      const pct = cotistas.length === 1 ? 100 : percentuaisNormalizados[index];
      await inserirMovimentoHolding(portalDb(c), {
        id: movimentoId, holding_id: row.holding_id, socio_id: row.socio_id,
        cotista_id: row.cotista_id || row.id, aeronave_id: body.aeronave_id || null,
        data_movimento: body.data_despesa || new Date().toISOString().slice(0, 10),
        descricao: body.descricao, fornecedor_nome: body.fornecedor || null,
        categoria_nome: body.categoria_nome || regra.grupo, grupo_categoria: regra.grupo,
        natureza: 'DESPESA', fluxo: 'SAIDA', valor_centavos: Math.round(valor * pct / 100 * 100),
        pago_diretamente: 1, status: 'PAGO_DIRETAMENTE', observacoes: body.observacoes || null,
        criado_por: user.id,
      })
      await inserirRateioHolding(portalDb(c), {
        id: uuid(), movimento_holding_id: movimentoId, holding_id: row.holding_id, socio_id: row.socio_id,
        cotista_id: row.cotista_id || row.id, categoria_nome: body.categoria_nome || regra.grupo,
        categoria_id: body.categoria_id || null, aeronave_id: body.aeronave_id || null,
        tipo_rateio: body.tipo_rateio, pago_por: row.socio_id || row.id, pago_diretamente: 1,
        percentual_sociedade: Number(row.percentual_sociedade || 0), percentual_uso: pct,
        valor_total: valor, valor_rateado: +(valor * pct / 100).toFixed(2), status: 'PENDENTE',
        descricao_despesa: body.descricao, observacoes: body.observacoes || null,
      })
    }
  }
  return ids[0] || null
}
app.get('/api/financeiro/envios-pagamento/opcoes', async c => {
  const user = await shareBrasilUser(c); if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = portalDb(c); await garantirCategoriasCliente(c); const [fornecedores,aeronaves,categorias,categoriasCliente,voos] = await Promise.all([db.prepare('SELECT id, COALESCE(apelido,nome_completo) label FROM fornecedores_favoritos ORDER BY label').all(), db.prepare("SELECT id, matricula_registro, fabricante, modelo FROM aeronave WHERE lower(COALESCE(status,'ativa')) NOT IN ('inativa','cancelada') ORDER BY matricula_registro").all(), db.prepare('SELECT * FROM categoria_movimentacao_share ORDER BY nome').all(), db.prepare('SELECT * FROM categoria_movimentacao_cliente ORDER BY nome').all(), db.prepare("SELECT numero_voo, MAX(data_agendada) AS ultima_data, MAX(aeronave_id) AS aeronave_id FROM solicitacoes_reserva_voo WHERE numero_voo IS NOT NULL AND trim(numero_voo) <> '' GROUP BY numero_voo ORDER BY ultima_data DESC LIMIT 200").all().catch(() => ({ results: [] as any[] }))])
  const categoriasShare = (categorias.results as any[]).filter((item) => String(item.grupo_categoria ?? item.grupo ?? item.agrupamento ?? '').toUpperCase() === 'DESPESAS EMPRESA').map((item) => ({ id: String(item.id), nome: String(item.nome ?? item.categoria ?? item.descricao ?? item.titulo ?? '') })).filter((item) => item.nome)
  return c.json({ fornecedores: fornecedores.results, aeronaves: aeronaves.results, categorias: categoriasShare, categorias_cliente: categoriasCliente.results, voos: voos.results })
})
app.get('/api/financeiro/envios-pagamento/anexos-opcoes', async c => {
  const user = await shareBrasilUser(c); if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = portalDb(c)
  const [recibos, relatorios, abastecimentos] = await Promise.all([
    db.prepare(`SELECT r.id, r.numero_recibo, r.descricao_servico, r.data_emissao, a.id AS anexo_id, a.nome_arquivo, a.tipo_arquivo, '/api/financeiro/recibos/anexos/' || a.id || '/arquivo' AS arquivo_url FROM recibos r LEFT JOIN recibo_anexos a ON a.id = r.anexo_id ORDER BY r.criado_em DESC LIMIT 300`).all().catch(() => ({ results: [] as any[] })),
    db.prepare(`SELECT r.id, r.numero_voo, r.numero_relatorio, r.aeronave_id, ar.matricula_registro, a.id AS anexo_id, a.nome_arquivo, a.tipo_arquivo, '/api/financeiro/relatorios-despesa-viagem/' || r.id || '/pdf/arquivo' AS arquivo_url FROM relatorio_despesa_viagem r LEFT JOIN aeronave ar ON ar.id = r.aeronave_id LEFT JOIN relatorio_despesa_viagem_anexos a ON a.relatorio_despesa_viagem_id = r.id AND a.indice_despesa = -1 ORDER BY r.criado_em DESC LIMIT 300`).all().catch(() => ({ results: [] as any[] })),
    db.prepare(`SELECT a.id, a.numero_voo, a.trecho, a.data, a.numero_comanda, a.numero_nf, a.local, ar.matricula_registro, COALESCE(s.nome, cl.razao_social, 'Cotista não informado') AS cotista_nome, a.comanda_url, a.nota_url, a.boleto_url FROM abastecimentos a LEFT JOIN aeronave ar ON ar.id = a.aeronave_id LEFT JOIN hold_socios s ON s.id = a.socio_id LEFT JOIN cliente cl ON cl.id = a.cliente_id WHERE a.comanda_url IS NOT NULL OR a.nota_url IS NOT NULL OR a.boleto_url IS NOT NULL ORDER BY a.data DESC LIMIT 300`).all().catch(() => ({ results: [] as any[] })),
  ])
  return c.json({ recibos: recibos.results, relatorios: relatorios.results, abastecimentos: abastecimentos.results })
})
app.get('/api/financeiro/envios-pagamento/aeronave/:id/cotistas', async c => {
  const user = await shareBrasilUser(c); if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const rows = await portalDb(c).prepare(`SELECT ca.id,ca.cliente_id,ca.socio_id,ca.percentual_sociedade,COALESCE(cl.razao_social,hs.nome) nome,hs.holding_id,CASE WHEN hs.id IS NOT NULL THEN 1 ELSE 0 END eh_holding FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id=ca.cliente_id LEFT JOIN hold_socios hs ON hs.id=ca.socio_id WHERE ca.aeronave_id=? ORDER BY nome`).bind(c.req.param('id')).all()
  return c.json({ cotistas: rows.results })
})
app.get('/api/financeiro/envios-pagamento', async c => { const user = await shareBrasilUser(c); if (!user) return c.json({ error:'nao_autorizado' },401); await garantirTabelaEnvioDespesas(c); const tipo=c.req.query('tipo'); const rows=tipo?await portalDb(c).prepare('SELECT * FROM envio_despesas WHERE tipo=? ORDER BY criado_em DESC LIMIT 200').bind(tipo).all():await portalDb(c).prepare('SELECT * FROM envio_despesas ORDER BY criado_em DESC LIMIT 200').all(); return c.json({ envios: rows.results }) })
app.post('/api/financeiro/envios-pagamento', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaEnvioDespesas(c)
  await garantirCategoriasCliente(c)
  const body: Record<string, any> = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const tipo = String(body.tipo || '').toLowerCase()
  const descricao = String(body.descricao || '').trim()
  const valor = Number(body.valor)
  const regra = regraFinanceira(tipo, body.grupo_categoria)
  if (!['share', 'reembolso', 'cliente'].includes(tipo) || !descricao || !Number.isFinite(valor) || valor <= 0) return c.json({ error: 'tipo_descricao_e_valor_obrigatorios' }, 400)
  if (regra.rateio && (!body.aeronave_id || !((body.cotista_ids || []).length || body.cotista_id))) return c.json({ error: 'aeronave_e_cotista_obrigatorios' }, 400)
  const db = portalDb(c); const envioId = uuid(); let lancamentoId: string | null = null; let rateioId: string | null = null
  try {
    await garantirColunasLancamentoEnvio(c)
    lancamentoId = await inserirLancamentoFinanceira(c, { ...body, tipo, descricao, valor }, user, envioId, regra)
    rateioId = await inserirRateioFinanceiro(c, { ...body, tipo, descricao, valor }, user, lancamentoId, regra)
    const colunasResult = await db.prepare("SELECT name FROM pragma_table_info('envio_despesas')").all<any>()
    const existentes = new Set((colunasResult.results || []).map((row: any) => String(row.name)))
    const dados: Record<string, any> = {
      id: envioId, tipo, descricao, valor, data_despesa: body.data_despesa || null, vencimento: body.vencimento || null,
      fornecedor: body.fornecedor || null, fornecedor_id: body.fornecedor_id || null, cotista_id: body.cotista_id || null,
      cotista_ids: JSON.stringify(body.cotista_ids || []), aeronave_id: body.aeronave_id || null, numero_voo: body.numero_voo || null,
      centro_custo: body.centro_custo || null, categoria_id: body.categoria_id || null, categoria_nome: body.categoria_nome || null,
      subcategoria_1: body.subcategoria_1 || null, subcategoria_2: body.subcategoria_2 || null, subcategoria_3: body.subcategoria_3 || null, subcategoria_4: body.subcategoria_4 || null,
      tipo_rateio: body.tipo_rateio || null, rateio_linhas_json: JSON.stringify(body.rateio_linhas || []), observacoes: body.observacoes || null, periodicidade: body.periodicidade || null, anexos_json: JSON.stringify(body.anexos || []),
      status: regra.rateio ? 'aguardando_email' : 'aguardando_programacao', email_solicitado: regra.rateio && body.email_solicitado ? 1 : 0,
      criado_por: user.id, grupo_categoria: regra.grupo, tipo_caixa: regra.caixa, tipo_despesa: tipo === 'share' ? null : body.tipo_despesa || null,
      pago_diretamente: regra.pagoDiretamente, pago_por: tipo === 'share' ? null : (body.pago_por || (tipo === 'cliente' ? body.cotista_id : 'SHARE')),
      lancamento_id: lancamentoId, rateio_id: rateioId,
    }
    const colunas: string[] = []; const valores: any[] = []
    for (const coluna of Object.keys(dados)) if (existentes.has(coluna)) { colunas.push(coluna); valores.push(dados[coluna]) }
    if (!existentes.has('id') || colunas.length < 4) throw new Error('schema_envio_despesas_incompativel')
    await db.prepare(`INSERT INTO envio_despesas (${colunas.join(',')}) VALUES (${colunas.map(() => '?').join(',')})`).bind(...valores).run()
    const row = await db.prepare('SELECT * FROM envio_despesas WHERE id=?').bind(envioId).first()
    return c.json({ ...row, lancamento_id: lancamentoId, rateio_id: rateioId }, 201)
  } catch (e: any) {
    if (lancamentoId) await db.prepare('DELETE FROM lancamentos WHERE id=?').bind(lancamentoId).run().catch(() => undefined)
    return c.json({ error: 'falha_ao_criar_envio_pagamento', detail: e?.message || String(e) }, 500)
  }
})
app.patch('/api/financeiro/envios-pagamento/:id', async c => { const user=await shareBrasilUser(c); if(!user) return c.json({error:'nao_autorizado'},401); await garantirTabelaEnvioDespesas(c); const body: Record<string, any>=await c.req.json<Record<string,any>>().catch(()=>({} as Record<string, any>)); const id=c.req.param('id'); const fields:string[]=[]; const values:any[]=[]; if(body.status){fields.push('status=?');values.push(String(body.status))} if(body.email_solicitado!==undefined){fields.push('email_solicitado=?');values.push(body.email_solicitado?1:0)} if(body.email_enviado!==undefined){fields.push('email_enviado=?','email_enviado_em=?','email_id=?','status=?');values.push(body.email_enviado?1:0,body.email_enviado?new Date().toISOString():null,body.email_id||null,body.email_enviado?'email_enviado':'email_nao_enviado')} if(!fields.length) return c.json({error:'nenhuma_atualizacao'},400); fields.push('atualizado_em=CURRENT_TIMESTAMP'); await portalDb(c).prepare(`UPDATE envio_despesas SET ${fields.join(',')} WHERE id=?`).bind(...values,id).run(); const row=await portalDb(c).prepare('SELECT * FROM envio_despesas WHERE id=?').bind(id).first(); return row?c.json(row):c.json({error:'nao_encontrado'},404) })

// ─── Financeiro: central de e-mail ───────────────────────────────────────────
async function garantirTabelaEmails(c: Context<{ Bindings: Bindings }>) {
  void c
  return
  await portalDb(c).prepare('ALTER TABLE user_profiles ADD COLUMN email_envio TEXT').run().catch(() => undefined)
  await portalDb(c).prepare('CREATE TABLE IF NOT EXISTS assinaturas_email (id TEXT PRIMARY KEY NOT NULL, usuario_id TEXT NOT NULL UNIQUE, nome TEXT NOT NULL, cargo TEXT, telefone TEXT, endereco TEXT, email TEXT NOT NULL, logo_url TEXT, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)').run()
  await portalDb(c).prepare(`CREATE TABLE IF NOT EXISTS emails_enviados (
    id TEXT PRIMARY KEY NOT NULL,
    destinatarios TEXT NOT NULL,
    assunto TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    anexos TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'enviado',
    erro TEXT,
    enviado_por TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run()
}
function emailArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean)
  try { const parsed = JSON.parse(String(value || '[]')); return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean) : [] } catch { return [] }
}
function arrayBufferBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer); let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)))
  return btoa(binary)
}

function carimboAssinaturaHtml(dataEmissaoISO: string): string {
  const dataExtenso = new Date(`${dataEmissaoISO}T00:00:00`).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })

  return `
    <div style="text-align:center; font-family:Arial,sans-serif; width:280px; margin:50px auto 0;">
      <div style="font-size:13px; margin-bottom:8px; color:#222;">
        Várzea Grande-MT, ${dataExtenso}
      </div>
      <img src="data:image/png;base64,${SIGNATURE_BASE64}" alt="Assinatura" style="width:170px; height:auto; display:block; margin:0 auto;">
      <div style="border-top:1px solid #333; width:220px; margin:2px auto 8px;"></div>
      <div style="font-size:13px; font-weight:bold; color:#111;">Rolffe de Lima Erbe</div>
      <div style="font-size:12px; color:#555; margin-bottom:16px;">Gestor Responsável</div>
      <img src="data:image/png;base64,${SIGNATURE_LOGO_BASE64}" alt="Share Brasil" style="width:110px; height:auto; display:block; margin:0 auto 6px;">
      <div style="font-size:11px; color:#444;">Financeiro - SHARE BRASIL SERVICOS AEROPORTUARIOS</div>
    </div>
  `
}

app.get('/api/interno/emails', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = portalDb(c)
  await garantirTabelaEmails(c)
  const [clientes, socios, recibos, relatorios, abastecimentos, historico] = await Promise.all([
    db.prepare("SELECT id, razao_social, email_principal, emails FROM cliente WHERE lower(COALESCE(status,'ativo')) = 'ativo' ORDER BY razao_social").all(),
    db.prepare("SELECT id, nome, email_principal, cotista_id, holding_id FROM hold_socios WHERE email_principal IS NOT NULL AND trim(email_principal) <> '' ORDER BY nome").all(),
    db.prepare("SELECT id, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em FROM recibo_anexos ORDER BY criado_em DESC LIMIT 200").all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em FROM relatorio_despesa_viagem_anexos ORDER BY criado_em DESC LIMIT 200").all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, local, numero_comanda, numero_nf, comanda_url, nota_url, boleto_url FROM abastecimentos WHERE comanda_url IS NOT NULL OR nota_url IS NOT NULL OR boleto_url IS NOT NULL ORDER BY data DESC LIMIT 200").all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, destinatarios, assunto, status, anexos, erro_mensagem AS erro, criado_em FROM emails_enviados WHERE enviado_por = ?1 ORDER BY criado_em DESC LIMIT 100").bind(user.id).all(),
  ])
  const contatos: any[] = []
  for (const row of (clientes.results as any[])) {
    const emails = [row.email_principal, ...emailArray(row.emails)]
    for (const email of [...new Set(emails.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))]) contatos.push({ id: `${row.id}:${email}`, nome: row.razao_social, email, tipo: 'cliente', cliente_id: row.id })
  }
  for (const row of (socios.results as any[])) contatos.push({ id: `socio:${row.id}`, nome: row.nome, email: String(row.email_principal).trim().toLowerCase(), tipo: 'socio', cotista_id: row.cotista_id, holding_id: row.holding_id || null })
  const anexosAbastecimento = (abastecimentos.results as any[]).flatMap((row) => ([['comanda_url', 'Comanda'], ['nota_url', 'Nota fiscal'], ['boleto_url', 'Boleto']] as const).filter(([campo]) => row[campo]).map(([campo, titulo]) => ({ id: `abastecimento:${row.id}:${campo.replace('_url', '')}`, nome: `${titulo} · ${row.numero_comanda || row.numero_nf || row.local || 'Abastecimento'}`, origem: 'abastecimento', tipo_arquivo: null, tamanho_arquivo: null, arquivo_url: row[campo] })))
  const anexos = [...(recibos.results as any[]).map((row) => ({ id: `recibo:${row.id}`, nome: row.nome_arquivo, origem: 'recibo', tipo_arquivo: row.tipo_arquivo, tamanho_arquivo: row.tamanho_arquivo, arquivo_url: `/api/financeiro/recibos/anexos/${row.id}/arquivo` })), ...(relatorios.results as any[]).map((row) => ({ id: `relatorio:${row.id}`, nome: row.nome_arquivo, origem: 'relatorio_despesa_viagem', tipo_arquivo: row.tipo_arquivo, tamanho_arquivo: row.tamanho_arquivo, arquivo_url: `/api/financeiro/relatorios-despesa-viagem/anexos/${row.id}/arquivo` })), ...anexosAbastecimento]
  return c.json({ contatos, anexos, historico: (historico.results as any[]).map((row) => ({ ...row, destinatarios: emailArray(row.destinatarios), quantidade_anexos: emailArray(row.anexos).length })) })
})
const ASSINATURA_EMPRESA_OPERACIONAL = 'SHARE BRASIL SERVICOS AEROPORTUARIOS LTDA'
function campoDepartamento(row: any, nomes: string[]) {
  for (const nome of nomes) if (row?.[nome] !== undefined && row[nome] !== null && String(row[nome]).trim()) return String(row[nome]).trim()
  return ''
}
function normalizarChaveDepartamento(valor: unknown) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}
async function assinaturaOperacional(c: Context<{ Bindings: Bindings }>, user: any) {
  const rows = await portalDb(c).prepare('SELECT * FROM departamentos_email').all<any>().catch(() => ({ results: [] as any[] }))
  const departamento = normalizarChaveDepartamento(user.departamentos_email)
  const row = (rows.results || []).find((item: any) => normalizarChaveDepartamento(item?.nome) === departamento) || {}
  return {
    nome: String(user.email_envio || user.nome_completo || ASSINATURA_EMPRESA_OPERACIONAL),
    cargo: campoDepartamento(row, ['nome']),
    telefone: campoDepartamento(row, ['telefone_padrao']),
    endereco: campoDepartamento(row, ['endereco_padrao']),
    logo_url: campoDepartamento(row, ['logo_url', 'logo', 'url_logo']) || null,
  }
}
app.get('/api/minha-assinatura', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaEmails(c)
  return c.json(await assinaturaOperacional(c, user))
})
app.patch('/api/minha-assinatura', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaEmails(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const nome = String(body.nome || '').trim()
  if (!nome) return c.json({ error: 'nome_obrigatorio' }, 400)
  await portalDb(c).prepare('UPDATE user_profiles SET email_envio = ? WHERE id = ?').bind(nome, user.id).run()
  return c.json(await assinaturaOperacional(c, { ...user, email_envio: nome }))
})
app.get('/api/interno/emails/contas-bancarias', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const rows = await portalDb(c).prepare('SELECT * FROM contas_bancarias ORDER BY banco').all<any>().catch(() => ({ results: [] as any[] }))
  const contas = (rows.results || []).map((row: any) => {
    const banco = campoDepartamento(row, ['banco', 'nome_banco', 'instituicao'])
    const agencia = campoDepartamento(row, ['agencia', 'agencia_numero', 'numero_agencia']) || null
    const numero = campoDepartamento(row, ['numero_conta', 'conta_numero', 'conta']) || null
    const tipo = campoDepartamento(row, ['tipo_conta', 'tipo']) || null
    const cnpj = campoDepartamento(row, ['cnpj', 'documento']) || '30.898.549/0001-06'
    const razao = campoDepartamento(row, ['razao_social', 'empresa', 'titular']) || 'SHARE BRASIL SERVIÇOS AERONÁUTICOS'
    const pix = campoDepartamento(row, ['pix', 'chave_pix', 'pix_email']) || null
    const linhas = [`Banco ${banco || 'não informado'}`, agencia ? `Agência: ${agencia}` : '', numero ? `${tipo || 'Conta'}: ${numero}` : '', `CNPJ: ${cnpj}`, `Razão: ${razao}`, pix ? `PIX ${pix}` : ''].filter(Boolean)
    return { id: String(row.id), banco: banco || 'Conta bancária', agencia, numero_conta: numero, tipo_conta: tipo, cnpj, razao_social: razao, pix, texto: `Segue abaixo os dados bancários para pagamento:

${linhas.join('\n\n')}` }
  })
  return c.json({ contas })
})
app.patch('/api/interno/emails/contas-bancarias/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = portalDb(c); const id = c.req.param('id')
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const columns = await db.prepare("SELECT name FROM pragma_table_info('contas_bancarias')").all<any>().catch(() => ({ results: [] as any[] }))
  const existentes = new Set((columns.results || []).map((row: any) => String(row.name)))
  const mapeamentos: Record<string, string[]> = { banco: ['banco', 'nome_banco', 'instituicao'], agencia: ['agencia', 'agencia_numero', 'numero_agencia'], numero_conta: ['numero_conta', 'conta_numero', 'conta'], tipo_conta: ['tipo_conta', 'tipo'], cnpj: ['cnpj', 'documento'], razao_social: ['razao_social', 'empresa', 'titular'], pix: ['pix', 'chave_pix', 'pix_email'] }
  const atualizacoes: Array<[string, any]> = []
  for (const [campo, candidatos] of Object.entries(mapeamentos)) { if (body[campo] === undefined) continue; const coluna = candidatos.find((item) => existentes.has(item)); if (coluna) atualizacoes.push([coluna, String(body[campo] || '').trim() || null]) }
  if (!atualizacoes.length) return c.json({ error: 'nenhum_campo_atualizavel' }, 400)
  for (const [coluna, valor] of atualizacoes) await db.prepare(`UPDATE contas_bancarias SET ${coluna} = ? WHERE id = ?`).bind(valor, id).run()
  return c.json({ ok: true })
})
app.post('/api/interno/emails', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const multipart = c.req.header('content-type')?.includes('multipart/form-data')
  const body = multipart ? await c.req.parseBody() : await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const destinatarios = emailArray(body.destinatarios)
  const assunto = String(body.assunto || '').trim(); const mensagem = [String(body.mensagem || '').trim(), String(body.dados_bancarios || '').trim()].filter(Boolean).join('\n\n'); const ids = Array.isArray(body.anexos) ? body.anexos.map(String) : (() => { try { const parsed = JSON.parse(String(body.anexos || '[]')); return Array.isArray(parsed) ? parsed.map(String) : [] } catch { return [] } })()
  if (!destinatarios.length || !assunto || !mensagem) return c.json({ error: 'destinatario_assunto_e_mensagem_obrigatorios' }, 400)
  if (destinatarios.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return c.json({ error: 'destinatario_invalido' }, 400)
  if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) return c.json({ error: 'email_nao_configurado' }, 503)
  await garantirTabelaEmails(c)
  const db = portalDb(c); const anexos: any[] = []
  for (const id of ids.slice(0, 10)) {
    const [prefix, rawId, tipoAbastecimento] = id.includes(':') ? id.split(':', 3) : ['', id]
    if (prefix === 'abastecimento') {
      const column = tipoAbastecimento === 'nota' ? 'nota_url' : tipoAbastecimento === 'boleto' ? 'boleto_url' : 'comanda_url'
      const row = await db.prepare(`SELECT ${column} AS caminho FROM abastecimentos WHERE id = ?1`).bind(rawId).first<any>().catch(() => null)
      if (row?.caminho) {
        let key = row.caminho
        try { key = new URL(row.caminho).searchParams.get('key') || key } catch { /* chave legada */ }
        const object = await shareBrasilBucket(c).get(key)
        if (object) anexos.push({ filename: key.split('/').pop() || `abastecimento-${tipoAbastecimento}`, content: arrayBufferBase64(await object.arrayBuffer()), content_type: object.httpMetadata?.contentType || 'application/octet-stream' })
      }
      continue
    }
    const table = prefix === 'recibo' ? 'recibo_anexos' : prefix === 'relatorio' ? 'relatorio_despesa_viagem_anexos' : ''
    if (!table) continue
    const row = await db.prepare(`SELECT nome_arquivo, caminho_arquivo, tipo_arquivo FROM ${table} WHERE id = ?1`).bind(rawId).first<any>().catch(() => null)
    if (!row) continue
    const object = await shareBrasilBucket(c).get(row.caminho_arquivo); if (!object) continue
    anexos.push({ filename: row.nome_arquivo, content: arrayBufferBase64(await object.arrayBuffer()), content_type: row.tipo_arquivo || 'application/octet-stream' })
  }
  const arquivosLocais = (Array.isArray(body.arquivos) ? body.arquivos : body.arquivos ? [body.arquivos] : []).filter((file): file is File => file instanceof File && !!file.size)
  for (const file of arquivosLocais.slice(0, 10)) anexos.push({ filename: file.name, content: arrayBufferBase64(await file.arrayBuffer()), content_type: file.type || 'application/octet-stream' })
  const id = uuid(); let status = 'enviado'; let erro: string | null = null
  const assinaturaAtual = await assinaturaOperacional(c, user)
  const logoRemota = /^https?:\/\//i.test(String(assinaturaAtual.logo_url || '').trim())
  const logoInline = logoRemota ? [] : [{ filename: 'share-brasil-logo.png', content: SIGNATURE_LOGO_BASE64, content_type: 'image/png', content_id: SIGNATURE_LOGO_CID }]
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: c.env.EMAIL_FROM.includes('<') ? c.env.EMAIL_FROM : `${assinaturaAtual.nome} <${c.env.EMAIL_FROM}>`, reply_to: user.email, to: destinatarios, subject: assunto, html: `<p>${escapeHtml(mensagem).replace(/\n/g, '<br>')}</p>${assinaturaHtml(assinaturaAtual)}`, attachments: [...logoInline, ...anexos] }) })
  if (!response.ok) { status = 'erro'; erro = await response.text().catch(() => 'falha_ao_enviar_email') }
  await db.prepare('INSERT INTO emails_enviados (id, destinatarios, assunto, mensagem, anexos, quantidade_anexos, status, erro_mensagem, enviado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, JSON.stringify(destinatarios), assunto, mensagem, JSON.stringify(ids), ids.length, status, erro, user.id).run()
  if (status === 'erro') return c.json({ error: 'falha_ao_enviar_email', id }, 502)
  return c.json({ success: true, id }, 201)
})
// ─── Financeiro: emissão de recibos (cliente reembolsável / caixa cliente / colaborador) ──
const PAGADOR_PADRAO_RECIBO = {
  nome: 'SHARE BRASIL SERVIÇOS AERONÁUTICOS',
  documento: '30.898.549/0001-06',
  endereco: 'AV. PRES. ARTHUR BERNARDES, 1457',
  cidade: 'VÁRZEA GRANDE',
  uf: 'MT',
} as const
// Segue as regras de REGRAS_NEGOCIO_FINANCEIRO.md: toda despesa nasce em `lancamentos`;
// despesa de cliente (direta ou reembolsável) sempre gera `rateio_despesas`; `rateio_despesas`
// é agnóstico a quem desembolsou (isso vive só em `lancamentos`/`tipo_caixa`); rateio entre
// cotistas usa `cotista_aeronave` (cliente_id OU socio_id, cobrindo também clientes com holding).
async function garantirTabelasRecibos(c: Context<{ Bindings: Bindings }>) {
  void c
  return
  const db = portalDb(c)
  const tabelas = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('recibos', 'recibo_rateio', 'recibo_anexos')").all<{ name: string }>()
  const existentes = new Set(tabelas.results.map((item) => item.name))
  const ausentes = ['recibos', 'recibo_rateio', 'recibo_anexos'].filter((nome) => !existentes.has(nome))
  if (ausentes.length) log.warn('[recibos] tabelas ausentes; inicializando schema', { tabelas: ausentes })

  await db.prepare(`CREATE TABLE IF NOT EXISTS recibos (
    id TEXT PRIMARY KEY NOT NULL,
    numero_recibo TEXT NOT NULL,
    tipo_recibo TEXT NOT NULL CHECK (tipo_recibo IN ('cliente_direto','cliente_reembolsavel','colaborador','pagamento')),
    beneficiario_tipo TEXT NOT NULL CHECK (beneficiario_tipo IN ('cliente','colaborador','freelancer','fornecedor')),
    cliente_id TEXT,
    colaborador_id TEXT,
    freelancer_id TEXT,
    cotista_id TEXT,
    recebedor_nome TEXT,
    recebedor_cpf TEXT,
    aeronave_id TEXT,
    rateado INTEGER NOT NULL DEFAULT 0,
    nome_pagador TEXT NOT NULL,
    documento_pagador TEXT,
    endereco_pagador TEXT,
    cidade_pagador TEXT,
    uf_pagador TEXT,
    valor REAL NOT NULL,
    descricao_servico TEXT NOT NULL,
    data_emissao TEXT NOT NULL,
    data_vencimento TEXT,
    forma_pagamento TEXT,
    numero_documento_anexo TEXT,
    anexo_id TEXT,
    pdf_anexo_id TEXT,
    pdf_url TEXT,
    observacoes TEXT,
    categoria_lancamento_id TEXT,
    categoria_movimentacao_id TEXT,
    categoria_id TEXT,
    tipo_despesa TEXT,
    grupo_categoria TEXT NOT NULL,
    tipo_caixa TEXT NOT NULL,
    natureza_despesa TEXT,
    periodicidade TEXT,
    tipo_rateio TEXT,
    subcategoria_1 TEXT,
    subcategoria_2 TEXT,
    subcategoria_3 TEXT,
    subcategoria_4 TEXT,
    status TEXT NOT NULL DEFAULT 'emitido' CHECK (status IN ('emitido','aguardando_reembolso','reembolsado','cancelado')),
    boleto_url TEXT,
    nf_url TEXT,
    recibo_url TEXT,
    lancamento_id TEXT,
    movimentacao_id TEXT,
    lancamento_reembolso_id TEXT,
    criado_por TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS recibos_criado_idx ON recibos(criado_em DESC)`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS recibo_anexos (id TEXT PRIMARY KEY NOT NULL, recibo_id TEXT, finalidade TEXT, nome_arquivo TEXT NOT NULL, caminho_arquivo TEXT NOT NULL, tipo_arquivo TEXT NOT NULL, tamanho_arquivo INTEGER NOT NULL DEFAULT 0, enviado_por TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP)`).run().catch(() => undefined)
  await db.prepare('ALTER TABLE recibo_anexos ADD COLUMN recibo_id TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE recibo_anexos ADD COLUMN finalidade TEXT').run().catch(() => undefined)
  await db.prepare(`CREATE INDEX IF NOT EXISTS recibos_numero_idx ON recibos(numero_recibo)`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS recibo_rateio (
    id TEXT PRIMARY KEY NOT NULL,
    recibo_id TEXT NOT NULL,
    rateio_despesas_id TEXT NOT NULL,
    cotista_id TEXT NOT NULL,
    nome TEXT,
    percentual REAL NOT NULL,
    valor REAL NOT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS rateio_hold (
    id TEXT PRIMARY KEY NOT NULL, movimentos_holding_id TEXT, categoria_nome TEXT, categoria_custo_id TEXT,
    fornecedor_id TEXT, cotista_id TEXT, cotista_nome TEXT, aeronave_id TEXT, tipo_rateio TEXT,
    data_vencimento TEXT, data_emissao_nf TEXT, numero_voo TEXT, subcategoria_1 TEXT, subcategoria_2 TEXT,
    subcategoria_3 TEXT, subcategoria_4 TEXT, descricao_despesa TEXT, pago_por TEXT, pago_diretamente INTEGER,
    percentual_sociedade REAL, percentual_uso REAL, valor_total REAL, valor_rateado REAL, status TEXT,
    observacoes TEXT, conferido_por TEXT, anexos_json TEXT DEFAULT '[]'
  )`).run().catch((error) => log.error('[recibos] rateio_hold indisponível:', error?.message || error))
  for (const coluna of ['cliente_id TEXT', 'colaborador_id TEXT', 'freelancer_id TEXT', 'cotista_id TEXT', 'recebedor_nome TEXT', 'recebedor_cpf TEXT', 'numero_documento_anexo TEXT', 'anexo_id TEXT', 'pdf_anexo_id TEXT', 'pdf_url TEXT', 'observacoes TEXT', 'natureza_despesa TEXT', 'categoria_lancamento_id TEXT', 'categoria_movimentacao_id TEXT', 'categoria_id TEXT', 'lancamento_id TEXT', 'lancamento_reembolso_id TEXT', 'movimentacao_id TEXT', 'periodicidade TEXT', 'tipo_rateio TEXT', 'subcategoria_1 TEXT', 'subcategoria_2 TEXT', 'subcategoria_3 TEXT', 'subcategoria_4 TEXT', 'recibo_url TEXT']) await db.prepare(`ALTER TABLE recibos ADD COLUMN ${coluna}`).run().catch(() => undefined)
  const schema = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recibos'").first<{ sql: string }>()
  const schemaSql = schema?.sql || ''
  if ((/CHECK\s*\(\s*tipo_recibo/i.test(schemaSql) && !schemaSql.includes("'pagamento'")) || (/CHECK\s*\(\s*beneficiario_tipo/i.test(schemaSql) && !schemaSql.includes("'freelancer'"))) {
    await db.prepare('ALTER TABLE recibos RENAME TO recibos_legacy').run()
    await db.prepare(`CREATE TABLE recibos (
      id TEXT PRIMARY KEY NOT NULL, numero_recibo TEXT NOT NULL,
      tipo_recibo TEXT NOT NULL CHECK (tipo_recibo IN ('cliente_direto','cliente_reembolsavel','colaborador','pagamento')),
      beneficiario_tipo TEXT NOT NULL CHECK (beneficiario_tipo IN ('cliente','colaborador','freelancer','fornecedor')),
      cliente_id TEXT, colaborador_id TEXT, freelancer_id TEXT, cotista_id TEXT,
      recebedor_nome TEXT, recebedor_cpf TEXT, aeronave_id TEXT,
      rateado INTEGER NOT NULL DEFAULT 0, nome_pagador TEXT NOT NULL, documento_pagador TEXT,
      endereco_pagador TEXT, cidade_pagador TEXT, uf_pagador TEXT, valor REAL NOT NULL,
      descricao_servico TEXT NOT NULL, data_emissao TEXT NOT NULL, data_vencimento TEXT,
      forma_pagamento TEXT, numero_documento_anexo TEXT, anexo_id TEXT, pdf_anexo_id TEXT, pdf_url TEXT, observacoes TEXT,
      categoria_lancamento_id TEXT, categoria_movimentacao_id TEXT, categoria_id TEXT, tipo_despesa TEXT,
      grupo_categoria TEXT NOT NULL, tipo_caixa TEXT NOT NULL, natureza_despesa TEXT, periodicidade TEXT,
      tipo_rateio TEXT, subcategoria_1 TEXT, subcategoria_2 TEXT, subcategoria_3 TEXT, subcategoria_4 TEXT,
      status TEXT NOT NULL DEFAULT 'emitido', boleto_url TEXT, nf_url TEXT, recibo_url TEXT,
      lancamento_id TEXT, movimentacao_id TEXT, lancamento_reembolso_id TEXT, criado_por TEXT,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run()
    await db.prepare(`INSERT INTO recibos (id, numero_recibo, tipo_recibo, beneficiario_tipo, cliente_id, colaborador_id, recebedor_nome, recebedor_cpf, aeronave_id, rateado, nome_pagador, documento_pagador, endereco_pagador, cidade_pagador, uf_pagador, valor, descricao_servico, data_emissao, data_vencimento, forma_pagamento, categoria_lancamento_id, tipo_despesa, grupo_categoria, tipo_caixa, status, boleto_url, nf_url, lancamento_id, lancamento_reembolso_id, criado_por, criado_em)
      SELECT id, numero_recibo, tipo_recibo, beneficiario_tipo, cliente_id, colaborador_id, recebedor_nome, recebedor_cpf, aeronave_id, rateado, nome_pagador, documento_pagador, endereco_pagador, cidade_pagador, uf_pagador, valor, descricao_servico, data_emissao, data_vencimento, forma_pagamento, categoria_lancamento_id, tipo_despesa, grupo_categoria, tipo_caixa, status, boleto_url, nf_url, lancamento_id, lancamento_reembolso_id, criado_por, criado_em FROM recibos_legacy`).run()
    await db.prepare('DROP TABLE recibos_legacy').run()
  }
  await db.prepare('ALTER TABLE recibos ADD COLUMN natureza_despesa TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE recibo_rateio ADD COLUMN cotista_id TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE rateio_despesas ADD COLUMN lancamentos_id TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE rateio_despesas ADD COLUMN cotista_id TEXT').run().catch(() => undefined)
  for (const coluna of ['cotista_id TEXT', 'categoria_id TEXT', 'categoria_movimentacao_id TEXT']) await db.prepare(`ALTER TABLE lancamentos ADD COLUMN ${coluna}`).run().catch(() => undefined)
  await db.prepare('ALTER TABLE movimentos_holding ADD COLUMN cotista_id TEXT').run().catch(() => undefined)
  for (const coluna of ['numero_recibo TEXT', 'recibo_url TEXT']) await db.prepare(`ALTER TABLE rateio_despesas ADD COLUMN ${coluna}`).run().catch(() => undefined)
  for (const coluna of ['numero_recibo TEXT', 'recibo_url TEXT']) await db.prepare(`ALTER TABLE rateio_hold ADD COLUMN ${coluna}`).run().catch(() => undefined)
  await db.prepare(`CREATE INDEX IF NOT EXISTS recibo_rateio_recibo_idx ON recibo_rateio(recibo_id)`).run()
}

// Mesma regra usada em /api/financeiro/envios-pagamento: define grupo_categoria, tipo_caixa,
// se gera rateio, e se foi pago diretamente pelo cliente (sem a Share intermediar).
function regraFinanceiraRecibo(beneficiarioTipo: 'cliente' | 'colaborador', reembolsavel: boolean, grupoInformado?: string) {
  if (beneficiarioTipo === 'colaborador') return regraFinanceira('share', grupoInformado)
  return regraFinanceira(reembolsavel ? 'reembolso' : 'cliente', grupoInformado)
}

async function proximoNumeroRecibo(c: Context<{ Bindings: Bindings }>, codigo: string): Promise<string> {
  const ano = new Date().getFullYear()
  const anoCurto = String(ano).slice(-2)
  const prefixo = `REC-${codigo.toUpperCase().slice(0, 3)}`
  const like = `${prefixo}%/${anoCurto}`
  const row = await portalDb(c).prepare('SELECT COUNT(*) AS total FROM recibos WHERE numero_recibo LIKE ?1').bind(like).first<{ total: number }>()
  const seq = (row?.total || 0) + 1
  return `${prefixo}${String(seq).padStart(3, '0')}/${anoCurto}`
}

async function proximoNumeroReciboSaida(c: Context<{ Bindings: Bindings }>, codigo: string, dataEmissao: string): Promise<string> {
  const ano = /^\d{4}-\d{2}-\d{2}/.test(dataEmissao) ? Number(dataEmissao.slice(0, 4)) : new Date().getFullYear()
  const anoCurto = String(ano).slice(-2)
  const prefixo = `REC-${codigo.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'CLI'}`
  const like = `${prefixo}%/${anoCurto}`
  const row = await portalDb(c).prepare('SELECT COUNT(*) AS total FROM recibos_saida WHERE numero_recibo LIKE ?1').bind(like).first<{ total: number }>().catch(() => null)
  const seq = (row?.total || 0) + 1
  return `${prefixo}${String(seq).padStart(3, '0')}/${anoCurto}`
}

async function buscarCategoriasRecibo(c: Context<{ Bindings: Bindings }>) {
  const db = portalDb(c)
  for (const tabela of ['categoria_movimentacao_share', 'categorias_caixa_share']) {
    const rows = await db.prepare(`SELECT * FROM ${tabela}`).all<any>().catch(() => ({ results: [] as any[] }))
    const categorias = rows.results
      .map((row) => ({ ...row, grupo_normalizado: String(row.grupo_categoria ?? row.grupo ?? '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') }))
      .filter((row) => ['DESPESAS EMPRESA', 'DESPESAS REEMBOLSAVEIS'].includes(row.grupo_normalizado))
      .map((row) => ({ id: String(row.id), nome: String(row.nome ?? row.categoria ?? row.descricao ?? ''), grupo_categoria: row.grupo_normalizado === 'DESPESAS REEMBOLSAVEIS' ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA', tipo_despesa: row.tipo_despesa ?? row.tipo ?? null }))
      .filter((row) => row.id && row.nome)
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    if (categorias.length) return categorias
  }
  return []
}
// ─── Financeiro: notas fiscais e recibos de saída ───
const CATEGORIA_CLIENTE_NF_SAIDA = '928cc6be-cb78-4b83-ac63-bd386686a8c9' // categoria_movimentacao_cliente "ADM SHARE BRASIL"
const CATEGORIA_CLIENTE_NF_SAIDA_NOME = 'ADM SHARE BRASIL'
const CATEGORIA_CLIENTE_NF_SAIDA_SUB_RECIBO = 'ADM SHARE - RECIBO' // subcategoria_1 dessa categoria
const CATEGORIA_CLIENTE_NF_SAIDA_SUB_NF = 'ADM SHARE - N.F'        // subcategoria_2 dessa categoria
const FORNECEDOR_SHARE_BRASIL_NOME = 'SHARE BRASIL'

const CATEGORIA_SHARE_RECIBO = '73355581-c479-4a5d-b90b-90b3332f198e'               // ADM SHARE - RECIBO
const CATEGORIA_SHARE_NF_DIARIAS = 'b5143aad-88ed-4649-9f17-3ff15904bda2'           // N.F DIARIAS DE VOO
const CATEGORIA_SHARE_NF_ADM_PILOTAGEM = '643fd58f-ae2f-4269-9d5a-93345d613fb9'     // ADM E PILOTAGEM - N.F
const CATEGORIA_SHARE_RECIBO_ADM_PILOTAGEM = '2874b45b-a3bb-4bec-8f7e-74b328f8693c' // ADM E PILOTAGEM - RECIBO
const CATEGORIA_SHARE_NF_ADM = '352095f3-a97a-4539-ad1a-b1471e577583'               // N.F ADM SHARE

const CATEGORIAS_RECEITA_SHARE: Record<string, string> = {
  [CATEGORIA_SHARE_RECIBO]: 'ADM SHARE - RECIBO',
  [CATEGORIA_SHARE_NF_DIARIAS]: 'N.F DIARIAS DE VOO',
  [CATEGORIA_SHARE_NF_ADM_PILOTAGEM]: 'ADM E PILOTAGEM - N.F',
  [CATEGORIA_SHARE_RECIBO_ADM_PILOTAGEM]: 'ADM E PILOTAGEM - RECIBO',
  [CATEGORIA_SHARE_NF_ADM]: 'N.F ADM SHARE',
}

/** Resolve a categoria de receita do Caixa Share. Prioriza o id vindo do front
 *  (dropdown de /notas-saida/opcoes); só cai pra heurística por nome se não vier id.
 *  Diferente da versão anterior, agora respeita "ADM E PILOTAGEM - RECIBO" quando
 *  é recibo de pilotagem (antes caía sempre em "ADM SHARE - RECIBO"). */
function resolverCategoriaReceitaShare(body: Record<string, any>, isRecibo: boolean): string {
  const idInformado = String(body.categoria_receita_id || '').trim()
  if (idInformado && CATEGORIAS_RECEITA_SHARE[idInformado]) return idInformado
  const nomeInformado = String(body.categoria_receita_nome || body.nome_categoria || '').toUpperCase()
  if (isRecibo) return nomeInformado.includes('PILOTAGEM') ? CATEGORIA_SHARE_RECIBO_ADM_PILOTAGEM : CATEGORIA_SHARE_RECIBO
  if (nomeInformado.includes('DIARIA')) return CATEGORIA_SHARE_NF_DIARIAS
  if (nomeInformado.includes('PILOTAGEM')) return CATEGORIA_SHARE_NF_ADM_PILOTAGEM
  return CATEGORIA_SHARE_NF_ADM
}

async function garantirTabelasNfSaida(c: Context<{ Bindings: Bindings }>) {
  void c
  return
  const db = portalDb(c)
  // Os CREATE TABLE abaixo espelham exatamente o schema real (recibos_saida /
  // notas_fiscais_saida) — IF NOT EXISTS só entra em ação em ambiente novo.
  await db.prepare(`CREATE TABLE IF NOT EXISTS notas_fiscais_saida (
    id TEXT PRIMARY KEY NOT NULL,
    numero TEXT NOT NULL,
    cotista_aeronave_id TEXT NOT NULL,
    data_criacao TEXT NOT NULL,
    data_vencimento TEXT NOT NULL,
    valor REAL NOT NULL,
    categoria TEXT NOT NULL,
    descricao TEXT NULL,
    status TEXT NOT NULL,
    arquivo_pdf_url TEXT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    criado_por TEXT NULL,
    aeronave_id TEXT NULL,
    lancamentos_id TEXT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS recibos_saida (
    id TEXT PRIMARY KEY NOT NULL,
    numero_recibo TEXT NOT NULL,
    tipo_recibo TEXT NULL,
    cotista_id TEXT NULL,
    aeronave_id TEXT NULL,
    valor_total REAL NULL,
    percentual REAL NULL,
    descricao_servico TEXT NOT NULL,
    nome_categoria TEXT NULL,
    categoria_id TEXT NULL,
    subcategoria_1 TEXT NULL,
    subcategoria_2 TEXT NULL,
    subcategoria_3 TEXT NULL,
    subcategoria_4 TEXT NULL,
    data_emissao TEXT NOT NULL,
    data_vencimento TEXT NULL,
    data_max_pagamento TEXT NULL,
    status TEXT NULL DEFAULT 'pendente',
    pdf_url TEXT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    contas_areceber_id TEXT NULL,
    lancamentos_id TEXT NULL,
    criado_por TEXT NULL
  )`).run()
  // Mesma tabela de anexos usada pelos recibos "internos" — passa a receber
  // também os anexos de NF/recibo de saída.
  await db.prepare(`CREATE TABLE IF NOT EXISTS recibo_anexos (
    id TEXT PRIMARY KEY NOT NULL,
    recibo_id TEXT,
    finalidade TEXT,
    nome_arquivo TEXT NOT NULL,
    caminho_arquivo TEXT NOT NULL,
    tipo_arquivo TEXT NOT NULL,
    tamanho_arquivo INTEGER NOT NULL DEFAULT 0,
    enviado_por TEXT,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run()
  // Instalações antigas podem já ter a tabela sem as colunas usadas pelo
  // vínculo do PDF com o recibo. CREATE IF NOT EXISTS não atualiza o schema.
  for (const coluna of ['recibo_id TEXT', 'finalidade TEXT']) {
    await db.prepare(`ALTER TABLE recibo_anexos ADD COLUMN ${coluna}`).run().catch(() => undefined)
  }
  // Instalações antigas usam lancamento_id; as novas usam lancamentos_id.
  await db.prepare('ALTER TABLE notas_fiscais_saida ADD COLUMN lancamento_id TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE recibos_saida ADD COLUMN lancamento_id TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE recibos_saida ADD COLUMN contas_areceber_id TEXT').run().catch(() => undefined)
}

async function inserirLinhaDinamica(db: any, table: string, row: Record<string, any>) {
  const info = await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as any
  const cols = new Set((info.results || []).map((x: any) => x.name))
  const entries = Object.entries(row).filter(([k]) => cols.has(k))
  if (!entries.length) throw new Error(`tabela_${table}_sem_colunas`)
  const names = entries.map(([k]) => k); const vals = entries.map(([, v]) => v ?? null)
  await db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map((_, i) => `?${i + 1}`).join(',')})`).bind(...vals).run()
}

function tipoRateioHolding(value: unknown): 'SOCIEDADE' | 'USO' | 'IGUALITARIO' | 'MANUAL' {
  const tipo = String(value || '').trim().toUpperCase()
  if (tipo === 'SOCIEDADE' || tipo === 'USO' || tipo === 'IGUALITARIO' || tipo === 'MANUAL') return tipo
  if (tipo.includes('SOCIEDADE')) return 'SOCIEDADE'
  if (tipo.includes('USO')) return 'USO'
  return 'MANUAL'
}

async function inserirRateioHolding(db: any, row: Record<string, any>) {
  const valorTotalCentavos = row.valor_total_centavos != null ? Number(row.valor_total_centavos) : Math.round(Number(row.valor_total || 0) * 100)
  const valorRateadoCentavos = row.valor_rateado_centavos != null ? Number(row.valor_rateado_centavos) : Math.round(Number(row.valor_rateado || 0) * 100)
  await inserirLinhaDinamica(db, 'rateio_hold', {
    id: row.id,
    movimentos_holding_id: row.movimentos_holding_id ?? row.movimento_holding_id,
    aeronave_id: row.aeronave_id,
    holding_id: row.holding_id,
    socio_id: row.socio_id,
    cotista_id: row.cotista_id,
    categoria_id: row.categoria_id ?? row.categoria_custo_id,
    categoria_nome: row.categoria_nome,
    tipo_rateio: tipoRateioHolding(row.tipo_rateio),
    percentual_sociedade: row.percentual_sociedade,
    percentual_uso: row.percentual_uso,
    valor_total_centavos: valorTotalCentavos,
    valor_rateado_centavos: valorRateadoCentavos,
    valor_pago_real_centavos: row.valor_pago_real_centavos ?? 0,
    pago_por_socio_id: row.pago_por_socio_id ?? row.pago_por,
    pago_diretamente: row.pago_diretamente,
    status: String(row.status || 'PENDENTE').toUpperCase(),
    data_pagamento: row.data_pagamento,
    descricao_despesa: row.descricao_despesa,
    observacoes: row.observacoes,
  })
}

function naturezaMovimentoHolding(value: unknown): 'RECEITA' | 'DESPESA' | 'REEMBOLSO' | 'APORTE' | 'RETIRADA' | 'AJUSTE' {
  const natureza = String(value || '').trim().toUpperCase()
  if (natureza === 'RECEITA' || natureza === 'DESPESA' || natureza === 'REEMBOLSO' || natureza === 'APORTE' || natureza === 'RETIRADA' || natureza === 'AJUSTE') return natureza
  if (natureza.includes('REEMBOLSO')) return 'REEMBOLSO'
  if (natureza.includes('APORTE') || natureza.includes('DEPOSITO')) return 'APORTE'
  if (natureza.includes('RETIRADA')) return 'RETIRADA'
  return 'DESPESA'
}

async function inserirMovimentoHolding(db: any, row: Record<string, any>) {
  await inserirLinhaDinamica(db, 'movimentos_holding', {
    id: row.id,
    holding_id: row.holding_id,
    socio_id: row.socio_id,
    cotista_id: row.cotista_id,
    aeronave_id: row.aeronave_id,
    data_movimento: row.data_movimento ?? row.data,
    data_vencimento: row.data_vencimento ?? row.prazo,
    data_pagamento: row.data_pagamento,
    descricao: row.descricao,
    fornecedor_id: row.fornecedor_id,
    fornecedor_nome: row.fornecedor_nome ?? row.fornecedor,
    categoria_id: row.categoria_id,
    categoria_nome: row.categoria_nome ?? row.categoria,
    grupo_categoria: row.grupo_categoria,
    fluxo: String(row.fluxo || 'SAIDA').toUpperCase(),
    natureza: naturezaMovimentoHolding(row.natureza ?? row.tipo),
    valor_centavos: row.valor_centavos,
    status: String(row.status || 'EM_ABERTO').toUpperCase(),
    pago_diretamente: row.pago_diretamente ?? 0,
    conta_bancaria_id: row.conta_bancaria_id,
    forma_pagamento: row.forma_pagamento,
    comprovante_url: row.comprovante_url,
    observacoes: row.observacoes,
    criado_por: row.criado_por,
  })
}

const TIPOS_RATEIO_D1 = new Set(['FIXO', 'VARIAVEL POR VOO', 'VARIAVEL POR HORA', 'EXTRA'])
function normalizarTipoRateioD1(value: unknown): string {
  const tipo = String(value || '').trim().toUpperCase()
  return TIPOS_RATEIO_D1.has(tipo) ? tipo : 'FIXO'
}

async function contextoNfSaida(c: Context<{ Bindings: Bindings }>, cotistaId: string) {
  return portalDb(c).prepare(`SELECT ca.id cotista_id,ca.aeronave_id,ca.cliente_id,ca.socio_id,hs.holding_id,COALESCE(ca.codigo_cliente,cl.codigo_cliente,'CLI') codigo_cliente,COALESCE(cl.razao_social,hs.nome) nome,cl.cnpj FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id=ca.cliente_id LEFT JOIN hold_socios hs ON hs.id=ca.socio_id WHERE ca.id=?1`).bind(cotistaId).first<any>()
}

async function gerarFinanceiroNfSaida(
  c: Context<{ Bindings: Bindings }>,
  ctx: any,
  body: any,
  origem: 'nf_saida' | 'recibo_saida',
  documentoId: string,
) {
  const db = portalDb(c)
  const valor = Number(body.valor ?? body.valor_total)
  if (!(valor > 0)) throw new Error('valor_invalido')

  const isRecibo = origem === 'recibo_saida'
  const categoriaShareId = resolverCategoriaReceitaShare(body, isRecibo)
  const nomeCategoriaShare = CATEGORIAS_RECEITA_SHARE[categoriaShareId]
  const descricao = String(body.descricao || body.descricao_servico || `${isRecibo ? 'Recibo' : 'Nota fiscal'} de saída ${body.numero || ''}`).trim()
  const usuario = await shareBrasilUser(c)
  const dataEmissao = String(body.data_criacao || body.data_emissao || '').trim()
  const dataVencimento = String(body.data_vencimento || dataEmissao || '').trim()

  // 1) Entrada pendente no Caixa Share — sempre uma das 5 categorias de receita.
  //    fluxo/status/caixa têm CHECK em maiúsculas em `lancamentos`; minúsculo quebra o insert.
  const lancamentoId = uuid()
  await inserirLinhaDinamica(db, 'lancamentos', {
    id: lancamentoId,
    aeronave_id: ctx.aeronave_id || null,
    data: dataEmissao,
    data_emissao: dataEmissao,
    descricao,
    categoria: nomeCategoriaShare,
    categoria_nome: nomeCategoriaShare,
    categoria_id: categoriaShareId,
    grupo_categoria: 'RECEITAS OPERACIONAIS',
    tipo: 'receita',
    prazo: dataVencimento,
    data_vencimento: dataVencimento,
    fluxo: 'ENTRADA',
    valor_centavos: Math.round(valor * 100),
    valor_total: valor,
    pago_por: ctx.cotista_id,     // NOT NULL — antes não era enviado e quebrava o insert
    caixa: 'SHARE',               // coluna real é "caixa" (o código antigo mandava "tipo_caixa", que não existe)
    tipo_caixa: 'SHARE',
    pago_diretamente: 0,
    reembolsavel: 0,
    reembolso_quitado: 0,
    status: 'PENDENTE',
    criado_por: usuario?.id,
    numero_nf: isRecibo ? null : body.numero,
    numero_recibo: isRecibo ? body.numero : null,
  })

  // 2) Contas a receber do cotista dono do recibo/NF.
  const contaId = uuid()
  await inserirLinhaDinamica(db, 'contas_areceber', {
    id: contaId,
    data_vencimento: dataVencimento,
    valor,
    categoria_id: categoriaShareId,
    categoria_nome: nomeCategoriaShare,
    descricao,
    criado_por: usuario?.id,
    aeronave_id: ctx.aeronave_id,
    cotista_id: ctx.cotista_id,
    nf_saida_id: origem === 'nf_saida' ? documentoId : null,
    lancamentos_id: lancamentoId,
    status: 'PENDENTE',
  })

  // 3) Espelho na tabela de rateio — SEMPRE categoria_movimentacao_cliente
  //    "ADM SHARE BRASIL" (928cc6be-...), tipo_rateio FIXO, fornecedor/pagador
  //    "SHARE BRASIL", percentual_uso 100%. Antes só existia pra holding
  //    (rateio_hold); agora existe também pro cliente direto (rateio_despesas).
  const subcategoriaRateio = isRecibo ? CATEGORIA_CLIENTE_NF_SAIDA_SUB_RECIBO : CATEGORIA_CLIENTE_NF_SAIDA_SUB_NF
  const rateioId = uuid()

  if (ctx.socio_id) {
    // Cotista é sócio de holding → movimentos_holding + rateio_hold
    const movimentoId = uuid()
    await inserirMovimentoHolding(db, {
      id: movimentoId,
      holding_id: ctx.holding_id || null,
      socio_id: ctx.socio_id || null,
      cotista_id: ctx.cotista_id || null,
      aeronave_id: ctx.aeronave_id,
      data_movimento: dataEmissao,
      descricao,
      fornecedor_nome: FORNECEDOR_SHARE_BRASIL_NOME,
      categoria_nome: CATEGORIA_CLIENTE_NF_SAIDA_NOME,
      grupo_categoria: 'RECEITAS OPERACIONAIS',
      natureza: 'DESPESA',
      fluxo: 'SAIDA',
      valor_centavos: Math.round(valor * 100),
      pago_diretamente: 0,
      status: 'PENDENTE',
      criado_por: usuario?.id,
    })
    await inserirRateioHolding(db, {
      id: rateioId,
      movimento_holding_id: movimentoId,
      holding_id: ctx.holding_id,
      socio_id: ctx.socio_id,
      cotista_id: ctx.cotista_id,
      categoria_id: CATEGORIA_CLIENTE_NF_SAIDA,
      categoria_nome: CATEGORIA_CLIENTE_NF_SAIDA_NOME,
      aeronave_id: ctx.aeronave_id,
      tipo_rateio: 'SOCIEDADE',
      pago_por_socio_id: ctx.socio_id,
      pago_diretamente: 1,
      percentual_sociedade: 100,
      percentual_uso: 100,
      valor_total: valor,
      valor_rateado: valor,
      status: 'PENDENTE',
      descricao_despesa: descricao,
    })
  } else {
    // Cliente direto (sem holding) → rateio_despesas ligado ao próprio lançamento.
    await inserirLinhaDinamica(db, 'rateio_despesas', {
      id: rateioId,
      lancamentos_id: lancamentoId,
      categoria_custo_id: CATEGORIA_CLIENTE_NF_SAIDA,
      categoria_nome: CATEGORIA_CLIENTE_NF_SAIDA_NOME,
      subcategoria_1: subcategoriaRateio,
      cotista_id: ctx.cotista_id,
      cotista_nome: ctx.nome,
      aeronave_id: ctx.aeronave_id,
      tipo_rateio: 'FIXO',
      data_vencimento: dataVencimento,
      data_emissao_nf: dataEmissao,
      descricao_despesa: descricao,
      pago_por: ctx.cotista_id,
      pago_diretamente: 1,
      percentual_sociedade: 100,
      percentual_uso: 100,
      valor_total: valor,
      valor_rateado: valor,
      status: 'pendente',
      numero_recibo: isRecibo ? body.numero : null,
      recibo_url: body.pdf_url || null,
    })
  }

  return { lancamentoId, contaId, rateioId, categoriaId: categoriaShareId, categoriaNome: nomeCategoriaShare }
}

app.get('/api/financeiro/notas-saida/opcoes', async c => {
  const user=await shareBrasilUser(c); if(!user) return c.json({error:'nao_autorizado'},401); await garantirTabelasNfSaida(c); await garantirCategoriasCliente(c); const db=portalDb(c)
  const [cotistas,aeronaves,categoriasReceita,categoriasDespesa,contasBancarias]=await Promise.all([db.prepare(`SELECT ca.id cotista_aeronave_id,ca.aeronave_id,ca.cliente_id,ca.socio_id,COALESCE(ca.codigo_cliente,cl.codigo_cliente) codigo_cliente,COALESCE(cl.razao_social,hs.nome) nome,cl.cnpj,hs.cpf,CASE WHEN ca.cliente_id IS NOT NULL THEN 'cliente' ELSE 'socio_hold' END tipo_cotista,CASE WHEN ca.cliente_id IS NOT NULL THEN cl.cnpj ELSE hs.cpf END documento FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id=ca.cliente_id LEFT JOIN hold_socios hs ON hs.id=ca.socio_id ORDER BY nome`).all(),db.prepare('SELECT id,matricula_registro FROM aeronave ORDER BY matricula_registro').all(),db.prepare("SELECT id,nome,grupo_categoria,tipo FROM categoria_movimentacao_share WHERE lower(COALESCE(tipo,'receita'))='receita' ORDER BY nome").all(),db.prepare('SELECT id,nome,subcategoria_1,subcategoria_2,subcategoria_3,subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome').all(),db.prepare('SELECT id,banco,numero_conta FROM contas_bancarias ORDER BY banco').all().catch(()=>({results:[]}))]); return c.json({cotistas:cotistas.results,aeronaves:aeronaves.results,categoriasReceita:categoriasReceita.results,categoriasDespesa:categoriasDespesa.results,contasBancarias:contasBancarias.results})
})
app.get('/api/financeiro/notas-saida', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)

  try {
    await garantirTabelasNfSaida(c)
    await garantirTabelaContas(c)
    const db = portalDb(c)
    const [notas, recibos] = await Promise.all([
      db.prepare(`SELECT n.*,COALESCE(cl.razao_social,hs.nome) cliente_nome,cl.cnpj cliente_cnpj,a.matricula_registro aeronave_matricula FROM notas_fiscais_saida n LEFT JOIN cotista_aeronave ca ON ca.id=n.cotista_aeronave_id LEFT JOIN cliente cl ON cl.id=ca.cliente_id LEFT JOIN hold_socios hs ON hs.id=ca.socio_id LEFT JOIN aeronave a ON a.id=n.aeronave_id ORDER BY n.data_criacao DESC`).all(),
      db.prepare(`SELECT r.*,COALESCE(cl.razao_social,hs.nome) cliente_nome,COALESCE(cl.cnpj,hs.cpf) cliente_cnpj,CASE WHEN ca.cliente_id IS NOT NULL THEN 'cliente' ELSE 'socio_hold' END tipo_cotista,a.matricula_registro aeronave_matricula,ca.aeronave_id,ca.cliente_id,ca.socio_id,ar.id contas_areceber_id FROM recibos_saida r LEFT JOIN cotista_aeronave ca ON ca.id=r.cotista_id LEFT JOIN cliente cl ON cl.id=ca.cliente_id LEFT JOIN hold_socios hs ON hs.id=ca.socio_id LEFT JOIN aeronave a ON a.id=r.aeronave_id LEFT JOIN contas_areceber ar ON ar.id=r.contas_areceber_id ORDER BY r.data_emissao DESC`).all(),
    ])
    return c.json({ notas: notas.results, recibos: recibos.results })
  } catch (error: any) {
    log.error('[financeiro/notas-saida] falha ao listar notas e recibos:', error?.message ?? error)
    return c.json({ error: 'erro_ao_listar_notas_saida' }, 500)
  }
})
app.post('/api/financeiro/notas-saida', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelasNfSaida(c)
  const body = await c.req.json<any>()
  if (!body.data_criacao || !body.data_vencimento) return c.json({ error: 'data_criacao_e_vencimento_obrigatorias' }, 400)
  const ctx = await contextoNfSaida(c, String(body.cotista_aeronave_id || ''))
  if (!ctx) return c.json({ error: 'cotista_invalido' }, 400)
  const id = uuid()
  const fin = await gerarFinanceiroNfSaida(c, ctx, body, 'nf_saida', id)
  const db = portalDb(c)
  await inserirLinhaDinamica(db, 'notas_fiscais_saida', {
    id,
    numero: String(body.numero || ''),
    cotista_aeronave_id: ctx.cotista_id,
    aeronave_id: ctx.aeronave_id,
    data_criacao: body.data_criacao,
    data_vencimento: body.data_vencimento,
    valor: Number(body.valor),
    categoria: fin.categoriaNome,
    descricao: body.descricao,
    status: body.status || 'pendente',
    arquivo_pdf_url: body.arquivo_pdf_url,
    lancamento_id: fin.lancamentoId,
    lancamentos_id: fin.lancamentoId, // coluna real "lancamentos_id" (antes ia "lancamento_id" e era descartado)
    criado_por: user.id,
  })
  if (body.anexo_id) {
    await db.prepare('UPDATE recibo_anexos SET recibo_id = ?1, finalidade = ?2 WHERE id = ?3')
      .bind(id, 'nf_saida', body.anexo_id).run().catch(() => undefined)
  }
  return c.json({ nota: await db.prepare('SELECT * FROM notas_fiscais_saida WHERE id=?1').bind(id).first() }, 201)
})

app.post('/api/financeiro/recibos-saida', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelasNfSaida(c)
  const body = await c.req.json<any>()
  if (!body.data_emissao) return c.json({ error: 'data_emissao_obrigatoria' }, 400)
  if (!body.descricao_servico) return c.json({ error: 'descricao_servico_obrigatoria' }, 400)
  const ctx = await contextoNfSaida(c, String(body.cotista_aeronave_id || ''))
  if (!ctx) return c.json({ error: 'cotista_invalido' }, 400)
  const numeroInformado = String(body.numero_recibo || body.numero || '').trim()
  if (numeroInformado && !/^[A-Z0-9][A-Z0-9._/-]{2,40}$/i.test(numeroInformado)) return c.json({ error: 'numero_recibo_invalido' }, 400)
  const numero = numeroInformado || await proximoNumeroReciboSaida(c, String(ctx.codigo_cliente || 'CLI'), String(body.data_emissao || ''))
  const duplicado = await portalDb(c).prepare('SELECT id FROM recibos_saida WHERE upper(numero_recibo) = upper(?1) LIMIT 1').bind(numero).first<{ id: string }>().catch(() => null)
  if (duplicado) return c.json({ error: 'numero_recibo_ja_existente' }, 409)
  const id = uuid()
  const fin = await gerarFinanceiroNfSaida(c, ctx, { ...body, numero }, 'recibo_saida', id)
  const db = portalDb(c)
  await inserirLinhaDinamica(db, 'recibos_saida', {
    id,
    numero_recibo: numero,
    tipo_recibo: ctx.socio_id ? 'holding' : 'cliente',
    cotista_id: ctx.cotista_id,
    aeronave_id: ctx.aeronave_id,
    valor_total: Number(body.valor),
    percentual: 100,
    descricao_servico: body.descricao_servico,
    nome_categoria: fin.categoriaNome,
    categoria_id: fin.categoriaId,
    data_emissao: body.data_emissao,
    data_vencimento: body.data_vencimento,
    status: body.status || 'pendente',
    pdf_url: body.pdf_url,
    contas_areceber_id: fin.contaId,
    lancamento_id: fin.lancamentoId,
    lancamentos_id: fin.lancamentoId, // coluna real "lancamentos_id"
    criado_por: user.id,
  })
  if (body.anexo_id) {
    await db.prepare('UPDATE recibo_anexos SET recibo_id = ?1, finalidade = ?2 WHERE id = ?3')
      .bind(id, 'recibo_saida', body.anexo_id).run().catch(() => undefined)
  }
  return c.json({ recibo: await db.prepare('SELECT * FROM recibos_saida WHERE id=?1').bind(id).first() }, 201)
})

app.post('/api/financeiro/notas-saida/anexos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelasNfSaida(c) // garante a recibo_anexos também
  const body = await c.req.parseBody()
  const file = body.arquivo
  if (!(file instanceof File) || !file.size) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const key = await salvarArquivoShareBrasil(c, user.id, file, 'notas-saida/anexos')
  const id = uuid()
  // Antes o arquivo era salvo no R2 mas nunca gravado em recibo_anexos: a URL
  // retornada sempre dava 404 quando o front tentava reabrir o anexo.
  await portalDb(c).prepare(
    'INSERT INTO recibo_anexos (id, recibo_id, finalidade, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, null, 'nf_saida_recibo_saida', file.name, key, file.type || 'application/octet-stream', file.size, user.id).run()
  return c.json({ id, url: `/api/financeiro/recibos/anexos/${id}/arquivo` }, 201)
})
app.get('/api/financeiro/recibos/opcoes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelasRecibos(c).catch((error) => log.error('[recibos/opcoes] falha ao garantir tabelas', error))
  await garantirCategoriasCliente(c).catch((error) => log.error('[recibos/opcoes] falha nas categorias de cliente', error))
  const db = portalDb(c)
  const [clientes, colaboradores, aeronave, cotistas, categorias, categoriasCliente, perfisRecebedores, freelancersRecebedores] = await Promise.all([
    db.prepare("SELECT id, razao_social, cnpj, endereco, cidade, uf, holding, status FROM cliente WHERE lower(COALESCE(status,'ativo')) IN ('ativo', 'active', '') ORDER BY razao_social").all().catch(() => ({ results: [] as any[] })),
    db.prepare("SELECT id, nome_completo, nome_exibicao, cpf, pix, nome_banco, tipo_conta, conta_numero, agencia_numero, email, tipo_user, status FROM user_profiles WHERE lower(trim(COALESCE(tipo_user, ''))) = 'colaborador' AND (status IS NULL OR lower(trim(COALESCE(status, ''))) IN ('', 'ativo', 'active')) ORDER BY COALESCE(NULLIF(trim(nome_exibicao), ''), nome_completo, email)").all().catch(() => ({ results: [] as any[] })),
    db.prepare('SELECT id, matricula_registro, fabricante, modelo FROM aeronave ORDER BY matricula_registro').all().catch(() => ({ results: [] as any[] })),
    db.prepare(`SELECT ca.id AS id, ca.id AS cotista_id, ca.aeronave_id, ca.cliente_id, ca.socio_id, ca.percentual_sociedade,
                       COALESCE(ca.codigo_cliente, cl.codigo_cliente) AS codigo_cliente,
                       cl.cnpj, cl.endereco, cl.cidade, cl.uf, hs.cpf,
                       COALESCE(cl.razao_social, hs.nome) AS nome
                FROM cotista_aeronave ca
                LEFT JOIN cliente cl ON cl.id = ca.cliente_id
                LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
                ORDER BY ca.aeronave_id, nome`).all().catch(() => ({ results: [] as any[] })),
    buscarCategoriasRecibo(c),
    db.prepare('SELECT * FROM categoria_movimentacao_cliente ORDER BY nome').all().catch(() => ({ results: [] as any[] })),
    db.prepare('SELECT * FROM user_profiles').all().catch(() => ({ results: [] as any[] })),
    db.prepare('SELECT * FROM tripulacao_freelancer').all().catch(() => ({ results: [] as any[] })),
  ])
  const ativo = (item: any) => {
    const status = String(item.status || '').trim().toLowerCase()
    return !status || status === 'ativo' || status === 'active'
  }
  const usuarios = (perfisRecebedores.results as any[]).filter(ativo).map((perfil) => ({
    id: perfil.id,
    nome: perfil.nome_exibicao || perfil.nome_completo || perfil.email || 'Perfil sem nome',
    cpf: perfil.cpf || null,
    email: perfil.email || null,
    telefone: perfil.telefone || null,
    tipo_user: perfil.tipo_user || null,
  }))
  const freelancers = (freelancersRecebedores.results as any[]).filter(ativo).map((freelancer) => ({
    id: freelancer.id,
    nome: freelancer.nome_completo || 'Freelancer sem nome',
    cpf: freelancer.cpf || null,
    email: freelancer.email || null,
    telefone: freelancer.telefone || null,
    canac: freelancer.canac || null,
    tipo_user: 'freelancer',
  }))
  const recebedores = [
    ...usuarios.map((usuario) => ({ ...usuario, id: `perfil:${usuario.id}`, origem: 'user_profiles' as const })),
    ...freelancers.map((freelancer) => ({ ...freelancer, id: `freelancer:${freelancer.id}`, origem: 'tripulacao_freelancer' as const })),
  ]
  return c.json({ clientes: clientes.results, colaboradores: colaboradores.results, aeronaves: aeronave.results, cotistas: cotistas.results, categorias, categorias_cliente: categoriasCliente.results, recebedores, usuarios, freelancers })
})

app.get('/api/financeiro/recibos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelasRecibos(c).catch((error) => log.error('[recibos] falha ao garantir tabelas', error))
  const status = c.req.query('status')
  const beneficiarioTipo = c.req.query('beneficiario_tipo')
  const busca = c.req.query('q')?.trim()
  const dataInicial = c.req.query('data_inicial')?.trim()
  const dataFinal = c.req.query('data_final')?.trim()
  const clauses: string[] = []
  const params: unknown[] = []
  if (status) { clauses.push('r.status = ?'); params.push(status) }
  if (beneficiarioTipo) { clauses.push('r.beneficiario_tipo = ?'); params.push(beneficiarioTipo) }
  if (busca) {
    clauses.push(`(r.numero_recibo LIKE ? OR r.nome_pagador LIKE ? OR r.recebedor_nome LIKE ? OR r.descricao_servico LIKE ? OR r.numero_documento_anexo LIKE ? OR r.observacoes LIKE ?)`)
    const termo = `%${busca}%`
    params.push(termo, termo, termo, termo, termo, termo)
  }
  if (dataInicial) { clauses.push('r.data_emissao >= ?'); params.push(dataInicial) }
  if (dataFinal) { clauses.push('r.data_emissao <= ?'); params.push(dataFinal) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  try {
    const stmt = portalDb(c).prepare(`SELECT r.*, COALESCE(r.pdf_anexo_id, pdf.id) AS pdf_anexo_id,
      COALESCE(r.pdf_url, CASE WHEN pdf.id IS NOT NULL THEN '/api/financeiro/recibos/anexos/' || pdf.id || '/arquivo' END) AS pdf_url
      FROM recibos r LEFT JOIN recibo_anexos pdf ON pdf.recibo_id = r.id AND pdf.finalidade = 'pdf_gerado' ${where} ORDER BY r.data_emissao DESC, r.criado_em DESC`)
    const rows = params.length ? await stmt.bind(...params).all() : await stmt.all()
    return c.json({ recibos: rows.results })
  } catch (error) {
    log.error('[recibos] falha ao listar recibos', error)
    return c.json({ recibos: [] })
  }
})

app.get('/api/financeiro/recibos/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelasRecibos(c)
  const db = portalDb(c)
  const recibo = await db.prepare(`SELECT r.*, COALESCE(r.pdf_anexo_id, pdf.id) AS pdf_anexo_id,
    COALESCE(r.pdf_url, CASE WHEN pdf.id IS NOT NULL THEN '/api/financeiro/recibos/anexos/' || pdf.id || '/arquivo' END) AS pdf_url
    FROM recibos r LEFT JOIN recibo_anexos pdf ON pdf.recibo_id = r.id AND pdf.finalidade = 'pdf_gerado'
    WHERE r.id = ?1`).bind(c.req.param('id')).first()
  if (!recibo) return c.notFound()
  const rateio = await db.prepare('SELECT * FROM recibo_rateio WHERE recibo_id = ?1 ORDER BY nome').bind(c.req.param('id')).all()
  return c.json({ recibo, rateio: rateio.results })
})

app.post('/api/financeiro/recibos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelasRecibos(c).catch((error) => log.error('[recibos] migração inicial ignorada:', error?.message || error))
  const db = portalDb(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  if (body.tipo_recibo === 'cliente_direto') return c.json({ error: 'tipo_recibo_nao_disponivel' }, 400)

  const ehPagamento = body.tipo_recibo === 'pagamento' || ['fornecedor', 'freelancer'].includes(String(body.beneficiario_tipo || '').toLowerCase())
  const recebedorId = String(body.recebedor_id || '').trim()
  const recebedorOrigem = recebedorId.startsWith('freelancer:') ? 'freelancer' : recebedorId.startsWith('perfil:') ? 'colaborador' : ''
  const beneficiarioTipo: 'cliente' | 'colaborador' | 'freelancer' | 'fornecedor' = ehPagamento
    ? (recebedorOrigem === 'freelancer' ? 'freelancer' : recebedorOrigem === 'colaborador' ? 'colaborador' : 'fornecedor')
    : body.beneficiario_tipo === 'colaborador' ? 'colaborador' : 'cliente'
  const reembolsavel = Boolean(body.reembolsavel) && beneficiarioTipo === 'cliente'
  const pagadorTipo = ehPagamento && body.pagador_tipo === 'cotista' ? 'cotista' : 'share'
  const rateado = Boolean(body.rateado) && (beneficiarioTipo === 'cliente' || (ehPagamento && pagadorTipo === 'cotista'))
  let descricao = String(body.descricao_servico || '').trim()
  const pagadorCotistaId = String(body.pagador_cotista_id || '').trim()
  let pagadorCotista: Record<string, any> | null = null
  if (pagadorTipo === 'cotista') {
    pagadorCotista = await db.prepare(`SELECT ca.id AS cotista_id, ca.cliente_id, ca.socio_id, hs.holding_id, COALESCE(cl.razao_social, hs.nome) AS nome,
      cl.cnpj, cl.endereco, cl.cidade, cl.uf, hs.cpf, COALESCE(ca.codigo_cliente, cl.codigo_cliente) AS codigo_cliente
      FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE ca.id = ?1`).bind(pagadorCotistaId).first<Record<string, any>>()
    if (!pagadorCotista) return c.json({ error: 'pagador_cotista_invalido' }, 400)
  }
  const nomePagador = pagadorCotista?.nome || PAGADOR_PADRAO_RECIBO.nome
  const documentoPagador = pagadorCotista?.cliente_id ? pagadorCotista.cnpj : pagadorCotista?.cpf || PAGADOR_PADRAO_RECIBO.documento
  const enderecoPagador = pagadorCotista?.endereco || PAGADOR_PADRAO_RECIBO.endereco
  const cidadePagador = pagadorCotista?.cidade || PAGADOR_PADRAO_RECIBO.cidade
  const ufPagador = pagadorCotista?.uf || PAGADOR_PADRAO_RECIBO.uf
  let recebedorNome = String(body.recebedor_nome || '').trim()
  let recebedorCpf = String(body.recebedor_cpf || '').trim()
  let freelancerId: string | null = null
  if (beneficiarioTipo === 'colaborador') {
    const colaboradorId = String(body.colaborador_id || '').trim() || recebedorId.replace(/^perfil:/, '')
    const colaborador = await db.prepare('SELECT nome_completo AS nome, cpf, pix FROM user_profiles WHERE id = ?1').bind(colaboradorId).first<{ nome: string; cpf: string | null; pix: string | null }>().catch(() => null)
    recebedorNome = colaborador?.nome || recebedorNome
    recebedorCpf = colaborador?.cpf || recebedorCpf
    if (colaborador?.pix && !descricao.toLowerCase().includes('pix')) descricao = `${descricao} · PIX para pagamento: ${colaborador.pix}`
  } else if (beneficiarioTipo === 'freelancer') {
    freelancerId = recebedorId.replace(/^freelancer:/, '') || String(body.freelancer_id || '').trim() || null
    const freelancer = freelancerId ? await db.prepare('SELECT nome_completo AS nome, cpf FROM tripulacao_freelancer WHERE id = ?1').bind(freelancerId).first<{ nome: string; cpf: string | null }>().catch(() => null) : null
    recebedorNome = freelancer?.nome || recebedorNome
    recebedorCpf = freelancer?.cpf || recebedorCpf
    if (freelancerId && !recebedorNome) return c.json({ error: 'freelancer_invalido' }, 400)
  }
  const clienteId = String(body.cliente_id || body.cotista_id || '').trim()
  const valor = Number.parseFloat(String(body.valor).replace(',', '.'))
  const valorCentavos = Math.round(valor * 100)
  const dataEmissao = String(body.data_emissao || '').trim() || new Date().toISOString().slice(0, 10)

  if (!descricao) return c.json({ error: 'descricao_obrigatoria' }, 400)
  if (!Number.isFinite(valor) || valor <= 0 || !Number.isInteger(valorCentavos) || valorCentavos <= 0) return c.json({ error: 'valor_invalido' }, 400)
  if (['fornecedor', 'freelancer', 'colaborador'].includes(beneficiarioTipo) && !recebedorNome) return c.json({ error: 'recebedor_obrigatorio' }, 400)
  if (beneficiarioTipo === 'colaborador' && !String(body.colaborador_id || '').trim() && !recebedorId.startsWith('perfil:')) return c.json({ error: 'colaborador_obrigatorio' }, 400)
  if (beneficiarioTipo === 'freelancer' && !freelancerId) return c.json({ error: 'freelancer_obrigatorio' }, 400)
  if (beneficiarioTipo === 'cliente' && !rateado && !clienteId) return c.json({ error: 'cliente_obrigatorio' }, 400)
  if (rateado && !String(body.aeronave_id || '').trim()) return c.json({ error: 'aeronave_obrigatoria_para_rateio' }, 400)
  if (ehPagamento && !String(body.forma_pagamento || '').trim()) return c.json({ error: 'forma_pagamento_obrigatoria' }, 400)

  const naturezaDespesa = beneficiarioTipo === 'colaborador' ? String(body.natureza_despesa || '').trim().toLowerCase() : ''
  if (beneficiarioTipo === 'colaborador' && !['aeronave', 'empresa'].includes(naturezaDespesa)) return c.json({ error: 'natureza_despesa_obrigatoria' }, 400)
  if (beneficiarioTipo === 'colaborador' && naturezaDespesa === 'aeronave' && !String(body.aeronave_id || '').trim()) return c.json({ error: 'aeronave_obrigatoria' }, 400)

  const categoriaId = String(body.categoria_movimentacao_id || body.categoria_lancamento_id || '').trim()
  const categoriaNomeManual = String(body.categoria_nome_manual || '').trim()
  const categoriaOutroId = '111124d9-6111-4e11-a1f7-c7477e0fdb89'
  const categoriasEmpresaPermitidas = new Set([
    '88980acf-465f-4a16-8111-d8efaf28365b', '482a2993-28e9-417e-98f5-d00d03ada423',
    '28a599f4-d8de-4969-98aa-58452d49c92e', '0293e29f-526e-4be0-af2e-0e10e73e8a8f',
    'a4d8ed56-9bb2-47e1-93fa-2b786ff280b7', '09defc15-dced-408d-a975-092928374907',
    '82e24a46-a773-4b6e-b2ae-bfd41c04bc5d', categoriaOutroId,
  ])
  let categoriaRecibo: Record<string, any> | null = null
  if (beneficiarioTipo === 'colaborador') {
    if (!categoriaId) return c.json({ error: 'categoria_obrigatoria' }, 400)
    for (const tabela of ['categoria_movimentacao_share', 'categorias_caixa_share']) {
      categoriaRecibo = await db.prepare(`SELECT * FROM ${tabela} WHERE id = ?1`).bind(categoriaId).first<Record<string, any>>().catch(() => null)
      if (categoriaRecibo) break
    }
    if (!categoriaRecibo) return c.json({ error: 'categoria_invalida' }, 400)
    const grupoCategoriaRecibo = String(categoriaRecibo.grupo_categoria ?? categoriaRecibo.grupo ?? '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    if (naturezaDespesa === 'aeronave' && grupoCategoriaRecibo !== 'DESPESAS REEMBOLSAVEIS') return c.json({ error: 'categoria_aeronave_invalida' }, 400)
    if (naturezaDespesa === 'empresa' && (!categoriasEmpresaPermitidas.has(categoriaId) || grupoCategoriaRecibo !== 'DESPESAS EMPRESA')) return c.json({ error: 'categoria_empresa_invalida' }, 400)
    if (categoriaId === categoriaOutroId && !categoriaNomeManual) return c.json({ error: 'descricao_categoria_obrigatoria' }, 400)
  }
  let categoriaPagamento: Record<string, any> | null = null
  if (ehPagamento) {
    await garantirCategoriasCliente(c).catch(() => undefined)
    const categoriaPagamentoId = String(body.categoria_movimentacao_id || '').trim()
    if (categoriaPagamentoId) {
      categoriaPagamento = await db.prepare('SELECT * FROM categoria_movimentacao_cliente WHERE id = ?1').bind(categoriaPagamentoId).first<Record<string, any>>().catch(() => null)
      if (!categoriaPagamento) categoriaPagamento = await db.prepare('SELECT * FROM categoria_movimentacao_share WHERE id = ?1').bind(categoriaPagamentoId).first<Record<string, any>>().catch(() => null)
    }
    if (!categoriaPagamento) return c.json({ error: 'categoria_pagamento_obrigatoria' }, 400)
  }
  const categoriaNomePagamento = String(categoriaPagamento?.nome || categoriaPagamento?.categoria || categoriaPagamento?.descricao || '').trim()
  const grupoCategoriaInformado = String(categoriaPagamento?.grupo_categoria ?? categoriaPagamento?.grupo ?? categoriaPagamento?.agrupamento ?? '').trim()
  const categoriaVinculada = !grupoCategoriaInformado && categoriaId
    ? await db.prepare('SELECT grupo_categoria FROM categoria_movimentacao_share WHERE categoria_cliente_id = ?1 LIMIT 1').bind(categoriaId).first<{ grupo_categoria: string | null }>().catch(() => null)
    : null
  const grupoCategoriaPagamento = String(grupoCategoriaInformado || categoriaVinculada?.grupo_categoria || categoriaNomePagamento || 'CAIXA CLIENTE').trim()
  const grupoCategoria = beneficiarioTipo === 'colaborador' || beneficiarioTipo === 'freelancer'
    ? (naturezaDespesa === 'aeronave' ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA')
    : ehPagamento ? grupoCategoriaPagamento : String(body.grupo_categoria || '').trim()
  const tipoDespesa = beneficiarioTipo === 'colaborador' || beneficiarioTipo === 'freelancer' ? (categoriaRecibo?.tipo_despesa ?? categoriaRecibo?.tipo ?? null) : null
  const categoriaNome = beneficiarioTipo === 'colaborador' || beneficiarioTipo === 'freelancer'
    ? (categoriaId === categoriaOutroId ? categoriaNomeManual : String(categoriaRecibo?.nome || categoriaRecibo?.categoria || categoriaRecibo?.descricao || grupoCategoria))
    : ehPagamento ? (categoriaNomePagamento || grupoCategoria) : grupoCategoria || (reembolsavel ? 'DESPESAS REEMBOLSÁVEIS' : 'CAIXA CLIENTE')
  const pagamentoPorCotistaCliente = ehPagamento && pagadorTipo === 'cotista' && Boolean(pagadorCotista?.cliente_id)
  const regra = pagamentoPorCotistaCliente
    ? { ...regraFinanceira('cliente', grupoCategoria), grupo: grupoCategoria }
    : ehPagamento || beneficiarioTipo === 'colaborador' || beneficiarioTipo === 'freelancer'
      ? { ...regraFinanceira('share', grupoCategoria), grupo: grupoCategoria }
      : regraFinanceiraRecibo('cliente', reembolsavel, grupoCategoria)
  const tipoCaixaRecibo = pagadorCotista?.socio_id ? 'HOLDING' : regra.caixa

  const reciboId = uuid()
  const contaPagarId = beneficiarioTipo === 'cliente' || beneficiarioTipo === 'colaborador' ? uuid() : null
  const numeroReciboInformado = String(body.numero_recibo || '').trim()
  if (numeroReciboInformado && !/^[A-Z0-9][A-Z0-9._/-]{2,40}$/i.test(numeroReciboInformado)) return c.json({ error: 'numero_recibo_invalido' }, 400)
  if (numeroReciboInformado) {
    const numeroExistente = await db.prepare('SELECT id FROM recibos WHERE upper(numero_recibo) = upper(?1) LIMIT 1').bind(numeroReciboInformado).first<{ id: string }>()
    if (numeroExistente) return c.json({ error: 'numero_recibo_ja_existente' }, 409)
  }
  const numeroRecibo = numeroReciboInformado || await proximoNumeroRecibo(c, beneficiarioTipo === 'colaborador' || pagadorTipo === 'share' ? 'SHE' : String(pagadorCotista?.codigo_cliente || 'SHE'))
  const reciboUrl = `/api/financeiro/recibos/${reciboId}/visualizacao`
  const observacoes = body.observacoes ? String(body.observacoes) : null

  // Linhas de rateio: usa as informadas no formulário (permite editar % ou marcar quem pagou
  // diretamente); se não vierem, usa todos os cotistas da aeronave com o percentual_sociedade.
  let linhasRateio: Array<{ cotista_id: string; cliente_id: string | null; socio_id: string | null; holding_id?: string | null; nome: string; percentual: number; valor: number; pago_por: string | null }> = []
  if (rateado) {
    const cotistas = await db.prepare(`SELECT ca.id AS cotista_id, ca.cliente_id, ca.socio_id, hs.holding_id, ca.percentual_sociedade,
                                               COALESCE(cl.razao_social, hs.nome) AS nome
                                        FROM cotista_aeronave ca
                                        LEFT JOIN cliente cl ON cl.id = ca.cliente_id
                                        LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
                                        WHERE ca.aeronave_id = ?1`).bind(body.aeronave_id).all<{ cotista_id: string; cliente_id: string | null; socio_id: string | null; holding_id: string | null; percentual_sociedade: number; nome: string }>()
    if (!cotistas.results.length) return c.json({ error: 'aeronave_sem_cotistas' }, 400)

    const overrides: Array<Record<string, any>> = Array.isArray(body.rateio_linhas) ? body.rateio_linhas : []
    const overrideByCotista = new Map(overrides.map((linha) => [String(linha.cotista_id), linha]))
    const selecionados = overrides.length
      ? cotistas.results.filter((cotista) => overrideByCotista.has(String(cotista.cotista_id)))
      : cotistas.results
    if (!selecionados.length) return c.json({ error: 'nenhum_cotista_selecionado' }, 400)

    linhasRateio = selecionados.map((cotista) => {
      const override = overrideByCotista.get(String(cotista.cotista_id))
      const percentual = override && Number.isFinite(Number(override.percentual)) && Number(override.percentual) > 0
        ? Number(override.percentual)
        : Number(cotista.percentual_sociedade || 0)
      const valorLinha = override && Number.isFinite(Number(override.valor)) && Number(override.valor) > 0
        ? Number(override.valor)
        : Number(((valor * percentual) / 100).toFixed(2))
      return {
        cotista_id: cotista.cotista_id,
        cliente_id: cotista.cliente_id,
        socio_id: cotista.socio_id,
        holding_id: cotista.holding_id || null,
        nome: cotista.nome || 'Cotista',
        percentual,
        valor: valorLinha,
        pago_por: override?.pago_por || (reembolsavel ? 'share' : (cotista.cliente_id || cotista.socio_id)),
      }
    })
    const totalPercentualRateio = linhasRateio.reduce((total, linha) => total + linha.percentual, 0)
    if (Math.abs(totalPercentualRateio - 100) > 0.01) return c.json({ error: 'rateio_deve_totalizar_100' }, 400)
  }

  const tipoRateio = normalizarTipoRateioD1(body.tipo_rateio)
  const possuiCotistaHolding = Boolean(pagadorCotista?.socio_id) || linhasRateio.some((linha) => Boolean(linha.socio_id))
  const possuiCotistaCliente = rateado
    ? linhasRateio.some((linha) => Boolean(linha.cliente_id) && !linha.socio_id)
    : !possuiCotistaHolding
  const valorHolding = rateado
    ? linhasRateio.filter((linha) => Boolean(linha.socio_id)).reduce((total, linha) => total + linha.valor, 0)
    : possuiCotistaHolding ? valor : 0
  const valorCliente = rateado
    ? linhasRateio.filter((linha) => !linha.socio_id).reduce((total, linha) => total + linha.valor, 0)
    : possuiCotistaCliente ? valor : 0
  const lancamentoId = possuiCotistaCliente || !ehPagamento ? uuid() : null
  const movimentacaoId = possuiCotistaHolding ? uuid() : null

  try {
    // 1. Cliente: somente cotistas cliente passam pelo caixa Share.
    if (lancamentoId) {
      await inserirLinhaDinamica(db, 'lancamentos', {
        id: lancamentoId, aeronave_id: body.aeronave_id || null, data: dataEmissao, data_emissao: dataEmissao,
        descricao, documento: body.numero_documento_anexo || null, numero_doc: body.numero_documento_anexo || null,
        fornecedor: ehPagamento ? recebedorNome : null, fornecedor_nome: ehPagamento ? recebedorNome : null,
        categoria: categoriaNome, categoria_nome: categoriaNome, categoria_id: categoriaId || null, categoria_movimentacao_id: categoriaId || null, grupo_categoria: regra.grupo,
        cotista_id: pagadorCotista?.cotista_id || (beneficiarioTipo === 'cliente' && !rateado ? clienteId : null),
        tipo: tipoDespesa || (ehPagamento ? 'PAGAMENTO' : 'DESPESA'), prazo: body.data_vencimento || null,
        data_vencimento: body.data_vencimento || null, fluxo: 'SAIDA', valor_centavos: Math.round(valorCliente * 100),
        valor_total: valorCliente, pago_por: rateado ? null : (pagadorCotista?.cliente_id || (beneficiarioTipo === 'cliente' ? (reembolsavel ? 'SHARE' : clienteId) : 'SHARE')),
        caixa: regra.caixa, tipo_caixa: regra.caixa, pago_diretamente: regra.pagoDiretamente,
        reembolsavel: regra.reembolsavel, reembolso_quitado: 0, status: 'PENDENTE', observacoes, criado_por: user.id,
        periodicidade: body.periodicidade || null, tipo_rateio: tipoRateio,
        subcategoria_1: body.subcategoria_1 || null, subcategoria_2: body.subcategoria_2 || null,
        subcategoria_3: body.subcategoria_3 || null, subcategoria_4: body.subcategoria_4 || null,
      })
    }

    // 2. Holding: não entra no caixa Share. Um recibo pago por sócio holding
    // gera somente a movimentação da conta da holding e seu rateio próprio.
    if (movimentacaoId) {
      const holdingId = pagadorCotista?.holding_id || linhasRateio.find((linha) => linha.socio_id)?.holding_id || null
      if (!holdingId) throw new Error('holding_nao_identificada_para_cotista')
      await inserirMovimentoHolding(db, {
        id: movimentacaoId, holding_id: holdingId, aeronave_id: body.aeronave_id || null,
        socio_id: pagadorCotista?.socio_id || linhasRateio.find((linha) => linha.socio_id)?.socio_id || null,
        cotista_id: pagadorCotista?.cotista_id || linhasRateio.find((linha) => linha.socio_id)?.cotista_id || null,
        data_movimento: dataEmissao, descricao, fornecedor_nome: ehPagamento ? recebedorNome : null,
        categoria_nome: categoriaNome, grupo_categoria: regra.grupo, natureza: 'DESPESA', fluxo: 'SAIDA',
        valor_centavos: Math.round(valorHolding * 100),
        pago_diretamente: 1, status: 'PENDENTE', observacoes, criado_por: user.id,
      })
    }

    // 3. Cada tipo de cotista usa seu próprio rateio e sua própria origem financeira.
    const rateioIdsGerados: string[] = []
    // O D1 aceita somente os quatro valores definidos no CHECK de rateio_despesas
    // e rateio_hold; rótulos como "cliente" não podem ser persistidos nessa coluna.
    if (rateado) {
      for (const linha of linhasRateio) {
        const rateioId = uuid()
        if (linha.socio_id) {
          await inserirRateioHolding(db, {
            id: rateioId, movimento_holding_id: movimentacaoId, holding_id: linha.holding_id,
            socio_id: linha.socio_id, cotista_id: linha.cotista_id, categoria_nome: categoriaNome,
            aeronave_id: body.aeronave_id || null, tipo_rateio: tipoRateio,
            descricao_despesa: descricao, pago_por: linha.pago_por, pago_diretamente: ehPagamento ? 1 : regra.pagoDiretamente,
            percentual_sociedade: linha.percentual, percentual_uso: linha.percentual,
            valor_total: valor, valor_rateado: linha.valor, status: 'PENDENTE', observacoes,
          })
        } else {
          if (!lancamentoId) throw new Error('lancamento_cliente_ausente_para_rateio')
          await inserirLinhaDinamica(db, 'rateio_despesas', {
            id: rateioId, lancamentos_id: lancamentoId, tipo_rateio: tipoRateio, data_vencimento: body.data_vencimento || null,
            data_emissao_nf: dataEmissao, categoria_nome: categoriaNome, cotista_id: linha.cotista_id, pago_por: linha.pago_por,
            pago_diretamente: ehPagamento ? 1 : regra.pagoDiretamente, aeronave_id: body.aeronave_id || null,
            descricao_despesa: descricao, valor_total: valor, valor_rateado: linha.valor, status: 'pendente',
            observacoes: `Rateio ${linha.percentual}% — ${linha.nome}`,
          })
        }
        await db.prepare('INSERT INTO recibo_rateio (id, recibo_id, rateio_despesas_id, nome, percentual, valor, cotista_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(uuid(), reciboId, rateioId, linha.nome, linha.percentual, linha.valor, linha.cotista_id).run()
        rateioIdsGerados.push(rateioId)
      }
    } else if (ehPagamento && pagadorCotista) {
      const subcategorias = [body.subcategoria_1, body.subcategoria_2, body.subcategoria_3, body.subcategoria_4].map((item) => item ? String(item) : null)
      if (pagadorCotista.cliente_id) {
        if (!lancamentoId) throw new Error('lancamento_cliente_ausente_para_rateio')
        const rateioId = uuid()
        await inserirLinhaDinamica(db, 'rateio_despesas', {
          id: rateioId, lancamentos_id: lancamentoId, tipo_rateio: tipoRateio, data_emissao_nf: dataEmissao,
          categoria_nome: categoriaNome, cotista_id: pagadorCotista.cotista_id, pago_por: pagadorCotista.cliente_id,
          pago_diretamente: 1, aeronave_id: body.aeronave_id || null, descricao_despesa: descricao,
          subcategoria_1: subcategorias[0], subcategoria_2: subcategorias[1], subcategoria_3: subcategorias[2],
          subcategoria_4: subcategorias[3], valor_total: valor, valor_rateado: valor, status: 'pendente',
          observacoes, numero_recibo: numeroRecibo, recibo_url: reciboUrl,
        })
        rateioIdsGerados.push(rateioId)
      } else if (pagadorCotista.socio_id) {
        const rateioId = uuid()
        await inserirRateioHolding(db, {
          id: rateioId, movimento_holding_id: movimentacaoId, holding_id: pagadorCotista.holding_id,
          socio_id: pagadorCotista.socio_id, cotista_id: pagadorCotista.cotista_id, categoria_nome: categoriaNome,
          aeronave_id: body.aeronave_id || null, tipo_rateio: tipoRateio,
          descricao_despesa: descricao, pago_por_socio_id: pagadorCotista.socio_id,
          pago_diretamente: 1, percentual_sociedade: 100, percentual_uso: 100,
          valor_total: valor, valor_rateado: valor, status: 'PENDENTE', observacoes,
        })
        rateioIdsGerados.push(rateioId)
      }
    } else if (regra.rateio) {
        if (!lancamentoId) throw new Error('lancamento_cliente_ausente_para_rateio')
        const rateioId = uuid()
        const pagoPor = regra.reembolsavel ? 'share' : body.cotista_id
        await inserirLinhaDinamica(db, 'rateio_despesas', {
          id: rateioId, lancamentos_id: lancamentoId, tipo_rateio: tipoRateio, data_vencimento: body.data_vencimento || null,
          data_emissao_nf: dataEmissao, categoria_nome: regra.grupo, cotista_id: body.cotista_id, pago_por: pagoPor,
          pago_diretamente: regra.pagoDiretamente, aeronave_id: body.aeronave_id || null, descricao_despesa: descricao,
          valor_total: valor, valor_rateado: valor, status: 'pendente', observacoes: body.observacoes || null,
        })
        rateioIdsGerados.push(rateioId)
    }

    // 3. recibo em si — snapshot para PDF/histórico, referenciando a lançamento de origem.
    const tipoRecibo = ehPagamento ? 'pagamento' : beneficiarioTipo === 'colaborador' ? 'colaborador' : (reembolsavel ? 'cliente_reembolsavel' : 'cliente_direto')
    const statusRecibo = reembolsavel ? 'aguardando_reembolso' : 'emitido'
    await inserirLinhaDinamica(db, 'recibos', {
      id: reciboId, numero_recibo: numeroRecibo, tipo_recibo: tipoRecibo, beneficiario_tipo: beneficiarioTipo,
      cliente_id: beneficiarioTipo === 'cliente' && !rateado ? clienteId : null,
      colaborador_id: beneficiarioTipo === 'colaborador' ? (String(body.colaborador_id || '').trim() || recebedorId.replace(/^perfil:/, '') || null) : null,
      freelancer_id: beneficiarioTipo === 'freelancer' ? freelancerId : null,
      cotista_id: pagadorCotista?.cotista_id || (beneficiarioTipo === 'cliente' && !rateado ? clienteId : null),
      recebedor_nome: (ehPagamento || beneficiarioTipo === 'colaborador' || beneficiarioTipo === 'freelancer') ? recebedorNome : null,
      recebedor_cpf: (ehPagamento || beneficiarioTipo === 'colaborador' || beneficiarioTipo === 'freelancer') ? recebedorCpf : null,
      aeronave_id: body.aeronave_id || null, rateado: rateado ? 1 : 0,
      nome_pagador: nomePagador, documento_pagador: documentoPagador, endereco_pagador: enderecoPagador,
      cidade_pagador: cidadePagador, uf_pagador: ufPagador, valor, descricao_servico: descricao,
      data_emissao: dataEmissao, data_vencimento: body.data_vencimento || null,
      forma_pagamento: ehPagamento ? body.forma_pagamento || null : null,
      numero_documento_anexo: body.numero_documento_anexo || null, anexo_id: body.anexo_id || null, pdf_anexo_id: null, pdf_url: null,
      observacoes, categoria_lancamento_id: categoriaId || null, categoria_movimentacao_id: categoriaId || null, categoria_id: categoriaId || null,
      tipo_despesa: tipoDespesa, grupo_categoria: regra.grupo, tipo_caixa: tipoCaixaRecibo, status: statusRecibo,
      boleto_url: body.boleto_url || null, nf_url: body.nf_url || null,
      lancamento_id: lancamentoId, movimentacao_id: movimentacaoId, criado_por: user.id,
      natureza_despesa: naturezaDespesa || null, periodicidade: body.periodicidade || null,
      tipo_rateio: tipoRateio, subcategoria_1: body.subcategoria_1 || null, subcategoria_2: body.subcategoria_2 || null,
      subcategoria_3: body.subcategoria_3 || null, subcategoria_4: body.subcategoria_4 || null, recibo_url: reciboUrl,
    })
    for (const rateioId of rateioIdsGerados) {
      await db.prepare('UPDATE rateio_despesas SET numero_recibo = ?1, recibo_url = ?2 WHERE id = ?3').bind(numeroRecibo, reciboUrl, rateioId).run().catch(() => undefined)
    }
    if (contaPagarId) {
      await garantirTabelaContas(c)
      await db.prepare(`INSERT INTO contas_apagar (id, data_vencimento, valor, categoria_id, categoria_nome, descricao, criado_por, aeronave_id, fornecedor_id, cotista_id, colaborador_id, boleto_url, nf_url, lancamento_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE')`).bind(
        contaPagarId, body.data_vencimento || dataEmissao, valor, categoriaId || null, categoriaNome, descricao, user.id,
        body.aeronave_id || null, null, beneficiarioTipo === 'cliente' ? clienteId : null,
        beneficiarioTipo === 'colaborador' ? body.colaborador_id : null, body.boleto_url || null, body.nf_url || null, lancamentoId,
      ).run()
    }

    const recibo = await db.prepare('SELECT * FROM recibos WHERE id = ?1').bind(reciboId).first()
    return c.json({ recibo, lancamento_id: lancamentoId, movimentacao_id: movimentacaoId, rateio_ids: rateioIdsGerados, rateio_linhas: linhasRateio }, 201)
  } catch (error: any) {
    log.error('[recibos] falha ao emitir recibo', { beneficiario_tipo: beneficiarioTipo, error: error?.message || String(error) })
    if (contaPagarId) await db.prepare('DELETE FROM contas_apagar WHERE id = ?1').bind(contaPagarId).run().catch(() => undefined)
    if (lancamentoId) {
      await db.prepare('DELETE FROM rateio_despesas WHERE lancamentos_id = ?1').bind(lancamentoId).run().catch(() => undefined)
      await db.prepare('DELETE FROM lancamentos WHERE id = ?1').bind(lancamentoId).run().catch(() => undefined)
    }
    if (movimentacaoId) {
      await db.prepare('DELETE FROM rateio_hold WHERE movimento_holding_id = ?1').bind(movimentacaoId).run().catch(() => undefined)
      await db.prepare('DELETE FROM movimentos_holding WHERE id = ?1').bind(movimentacaoId).run().catch(() => undefined)
    }
    await db.prepare('DELETE FROM recibo_rateio WHERE recibo_id = ?1').bind(reciboId).run().catch(() => undefined)
    await db.prepare('DELETE FROM recibos WHERE id = ?1').bind(reciboId).run().catch(() => undefined)
    return c.json({ error: error?.message || 'falha_ao_emitir_recibo' }, 500)
  }
})

app.get('/api/financeiro/recibos/:id/visualizacao', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const recibo = await portalDb(c).prepare('SELECT * FROM recibos WHERE id = ?1').bind(c.req.param('id')).first<Record<string, any>>()
  if (!recibo) return c.notFound()
  const dinheiro = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(recibo.valor || 0))
  const esc = (value: unknown) => escapeHtml(String(value || '—'))
  return c.html(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(recibo.numero_recibo)}</title><style>body{font-family:Arial,sans-serif;color:#263238;margin:36px;max-width:900px}header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #ccd2d6;padding-bottom:18px}img{width:220px;height:96px;object-fit:contain;object-position:left center}.title{text-align:center}.title h1{font-size:25px;text-decoration:underline}.number{text-align:right;font-size:12px}.value{border:2px solid #263238;font-size:18px;font-weight:700;padding:10px 24px;margin-top:12px}.parties{display:grid;grid-template-columns:1fr 1fr;gap:40px;border-bottom:1px solid #ccd2d6;padding:24px 0;font-size:13px}.label{font-size:10px;font-weight:bold;color:#69757d;text-transform:uppercase}.table{margin-top:22px;border:1px solid #ccd2d6}.row{display:grid;grid-template-columns:1fr 160px 110px;padding:10px}.head{background:#e7eaed;font-weight:bold;font-size:12px}.details{margin-top:22px;border:1px solid #dde2e5;padding:14px;font-size:12px}@media print{body{margin:18mm}}</style></head><body><header><img src="data:image/png;base64,${SIGNATURE_LOGO_BASE64}" alt="Share Brasil"><div class="title"><h1>RECIBO</h1></div><div class="number"><b>Número do recibo:</b><br>${esc(recibo.numero_recibo)}<div class="value">${dinheiro}</div></div></header><section class="parties"><div><p class="label">${recibo.tipo_recibo === 'pagamento' ? 'Recebedor' : 'Pagador'}</p>${recibo.tipo_recibo === 'pagamento' ? `<b>${esc(recibo.recebedor_nome)}</b><br>` : `<b>SHARE BRASIL SERVIÇOS AERONÁUTICOS</b><br>CNPJ: 30.898.549/0001-06<br>Av. Pres. Arthur Bernardes, 1457`}</div><div><p class="label">${recibo.tipo_recibo === 'pagamento' ? 'Pagador' : 'Recebedor'}</p>${recibo.tipo_recibo === 'pagamento' ? `<b>${esc(recibo.nome_pagador)}</b><br>${esc(recibo.documento_pagador)}<br>${esc(recibo.endereco_pagador)}<br>${esc([recibo.cidade_pagador, recibo.uf_pagador].filter(Boolean).join(' - '))}` : recibo.tipo_recibo === 'colaborador' ? `<b>${esc(recibo.recebedor_nome)}</b><br>CPF: ${esc(recibo.recebedor_cpf)}` : `<b>${esc(recibo.nome_pagador)}</b><br>${esc(recibo.documento_pagador)}<br>${esc(recibo.endereco_pagador)}<br>${esc([recibo.cidade_pagador, recibo.uf_pagador].filter(Boolean).join(' - '))}`}</div></section><div class="table"><div class="row head"><span>Descrição do Serviço</span><span>Nº Documento</span><span>Valor</span></div><div class="row"><span>${esc(recibo.descricao_servico)}</span><span>${esc(recibo.numero_documento_anexo)}</span><b>${dinheiro}</b></div></div>${carimboAssinaturaHtml(recibo.data_emissao)}</body></html>`)
})

// Cliente reembolsa a Share pelo valor que ela antecipou: fecha o ciclo de
// DESPESAS REEMBOLSÁVEIS gerando a entrada REEMBOLSOS ENTRADAS (tipo_caixa=share) e marcando a
// lançamento original como reembolso_quitado. Nunca aplicável a recibo rateado por holding
// (regra: cliente com sócios não usa fluxo de reembolso com a Share).
app.post('/api/financeiro/recibos/:id/reembolso', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelasRecibos(c)
  const db = portalDb(c)
  const recibo = await db.prepare('SELECT * FROM recibos WHERE id = ?1').bind(c.req.param('id')).first<Record<string, any>>()
  if (!recibo) return c.notFound()
  if (recibo.tipo_recibo !== 'cliente_reembolsavel') return c.json({ error: 'recibo_nao_e_reembolsavel' }, 400)
  if (recibo.status !== 'aguardando_reembolso') return c.json({ error: 'recibo_nao_esta_aguardando_reembolso' }, 400)

  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const dataReembolso = String(body.data || '').trim() || new Date().toISOString().slice(0, 10)
    const valorReembolsoCentavos = Math.round(Number(recibo.valor || 0) * 100)
  const resultadoReembolso = await issueRevenue(db, {
    descricao: `Reembolso recibo ${recibo.numero_recibo}`,
    valorCentavos: valorReembolsoCentavos,
    data_emissao: dataReembolso,
    data_vencimento: dataReembolso,
    cotista_id: recibo.cotista_id || 'SHARE',
    categoria_nome: 'REEMBOLSOS ENTRADAS',
    origem_tipo: 'REEMBOLSO_RECIBO',
    origem_id: recibo.id,
    idempotencyKey: `recibo-reembolso:${recibo.id}`,
    observacoes: body.observacoes || null,
  }, user.id)
  const reembolsoId = resultadoReembolso.id
  await settleReceivable(db, resultadoReembolso.contaReceberId, {
    dataRecebimento: dataReembolso,
  }, user.id)

      await db.prepare('UPDATE lancamentos SET reembolso_quitado = 1 WHERE id = ?1').bind(recibo.lancamento_id).run()
      await db.prepare("UPDATE recibos SET status = 'reembolsado', lancamento_reembolso_id = ?1 WHERE id = ?2").bind(reembolsoId, recibo.id).run()

  return c.json({ ok: true, lancamento_reembolso_id: reembolsoId })
})

app.post('/api/financeiro/recibos/:id/cancelar', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelasRecibos(c)
  const db = portalDb(c)
  const recibo = await db.prepare('SELECT * FROM recibos WHERE id = ?1').bind(c.req.param('id')).first<Record<string, any>>()
  if (!recibo) return c.notFound()
  if (recibo.status === 'reembolsado') return c.json({ error: 'recibo_ja_reembolsado_nao_pode_cancelar' }, 400)
  if (recibo.status === 'cancelado') return c.json({ ok: true })
  if (recibo.lancamento_id) {
    await db.prepare("UPDATE lancamentos SET status = 'cancelado' WHERE id = ?1").bind(recibo.lancamento_id).run()
    await db.prepare("UPDATE rateio_despesas SET status = 'cancelado' WHERE lancamentos_id = ?1").bind(recibo.lancamento_id).run()
  }
  if (recibo.movimentacao_id) {
    await db.prepare("UPDATE movimentos_holding SET status = 'CANCELADO' WHERE id = ?1").bind(recibo.movimentacao_id).run()
    await db.prepare("UPDATE rateio_hold SET status = 'CANCELADO' WHERE movimento_holding_id = ?1").bind(recibo.movimentacao_id).run()
  }
  if (recibo.pdf_anexo_id) {
    const pdf = await db.prepare('SELECT caminho_arquivo FROM recibo_anexos WHERE id = ?1').bind(recibo.pdf_anexo_id).first<{ caminho_arquivo: string }>().catch(() => null)
    if (pdf?.caminho_arquivo) await shareBrasilBucket(c).delete(pdf.caminho_arquivo).catch(() => undefined)
  }
  await db.prepare('DELETE FROM recibo_anexos WHERE recibo_id = ?1').bind(recibo.id).run().catch(() => undefined)
  await db.prepare("UPDATE recibos SET status = 'cancelado' WHERE id = ?1").bind(recibo.id).run()
  return c.json({ ok: true })
})

// Upload de anexos do recibo (boleto, nota fiscal etc.) — mesmo padrão de
// salvarArquivoShareBrasil usado para documentos de cliente/sócio.
app.post('/api/financeiro/recibos/anexos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelasRecibos(c)
    const db = portalDb(c)
    const body = await c.req.parseBody()
    const fileValue = body.arquivo
    if (!(fileValue instanceof File) || !fileValue.size) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    const file = fileValue
    const key = await salvarArquivoShareBrasil(c, user.id, file, 'recibos/anexos')
    const id = uuid()
    const reciboId = typeof body.recibo_id === 'string' && body.recibo_id.trim() ? body.recibo_id.trim() : null
    await db.prepare('INSERT INTO recibo_anexos (id, recibo_id, finalidade, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, reciboId, reciboId ? 'anexo_recibo' : 'anexo_avulso', file.name, key, file.type || 'application/octet-stream', file.size, user.id).run()
    if (reciboId) await db.prepare('UPDATE recibos SET anexo_id = ?1 WHERE id = ?2').bind(id, reciboId).run()
    return c.json({ id, url: `/api/financeiro/recibos/anexos/${id}/arquivo` }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_anexo' }, 400)
  }
})
app.post('/api/financeiro/recibos/:id/pdf', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelasRecibos(c)
  const db = portalDb(c)
  const reciboId = c.req.param('id')
  const recibo = await db.prepare('SELECT id, numero_recibo FROM recibos WHERE id = ?1').bind(reciboId).first<{ id: string; numero_recibo: string }>()
  if (!recibo) return c.notFound()
  const form = await c.req.formData()
  const fileValue = form.get('arquivo') as unknown
  if (!fileValue || typeof fileValue !== 'object' || !('size' in fileValue)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const file = fileValue as File
  if (file.type !== 'application/pdf') return c.json({ error: 'pdf_obrigatorio' }, 400)
  try {
    const key = await salvarArquivoShareBrasil(c, user.id, file, 'recibos/pdf')
    const anexoId = `pdf:${reciboId}`
    await db.prepare('INSERT OR REPLACE INTO recibo_anexos (id, recibo_id, finalidade, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(anexoId, reciboId, 'pdf_gerado', file.name, key, file.type, file.size, user.id).run()
    const pdfUrl = new URL(`/api/financeiro/recibos/anexos/${encodeURIComponent(anexoId)}/arquivo`, c.req.url).toString()
    await db.prepare('UPDATE recibos SET pdf_anexo_id = ?1, pdf_url = ?2 WHERE id = ?3').bind(anexoId, pdfUrl, reciboId).run().catch(() => undefined)
    return c.json({ anexo_id: anexoId, pdf_url: pdfUrl }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_pdf' }, 400)
  }
})
app.get('/api/financeiro/recibos/anexos/:id/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await portalDb(c).prepare('SELECT caminho_arquivo, nome_arquivo, tipo_arquivo FROM recibo_anexos WHERE id = ?1').bind(c.req.param('id')).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo, 'Content-Disposition': `inline; filename="${shareBrasilFileName(row.nome_arquivo)}"`, 'Cache-Control': 'private, max-age=60' } })
})

async function garantirTabelaFichaPeso(c: Context<{ Bindings: Bindings }>) {
  void c
  return
  const db = portalDb(c)
  await db.prepare(`CREATE TABLE IF NOT EXISTS ctm_ficha_peso_balanceamento (
    id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    aeronave_id TEXT NOT NULL,
    peso_balanceamento_id TEXT NOT NULL,
    data_voo TEXT NOT NULL,
    numero_voo TEXT,
    piloto_responsavel TEXT NOT NULL,
    peso_vazio_kg REAL NOT NULL,
    braco_vazio REAL,
    momento_vazio REAL,
    itens_carregamento TEXT NOT NULL DEFAULT '[]',
    fuel_litros REAL, fuel_kg REAL, fuel_braco REAL, fuel_momento REAL,
    peso_total_kg REAL, momento_total REAL, cg_calculado REAL,
    peso_maximo_decolagem REAL, peso_maximo_pouso REAL, peso_maximo_sem_combustivel REAL,
    cg_limite_dianteiro REAL, cg_limite_traseiro REAL,
    dentro_dos_limites INTEGER,
    status TEXT NOT NULL DEFAULT 'RASCUNHO',
    snapshot_limites TEXT NOT NULL,
    observacoes TEXT,
    solicitacao_id TEXT,
    assinatura_nome TEXT,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    finalizado_em TEXT
  )`).run()
  await db.prepare('ALTER TABLE ctm_ficha_peso_balanceamento ADD COLUMN solicitacao_id TEXT').run().catch(() => undefined)
  await db.prepare('ALTER TABLE ctm_ficha_peso_balanceamento ADD COLUMN assinatura_nome TEXT').run().catch(() => undefined)
}

const parseJsonOr = (value: unknown, fallback: unknown) => {
  try { return JSON.parse(String(value ?? '')) } catch { return fallback }
}

app.get('/api/interno/agendamento/:id/peso-balanceamento', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaFichaPeso(c)
  const db = portalDb(c)
  const id = c.req.param('id')
  const reserva = await db.prepare(`SELECT s.id, s.aeronave_id, s.numero_voo, s.data_agendada, s.origem, s.destino, s.numero_passageiros, s.piloto_id, s.copiloto_id,
      a.matricula_registro, a.modelo, a.fabricante
    FROM solicitacoes_reserva_voo s LEFT JOIN aeronave a ON a.id = s.aeronave_id WHERE s.id = ?1`).bind(id).first<any>()
  if (!reserva) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  const [piloto, copiloto, config, ficha] = await Promise.all([
    reserva.piloto_id ? buscarTripulante(c, reserva.piloto_id) : null,
    reserva.copiloto_id ? buscarTripulante(c, reserva.copiloto_id) : null,
    db.prepare('SELECT * FROM ctm_peso_balanceamento WHERE aeronave_id = ?1').bind(reserva.aeronave_id).first<any>().catch(() => null),
    db.prepare('SELECT * FROM ctm_ficha_peso_balanceamento WHERE solicitacao_id = ?1 ORDER BY criado_em DESC LIMIT 1').bind(id).first<any>(),
  ])
  return c.json({
    solicitacao: reserva,
    piloto: piloto ? { id: piloto.id, nome: piloto.nome_completo, canac: (piloto as any).canac ?? null } : null,
    copiloto: copiloto ? { id: copiloto.id, nome: copiloto.nome_completo, canac: (copiloto as any).canac ?? null } : null,
    configuracao: config || null,
    ficha: ficha ? { ...ficha, itens_carregamento: parseJsonOr(ficha.itens_carregamento, []), snapshot_limites: parseJsonOr(ficha.snapshot_limites, {}) } : null,
  })
})

app.post('/api/interno/agendamento/:id/peso-balanceamento', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaFichaPeso(c)
  const db = portalDb(c)
  const solicitacaoId = c.req.param('id')
  const body = await c.req.json<Record<string, any>>().catch(() => null)
  if (!body) return c.json({ error: 'payload_invalido' }, 400)
  const reserva = await db.prepare('SELECT id, aeronave_id, numero_voo, data_agendada FROM solicitacoes_reserva_voo WHERE id = ?1').bind(solicitacaoId).first<any>()
  if (!reserva) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  const piloto = String(body.piloto_responsavel || '').trim()
  if (!piloto) return c.json({ error: 'piloto_responsavel_obrigatorio' }, 400)
  const itens = Array.isArray(body.itens_carregamento) ? body.itens_carregamento : []
  const num = (valor: unknown) => (valor === null || valor === undefined || valor === '' ? null : Number(valor))
  const status = body.status === 'FINALIZADA' ? 'FINALIZADA' : 'RASCUNHO'
  const existente = await db.prepare('SELECT id, status FROM ctm_ficha_peso_balanceamento WHERE solicitacao_id = ?1 ORDER BY criado_em DESC LIMIT 1').bind(solicitacaoId).first<any>()
  if (existente?.status === 'FINALIZADA') return c.json({ error: 'ficha_ja_finalizada', id: existente.id }, 409)
  const id = existente?.id || crypto.randomUUID()
  const valores = [
    reserva.aeronave_id, String(body.peso_balanceamento_id || ''), String(body.data_voo || reserva.data_agendada),
    body.numero_voo ?? reserva.numero_voo ?? null, piloto, Number(body.peso_vazio_kg || 0), num(body.braco_vazio), num(body.momento_vazio),
    JSON.stringify(itens), num(body.fuel_litros), num(body.fuel_kg), num(body.fuel_braco), num(body.fuel_momento), num(body.peso_total_kg), num(body.momento_total), num(body.cg_calculado),
    num(body.peso_maximo_decolagem), num(body.peso_maximo_pouso), num(body.peso_maximo_sem_combustivel), num(body.cg_limite_dianteiro), num(body.cg_limite_traseiro),
    body.dentro_dos_limites ? 1 : 0, status, JSON.stringify(body.snapshot_limites || {}), body.observacoes?.toString().trim() || null,
    solicitacaoId, body.assinatura_nome?.toString().trim() || piloto, status === 'FINALIZADA' ? new Date().toISOString() : null,
  ]
  if (existente) {
    await db.prepare(`UPDATE ctm_ficha_peso_balanceamento SET aeronave_id = ?, peso_balanceamento_id = ?, data_voo = ?, numero_voo = ?, piloto_responsavel = ?,
      peso_vazio_kg = ?, braco_vazio = ?, momento_vazio = ?, itens_carregamento = ?, fuel_litros = ?, fuel_kg = ?, fuel_braco = ?, fuel_momento = ?,
      peso_total_kg = ?, momento_total = ?, cg_calculado = ?, peso_maximo_decolagem = ?, peso_maximo_pouso = ?, peso_maximo_sem_combustivel = ?,
      cg_limite_dianteiro = ?, cg_limite_traseiro = ?, dentro_dos_limites = ?, status = ?, snapshot_limites = ?, observacoes = ?, solicitacao_id = ?,
      assinatura_nome = ?, finalizado_em = ? WHERE id = ?`).bind(...valores, id).run()
  } else {
    await db.prepare(`INSERT INTO ctm_ficha_peso_balanceamento (aeronave_id, peso_balanceamento_id, data_voo, numero_voo, piloto_responsavel,
      peso_vazio_kg, braco_vazio, momento_vazio, itens_carregamento, fuel_litros, fuel_kg, fuel_braco, fuel_momento,
      peso_total_kg, momento_total, cg_calculado, peso_maximo_decolagem, peso_maximo_pouso, peso_maximo_sem_combustivel,
      cg_limite_dianteiro, cg_limite_traseiro, dentro_dos_limites, status, snapshot_limites, observacoes, solicitacao_id,
      assinatura_nome, finalizado_em, id) VALUES (${new Array(29).fill('?').join(', ')})`).bind(...valores, id).run()
  }
  const ficha = await db.prepare('SELECT * FROM ctm_ficha_peso_balanceamento WHERE id = ?1').bind(id).first<any>()
  return c.json({ success: true, ficha: { ...ficha, itens_carregamento: parseJsonOr(ficha?.itens_carregamento, []), snapshot_limites: parseJsonOr(ficha?.snapshot_limites, {}) } }, existente ? 200 : 201)
})

app.notFound((c) => c.json({ error: 'Rota não encontrada', path: c.req.path }, 404))

// ─── Financeiro econômico dos cotistas e holdings ─────────────────────────────

async function servicoFinanceiro(c: Context<{ Bindings: Bindings }>) {
  return prepararFinanceiro(portalDb(c))
}

function respostaErroFinanceiro(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (error instanceof FinanceValidationError) {
    return c.json({ error: error.message, code: error.code }, 400)
  }
  log.error('[financeiro] falha inesperada', error)
  return c.json({ error: 'falha_ao_processar_lancamento' }, 500)
}

function erroFinanceiroKernel(c: Context<{ Bindings: Bindings }>, error: unknown) {
  if (error instanceof FinanceKernelError) return c.json({ error: error.message, code: error.code }, error.status as any)
  log.error('[financeiro-kernel] falha inesperada', error)
  return c.json({ error: 'falha_ao_processar_financeiro' }, 500)
}

app.get('/api/lancamentos/opcoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const db = portalDb(c)
  await prepararFinanceiro(db)
  const [categorias, contas, cotistas, holdings] = await Promise.all([
    db.prepare('SELECT * FROM categorias_caixa_share ORDER BY grupo, nome').all().catch(() => ({ results: [] })),
    db.prepare('SELECT id, banco, numero_conta, tipo_conta FROM contas_bancarias ORDER BY banco').all().catch(() => ({ results: [] })),
    db.prepare(`SELECT ca.id AS id, COALESCE(cl.razao_social, hs.nome, ca.id) AS nome,
                       ca.aeronave_id, ca.percentual_sociedade
                FROM cotista_aeronave ca
                LEFT JOIN cliente cl ON cl.id = ca.cliente_id
                LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
                ORDER BY nome`).all().catch(() => ({ results: [] })),
    db.prepare('SELECT id, nome, conta_bancaria FROM holdings WHERE ativo = 1 ORDER BY nome').all().catch(() => ({ results: [] })),
  ])
  return c.json({
    categorias: categorias.results || [],
    contas_bancarias: contas.results || [],
    cotistas: cotistas.results || [],
    holdings: holdings.results || [],
    pagadores: [
      { id: 'DGA_ADM', nome: 'Administração (DGA)' },
      { id: 'SHARE', nome: 'Share Brasil' },
      ...(cotistas.results || []).map((cotista: any) => ({ id: String(cotista.id), nome: String(cotista.nome || cotista.id) })),
    ],
  })
})


app.get('/api/lancamentos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const inicio = c.req.query('inicio')
  const fim = c.req.query('fim')
  const caixa = c.req.query('caixa')
  if ((inicio && !/^\d{4}-\d{2}-\d{2}$/.test(inicio)) || (fim && !/^\d{4}-\d{2}-\d{2}$/.test(fim))) {
    return c.json({ error: 'filtro_de_data_invalido' }, 400)
  }
  try {
    const service = await servicoFinanceiro(c)
    return c.json({ lancamentos: await service.listarLancamentos(inicio, fim, caixa || undefined) })
  } catch (error) {
    return respostaErroFinanceiro(c, error)
  }
})

app.post('/api/lancamentos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const valorCentavos = Number(body.valorCentavos)
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) return c.json({ error: 'valor_centavos_invalido' }, 400)
  const fluxo = String(body.fluxo || 'SAIDA').toUpperCase()
  if (fluxo !== 'ENTRADA' && fluxo !== 'SAIDA') return c.json({ error: 'fluxo_invalido' }, 400)
  if (body.valor_total != null || body.valor != null) return c.json({ error: 'use_valorCentavos' }, 400)
  try {
    const userId = extractSupabaseUserId(c)
    const result = fluxo === 'ENTRADA'
      ? await issueRevenue(portalDb(c), { ...body, valorCentavos }, userId)
      : await createExpense(portalDb(c), { ...body, valorCentavos }, userId)
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) {
    return erroFinanceiroKernel(c, error)
  }
})

app.get('/api/balanco', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const inicio = c.req.query('inicio')
  const fim = c.req.query('fim')
  if ((inicio && !/^\d{4}-\d{2}-\d{2}$/.test(inicio)) || (fim && !/^\d{4}-\d{2}-\d{2}$/.test(fim))) {
    return c.json({ error: 'filtro_de_data_invalido' }, 400)
  }
  try {
    const service = await servicoFinanceiro(c)
    return c.json(await service.obterConsolidadoBalanco(inicio, fim))
  } catch (error) {
    return respostaErroFinanceiro(c, error)
  }
})

// ─── Financeiro Cotista (clientes, rateios e balanço) ─────────────────────────

app.get('/api/interno/financeiro-cotista/dashboard', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const inicio = textoOuNulo(c.req.query('inicio'))
  const fim = textoOuNulo(c.req.query('fim'))
  if ((inicio && !/^\d{4}-\d{2}-\d{2}$/.test(inicio)) || (fim && !/^\d{4}-\d{2}-\d{2}$/.test(fim))) {
    return c.json({ error: 'filtro_de_data_invalido' }, 400)
  }

  try {
    const service = await servicoFinanceiro(c)
    const balanco = await service.obterConsolidadoBalanco(inicio || undefined, fim || undefined)
    const lancamentos = balanco.lancamentos.filter((item) => item.rateios.length > 0 || item.caixa.toUpperCase() !== 'SHARE')
    const valor = (item: typeof lancamentos[number]) => item.valorCentavos
    const saidas = lancamentos.filter((item) => item.fluxo === 'SAIDA')
    const entradas = lancamentos.filter((item) => item.fluxo === 'ENTRADA')
    const valorRateado = (item: typeof lancamentos[number]) => item.rateios.reduce((total, rateio) => total + rateio.valorCentavos, 0)
    const pendentes = lancamentos.filter((item) => !['PAGO', 'QUITADO', 'CONCILIADO', 'CANCELADO'].includes(item.status.toUpperCase()))

    const meses = new Map<string, { mes: string; entradas: number; saidas: number; custoRateado: number; lancamentos: number }>()
    for (const item of lancamentos) {
      const mes = item.data.slice(0, 7)
      const linha = meses.get(mes) ?? { mes, entradas: 0, saidas: 0, custoRateado: 0, lancamentos: 0 }
      linha.lancamentos += 1
      if (item.fluxo === 'ENTRADA') linha.entradas += valor(item)
      else { linha.saidas += valor(item); linha.custoRateado += valorRateado(item) }
      meses.set(mes, linha)
    }

    const categorias = new Map<string, { categoria: string; grupo: string; valor: number; quantidade: number }>()
    for (const item of saidas) {
      const categoria = item.categoria || 'SEM CATEGORIA'
      const atual = categorias.get(categoria) ?? { categoria, grupo: item.grupoCategoria || 'SEM GRUPO', valor: 0, quantidade: 0 }
      atual.valor += valor(item)
      atual.quantidade += 1
      categorias.set(categoria, atual)
    }

    const cotistas = new Map<string, { cotista: string; devido: number; pago: number; quantidade: number }>()
    for (const item of saidas) {
      for (const rateio of item.rateios) {
        const atual = cotistas.get(rateio.cotista) ?? { cotista: rateio.cotista, devido: 0, pago: 0, quantidade: 0 }
        atual.devido += rateio.valorCentavos
        atual.quantidade += 1
        cotistas.set(rateio.cotista, atual)
      }
    }

    const fechamentoMensal = [...meses.values()].sort((a, b) => a.mes.localeCompare(b.mes)).map((linha) => ({
      ...linha,
      saldo: linha.entradas - linha.saidas,
      mediaPorLancamento: linha.lancamentos ? Math.round(linha.saidas / linha.lancamentos) : 0,
    }))
    const totalSaidas = saidas.reduce((total, item) => total + valor(item), 0)
    const totalRateado = saidas.reduce((total, item) => total + valorRateado(item), 0)
    const mesesComMovimento = fechamentoMensal.length || 1

    return c.json({
      lancamentos,
      saldos: balanco.saldos,
      matrizCompensacao: balanco.matrizCompensacao,
      holdings: balanco.holdings,
      resumo: {
        entradas: entradas.reduce((total, item) => total + valor(item), 0),
        saidas: totalSaidas,
        saldo: entradas.reduce((total, item) => total + valor(item), 0) - totalSaidas,
        custo_rateado: totalRateado,
        pendentes: pendentes.length,
        media_mensal: Math.round(totalSaidas / mesesComMovimento),
        media_lancamento: saidas.length ? Math.round(totalSaidas / saidas.length) : 0,
      },
      fechamento_mensal: fechamentoMensal,
      ranking_gastos: [...categorias.values()].sort((a, b) => b.valor - a.valor).slice(0, 10),
      ranking_cotistas: [...cotistas.values()].sort((a, b) => b.devido - a.devido).slice(0, 10),
    })
  } catch (error) {
    return respostaErroFinanceiro(c, error)
  }
})

// ─── Financeiro Share (Caixa Share) ───────────────────────────────────────────

type LinhaGenerica = Record<string, unknown>

function textoOuNulo(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null
  const texto = String(valor).trim()
  return texto ? texto : null
}

function numeroOuZero(valor: unknown): number {
  const numero = Number(valor)
  return Number.isFinite(numero) ? numero : 0
}

function escolherCampo(linha: LinhaGenerica, chaves: string[]): string | null {
  for (const chave of chaves) {
    const valor = textoOuNulo(linha[chave])
    if (valor) return valor
  }
  return null
}

function normalizarCategoriaShare(linha: LinhaGenerica) {
  return {
    id: String(linha.id ?? ''),
    nome: escolherCampo(linha, ['nome', 'categoria', 'descricao', 'categoria_nome', 'titulo']) ?? 'SEM NOME',
    tipo: escolherCampo(linha, ['tipo', 'fluxo', 'natureza']),
    grupo: escolherCampo(linha, ['grupo', 'grupo_categoria', 'subcategoria', 'agrupamento']),
    classificacao: escolherCampo(linha, ['classificacao', 'frequencia', 'tipo_custo', 'periodicidade']),
    empresa_id: escolherCampo(linha, ['empresa_id', 'id_empresa']),
    reembolsavel: numeroOuZero(linha.reembolsavel) === 1,
  }
}

app.get('/api/interno/financeiro-share/opcoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const db = portalDb(c)
  const [categorias, contas, empresas] = await Promise.all([
    db.prepare('SELECT * FROM categorias_caixa_share').all<LinhaGenerica>().catch(() => ({ results: [] as LinhaGenerica[] })),
    db.prepare('SELECT id, banco, numero_conta, tipo_conta FROM contas_bancarias ORDER BY banco').all().catch(() => ({ results: [] })),
    db.prepare('SELECT id, razao_social, cnpj FROM empresa ORDER BY razao_social').all().catch(() => ({ results: [] })),
  ])
  return c.json({
    categorias: (categorias.results || []).map(normalizarCategoriaShare).sort((a, b) => `${a.grupo}${a.nome}`.localeCompare(`${b.grupo}${b.nome}`, 'pt-BR')),
    contas_bancarias: contas.results || [],
    empresas: empresas.results || [],
  })
})

app.get('/api/interno/financeiro-share/lancamentos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const mes = textoOuNulo(c.req.query('mes'))
  const inicio = textoOuNulo(c.req.query('inicio'))
  const fim = textoOuNulo(c.req.query('fim'))
  const busca = textoOuNulo(c.req.query('busca'))?.toLowerCase() || ''
  const categoriaId = textoOuNulo(c.req.query('categoria_id'))
  const status = textoOuNulo(c.req.query('status'))?.toUpperCase() || ''
  if ((inicio && !/^\d{4}-\d{2}-\d{2}$/.test(inicio)) || (fim && !/^\d{4}-\d{2}-\d{2}$/.test(fim)) || (mes && !/^\d{4}-\d{2}$/.test(mes))) {
    return c.json({ error: 'filtro_de_data_invalido' }, 400)
  }

  try {
    const service = await servicoFinanceiro(c)
    const canonicos = await service.listarLancamentos(inicio || undefined, fim || undefined)
    const filtrados = canonicos.filter((item) => {
      const dataMes = item.data.slice(0, 7)
      const texto = `${item.descricao} ${item.categoria} ${item.fornecedor || ''} ${item.documento || ''}`.toLowerCase()
      const caixaShare = item.caixa.toUpperCase() === 'SHARE' && item.rateios.length === 0
      return caixaShare && (!mes || dataMes === mes) && (!busca || texto.includes(busca)) && (!categoriaId || item.categoria === categoriaId) && (!status || item.status.toUpperCase() === status)
    })
    const pago = (statusAtual: string, data: string | null) => ['PAGO', 'QUITADO', 'CONCILIADO'].includes(statusAtual.toUpperCase()) || Boolean(data)
    const lancamentos: LinhaGenerica[] = filtrados.map((item) => ({
      id: item.id,
      descricao: item.descricao,
      fluxo: item.fluxo.toLowerCase(),
      categoria_id: null,
      categoria_nome: item.categoria,
      grupo_categoria: item.grupoCategoria,
      tipo: item.tipo,
      cotista_id: null,
      valor_total: item.valorCentavos / 100,
      valor_pago_real: pago(item.status, item.prazo) ? item.valorCentavos / 100 : null,
      data_emissao: item.data,
      data_pagamento: pago(item.status, item.prazo) ? item.data : null,
      data_vencimento: item.prazo,
      status: item.status.toLowerCase(),
      forma_pagamento: null,
      conta_bancaria: item.caixa,
      fornecedor_nome: item.fornecedor,
      numero_doc: item.documento,
      numero_nf: null,
      numero_recibo: null,
      numero_boleto: null,
      observacoes: item.observacoes,
      periodicidade: null,
      comprovante_url: null,
      nf_url: null,
      boleto_url: null,
      recibo_url: null,
      tipo_caixa: item.caixa.toLowerCase(),
      criado_em: item.data,
    }))
    const valorDe = (linha: LinhaGenerica) => numeroOuZero(linha.valor_pago_real ?? linha.valor_total)
    const ehEntrada = (linha: LinhaGenerica) => String(linha.fluxo || '').toLowerCase() === 'entrada'
    const pendentes = lancamentos.filter((linha) => !pago(String(linha.status || ''), textoOuNulo(linha.data_pagamento)))
    const entradas = lancamentos.filter(ehEntrada).reduce((total, linha) => total + valorDe(linha), 0)
    const saidas = lancamentos.filter((linha) => !ehEntrada(linha)).reduce((total, linha) => total + valorDe(linha), 0)
    const porGrupo = new Map<string, number>()
    for (const linha of lancamentos) if (!ehEntrada(linha)) { const grupo = textoOuNulo(linha.grupo_categoria) || 'SEM GRUPO'; porGrupo.set(grupo, (porGrupo.get(grupo) || 0) + valorDe(linha)) }
    return c.json({ lancamentos, resumo: { entradas, saidas, saldo: entradas - saidas, total_lancamentos: lancamentos.length, pendentes: pendentes.length, valor_pendente: pendentes.reduce((total, linha) => total + valorDe(linha), 0) }, grupos: [...porGrupo.entries()].map(([grupo, valor]) => ({ grupo, valor })).sort((a, b) => b.valor - a.valor) })
  } catch (error) {
    return respostaErroFinanceiro(c, error)
  }
})



// ─── Exports ──────────────────────────────────────────────────────────────────

// ─── Contas a pagar / a receber ──────────────────────────────────────────────

async function garantirTabelaContas(c: Context<{ Bindings: Bindings }>): Promise<void> {
  void c
}

function mapearContaAPagar(linha: LinhaGenerica): LinhaGenerica {
  return {
    id: linha.id,
    dataVencimento: linha.data_vencimento,
    valor: linha.valor,
    categoriaId: linha.categoria_id,
    categoriaNome: linha.categoria_nome,
    descricao: linha.descricao,
    criadoPor: linha.criado_por,
    aeronaveId: linha.aeronave_id,
    fornecedorId: linha.fornecedor_id,
    cotistaId: linha.cotista_id,
    boletoUrl: linha.boleto_url,
    nfUrl: linha.nf_url,
    dataPagamento: linha.data_pagamento,
    bancoPagamento: linha.banco_pagamento,
    comprovantePagamentoUrl: linha.comprovante_pagamento_url,
    lancamentoId: linha.lancamento_id,
    status: linha.status,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em,
  }
}

function mapearContaAReceber(linha: LinhaGenerica): LinhaGenerica {
  return {
    id: linha.id,
    dataVencimento: linha.data_vencimento,
    valor: linha.valor,
    categoriaId: linha.categoria_id,
    categoriaNome: linha.categoria_nome,
    descricao: linha.descricao,
    criadoPor: linha.criado_por,
    aeronaveId: linha.aeronave_id,
    fornecedorId: linha.fornecedor_id,
    cotistaId: linha.cotista_id,
    boletoUrl: linha.boleto_url,
    nfUrl: linha.nf_url,
    nfSaidaId: linha.nf_saida_id,
    dataRecebimento: linha.data_recebimento,
    bancoRecebimento: linha.banco_recebimento,
    comprovanteRecebimentoUrl: linha.comprovante_recebimento_url,
    lancamentoId: linha.lancamentos_id ?? linha.lancamento_id,
    status: linha.status,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em,
  }
}

app.get('/api/contas-apagar', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaContas(c)
  const db = portalDb(c)
  const status = textoOuNulo(c.req.query('status'))
  const vencidasAte = textoOuNulo(c.req.query('vencidasAte'))
  const fornecedorId = textoOuNulo(c.req.query('fornecedorId'))
  const condicoes: string[] = []
  const valores: unknown[] = []
  if (status) { condicoes.push('UPPER(status) = ?'); valores.push(status.toUpperCase()) }
  if (fornecedorId) { condicoes.push('fornecedor_id = ?'); valores.push(fornecedorId) }
  if (vencidasAte) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vencidasAte)) return c.json({ error: 'filtro_de_data_invalido' }, 400)
    condicoes.push("UPPER(status) NOT IN ('PAGO','CANCELADO') AND date(data_vencimento) <= date(?)")
    valores.push(vencidasAte)
  }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : ''
  const rows = await db.prepare(`SELECT * FROM contas_apagar ${where} ORDER BY data_vencimento ASC LIMIT 500`).bind(...valores).all<LinhaGenerica>()
  return c.json((rows.results || []).map(mapearContaAPagar))
})

app.post('/api/contas-apagar/:id/dar-baixa', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  try {
    const resultado = await settlePayable(portalDb(c), c.req.param('id'), await c.req.json().catch(() => ({})), extractSupabaseUserId(c) || null)
    return c.json(mapearContaAPagar(resultado as LinhaGenerica))
  } catch (error) {
    return erroFinanceiroKernel(c, error)
  }
})

app.get('/api/contas-areceber', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaContas(c)
  const db = portalDb(c)
  const status = textoOuNulo(c.req.query('status'))
  const vencidasAte = textoOuNulo(c.req.query('vencidasAte'))
  const cotistaId = textoOuNulo(c.req.query('cotistaId'))
  const condicoes: string[] = []
  const valores: unknown[] = []
  if (status) { condicoes.push('UPPER(status) = ?'); valores.push(status.toUpperCase()) }
  if (cotistaId) { condicoes.push('cotista_id = ?'); valores.push(cotistaId) }
  if (vencidasAte) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vencidasAte)) return c.json({ error: 'filtro_de_data_invalido' }, 400)
    condicoes.push("UPPER(status) NOT IN ('RECEBIDO','CANCELADO') AND date(data_vencimento) <= date(?)")
    valores.push(vencidasAte)
  }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : ''
  const rows = await db.prepare(`SELECT * FROM contas_areceber ${where} ORDER BY data_vencimento ASC LIMIT 500`).bind(...valores).all<LinhaGenerica>()
  return c.json((rows.results || []).map(mapearContaAReceber))
})

app.post('/api/contas-areceber/:id/dar-baixa', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  try {
    const resultado = await settleReceivable(portalDb(c), c.req.param('id'), await c.req.json().catch(() => ({})), extractSupabaseUserId(c) || null)
    return c.json(mapearContaAReceber(resultado as LinhaGenerica))
  } catch (error) {
    return erroFinanceiroKernel(c, error)
  }
})


// ─── Aeronaves Share Brasil ───────────────────────────────────────────────────
app.get('/api/sharebrasil/aeronaves', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const status = String(c.req.query('status') || '').trim().toLowerCase()
  const filtro = status === 'inativa' ? " WHERE lower(COALESCE(a.status, 'ativa')) IN ('inativa', 'cancelada')" : status === 'todas' ? '' : " WHERE lower(COALESCE(a.status, 'ativa')) NOT IN ('inativa', 'cancelada')"
  const rows = await portalDb(c).prepare(`SELECT a.*, p.categoria AS performance_categoria, p.teto_servico_ft AS performance_teto_servico_ft, p.nivel_cruzeiro_min_ft AS performance_nivel_cruzeiro_min_ft, p.nivel_cruzeiro_max_ft AS performance_nivel_cruzeiro_max_ft, p.aprovado_rvsm AS performance_aprovado_rvsm, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm FROM aeronave a LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1))${filtro} ORDER BY a.matricula_registro`).all()
  return c.json({ aeronaves: rows.results || [] })
})
app.get('/api/sharebrasil/aeronaves/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await portalDb(c).prepare(`SELECT a.*, p.id AS performance_id, p.categoria AS performance_categoria, p.modelo AS performance_modelo, p.teto_servico_ft AS performance_teto_servico_ft, p.nivel_cruzeiro_min_ft AS performance_nivel_cruzeiro_min_ft, p.nivel_cruzeiro_max_ft AS performance_nivel_cruzeiro_max_ft, p.aprovado_rvsm AS performance_aprovado_rvsm, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm FROM aeronave a LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1)) WHERE a.id = ?`).bind(c.req.param('id')).first()
  if (!row) return c.json({ error: 'aeronave_nao_encontrada' }, 404)
  return c.json({ aeronave: row })
})
app.post('/api/sharebrasil/aeronaves', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body: Record<string, any> = await c.req.json().catch(() => ({} as Record<string, any>))
  const matricula = String(body.matricula_registro || '').trim().toUpperCase()
  const fabricante = String(body.fabricante || '').trim()
  const modelo = String(body.modelo || '').trim()
  if (!matricula || !fabricante || !modelo) return c.json({ error: 'matricula_fabricante_modelo_obrigatorios' }, 400)
  const db = portalDb(c)
  const existente = await db.prepare('SELECT id FROM aeronave WHERE upper(matricula_registro) = ? LIMIT 1').bind(matricula).first()
  if (existente) return c.json({ error: 'matricula_ja_cadastrada' }, 409)
  const aeronaveId = uuid()
  const performanceFields = ['categoria', 'modelo', 'teto_servico_ft', 'nivel_cruzeiro_min_ft', 'nivel_cruzeiro_max_ft', 'aprovado_rvsm', 'velocidade_cruzeiro_kt', 'taxa_subida_fpm', 'taxa_descida_fpm']
  const performanceData = Object.fromEntries(performanceFields.filter((key) => body[key] !== undefined && body[key] !== '').map((key) => [key, key === 'aprovado_rvsm' ? (body[key] ? 1 : 0) : body[key]]))
  let performanceId: string | null = null
  if (Object.keys(performanceData).length) {
    performanceId = uuid()
    const cols = ['id', ...Object.keys(performanceData), 'criado_em', 'atualizado_em']
    await db.prepare(`INSERT INTO performance_aeronave (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(performanceId, ...Object.keys(performanceData).map((key) => performanceData[key]), new Date().toISOString(), new Date().toISOString()).run()
  }
  const aircraftData: Record<string, any> = { id: aeronaveId, matricula_registro: matricula, fabricante, modelo, numero_serie: body.numero_serie || null, nome_proprietario: body.nome_proprietario || null, status: body.status === 'inativa' ? 'inativa' : 'ativa', consumo_combustivel: body.consumo_combustivel || null, ano: body.ano || null, base: body.base || null, preco_hora: body.preco_hora || null, url_imagem: body.url_imagem || null, velocidade_cruzeiro: body.velocidade_cruzeiro || null, tipo_aeronave: body.tipo_aeronave || null, numero_motores: body.numero_motores || null, performance_aeronave_id: performanceId }
  const schema = await db.prepare("SELECT name FROM pragma_table_info('aeronave')").all<{ name: string }>()
  const existentes = new Set((schema.results || []).map((item) => item.name))
  const colunas = Object.keys(aircraftData).filter((key) => existentes.has(key))
  await db.prepare(`INSERT INTO aeronave (${colunas.join(',')}) VALUES (${colunas.map(() => '?').join(',')})`).bind(...colunas.map((key) => aircraftData[key])).run()
  const criado = await db.prepare('SELECT * FROM aeronave WHERE id = ?').bind(aeronaveId).first()
  return c.json({ aeronave: criado, performance_id: performanceId }, 201)
})

// ─── CTM: Controle de Troca e Manutenção ─────────────────────────────────────
const CTM_READ_TABLES: Record<string, { table: string; order?: string }> = {
  programa: { table: 'ctm_programa_manutencao', order: 'categoria, item' },
  oas: { table: 'ctm_ordem_acompanhamento_servico', order: 'data_entrada DESC' },
  orcamentos: { table: 'ctm_orcamentos', order: 'criado_em DESC' },
  componentes: { table: 'ctm_mapa_componente', order: 'nome' },
  diretrizes: { table: 'ctm_diretrizes', order: 'data_vencimento' },
  ras: { table: 'ctm_ras', order: 'data_entrada DESC' },
  carregamentos: { table: 'ctm_carregamentos', order: 'data_voo DESC, criado_em DESC' },
}
async function ctmRead(c: Context<{ Bindings: Bindings }>, table: string, where = '', params: unknown[] = []) {
  try {
    return await portalDb(c).prepare(`SELECT * FROM ${table}${where}`).bind(...params).all<any>()
  } catch (error) {
    log.error(`[ctm] leitura falhou em ${table}`, error)
    return { results: [] as any[] }
  }
}
app.get('/api/ctm/aeronave', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const rows = await ctmRead(c, 'aeronave', " WHERE lower(COALESCE(status,'ativa')) NOT IN ('inativa','cancelada') ORDER BY matricula_registro")
  return c.json({ data: rows.results })
})
app.get('/api/ctm/dashboard', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const aeronaveId = String(c.req.query('aeronave_id') || '').trim()
  const aeronave= await ctmRead(c, 'aeronave', " WHERE lower(COALESCE(status,'ativa')) NOT IN ('inativa','cancelada') ORDER BY matricula_registro")
  const selecionada = (aeronave.results || []).find((item: any) => String(item.id) === aeronaveId) || (aeronave.results || [])[0] || null
  const id = selecionada?.id
  const filtro = id ? ' WHERE aeronave_id = ?' : ' WHERE 1 = 0'
  const [programa, diretrizes, componentes, oas, orcamentos, ras, carregamentos] = await Promise.all([
    ctmRead(c, 'ctm_programa_manutencao', `${filtro} ORDER BY categoria, item`, id ? [id] : []),
    ctmRead(c, 'ctm_diretrizes', `${filtro} ORDER BY data_vencimento`, id ? [id] : []),
    ctmRead(c, 'ctm_mapa_componente', `${filtro} ORDER BY nome`, id ? [id] : []),
    ctmRead(c, 'ctm_ordem_acompanhamento_servico', `${filtro} ORDER BY data_entrada DESC`, id ? [id] : []),
    ctmRead(c, 'ctm_orcamentos', `${filtro} ORDER BY criado_em DESC`, id ? [id] : []),
    ctmRead(c, 'ctm_ras', `${filtro} ORDER BY data_entrada DESC`, id ? [id] : []),
    ctmRead(c, 'ctm_carregamentos', `${filtro} ORDER BY data_voo DESC`, id ? [id] : []),
  ])
  const totalOrcamento = (orcamentos.results || []).reduce((total: number, item: any) => total + Number(item.total || item.valor_total || 0), 0)
  return c.json({ data: { aeronaves: aeronave.results, aeronave: selecionada, programa: programa.results, diretrizes: diretrizes.results, componentes: componentes.results, oas: oas.results, orcamentos: orcamentos.results, ras: ras.results, carregamentos: carregamentos.results, resumo: { itens_manutencao: programa.results.length, proximos_vencimentos: programa.results.filter((item: any) => String(item.status || '').toLowerCase() !== 'concluido').length, diretrizes_pendentes: diretrizes.results.filter((item: any) => !['complied', 'concluido', 'conforme'].includes(String(item.status || '').toLowerCase())).length, componentes_atencao: componentes.results.filter((item: any) => !['ok', 'regular'].includes(String(item.status || '').toLowerCase())).length, ordens_abertas: oas.results.filter((item: any) => !['concluido', 'concluida', 'cancelado', 'cancelada'].includes(String(item.status || '').toLowerCase())).length, orcamento_total: totalOrcamento } } })
})
for (const [slug, config] of Object.entries(CTM_READ_TABLES)) {
  app.get(`/api/ctm/${slug}`, async c => {
    if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
    const aeronaveId = String(c.req.query('aeronave_id') || '').trim()
    const where = aeronaveId ? ` WHERE aeronave_id = ? ORDER BY ${config.order || 'id'}` : ` ORDER BY ${config.order || 'id'}`
    const rows = await ctmRead(c, config.table, where, aeronaveId ? [aeronaveId] : [])
    return c.json({ data: rows.results })
  })
}

const PREFETCH_ICAOS = ['SBGR', 'SBSP', 'SBRJ', 'SBCY', 'SBCF', 'SBBR']
const WORKER_URL = 'https://api.share-brasil.com'

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
