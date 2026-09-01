import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { XMLParser } from 'fast-xml-parser'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

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

// ─── App & Logger ─────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', async (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean)
  const corsMiddleware = cors({
    origin: allowed && allowed.length > 0 ? allowed : '*',
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  })
  return corsMiddleware(c, next)
})

class CloudflareSseTransport {
  readonly sessionId = crypto.randomUUID()
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private readonly encoder = new TextEncoder()
  private closed = false
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(private readonly requestUrl: string) {}

  readonly stream = new ReadableStream<Uint8Array>({
    start: controller => {
      this.controller = controller
      const endpointUrl = new URL(`/mcp/messages?sessionId=${this.sessionId}`, this.requestUrl).toString()
      this.write(`event: endpoint\ndata: ${endpointUrl}\n\n`)
    },
    cancel: () => this.close(),
  })

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
  }

  async handleMessage(message: unknown): Promise<void> {
    const parsed = JSONRPCMessageSchema.parse(message)
    this.onmessage?.(parsed)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.controller?.close()
    this.controller = undefined
    this.onclose?.()
  }

  private write(frame: string): void {
    if (this.closed || !this.controller) return
    try {
      this.controller.enqueue(this.encoder.encode(frame))
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

type McpSession = { transport: CloudflareSseTransport; server: McpServer }
const mcpSessions = new Map<string, McpSession>()

function createMcpServer(db: D1Database): McpServer {
  const server = new McpServer({ name: 'Share Brasil MCP', version: '1.0.0' })
  server.tool(
    'executar_query_d1',
    'Executa comandos SQL de leitura e escrita no banco de dados SHARE_DB',
    { sql: z.string().describe('A query SQL a ser executada no banco de dados') },
    async ({ sql }) => {
      try {
        const result = await db.prepare(sql).all()
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

app.get('/mcp', async c => {
  const transport = new CloudflareSseTransport(c.req.url)
  const session: McpSession = { transport, server: createMcpServer(c.env.SHARE_DB) }
  mcpSessions.set(transport.sessionId, session)
  transport.onclose = () => mcpSessions.delete(transport.sessionId)
  try {
    await session.server.connect(transport)
    return new Response(transport.stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  } catch (error) {
    mcpSessions.delete(transport.sessionId)
    await transport.close()
    return c.text(`Erro ao iniciar sessão MCP: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
})

app.post('/mcp/messages', async c => {
  const sessionId = c.req.query('sessionId')
  const session = sessionId ? mcpSessions.get(sessionId) : undefined
  if (!session) return c.text('Sessão MCP não encontrada ou expirada', 404)
  try {
    await session.transport.handleMessage(await c.req.json())
    return c.text('OK')
  } catch (error) {
    return c.text(`Erro ao processar mensagem MCP: ${error instanceof Error ? error.message : String(error)}`, 400)
  }
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
  return c.json({ data_referencia: dataReferencia, resumo: { voos_hoje: Number(resumo?.voos_hoje || 0), pendencias: Number(resumo?.pendencias || 0), reservas_abertas: Number(resumo?.reservas_abertas || 0), aeronaves_ativas: Number(aeronavesAtivas?.total || 0) }, solicitacoes: solicitacoes.results })
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
    db.prepare('SELECT id, nome, cliente_id FROM hold_socios ORDER BY nome').all(),
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
  return c.json({ ano, aeronaves: rows.results.map((row: any) => ({ ...row, horas_ano: Number(row.horas_ano || 0), celula_atual_ttotal: Number(row.celula_atual_ttotal || 0), celula_prox_revisao_ttotal: Number(row.celula_prox_revisao_ttotal || 0), fechado: Number(row.fechado || 0) })) })
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
  const [tripulantes, habilitacoes, freelancers, aeronaves] = await Promise.all([
    db.prepare(`SELECT t.id, t.user_id, t.canac, t.nome_completo, t.status, t.tipo_licenca, up.email, up.telefone, up.url_avatar, up.departamento FROM tripulacao t LEFT JOIN user_profiles up ON up.id = t.user_id ORDER BY t.nome_completo`).all(),
    db.prepare('SELECT * FROM habilitacoes_tripulante ORDER BY data_validade, validade_cma').all(),
    db.prepare('SELECT f.*, a.matricula_registro, a.fabricante, a.modelo FROM tripulacao_freelancer f LEFT JOIN aeronave a ON a.id = f.aeronave_id ORDER BY f.nome_completo').all(),
    db.prepare('SELECT id, matricula_registro, fabricante, modelo, tipo_aeronave, numero_motores, status FROM aeronave ORDER BY matricula_registro').all(),
  ])
  return c.json({ tripulantes: tripulantes.results, habilitacoes: habilitacoes.results, freelancers: freelancers.results, aeronaves: aeronaves.results })
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
  const [clientes, socios, aeronaves, vinculos] = await Promise.all([
    db.prepare("SELECT id, razao_social AS nome, codigo_cliente FROM cliente WHERE lower(COALESCE(status, 'ativo')) NOT IN ('inativo', 'cancelado') ORDER BY razao_social").all(),
    db.prepare("SELECT id, nome, cliente_id FROM hold_socios ORDER BY nome").all(),
    db.prepare(`SELECT a.id, a.matricula_registro, a.fabricante, a.modelo, a.status, a.ano, a.base, a.url_imagem, a.tipo_aeronave, a.consumo_combustivel, a.velocidade_cruzeiro, p.categoria AS performance_categoria, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.teto_servico_ft AS performance_teto_servico_ft, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm
      FROM aeronave a
      LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1))
      ORDER BY a.matricula_registro`).all(),
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
      ORDER BY date(s.data_agendada), s.horario_previsto_agendamento, s.criado_em`).bind(inicio, fim).all(),
    db.prepare(`SELECT a.id, a.matricula_registro, a.fabricante, a.modelo, a.status, a.ano, a.base, a.url_imagem, a.tipo_aeronave, a.consumo_combustivel, a.velocidade_cruzeiro, p.categoria AS performance_categoria, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.teto_servico_ft AS performance_teto_servico_ft, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm
      FROM aeronave a
      LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1))
      ORDER BY a.matricula_registro`).all(),
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
  const socio = body?.socio_id ? await portalDb(c).prepare('SELECT id, cliente_id FROM hold_socios WHERE id = ?1').bind(body.socio_id).first<{ id: string; cliente_id: string | null }>() : null
  if (!cliente && !socio) return c.json({ error: 'cliente_ou_socio_obrigatorio' }, 400)
  if (cliente && socio) return c.json({ error: 'selecione_cliente_ou_socio' }, 400)
  const clienteId = cliente?.id || socio?.cliente_id || null
  const clienteEmprestimoId = body?.cliente_emprestimo_id?.trim() || null
  const socioEmprestimoId = body?.socio_emprestimo_id?.trim() || null
  if (clienteEmprestimoId && socioEmprestimoId) return c.json({ error: 'selecione_apenas_um_cedente' }, 400)
  if (clienteEmprestimoId && clienteEmprestimoId === clienteId) return c.json({ error: 'cedente_deve_ser_diferente_do_titular' }, 400)
  if (socioEmprestimoId && socioEmprestimoId === socio?.id) return c.json({ error: 'cedente_deve_ser_diferente_do_titular' }, 400)
  const cedenteCliente = clienteEmprestimoId ? await portalDb(c).prepare('SELECT id FROM cliente WHERE id = ?1').bind(clienteEmprestimoId).first<{ id: string }>() : null
  const cedenteSocio = socioEmprestimoId ? await portalDb(c).prepare('SELECT id, cliente_id FROM hold_socios WHERE id = ?1').bind(socioEmprestimoId).first<{ id: string; cliente_id: string | null }>() : null
  if (clienteEmprestimoId && !cedenteCliente) return c.json({ error: 'cliente_emprestimo_nao_encontrado' }, 400)
  if (socioEmprestimoId && !cedenteSocio) return c.json({ error: 'socio_emprestimo_nao_encontrado' }, 400)
  const vinculoTitular = await portalDb(c).prepare('SELECT codigo_cliente FROM cotista_aeronave WHERE aeronave_id = ?1 AND (cliente_id = ?2 OR socio_id = ?3) AND codigo_cliente IS NOT NULL LIMIT 1').bind(aeronaveId, clienteId, socio?.id || null).first<{ codigo_cliente: string }>()
  const vinculoCedente = clienteEmprestimoId || socioEmprestimoId
    ? await portalDb(c).prepare('SELECT codigo_cliente FROM cotista_aeronave WHERE aeronave_id = ?1 AND (cliente_id = ?2 OR socio_id = ?3) AND codigo_cliente IS NOT NULL LIMIT 1').bind(aeronaveId, clienteEmprestimoId || cedenteSocio?.cliente_id || null, socioEmprestimoId).first<{ codigo_cliente: string }>()
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
  const db = portalDb(c)
  await db.prepare(`CREATE TABLE IF NOT EXISTS checklists_pre_voo (id TEXT PRIMARY KEY NOT NULL, solicitacao_id TEXT NULL, aeronave_id TEXT NULL, cliente_id TEXT NULL, status TEXT NOT NULL DEFAULT 'rascunho', precisa_abastecer INTEGER NULL, abastecimento_id TEXT NULL, respostas TEXT NOT NULL DEFAULT '{}', observacoes TEXT NULL, executado_por TEXT NULL, executado_por_nome TEXT NULL, concluido_em TEXT NULL, criado_por TEXT NULL, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, numero_voo TEXT NULL, nivel_oleo TEXT NULL, alerta_id TEXT NULL)`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS alerta_checklist (id TEXT PRIMARY KEY NOT NULL, checklists_pre_voo_id TEXT NULL, alerta1 TEXT NULL, alerta2 TEXT NULL, alerta3 TEXT NULL, alerta4 TEXT NULL, alerta5 TEXT NULL, alerta6 TEXT NULL, alerta7 TEXT NULL, alerta8 TEXT NULL, alerta9 TEXT NULL, alerta10 TEXT NULL, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
  // Compatibilidade: migra dados da tabela reduzida criada anteriormente, sem usá-la novamente.
  await db.prepare(`INSERT OR IGNORE INTO checklists_pre_voo (id, solicitacao_id, respostas, observacoes, abastecimento_id, status, executado_por, criado_em, atualizado_em, precisa_abastecer, nivel_oleo, alerta_id, concluido_em) SELECT id, solicitacao_id, itens, observacoes, abastecimento_id, status, usuario_id, criado_em, atualizado_em, precisa_abastecer, nivel_oleo, alerta_id, concluido_em FROM checklist_pre_voo`).run().catch(() => undefined)
}

app.get('/api/interno/agendamento/:id/checklist', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaChecklist(c); const row = await portalDb(c).prepare('SELECT id, solicitacao_id, respostas AS itens, observacoes, abastecimento_id, status, executado_por AS usuario_id, executado_por_nome, nivel_oleo, alerta_id, concluido_em FROM checklists_pre_voo WHERE solicitacao_id = ? ORDER BY criado_em DESC LIMIT 1').bind(c.req.param('id')).first<any>()
  return c.json(row ? { ...row, itens: JSON.parse(row.itens || '{}') } : null)
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
  const db = portalDb(c)
  await db.prepare(`CREATE TABLE IF NOT EXISTS jornadas_voo (id TEXT PRIMARY KEY NOT NULL, solicitacao_id TEXT NULL, aeronave_id TEXT NOT NULL, tripulante_id TEXT NULL, data TEXT NOT NULL, horario_acionamento TEXT NULL, horario_apresentacao TEXT NULL, horario_corte_inicio TEXT NULL, horario_corte_final TEXT NULL, status TEXT NOT NULL DEFAULT 'em_rota', observacoes TEXT NULL, criado_por TEXT NULL, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS pernas_jornada_voo (id TEXT PRIMARY KEY NOT NULL, jornada_id TEXT NOT NULL, numero INTEGER NOT NULL, origem TEXT NOT NULL, destino TEXT NOT NULL, horario_ac TEXT NULL, horario_dep TEXT NULL, horario_pouso TEXT NULL, horario_corte TEXT NULL, status TEXT NOT NULL DEFAULT 'em_voo', lancamento_diario_id TEXT NULL, criado_em TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
}
function minutosEntre(inicio: string | null, fim: string | null): number { if (!inicio || !fim) return 0; const a = new Date(inicio).getTime(), b = new Date(fim).getTime(); return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b-a)/60000) : 0 }
app.get('/api/interno/agendamento/:id/jornada', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401); await garantirTabelaJornadas(c)
  const jornada = await portalDb(c).prepare('SELECT * FROM jornadas_voo WHERE solicitacao_id = ? ORDER BY criado_em DESC LIMIT 1').bind(c.req.param('id')).first<any>()
  if (!jornada) return c.json(null); const pernas = await portalDb(c).prepare('SELECT * FROM pernas_jornada_voo WHERE jornada_id = ? ORDER BY numero').bind(jornada.id).all<any>(); return c.json({ ...jornada, pernas: pernas.results })
})
app.post('/api/interno/agendamento/:id/jornada', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401); await garantirTabelaJornadas(c); const idSolicitacao=c.req.param('id'); const body=await c.req.json<Record<string,any>>().catch(() => ({} as Record<string, any>)); const voo=await portalDb(c).prepare('SELECT aeronave_id, piloto_id, data_agendada FROM solicitacoes_reserva_voo WHERE id=?').bind(idSolicitacao).first<any>(); if(!voo) return c.notFound()
  const data=String(body.data||voo.data_agendada||''); const ac=String(body.horario_acionamento||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(data)||!ac) return c.json({error:'data_e_acionamento_obrigatorios'},400)
  const id=uuid(); const apresentacao=body.horario_apresentacao||new Date(new Date(`${data}T${ac}`).getTime()-30*60000).toISOString(); const acionamento=new Date(`${data}T${ac}`).toISOString(); await portalDb(c).prepare('INSERT INTO jornadas_voo (id, solicitacao_id, aeronave_id, tripulante_id, data, horario_acionamento, horario_apresentacao, horario_corte_inicio, status, observacoes, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id,idSolicitacao,voo.aeronave_id,body.tripulante_id||voo.piloto_id||null,data,acionamento,apresentacao,body.horario_corte_inicio||null,'em_rota',body.observacoes||null,extractSupabaseUserId(c)).run(); return c.json({id,status:'em_rota',data,horario_acionamento:acionamento,horario_apresentacao:apresentacao,pernas:[]},201)
})
app.patch('/api/interno/jornadas/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({error:'internal_auth_required'},401); await garantirTabelaJornadas(c); const id=c.req.param('id'); const body=await c.req.json<Record<string,any>>().catch(() => ({} as Record<string, any>)); const atual=await portalDb(c).prepare('SELECT * FROM jornadas_voo WHERE id=?').bind(id).first<any>(); if(!atual) return c.notFound(); const fim=body.horario_corte_final||atual.horario_corte_final; if(body.status==='encerrada' && !fim) return c.json({error:'corte_final_obrigatorio'},400); if(body.status==='encerrada' && minutosEntre(atual.horario_apresentacao||atual.horario_acionamento,fim)>540) return c.json({error:'limite_jornada_9_horas_excedido',detail:'A jornada ultrapassa o limite de 9 horas.'},409); if (body.status === 'encerrada' && atual.tripulante_id) { const db=portalDb(c); const minutos= minutosEntre(atual.horario_apresentacao||atual.horario_acionamento,fim); const semana=await db.prepare("SELECT COALESCE(SUM((julianday(horario_corte_final)-julianday(horario_apresentacao))*1440),0) minutos FROM jornadas_voo WHERE tripulante_id=? AND status='encerrada' AND date(data)>=date(?,'-6 days') AND date(data)<=date(?)").bind(atual.tripulante_id,atual.data,atual.data).first<any>(); const mes=await db.prepare("SELECT COALESCE(SUM((julianday(horario_corte_final)-julianday(horario_apresentacao))*1440),0) minutos FROM jornadas_voo WHERE tripulante_id=? AND status='encerrada' AND strftime('%Y-%m',data)=strftime('%Y-%m',?)").bind(atual.tripulante_id,atual.data).first<any>(); if(Number(semana?.minutos||0)+minutos>2640) return c.json({error:'limite_jornada_semanal_excedido',detail:'O tripulante ultrapassaria 44 horas na semana.'},409); if(Number(mes?.minutos||0)+minutos>10560) return c.json({error:'limite_jornada_mensal_excedido',detail:'O tripulante ultrapassaria 176 horas no mês.'},409); } await portalDb(c).prepare('UPDATE jornadas_voo SET horario_acionamento=?, horario_apresentacao=?, horario_corte_inicio=?, horario_corte_final=?, data=?, status=?, observacoes=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').bind(body.horario_acionamento||atual.horario_acionamento,body.horario_apresentacao||atual.horario_apresentacao,body.horario_corte_inicio||atual.horario_corte_inicio,fim,body.data||atual.data,body.status||atual.status,body.observacoes||atual.observacoes,id).run(); return c.json(await portalDb(c).prepare('SELECT * FROM jornadas_voo WHERE id=?').bind(id).first())
})
app.post('/api/interno/jornadas/:id/pernas', async c => {
  if (!(await requireShareInternal(c))) return c.json({error:'internal_auth_required'},401); await garantirTabelaJornadas(c); const id=c.req.param('id'); const jornada=await portalDb(c).prepare('SELECT * FROM jornadas_voo WHERE id=?').bind(id).first<any>(); if(!jornada) return c.notFound(); const b=await c.req.json<Record<string,any>>().catch(() => ({} as Record<string, any>)); const data=String(b.data||jornada.data); if(data!==String(jornada.data) && !b.virada_hora) return c.json({error:'perna_data_diferente_jornada',detail:'Uma nova perna precisa ocorrer no mesmo dia da jornada, salvo virada de hora autorizada.'},409); if(!b.origem||!b.destino||!b.horario_ac||!b.horario_dep) return c.json({error:'origem_destino_ac_dep_obrigatorios'},400); const last=await portalDb(c).prepare('SELECT COALESCE(MAX(numero),0) n FROM pernas_jornada_voo WHERE jornada_id=?').bind(id).first<any>(); const pernaId=uuid(); await portalDb(c).prepare('INSERT INTO pernas_jornada_voo (id,jornada_id,numero,origem,destino,horario_ac,horario_dep,horario_pouso,horario_corte,status) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(pernaId,id,Number(last?.n||0)+1,b.origem,b.destino,b.horario_ac,b.horario_dep,b.horario_pouso||null,b.horario_corte||null,b.horario_corte?'pousado':'em_voo').run(); return c.json({id:pernaId,status:b.horario_corte?'pousado':'em_voo'},201)
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
         AND (ca.socio_id = ?1 OR ca.cliente_id = ?2 OR EXISTS (SELECT 1 FROM hold_socios hs WHERE hs.id = ca.socio_id AND hs.cliente_id = ?2))
       ORDER BY CASE WHEN ca.socio_id = ?1 THEN 0 WHEN ca.cliente_id = ?2 THEN 1 ELSE 2 END
       LIMIT 1`
    : `SELECT ca.codigo_cliente, ca.socio_id
       FROM cotista_aeronave ca
       WHERE ca.aeronave_id = ?3 AND ca.codigo_cliente IS NOT NULL
         AND (ca.socio_id = ?1 OR ca.cliente_id = ?2 OR EXISTS (SELECT 1 FROM hold_socios hs WHERE hs.id = ca.socio_id AND hs.cliente_id = ?2))
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

app.get('/api/interno/abastecimentos/opcoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  const db = portalDb(c)
  const aeronaveId = c.req.query('aeronave_id') || ''
  const [clientes, socios, aeronaves, fornecedores, diarios] = await Promise.all([
    db.prepare("SELECT id, razao_social AS nome, codigo_cliente FROM cliente WHERE lower(COALESCE(status, 'ativo')) NOT IN ('inativo', 'cancelado') ORDER BY razao_social").all(),
    db.prepare('SELECT s.id, s.nome, s.cliente_id, c.razao_social AS cliente_nome FROM hold_socios s LEFT JOIN cliente c ON c.id = s.cliente_id ORDER BY s.nome').all(),
    db.prepare('SELECT id, matricula_registro, fabricante, modelo, status FROM aeronave ORDER BY matricula_registro').all(),
    db.prepare('SELECT * FROM fornecedores_favoritos ORDER BY COALESCE(apelido, nome_completo), nome_completo').all(),
    aeronaveId
      ? db.prepare('SELECT l.id, l.data_registro, l.numero_voo, l.aeronave_id, l.cliente_id, l.socio_id, l.aerodromo_partida, l.aerodromo_chegada, c.razao_social AS cliente_nome, s.nome AS socio_nome FROM lancamentos_diario_bordo l LEFT JOIN cliente c ON c.id = l.cliente_id LEFT JOIN hold_socios s ON s.id = l.socio_id WHERE l.aeronave_id = ?1 ORDER BY date(l.data_registro) DESC, l.id DESC LIMIT 1').bind(aeronaveId).all()
      : db.prepare('SELECT id, data_registro, numero_voo, aeronave_id, cliente_id, socio_id, aerodromo_partida, aerodromo_chegada FROM lancamentos_diario_bordo ORDER BY date(data_registro) DESC LIMIT 100').all(),
  ])
  return c.json({ clientes: clientes.results, socios: socios.results, aeronaves: aeronaves.results, fornecedores: fornecedores.results, diarios: diarios.results })
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
    return c.json({ id, nome: file.name, pasta_id: pastaId, arquivo_url: `/api/sharebrasil/documentos/${id}/arquivo` }, 201)
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

app.get('/api/sharebrasil/clientes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = portalDb(c)
  await db.prepare(`CREATE TABLE IF NOT EXISTS documentos_socio (id TEXT PRIMARY KEY NOT NULL, socio_id TEXT NOT NULL, cliente_id TEXT, nome_arquivo TEXT NOT NULL, caminho_arquivo TEXT NOT NULL, tipo_arquivo TEXT NOT NULL, tamanho_arquivo INTEGER NOT NULL DEFAULT 0, enviado_por TEXT, categoria TEXT NOT NULL DEFAULT 'documentos-pessoais', criado_em TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
  const [clientes, socios, vinculos, documentos, documentosSocios, aeronaves] = await Promise.all([
    db.prepare('SELECT * FROM cliente ORDER BY razao_social').all(),
    db.prepare('SELECT * FROM hold_socios ORDER BY nome').all(),
    db.prepare('SELECT ca.*, a.matricula_registro, a.fabricante, a.modelo FROM cotista_aeronave ca LEFT JOIN aeronave a ON a.id = ca.aeronave_id ORDER BY ca.codigo_cliente').all(),
    db.prepare('SELECT * FROM documentos_cliente ORDER BY criado_em DESC').all(),
    db.prepare('SELECT * FROM documentos_socio ORDER BY criado_em DESC').all(),
    db.prepare('SELECT id, matricula_registro, fabricante, modelo, tipo_aeronave FROM aeronave ORDER BY matricula_registro').all(),
  ])
  return c.json({ clientes: clientes.results, socios: socios.results, vinculos: vinculos.results, aeronaves: aeronaves.results, documentos: documentos.results.map((item: any) => ({ ...item, arquivo_url: `/api/sharebrasil/clientes/documentos/${item.id}/arquivo` })), documentos_socios: documentosSocios.results.map((item: any) => ({ ...item, arquivo_url: `/api/sharebrasil/socios/documentos/${item.id}/arquivo` })) })
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
app.post('/api/sharebrasil/clientes/:id/aeronaves', async c => {
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
  await db.prepare(`CREATE TABLE IF NOT EXISTS documentos_socio (id TEXT PRIMARY KEY NOT NULL, socio_id TEXT NOT NULL, cliente_id TEXT, nome_arquivo TEXT NOT NULL, caminho_arquivo TEXT NOT NULL, tipo_arquivo TEXT NOT NULL, tamanho_arquivo INTEGER NOT NULL DEFAULT 0, enviado_por TEXT, categoria TEXT NOT NULL DEFAULT 'documentos-pessoais', criado_em TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
  const socio = await db.prepare('SELECT id, cliente_id FROM hold_socios WHERE id = ?1').bind(c.req.param('id')).first<{ id: string; cliente_id: string | null }>()
  if (!socio) return c.notFound()
  const form = await c.req.formData()
  const fileValue = form.get('arquivo') as unknown
  if (!fileValue || typeof fileValue !== 'object' || !('size' in fileValue)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const file = fileValue as File
  try {
    const categoria = categoriaDocumentoCliente(form.get('categoria'))
    const clientePath = socio.cliente_id || 'sem-cliente'
    const key = await salvarArquivoShareBrasil(c, user.id, file, `documentos_cliente/${categoria}/${clientePath}/socios/${socio.id}`)
    const id = uuid()
    await db.prepare('INSERT INTO documentos_socio (id, socio_id, cliente_id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, categoria) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, socio.id, socio.cliente_id, file.name, key, file.type || 'application/octet-stream', file.size, user.id, categoria).run()
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
  const result = await portalDb(c).prepare("SELECT 1 FROM usuarios_funcoes WHERE user_id = ?1 AND lower(replace(replace(trim(funcao), ' ', '_'), '-', '_')) IN ('admin', 'financeiro_master', 'gestor_master') LIMIT 1").bind(user.id).first()
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
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_ROLE_KEY) return c.json({ error: 'supabase_admin_nao_configurado' }, 503)
  const authResponse = await fetch(`${c.env.SUPABASE_URL}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: c.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senha, email_confirm: true, user_metadata: { nome_completo: nome, tipo_user: 'colaborador' } }) })
  const authData = await authResponse.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  if (!authResponse.ok || !authData.id) return c.json({ error: authData.msg || authData.message || 'nao_foi_possivel_criar_usuario_supabase' }, authResponse.status === 422 ? 409 : 502)
  const id = String(authData.id)
  try {
    await portalDb(c).prepare(`INSERT INTO user_profiles (id, email, nome_completo, nome_exibicao, telefone, cidade, uf, data_nascimento, data_admissao, cpf, rg, canac, status, tipo_user, departamento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo', 'colaborador', ?)`).bind(id, email, nome, body.nome_exibicao || nome, body.telefone || null, body.cidade || null, body.uf || null, body.data_nascimento || null, body.data_admissao || null, body.cpf || null, body.rg || null, body.canac || null, body.departamento || null).run()
  } catch (error) {
    await fetch(`${c.env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { apikey: c.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}` } }).catch(() => undefined)
    log.error('[gestao-colaborador] falha ao inserir perfil D1:', error)
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
  const room = await portalDb(c).prepare("SELECT id FROM centro_reunioes WHERE id = ?1 AND status = 'ATIVA'").bind(c.req.param('id')).first()
  if (!room) return c.notFound()
  const roomId = c.env.MEETING_ROOMS.idFromName(c.req.param('id'))
  const stub = c.env.MEETING_ROOMS.get(roomId)
  const target = new URL('https://meeting-room/websocket')
  target.searchParams.set('user_id', user.id)
  target.searchParams.set('name', user.nome_exibicao || user.nome_completo || user.email)
  target.searchParams.set('participant_id', c.req.query('participant_id') || uuid())
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
    const attachment = { id: url.searchParams.get('participant_id') || crypto.randomUUID(), userId: url.searchParams.get('user_id') || '', name: url.searchParams.get('name') || 'Participante' }
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
    const senderAttachment = sender.deserializeAttachment() as { id: string; userId: string; name: string } | null
    if (!senderAttachment) return
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
  await portalDb(c).prepare(`CREATE TABLE IF NOT EXISTS envio_despesas (id TEXT PRIMARY KEY NOT NULL, tipo TEXT NOT NULL CHECK (tipo IN ('share', 'reembolso', 'cliente')), descricao TEXT NOT NULL, valor REAL NOT NULL DEFAULT 0, data_despesa TEXT, vencimento TEXT, fornecedor TEXT, cliente_id TEXT, socio_id TEXT, aeronave_id TEXT, numero_voo TEXT, centro_custo TEXT, observacoes TEXT, status TEXT NOT NULL DEFAULT 'enviado', criado_por TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
}
app.get('/api/financeiro/envios-pagamento', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaEnvioDespesas(c)
  const tipo = c.req.query('tipo')
  const query = tipo ? 'SELECT * FROM envio_despesas WHERE tipo = ? ORDER BY criado_em DESC LIMIT 200' : 'SELECT * FROM envio_despesas ORDER BY criado_em DESC LIMIT 200'
  const rows = tipo ? await portalDb(c).prepare(query).bind(tipo).all() : await portalDb(c).prepare(query).all()
  return c.json({ envios: rows.results })
})
app.post('/api/financeiro/envios-pagamento', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaEnvioDespesas(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const tipo = String(body.tipo || '').toLowerCase()
  const descricao = String(body.descricao || '').trim()
  const valor = Number(body.valor)
  if (!['share', 'reembolso', 'cliente'].includes(tipo) || !descricao || !Number.isFinite(valor) || valor <= 0) return c.json({ error: 'tipo_descricao_e_valor_obrigatorios' }, 400)
  const id = uuid()
  await portalDb(c).prepare('INSERT INTO envio_despesas (id, tipo, descricao, valor, data_despesa, vencimento, fornecedor, cliente_id, socio_id, aeronave_id, numero_voo, centro_custo, observacoes, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, tipo, descricao, valor, body.data_despesa || null, body.vencimento || null, body.fornecedor || null, body.cliente_id || null, body.socio_id || null, body.aeronave_id || null, body.numero_voo || null, body.centro_custo || null, body.observacoes || null, user.id).run()
  const row = await portalDb(c).prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(id).first()
  return c.json(row, 201)
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
