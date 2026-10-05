import { Hono, Context } from "hono"
import { cachedFetch, checkRateLimit } from "../lib/cache"
import { checkInternalAuth, requireAuthenticatedUser } from "../lib/auth"
import { escapeHtml } from "../lib/format"

type Bindings = { SHARE_DB: D1Database; CACHE_KV: KVNamespace; RATE_LIMITER: DurableObjectNamespace; INTERNAL_TOKEN?: string; SUPABASE_URL?: string; SUPABASE_ANON_KEY?: string; SUPABASE_SERVICE_ROLE_KEY?: string; VITE_SUPABASE_PUBLISHABLE_KEY?: string; WINSOCK_VALUATION_URL?: string; WINSOCK_API_KEY?: string; WINSOCK_AUTH_HEADER?: string; WINSOCK_AUTH_PREFIX?: string }
type Variables = Record<string, never>

export const valuationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const log = { debug: (..._args: unknown[]) => undefined, warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) }
const WINSOCK_VALUATION_CACHE_TTL = 86_400
const WINSOCK_N_NUMBER = /^N[0-9A-Z]{1,5}$/i

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

// ─── Windsock: resolver make_model_id a partir de texto livre ────────────────

async function resolveMakeModelId(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  modelText: string
): Promise<number | null> {
  const trimmed = modelText.trim()
  if (!trimmed) return null

  const cacheKey = `windsock-makemodel:${trimmed.toLowerCase()}`

  return cachedFetch(c, cacheKey, 30 * 86_400, async () => {
    const allowed = await checkRateLimit(c, 'windsock:reference', 60)
    if (!allowed) throw new Error('Limite de requisições de referência à Windsock atingido')

    const url = `https://windsock.ai/api/v3/references/make-models?q=${encodeURIComponent(trimmed)}&limit=1`
    const apiKey = c.env.WINSOCK_API_KEY
    if (!apiKey) throw new Error('Integração Windsock não configurada')
    const res = await fetch(url, { headers: { 'X-API-Key': apiKey } })
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
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
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
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  aircraft: Record<string, unknown>
): Promise<Record<string, any>> {
  const registration = typeof aircraft.registration === 'string' ? aircraft.registration.trim() : ''
  const isFaaTail = WINSOCK_N_NUMBER.test(registration)
  const makeModelId = isFaaTail ? null : await resolveMakeModelId(c, String(aircraft.model ?? ''))

  return callWindsockValuationApi(c, buildWindsockRequestBody(aircraft, makeModelId))
}

async function estimateUsMarketValue(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
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


/**
 * Handler compartilhado de valuation, registrado em /api/valuation (singular)
 * e /api/valuations (plural) — mesma lógica, duas rotas.
 *
 * Aceita tanto um usuário Supabase autenticado quanto o x-internal-token
 * (checkInternalAuth), para permitir chamadas internas/servidor-a-servidor
 * sem sessão de usuário.
 */
async function valuationHandler(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
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

valuationRoutes.post('/api/valuation', valuationHandler)
valuationRoutes.post('/api/valuations', valuationHandler)

valuationRoutes.post('/api/us-aircraft-estimate', async (c) => {
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
