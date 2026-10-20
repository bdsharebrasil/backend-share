import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { financeiroRoutes } from './financeiroRoutes'
import { abastecimentosRoutes } from './routes/abastecimentosRoutes'
import { gestorContratosRoutes } from './routes/gestorContratosRoutes'
import { diarioBordoRoutes } from './routes/diarioBordoRoutes'
import { jornadasRoutes } from './routes/jornadasRoutes'
import { aiswebRoutes } from './routes/aiswebRoutes'
import { valuationRoutes } from './routes/valuationRoutes'
import { portalRoutes } from './routes/portalRoutes'
import { emailRoutes } from './routes/emailsRoutes'
import { mensagensRoutes } from './routes/mensagensRoutes'
import { tripulacaoRoutes } from './routes/tripulacaoRoutes'
import { colaboradorVoosRoutes } from './routes/colaboradorVoosRoutes'
import { ctmRoutes } from './routes/ctmRoutes'
import { rastreioRoutes } from './routes/rastreioRoutes'
import { autorizarRequisicaoFinanceira, usuarioTemPapel } from './financeiro/financeiroAuth'
import { FinanceError, processFinanceQueue } from './financeiro/FinanceiroKernel'
import { calcularVencimentoReembolsoTripulante, findLancamentoClientId, sincronizarRelatorioViagemFinanceiro } from './relatorioFinanceiro'
import { ensureRelatorioContaAReceber, repairRelatorioContaReceberLinkStatements } from './financeiro/relatorioContaReceber'
import { lotesIcaoRelatorio, nomearRotaRelatorio, sequenciaRotaRelatorio, type PernaRotaRelatorio } from './relatorioViagemRota'
import { validateWorkerSchema } from './lib/schema'
import { escapeHtml } from './lib/format'
import { calcularDiasPeriodoAgendamento, normalizarHorarioAgendamento } from './lib/schedule'
import { checkRateLimit, clientIp } from './lib/cache'
import { normalizarPastaUpload, salvarArquivoShareBrasil, shareBrasilBucket, shareBrasilFileName } from './lib/storage'
import { uuid } from './lib/strings'
import { shareBrasilPontoRoutes } from './routes/shareBrasilPontoRoutes'
import { createLogger } from './lib/logger'
import type { Env } from './types/env'
import {
  authenticatedColaborador,
  authenticatedColaboradorToken,
  checkInternalAuth,
  extractSupabaseUserId,
  getAuthenticatedUserId,
  isColaboradorManager,
  isTaskManager,
  requireAuthenticatedUser,
  requireFlightOperationAccess,
  requireShareInternal,
  shareBrasilUser,
  type Colaborador,
} from './lib/auth'

// ─── Types ────────────────────────────────────────────────────────────────────

type Bindings = Pick<Env, 'AISWEB_API_KEY' | 'AISWEB_API_PASS' | 'CACHE_KV' | 'RATE_LIMITER' | 'FILES' | 'SHARE_FILES' | 'SHARE_DB' | 'RESEND_API_KEY' | 'INTERNAL_TOKEN' | 'EMAIL_FROM' | 'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY' | 'VITE_SUPABASE_PUBLISHABLE_KEY' | 'WINSOCK_VALUATION_URL' | 'WINSOCK_API_KEY' | 'WINSOCK_AUTH_HEADER' | 'WINSOCK_AUTH_PREFIX' | 'ANTHROPIC_API_KEY' | 'GEMINI_API_KEY' | 'ALLOWED_ORIGINS' | 'TELEGRAM_BOT_TOKEN' | 'CLIENT_SESSION_SECRET' | 'CLIENT_SESSION_TTL_SECONDS' | 'CLOUDFLARE_TURN_KEY_ID' | 'CLOUDFLARE_TURN_API_TOKEN' | 'MEETING_ROOMS' | 'ADSB_PROVIDER'>

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

function allowedOrigins(env: Bindings): string[] {
  return env.ALLOWED_ORIGINS?.split(',').map(origin => origin.trim()).filter(Boolean) ?? []
}

function originFor(env: Bindings, origin: string): string {
  return allowedOrigins(env).includes(origin) ? origin : ''
}

app.onError((error, c) => {
  if (error instanceof FinanceError) {
    return c.json({ error: error.message, code: error.code }, error.status as any)
  }

  createLogger((c as any).get?.('requestId') || null).error('http.internal_error', error)
  return c.json({ error: 'erro_interno', code: 'erro_interno' }, 500)
})

// CRUCIAL: O CORS precisa ser o primeiro middleware global executado
app.use('*', async (c, next) => {
  const corsMiddleware = cors({
    origin: origin => originFor(c.env, origin),
    allowHeaders: ['Content-Type', 'Authorization', 'apikey', 'X-Requested-With', 'X-Request-Id'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  })
  return corsMiddleware(c, next)
})
app.use('*', async (c, next) => {
  const recebido = c.req.header('X-Request-Id')?.trim() || ''
  const requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(recebido) ? recebido : crypto.randomUUID()
  ;(c as any).set('requestId', requestId)
  c.header('X-Request-Id', requestId)
  await next()
})
app.route('/', abastecimentosRoutes)
app.route('/api/gestor/contratos', gestorContratosRoutes)
app.route('/', diarioBordoRoutes)
app.route('/', jornadasRoutes)
app.route('/', aiswebRoutes)
app.route('/', valuationRoutes)
app.route('/', portalRoutes)
app.route('/', emailRoutes)
app.route('/', mensagensRoutes)
app.route('/', tripulacaoRoutes)
app.route('/', colaboradorVoosRoutes)
app.route('/', ctmRoutes)
app.route('/', rastreioRoutes)
app.route('/api/sharebrasil/ponto', shareBrasilPontoRoutes)
// ─── Financeiro: único ponto de entrada para comandos financeiros ────────────
// As rotas legadas de escrita foram removidas abaixo para evitar dois fluxos
// gravando diretamente no mesmo D1. O kernel é o único dono dessas operações.
app.use('/api/financeiro/*', async (c, next) => {
  const acesso = await autorizarRequisicaoFinanceira(c, new URL(c.req.url).pathname, c.req.method)
  if (!acesso.autorizado) return c.json({ error: acesso.status === 401 ? 'nao_autorizado' : 'financeiro_nao_autorizado' }, acesso.status)
  ;(c as any).set('userId', acesso.userId)
  return next()
})
app.use('/api/financeiro/cotista/*', async (c, next) => {
  const userId = (c as any).get('userId') as string | null
  if (!userId) return c.json({ error: 'nao_autorizado' }, 401)
  const permitido = await usuarioTemPapel(c.env.SHARE_DB, userId, ['admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster'])
  if (!permitido) return c.json({ error: 'financeiro_cotista_nao_autorizado' }, 403)
  return next()
})
app.route('/api/financeiro', financeiroRoutes)

// Compatibilidade para clientes antigos; o endpoint canônico é financeiro/dashboard/financeiro.
app.get('/api/interno/dashboard/financeiro', async (c) => {
  const acesso = await autorizarRequisicaoFinanceira(c, new URL(c.req.url).pathname, c.req.method)
  if (!acesso.autorizado) return c.json({ error: acesso.status === 401 ? 'nao_autorizado' : 'financeiro_nao_autorizado' }, acesso.status)
  ;(c as any).set('userId', acesso.userId)
  const url = new URL(c.req.url)
  url.pathname = '/dashboard/financeiro'
  return financeiroRoutes.fetch(new Request(url, c.req.raw), c.env, c.executionCtx)
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
  const corsMiddleware = cors({
    origin: origin => originFor(c.env, origin),
    allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
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
    createLogger((c as any).get?.('requestId') || null).error('mcp.session_start_error', error)
    return c.json({ error: 'erro_interno', code: 'erro_interno' }, 500)
  }
})

// ─── Outras Configurações & Helpers Originais ──────────────────────────────────

const log = createLogger()

// ─── Helpers: arquivos, short links e auth ────────────────────────────────────

function shortCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
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
const MAX_COLABORADOR_UPLOAD_BYTES = 10 * 1024 * 1024
const TIPOS_DOCUMENTO_COLABORADOR = new Set([
  'application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

async function parseColaboradorUploadForm(c: Context<{ Bindings: Bindings }>): Promise<FormData | null> {
  const contentLength = Number(c.req.header('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_COLABORADOR_UPLOAD_BYTES) return null
  const body = c.req.raw.body
  if (!body) throw new Error('multipart_body_missing')

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_COLABORADOR_UPLOAD_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'Content-Type': c.req.header('content-type') || '' } }).formData()
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
  if (file.size > MAX_COLABORADOR_UPLOAD_BYTES) throw new Error('arquivo_excede_10mb')
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
    const result = await c.env.SHARE_DB.prepare("SELECT id, nome, designativo_icao, coordenadas FROM aerodromo WHERE (?1 = '%%' OR upper(designativo_icao) LIKE ?1 OR upper(nome) LIKE ?1) ORDER BY designativo_icao").bind(termo).all<{ id: string; nome: string; designativo_icao: string; coordenadas: string | null }>()
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
    throw e
  }
})

// ─── Routes: Upload de arquivos (R2 + short link) ────────────────────────────

app.post('/api/upload', async (c) => {
  if (!(await checkInternalAuth(c))) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    let folder: string
    try {
      folder = normalizarPastaUpload(formData.get('folder'))
    } catch {
      return c.json({ error: 'Pasta inválida' }, 400)
    }

    if (!file) return c.json({ error: 'Arquivo ausente' }, 400)

    const MAX_SIZE = 25 * 1024 * 1024 // 25MB
    if (file.size > MAX_SIZE) return c.json({ error: 'Arquivo excede 25MB' }, 413)

    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
    const key = `${folder}/${Date.now()}-${uuid().slice(0, 8)}.${ext}`

    await c.env.FILES.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    })

    const code = shortCode()
    await c.env.SHARE_DB.prepare('INSERT INTO short_links (code, r2_key) VALUES (?, ?)')
      .bind(code, key)
      .run()

    const url = new URL(c.req.url)
    const publicUrl = `${url.protocol}//${url.host}/r/${code}`

    return c.json({ url: publicUrl, key, code })
  } catch (e: any) {
    log.error('[upload]', e.message)
    throw e
  }
})

// ─── Route: Servir arquivo via short link (público, sem auth) ───────────────

app.get('/r/:code', async (c) => {
  const code = c.req.param('code')
  if (!/^[a-f0-9]{32}$/i.test(code)) return c.notFound()
  try {
    const row = await c.env.SHARE_DB.prepare('SELECT r2_key FROM short_links WHERE code = ?')
      .bind(code)
      .first<{ r2_key: string }>()

    if (!row) return c.notFound()

    const object = await c.env.FILES.get(row.r2_key)
    if (!object) return c.notFound()

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    headers.set('Content-Disposition', `attachment; filename="${shareBrasilFileName(row.r2_key.split('/').pop() || 'arquivo')}"`)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')

    return new Response(object.body, { headers })
  } catch (e: any) {
    log.error('[serve-file]', e.message)
    throw e
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
  const db = c.env.SHARE_DB
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
    if (!(await requireAuthenticatedUser(c))) return c.json({ error: 'auth_required' }, 401)
    const authenticatedUserId = extractSupabaseUserId(c)
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
        user_id: authenticatedUserId,
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

function diasDoPeriodo(dataInicio: string, dataFim: string): number {
  const inicio = new Date(`${dataInicio}T00:00:00Z`)
  const fim = new Date(`${dataFim}T00:00:00Z`)
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime()) || fim < inicio) return 0
  return Math.floor((fim.getTime() - inicio.getTime()) / 86_400_000) + 1
}

type ColaboradorPerfilMetricas = { horas_totais: number; voos_escalados: number; ctm_abertos: number }

async function buscarTripulanteColaborador(db: D1Database, colaborador: Colaborador) {
  return db.prepare(`SELECT id, user_id, canac, nome_completo, status, tipo_licenca FROM tripulacao
    WHERE user_id = ?1 OR (NULLIF(trim(?2), '') IS NOT NULL AND lower(trim(canac)) = lower(trim(?2)))
    ORDER BY CASE WHEN user_id = ?1 THEN 0 ELSE 1 END LIMIT 1`).bind(colaborador.id, colaborador.canac).first<any>()
}

async function carregarMetricasColaborador(db: D1Database, colaborador: Colaborador, tripulante: any): Promise<ColaboradorPerfilMetricas> {
  const canac = String(tripulante?.canac || colaborador.canac || '').trim()
  const identities = [...new Set([tripulante?.id, tripulante?.canac, colaborador.canac, ...(canac ? [] : [tripulante?.nome_completo, colaborador.nome_completo])]
    .map(value => String(value || '').trim().toLowerCase()).filter(Boolean))]
  const [horas, voos, ctm] = await Promise.all([
    identities.length
      ? db.prepare(`SELECT COALESCE(SUM(COALESCE(NULLIF(tempo_total, 0), tempo_voo, 0)), 0) AS total
          FROM lancamentos_diario_bordo
          WHERE lower(trim(COALESCE(pic_canac, ''))) IN (${identities.map(() => '?').join(', ')})
             OR lower(trim(COALESCE(sic_canac, ''))) IN (${identities.map(() => '?').join(', ')})`)
        .bind(...identities, ...identities).first<{ total: number }>()
        .catch(error => { log.error('[colaborador/perfil] horas de voo indisponíveis', error); return null })
      : Promise.resolve(null),
    tripulante?.id
      ? db.prepare(`SELECT COUNT(*) AS total FROM solicitacoes_reserva_voo
          WHERE lower(trim(COALESCE(status, ''))) = 'aprovada' AND (piloto_id = ?1 OR copiloto_id = ?1)`)
        .bind(tripulante.id).first<{ total: number }>()
        .catch(error => { log.error('[colaborador/perfil] voos escalados indisponíveis', error); return null })
      : Promise.resolve(null),
    db.prepare("SELECT name FROM pragma_table_info('relatorios_manutencao')").all<{ name: string }>()
      .then(async schema => {
        const columns = new Set((schema.results || []).map(column => column.name))
        const idAuthorColumns = ['criado_por', 'created_by', 'reported_by', 'reportado_por', 'user_id', 'usuario_id'].filter(column => columns.has(column))
        const nameAuthorColumns = ['mecanico_responsavel', 'responsavel_tecnico'].filter(column => columns.has(column))
        if ((!idAuthorColumns.length && (!nameAuthorColumns.length || !colaborador.nome_completo)) || !columns.has('status')) return null
        const idIsAvailable = idAuthorColumns.length > 0
        const authorColumns = idIsAvailable ? idAuthorColumns : nameAuthorColumns
        const authorPredicates = authorColumns.map(column => idIsAvailable
          ? `${column} = ?1`
          : `lower(trim(COALESCE(${column}, ''))) = lower(trim(?1))`)
        const authorPredicate = `(${authorPredicates.join(' OR ')})`
        return db.prepare(`SELECT COUNT(*) AS total FROM relatorios_manutencao
          WHERE lower(trim(COALESCE(status, ''))) IN ('open', 'aberto')
            AND ${authorPredicate}`)
          .bind(idIsAvailable ? colaborador.id : colaborador.nome_completo).first<{ total: number }>()
      })
      .catch(error => { log.error('[colaborador/perfil] reports CTM indisponíveis', error); return null }),
  ])

  return {
    horas_totais: Number(horas?.total || 0),
    voos_escalados: Number(voos?.total || 0),
    ctm_abertos: Number(ctm?.total || 0),
  }
}

app.get('/api/colaborador/perfil', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const [tripulante, pagamentos, documentos, funcoes, ferias, aprovacoesRelatorios] = await Promise.all([
    buscarTripulanteColaborador(db, colaborador),
    db.prepare("SELECT id, descricao, NULL AS competencia, data_vencimento, data_pagamento, ROUND(valor_centavos / 100.0, 2) AS valor, status, observacoes FROM lancamentos WHERE colaborador_id = ?1 AND lower(status) <> 'cancelado' ORDER BY date(COALESCE(data_vencimento, data_emissao, criado_em)) DESC, criado_em DESC").bind(colaborador.id).all().catch(error => { log.error('[colaborador/perfil] pagamentos indisponíveis', error); return { results: [] } }),
    db.prepare('SELECT id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, criado_em, categoria FROM documentos_usuarios WHERE user_id = ?1 ORDER BY criado_em DESC').bind(colaborador.id).all().catch(error => { log.error('[colaborador/perfil] documentos indisponíveis', error); return { results: [] } }),
    db.prepare('SELECT id, funcao, criado_em FROM usuarios_funcoes WHERE user_id = ?1 ORDER BY funcao').bind(colaborador.id).all().catch(error => { log.error('[colaborador/perfil] funções indisponíveis', error); return { results: [] } }),
    db.prepare('SELECT id, data_inicio, data_fim, quantidade_dias, status, observacoes, motivo_reprovacao, aprovado_em, criado_em, atualizado_em FROM solicitacoes_ferias WHERE colaborador_id = ?1 ORDER BY data_inicio DESC, criado_em DESC').bind(colaborador.id).all().catch(error => { log.error('[colaborador/perfil] férias indisponíveis', error); return { results: [] } }),
    db.prepare(`SELECT r.id, r.numero_relatorio, r.numero_voo, r.data_inicio, r.data_fim, r.total_valor,
      r.total_tripulante_1, r.total_tripulante_2, r.status, r.status_aprovacao_tripulante,
      r.status_aprovacao_tripulante_2, r.aprovado_tripulante_1_em, r.aprovado_tripulante_2_em,
      r.aprovado_tripulante_em, r.despesas, r.pdf_url, r.tripulacao_id, r.tripulante_id_2,
      a.matricula_registro AS aeronave_matricula
      FROM relatorio_despesa_viagem r LEFT JOIN aeronave a ON a.id = r.aeronave_id
      LEFT JOIN tripulacao t1 ON t1.id = r.tripulacao_id
      LEFT JOIN tripulacao t2 ON t2.id = r.tripulante_id_2
      WHERE (t1.user_id = ?1 OR t2.user_id = ?1)
        AND r.status IN ('aguardando_aprovacao', 'ajuste_necessario')
      ORDER BY r.atualizado_em DESC`).bind(colaborador.id).all().catch(error => { log.error('[colaborador/perfil] aprovações de relatório indisponíveis', error); return { results: [] } }),
  ])

  const metricas = await carregarMetricasColaborador(db, colaborador, tripulante)
  const diasUtilizados = (ferias.results as Array<{ quantidade_dias: number; status: string }>)
    .filter(item => item.status === 'aprovada')
    .reduce((total, item) => total + item.quantidade_dias, 0)
  return c.json({
    perfil: { ...colaborador, foto_url: colaborador.url_avatar ? '/api/colaborador/foto' : null, dias_ferias_direito: 30 },
    tripulante,
    metricas,
    pagamentos: pagamentos.results,
    documentos: documentos.results.map(row => documentoColaborador(row as Record<string, unknown>)),
    funcoes: funcoes.results,
    ferias: ferias.results,
    aprovacoes_relatorios: aprovacoesRelatorios.results.map((row: any) => ({ ...row, despesas: despesasRelatorioViagem(row.despesas) })),
    resumo_ferias: { dias_direito: 30, dias_utilizados: diasUtilizados, dias_disponiveis: Math.max(0, 30 - diasUtilizados) },
  })
})

function despesasRelatorioViagem(valor: unknown): any[] {
  if (valor == null) return []
  try {
    const parsed = typeof valor === 'string' ? JSON.parse(valor) : valor
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

app.patch('/api/colaborador/perfil', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'corpo_invalido' }, 400)
  const fields = ['nome_completo', 'nome_exibicao', 'cpf', 'telefone', 'endereco', 'cidade', 'uf', 'data_nascimento', 'rg', 'canac', 'url_avatar'] as const
  const updates = fields.filter(field => body[field] !== undefined).map(field => ({ field, value: body[field] === null ? null : String(body[field]).trim() }))
  if (updates.length === 0 && body.tipo_licenca === undefined) {
    const tripulante = await buscarTripulanteColaborador(c.env.SHARE_DB, colaborador)
    return c.json({ perfil: colaborador, tripulante, metricas: await carregarMetricasColaborador(c.env.SHARE_DB, colaborador, tripulante) })
  }
  if (updates.length > 0) {
    const assignments = updates.map(({ field }) => `${field} = ?`).join(', ')
    await c.env.SHARE_DB.prepare(`UPDATE user_profiles SET ${assignments}, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?`).bind(...updates.map(({ value }) => value), colaborador.id).run()
  }
  const updated = await c.env.SHARE_DB.prepare('SELECT * FROM user_profiles WHERE id = ?1').bind(colaborador.id).first<Colaborador>()
  if (updates.some(({ field }) => field === 'nome_completo' || field === 'canac')) {
    await sincronizarTripulacaoColaborador(c, colaborador.id, updated || {}).catch(error => log.warn('[colaborador/perfil] tripulação não sincronizada', error?.message || error))
  }
  if (body.tipo_licenca !== undefined) {
    await c.env.SHARE_DB.prepare('UPDATE tripulacao SET tipo_licenca = ?1 WHERE user_id = ?2').bind(body.tipo_licenca === null ? null : String(body.tipo_licenca).trim() || null, colaborador.id).run()
  }
  const tripulante = await buscarTripulanteColaborador(c.env.SHARE_DB, updated || colaborador)
  return c.json({ perfil: { ...updated, foto_url: updated?.url_avatar ? '/api/colaborador/foto' : null, dias_ferias_direito: 30 }, tripulante, metricas: await carregarMetricasColaborador(c.env.SHARE_DB, updated || colaborador, tripulante) })
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
  const formData = await parseColaboradorUploadForm(c)
  if (!formData) return c.json({ error: 'arquivo_excede_10mb' }, 413)
  const fileValue = formData.get('foto') as unknown
  if (!fileValue || typeof fileValue !== 'object' || !('type' in fileValue) || typeof fileValue.type !== 'string' || !fileValue.type.startsWith('image/')) return c.json({ error: 'foto_invalida' }, 400)
  const file = fileValue as File
  try {
    const key = await salvarArquivoColaborador(c, colaborador.id, file, 'avatar_profiles')
    await c.env.SHARE_DB.prepare('UPDATE user_profiles SET url_avatar = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?').bind(key, colaborador.id).run()
    await sincronizarTripulacaoColaborador(c, colaborador.id, {}).catch(error => log.warn('[colaborador/foto] tripulação não sincronizada', error?.message || error))
    return c.json({ foto_url: '/api/colaborador/foto' })
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_foto' }, 400)
  }
})

app.get('/api/colaborador/documentos', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare('SELECT id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, criado_em, categoria FROM documentos_usuarios WHERE user_id = ?1 ORDER BY criado_em DESC').bind(colaborador.id).all()
  return c.json(result.results.map(row => documentoColaborador(row as Record<string, unknown>)))
})

app.post('/api/colaborador/documentos', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const formData = await parseColaboradorUploadForm(c)
  if (!formData) return c.json({ error: 'arquivo_excede_10mb' }, 413)
  const fileValue = formData.get('arquivo') as unknown
  const categoria = String(formData.get('tipo_documento') || '').trim()
  if (!fileValue || typeof fileValue !== 'object' || !('type' in fileValue) || !categoria) return c.json({ error: 'tipo_e_arquivo_obrigatorios' }, 400)
  const file = fileValue as File
  if (!TIPOS_DOCUMENTO_COLABORADOR.has(file.type)) return c.json({ error: 'tipo_de_arquivo_nao_permitido' }, 415)
  let caminhoArquivo: string | null = null
  try {
    caminhoArquivo = await salvarArquivoColaborador(c, colaborador.id, file, 'documentos_colaboradores')
    const id = uuid()
    const nomeArquivo = String(formData.get('nome_arquivo') || file.name).trim() || file.name
    await c.env.SHARE_DB.prepare('INSERT INTO documentos_usuarios (id, user_id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, categoria) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, colaborador.id, nomeArquivo, caminhoArquivo, file.type, file.size, colaborador.id, categoria).run()
    return c.json({ id, user_id: colaborador.id, nome_arquivo: nomeArquivo, tipo_documento: categoria, mime_type: file.type, tamanho_bytes: file.size, criado_em: new Date().toISOString(), status: 'em_analise', arquivo_url: `/api/colaborador/documentos/${id}/arquivo` }, 201)
  } catch (error: any) {
    if (caminhoArquivo) await bucketColaborador(c).delete(caminhoArquivo).catch(() => undefined)
    return c.json({ error: error?.message || 'falha_ao_salvar_documento' }, 400)
  }
})

app.patch('/api/colaborador/documentos/:id', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const id = c.req.param('id')
  const documento = await db.prepare('SELECT id, user_id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, criado_em, categoria FROM documentos_usuarios WHERE id = ?1 AND user_id = ?2').bind(id, colaborador.id).first<Record<string, any>>()
  if (!documento) return c.notFound()
  const formData = await parseColaboradorUploadForm(c)
  if (!formData) return c.json({ error: 'arquivo_excede_10mb' }, 413)
  const categoria = String(formData.get('categoria') ?? documento.categoria ?? 'documentos').trim() || 'documentos'
  const nomeArquivo = String(formData.get('nome_arquivo') ?? documento.nome_arquivo).trim() || documento.nome_arquivo
  const fileValue = formData.get('arquivo') as unknown
  const file = fileValue && typeof fileValue === 'object' && 'type' in fileValue && 'size' in fileValue ? fileValue as File : null
  if (file && !TIPOS_DOCUMENTO_COLABORADOR.has(file.type)) return c.json({ error: 'tipo_de_arquivo_nao_permitido' }, 415)
  let novoCaminho: string | null = null
  let salvoNoD1 = false
  try {
    if (file) novoCaminho = await salvarArquivoColaborador(c, colaborador.id, file, 'documentos_colaboradores')
    await db.prepare(`UPDATE documentos_usuarios SET nome_arquivo = ?1, categoria = ?2,
      caminho_arquivo = ?3, tipo_arquivo = ?4, tamanho_arquivo = ?5 WHERE id = ?6 AND user_id = ?7`)
      .bind(nomeArquivo, categoria, novoCaminho || documento.caminho_arquivo, file?.type || documento.tipo_arquivo, file?.size ?? documento.tamanho_arquivo, id, colaborador.id).run()
    salvoNoD1 = true
    if (novoCaminho) await bucketParaChaveColaborador(c, documento.caminho_arquivo).delete(documento.caminho_arquivo).catch(() => undefined)
    const atualizado = await db.prepare('SELECT id, user_id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, criado_em, categoria FROM documentos_usuarios WHERE id = ?1 AND user_id = ?2').bind(id, colaborador.id).first<Record<string, unknown>>()
    return c.json(documentoColaborador(atualizado || {}))
  } catch (error: any) {
    if (novoCaminho && !salvoNoD1) await bucketColaborador(c).delete(novoCaminho).catch(() => undefined)
    return c.json({ error: error?.message || 'falha_ao_atualizar_documento' }, 400)
  }
})

app.delete('/api/colaborador/documentos/:id', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const id = c.req.param('id')
  const documento = await db.prepare('SELECT caminho_arquivo FROM documentos_usuarios WHERE id = ?1 AND user_id = ?2').bind(id, colaborador.id).first<{ caminho_arquivo: string }>()
  if (!documento) return c.notFound()
  await db.prepare('DELETE FROM documentos_usuarios WHERE id = ?1 AND user_id = ?2').bind(id, colaborador.id).run()
  await bucketParaChaveColaborador(c, documento.caminho_arquivo).delete(documento.caminho_arquivo).catch(() => undefined)
  return c.json({ success: true, id })
})

app.get('/api/colaborador/documentos/:id/arquivo', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const documento = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, tipo_arquivo, nome_arquivo FROM documentos_usuarios WHERE id = ?1 AND user_id = ?2').bind(c.req.param('id'), colaborador.id).first<{ caminho_arquivo: string; tipo_arquivo: string; nome_arquivo: string }>()
  if (!documento) return c.notFound()
  const object = await bucketParaChaveColaborador(c, documento.caminho_arquivo).get(documento.caminho_arquivo)
  if (!object) return c.notFound()
  const headers = new Headers({ 'Content-Type': documento.tipo_arquivo, 'Content-Disposition': `attachment; filename="${documento.nome_arquivo.replace(/[^a-zA-Z0-9._-]/g, '_')}"` })
  return new Response(object.body, { headers })
})

app.get('/api/colaborador/ferias', async c => {
  const colaborador = await authenticatedColaborador(c)
  if (!colaborador) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare('SELECT id, data_inicio, data_fim, quantidade_dias, status, observacoes, motivo_reprovacao, aprovado_em, criado_em, atualizado_em FROM solicitacoes_ferias WHERE colaborador_id = ?1 ORDER BY data_inicio DESC, criado_em DESC').bind(colaborador.id).all()
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
  const saldo = await c.env.SHARE_DB.prepare("SELECT COALESCE(SUM(quantidade_dias), 0) AS total FROM solicitacoes_ferias WHERE colaborador_id = ?1 AND status IN ('solicitada', 'aprovada')").bind(colaborador.id).first<{ total: number }>()
  if (Number(saldo?.total || 0) + quantidadeDias > 30) return c.json({ error: 'saldo_de_ferias_insuficiente' }, 409)
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO solicitacoes_ferias (id, colaborador_id, data_inicio, data_fim, quantidade_dias, observacoes) VALUES (?, ?, ?, ?, ?, ?)').bind(id, colaborador.id, dataInicio, dataFim, quantidadeDias, body?.observacoes?.trim() || null).run()
  return c.json({ id, data_inicio: dataInicio, data_fim: dataFim, quantidade_dias: quantidadeDias, status: 'solicitada' }, 201)
})

app.get('/api/interno/dashboard/operacoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const dataReferencia = c.req.query('data') || new Date().toISOString().slice(0, 10)
  const [resumo, solicitacoes] = await Promise.all([
    c.env.SHARE_DB.prepare(`SELECT
      SUM(CASE WHEN date(data_agendada) = ?1 THEN 1 ELSE 0 END) AS voos_hoje,
      SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END) AS pendencias,
      COUNT(*) AS reservas_abertas
      FROM solicitacoes_reserva_voo
      WHERE date(data_agendada) >= ?1 AND status IN ('pendente', 'aprovada')`).bind(dataReferencia).first<Record<string, number>>(),
    c.env.SHARE_DB.prepare(`SELECT s.id, s.cliente_id, s.socio_id, s.aeronave_id, s.origem, s.destino, s.data_agendada, s.horario_previsto_agendamento, s.dias_duracao, s.numero_passageiros, s.voo_emprestado, s.status, s.motivo_rejeicao, s.numero_voo, s.criado_em, s.atualizado_em, c.razao_social AS cliente_razao_social, hs.nome AS socio_nome, COALESCE((SELECT ca.codigo_cliente FROM cotista_aeronave ca WHERE ca.socio_id = s.socio_id AND ca.codigo_cliente IS NOT NULL AND (ca.aeronave_id = s.aeronave_id OR s.aeronave_id IS NULL) ORDER BY CASE WHEN ca.aeronave_id = s.aeronave_id THEN 0 ELSE 1 END LIMIT 1), c.codigo_cliente) AS codigo_cliente, a.matricula_registro, a.modelo
      FROM solicitacoes_reserva_voo s
      LEFT JOIN cliente c ON c.id = s.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = s.socio_id
      LEFT JOIN aeronave a ON a.id = s.aeronave_id
      WHERE date(s.data_agendada) >= ?1
      ORDER BY date(s.data_agendada), s.horario_previsto_agendamento, s.criado_em
      LIMIT 50`).bind(dataReferencia).all(),
  ])
  const aeronavesAtivas = await c.env.SHARE_DB.prepare("SELECT COUNT(*) AS total FROM aeronave WHERE lower(status) = 'ativa'").first<{ total: number }>()
  return c.json({ data_referencia: dataReferencia, resumo: { voos_hoje: Number(resumo?.voos_hoje || 0), pendencias: Number(resumo?.pendencias || 0), reservas_abertas: Number(resumo?.reservas_abertas || 0), aeronaves_ativas: Number(aeronavesAtivas?.total || 0) }, solicitacoes: solicitacoes.results })
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
  const tripulante = await c.env.SHARE_DB.prepare(`SELECT t.id, t.nome_completo, t.canac, t.status, t.tipo_licenca FROM tripulacao t LEFT JOIN user_profiles up ON up.id = t.user_id WHERE t.id = ?1 AND lower(COALESCE(t.status, 'ativo')) = 'ativo' AND lower(COALESCE(up.status, 'ativo')) NOT IN ('inativo', 'inactive')`).bind(id).first<Omit<TripulanteDisponivel, 'origem'>>()
  if (tripulante) return { ...tripulante, origem: 'tripulacao' }
  const freelancer = await c.env.SHARE_DB.prepare('SELECT id, nome_completo, canac, status, NULL AS tipo_licenca FROM tripulacao_freelancer WHERE id = ?1').bind(id).first<Omit<TripulanteDisponivel, 'origem'>>()
  return freelancer ? { ...freelancer, origem: 'freelancer' } : null
}

async function garantirTabelaDisponibilidadeTripulacao(c: Context<{ Bindings: Bindings }>) {
  await validateWorkerSchema(c, [{table:'escala_tripulacao',columns:['id','tripulacao_id','data_inicio','data_fim','status']}])
}

async function garantirTabelaPlanosVoo(c: Context<{ Bindings: Bindings }>) {
  await validateWorkerSchema(c, [{table:'planos_voo',columns:['id']}])
}


async function validarElegibilidadeTripulante(c: Context<{ Bindings: Bindings }>, tripulanteId: string, aeronaveId: string): Promise<string | null> {
  const tripulante = await buscarTripulante(c, tripulanteId)
  if (!tripulante) return 'tripulante_nao_encontrado'
  if (tripulante.origem === 'freelancer') return null
  const hoje = new Date().toISOString().slice(0, 10)
  const habilitacoes = await c.env.SHARE_DB.prepare('SELECT tipo_habilitacao, data_validade, validade_cma FROM habilitacoes_tripulante WHERE tripulacao_id = ?1').bind(tripulanteId).all<{ tipo_habilitacao: string; data_validade: string | null; validade_cma: string | null }>()
  const cma = habilitacoes.results.find((item) => item.validade_cma)
  if (!cma?.validade_cma || cma.validade_cma < hoje) return 'cma_vencido_ou_nao_cadastrado'
  const aeronave = await c.env.SHARE_DB.prepare('SELECT numero_motores, modelo FROM aeronave WHERE id = ?1').bind(aeronaveId).first<{ numero_motores: number | null; modelo: string }>()
  if (Number(aeronave?.numero_motores || 0) >= 2) {
    const mlte = habilitacoes.results.find((item) => /(^|[^A-Z])MLTE([^A-Z]|$)/i.test(item.tipo_habilitacao || '') && (!item.data_validade || item.data_validade >= hoje))
    if (!mlte) return 'habilitacao_mlte_necessaria'
  }
  return null
}

async function garantirTabelaSequenciaVoos(c: Context<{ Bindings: Bindings }>): Promise<void> {
  await validateWorkerSchema(c, [{ table: 'voo_sequencia_cotista', columns: ['cotista_key', 'ultimo_numero'] }])
}

async function portalNextFlightSequence(c: Context<{ Bindings: Bindings }>, cotistaKey: string): Promise<number> {
  const sequence = await c.env.SHARE_DB.prepare(`INSERT INTO voo_sequencia_cotista (cotista_key, ultimo_numero) VALUES (?1, 1)
    ON CONFLICT(cotista_key) DO UPDATE SET ultimo_numero = ultimo_numero + 1
    RETURNING ultimo_numero`).bind(cotistaKey).first<{ ultimo_numero: number }>()
  if (!sequence) throw new Error('flight_sequence_not_initialized')
  return sequence.ultimo_numero
}

async function portalFlightSequence(c: Context<{ Bindings: Bindings }>, clientCode: string, cotistaKey: string): Promise<string> {
  const sequence = await portalNextFlightSequence(c, cotistaKey)
  const codigo = clientCode.trim().toUpperCase().slice(0, 3)
  const ano = String(new Date().getFullYear()).slice(-2)
  return `${codigo}-${String(sequence).padStart(4, '0')}/${ano}`
}

function portalAircraftSuffix(registration: string | null | undefined): string {
  const normalized = String(registration ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return normalized.replace(/^PR/, '').slice(-3) || 'AER'
}

async function portalLoanFlightSequence(c: Context<{ Bindings: Bindings }>, clientCode: string, registration: string | null | undefined, cotistaKey: string): Promise<string> {
  const codigo = clientCode.trim().toUpperCase().slice(0, 3)
  const ano = String(new Date().getFullYear()).slice(-2)
  const sequence = await portalNextFlightSequence(c, cotistaKey)
  return `${codigo}-${portalAircraftSuffix(registration)}${String(sequence).padStart(3, '0')}/${ano}`
}

app.get('/api/interno/planos-voo', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaPlanosVoo(c)
  await validarTabelaChecklistPlano(c)
  const rows = await c.env.SHARE_DB.prepare(`SELECT p.id, p.numero_voo, p.adep, p.ades, p.data_voo, p.eobt, p.payload_json, p.criado_em AS created_at, cp.status AS checklist_status
    FROM planos_voo p LEFT JOIN checklists_planos_voo cp ON cp.plano_voo_id = p.id
    ORDER BY p.criado_em DESC`).all<any>()
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
  await c.env.SHARE_DB.prepare(`INSERT INTO planos_voo (id, numero_voo, adep, ades, data_voo, eobt, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, numeroVoo, adep, ades, dataVoo, eobt, JSON.stringify(body)).run()
  return c.json({ id, created_at: new Date().toISOString() }, 201)
})

async function validarTabelaChecklistPlano(c: Context<{ Bindings: Bindings }>) {
  await validateWorkerSchema(c, [{ table: 'checklists_planos_voo', columns: ['id', 'plano_voo_id', 'itens_json', 'status'] }])
}

app.get('/api/interno/planos-voo/:id/checklist', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await validarTabelaChecklistPlano(c)
  const row = await c.env.SHARE_DB.prepare('SELECT id, plano_voo_id, itens_json, observacoes, status, executado_por AS usuario_id, executado_por_nome, criado_em, atualizado_em, concluido_em FROM checklists_planos_voo WHERE plano_voo_id = ?1').bind(c.req.param('id')).first<any>()
  if (!row) return c.json(null)
  return c.json({ ...row, itens: JSON.parse(row.itens_json || '{}') })
})

app.post('/api/interno/planos-voo/:id/checklist', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await validarTabelaChecklistPlano(c)
  const plano = await c.env.SHARE_DB.prepare('SELECT id FROM planos_voo WHERE id = ?1').bind(c.req.param('id')).first()
  if (!plano) return c.notFound()
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as any))
  const userId = extractSupabaseUserId(c)
  const executor = userId ? await c.env.SHARE_DB.prepare('SELECT COALESCE(nome_exibicao, nome_completo, email) AS nome FROM user_profiles WHERE id=?1').bind(userId).first<{ nome: string }>() : null
  const userName = executor?.nome || userId || 'Usuário não identificado'
  const status = body.status === 'concluido' ? 'concluido' : 'rascunho'
  const agora = new Date().toISOString()
  const concluidoEm = status === 'concluido' ? agora : null
  const id = uuid()
  await c.env.SHARE_DB.prepare(`INSERT INTO checklists_planos_voo (id, plano_voo_id, itens_json, observacoes, status, executado_por, executado_por_nome, criado_em, atualizado_em, concluido_em)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?8)
    ON CONFLICT(plano_voo_id) DO UPDATE SET itens_json=excluded.itens_json, observacoes=excluded.observacoes, status=excluded.status, executado_por=excluded.executado_por, executado_por_nome=excluded.executado_por_nome, atualizado_em=CURRENT_TIMESTAMP, concluido_em=excluded.concluido_em`).bind(id, c.req.param('id'), JSON.stringify(body.itens || {}), String(body.observacoes || '').trim() || null, status, userId, userName, concluidoEm).run()
  const row = await c.env.SHARE_DB.prepare('SELECT id, plano_voo_id, status, atualizado_em, concluido_em FROM checklists_planos_voo WHERE plano_voo_id = ?1').bind(c.req.param('id')).first<any>()
  return c.json(row, 201)
})

app.post('/api/interno/planos-voo/:id/pdf', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const planId = c.req.param('id')
  const plan = await c.env.SHARE_DB.prepare('SELECT id, payload_json FROM planos_voo WHERE id = ?1').bind(planId).first<{ id: string; payload_json: string }>()
  if (!plan) return c.notFound()
  const form = await c.req.formData()
  const file = form.get('arquivo') as File | null
  if (!(file instanceof File) || !file.size || file.type !== 'application/pdf') return c.json({ error: 'pdf_invalido' }, 400)
  const userId = extractSupabaseUserId(c) || 'interno'
  const key = await salvarArquivoShareBrasil(c, userId, file, 'planos-voo')
  const payload = JSON.parse(plan.payload_json || '{}')
  payload.pdf = { key, nome_arquivo: file.name, salvo_em: new Date().toISOString() }
  await c.env.SHARE_DB.prepare('UPDATE planos_voo SET payload_json = ?1 WHERE id = ?2').bind(JSON.stringify(payload), planId).run()
  return c.json({ success: true, nome_arquivo: file.name })
})

app.get('/api/interno/planos-voo/:id/pdf', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const plan = await c.env.SHARE_DB.prepare('SELECT payload_json FROM planos_voo WHERE id = ?1').bind(c.req.param('id')).first<{ payload_json: string }>()
  if (!plan) return c.notFound()
  const payload = JSON.parse(plan.payload_json || '{}')
  const key = payload?.pdf?.key
  if (!key) return c.notFound()
  const object = await shareBrasilBucket(c).get(key)
  if (!object) return c.notFound()
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Content-Type', 'application/pdf')
  headers.set('Content-Disposition', `inline; filename="${shareBrasilFileName(payload.pdf.nome_arquivo || 'plano-voo.pdf')}"`)
  headers.set('Cache-Control', 'private, max-age=300')
  return new Response(object.body, { headers })
})

app.get('/api/interno/agendamento/opcoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const db = c.env.SHARE_DB
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
  return c.json({ clientes: clientes.results, socios: socios.results, aeronaves: aeronave.results, vinculos: vinculos.results })
})

app.get('/api/interno/agendamento', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const inicio = c.req.query('inicio') || new Date().toISOString().slice(0, 10)
  const fim = c.req.query('fim') || inicio.slice(0, 7) + '-31'
  const db = c.env.SHARE_DB
  const [agendamentos, aeronave, tripulacao, freelancers, disponibilidades] = await Promise.all([
    db.prepare(`SELECT s.id, s.cliente_id, s.socio_id, s.cliente_emprestimo_id, s.socio_emprestimo_id, s.aeronave_id, s.origem, s.destino, s.data_agendada, date(s.data_agendada, '+' || (COALESCE(s.dias_duracao, 1) - 1) || ' days') AS data_fim, s.horario_previsto_agendamento, s.dias_duracao, s.numero_passageiros, s.voo_emprestado, s.status, s.observacoes, s.motivo_rejeicao, s.numero_voo, s.criado_em, s.atualizado_em, s.piloto_id, s.copiloto_id,
        (SELECT COUNT(*) FROM jornadas_voo j WHERE j.solicitacao_id = s.id AND j.status = 'encerrada') AS jornadas_encerradas,
        (SELECT COUNT(*) FROM jornadas_voo j WHERE j.solicitacao_id = s.id AND j.status <> 'encerrada') AS jornadas_abertas,
        c.razao_social AS cliente_razao_social, so.nome AS socio_nome, ce.razao_social AS cliente_emprestimo_nome, se.nome AS socio_emprestimo_nome, COALESCE(ce.codigo_cliente, (SELECT cae.codigo_cliente FROM cotista_aeronave cae WHERE (cae.cliente_id = s.cliente_emprestimo_id OR cae.socio_id = s.socio_emprestimo_id) AND cae.aeronave_id = s.aeronave_id ORDER BY cae.codigo_cliente LIMIT 1), (SELECT ca.codigo_cliente FROM cotista_aeronave ca WHERE (ca.cliente_id = s.cliente_id OR ca.socio_id = s.socio_id) AND ca.aeronave_id = s.aeronave_id ORDER BY ca.codigo_cliente LIMIT 1), c.codigo_cliente) AS codigo_cliente, a.matricula_registro, a.modelo, a.status AS status_aeronave,
        (SELECT cp.status FROM checklists_pre_voo cp WHERE cp.solicitacao_id = s.id ORDER BY cp.criado_em DESC LIMIT 1) AS checklist_status,
        (SELECT cp.respostas FROM checklists_pre_voo cp WHERE cp.solicitacao_id = s.id ORDER BY cp.criado_em DESC LIMIT 1) AS checklist_respostas
      FROM solicitacoes_reserva_voo s
      LEFT JOIN cliente c ON c.id = s.cliente_id
      LEFT JOIN hold_socios so ON so.id = s.socio_id
      LEFT JOIN cliente ce ON ce.id = s.cliente_emprestimo_id
      LEFT JOIN hold_socios se ON se.id = s.socio_emprestimo_id
      LEFT JOIN aeronave a ON a.id = s.aeronave_id
      WHERE date(s.data_agendada) BETWEEN ?1 AND ?2
      ORDER BY date(s.data_agendada), s.horario_previsto_agendamento, s.criado_em`).bind(inicio, fim).all().catch(error => { log.error('[agendamento] lançamentos indisponíveis', error); return { results: [] } }),
    db.prepare(`SELECT a.id, a.matricula_registro, a.fabricante, a.modelo, a.status, a.ano, a.base, a.url_imagem, a.tipo_aeronave, a.consumo_combustivel, a.velocidade_cruzeiro, p.categoria AS performance_categoria, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.teto_servico_ft AS performance_teto_servico_ft, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm
      FROM aeronave a
      LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1))
      ORDER BY a.matricula_registro`).all().catch(error => { log.error('[agendamento] aeronaves indisponíveis', error); return { results: [] } }),
    db.prepare("SELECT t.id, t.nome_completo, t.canac, t.status, t.tipo_licenca, up.url_avatar AS url_avatar, CASE WHEN up.url_avatar IS NOT NULL THEN '/api/interno/tripulacao/' || t.id || '/foto' ELSE NULL END AS foto_url, 'tripulacao' AS origem FROM tripulacao t LEFT JOIN user_profiles up ON up.id = COALESCE(t.user_id, (SELECT p.id FROM user_profiles p WHERE (NULLIF(trim(t.canac), '') IS NOT NULL AND lower(trim(p.canac)) = lower(trim(t.canac))) OR lower(trim(p.nome_completo)) = lower(trim(t.nome_completo)) ORDER BY CASE WHEN NULLIF(trim(t.canac), '') IS NOT NULL AND lower(trim(p.canac)) = lower(trim(t.canac)) THEN 0 ELSE 1 END, p.id LIMIT 1)) WHERE lower(COALESCE(t.status, 'ativo')) = 'ativo' AND lower(COALESCE(up.status, 'ativo')) NOT IN ('inativo', 'inactive') ORDER BY t.nome_completo").all().catch(error => { log.error('[agendamento] tripulação indisponível', error); return { results: [] } }),
    db.prepare("SELECT id, nome_completo, canac, status, NULL AS tipo_licenca, url_avatar, CASE WHEN url_avatar IS NOT NULL THEN '/api/interno/tripulacao-freelancer/' || id || '/foto' ELSE NULL END AS foto_url, 'freelancer' AS origem FROM tripulacao_freelancer WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo").all().catch(error => { log.error('[agendamento] freelancers indisponíveis', error); return { results: [] } }),
    db.prepare(`SELECT e.id, e.tripulacao_id AS tripulante_id,
        CASE WHEN EXISTS (SELECT 1 FROM tripulacao t WHERE t.id = e.tripulacao_id) THEN 'tripulacao' ELSE 'freelancer' END AS tripulante_origem,
        e.data_inicio, e.data_fim, e.status, e.observacoes
      FROM escala_tripulacao e
      WHERE date(e.data_inicio) <= date(?2) AND date(e.data_fim) >= date(?1)
      ORDER BY date(e.data_inicio), e.tripulacao_id`).bind(inicio, fim).all().catch(error => { log.error('[agendamento] disponibilidades indisponíveis', error); return { results: [] } }),
  ])
  const tripulantes = [...tripulacao.results, ...freelancers.results]
  const agendamentosFormatados = agendamentos.results.map((item: any) => {
    const { checklist_respostas: respostasJson, ...agendamento } = item
    let itensRespondidos = 0
    try {
      const respostas = JSON.parse(String(respostasJson || '{}'))
      if (respostas && typeof respostas === 'object' && !Array.isArray(respostas)) {
        itensRespondidos = Object.values(respostas).filter((resposta: any) => Boolean(resposta && typeof resposta === 'object' && resposta.status)).length
      }
    } catch {
      itensRespondidos = 0
    }
    return { ...agendamento, checklist_itens_respondidos: itensRespondidos }
  })
  const nomes = new Map(tripulantes.map((item: any) => [item.id, item.nome_completo]))
  const escala = agendamentosFormatados
    .filter((item: any) => ['aprovada', 'em_voo', 'em_rota', 'em_solo'].includes(String(item.status || '').toLowerCase()) && (item.piloto_id || item.copiloto_id))
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
  return c.json({ inicio, fim, agendamentos: agendamentosFormatados, aeronaves: aeronave.results, tripulacao: tripulantes, escala, disponibilidades: disponibilidades.results })
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
  await c.env.SHARE_DB.prepare(`INSERT INTO escala_tripulacao (id, tripulacao_id, data_inicio, data_fim, status, observacoes) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, tripulante.id, dataInicio, dataFim, status, body?.observacoes?.trim() || null).run()
  return c.json({ id, ...body, tripulante_origem: tripulante.origem, tripulante_nome: tripulante.nome_completo }, 201)
})

app.post('/api/interno/agendamento', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaDisponibilidadeTripulacao(c)
  const body = await c.req.json<{ cliente_id?: string; socio_id?: string; aeronave_id?: string; origem?: string; destino?: string; data_agendada?: string; data_fim?: string; horario_previsto_agendamento?: string; dias_duracao?: number; numero_passageiros?: number; cliente_emprestimo_id?: string; socio_emprestimo_id?: string; voo_emprestado?: string; piloto_id?: string; copiloto_id?: string; observacoes?: string }>().catch(() => null)
  const origem = body?.origem?.trim().toUpperCase() || ''
  const destino = body?.destino?.trim().toUpperCase() || ''
  const dataAgendada = body?.data_agendada?.trim() || ''
  const dataFim = body?.data_fim?.trim() || dataAgendada
  const aeronaveId = body?.aeronave_id?.trim() || ''
  if (!origem || !destino || !dataAgendada || !dataFim || !aeronaveId) return c.json({ error: 'origem_destino_periodo_e_aeronave_obrigatorios' }, 400)
  const diasDuracao = calcularDiasPeriodoAgendamento(dataAgendada, dataFim)
  if (!diasDuracao) return c.json({ error: 'periodo_invalido' }, 400)
  const horarioPrevisto = body?.horario_previsto_agendamento ? normalizarHorarioAgendamento(dataAgendada, body.horario_previsto_agendamento) : null
  if (body?.horario_previsto_agendamento && !horarioPrevisto) return c.json({ error: 'horario_previsto_invalido' }, 400)
  const aeronave = await c.env.SHARE_DB.prepare('SELECT id FROM aeronave WHERE id = ?1').bind(aeronaveId).first<{ id: string }>()
  if (!aeronave) return c.json({ error: 'aeronave_nao_disponivel' }, 409)
  const cliente = body?.cliente_id ? await c.env.SHARE_DB.prepare('SELECT id, codigo_cliente FROM cliente WHERE id = ?1').bind(body.cliente_id).first<{ id: string; codigo_cliente: string | null }>() : null
  const socio = body?.socio_id ? await c.env.SHARE_DB.prepare('SELECT id, cotista_id, holding_id FROM hold_socios WHERE id = ?1').bind(body.socio_id).first<{ id: string; cotista_id: string; holding_id: string | null }>() : null
  if (!cliente && !socio) return c.json({ error: 'cliente_ou_socio_obrigatorio' }, 400)
  if (cliente && socio) return c.json({ error: 'selecione_cliente_ou_socio' }, 400)
  const clienteId = cliente?.id || null
  const clienteEmprestimoId = body?.cliente_emprestimo_id?.trim() || null
  const socioEmprestimoId = body?.socio_emprestimo_id?.trim() || null
  if (clienteEmprestimoId && socioEmprestimoId) return c.json({ error: 'selecione_apenas_um_cedente' }, 400)
  if (clienteEmprestimoId && clienteEmprestimoId === clienteId) return c.json({ error: 'cedente_deve_ser_diferente_do_titular' }, 400)
  if (socioEmprestimoId && socioEmprestimoId === socio?.id) return c.json({ error: 'cedente_deve_ser_diferente_do_titular' }, 400)
  const cedenteCliente = clienteEmprestimoId ? await c.env.SHARE_DB.prepare('SELECT id FROM cliente WHERE id = ?1').bind(clienteEmprestimoId).first<{ id: string }>() : null
  const cedenteSocio = socioEmprestimoId ? await c.env.SHARE_DB.prepare('SELECT id, cotista_id, holding_id FROM hold_socios WHERE id = ?1').bind(socioEmprestimoId).first<{ id: string; cotista_id: string; holding_id: string | null }>() : null
  if (clienteEmprestimoId && !cedenteCliente) return c.json({ error: 'cliente_emprestimo_nao_encontrado' }, 400)
  if (socioEmprestimoId && !cedenteSocio) return c.json({ error: 'socio_emprestimo_nao_encontrado' }, 400)
  const vinculoTitular = await c.env.SHARE_DB.prepare('SELECT codigo_cliente FROM cotista_aeronave WHERE aeronave_id = ?1 AND (cliente_id = ?2 OR socio_id = ?3) AND codigo_cliente IS NOT NULL LIMIT 1').bind(aeronaveId, clienteId, socio?.id || null).first<{ codigo_cliente: string }>()
  const vinculoCedente = clienteEmprestimoId || socioEmprestimoId
    ? await c.env.SHARE_DB.prepare('SELECT codigo_cliente FROM cotista_aeronave WHERE aeronave_id = ?1 AND (cliente_id = ?2 OR socio_id = ?3) AND codigo_cliente IS NOT NULL LIMIT 1').bind(aeronaveId, clienteEmprestimoId || null, socioEmprestimoId).first<{ codigo_cliente: string }>()
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
  await c.env.SHARE_DB.prepare(`INSERT INTO solicitacoes_reserva_voo (id, cliente_id, socio_id, cliente_emprestimo_id, socio_emprestimo_id, aeronave_id, voo_emprestado, origem, destino, data_agendada, horario_previsto_agendamento, dias_duracao, numero_passageiros, status, observacoes, piloto_id, copiloto_id, numero_voo, aprovado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, clienteId, socio?.id || null, clienteEmprestimoId, socioEmprestimoId, aeronaveId, vooEmprestado, origem, destino, dataAgendada, horarioPrevisto, diasDuracao, Math.max(1, Number(body?.numero_passageiros || 1)), 'pendente', body?.observacoes?.trim() || null, piloto?.id || null, copiloto?.id || null, null, null).run()
  return c.json({ id, status: 'pendente', numero_voo: null }, 201)
})

app.patch('/api/interno/agendamento/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const id = c.req.param('id').trim()
  if (!id) return c.json({ error: 'agendamento_id_obrigatorio' }, 400)
  const db = c.env.SHARE_DB
  const atual = await db.prepare('SELECT * FROM solicitacoes_reserva_voo WHERE id = ?1').bind(id).first<any>()
  if (!atual) return c.notFound()
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const origem = body.origem === undefined ? String(atual.origem || '').trim().toUpperCase() : String(body.origem || '').trim().toUpperCase()
  const destino = body.destino === undefined ? String(atual.destino || '').trim().toUpperCase() : String(body.destino || '').trim().toUpperCase()
  const dataAgendada = body.data_agendada === undefined ? String(atual.data_agendada || '').slice(0, 10) : String(body.data_agendada || '').trim()
  if (!origem || !destino || !/^\d{4}-\d{2}-\d{2}$/.test(dataAgendada)) return c.json({ error: 'rota_e_periodo_invalidos' }, 400)
  const dataFimAtual = new Date(Date.parse(`${dataAgendada}T00:00:00Z`) + (Math.max(1, Number(atual.dias_duracao) || 1) - 1) * 86_400_000).toISOString().slice(0, 10)
  const dataFim = body.data_fim === undefined ? dataFimAtual : String(body.data_fim || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataFim) || dataFim < dataAgendada) return c.json({ error: 'rota_e_periodo_invalidos' }, 400)
  const aeronaveId = body.aeronave_id === undefined ? atual.aeronave_id : String(body.aeronave_id || '').trim()
  const aeronave = await db.prepare('SELECT id FROM aeronave WHERE id = ?1').bind(aeronaveId).first<{ id: string }>()
  if (!aeronave) return c.json({ error: 'aeronave_nao_disponivel' }, 409)
  const horarioEnviado = body.horario_previsto_agendamento === undefined ? atual.horario_previsto_agendamento : body.horario_previsto_agendamento
  const horarioPrevisto = horarioEnviado ? normalizarHorarioAgendamento(dataAgendada, horarioEnviado) : null
  if (horarioEnviado && !horarioPrevisto) return c.json({ error: 'horario_previsto_invalido' }, 400)
  const numeroPassageiros = body.numero_passageiros === undefined ? Number(atual.numero_passageiros || 1) : Number(body.numero_passageiros)
  if (!Number.isInteger(numeroPassageiros) || numeroPassageiros < 1) return c.json({ error: 'numero_passageiros_invalido' }, 400)
  const pilotoId = body.piloto_id === undefined ? atual.piloto_id : String(body.piloto_id || '').trim() || null
  const copilotoId = body.copiloto_id === undefined ? atual.copiloto_id : String(body.copiloto_id || '').trim() || null
  if (pilotoId && copilotoId && pilotoId === copilotoId) return c.json({ error: 'tripulantes_iguais' }, 400)
  for (const assigned of [pilotoId, copilotoId].filter((value): value is string => Boolean(value))) {
    if (!(await buscarTripulante(c, assigned))) return c.json({ error: 'tripulante_nao_encontrado', tripulante_id: assigned }, 400)
    const eligibility = await validarElegibilidadeTripulante(c, assigned, aeronaveId)
    if (eligibility) return c.json({ error: eligibility, tripulante_id: assigned }, 409)
  }
  const diasDuracao = calcularDiasPeriodoAgendamento(dataAgendada, dataFim)
  if (!diasDuracao) return c.json({ error: 'periodo_invalido' }, 400)
  await db.prepare(`UPDATE solicitacoes_reserva_voo SET aeronave_id = ?, origem = ?, destino = ?, data_agendada = ?, horario_previsto_agendamento = ?, dias_duracao = ?, numero_passageiros = ?, piloto_id = ?, copiloto_id = ?, observacoes = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(
    aeronaveId, origem, destino, dataAgendada, horarioPrevisto, diasDuracao, numeroPassageiros, pilotoId, copilotoId,
    body.observacoes === undefined ? atual.observacoes : String(body.observacoes || '').trim() || null, id,
  ).run()
  return c.json({ success: true, id, data_agendada: dataAgendada, data_fim: dataFim, dias_duracao: diasDuracao, horario_previsto_agendamento: horarioPrevisto, numero_passageiros: numeroPassageiros, aeronave_id: aeronaveId, piloto_id: pilotoId, copiloto_id: copilotoId })
})

app.post('/api/interno/solicitacoes/:id/aprovar', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaDisponibilidadeTripulacao(c)
  await garantirTabelaSequenciaVoos(c)
  const id = c.req.param('id')
  const reservation = await c.env.SHARE_DB.prepare(`SELECT s.*, a.matricula_registro
    FROM solicitacoes_reserva_voo s
    LEFT JOIN aeronave a ON a.id = s.aeronave_id
    WHERE s.id = ?1`).bind(id).first<{
      status: string
      cliente_id: string | null
      socio_id: string | null
      matricula_registro: string | null
      aeronave_id: string
      cliente_emprestimo_id: string | null
      socio_emprestimo_id: string | null
      voo_emprestado: string | null
      data_agendada: string
      dias_duracao: number
      horario_previsto_agendamento: string | null
      numero_passageiros: number
    }>()
  if (!reservation) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  if (reservation.status !== 'pendente') return c.json({ error: 'solicitacao_nao_pendente' }, 409)
  type CorpoConfirmacao = {
    piloto_id?: string
    copiloto_id?: string
    aeronave_id?: string
    data_agendada?: string
    data_fim?: string
    horario_previsto_agendamento?: string | null
    numero_passageiros?: number
    cliente_emprestimo_id?: string | null
    socio_emprestimo_id?: string | null
  }
  const body = await c.req.json<CorpoConfirmacao>().catch(() => ({} as CorpoConfirmacao))
  const aeronaveId = body.aeronave_id?.trim() || reservation.aeronave_id
  const dataAgendada = body.data_agendada?.trim() || reservation.data_agendada.slice(0, 10)
  const dataFimAtual = new Date(Date.parse(`${dataAgendada}T00:00:00Z`) + (Math.max(1, Number(reservation.dias_duracao) || 1) - 1) * 86_400_000).toISOString().slice(0, 10)
  const dataFim = body.data_fim?.trim() || dataFimAtual
  const diasDuracao = calcularDiasPeriodoAgendamento(dataAgendada, dataFim)
  if (!diasDuracao) return c.json({ error: 'periodo_invalido' }, 400)
  const numeroPassageiros = body.numero_passageiros === undefined ? Number(reservation.numero_passageiros || 1) : Number(body.numero_passageiros)
  if (!Number.isInteger(numeroPassageiros) || numeroPassageiros < 1) return c.json({ error: 'numero_passageiros_invalido' }, 400)
  const horarioEnviado = body.horario_previsto_agendamento !== undefined ? body.horario_previsto_agendamento : reservation.horario_previsto_agendamento
  const horarioPrevisto = horarioEnviado ? normalizarHorarioAgendamento(dataAgendada, horarioEnviado) : null
  if (horarioEnviado && !horarioPrevisto) return c.json({ error: 'horario_previsto_invalido' }, 400)
  const aeronave = await c.env.SHARE_DB.prepare('SELECT id, matricula_registro FROM aeronave WHERE id = ?1').bind(aeronaveId).first<{ id: string; matricula_registro: string | null }>()
  if (!aeronave) return c.json({ error: 'aeronave_nao_disponivel' }, 409)
  const clienteEmprestimoId = body.cliente_emprestimo_id !== undefined ? body.cliente_emprestimo_id?.trim() || null : reservation.cliente_emprestimo_id
  const socioEmprestimoId = body.socio_emprestimo_id !== undefined ? body.socio_emprestimo_id?.trim() || null : reservation.socio_emprestimo_id
  if (clienteEmprestimoId && socioEmprestimoId) return c.json({ error: 'selecione_apenas_um_cedente' }, 400)
  if (clienteEmprestimoId && clienteEmprestimoId === reservation.cliente_id) return c.json({ error: 'cedente_deve_ser_diferente_do_titular' }, 400)
  if (socioEmprestimoId && socioEmprestimoId === reservation.socio_id) return c.json({ error: 'cedente_deve_ser_diferente_do_titular' }, 400)
  const titularVinculado = await c.env.SHARE_DB.prepare('SELECT id FROM cotista_aeronave WHERE aeronave_id = ?1 AND (cliente_id = ?2 OR socio_id = ?3) LIMIT 1')
    .bind(aeronaveId, reservation.cliente_id, reservation.socio_id).first<{ id: string }>()
  const cedenteVinculado = clienteEmprestimoId || socioEmprestimoId
    ? await c.env.SHARE_DB.prepare('SELECT id FROM cotista_aeronave WHERE aeronave_id = ?1 AND (cliente_id = ?2 OR socio_id = ?3) LIMIT 1')
      .bind(aeronaveId, clienteEmprestimoId, socioEmprestimoId).first<{ id: string }>()
    : null
  if ((clienteEmprestimoId || socioEmprestimoId) && !cedenteVinculado) return c.json({ error: 'cedente_nao_vinculado_a_aeronave' }, 400)
  if (!titularVinculado && !cedenteVinculado) return c.json({ error: 'informe_emprestimo_da_aeronave' }, 400)
  const vooEmprestado = Boolean(clienteEmprestimoId || socioEmprestimoId)
  if (!body.piloto_id) return c.json({ error: 'piloto_obrigatorio' }, 400)
  if (body.copiloto_id && body.copiloto_id === body.piloto_id) return c.json({ error: 'tripulantes_iguais' }, 400)
  const piloto = await buscarTripulante(c, body.piloto_id)
  const copiloto = body.copiloto_id ? await buscarTripulante(c, body.copiloto_id) : null
  if (!piloto) return c.json({ error: 'piloto_nao_encontrado' }, 400)
  if (body.copiloto_id && !copiloto) return c.json({ error: 'copiloto_nao_encontrado' }, 400)
  for (const assigned of [body.piloto_id, body.copiloto_id].filter((value): value is string => Boolean(value))) {
    const eligibility = await validarElegibilidadeTripulante(c, assigned, aeronaveId)
    if (eligibility) return c.json({ error: eligibility, tripulante_id: assigned }, 409)
  }

  const cotistaQuery = vooEmprestado
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
  const cotistaStatement = c.env.SHARE_DB.prepare(cotistaQuery)
  const cotista = vooEmprestado
    ? await cotistaStatement.bind(reservation.socio_id, reservation.cliente_id).first<{ codigo_cliente: string; socio_id: string | null }>()
    : await cotistaStatement.bind(reservation.socio_id, reservation.cliente_id, aeronaveId).first<{ codigo_cliente: string; socio_id: string | null }>()
  if (!cotista?.codigo_cliente?.trim()) {
    return c.json({
      error: 'codigo_cotista_nao_encontrado',
      detail: vooEmprestado
        ? 'Voo emprestado: nenhum codigo_cliente foi encontrado para o cotista tomador, independentemente da aeronave cedida.'
        : 'Nenhum registro em cotista_aeronave possui codigo_cliente para esta aeronave e este cliente/socio.',
      solicitacao_id: id,
      cliente_id: reservation.cliente_id,
      socio_id: reservation.socio_id,
      aeronave_id: aeronaveId,
      voo_emprestado: vooEmprestado,
    }, 409)
  }

  const cotistaKey = cotista.socio_id ? `socio:${cotista.socio_id}` : `cliente:${reservation.cliente_id}`
  const numeroVoo = vooEmprestado
    ? await portalLoanFlightSequence(c, cotista.codigo_cliente, aeronave.matricula_registro, cotistaKey)
    : await portalFlightSequence(c, cotista.codigo_cliente, cotistaKey)
  const aprovadoPor = extractSupabaseUserId(c)
  const result = await c.env.SHARE_DB.prepare("UPDATE solicitacoes_reserva_voo SET status = 'aprovada', numero_voo = ?, piloto_id = ?, copiloto_id = ?, aeronave_id = ?, cliente_emprestimo_id = ?, socio_emprestimo_id = ?, voo_emprestado = ?, data_agendada = ?, horario_previsto_agendamento = ?, dias_duracao = ?, numero_passageiros = ?, aprovado_por = ?, aprovado_em = CURRENT_TIMESTAMP, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pendente'")
    .bind(numeroVoo, piloto.id, copiloto?.id || null, aeronaveId, clienteEmprestimoId, socioEmprestimoId, vooEmprestado ? 'sim' : 'nao', dataAgendada, horarioPrevisto, diasDuracao, numeroPassageiros, aprovadoPor, id).run()
  if (!result.meta.changes) return c.json({ error: 'solicitacao_nao_pendente' }, 409)
  return c.json({ success: true, status: 'aprovada', solicitacao_id: id, numero_voo: numeroVoo, aeronave_id: aeronaveId, data_agendada: dataAgendada, horario_previsto_agendamento: horarioPrevisto, dias_duracao: diasDuracao, numero_passageiros: numeroPassageiros, voo_emprestado: vooEmprestado ? 'sim' : 'nao', piloto, copiloto, notification_sent: false })
})

app.post('/api/interno/solicitacoes/:id/reprovar', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<{ motivo_rejeicao?: string }>().catch(() => ({} as { motivo_rejeicao?: string }))
  if (!body.motivo_rejeicao?.trim()) return c.json({ error: 'motivo_rejeicao_obrigatorio' }, 400)
  const result = await c.env.SHARE_DB.prepare("UPDATE solicitacoes_reserva_voo SET status = 'reprovada', motivo_rejeicao = ?, aprovado_em = CURRENT_TIMESTAMP, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pendente'")
    .bind(body.motivo_rejeicao.trim(), c.req.param('id')).run()
  if (!result.meta.changes) return c.json({ error: 'solicitacao_nao_pendente' }, 409)
  return c.json({ success: true, status: 'reprovada', solicitacao_id: c.req.param('id') })
})

app.delete('/api/interno/agendamento/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaDisponibilidadeTripulacao(c)
  const id = c.req.param('id').trim()
  if (!id) return c.json({ error: 'agendamento_id_obrigatorio' }, 400)
  const db = c.env.SHARE_DB
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

async function garantirTabelaAbastecimentos(c: Context<{ Bindings: Bindings }>) {
  await validateWorkerSchema(c, [{
    table: 'abastecimentos',
    columns: ['id', 'cliente_id', 'socio_id', 'aeronave_id', 'data', 'tipo_combustivel', 'trecho', 'local', 'numero_comanda', 'numero_nf', 'litros', 'valor_unitario', 'valor_total', 'desconto', 'fornecedor_id', 'status', 'observacao', 'criado_por', 'lancamento_diario_id', 'voo_emprestado', 'numero_voo', 'prazo_envio_cliente', 'atualizado_em'],
  }])
}

async function garantirTabelaChecklist(c: Context<{ Bindings: Bindings }>) {
  await validateWorkerSchema(c, [{table:'checklists_pre_voo',columns:['id']}])
}

async function normalizarLocalAbastecimento(db: D1Database, valor: unknown): Promise<string | null> {
  const local = String(valor ?? '').trim()
  if (!local) return null
  const aerodromo = await db.prepare(
    'SELECT designativo_icao FROM aerodromo WHERE id = ?1 OR upper(trim(designativo_icao)) = upper(trim(?1)) LIMIT 1',
  ).bind(local).first<{ designativo_icao: string }>()
  return aerodromo?.designativo_icao?.trim().toUpperCase() || null
}

app.get('/api/interno/agendamento/:id/checklist', async c => {
  if (!(await requireFlightOperationAccess(c, c.req.param('id')))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  await garantirTabelaChecklist(c)
  const row = await c.env.SHARE_DB.prepare('SELECT id, solicitacao_id, respostas AS itens, observacoes, abastecimento_id, precisa_abastecer, status, executado_por AS usuario_id, executado_por_nome, nivel_oleo, alerta_id, concluido_em, atualizado_em FROM checklists_pre_voo WHERE solicitacao_id = ? ORDER BY criado_em DESC LIMIT 1').bind(c.req.param('id')).first<any>()
  if (!row) return c.json(null)
  const alertas = row.alerta_id ? await c.env.SHARE_DB.prepare('SELECT alerta1, alerta2, alerta3, alerta4, alerta5, alerta6, alerta7, alerta8, alerta9, alerta10 FROM alerta_checklist WHERE id = ?').bind(row.alerta_id).first<any>() : null
  const alertasMap = Object.fromEntries(Object.entries(alertas || {}).filter(([key, value]) => key.startsWith('alerta') && String(value || '').trim()).map(([key, value]) => [key.replace(/^alerta/, ''), String(value).trim()]))
  const abastecimento = row.abastecimento_id ? await c.env.SHARE_DB.prepare('SELECT id, data, tipo_combustivel, local, litros, valor_unitario, desconto, numero_comanda, numero_nf, trecho FROM abastecimentos WHERE id = ?1').bind(row.abastecimento_id).first<any>().catch(() => null) : null
  return c.json({
    ...row,
    itens: JSON.parse(row.itens || '{}'),
    alertas: alertasMap,
    abastecimento,
  })
})
app.post('/api/interno/agendamento/:id/checklist', async c => {
  if (!(await requireFlightOperationAccess(c, c.req.param('id')))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  await garantirTabelaChecklist(c); await garantirTabelaAbastecimentos(c)
  const idAgendamento = c.req.param('id')
  const agendamento = await c.env.SHARE_DB.prepare('SELECT * FROM solicitacoes_reserva_voo WHERE id = ?').bind(idAgendamento).first<any>()
  if (!agendamento) return c.notFound()
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as any))
  const status = body.status || 'concluido'
  if (!['rascunho', 'concluido'].includes(status)) return c.json({ error: 'status_checklist_invalido' }, 400)
  if (String(agendamento.status || '').trim().toLowerCase() !== 'aprovada') return c.json({ error: 'checklist_fora_da_preparacao', detail: 'A execução do checklist só pode ser alterada durante a preparação do voo.' }, 409)
  const userId = extractSupabaseUserId(c)
  const executor = userId ? await c.env.SHARE_DB.prepare('SELECT COALESCE(nome_exibicao, nome_completo, email) AS nome FROM user_profiles WHERE id=?').bind(userId).first<{ nome: string }>() : null
  const userName = executor?.nome || userId || 'Usuário não identificado'
  const existente = await c.env.SHARE_DB.prepare('SELECT id, abastecimento_id, alerta_id, status FROM checklists_pre_voo WHERE solicitacao_id = ? ORDER BY criado_em DESC LIMIT 1').bind(idAgendamento).first<{ id: string; abastecimento_id: string | null; alerta_id: string | null; status: string | null }>()
  if (existente?.id) {
    if (String(existente.status || '').trim().toLowerCase() === 'concluido') return c.json({ error: 'checklist_ja_concluido', detail: 'O checklist finalizado é somente para consulta.' }, 409)
  }
  const precisaAbastecer = body.abastecimento?.necessita_abastecer === true || body.abastecimento?.necessita_abastecer === 'sim'
  if (existente?.abastecimento_id && !precisaAbastecer) return c.json({ error: 'abastecimento_ja_vinculado', detail: 'O abastecimento vinculado permanece no fluxo financeiro; revise os dados sem desvinculá-lo do checklist.' }, 409)
  const alertas = Object.entries(body.alertas || {}).filter(([, texto]) => String(texto || '').trim()).map(([item, texto]) => `${item}: ${String(texto).trim()}`).slice(0, 10)
  if (status === 'concluido' && alertas.length < Object.values(body.respostas || body.itens || {}).filter((resposta: any) => resposta?.status === 'alerta').length) return c.json({ error: 'justificativa_alerta_obrigatoria', detail: 'Todo item marcado como alerta precisa de uma justificativa.' }, 400)
  const a = body.abastecimento || {}
  const localIcao = await normalizarLocalAbastecimento(c.env.SHARE_DB, a.local)
  if (status === 'concluido' && precisaAbastecer && (!a.data || !localIcao || !a.tipo_combustivel || Number(a.litros) <= 0 || Number(a.valor_unitario) < 0)) {
    return c.json({ error: 'abastecimento_incompleto', detail: 'Para concluir o checklist, preencha data, tipo de combustível, local, litros e valor unitário do abastecimento.' }, 400)
  }
  let abastecimentoId = precisaAbastecer ? existente?.abastecimento_id || null : null
  let abastecimentoCriado = false
  if (precisaAbastecer && a.data && localIcao && Number(a.litros) > 0) {
    let pagador = { cliente_id: a.cliente_id || agendamento.cliente_id || null, socio_id: a.socio_id || agendamento.socio_id || null }
    if (a.lancamento_diario_id) {
      const trecho = await c.env.SHARE_DB.prepare('SELECT cliente_id, socio_id FROM lancamentos_diario_bordo WHERE id = ?1 AND aeronave_id = ?2').bind(a.lancamento_diario_id, agendamento.aeronave_id).first<{ cliente_id: string | null; socio_id: string | null }>()
      if (!trecho) return c.json({ error: 'trecho_diario_invalido', detail: 'O último trecho informado não pertence à aeronave deste agendamento.' }, 400)
      pagador = { cliente_id: trecho.cliente_id, socio_id: trecho.socio_id }
    }
    const valores = [pagador.cliente_id, pagador.socio_id, agendamento.aeronave_id, a.data, a.tipo_combustivel, a.trecho || `${agendamento.origem} X ${agendamento.destino}`, localIcao, a.numero_comanda || null, a.numero_nf || null, Number(a.litros), Number(a.valor_unitario), Math.max(0, Number(a.litros) * Number(a.valor_unitario) - Number(a.desconto || 0)), Number(a.desconto || 0), a.fornecedor_id || null, 'gerado pré voo', null, userId, a.lancamento_diario_id || null, agendamento.voo_emprestado === 'sim' ? 1 : 0, agendamento.numero_voo || null, a.prazo_envio_cliente || null]
    const valoresInsert = [pagador.cliente_id, pagador.socio_id, agendamento.aeronave_id, a.data, a.tipo_combustivel, a.trecho || `${agendamento.origem} X ${agendamento.destino}`, localIcao, a.numero_comanda || null, a.numero_nf || null, Number(a.litros), Number(a.valor_unitario), Math.max(0, Number(a.litros) * Number(a.valor_unitario) - Number(a.desconto || 0)), Number(a.desconto || 0), a.fornecedor_id || null, 'gerado pré voo', null, userId, a.lancamento_diario_id || null, agendamento.voo_emprestado === 'sim' ? 1 : 0, agendamento.numero_voo || null, a.prazo_envio_cliente || null]
    if (abastecimentoId) {
      await c.env.SHARE_DB.prepare(`UPDATE abastecimentos SET cliente_id=?, socio_id=?, aeronave_id=?, data=?, tipo_combustivel=?, trecho=?, local=?, numero_comanda=?, numero_nf=?, litros=?, valor_unitario=?, valor_total=?, desconto=?, fornecedor_id=?, status=?, observacao=?, criado_por=?, lancamento_diario_id=?, voo_emprestado=?, numero_voo=?, prazo_envio_cliente=? WHERE id=?`).bind(...valores, abastecimentoId).run()
    } else {
      abastecimentoId = uuid()
      await c.env.SHARE_DB.prepare(`INSERT INTO abastecimentos (id, cliente_id, socio_id, aeronave_id, data, tipo_combustivel, trecho, local, numero_comanda, numero_nf, litros, valor_unitario, valor_total, desconto, fornecedor_id, status, observacao, criado_por, lancamento_diario_id, voo_emprestado, numero_voo, prazo_envio_cliente) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(abastecimentoId, ...valoresInsert).run()
      abastecimentoCriado = true
    }
  } else if (status === 'concluido' && precisaAbastecer) {
    return c.json({ error: 'abastecimento_incompleto', detail: 'Salve os dados do abastecimento antes de concluir o checklist.' }, 400)
  }
  const nivelOleo = body.nivel_oleo == null ? null : String(body.nivel_oleo).trim() || null
  const alertaId = alertas.length ? (existente?.alerta_id || uuid()) : null
  if (alertas.length) {
    const campos = alertas.map((_, index) => `alerta${index + 1}`).join(', ')
    const marks = alertas.map(() => '?').join(', ')
    if (existente?.alerta_id) await c.env.SHARE_DB.prepare(`UPDATE alerta_checklist SET ${alertas.map((_, index) => `alerta${index + 1} = ?`).join(', ')}, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`).bind(...alertas, alertaId).run()
    else await c.env.SHARE_DB.prepare(`INSERT INTO alerta_checklist (id, checklists_pre_voo_id, ${campos}) VALUES (?, ?, ${marks})`).bind(alertaId, existente?.id || null, ...alertas).run()
  }
  const precisaValor = precisaAbastecer ? 1 : 0
  const concluidoEm = status === 'concluido' ? new Date().toISOString() : null
  const checklistId = existente?.id || uuid()
  if (existente) {
    await c.env.SHARE_DB.prepare('UPDATE checklists_pre_voo SET executado_por=?, executado_por_nome=?, respostas=?, observacoes=?, abastecimento_id=?, precisa_abastecer=?, nivel_oleo=?, alerta_id=?, status=?, concluido_em=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').bind(userId, userName, JSON.stringify(body.itens || {}), body.observacoes || null, abastecimentoId, precisaValor, nivelOleo, alertaId, status, concluidoEm, existente.id).run()
  } else {
    if (alertaId) await c.env.SHARE_DB.prepare('UPDATE alerta_checklist SET checklists_pre_voo_id=? WHERE id=?').bind(checklistId, alertaId).run()
    await c.env.SHARE_DB.prepare('INSERT INTO checklists_pre_voo (id, solicitacao_id, aeronave_id, executado_por, executado_por_nome, respostas, observacoes, abastecimento_id, precisa_abastecer, nivel_oleo, alerta_id, status, concluido_em, numero_voo, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(checklistId, idAgendamento, agendamento.aeronave_id || null, userId, userName, JSON.stringify(body.itens || {}), body.observacoes || null, abastecimentoId, precisaValor, nivelOleo, alertaId, status, concluidoEm, agendamento.numero_voo || null, userId).run()
  }
  if (abastecimentoCriado && abastecimentoId) await notifyChecklistAbastecimento(c.env.SHARE_DB, abastecimentoId, userId, agendamento.numero_voo, localIcao).catch((error) => console.error('[checklist] falha ao notificar abastecimento criado', error))
  return c.json({ id: checklistId, solicitacao_id: idAgendamento, abastecimento_id: abastecimentoId }, existente ? 200 : 201)
})

// ─── Share Brasil: ponto, documentos, senhas e contatos ─────────────────────
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
function shareBrasilMonth(value: string | undefined): { inicio: string; fim: string } {
  const month = /^\d{4}-\d{2}$/.test(value || '') ? value! : new Date().toISOString().slice(0, 7)
  return { inicio: `${month}-01`, fim: `${month}-31` }
}

app.get('/api/sharebrasil/ponto', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const { inicio, fim } = shareBrasilMonth(c.req.query('mes'))
  const db = c.env.SHARE_DB
  const [lancamentos, anexos, justificativas, correcoes] = await Promise.all([
    db.prepare('SELECT * FROM lancamento_ponto WHERE user_id = ?1 AND date(data_entrada) BETWEEN ?2 AND ?3 ORDER BY data_entrada DESC').bind(user.id, inicio, fim).all(),
    db.prepare('SELECT * FROM lancamento_ponto_anexos WHERE user_id = ?1 AND date(data_entrada) BETWEEN ?2 AND ?3 ORDER BY criado_em DESC').bind(user.id, inicio, fim).all(),
    db.prepare('SELECT * FROM justificativa_ausencia WHERE id_usuario = ?1 AND date(data_registro) BETWEEN ?2 AND ?3 ORDER BY data_registro DESC').bind(user.id, inicio, fim).all(),
    db.prepare('SELECT * FROM solicitacoes_correcao_ponto WHERE user_id = ?1 AND date(data_entrada) BETWEEN ?2 AND ?3 ORDER BY data_entrada DESC, criado_em DESC').bind(user.id, inicio, fim).all(),
  ])
  return c.json({ mes: inicio.slice(0, 7), lancamentos: lancamentos.results, anexos: anexos.results.map((item: any) => ({ ...item, arquivo_url: `/api/sharebrasil/ponto/anexos/${item.id}/arquivo` })), justificativas: justificativas.results, correcoes: correcoes.results })
})

app.post('/api/sharebrasil/ponto/correcao', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ data_entrada?: string; lancamento_ponto_id?: string; tipo_correcao?: string; tempo_original?: string; tempo_corrigido?: string; justificativa?: string }>().catch(() => ({} as any))
  if (!body.data_entrada || !body.tipo_correcao || !body.tempo_corrigido || !body.justificativa?.trim()) return c.json({ error: 'campos_obrigatorios' }, 400)
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO solicitacoes_correcao_ponto (id, user_id, data_entrada, lancamento_ponto_id, tipo_correcao, tempo_original, tempo_corrigido, justificativa) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, user.id, body.data_entrada, body.lancamento_ponto_id || null, body.tipo_correcao, body.tempo_original || null, body.tempo_corrigido, body.justificativa.trim()).run()
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
    await c.env.SHARE_DB.prepare('INSERT INTO justificativa_ausencia (id, id_usuario, data_registro, justificativa, url_documento) VALUES (?, ?, ?, ?, ?)').bind(id, user.id, data, justificativa, key).run()
    if (key) {
      const lancamento = await c.env.SHARE_DB.prepare('SELECT id FROM lancamento_ponto WHERE user_id = ?1 AND data_entrada = ?2 LIMIT 1').bind(user.id, data).first<{ id: string }>()
      await c.env.SHARE_DB.prepare('INSERT INTO lancamento_ponto_anexos (id, lancamento_ponto_id, user_id, data_entrada, caminho_arquivo, nome_arquivo, tipo_arquivo, tipo_justificativa, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(uuid(), lancamento?.id || null, user.id, data, key, (fileValue as File).name, (fileValue as File).type || null, 'medical', justificativa).run()
    }
    return c.json({ id, status: 'pendente', url_documento: key }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_justificativa' }, 400)
  }
})

app.get('/api/sharebrasil/ponto/anexos/:id/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, nome_arquivo, tipo_arquivo FROM lancamento_ponto_anexos WHERE id = ?1 AND user_id = ?2').bind(c.req.param('id'), user.id).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string | null }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${shareBrasilFileName(row.nome_arquivo)}"` } })
})

app.get('/api/sharebrasil/documentos/pastas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare('SELECT * FROM pastas_documentos ORDER BY nome').all()
  return c.json(result.results)
})

app.post('/api/sharebrasil/documentos/pastas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ nome?: string; pasta_pai_id?: string }>().catch(() => ({} as any))
  if (!body.nome?.trim()) return c.json({ error: 'nome_obrigatorio' }, 400)
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO pastas_documentos (id, nome, pasta_pai_id, criado_por) VALUES (?, ?, ?, ?)').bind(id, body.nome.trim(), body.pasta_pai_id || null, user.id).run()
  return c.json({ id, nome: body.nome.trim(), pasta_pai_id: body.pasta_pai_id || null }, 201)
})

app.get('/api/sharebrasil/documentos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const pastaId = c.req.query('pasta_id') || null
  const result = pastaId ? await c.env.SHARE_DB.prepare('SELECT * FROM documentos_internos WHERE pasta_id = ?1 ORDER BY criado_em DESC').bind(pastaId).all() : await c.env.SHARE_DB.prepare('SELECT * FROM documentos_internos ORDER BY criado_em DESC').all()
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
    await c.env.SHARE_DB.prepare('INSERT INTO documentos_internos (id, pasta_id, nome, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, pastaId, file.name, key, file.type || 'application/octet-stream', file.size, user.id).run()
    const documento = await c.env.SHARE_DB.prepare('SELECT id, pasta_id, nome, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, criado_em FROM documentos_internos WHERE id = ?').bind(id).first()
    return c.json({ ...documento, arquivo_url: `/api/sharebrasil/documentos/${id}/arquivo` }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_documento' }, 400)
  }
})

app.get('/api/sharebrasil/documentos/:id/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, nome, tipo_arquivo FROM documentos_internos WHERE id = ?1').bind(c.req.param('id')).first<{ caminho_arquivo: string; nome: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo, 'Content-Disposition': `attachment; filename="${shareBrasilFileName(row.nome)}"` } })
})

app.get('/api/sharebrasil/senhas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare('SELECT id, titulo, site, login, observacoes, criado_por, criado_em, atualizado_em, setor FROM senhas ORDER BY titulo').all()
  return c.json(result.results)
})

app.get('/api/sharebrasil/senhas/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare('SELECT id, titulo, site, login, senha, observacoes, criado_por, criado_em, atualizado_em, setor FROM senhas WHERE id = ?1').bind(c.req.param('id')).first()
  if (!row) return c.notFound()
  return c.json(row)
})

app.post('/api/sharebrasil/senhas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ titulo?: string; site?: string; login?: string; senha?: string; observacoes?: string; setor?: string }>().catch(() => ({} as any))
  if (!body.titulo?.trim() || !body.site?.trim() || !body.login?.trim() || !body.senha) return c.json({ error: 'campos_obrigatorios' }, 400)
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO senhas (id, titulo, site, login, senha, observacoes, criado_por, setor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.titulo.trim(), body.site.trim(), body.login.trim(), body.senha, body.observacoes?.trim() || null, user.id, body.setor?.trim() || null).run()
  return c.json({ id, titulo: body.titulo.trim() }, 201)
})

app.patch('/api/sharebrasil/senhas/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ titulo?: string; site?: string; login?: string; senha?: string; observacoes?: string; setor?: string }>().catch(() => ({} as any))
  const result = await c.env.SHARE_DB.prepare('UPDATE senhas SET titulo = COALESCE(?, titulo), site = COALESCE(?, site), login = COALESCE(?, login), senha = COALESCE(?, senha), observacoes = ?, setor = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(body.titulo?.trim() || null, body.site?.trim() || null, body.login?.trim() || null, body.senha || null, body.observacoes?.trim() || null, body.setor?.trim() || null, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.delete('/api/sharebrasil/senhas/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare('DELETE FROM senhas WHERE id = ?1').bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.get('/api/sharebrasil/contatos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare('SELECT * FROM agenda_contatos ORDER BY nome').all()
  return c.json(result.results)
})

app.post('/api/sharebrasil/contatos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, string>>().catch(() => ({} as Record<string, string>))
  if (!body.nome?.trim()) return c.json({ error: 'nome_obrigatorio' }, 400)
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO agenda_contatos (id, nome, telefone, email, empresa, cargo, observacoes, endereco, uf, cidade, categoria) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.nome.trim(), body.telefone || null, body.email || null, body.empresa || null, body.cargo || null, body.observacoes || null, body.endereco || null, body.uf || null, body.cidade || null, body.categoria || null).run()
  return c.json({ id }, 201)
})

app.patch('/api/sharebrasil/contatos/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, string>>().catch(() => ({} as Record<string, string>))
  const result = await c.env.SHARE_DB.prepare('UPDATE agenda_contatos SET nome = COALESCE(?, nome), telefone = ?, email = ?, empresa = ?, cargo = ?, observacoes = ?, endereco = ?, uf = ?, cidade = ?, categoria = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(body.nome?.trim() || null, body.telefone || null, body.email || null, body.empresa || null, body.cargo || null, body.observacoes || null, body.endereco || null, body.uf || null, body.cidade || null, body.categoria || null, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.delete('/api/sharebrasil/contatos/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare('DELETE FROM agenda_contatos WHERE id = ?1').bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

async function garantirForeignKeyCotistas(c: Context<{ Bindings: Bindings }>) {
  await validateWorkerSchema(c, [{table:'hold_socios',columns:['id','holding_id']}])
}
app.get('/api/sharebrasil/clientes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
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
  return c.json({ clientes: clientes.results, holdings: holdings.results, socios: socios.results, vinculos: vinculos.results, aeronaves: aeronave.results, documentos: documentos.results.map((item: any) => ({ ...item, arquivo_url: `/api/sharebrasil/clientes/documentos/${item.id}/arquivo` })), documentos_socios: documentosSocios.results.map((item: any) => ({ ...item, arquivo_url: `/api/sharebrasil/socios/documentos/${item.id}/arquivo` })) })
})

app.post('/api/sharebrasil/holdings', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const nome = String(body.nome || '').trim()
  if (!nome) return c.json({ error: 'nome_holding_obrigatorio' }, 400)
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO holdings (id, nome, conta_bancaria, ativo) VALUES (?, ?, ?, 1)').bind(id, nome, body.conta_bancaria || null).run()
  return c.json({ id, nome }, 201)
})
app.post('/api/sharebrasil/holdings/:id/socios', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const nome = String(body.nome || '').trim(); const cpf = String(body.cpf || '').trim()
  if (!nome || !cpf) return c.json({ error: 'nome_e_cpf_obrigatorios' }, 400)
  const holding = await c.env.SHARE_DB.prepare('SELECT id FROM holdings WHERE id = ?1 AND ativo = 1').bind(c.req.param('id')).first()
  if (!holding) return c.notFound()
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO hold_socios (id, cotista_id, nome, cpf, email_principal, emails, endereco, cidade, uf, contato_financeiro, telefone_financeiro, telefone, observacoes, holding_id) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, nome, cpf, body.email_principal || null, JSON.stringify(body.emails || []), body.endereco || null, body.cidade || null, body.uf || null, body.contato_financeiro || null, body.telefone_financeiro || null, body.telefone || null, body.observacoes || null, c.req.param('id')).run()
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
  await c.env.SHARE_DB.prepare('INSERT INTO cotista_aeronave (id, socio_id, aeronave_id, percentual_sociedade) VALUES (?, ?, ?, ?)').bind(id, c.req.param('id'), body.aeronave_id, percentual).run()
  return c.json({ id }, 201)
})
app.post('/api/sharebrasil/clientes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  if (!body.razao_social?.trim()) return c.json({ error: 'razao_social_obrigatoria' }, 400)
  const aeronaveId = body.aeronave_id ? String(body.aeronave_id).trim() : null
  const percentual = body.percentual_sociedade == null || body.percentual_sociedade === ''
    ? 100
    : Number(body.percentual_sociedade)
  if (aeronaveId && (!Number.isFinite(percentual) || percentual < 0 || percentual > 100)) return c.json({ error: 'percentual_invalido' }, 400)
  if (aeronaveId) {
    const aeronave = await c.env.SHARE_DB.prepare('SELECT id FROM aeronave WHERE id = ?1 AND status <> ?2').bind(aeronaveId, 'inativa').first()
    if (!aeronave) return c.json({ error: 'aeronave_nao_encontrada' }, 400)
  }
  const id = uuid()
  const statements = [
    c.env.SHARE_DB.prepare('INSERT INTO cliente (id, razao_social, cnpj, inscricao_estadual, proprietario, endereco, cidade, uf, contato_financeiro, telefone_financeiro, telefone_cliente, telefone_outro, email_principal, emails, status, holding, codigo_cliente, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.razao_social.trim(), body.cnpj || null, body.inscricao_estadual || null, body.proprietario || null, body.endereco || null, body.cidade || null, body.uf || null, body.contato_financeiro || null, body.telefone_financeiro || null, body.telefone_cliente || null, body.telefone_outro || null, body.email_principal || null, JSON.stringify(body.emails || []), body.status || 'ativo', body.holding ? 1 : 0, body.codigo_cliente || null, body.observacoes || null),
  ]
  if (aeronaveId) statements.push(c.env.SHARE_DB.prepare('INSERT INTO cotista_aeronave (id, cliente_id, aeronave_id, percentual_sociedade, codigo_cliente, status) VALUES (?, ?, ?, ?, ?, ?)').bind(uuid(), id, aeronaveId, percentual, body.codigo_cliente || null, 'ativo'))
  await c.env.SHARE_DB.batch(statements)
  return c.json({ id, aeronave_id: aeronaveId, percentual_sociedade: aeronaveId ? percentual : null }, 201)
})

app.patch('/api/sharebrasil/clientes/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const fields = ['razao_social','cnpj','inscricao_estadual','proprietario','endereco','cidade','uf','contato_financeiro','telefone_financeiro','telefone_cliente','telefone_outro','email_principal','status','codigo_cliente','observacoes']
  const values = fields.map((field) => body[field] ?? null)
  const result = await c.env.SHARE_DB.prepare(`UPDATE cliente SET ${fields.map((field) => `${field} = COALESCE(?, ${field})`).join(', ')}, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(...values, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  if (body.status !== undefined) await c.env.SHARE_DB.prepare('UPDATE cotista_aeronave SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE cliente_id = ?').bind(body.status === 'inativo' ? 'inativo' : 'ativo', c.req.param('id')).run()
  return c.json({ success: true })
})

app.patch('/api/sharebrasil/socios/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const fields = ['nome', 'cpf', 'email_principal', 'telefone', 'endereco', 'cidade', 'uf', 'observacoes']
  const provided = fields.filter((field) => body[field] !== undefined)
  if (!provided.length && body.status === undefined) return c.json({ error: 'nenhum_campo_informado' }, 400)
  const values = provided.map((field) => body[field] ?? null)
  const result = provided.length
    ? await c.env.SHARE_DB.prepare(`UPDATE hold_socios SET ${provided.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`).bind(...values, c.req.param('id')).run()
    : await c.env.SHARE_DB.prepare('SELECT id FROM hold_socios WHERE id = ?').bind(c.req.param('id')).first()
  if (!result || (provided.length && Number((result as any).meta?.changes || 0) === 0)) return c.notFound()
  if (body.status !== undefined) await c.env.SHARE_DB.prepare('UPDATE cotista_aeronave SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE socio_id = ?').bind(body.status === 'inativo' ? 'inativo' : 'ativo', c.req.param('id')).run()
  return c.json({ success: true })
})
app.post('/api/sharebrasil/clientes/:id/aeronave', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ aeronave_id?: string; percentual_sociedade?: number; codigo_cliente?: string }>().catch(() => ({} as any))
  if (!body.aeronave_id) return c.json({ error: 'aeronave_obrigatoria' }, 400)
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO cotista_aeronave (id, cliente_id, aeronave_id, percentual_sociedade, codigo_cliente, status) VALUES (?, ?, ?, ?, ?, ?)').bind(id, c.req.param('id'), body.aeronave_id, Number(body.percentual_sociedade || 100), body.codigo_cliente || null, 'ativo').run()
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
    await c.env.SHARE_DB.prepare('UPDATE cliente SET url_logo = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(key, c.req.param('id')).run()
    return c.json({ url_logo: `/api/sharebrasil/clientes/${c.req.param('id')}/logo/arquivo` })
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_logo' }, 400)
  }
})

app.get('/api/sharebrasil/clientes/:id/logo/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare('SELECT url_logo FROM cliente WHERE id = ?1').bind(c.req.param('id')).first<{ url_logo: string | null }>()
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
    await c.env.SHARE_DB.prepare('INSERT INTO documentos_cliente (id, cliente_id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, categoria) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, c.req.param('id'), file.name, key, file.type || 'application/octet-stream', file.size, user.id, categoria).run()
    return c.json({ id, arquivo_url: `/api/sharebrasil/clientes/documentos/${id}/arquivo` }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_documento_cliente' }, 400)
  }
})

app.get('/api/sharebrasil/clientes/documentos/:id/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, nome_arquivo, tipo_arquivo FROM documentos_cliente WHERE id = ?1').bind(c.req.param('id')).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo, 'Content-Disposition': `attachment; filename="${shareBrasilFileName(row.nome_arquivo)}"` } })
})



app.post('/api/sharebrasil/socios/:id/documentos', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
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
  const row = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, nome_arquivo, tipo_arquivo FROM documentos_socio WHERE id = ?1').bind(c.req.param('id')).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo, 'Content-Disposition': `attachment; filename="${shareBrasilFileName(row.nome_arquivo)}"` } })
})
// ─── Share Brasil: tarefas, notificações e calendário ─────────────────────────
async function isMeetingManager(c: Context<{ Bindings: Bindings }>, user: Colaborador): Promise<boolean> {
  if (isTaskManager(user)) return true
  const result = await c.env.SHARE_DB.prepare("SELECT 1 FROM usuarios_funcoes WHERE user_id = ?1 AND lower(replace(replace(funcao, ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster') LIMIT 1").bind(user.id).first()
  return Boolean(result)
}

type AniversarioPayload = { nome: string; data_aniversario: string; empresa: string | null; categoria: string; url_avatar: string | null }
const CATEGORIAS_ANIVERSARIO = new Set(['cliente', 'colaborador', 'fornecedor', 'hotel'])
function validarAniversarioPayload(body: Record<string, unknown>): { payload?: AniversarioPayload; error?: string } {
  const nome = String(body.nome || '').trim()
  if (!nome || nome.length > 160) return { error: 'nome_obrigatorio_ou_invalido' }
  const data = String(body.data_aniversario || '').trim().slice(0, 10)
  const partesData = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data)
  if (!partesData) return { error: 'data_aniversario_invalida' }
  const [ano, mes, dia] = partesData.slice(1).map(Number)
  const dataValidada = new Date(Date.UTC(ano, mes - 1, dia))
  if (dataValidada.getUTCFullYear() !== ano || dataValidada.getUTCMonth() !== mes - 1 || dataValidada.getUTCDate() !== dia) return { error: 'data_aniversario_invalida' }
  const categoria = String(body.categoria || 'cliente').trim().toLowerCase()
  if (!CATEGORIAS_ANIVERSARIO.has(categoria)) return { error: 'categoria_invalida' }
  const empresaValor = String(body.empresa || '').trim()
  if (empresaValor.length > 160) return { error: 'empresa_invalida' }
  const avatarValor = String(body.url_avatar || '').trim()
  let url_avatar: string | null = null
  if (avatarValor) {
    try {
      const url = new URL(avatarValor)
      if (!['http:', 'https:'].includes(url.protocol) || avatarValor.length > 500) return { error: 'url_avatar_invalida' }
      url_avatar = url.toString()
    } catch {
      return { error: 'url_avatar_invalida' }
    }
  }
  return { payload: { nome, data_aniversario: data, empresa: empresaValor || null, categoria, url_avatar } }
}

app.get('/api/interno/aniversarios', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const db = c.env.SHARE_DB
  const [manuais, perfis] = await Promise.all([
    db.prepare("SELECT id, nome, data_aniversario, empresa, categoria, url_avatar, criado_em, atualizado_em, 'aniversarios' AS origem FROM aniversarios ORDER BY nome COLLATE NOCASE").all(),
    db.prepare("SELECT 'user_profiles:' || id AS id, COALESCE(NULLIF(trim(nome_exibicao), ''), NULLIF(trim(nome_completo), ''), email) AS nome, data_nascimento AS data_aniversario, departamento AS empresa, 'colaborador' AS categoria, url_avatar, data_criacao AS criado_em, data_atualizacao AS atualizado_em, 'user_profiles' AS origem FROM user_profiles WHERE data_nascimento IS NOT NULL AND trim(data_nascimento) <> '' ORDER BY COALESCE(NULLIF(trim(nome_exibicao), ''), NULLIF(trim(nome_completo), ''), email) COLLATE NOCASE").all(),
  ])
  return c.json({ aniversarios: [...(perfis.results || []), ...(manuais.results || [])] })
})

app.post('/api/interno/aniversarios', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const validacao = validarAniversarioPayload(body)
  if (!validacao.payload) return c.json({ error: validacao.error || 'aniversario_invalido' }, 400)
  const id = uuid()
  const item = validacao.payload
  await c.env.SHARE_DB.prepare('INSERT INTO aniversarios (id, nome, data_aniversario, empresa, categoria, url_avatar) VALUES (?, ?, ?, ?, ?, ?)').bind(id, item.nome, item.data_aniversario, item.empresa, item.categoria, item.url_avatar).run()
  return c.json({ aniversario: { id, ...item, origem: 'aniversarios' } }, 201)
})

const atualizarAniversario = async (c: Context<{ Bindings: Bindings }>) => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const validacao = validarAniversarioPayload(body)
  if (!validacao.payload) return c.json({ error: validacao.error || 'aniversario_invalido' }, 400)
  const item = validacao.payload
  const result = await c.env.SHARE_DB.prepare('UPDATE aniversarios SET nome = ?, data_aniversario = ?, empresa = ?, categoria = ?, url_avatar = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(item.nome, item.data_aniversario, item.empresa, item.categoria, item.url_avatar, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ aniversario: { id: c.req.param('id'), ...item, origem: 'aniversarios' }, success: true })
}
app.patch('/api/interno/aniversarios/:id', atualizarAniversario)
app.put('/api/interno/aniversarios/:id', atualizarAniversario)
app.delete('/api/interno/aniversarios/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const result = await c.env.SHARE_DB.prepare('DELETE FROM aniversarios WHERE id = ?1').bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.get('/api/interno/aerodromos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const q = (c.req.query('q') || '').trim(); const termo = `%${q}%`
  const rows = await c.env.SHARE_DB.prepare("SELECT id, nome, designativo_icao, coordenadas FROM aerodromo WHERE (?1 = '%%' OR upper(designativo_icao) LIKE upper(?1) OR upper(nome) LIKE upper(?1)) ORDER BY designativo_icao").bind(termo).all()
  return c.json({ aerodromos: rows.results })
})
type AerodromoPayload = { nome?: string; designativo_icao?: string; coordenadas?: string | null }
const HEMISFERIOS_NEGATIVOS = new Set(['S', 'W'])
function coordenadaDMSParaDecimal(valor: string) {
  const original = valor.trim()
  if (!original) return original
  const partes = original.replace(/[º°]/g, ' ').replace(/[′']/g, ' ').replace(/[″\"]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().split(' ').filter(Boolean)
  const hemisferio = partes.find(parte => /^[NSEW]$/.test(parte))
  const numeros = partes.filter(parte => !/^[NSEW]$/.test(parte))
  if (!hemisferio || numeros.length < 1 || numeros.length > 3 || numeros.some(parte => Number.isNaN(Number(parte)))) return original
  const graus = Math.abs(Number(numeros[0])); const minutos = numeros.length > 1 ? Number(numeros[1]) : 0; const segundos = numeros.length > 2 ? Number(numeros[2]) : 0
  if (minutos < 0 || minutos >= 60 || segundos < 0 || segundos >= 60) return original
  const decimal = graus + minutos / 60 + segundos / 3600
  return (HEMISFERIOS_NEGATIVOS.has(hemisferio) ? -decimal : decimal).toFixed(8)
}
function normalizarCoordenadas(valor: string) {
  const partes = valor.split(',')
  return partes.length === 2 ? partes.map(coordenadaDMSParaDecimal).join(',') : coordenadaDMSParaDecimal(valor)
}
function validarAerodromo(body: AerodromoPayload) {
  const nome = String(body.nome || '').trim()
  const icao = String(body.designativo_icao || '').trim().toUpperCase()
  const coordenadas = typeof body.coordenadas === 'string' && body.coordenadas.trim() ? normalizarCoordenadas(body.coordenadas) : null
  return { nome, icao, coordenadas }
}
async function autorizarGestaoAerodromo(c: Context<{ Bindings: Bindings }>) {
  const user = await shareBrasilUser(c)
  return user && await isColaboradorManager(c, user)
}
app.post('/api/interno/aerodromos', async c => {
  if (!(await requireAuthenticatedUser(c))) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<AerodromoPayload>().catch(() => ({} as AerodromoPayload)); const { nome, icao, coordenadas } = validarAerodromo(body)
  if (!nome || !/^[A-Z0-9]{4}$/.test(icao)) return c.json({ error: 'nome_e_icao_obrigatorios' }, 400)
  const id = uuid()
  try {
    await c.env.SHARE_DB.prepare('INSERT INTO aerodromo (id, nome, designativo_icao, coordenadas) VALUES (?, ?, ?, ?)').bind(id, nome, icao, coordenadas).run()
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) return c.json({ error: 'designativo_icao_ja_cadastrado' }, 409)
    throw error
  }
  return c.json({ id, nome, designativo_icao: icao, coordenadas }, 201)
})
const atualizarAerodromo = async (c: Context<{ Bindings: Bindings }>) => {
  if (!(await autorizarGestaoAerodromo(c))) return c.json({ error: 'permissao_necessaria' }, 403)
  const body = await c.req.json<AerodromoPayload>().catch(() => ({} as AerodromoPayload)); const { nome, icao, coordenadas } = validarAerodromo(body)
  if (!nome || !/^[A-Z0-9]{4}$/.test(icao)) return c.json({ error: 'nome_e_icao_obrigatorios' }, 400)
  try {
    const result = await c.env.SHARE_DB.prepare('UPDATE aerodromo SET nome = ?, designativo_icao = ?, coordenadas = ? WHERE id = ?').bind(nome, icao, coordenadas, c.req.param('id')).run()
    if (!result.meta.changes) return c.notFound()
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) return c.json({ error: 'designativo_icao_ja_cadastrado' }, 409)
    throw error
  }
  return c.json({ id: c.req.param('id'), nome, designativo_icao: icao, coordenadas, success: true })
}
app.patch('/api/interno/aerodromos/:id', atualizarAerodromo)
app.put('/api/interno/aerodromos/:id', atualizarAerodromo)
app.delete('/api/interno/aerodromos/:id', async c => {
  if (!(await autorizarGestaoAerodromo(c))) return c.json({ error: 'permissao_necessaria' }, 403)
  const result = await c.env.SHARE_DB.prepare('DELETE FROM aerodromo WHERE id = ?').bind(c.req.param('id')).run(); if (!result.meta.changes) return c.notFound(); return c.json({ success: true })
})

function funcoesColaborador(row: Record<string, any>) {
  const funcoes = String(row.funcoes_raw || '').split(',').map(item => item.trim()).filter(Boolean)
  const { funcoes_raw: _funcoesRaw, ...colaborador } = row
  return { ...colaborador, funcoes }
}
async function sincronizarTripulacaoColaborador(c: Context<{ Bindings: Bindings }>, userId: string, body: Record<string, any> = {}) {
  const db = c.env.SHARE_DB
  const perfil = await db.prepare('SELECT id, nome_completo, canac, status, departamento FROM user_profiles WHERE id = ?1').bind(userId).first<any>()
  if (!perfil) return
  const funcao = String(body.funcao || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const departamento = String(body.departamento || body.departamentos_email || perfil.departamento || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const funcaoAtual = await db.prepare("SELECT funcao FROM usuarios_funcoes WHERE user_id = ?1 ORDER BY criado_em DESC LIMIT 1").bind(userId).first<{ funcao: string }>().catch(() => null)
  const existente = await db.prepare('SELECT id FROM tripulacao WHERE user_id = ?1').bind(userId).first<{ id: string }>()
  const ehTripulante = Boolean(existente) || [funcao, departamento, String(funcaoAtual?.funcao || '').trim().toLowerCase().replace(/[\s-]+/g, '_')].includes('tripulante')
  if (!ehTripulante) {
    if (existente) await db.prepare("UPDATE tripulacao SET status = 'inativo' WHERE id = ?1").bind(existente.id).run()
    return
  }
  const canac = String(body.canac ?? perfil.canac ?? '').trim()
  if (!canac) throw new Error('canac_obrigatorio_para_tripulante')
  const status = String(body.status ?? perfil.status ?? 'ativo').trim().toLowerCase() === 'inativo' ? 'inativo' : 'ativo'
  if (existente) {
    await db.prepare('UPDATE tripulacao SET canac = ?, nome_completo = ?, status = ? WHERE id = ?').bind(canac, perfil.nome_completo, status, existente.id).run()
  } else {
    await db.prepare('INSERT INTO tripulacao (id, user_id, canac, nome_completo, status) VALUES (?, ?, ?, ?, ?)').bind(uuid(), userId, canac, perfil.nome_completo, status).run()
  }
}

app.get('/api/gestor/gestao-colaborador', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const result = await c.env.SHARE_DB.prepare("SELECT p.id, p.email, p.nome_completo, p.nome_exibicao, p.telefone, p.cidade, p.uf, p.data_nascimento, p.data_admissao, p.cpf, p.rg, p.canac, p.status, p.tipo_user, p.departamento, p.departamentos_email, p.exame_admissional_realizado, p.exame_admissional_data, p.exame_admissional_local, p.exame_admissional_empresa, p.exame_admissional_prazo, p.exame_admissional_documento_id, p.data_criacao, p.data_atualizacao, GROUP_CONCAT(uf.funcao) AS funcoes_raw FROM user_profiles p LEFT JOIN usuarios_funcoes uf ON uf.user_id = p.id WHERE lower(COALESCE(p.tipo_user, 'colaborador')) = 'colaborador' GROUP BY p.id ORDER BY COALESCE(p.nome_exibicao, p.nome_completo), p.email").all<Record<string, any>>()
  return c.json(result.results.map(funcoesColaborador))
})

app.post('/api/gestor/gestao-colaborador', async c => {
  const creator = await shareBrasilUser(c)
  if (!creator || !await isColaboradorManager(c, creator)) return c.json({ error: 'permissao_necessaria' }, 403)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const email = String(body.email || '').trim().toLowerCase()
  const senha = String(body.senha || '')
  const nome = String(body.nome_completo || '').trim()
  const departamento = String(body.departamentos_email || body.departamento || '').trim()
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || senha.length < 6 || !nome) return c.json({ error: 'nome_email_e_senha_validos_sao_obrigatorios' }, 400)
  if (body.exame_admissional_realizado && (!String(body.exame_admissional_data || '').trim() || !String(body.exame_admissional_local || '').trim() || !String(body.exame_admissional_empresa || '').trim())) return c.json({ error: 'dados_do_exame_admissional_obrigatorios' }, 400)
  if (!body.exame_admissional_realizado && !String(body.exame_admissional_prazo || '').trim()) return c.json({ error: 'prazo_do_exame_admissional_obrigatorio' }, 400)
  const emailEnvio = await gerarEmailEnvioColaborador(c, nome)
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_ROLE_KEY) return c.json({ error: 'supabase_admin_nao_configurado' }, 503)
  const authResponse = await fetch(`${c.env.SUPABASE_URL}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: c.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senha, email_confirm: true, user_metadata: { nome_completo: nome, tipo_user: 'colaborador' } }) })
  const authData = await authResponse.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  if (!authResponse.ok || !authData.id) return c.json({ error: authData.msg || authData.message || 'nao_foi_possivel_criar_usuario_supabase' }, authResponse.status === 422 ? 409 : 502)
  const id = String(authData.id)
  try {
    const db = c.env.SHARE_DB
    await db.batch([
      db.prepare(`INSERT INTO user_profiles (id, email, email_envio, nome_completo, nome_exibicao, telefone, cidade, uf, data_nascimento, data_admissao, cpf, rg, canac, status, tipo_user, departamento, departamentos_email, exame_admissional_realizado, exame_admissional_data, exame_admissional_local, exame_admissional_empresa, exame_admissional_prazo, exame_admissional_documento_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, email, emailEnvio, nome, body.nome_exibicao || nome, body.telefone || null, body.cidade || null, body.uf || null, body.data_nascimento || null, body.data_admissao || null, body.cpf || null, body.rg || null, body.canac || null, 'ativo', 'colaborador', departamento || null, departamento || null, body.exame_admissional_realizado ? 1 : 0, body.exame_admissional_data || null, body.exame_admissional_local || null, body.exame_admissional_empresa || null, body.exame_admissional_prazo || null, body.exame_admissional_documento_id || null),
      db.prepare('INSERT INTO usuarios_funcoes (id, user_id, funcao) VALUES (?, ?, ?)').bind(uuid(), id, String(departamento || body.funcao || 'colaborador').trim().toLowerCase().replace(/[\s-]+/g, '_')),
      db.prepare('INSERT INTO assinaturas_email (id, usuario_id, nome, cargo, telefone, endereco, email) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(uuid(), id, nome, body.cargo || departamento || null, body.telefone || null, null, emailEnvio),
    ])
    await sincronizarTripulacaoColaborador(c, id, { ...body, departamento })
  } catch (error) {
    await c.env.SHARE_DB.prepare('DELETE FROM usuarios_funcoes WHERE user_id = ?1').bind(id).run().catch(() => undefined)
    await c.env.SHARE_DB.prepare('DELETE FROM user_profiles WHERE id = ?1').bind(id).run().catch(() => undefined)
    await fetch(`${c.env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { apikey: c.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}` } }).catch(() => undefined)
    log.error('[gestao-colaborador] falha ao inserir perfil ou função D1:', error)
    return c.json({ error: 'usuario_criado_no_supabase_mas_falha_ao_salvar_perfil_d1' }, 500)
  }
  return c.json(await c.env.SHARE_DB.prepare('SELECT id, email, nome_completo, nome_exibicao, telefone, cidade, uf, data_nascimento, data_admissao, cpf, rg, canac, status, tipo_user, departamento, departamentos_email, exame_admissional_realizado, exame_admissional_data, exame_admissional_local, exame_admissional_empresa, exame_admissional_prazo, exame_admissional_documento_id, data_criacao, data_atualizacao FROM user_profiles WHERE id = ?1').bind(id).first(), 201)
})

app.patch('/api/gestor/gestao-colaborador/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const id = c.req.param('id'); const current = await c.env.SHARE_DB.prepare('SELECT id FROM user_profiles WHERE id = ?1 AND lower(COALESCE(tipo_user, \'colaborador\')) = \'colaborador\'').bind(id).first()
  if (!current) return c.notFound()
  const fields = ['nome_completo', 'nome_exibicao', 'telefone', 'cidade', 'uf', 'data_nascimento', 'data_admissao', 'cpf', 'rg', 'canac', 'departamento', 'departamentos_email', 'status', 'exame_admissional_realizado', 'exame_admissional_data', 'exame_admissional_local', 'exame_admissional_empresa', 'exame_admissional_prazo', 'exame_admissional_documento_id']
  const updates = fields.filter(field => body[field] !== undefined)
  if (body.exame_admissional_realizado !== undefined) body.exame_admissional_realizado = body.exame_admissional_realizado ? 1 : 0
  if (body.exame_admissional_realizado && (!String(body.exame_admissional_data || '').trim() || !String(body.exame_admissional_local || '').trim() || !String(body.exame_admissional_empresa || '').trim())) return c.json({ error: 'dados_do_exame_admissional_obrigatorios' }, 400)
  if (!body.exame_admissional_realizado && body.exame_admissional_prazo !== undefined && !String(body.exame_admissional_prazo || '').trim()) return c.json({ error: 'prazo_do_exame_admissional_obrigatorio' }, 400)
  if (!updates.length) return c.json({ error: 'nenhum_campo_informado' }, 400)
  await c.env.SHARE_DB.prepare(`UPDATE user_profiles SET ${updates.map(field => `${field} = ?`).join(', ')}, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?`).bind(...updates.map(field => body[field] || null), id).run()
  await sincronizarTripulacaoColaborador(c, id, body)
  return c.json(await c.env.SHARE_DB.prepare('SELECT * FROM user_profiles WHERE id = ?1').bind(id).first())
})

app.post('/api/gestor/gestao-colaborador/:id/documentos', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const userId = c.req.param('id')
  const colaborador = await c.env.SHARE_DB.prepare("SELECT id FROM user_profiles WHERE id = ?1 AND lower(COALESCE(tipo_user, 'colaborador')) = 'colaborador'").bind(userId).first()
  if (!colaborador) return c.notFound()
  const formData = await c.req.formData()
  const fileValue = formData.get('arquivo') as unknown
  const categoria = String(formData.get('categoria') || 'documentos').trim() || 'documentos'
  if (!fileValue || typeof fileValue !== 'object' || !('type' in fileValue)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const file = fileValue as File
  if (!TIPOS_DOCUMENTO_COLABORADOR.has(file.type)) return c.json({ error: 'tipo_de_arquivo_nao_permitido' }, 415)
  try {
    const caminho = await salvarArquivoColaborador(c, userId, file, 'documentos_colaboradores')
    const id = uuid()
    const nomeArquivo = String(formData.get('nome_arquivo') || file.name).trim() || file.name
    await c.env.SHARE_DB.prepare('INSERT INTO documentos_usuarios (id, user_id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, categoria) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, userId, nomeArquivo, caminho, file.type, file.size, user.id, categoria).run()
    return c.json({ id, user_id: userId, nome_arquivo: nomeArquivo, caminho_arquivo: caminho, tipo_arquivo: file.type, tamanho_arquivo: file.size, categoria, arquivo_url: `/api/gestor/gestao-colaborador/${userId}/documentos/${id}/arquivo` }, 201)
  } catch (error: any) {
    return c.json({ error: error?.message || 'falha_ao_salvar_documento' }, 400)
  }
})
app.get('/api/gestor/gestao-colaborador/:id/documentos/:documentoId/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const row = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, tipo_arquivo, nome_arquivo FROM documentos_usuarios WHERE id = ?1 AND user_id = ?2').bind(c.req.param('documentoId'), c.req.param('id')).first<{ caminho_arquivo: string; tipo_arquivo: string; nome_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await bucketParaChaveColaborador(c, row.caminho_arquivo).get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo, 'Content-Disposition': `inline; filename="${shareBrasilFileName(row.nome_arquivo)}"` } })
})
app.patch('/api/gestor/gestao-colaborador/:id/documentos/:documentoId', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const userId = c.req.param('id'); const documentoId = c.req.param('documentoId'); const db = c.env.SHARE_DB
  const row = await db.prepare('SELECT * FROM documentos_usuarios WHERE id = ?1 AND user_id = ?2').bind(documentoId, userId).first<any>()
  if (!row) return c.notFound()
  const formData = await c.req.formData(); const fileValue = formData.get('arquivo') as unknown
  const categoria = formData.has('categoria') ? String(formData.get('categoria') || '').trim() || 'documentos' : row.categoria
  let nome = String(formData.get('nome_arquivo') || row.nome_arquivo).trim() || row.nome_arquivo
  let caminho = row.caminho_arquivo; let tipo = row.tipo_arquivo; let tamanho = row.tamanho_arquivo
  let salvoNoD1 = false
  try {
    if (fileValue && typeof fileValue === 'object' && 'type' in fileValue) {
      const file = fileValue as File
      if (!TIPOS_DOCUMENTO_COLABORADOR.has(file.type)) return c.json({ error: 'tipo_de_arquivo_nao_permitido' }, 415)
      caminho = await salvarArquivoColaborador(c, userId, file, 'documentos_colaboradores'); nome = String(formData.get('nome_arquivo') || file.name).trim() || file.name; tipo = file.type; tamanho = file.size
    }
    await db.prepare('UPDATE documentos_usuarios SET nome_arquivo = ?, caminho_arquivo = ?, tipo_arquivo = ?, tamanho_arquivo = ?, categoria = ? WHERE id = ? AND user_id = ?').bind(nome, caminho, tipo, tamanho, categoria, documentoId, userId).run()
    salvoNoD1 = true
    if (caminho !== row.caminho_arquivo) await bucketParaChaveColaborador(c, row.caminho_arquivo).delete(row.caminho_arquivo).catch(() => undefined)
    return c.json(await db.prepare('SELECT id, user_id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, criado_em, categoria FROM documentos_usuarios WHERE id = ?').bind(documentoId).first())
  } catch (error: any) {
    if (caminho !== row.caminho_arquivo && !salvoNoD1) await bucketParaChaveColaborador(c, caminho).delete(caminho).catch(() => undefined)
    return c.json({ error: error?.message || 'falha_ao_atualizar_documento' }, 400)
  }
})
app.delete('/api/gestor/gestao-colaborador/:id/documentos/:documentoId', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const userId = c.req.param('id'); const documentoId = c.req.param('documentoId'); const db = c.env.SHARE_DB
  const row = await db.prepare('SELECT caminho_arquivo FROM documentos_usuarios WHERE id = ?1 AND user_id = ?2').bind(documentoId, userId).first<{ caminho_arquivo: string }>()
  if (!row) return c.notFound()
  await db.prepare('DELETE FROM documentos_usuarios WHERE id = ?1 AND user_id = ?2').bind(documentoId, userId).run()
  await bucketParaChaveColaborador(c, row.caminho_arquivo).delete(row.caminho_arquivo).catch(() => undefined)
  return c.json({ success: true, id: documentoId })
})
app.get('/api/gestor/gestao-colaborador/:id/ficha', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const id = c.req.param('id')
  const db = c.env.SHARE_DB
  const perfil = await db.prepare('SELECT id, email, nome_completo, nome_exibicao, telefone, endereco, cidade, uf, data_nascimento, data_admissao, cpf, rg, canac, status, tipo_user, departamento, data_criacao, data_atualizacao FROM user_profiles WHERE id = ?1 AND lower(COALESCE(tipo_user, \'colaborador\')) = \'colaborador\'').bind(id).first()
  if (!perfil) return c.notFound()
  const [documentos, funcoes, ferias, lancamentos] = await Promise.all([
    db.prepare('SELECT id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, criado_em, categoria FROM documentos_usuarios WHERE user_id = ?1 ORDER BY criado_em DESC').bind(id).all().catch(() => ({ results: [] })),
    db.prepare('SELECT id, funcao, criado_em FROM usuarios_funcoes WHERE user_id = ?1 ORDER BY funcao').bind(id).all().catch(() => ({ results: [] })),
    db.prepare('SELECT id, data_inicio, data_fim, quantidade_dias, status, observacoes, motivo_reprovacao, aprovado_em, criado_em, atualizado_em FROM solicitacoes_ferias WHERE colaborador_id = ?1 ORDER BY data_inicio DESC, criado_em DESC').bind(id).all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, colaborador_id, descricao, ROUND(valor_centavos / 100.0, 2) AS valor, data, data_emissao, data_vencimento, data_pagamento, status, observacoes, pago_por, criado_em FROM lancamentos WHERE colaborador_id = ?1 ORDER BY date(COALESCE(data_vencimento, data, criado_em)) DESC, criado_em DESC LIMIT 200").bind(id).all().catch(() => ({ results: [] })),
  ])
  return c.json({ perfil, documentos: documentos.results, funcoes: funcoes.results, ferias: ferias.results, recebimentos: lancamentos.results })
})

app.get('/api/gestor/ferias', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const inicio = c.req.query('inicio') || new Date().toISOString().slice(0, 10)
  const db = c.env.SHARE_DB
  const registros = await db.prepare(`SELECT f.id, f.colaborador_id, f.data_inicio, f.data_fim, f.quantidade_dias, f.status, f.observacoes, f.motivo_reprovacao, f.aprovado_em, f.criado_em, p.nome_completo, p.nome_exibicao, p.email, p.departamento, p.data_admissao
    FROM solicitacoes_ferias f LEFT JOIN user_profiles p ON p.id = f.colaborador_id
    ORDER BY CASE f.status WHEN 'solicitada' THEN 1 WHEN 'aprovada' THEN 2 ELSE 3 END, date(f.data_inicio), p.nome_completo`).all().catch(() => ({ results: [] }))
  const periodos = await db.prepare(`SELECT pa.id, pa.user_id AS colaborador_id, pa.data_inicio, pa.data_fim, pa.data_limite_concessao, pa.dias_direito, pa.dias_gozados, pa.dias_abono, pa.dias_disponiveis, pa.status, pa.criado_em, p.nome_completo, p.nome_exibicao, p.email, p.departamento, p.data_admissao
    FROM periodos_aquisitivos_ferias pa LEFT JOIN user_profiles p ON p.id = pa.user_id
    ORDER BY date(pa.data_fim), p.nome_completo`).all().catch(() => ({ results: [] }))
  const vencidas = await db.prepare("SELECT COUNT(*) AS total FROM solicitacoes_ferias WHERE status = 'aprovada' AND date(data_fim) < date(?1)").bind(inicio).first<{ total: number }>().catch(() => ({ total: 0 }))
  const ativas = await db.prepare("SELECT COUNT(*) AS total FROM solicitacoes_ferias WHERE status = 'aprovada' AND date(data_inicio) <= date(?1) AND date(data_fim) >= date(?1)").bind(inicio).first<{ total: number }>().catch(() => ({ total: 0 }))
  const solicitadas = await db.prepare("SELECT COUNT(*) AS total FROM solicitacoes_ferias WHERE status = 'solicitada'").first<{ total: number }>().catch(() => ({ total: 0 }))
  const periodosVencidos = (periodos.results || []).filter((periodo: any) => String(periodo.status || '').toUpperCase() === 'VENCIDO' || (periodo.data_limite_concessao && String(periodo.data_limite_concessao) < inicio && !['GOZADO', 'CANCELADO'].includes(String(periodo.status || '').toUpperCase()))).length
  return c.json({ inicio, registros: registros.results, periodos: periodos.results, resumo: { ativas: Number(ativas?.total || 0), solicitadas: Number(solicitadas?.total || 0), vencidas: Number(vencidas?.total || 0) + periodosVencidos } })
})

app.patch('/api/gestor/ferias/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !await isColaboradorManager(c, user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const body = await c.req.json<{ status?: string; motivo_reprovacao?: string }>().catch(() => ({} as { status?: string; motivo_reprovacao?: string }))
  const status = String(body.status || '').trim().toLowerCase()
  if (!['aprovada', 'reprovada', 'cancelada'].includes(status)) return c.json({ error: 'status_de_ferias_invalido' }, 400)
  if (status === 'reprovada' && !String(body.motivo_reprovacao || '').trim()) return c.json({ error: 'motivo_reprovacao_obrigatorio' }, 400)
  const id = c.req.param('id')
  const db = c.env.SHARE_DB
  const atual = await db.prepare('SELECT id, status FROM solicitacoes_ferias WHERE id = ?1').bind(id).first<{ id: string; status: string }>()
  if (!atual) return c.notFound()
  if (atual.status !== 'solicitada' && status !== 'cancelada') return c.json({ error: 'solicitacao_nao_pendente' }, 409)
  await db.prepare("UPDATE solicitacoes_ferias SET status = ?1, motivo_reprovacao = ?2, aprovado_em = CASE WHEN ?1 = 'aprovada' THEN CURRENT_TIMESTAMP ELSE NULL END, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?3")
    .bind(status, status === 'reprovada' ? String(body.motivo_reprovacao).trim() : null, id).run()
  return c.json(await db.prepare('SELECT id, colaborador_id, data_inicio, data_fim, quantidade_dias, status, observacoes, motivo_reprovacao, aprovado_em, criado_em, atualizado_em FROM solicitacoes_ferias WHERE id = ?1').bind(id).first())
})

function jsonArray(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [])
}

async function visibleTask(c: Context<{ Bindings: Bindings }>, user: Colaborador, id: string): Promise<any | null> {
  const manager = isTaskManager(user)
  const sql = manager
    ? 'SELECT * FROM tarefas WHERE id = ?1 AND origem = \'KANBAN\''
    : 'SELECT * FROM tarefas WHERE id = ?1 AND origem = \'KANBAN\' AND (criado_por = ?2 OR publico = 1 OR EXISTS (SELECT 1 FROM json_each(COALESCE(atribuido_para, \'[]\')) WHERE json_each.value = ?2))'
  return manager ? c.env.SHARE_DB.prepare(sql).bind(id).first() : c.env.SHARE_DB.prepare(sql).bind(id, user.id).first()
}

async function notifyTask(c: Context<{ Bindings: Bindings }>, taskId: string, recipients: string[], mensagem: string, status?: string): Promise<void> {
  const unique = [...new Set(recipients.filter(Boolean))]
  if (!unique.length) return
  const db = c.env.SHARE_DB
  for (const recipient of unique) {
    await db.prepare('INSERT INTO tarefas_notificacoes (id, id_da_tarefa, user_id, mensagem, status_alterado_para) VALUES (?, ?, ?, ?, ?)').bind(uuid(), taskId, recipient, mensagem, status || null).run()
  }
}
async function notifyUsers(db: D1Database, recipients: string[], idFrom: string, mensagem: string): Promise<void> {
  const uniqueRecipients = [...new Set(recipients.filter(Boolean))]
  for (const recipient of uniqueRecipients) {
    await db.prepare("INSERT INTO notificacoes (id, id_from, departamento_destinatario, status, mensagem) VALUES (?, ?, ?, 'nao_lida', ?)").bind(uuid(), idFrom, recipient, mensagem || null).run()
  }
}
async function notifyChecklistAbastecimento(db: D1Database, abastecimentoId: string, criadoPor: string | null, numeroVoo: string | null, local: string | null): Promise<void> {
  const recipients = await db.prepare(`SELECT id FROM user_profiles
    WHERE id <> ?1 AND (status IS NULL OR lower(status) IN ('ativo', 'active')) AND (
      lower(replace(replace(trim(COALESCE(tipo_user, '')), ' ', '_'), '-', '_')) IN ('financeiro', 'financeiro_admin', 'financeiroadmin', 'financeiro_master', 'financeiromaster', 'admin', 'administrador')
      OR lower(replace(replace(trim(COALESCE(departamento, '')), ' ', '_'), '-', '_')) IN ('financeiro', 'financeiro_admin', 'financeiroadmin', 'financeiro_master', 'financeiromaster', 'admin', 'administrador', 'administrativo')
      OR id IN (SELECT user_id FROM usuarios_funcoes WHERE lower(replace(replace(trim(funcao), ' ', '_'), '-', '_')) IN ('financeiro', 'financeiro_admin', 'financeiroadmin', 'financeiro_master', 'financeiromaster', 'admin', 'administrador'))
    )`).bind(criadoPor || '').all<{ id: string }>()
  const uniqueRecipients = [...new Set((recipients.results || []).map((recipient) => recipient.id).filter(Boolean))]
  if (!uniqueRecipients.length) return
  const voo = numeroVoo ? ` do voo ${numeroVoo}` : ''
  const aeroporto = local ? ` em ${local}` : ''
  await notifyUsers(db, uniqueRecipients, `abastecimento/${abastecimentoId}`, `Novo abastecimento${voo}${aeroporto} criado pelo checklist pré-voo. É necessário completar os dados fiscais e finalizar o registro no financeiro.`)
}
function notificationDestinations(user: Colaborador): string[] {
  return [...new Set([user.id, user.departamento, ...(user.departamentos_email || '').split(',')]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))]
}

app.get('/api/sharebrasil/tarefas/usuarios', async c => {
  const user = await shareBrasilUser(c)
  if (!user || !isTaskManager(user)) return c.json({ error: 'permissao_necessaria' }, 403)
  const result = await c.env.SHARE_DB.prepare("SELECT id, nome_completo, nome_exibicao, email, tipo_user, departamento FROM user_profiles WHERE status IS NULL OR lower(status) IN ('ativo', 'active') ORDER BY COALESCE(nome_exibicao, nome_completo), email").all()
  return c.json(result.results)
})

app.get('/api/sharebrasil/tarefas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const manager = isTaskManager(user)
  const sql = manager
    ? "SELECT * FROM tarefas WHERE origem = 'KANBAN' ORDER BY CASE status WHEN 'ABERTO' THEN 1 WHEN 'EM_ANDAMENTO' THEN 2 WHEN 'CONCLUIDA' THEN 3 ELSE 4 END, prazo IS NULL, prazo, criado_em DESC"
    : "SELECT * FROM tarefas WHERE origem = 'KANBAN' AND (criado_por = ?1 OR publico = 1 OR EXISTS (SELECT 1 FROM json_each(COALESCE(atribuido_para, '[]')) WHERE json_each.value = ?1)) ORDER BY prazo IS NULL, prazo, criado_em DESC"
  const tasks = manager ? await c.env.SHARE_DB.prepare(sql).all() : await c.env.SHARE_DB.prepare(sql).bind(user.id).all()
  const taskIds = tasks.results.map((row: any) => row.id)
  const comments: any[] = []
  for (const taskId of taskIds) {
    const result = await c.env.SHARE_DB.prepare('SELECT c.*, COALESCE(u.nome_exibicao, u.nome_completo, u.email) AS usuario_nome FROM tarefas_comentarios c LEFT JOIN user_profiles u ON u.id = c.usuario_id WHERE c.tarefa_id = ?1 ORDER BY c.criado_em ASC').bind(taskId).all()
    comments.push(...result.results)
  }
  const notifications = await c.env.SHARE_DB.prepare('SELECT * FROM tarefas_notificacoes WHERE user_id = ?1 ORDER BY criado_em DESC LIMIT 50').bind(user.id).all()
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
  await c.env.SHARE_DB.prepare("INSERT INTO tarefas (id, titulo, descricao, status, prioridade, criado_por, prazo, publico, origem, atribuido_para, progresso) VALUES (?, ?, ?, 'ABERTO', ?, ?, ?, ?, 'KANBAN', ?, 0)").bind(id, body.titulo.trim(), body.descricao?.trim() || null, body.prioridade || 'MEDIA', user.id, body.prazo || null, publico, assignedJson).run()
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
  await c.env.SHARE_DB.prepare('UPDATE tarefas SET titulo = COALESCE(?, titulo), descricao = COALESCE(?, descricao), status = ?, prioridade = COALESCE(?, prioridade), prazo = ?, progresso = ?, publico = COALESCE(?, publico), atribuido_para = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(body.titulo?.trim() || null, body.descricao?.trim() || null, status, body.prioridade || null, body.prazo === undefined ? task.prazo : body.prazo, progress, body.publico === undefined ? null : (body.publico ? 1 : 0), jsonArray(assigned), task.id).run()
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
  await c.env.SHARE_DB.prepare('INSERT INTO tarefas_comentarios (id, tarefa_id, usuario_id, comentario) VALUES (?, ?, ?, ?)').bind(id, task.id, user.id, body.comentario.trim()).run()
  const recipients = [task.criado_por, ...JSON.parse(task.atribuido_para || '[]')].filter((recipient: string) => recipient && recipient !== user.id)
  await notifyTask(c, task.id, recipients, `Novo comentário na tarefa: ${task.titulo}`)
  return c.json({ id, tarefa_id: task.id, comentario: body.comentario.trim() }, 201)
})

app.get('/api/sharebrasil/notificacoes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const destinations = notificationDestinations(user)
  const destinationPlaceholders = destinations.map((_, index) => `?${index + 1}`).join(', ')
  const generalResult = await db.prepare(`SELECT n.id, n.id_from, n.departamento_destinatario, n.status, n.mensagem,
        n.criado_em, NULL AS atualizado_em,
        CASE WHEN lower(COALESCE(n.status, '')) IN ('lida', 'lido', 'read') THEN 1 ELSE 0 END AS lido,
        NULL AS id_da_tarefa, NULL AS status_alterado_para,
        NULL AS tarefa_titulo, NULL AS tarefa_origem, r.id AS relatorio_id,
        r.anexos_rejeicao, 'geral' AS origem_notificacao
      FROM notificacoes n
      LEFT JOIN relatorio_despesa_viagem r ON n.id_from = 'relatorio_despesa_viagem/' || r.id
      WHERE lower(trim(COALESCE(n.departamento_destinatario, ''))) IN (${destinationPlaceholders})
      ORDER BY n.criado_em DESC LIMIT 100`).bind(...destinations).all<any>()
  if (c.req.query('origem') === 'geral') return c.json({ notificacoes: generalResult.results || [] })
  const taskResult = await db.prepare(`SELECT n.*, t.titulo AS tarefa_titulo, t.origem AS tarefa_origem,
      CASE WHEN instr(COALESCE(t.titulo, ''), '[RELATORIO:') > 0 THEN substr(t.titulo,
        instr(t.titulo, '[RELATORIO:') + 11,
        instr(substr(t.titulo, instr(t.titulo, '[RELATORIO:') + 11), ']') - 1)
        ELSE NULL END AS relatorio_id,
      r.anexos_rejeicao, 'tarefa' AS origem_notificacao
    FROM tarefas_notificacoes n LEFT JOIN tarefas t ON t.id = n.id_da_tarefa
    LEFT JOIN relatorio_despesa_viagem r ON r.id = CASE
      WHEN instr(COALESCE(t.titulo, ''), '[RELATORIO:') > 0 THEN substr(t.titulo,
        instr(t.titulo, '[RELATORIO:') + 11,
        instr(substr(t.titulo, instr(t.titulo, '[RELATORIO:') + 11), ']') - 1)
      ELSE NULL END
    WHERE n.user_id = ?1 ORDER BY n.criado_em DESC LIMIT 100`).bind(user.id).all<any>()
  const notificacoes = [...(taskResult.results || []), ...(generalResult.results || [])]
    .sort((a, b) => Date.parse(b.criado_em) - Date.parse(a.criado_em))
    .slice(0, 100)
  return c.json({ notificacoes })
})
app.patch('/api/sharebrasil/notificacoes/:id/lida', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const id = c.req.param('id')
  let result
  if (c.req.query('origem') === 'geral') {
    const destinations = notificationDestinations(user)
    const placeholders = destinations.map((_, index) => `?${index + 2}`).join(', ')
    result = await db.prepare(`UPDATE notificacoes SET status = 'lida' WHERE id = ?1 AND lower(trim(COALESCE(departamento_destinatario, ''))) IN (${placeholders})`).bind(id, ...destinations).run()
  } else {
    result = await db.prepare('UPDATE tarefas_notificacoes SET lido = 1, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2').bind(id, user.id).run()
  }
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})
app.delete('/api/sharebrasil/notificacoes/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const id = c.req.param('id')
  let result
  if (c.req.query('origem') === 'geral') {
    const destinations = notificationDestinations(user)
    const placeholders = destinations.map((_, index) => `?${index + 2}`).join(', ')
    result = await db.prepare(`DELETE FROM notificacoes WHERE id = ?1 AND lower(trim(COALESCE(departamento_destinatario, ''))) IN (${placeholders})`).bind(id, ...destinations).run()
  } else {
    result = await db.prepare('DELETE FROM tarefas_notificacoes WHERE id = ?1 AND user_id = ?2').bind(id, user.id).run()
  }
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})
app.delete('/api/sharebrasil/notificacoes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const destinations = notificationDestinations(user)
  const placeholders = destinations.map((_, index) => `?${index + 1}`).join(', ')
  await db.batch([
    db.prepare('DELETE FROM tarefas_notificacoes WHERE user_id = ?1').bind(user.id),
    db.prepare(`DELETE FROM notificacoes WHERE lower(trim(COALESCE(departamento_destinatario, ''))) IN (${placeholders})`).bind(...destinations),
  ])
  return c.json({ success: true })
})

app.get('/api/sharebrasil/calendario/categorias', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare('SELECT * FROM categorias_calendario WHERE usuario_id = ?1 ORDER BY nome').bind(user.id).all()
  return c.json(result.results)
})

app.post('/api/sharebrasil/calendario/categorias', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ nome?: string; cor?: string }>().catch(() => ({} as any))
  if (!body.nome?.trim()) return c.json({ error: 'nome_obrigatorio' }, 400)
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO categorias_calendario (id, usuario_id, nome, cor) VALUES (?, ?, ?, ?)').bind(id, user.id, body.nome.trim(), body.cor || '#2fb9a7').run()
  return c.json({ id, nome: body.nome.trim(), cor: body.cor || '#2fb9a7' }, 201)
})

app.get('/api/sharebrasil/calendario', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const inicio = c.req.query('inicio') || '1900-01-01'; const fim = c.req.query('fim') || '2999-12-31'
  const result = await c.env.SHARE_DB.prepare("SELECT l.*, c.nome AS categoria_nome, c.cor AS categoria_cor FROM lembretes_calendario l LEFT JOIN categorias_calendario c ON c.id = l.cor_categoria_id WHERE l.data BETWEEN ?1 AND ?2 AND (l.visibilidade = 'TODOS' OR l.usuario_id = ?3) ORDER BY l.data, l.hora").bind(inicio, fim, user.id).all()
  return c.json(result.results)
})

app.post('/api/sharebrasil/calendario', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ titulo?: string; descricao?: string; data?: string; hora?: string; visibilidade?: 'PRIVADO' | 'TODOS'; cor_categoria_id?: string }>().catch(() => ({} as any))
  if (!body.titulo?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(body.data || '')) return c.json({ error: 'titulo_e_data_obrigatorios' }, 400)
  const visibility = body.visibilidade === 'TODOS' ? 'TODOS' : 'PRIVADO'
  const calendarId = uuid(); const taskId = uuid()
  await c.env.SHARE_DB.prepare("INSERT INTO tarefas (id, titulo, descricao, status, prioridade, criado_por, prazo, publico, origem, atribuido_para, progresso) VALUES (?, ?, ?, 'ABERTO', 'MEDIA', ?, ?, ?, 'CALENDARIO', ?, 0)").bind(taskId, body.titulo.trim(), body.descricao?.trim() || null, user.id, body.data, visibility === 'TODOS' ? 1 : 0, jsonArray([user.id])).run()
  await c.env.SHARE_DB.prepare('INSERT INTO lembretes_calendario (id, usuario_id, titulo, descricao, data, hora, visibilidade, cor_categoria_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(calendarId, user.id, body.titulo.trim(), body.descricao?.trim() || null, body.data, body.hora || null, visibility, body.cor_categoria_id || null).run()
  const users = visibility === 'TODOS' ? await c.env.SHARE_DB.prepare("SELECT id FROM user_profiles WHERE status IS NULL OR lower(status) IN ('ativo', 'active')").all() : { results: [{ id: user.id }] }
  await notifyTask(c, taskId, users.results.map((item: any) => item.id), `Novo evento no calendário: ${body.titulo.trim()}`)
  return c.json({ id: calendarId, titulo: body.titulo.trim(), data: body.data, hora: body.hora || null, visibilidade: visibility }, 201)
})



// ─── Hotéis Share Brasil: contatos, CRUD e reservas por email ─────────────────
async function garantirTabelaHoteis(c: Context<{ Bindings: Bindings }>) {
  await validateWorkerSchema(c, [{table:'hoteis',columns:['id']},{table:'reservas_hoteis',columns:['id']}])
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
  const result = busca ? await c.env.SHARE_DB.prepare(query).bind(`%${busca}%`).all() : await c.env.SHARE_DB.prepare(query).all()
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
  await c.env.SHARE_DB.prepare(`INSERT INTO hoteis (id, nome, telefone, endereco, uf, cidade, preco_single, preco_duplo, estrelas, convenio, email, telefone_reservas, contato_comercial, telefone_comercial, email_comercial, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, nome, body.telefone || null, body.endereco || null, body.uf || null, body.cidade || null, body.preco_single == null || body.preco_single === '' ? null : Number(body.preco_single), body.preco_duplo == null || body.preco_duplo === '' ? null : Number(body.preco_duplo), Math.max(0, Math.min(5, Math.trunc(Number(body.estrelas) || 0))), body.convenio ? 1 : 0, body.email || null, body.telefone_reservas || null, body.contato_comercial || null, body.telefone_comercial || null, body.email_comercial || null, body.observacoes || null).run()
  return c.json(hotelPayload(await c.env.SHARE_DB.prepare('SELECT * FROM hoteis WHERE id = ?1').bind(id).first<Record<string, any>>() || { id, nome }), 201)
})

app.patch('/api/sharebrasil/hoteis/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!await isColaboradorManager(c, user)) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await garantirTabelaHoteis(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const current = await c.env.SHARE_DB.prepare('SELECT * FROM hoteis WHERE id = ?1').bind(c.req.param('id')).first<Record<string, any>>()
  if (!current) return c.notFound()
  const value = (key: string) => body[key] === undefined ? current[key] : body[key]
  await c.env.SHARE_DB.prepare('UPDATE hoteis SET nome=?, telefone=?, endereco=?, uf=?, cidade=?, preco_single=?, preco_duplo=?, estrelas=?, convenio=?, email=?, telefone_reservas=?, contato_comercial=?, telefone_comercial=?, email_comercial=?, observacoes=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').bind(String(value('nome') || '').trim(), value('telefone') || null, value('endereco') || null, value('uf') || null, value('cidade') || null, value('preco_single') === '' || value('preco_single') == null ? null : Number(value('preco_single')), value('preco_duplo') === '' || value('preco_duplo') == null ? null : Number(value('preco_duplo')), Math.max(0, Math.min(5, Math.trunc(Number(value('estrelas')) || 0))), value('convenio') ? 1 : 0, value('email') || null, value('telefone_reservas') || null, value('contato_comercial') || null, value('telefone_comercial') || null, value('email_comercial') || null, value('observacoes') || null, current.id).run()
  return c.json(hotelPayload(await c.env.SHARE_DB.prepare('SELECT * FROM hoteis WHERE id = ?1').bind(current.id).first<Record<string, any>>() || current))
})

app.delete('/api/sharebrasil/hoteis/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!await isColaboradorManager(c, user)) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await garantirTabelaHoteis(c)
  const result = await c.env.SHARE_DB.prepare('DELETE FROM hoteis WHERE id = ?1').bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.post('/api/sharebrasil/hoteis/:id/reservar', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaHoteis(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const hotel = await c.env.SHARE_DB.prepare('SELECT * FROM hoteis WHERE id = ?1').bind(c.req.param('id')).first<Record<string, any>>()
  if (!hotel) return c.notFound()
  const destinatario = String(hotel.email || hotel.email_comercial || '').trim()
  if (!destinatario) return c.json({ error: 'hotel_sem_email' }, 422)
  const checkin = String(body.data_checkin || '').trim(); const checkout = String(body.data_checkout || '').trim(); const hospede = String(body.hospede_nome || '').trim(); const telefone = String(body.hospede_telefone || '').trim(); const quantidade = Number(body.quantidade_hospedes || 1)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout) || !hospede || !telefone || !Number.isInteger(quantidade) || quantidade < 1) return c.json({ error: 'dados_da_reserva_invalidos' }, 400)
  if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) return c.json({ error: 'email_nao_configurado' }, 503)
  const emailResponse = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: c.env.EMAIL_FROM, to: [destinatario], reply_to: body.hospede_email || undefined, subject: `Solicitação de reserva — ${hotel.nome} (${checkin} a ${checkout})`, html: `<h2>Solicitação de reserva</h2><p><strong>Hotel:</strong> ${escapeHtml(hotel.nome)}</p><p><strong>Check-in:</strong> ${escapeHtml(checkin)}</p><p><strong>Check-out:</strong> ${escapeHtml(checkout)}</p><p><strong>Quarto:</strong> ${escapeHtml(body.tipo_quarto || 'Não informado')}</p><p><strong>Hóspede:</strong> ${escapeHtml(hospede)}</p><p><strong>Telefone:</strong> ${escapeHtml(telefone)}</p><p><strong>Quantidade:</strong> ${escapeHtml(quantidade)}</p><p><strong>Observações:</strong> ${escapeHtml(body.observacoes || '—')}</p>` }) })
  if (!emailResponse.ok) return c.json({ error: 'falha_ao_enviar_email' }, 502)
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO reservas_hoteis (id, hotel_id, criado_por, data_checkin, data_checkout, tipo_quarto, quantidade_hospedes, hospede_nome, hospede_telefone, hospede_email, observacoes, destinatario_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, hotel.id, user.id, checkin, checkout, body.tipo_quarto || null, quantidade, hospede, telefone, body.hospede_email || null, body.observacoes || null, destinatario).run()
  return c.json({ success: true, id, destinatario_email: destinatario }, 201)
})

// ─── Centro de Treinamento: tutoriais, treinamentos e salas colaborativas ────
async function ensureTrainingTables(c: Context<{ Bindings: Bindings }>) {
  await validateWorkerSchema(c, [{table:'centro_reunioes',columns:['id']},{table:'manual_tutoriais',columns:['id']}])
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
  const result = categoria ? await c.env.SHARE_DB.prepare(query).bind(categoria).all() : await c.env.SHARE_DB.prepare(query).all()
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
    await c.env.SHARE_DB.prepare('INSERT INTO manual_tutoriais (id, titulo, descricao, video_url, conteudo_html, categoria, ordem, criado_por, tema, arquivo_url, tipo_arquivo, tamanho_arquivo, publicado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').bind(id, titulo, descricao, videoUrl, conteudoHtml, categoria, Number.isFinite(ordem) ? ordem : 0, user.id, tema, arquivoUrl, tipoArquivo, tamanhoArquivo).run()
    const row = await c.env.SHARE_DB.prepare('SELECT * FROM manual_tutoriais WHERE id = ?1').bind(id).first<Record<string, any>>()
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
  const current = await c.env.SHARE_DB.prepare('SELECT * FROM manual_tutoriais WHERE id = ?1').bind(c.req.param('id')).first<Record<string, any>>()
  if (!current) return c.notFound()
  const categoria = body.categoria == null ? current.categoria : String(body.categoria).toUpperCase()
  if (!['TUTORIAL', 'TREINAMENTO'].includes(categoria)) return c.json({ error: 'categoria_invalida' }, 400)
  await c.env.SHARE_DB.prepare('UPDATE manual_tutoriais SET titulo = ?, descricao = ?, categoria = ?, tema = ?, video_url = ?, conteudo_html = ?, ordem = ?, publicado = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(String(body.titulo ?? current.titulo).trim(), String(body.descricao ?? current.descricao).trim(), categoria, body.tema == null ? current.tema : String(body.tema), body.video_url == null ? current.video_url : String(body.video_url), body.conteudo_html == null ? current.conteudo_html : String(body.conteudo_html), Number(body.ordem ?? current.ordem) || 0, body.publicado == null ? current.publicado : (body.publicado ? 1 : 0), current.id).run()
  const row = await c.env.SHARE_DB.prepare('SELECT * FROM manual_tutoriais WHERE id = ?1').bind(current.id).first<Record<string, any>>()
  return c.json(trainingPayload(row || current))
})

app.delete('/api/sharebrasil/centro-treinamento/materiais/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!await isColaboradorManager(c, user)) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await ensureTrainingTables(c)
  const row = await c.env.SHARE_DB.prepare('SELECT arquivo_url FROM manual_tutoriais WHERE id = ?1').bind(c.req.param('id')).first<{ arquivo_url: string | null }>()
  if (!row) return c.notFound()
  await c.env.SHARE_DB.prepare('DELETE FROM manual_tutoriais WHERE id = ?1').bind(c.req.param('id')).run()
  if (row.arquivo_url) await shareBrasilBucket(c).delete(row.arquivo_url).catch(() => undefined)
  return c.json({ success: true })
})

app.get('/api/sharebrasil/centro-treinamento/materiais/:id/arquivo', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await ensureTrainingTables(c)
  const row = await c.env.SHARE_DB.prepare('SELECT arquivo_url, tipo_arquivo, titulo FROM manual_tutoriais WHERE id = ?1').bind(c.req.param('id')).first<{ arquivo_url: string | null; tipo_arquivo: string | null; titulo: string }>()
  if (!row?.arquivo_url) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.arquivo_url)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': row.tipo_arquivo || 'application/octet-stream', 'Content-Disposition': `inline; filename="${shareBrasilFileName(row.titulo)}"`, 'Cache-Control': 'private, max-age=3600' } })
})

app.get('/api/sharebrasil/centro-treinamento/reunioes', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await ensureTrainingTables(c)
  const filtro = await isMeetingManager(c, user) ? '' : "WHERE r.status = 'ATIVA'"
  const result = await c.env.SHARE_DB.prepare(`SELECT r.*, COALESCE(u.nome_exibicao, u.nome_completo, u.email) AS criado_por_nome FROM centro_reunioes r LEFT JOIN user_profiles u ON u.id = r.criado_por ${filtro} ORDER BY r.criado_em DESC`).all()
  return c.json(result.results)
})

app.get('/api/sharebrasil/centro-treinamento/reunioes/encerradas', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!(await isMeetingManager(c, user))) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await ensureTrainingTables(c)
  const result = await c.env.SHARE_DB.prepare(`SELECT r.*, COALESCE(u.nome_exibicao, u.nome_completo, u.email) AS criado_por_nome FROM centro_reunioes r LEFT JOIN user_profiles u ON u.id = r.criado_por WHERE r.status = 'ENCERRADA' ORDER BY r.encerrado_em DESC, r.criado_em DESC`).all()
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
  await c.env.SHARE_DB.prepare('INSERT INTO centro_reunioes (id, titulo, descricao, criado_por) VALUES (?, ?, ?, ?)').bind(id, titulo, body.descricao?.trim() || null, user.id).run()
  return c.json({ id, titulo, descricao: body.descricao?.trim() || null, status: 'ATIVA' }, 201)
})

app.post('/api/sharebrasil/centro-treinamento/reunioes/:id/encerrar', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!(await isMeetingManager(c, user))) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await ensureTrainingTables(c)
  await c.env.SHARE_DB.prepare("UPDATE centro_reunioes SET status = 'ENCERRADA', encerrado_em = CURRENT_TIMESTAMP WHERE id = ?1").bind(c.req.param('id')).run()
  return c.json({ success: true })
})

app.delete('/api/sharebrasil/centro-treinamento/reunioes/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  if (!(await isMeetingManager(c, user))) return c.json({ error: 'somente_admin_ou_gestor_master' }, 403)
  await ensureTrainingTables(c)
  const result = await c.env.SHARE_DB.prepare("DELETE FROM centro_reunioes WHERE id = ?1 AND status = 'ENCERRADA'").bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.json({ error: 'sala_nao_encerrada_ou_nao_encontrada' }, 409)
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
  const room = await c.env.SHARE_DB.prepare("SELECT id, criado_por FROM centro_reunioes WHERE id = ?1 AND status = 'ATIVA'").bind(c.req.param('id')).first<{ id: string; criado_por: string }>()
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
  const result = await c.env.SHARE_DB.prepare("SELECT DISTINCT trim(departamento) AS departamento FROM user_profiles WHERE departamento IS NOT NULL AND trim(departamento) <> '' ORDER BY departamento").all()
  return c.json(result.results)
})

app.get('/api/colaborador/recados', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare("SELECT r.id, r.criado_em, r.atualizado_em, r.autor_id, r.mensagem, r.fixado, r.departamento_id, r.lido_por, COALESCE(a.nome_exibicao, a.nome_completo, a.email) AS autor_nome, uf.funcao AS departamento FROM recados r LEFT JOIN user_profiles a ON a.id = r.autor_id LEFT JOIN usuarios_funcoes uf ON uf.id = r.departamento_id WHERE r.departamento_id IS NULL OR lower(COALESCE(uf.funcao, '')) = lower(COALESCE(?1, '')) ORDER BY r.fixado DESC, r.criado_em DESC LIMIT 100").bind(user.departamento || null).all()
  return c.json(result.results.map((item: any) => ({ ...item, fixado: Boolean(item.fixado), lido: JSON.parse(item.lido_por || '[]').includes(user.id), pode_excluir: item.autor_id === user.id })))
})

app.post('/api/colaborador/recados', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ mensagem?: string; departamento?: string | null; fixado?: boolean }>().catch(() => ({} as any))
  if (!body.mensagem?.trim()) return c.json({ error: 'mensagem_obrigatoria' }, 400)
  let departamentoId: string | null = null
  const departamento = body.departamento?.trim()
  if (departamento) {
    const target = await c.env.SHARE_DB.prepare('SELECT id FROM usuarios_funcoes WHERE lower(funcao) = lower(?1) LIMIT 1').bind(departamento).first<{ id: string }>()
    if (!target) return c.json({ error: 'departamento_nao_encontrado' }, 400)
    departamentoId = target.id
  }
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO recados (id, autor_id, mensagem, fixado, departamento_id) VALUES (?, ?, ?, ?, ?)').bind(id, user.id, body.mensagem.trim(), body.fixado ? 1 : 0, departamentoId).run()
  return c.json({ id, mensagem: body.mensagem.trim(), departamento: departamento || null, fixado: Boolean(body.fixado) }, 201)
})

app.delete('/api/colaborador/recados/:id', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare('DELETE FROM recados WHERE id = ?1 AND autor_id = ?2').bind(c.req.param('id'), user.id).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

app.patch('/api/colaborador/recados/:id/lido', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare("SELECT r.id, r.lido_por FROM recados r LEFT JOIN usuarios_funcoes uf ON uf.id = r.departamento_id WHERE r.id = ?1 AND (r.departamento_id IS NULL OR lower(COALESCE(uf.funcao, '')) = lower(COALESCE(?2, '')))").bind(c.req.param('id'), user.departamento || null).first<{ id: string; lido_por: string }>()
  if (!row) return c.notFound()
  const readers = JSON.parse(row.lido_por || '[]') as unknown
  const lidoPor = Array.isArray(readers) ? [...new Set([...readers.filter((item): item is string => typeof item === 'string'), user.id])] : [user.id]
  await c.env.SHARE_DB.prepare('UPDATE recados SET lido_por = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(lidoPor), row.id).run()
  return c.json({ success: true, lido: true })
})

export class RateLimitCounter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
    const body = await request.json<{ minuteWindow: number; perMinute: number }>()
    if (!Number.isInteger(body.minuteWindow) || !Number.isInteger(body.perMinute) || body.perMinute < 1) {
      return Response.json({ error: 'invalid_rate_limit' }, { status: 400 })
    }
    const allowed = await this.state.storage.transaction(async transaction => {
      const stored = await transaction.get<{ minuteWindow: number; count: number }>('counter')
      const count = stored?.minuteWindow === body.minuteWindow ? stored.count : 0
      if (count >= body.perMinute) return false
      await transaction.put('counter', { minuteWindow: body.minuteWindow, count: count + 1 })
      return true
    })
    return Response.json({ allowed })
  }
}

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



app.notFound((c) => c.json({ error: 'Rota não encontrada', path: c.req.path }, 404))

// Relatórios de despesa de viagem: rotas restauradas e compatíveis com SHARE_DB/D1.
async function garantirTabelaRelatorioDespesaViagem(c: Context<{ Bindings: Bindings }>) {
  await validateWorkerSchema(c, [
    { table: 'relatorio_despesa_viagem_anexos', columns: ['id'] },
    { table: 'relatorio_despesa_viagem', columns: ['id', 'anexos_rejeicao'] },
    { table: 'relatorio_despesa_viagem_historico_ajustes', columns: ['id', 'relatorio_despesa_viagem_id', 'tripulante_pos', 'motivo', 'anexos', 'criado_em'] },
    { table: 'sequencia_relatorios_despesa_viagem', columns: ['codigo_cotista', 'aeronave_id', 'ano', 'ultimo_numero'] },
  ])
}


function pagadorDespesaRelatorio(valor: unknown) {
  return String(valor || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_')
}

function despesaTripulanteRelatorio(despesa: any, pos: 1 | 2) {
  const valor = Number(despesa?.valor ?? despesa?.amount ?? 0)
  const pagador = pagadorDespesaRelatorio(despesa?.pago_por ?? despesa?.paid_by)
  return valor > 0 && (pagador === `tripulante_${pos}` || pagador === `tripulante${pos}`)
}

function requerAprovacaoTripulanteRelatorio(despesas: unknown, pos: 1 | 2) {
  return despesasRelatorioViagem(despesas).some((despesa: any) => despesaTripulanteRelatorio(despesa, pos))
}

function statusRelatorioViagem(valor: unknown) {
  const normalizado = String(valor || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_')
  const validos = new Set(['rascunho', 'finalizado', 'aguardando_aprovacao', 'ajuste_necessario', 'ajuste_concluido', 'aprovado', 'enviado_cliente'])
  return validos.has(normalizado) ? normalizado : String(valor || 'rascunho')
}

async function persistirMetadadosFinanceirosRelatorio(
  db: D1Database,
  relatorioId: string,
  usuarioId?: string | null,
  emailId?: string | null,
  enviadoCliente = false,
  dataVencimento?: string | null,
) {
  const prefixo = `RELATORIO_DESPESA_VIAGEM:${relatorioId}`
  // contas_apagar não tem origem_id; os dois reembolsos usam chaves idempotentes próprias.
  const contas = await db.prepare(`SELECT
      MAX(CASE WHEN idempotency_key = ?1 THEN id END) AS conta_tripulante_1,
      MAX(CASE WHEN idempotency_key = ?2 THEN id END) AS conta_tripulante_2
    FROM contas_apagar
    WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND idempotency_key IN (?1, ?2)`).bind(
    `${prefixo}:tripulante_1:CONTA_PAGAR`,
    `${prefixo}:tripulante_2:CONTA_PAGAR`,
  ).first<{ conta_tripulante_1: string | null; conta_tripulante_2: string | null }>()
  await db.prepare(`UPDATE relatorio_despesa_viagem SET
      gerado_por_usuario_id = COALESCE(gerado_por_usuario_id, ?1),
      contas_apagar_tripulante_1_id = COALESCE(?2, contas_apagar_tripulante_1_id),
      contas_apagar_tripulante_2_id = COALESCE(?3, contas_apagar_tripulante_2_id),
      status = CASE WHEN ?4 = 1 THEN 'enviado_cliente' ELSE status END,
      enviado_para_cliente_em = CASE WHEN ?4 = 1 THEN COALESCE(enviado_para_cliente_em, CURRENT_TIMESTAMP) ELSE enviado_para_cliente_em END,
      programado_pagamento_em = COALESCE(programado_pagamento_em, CASE WHEN ?4 = 1 THEN CURRENT_TIMESTAMP ELSE NULL END),
      data_vencimento_reembolso = COALESCE(?5, data_vencimento_reembolso),
      atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ?6`).bind(
    usuarioId || null,
    contas?.conta_tripulante_1 || null,
    contas?.conta_tripulante_2 || null,
    enviadoCliente ? 1 : 0,
    dataVencimento || null,
    relatorioId,
  ).run()
  if (emailId) {
    await db.prepare(`UPDATE relatorio_despesa_viagem SET enviado_para_cliente_em = COALESCE(enviado_para_cliente_em, CURRENT_TIMESTAMP), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?1`).bind(relatorioId).run()
  }
}


function normalizarCodigoRelatorio(value: unknown): string {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function normalizarMatriculaRelatorio(value: unknown): string {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, ' ')
}

async function buscarVooRelatorio(db: D1Database, numeroVoo: string, clienteId: string, socioId: string | null, aeronaveId: string) {
  const voo = await db.prepare(`SELECT id, numero_voo, cliente_id, socio_id, aeronave_id, origem, destino
    FROM solicitacoes_reserva_voo WHERE numero_voo = ?1 LIMIT 1`).bind(numeroVoo).first<any>()
  if (!voo) return { error: 'voo_nao_encontrado', numero_voo: numeroVoo }
  const cotistaCompativel = socioId
    ? voo.socio_id === socioId && voo.cliente_id === clienteId
    : !voo.socio_id && voo.cliente_id === clienteId
  if (voo.aeronave_id !== aeronaveId || !cotistaCompativel) {
    return { error: 'voo_incompativel_com_cotista_ou_aeronave', numero_voo: numeroVoo, solicitacao_id: voo.id, cliente_id: voo.cliente_id, socio_id: voo.socio_id, aeronave_id: voo.aeronave_id }
  }
  return { voo }
}

async function montarRotaRelatorioViagem(
  db: D1Database,
  solicitacaoId: string,
  origem: string | null,
  destino: string | null,
) {
  const { results: pernas } = await db.prepare(`
    SELECT p.numero, p.destino, j.numero_jornada AS jornada_numero
    FROM pernas_jornada_voo p
    JOIN jornadas_voo j ON j.id = p.jornada_id
    WHERE j.solicitacao_id = ?1 AND j.jornada_principal_id IS NULL
  `).bind(solicitacaoId).all<PernaRotaRelatorio>()
  const icaos = sequenciaRotaRelatorio(origem, destino, pernas || [])
  const nomes = await buscarNomesAerodromos(db, icaos)

  return {
    icaos,
    rota_icao: icaos.join(' - '),
    rota_nome: nomearRotaRelatorio(icaos, nomes),
  }
}

async function buscarNomesAerodromos(db: D1Database, icaos: string[]): Promise<Map<string, string>> {
  const lotes = lotesIcaoRelatorio(icaos)
  const resultados = await Promise.all(lotes.map((lote) => db.prepare(`
    SELECT designativo_icao, nome FROM aerodromo
    WHERE upper(designativo_icao) IN (${lote.map(() => '?').join(', ')})
  `).bind(...lote).all<{ designativo_icao: string; nome: string }>()))
  const nomes = new Map<string, string>()
  for (const resultado of resultados) {
    for (const aerodromo of resultado.results || []) {
      nomes.set(aerodromo.designativo_icao.toUpperCase(), aerodromo.nome)
    }
  }
  return nomes
}

async function gerarNumeroRelatorioViagem(
  db: D1Database,
  clienteId: string,
  socioId: string | null,
  aeronaveId: string,
  dataInicio: string,
): Promise<string> {
  const codigoRow = socioId
    ? await db.prepare(`SELECT ca.codigo_cliente AS codigo_cliente FROM hold_socios hs LEFT JOIN cotista_aeronave ca ON ca.id = hs.cotista_id WHERE hs.id = ?1 LIMIT 1`).bind(socioId).first<{ codigo_cliente: string | null }>()
    : await db.prepare(`SELECT COALESCE(NULLIF(c.codigo_cliente, ''), NULLIF(ca.codigo_cliente, '')) AS codigo_cliente
        FROM cliente c LEFT JOIN holdings h ON h.id = ?1
        LEFT JOIN cotista_aeronave ca ON ca.aeronave_id = ?2 AND (ca.cliente_id = ?1 OR ca.cliente_id = c.id OR ca.id = ?1)
        WHERE c.id = ?1 OR h.id = ?1 LIMIT 1`).bind(clienteId, aeronaveId).first<{ codigo_cliente: string | null }>()
  const aeronave = await db.prepare('SELECT matricula_registro FROM aeronave WHERE id = ?1').bind(aeronaveId).first<{ matricula_registro: string | null }>()
  const codigo = normalizarCodigoRelatorio(codigoRow?.codigo_cliente)
  const matricula = normalizarMatriculaRelatorio(aeronave?.matricula_registro)
  const ano = /^\d{4}-\d{2}-\d{2}$/.test(dataInicio) ? dataInicio.slice(2, 4) : ''
  if (!codigo) throw new Error('codigo_cotista_obrigatorio')
  if (!matricula) throw new Error('matricula_aeronave_obrigatoria')
  if (!ano) throw new Error('ano_relatorio_invalido')
  const anteriores = await db.prepare('SELECT numero_relatorio FROM relatorio_despesa_viagem WHERE numero_relatorio LIKE ?1 AND aeronave_id = ?2').bind(`REL-${codigo}-%/${ano} ${matricula}`, aeronaveId).all<{ numero_relatorio: string }>()
  const maiorExistente = (anteriores.results || []).reduce((maior, item) => {
    const numero = String(item.numero_relatorio || '')
    const inicio = `REL-${codigo}-`
    const fim = `/${ano} ${matricula}`
    if (!numero.startsWith(inicio) || !numero.endsWith(fim)) return maior
    const sequencia = Number(numero.slice(inicio.length, -fim.length))
    return Number.isInteger(sequencia) && sequencia > maior ? sequencia : maior
  }, 0)
  const proximoNumero = maiorExistente + 1
  const proximo = await db.prepare(`INSERT INTO sequencia_relatorios_despesa_viagem (codigo_cotista, aeronave_id, ano, ultimo_numero)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(codigo_cotista, aeronave_id, ano) DO UPDATE SET ultimo_numero = MAX(sequencia_relatorios_despesa_viagem.ultimo_numero + 1, excluded.ultimo_numero)
    RETURNING ultimo_numero`).bind(codigo, aeronaveId, ano, proximoNumero).first<{ ultimo_numero: number }>()
  if (!proximo?.ultimo_numero) throw new Error('falha_ao_gerar_numero_relatorio')
  return `REL-${codigo}-${String(proximo.ultimo_numero).padStart(3, '0')}/${ano} ${matricula}`
}

async function buscarRelatorioViagemComNomes(c: Context<{ Bindings: Bindings }>, id: string): Promise<(Record<string, any> & { despesas: any[] }) | null> {
  const db = c.env.SHARE_DB
  const row = await db.prepare(`SELECT r.*,
      CASE WHEN r.socio_id IS NOT NULL
        THEN COALESCE(NULLIF(hs.nome, ''), ca.codigo_cliente)
        ELSE COALESCE(NULLIF(c.razao_social, ''), NULLIF(h.nome, ''), NULLIF(hs_holding.nome, ''), NULLIF(h_socio.nome, ''), NULLIF(h_relacao.nome, ''), NULLIF(cc.razao_social, ''), ca.codigo_cliente)
      END AS cliente_nome,
        COALESCE(h.nome, hs_holding.nome, h_socio.nome, h_relacao.nome) AS holding_nome,
      hs.nome AS socio_nome,
      a.matricula_registro AS aeronave_matricula,
      COALESCE(NULLIF(r.nome_tripulante, ''), t1.nome_completo, f1.nome_completo) AS nome_tripulante,
      COALESCE(NULLIF(r.nome_tripulante_2, ''), t2.nome_completo, f2.nome_completo) AS nome_tripulante_2
    FROM relatorio_despesa_viagem r
    LEFT JOIN cliente c ON c.id = r.cliente_id
    LEFT JOIN holdings h ON h.id = r.cliente_id
    LEFT JOIN cotista_aeronave ca ON ca.aeronave_id = r.aeronave_id
      AND ((r.socio_id IS NOT NULL AND ca.socio_id = r.socio_id)
        OR (r.cliente_id IS NOT NULL AND (ca.cliente_id = r.cliente_id OR ca.id = r.cliente_id)))
    LEFT JOIN cliente cc ON cc.id = ca.cliente_id
    LEFT JOIN hold_socios hs ON hs.id = COALESCE(r.socio_id, ca.socio_id)
    LEFT JOIN holdings hs_holding ON hs_holding.id = hs.holding_id
    LEFT JOIN holdings h_socio ON h_socio.id = r.socio_id
    LEFT JOIN holdings h_relacao ON h_relacao.id = (
      SELECT hs_relacao.holding_id
      FROM cotista_aeronave ca_relacao
      LEFT JOIN hold_socios hs_relacao ON hs_relacao.id = ca_relacao.socio_id
      WHERE ca_relacao.aeronave_id = r.aeronave_id
        AND (ca_relacao.socio_id = r.socio_id OR hs_relacao.holding_id = r.cliente_id)
      LIMIT 1
    )
    LEFT JOIN aeronave a ON a.id = r.aeronave_id
    LEFT JOIN tripulacao t1 ON t1.id = r.tripulacao_id
    LEFT JOIN tripulacao_freelancer f1 ON f1.id = r.tripulacao_id
    LEFT JOIN tripulacao t2 ON t2.id = r.tripulante_id_2
    LEFT JOIN tripulacao_freelancer f2 ON f2.id = r.tripulante_id_2
    WHERE r.id = ?1`).bind(id).first<Record<string, any>>()
  if (!row) return null
  const anexos = await db.prepare('SELECT id, relatorio_despesa_viagem_id, indice_despesa, nome_arquivo, caminho_arquivo, url_arquivo, tipo_arquivo, tamanho_arquivo, criado_em FROM relatorio_despesa_viagem_anexos WHERE relatorio_despesa_viagem_id = ?1 ORDER BY indice_despesa, criado_em').bind(id).all()
  return { ...row, status: statusRelatorioViagem(row.status), despesas: despesasRelatorioViagem(row.despesas), anexos: anexos.results || [] }
}

app.get('/api/financeiro/relatorios-despesa-viagem/opcoes', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const db = c.env.SHARE_DB
    const [clientes, aeronaves, tripulantes, categorias, socios, voos] = await Promise.all([
      db.prepare(`SELECT id, razao_social, codigo_cliente, holding FROM cliente
        WHERE lower(COALESCE(status, 'ativo')) NOT IN ('inativo', 'cancelado')
        UNION ALL
        SELECT id, nome AS razao_social, NULL AS codigo_cliente, 1 AS holding FROM holdings
        WHERE ativo = 1
        ORDER BY razao_social`).all(),
      db.prepare('SELECT id, matricula_registro, fabricante, modelo FROM aeronave ORDER BY matricula_registro').all(),
      db.prepare(`SELECT t.id, t.nome_completo, t.canac, t.status, 'tripulacao' AS origem FROM tripulacao t
        LEFT JOIN user_profiles up ON up.id = t.user_id
        WHERE lower(COALESCE(t.status, 'ativo')) = 'ativo' AND lower(COALESCE(up.status, 'ativo')) NOT IN ('inativo', 'inactive')
        UNION ALL
        SELECT id, nome_completo, canac, status, 'tripulacao_freelancer' AS origem FROM tripulacao_freelancer
        WHERE lower(COALESCE(status, 'ativo')) = 'ativo'
        ORDER BY nome_completo`).all().catch(() => ({ results: [] })),
      db.prepare('SELECT id, nome FROM categoria_movimentacao_share ORDER BY nome').all(),
      db.prepare('SELECT id, nome, holding_id FROM hold_socios ORDER BY nome').all().catch(() => ({ results: [] })),
      db.prepare(`SELECT s.id AS solicitacao_id, s.numero_voo, s.cliente_id, s.socio_id, s.aeronave_id, s.origem, s.destino,
          s.data_agendada, s.dias_duracao, s.piloto_id, s.copiloto_id,
          COALESCE(c.razao_social, h.nome, hs.nome) AS cotista_nome,
          hs.nome AS socio_nome,
          COALESCE(t1.nome_completo, f1.nome_completo) AS tripulante_nome,
          COALESCE(t2.nome_completo, f2.nome_completo) AS tripulante_nome_2,
          a.matricula_registro
        FROM solicitacoes_reserva_voo s
        LEFT JOIN aeronave a ON a.id = s.aeronave_id
        LEFT JOIN cliente c ON c.id = s.cliente_id
        LEFT JOIN holdings h ON h.id = s.cliente_id
        LEFT JOIN hold_socios hs ON hs.id = s.socio_id
        LEFT JOIN tripulacao t1 ON t1.id = s.piloto_id
        LEFT JOIN tripulacao_freelancer f1 ON f1.id = s.piloto_id
        LEFT JOIN tripulacao t2 ON t2.id = s.copiloto_id
        LEFT JOIN tripulacao_freelancer f2 ON f2.id = s.copiloto_id
        WHERE s.numero_voo IS NOT NULL AND trim(s.numero_voo) <> ''
          AND (?1 IS NULL OR s.aeronave_id = ?1)
          AND (?2 IS NULL OR (s.cliente_id = ?2 AND (?3 IS NULL AND (s.socio_id IS NULL OR trim(s.socio_id) = '') OR s.socio_id = ?3)))
        ORDER BY date(s.data_agendada) DESC, s.numero_voo DESC, s.id LIMIT 200`).bind(
        c.req.query('aeronave_id') || null, c.req.query('cliente_id') || null, c.req.query('socio_id') || null,
      ).all().catch(() => ({ results: [] })),
    ])
    const voosDisponiveis = voos.results || []
    const aeronaveFiltro = c.req.query('aeronave_id') || null
    const clienteFiltro = c.req.query('cliente_id') || null
    const socioFiltro = c.req.query('socio_id') || null
    const pernas = voosDisponiveis.length
      ? await db.prepare(`SELECT j.solicitacao_id, p.numero, p.destino, j.numero_jornada AS jornada_numero
          FROM pernas_jornada_voo p
          JOIN jornadas_voo j ON j.id = p.jornada_id
          WHERE j.solicitacao_id IN (
            SELECT s.id FROM solicitacoes_reserva_voo s
            WHERE s.numero_voo IS NOT NULL AND trim(s.numero_voo) <> ''
              AND (?1 IS NULL OR s.aeronave_id = ?1)
              AND (?2 IS NULL OR (s.cliente_id = ?2 AND (?3 IS NULL AND (s.socio_id IS NULL OR trim(s.socio_id) = '') OR s.socio_id = ?3)))
            ORDER BY date(s.data_agendada) DESC, s.numero_voo DESC, s.id LIMIT 200
          ) AND j.jornada_principal_id IS NULL`)
        .bind(aeronaveFiltro, clienteFiltro, socioFiltro).all<PernaRotaRelatorio & { solicitacao_id: string }>()
      : { results: [] as Array<PernaRotaRelatorio & { solicitacao_id: string }> }
    const pernasPorSolicitacao = new Map<string, PernaRotaRelatorio[]>()
    for (const perna of pernas.results || []) {
      const agrupadas = pernasPorSolicitacao.get(perna.solicitacao_id) || []
      agrupadas.push(perna)
      pernasPorSolicitacao.set(perna.solicitacao_id, agrupadas)
    }
    const voosComSequencia = voosDisponiveis.map((voo: any) => {
      const icaos = sequenciaRotaRelatorio(voo.origem, voo.destino, pernasPorSolicitacao.get(voo.solicitacao_id) || [])
      const dadosVoo = { ...voo }
      delete dadosVoo.solicitacao_id
      return { voo: dadosVoo, icaos }
    })
    const icaos = [...new Set(voosComSequencia.flatMap(({ icaos: rota }) => rota))]
    const nomesPorIcao = await buscarNomesAerodromos(db, icaos)
    const voosComRota = voosComSequencia.map(({ voo, icaos: rota }) => ({
      ...voo,
      rota_icao: rota.join(' - '),
      rota_nome: nomearRotaRelatorio(rota, nomesPorIcao),
    }))
    return c.json({ clientes: clientes.results, aeronaves: aeronaves.results, tripulantes: tripulantes.results, categorias: categorias.results, socios: socios.results, voos: voosComRota })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:opcoes]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_carregar_opcoes' }, 500)
  }
})

app.get('/api/financeiro/relatorios-despesa-viagem/minhas', async c => {
  const userId = await getAuthenticatedUserId(c)
  if (!userId) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const rows = await c.env.SHARE_DB.prepare(`SELECT r.*,
        a.matricula_registro AS aeronave_matricula,
        COALESCE(NULLIF(r.nome_tripulante, ''), t1.nome_completo) AS nome_tripulante,
        COALESCE(NULLIF(r.nome_tripulante_2, ''), t2.nome_completo) AS nome_tripulante_2,
        CASE WHEN t1.user_id = ?1 THEN 1 ELSE 2 END AS tripulante_pos,
        COALESCE((SELECT SUM(cp.valor_centavos) FROM contas_apagar cp
          WHERE cp.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
            AND cp.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || r.id || ':' || CASE WHEN t1.user_id = ?1 THEN 'tripulante_1' ELSE 'tripulante_2' END || ':CONTA_PAGAR'), 0) AS pagamento_total_centavos,
        COALESCE((SELECT SUM(CASE WHEN upper(COALESCE(cp.status, '')) = 'PAGO' THEN cp.valor_centavos ELSE 0 END) FROM contas_apagar cp
          WHERE cp.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
            AND cp.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || r.id || ':' || CASE WHEN t1.user_id = ?1 THEN 'tripulante_1' ELSE 'tripulante_2' END || ':CONTA_PAGAR'), 0) AS pagamento_pago_centavos,
        COALESCE((SELECT COUNT(*) FROM contas_apagar cp
          WHERE cp.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
            AND cp.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || r.id || ':' || CASE WHEN t1.user_id = ?1 THEN 'tripulante_1' ELSE 'tripulante_2' END || ':CONTA_PAGAR'), 0) AS pagamentos_total,
        COALESCE((SELECT COUNT(*) FROM contas_apagar cp
          WHERE cp.origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
            AND cp.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || r.id || ':' || CASE WHEN t1.user_id = ?1 THEN 'tripulante_1' ELSE 'tripulante_2' END || ':CONTA_PAGAR'
            AND upper(COALESCE(cp.status, '')) = 'PAGO'), 0) AS pagamentos_concluidos
      FROM relatorio_despesa_viagem r
      LEFT JOIN tripulacao t1 ON t1.id = r.tripulacao_id
      LEFT JOIN tripulacao t2 ON t2.id = r.tripulante_id_2
      LEFT JOIN aeronave a ON a.id = r.aeronave_id
      WHERE t1.user_id = ?1 OR t2.user_id = ?1
      ORDER BY date(r.data_inicio) DESC, r.criado_em DESC LIMIT 200`).bind(userId).all<Record<string, any>>()
    const reportRows = rows.results || []
    const anexosPorRelatorio = new Map<string, Record<string, any>[]>()
    const ajustesPorRelatorio = new Map<string, Record<string, any>[]>()
    if (reportRows.length) {
      const placeholders = reportRows.map(() => '?').join(', ')
      const reportIds = reportRows.map((row) => row.id)
      const [anexos, ajustes] = await Promise.all([
        c.env.SHARE_DB.prepare(`SELECT id, relatorio_despesa_viagem_id, indice_despesa, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em
          FROM relatorio_despesa_viagem_anexos
          WHERE relatorio_despesa_viagem_id IN (${placeholders})
          ORDER BY relatorio_despesa_viagem_id, indice_despesa, criado_em`).bind(...reportIds).all<Record<string, any>>(),
        c.env.SHARE_DB.prepare(`SELECT id, relatorio_despesa_viagem_id, tripulante_pos, motivo, anexos, criado_em
          FROM relatorio_despesa_viagem_historico_ajustes
          WHERE relatorio_despesa_viagem_id IN (${placeholders})
          ORDER BY criado_em, id`).bind(...reportIds).all<Record<string, any>>(),
      ])
      for (const anexo of anexos.results || []) {
        const lista = anexosPorRelatorio.get(anexo.relatorio_despesa_viagem_id) || []
        lista.push({
          ...anexo,
          url_arquivo: `/api/financeiro/relatorios-despesa-viagem/${encodeURIComponent(anexo.relatorio_despesa_viagem_id)}/anexos/${encodeURIComponent(anexo.id)}/arquivo`,
        })
        anexosPorRelatorio.set(anexo.relatorio_despesa_viagem_id, lista)
      }
      for (const ajuste of ajustes.results || []) {
        const lista = ajustesPorRelatorio.get(ajuste.relatorio_despesa_viagem_id) || []
        lista.push({
          id: ajuste.id,
          tripulante_pos: ajuste.tripulante_pos,
          motivo: ajuste.motivo,
          criado_em: ajuste.criado_em,
          anexos: parseAdjustmentAttachments(ajuste.anexos).map((anexo) => ({
            ...anexo,
            url_arquivo: `/api/financeiro/relatorios-despesa-viagem/${encodeURIComponent(ajuste.relatorio_despesa_viagem_id)}/anexos-rejeicao/${encodeURIComponent(anexo.id)}/arquivo`,
          })),
        })
        ajustesPorRelatorio.set(ajuste.relatorio_despesa_viagem_id, lista)
      }
    }
    return c.json({ relatorios: reportRows.map((row) => ({
      ...row,
      status: statusRelatorioViagem(row.status),
      despesas: despesasRelatorioViagem(row.despesas),
      anexos_rejeicao: rejectionAttachments(row.anexos_rejeicao, row.id),
      anexos: anexosPorRelatorio.get(row.id) || [],
      historico_ajustes: ajustesPorRelatorio.get(row.id) || [],
      pagamento_status: Number(row.pagamentos_total || 0) > 0
        ? Number(row.pagamentos_concluidos || 0) === Number(row.pagamentos_total) ? 'PAGO' : 'PENDENTE'
        : 'NAO_PROGRAMADO',
      pagamento_valor: Number(row.pagamento_pago_centavos || 0) / 100,
      pagamento_total: Number(row.pagamento_total_centavos || 0) / 100,
    })) })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:minhas]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_listar_relatorios_do_tripulante' }, 500)
  }
})

app.get('/api/financeiro/relatorios-despesa-viagem', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const rows = await c.env.SHARE_DB.prepare(`SELECT r.*,
        CASE WHEN r.socio_id IS NOT NULL
          THEN COALESCE(NULLIF(hs.nome, ''), ca.codigo_cliente)
          ELSE COALESCE(NULLIF(c.razao_social, ''), NULLIF(h.nome, ''), NULLIF(hs_holding.nome, ''), NULLIF(h_socio.nome, ''), NULLIF(h_relacao.nome, ''), NULLIF(cc.razao_social, ''), ca.codigo_cliente)
        END AS cliente_nome,
        COALESCE(h.nome, hs_holding.nome, h_socio.nome, h_relacao.nome) AS holding_nome,
        hs.nome AS socio_nome,
        a.matricula_registro AS aeronave_matricula,
        COALESCE(NULLIF(r.nome_tripulante, ''), t1.nome_completo, f1.nome_completo) AS nome_tripulante,
        COALESCE(NULLIF(r.nome_tripulante_2, ''), t2.nome_completo, f2.nome_completo) AS nome_tripulante_2
      FROM relatorio_despesa_viagem r
      LEFT JOIN cliente c ON c.id = r.cliente_id
      LEFT JOIN holdings h ON h.id = r.cliente_id
      LEFT JOIN cotista_aeronave ca ON ca.aeronave_id = r.aeronave_id
        AND ((r.socio_id IS NOT NULL AND ca.socio_id = r.socio_id)
          OR (r.cliente_id IS NOT NULL AND (ca.cliente_id = r.cliente_id OR ca.id = r.cliente_id)))
      LEFT JOIN cliente cc ON cc.id = ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = COALESCE(r.socio_id, ca.socio_id)
      LEFT JOIN holdings hs_holding ON hs_holding.id = hs.holding_id
      LEFT JOIN holdings h_socio ON h_socio.id = r.socio_id
      LEFT JOIN holdings h_relacao ON h_relacao.id = (
        SELECT hs_relacao.holding_id
        FROM cotista_aeronave ca_relacao
        LEFT JOIN hold_socios hs_relacao ON hs_relacao.id = ca_relacao.socio_id
        WHERE ca_relacao.aeronave_id = r.aeronave_id
          AND (ca_relacao.socio_id = r.socio_id OR hs_relacao.holding_id = r.cliente_id)
        LIMIT 1
      )
      LEFT JOIN aeronave a ON a.id = r.aeronave_id
      LEFT JOIN tripulacao t1 ON t1.id = r.tripulacao_id
      LEFT JOIN tripulacao_freelancer f1 ON f1.id = r.tripulacao_id
      LEFT JOIN tripulacao t2 ON t2.id = r.tripulante_id_2
      LEFT JOIN tripulacao_freelancer f2 ON f2.id = r.tripulante_id_2
      ORDER BY date(r.data_inicio) DESC, r.criado_em DESC LIMIT 200`).all<Record<string, any>>()
    return c.json({ relatorios: (rows.results || []).map((row) => ({ ...row, status: statusRelatorioViagem(row.status), despesas: despesasRelatorioViagem(row.despesas) })) })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:listar]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_listar_relatorios' }, 500)
  }
})

app.get('/api/financeiro/relatorios-despesa-viagem/:id', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const relatorio = await buscarRelatorioViagemComNomes(c, c.req.param('id'))
    if (!relatorio) return c.notFound()
    return c.json({ relatorio })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:detalhe]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_carregar_relatorio' }, 500)
  }
})

app.post('/api/financeiro/relatorios-despesa-viagem', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const body = await c.req.json<Record<string, any>>().catch(() => null)
    if (!body) return c.json({ error: 'payload_invalido' }, 400)
    const clienteId = String(body.cliente_id || '').trim()
    const aeronaveId = String(body.aeronave_id || '').trim()
    let rota = String(body.rota || '').trim()
    const tripulacaoId = String(body.tripulacao_id || '').trim()
    const nomeTripulante = String(body.nome_tripulante || '').trim()
    const dataInicio = String(body.data_inicio || '').trim()
    const dataFim = String(body.data_fim || '').trim()
    if (!clienteId) return c.json({ error: 'cliente_obrigatorio' }, 400)
    if (!aeronaveId) return c.json({ error: 'aeronave_obrigatoria' }, 400)
    if (!tripulacaoId && !nomeTripulante) return c.json({ error: 'tripulante_obrigatorio' }, 400)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataInicio) || !/^\d{4}-\d{2}-\d{2}$/.test(dataFim)) return c.json({ error: 'datas_obrigatorias' }, 400)
    if (dataFim < dataInicio) return c.json({ error: 'data_fim_antes_da_data_inicio' }, 400)

    const db = c.env.SHARE_DB
    const aeronave = await db.prepare('SELECT matricula_registro FROM aeronave WHERE id = ?1').bind(aeronaveId).first<{ matricula_registro: string | null }>()
    if (!aeronave) return c.json({ error: 'aeronave_nao_encontrada', aeronave_id: aeronaveId }, 400)
    const id = uuid()
    const socioId = body.socio_id ? String(body.socio_id).trim() : null
    const numeroVoo = body.numero_voo == null ? null : String(body.numero_voo || '').trim() || null
    if (numeroVoo) {
      const validacaoVoo = await buscarVooRelatorio(db, numeroVoo, clienteId, socioId, aeronaveId)
      if ('error' in validacaoVoo) return c.json(validacaoVoo, validacaoVoo.error === 'voo_nao_encontrado' ? 400 : 409)
      const rotaCalculada = await montarRotaRelatorioViagem(db, validacaoVoo.voo.id, validacaoVoo.voo.origem, validacaoVoo.voo.destino)
      rota = rotaCalculada.rota_nome
    }
    if (!rota) return c.json({ error: 'trecho_obrigatorio' }, 400)
    const numero = await gerarNumeroRelatorioViagem(db, clienteId, socioId, aeronaveId, dataInicio)
    const status = statusRelatorioViagem(body.status || 'rascunho')
    await db.prepare(`
      INSERT INTO relatorio_despesa_viagem (
        id, numero_relatorio, numero_voo, cliente_id, socio_id, aeronave_id, matricula_aeronave,
        rota, data_inicio, data_fim, quantidade_dias, tripulacao_id, nome_tripulante,
        tripulante_id_2, nome_tripulante_2, observacoes, despesas, status,
        total_valor, total_combustivel, total_hospedagem, total_alimentacao, total_transporte,
        total_outros, total_tripulacao, total_tripulante_1, total_tripulante_2, total_cliente,
        total_sharebrasil, criado_por, gerado_por_usuario_id
      ) VALUES (${new Array(31).fill('?').join(', ')})
    `).bind(
      id, numero, numeroVoo, clienteId, socioId, aeronaveId,
      aeronave?.matricula_registro || body.matricula_aeronave || null, rota, dataInicio, dataFim,
      Number(body.quantidade_dias || 1), tripulacaoId || null, nomeTripulante || null,
      body.tripulante_id_2 || null, body.nome_tripulante_2 || null, body.observacoes || null,
      JSON.stringify(despesasRelatorioViagem(body.despesas)), status,
      Number(body.total_valor || 0), Number(body.total_combustivel || 0), Number(body.total_hospedagem || 0),
      Number(body.total_alimentacao || 0), Number(body.total_transporte || 0), Number(body.total_outros || 0),
      Number(body.total_tripulacao || 0), Number(body.total_tripulante_1 || 0), Number(body.total_tripulante_2 || 0),
      Number(body.total_cliente || 0), Number(body.total_sharebrasil || 0), user.id, user.id,
    ).run()
    const relatorio = await buscarRelatorioViagemComNomes(c, id)
    if (!relatorio) return c.json({ error: 'falha_ao_carregar_relatorio_criado' }, 500)
    if (['finalizado', 'enviado_cliente'].includes(status)) await sincronizarRelatorioViagemFinanceiro(db, relatorio, user.id)
    return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, id) }, 201)
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:criar]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_criar_relatorio' }, 500)
  }
})

app.patch('/api/financeiro/relatorios-despesa-viagem/:id', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const id = c.req.param('id')
    const db = c.env.SHARE_DB
    const atual = await db.prepare(`SELECT id, status, despesas, numero_relatorio, numero_voo, cliente_id, socio_id, aeronave_id, matricula_aeronave,
      rota, tripulacao_id, nome_tripulante, data_inicio, data_fim, pdf_path, enviado_para_tripulante_em, enviado_para_tripulante_2_em,
      aprovado_tripulante_1_em, aprovado_tripulante_2_em, aprovado_tripulante_em,
      status_aprovacao_tripulante, status_aprovacao_tripulante_2
      FROM relatorio_despesa_viagem WHERE id = ?1`).bind(id).first<any>()
    if (!atual) return c.notFound()
    const statusAtual = statusRelatorioViagem(atual.status)
    const bloqueadoPorEnvioOuDecisao = statusAtual !== 'ajuste_necessario' && (['aguardando_aprovacao', 'aprovado', 'enviado_cliente'].includes(statusAtual)
      || Boolean(atual.enviado_para_tripulante_em || atual.enviado_para_tripulante_2_em || atual.aprovado_tripulante_1_em || atual.aprovado_tripulante_2_em || atual.aprovado_tripulante_em)
      || ['aprovado', 'reprovado'].includes(String(atual.status_aprovacao_tripulante || '').toLowerCase())
      || ['aprovado', 'reprovado'].includes(String(atual.status_aprovacao_tripulante_2 || '').toLowerCase()))
    if (bloqueadoPorEnvioOuDecisao) return c.json({ error: 'relatorio_bloqueado_apos_envio_ou_decisao' }, 409)
    if (!['rascunho', 'finalizado', 'ajuste_necessario'].includes(statusAtual)) return c.json({ error: 'relatorio_nao_editavel_neste_estado' }, 409)
    const body = await c.req.json<Record<string, any>>().catch(() => null)
    if (!body) return c.json({ error: 'payload_invalido' }, 400)
    const despesasAnteriores = despesasRelatorioViagem(atual.despesas).map((despesa, index) => ({
      ...despesa,
      id: String(despesa.id || `${id}-despesa-${index}`),
    }))
    const despesasNovas = body.despesas === undefined ? null : despesasRelatorioViagem(body.despesas).map((despesa, index) => ({
      ...despesa,
      id: String(despesa.id || `${id}-despesa-${index}`),
    }))

    const numeroAnterior = String(atual.numero_relatorio || '').trim()
    const numeroRecebido = body.numero_relatorio === undefined ? numeroAnterior : String(body.numero_relatorio ?? '').trim()
    if (body.numero_relatorio !== undefined && numeroRecebido !== numeroAnterior) {
      if (statusAtual !== 'rascunho') return c.json({ error: 'numero_relatorio_alteravel_somente_em_rascunho' }, 409)
      if (!numeroRecebido) return c.json({ error: 'numero_relatorio_obrigatorio' }, 400)
      if (numeroRecebido.length > 100 || !/^REL-[A-Z0-9]+-\d{3,}\/\d{2} [A-Z0-9][A-Z0-9 -]{0,29}$/.test(numeroRecebido)) return c.json({ error: 'formato_numero_relatorio_invalido' }, 400)
      const colisao = await db.prepare('SELECT id FROM relatorio_despesa_viagem WHERE upper(trim(numero_relatorio)) = upper(?1) AND id <> ?2 LIMIT 1').bind(numeroRecebido, id).first<{ id: string }>()
      if (colisao) return c.json({ error: 'numero_relatorio_ja_utilizado' }, 409)
    }
    const numeroFoiAlterado = numeroRecebido !== numeroAnterior
    const clienteId = body.cliente_id === undefined ? String(atual.cliente_id || '').trim() : String(body.cliente_id || '').trim()
    const socioId = body.socio_id === undefined ? (atual.socio_id ? String(atual.socio_id).trim() : null) : (String(body.socio_id || '').trim() || null)
    const aeronaveId = body.aeronave_id === undefined ? String(atual.aeronave_id || '').trim() : String(body.aeronave_id || '').trim()
    const numeroVoo = body.numero_voo === undefined ? (atual.numero_voo ? String(atual.numero_voo).trim() : null) : (String(body.numero_voo || '').trim() || null)
    let rota = body.rota === undefined ? String(atual.rota || '').trim() : String(body.rota || '').trim()
    const tripulacaoId = body.tripulacao_id === undefined ? String(atual.tripulacao_id || '').trim() : String(body.tripulacao_id || '').trim()
    const nomeTripulante = body.nome_tripulante === undefined ? String(atual.nome_tripulante || '').trim() : String(body.nome_tripulante || '').trim()
    if (!clienteId) return c.json({ error: 'cliente_obrigatorio' }, 400)
    if (!aeronaveId) return c.json({ error: 'aeronave_obrigatoria' }, 400)
    if (!tripulacaoId && !nomeTripulante) return c.json({ error: 'tripulante_obrigatorio' }, 400)
    const aeronave = await db.prepare('SELECT matricula_registro FROM aeronave WHERE id = ?1').bind(aeronaveId).first<{ matricula_registro: string | null }>()
    if (!aeronave) return c.json({ error: 'aeronave_nao_encontrada', aeronave_id: aeronaveId }, 400)
    if (numeroVoo) {
      const validacaoVoo = await buscarVooRelatorio(db, numeroVoo, clienteId, socioId, aeronaveId)
      if ('error' in validacaoVoo) return c.json(validacaoVoo, validacaoVoo.error === 'voo_nao_encontrado' ? 400 : 409)
      const numeroVooAnterior = atual.numero_voo ? String(atual.numero_voo).trim() : null
      if (numeroVoo !== numeroVooAnterior) {
        const rotaCalculada = await montarRotaRelatorioViagem(db, validacaoVoo.voo.id, validacaoVoo.voo.origem, validacaoVoo.voo.destino)
        rota = rotaCalculada.rota_nome
      }
    }
    if (!rota) return c.json({ error: 'trecho_obrigatorio' }, 400)
    const dataInicio = body.data_inicio === undefined ? String(atual.data_inicio || '') : String(body.data_inicio || '').trim()
    const dataFim = body.data_fim === undefined ? String(atual.data_fim || '') : String(body.data_fim || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataInicio) || !/^\d{4}-\d{2}-\d{2}$/.test(dataFim)) return c.json({ error: 'datas_obrigatorias' }, 400)
    if (dataFim < dataInicio) return c.json({ error: 'data_fim_antes_da_data_inicio' }, 400)
    const identificadoresAlterados = clienteId !== String(atual.cliente_id || '').trim() || socioId !== (atual.socio_id ? String(atual.socio_id).trim() : null) || aeronaveId !== String(atual.aeronave_id || '').trim() || dataInicio.slice(0, 4) !== String(atual.data_inicio || '').slice(0, 4)
    const documentoDependenteAlterado = identificadoresAlterados || numeroVoo !== (atual.numero_voo ? String(atual.numero_voo).trim() : null) || numeroFoiAlterado
    const numero = numeroFoiAlterado
      ? numeroRecebido
      : identificadoresAlterados && statusAtual === 'rascunho'
        ? await gerarNumeroRelatorioViagem(db, clienteId, socioId, aeronaveId, dataInicio)
        : undefined
    const despesas = body.despesas === undefined ? undefined : JSON.stringify(despesasRelatorioViagem(body.despesas))
    const novoStatus = ['finalizado', 'ajuste_necessario'].includes(statusAtual) ? statusAtual : statusRelatorioViagem(body.status || statusAtual)
    const updateResult = await db.prepare(`UPDATE relatorio_despesa_viagem SET
        numero_relatorio = COALESCE(?1, numero_relatorio), numero_voo = ?2, cliente_id = ?3, socio_id = ?4,
        aeronave_id = ?5, matricula_aeronave = ?6, rota = ?7, data_inicio = ?8, data_fim = ?9,
        quantidade_dias = COALESCE(?10, quantidade_dias), tripulacao_id = ?, nome_tripulante = ?, tripulante_id_2 = ?, nome_tripulante_2 = ?, observacoes = ?,
        despesas = COALESCE(?, despesas), status = ?, total_valor = ?, total_combustivel = ?, total_hospedagem = ?, total_alimentacao = ?,
        total_transporte = ?, total_outros = ?, total_tripulacao = ?, total_tripulante_1 = ?, total_tripulante_2 = ?, total_cliente = ?, total_sharebrasil = ?,
        pdf_url = CASE WHEN ? = 1 OR ? = 'ajuste_necessario' THEN NULL ELSE pdf_url END, pdf_path = CASE WHEN ? = 1 OR ? = 'ajuste_necessario' THEN NULL ELSE pdf_path END,
        status_aprovacao_tripulante = CASE WHEN ? = 'ajuste_necessario' THEN NULL ELSE status_aprovacao_tripulante END, status_aprovacao_tripulante_2 = CASE WHEN ? = 'ajuste_necessario' THEN NULL ELSE status_aprovacao_tripulante_2 END,
        aprovado_tripulante_1_em = CASE WHEN ? = 'ajuste_necessario' THEN NULL ELSE aprovado_tripulante_1_em END, aprovado_tripulante_2_em = CASE WHEN ? = 'ajuste_necessario' THEN NULL ELSE aprovado_tripulante_2_em END, aprovado_tripulante_em = CASE WHEN ? = 'ajuste_necessario' THEN NULL ELSE aprovado_tripulante_em END,
        enviado_para_tripulante_em = CASE WHEN ? = 'ajuste_necessario' THEN NULL ELSE enviado_para_tripulante_em END, enviado_para_tripulante_2_em = CASE WHEN ? = 'ajuste_necessario' THEN NULL ELSE enviado_para_tripulante_2_em END, token_aprovacao_tripulante_1 = CASE WHEN ? = 'ajuste_necessario' THEN NULL ELSE token_aprovacao_tripulante_1 END, token_aprovacao_tripulante_2 = CASE WHEN ? = 'ajuste_necessario' THEN NULL ELSE token_aprovacao_tripulante_2 END,
        atualizado_em = CURRENT_TIMESTAMP WHERE id = ?
          AND (? = 0 OR lower(COALESCE(status, 'rascunho')) = 'rascunho')
          AND (? = 0 OR NOT EXISTS (SELECT 1 FROM relatorio_despesa_viagem outro WHERE upper(trim(outro.numero_relatorio)) = upper(?) AND outro.id <> ?))`)
      .bind(numero || null, numeroVoo, clienteId, socioId, aeronaveId, aeronave.matricula_registro || null,
        rota, dataInicio, dataFim,
        body.quantidade_dias != null ? Number(body.quantidade_dias) : null, tripulacaoId || null, nomeTripulante || null,
        body.tripulante_id_2 || null, body.nome_tripulante_2 || null, body.observacoes || null, despesas, novoStatus,
        Number(body.total_valor || 0), Number(body.total_combustivel || 0), Number(body.total_hospedagem || 0), Number(body.total_alimentacao || 0),
        Number(body.total_transporte || 0), Number(body.total_outros || 0), Number(body.total_tripulacao || 0), Number(body.total_tripulante_1 || 0),
        Number(body.total_tripulante_2 || 0), Number(body.total_cliente || 0), Number(body.total_sharebrasil || 0), documentoDependenteAlterado ? 1 : 0, statusAtual, documentoDependenteAlterado ? 1 : 0, statusAtual, statusAtual, statusAtual, statusAtual, statusAtual, statusAtual, statusAtual, statusAtual, statusAtual, statusAtual, id,
        numero && numero !== numeroAnterior ? 1 : 0, numero && numero !== numeroAnterior ? 1 : 0, numero || numeroAnterior, id).run()
    if (!updateResult.meta.changes) return c.json({ error: numero && numero !== numeroAnterior ? 'numero_relatorio_ja_utilizado_ou_relatorio_alterado' : 'relatorio_alterado_concorrente' }, 409)
    if (despesasNovas) {
      const despesaIdPorIndiceAntigo = new Map(despesasAnteriores.map((despesa, index) => [index, String(despesa.id)]))
      const novoIndicePorDespesaId = new Map(despesasNovas.map((despesa, index) => [String(despesa.id), index]))
      const anexos = await db.prepare(`SELECT id, indice_despesa FROM relatorio_despesa_viagem_anexos WHERE relatorio_despesa_viagem_id = ?1`).bind(id).all<{ id: string; indice_despesa: number }>()
      const atualizacoesAnexos = (anexos.results || []).flatMap((anexo) => {
        const despesaId = despesaIdPorIndiceAntigo.get(Number(anexo.indice_despesa))
        const novoIndice = despesaId === undefined ? undefined : novoIndicePorDespesaId.get(despesaId)
        const indiceDestino = novoIndice ?? -1
        return indiceDestino === Number(anexo.indice_despesa)
          ? []
          : [db.prepare('UPDATE relatorio_despesa_viagem_anexos SET indice_despesa = ?1 WHERE id = ?2 AND relatorio_despesa_viagem_id = ?3').bind(indiceDestino, anexo.id, id)]
      })
      if (atualizacoesAnexos.length) await db.batch(atualizacoesAnexos)
    }
    if (numeroFoiAlterado) {
      await db.prepare(`INSERT INTO auditoria_financeira (id, entidade, entidade_id, operacao, usuario_id, motivo)
        VALUES (?1, 'relatorio_despesa_viagem', ?2, 'ALTERACAO_NUMERO_RELATORIO', ?3, ?4)`).bind(
        uuid(), id, user.id, JSON.stringify({ numero_anterior: numeroAnterior, numero_novo: numeroRecebido, usuario_id: user.id, alterado_em: new Date().toISOString() }),
      ).run()
    }
    if (identificadoresAlterados) {
      await db.prepare(`INSERT INTO auditoria_financeira (id, entidade, entidade_id, operacao, usuario_id, motivo)
        VALUES (?1, 'relatorio_despesa_viagem', ?2, 'ALTERACAO_IDENTIFICADORES', ?3, ?4)`).bind(
        uuid(), id, user.id, JSON.stringify({ numero_anterior: atual.numero_relatorio || null, numero_novo: numero || null, cliente_anterior: atual.cliente_id || null, cliente_novo: clienteId, socio_anterior: atual.socio_id || null, socio_novo: socioId, aeronave_anterior: atual.aeronave_id || null, aeronave_nova: aeronaveId }),
      ).run().catch((error) => log.warn('[relatorio-despesa-viagem:auditoria-numero]', error?.message || error))
    }
    if (documentoDependenteAlterado || numeroFoiAlterado) {
      if (atual.pdf_path) await shareBrasilBucket(c).delete(atual.pdf_path).catch(() => undefined)
      if (numeroFoiAlterado) {
        await db.prepare(`UPDATE lancamentos SET numero_doc = ?1,
          descricao = replace(descricao, ?2, ?3), observacoes = replace(observacoes, ?2, ?3),
          url_doc = NULL, atualizado_em = CURRENT_TIMESTAMP
          WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?4`).bind(
          numeroRecebido, numeroAnterior, numeroRecebido, id,
        ).run()
      } else {
        await db.prepare("UPDATE lancamentos SET url_doc = NULL, atualizado_em = CURRENT_TIMESTAMP WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1").bind(id).run()
      }
    }
    return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, id) })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:atualizar]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_atualizar_relatorio' }, 400)
  }
})
app.post('/api/financeiro/relatorios-despesa-viagem/:id/finalizar', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const id = c.req.param('id')
    const db = c.env.SHARE_DB
    const relatorio = await buscarRelatorioViagemComNomes(c, id)
    if (!relatorio) return c.notFound()
    if (!['rascunho', 'ajuste_necessario'].includes(statusRelatorioViagem(relatorio.status))) return c.json({ error: 'relatorio_ja_finalizado' }, 409)
    if (!despesasRelatorioViagem(relatorio.despesas).some((item: any) => Number(item?.valor ?? item?.amount) > 0)) return c.json({ error: 'relatorio_sem_despesas' }, 400)
    const numero = String(relatorio.numero_relatorio || '').trim()
    if (!numero) return c.json({ error: 'numero_relatorio_obrigatorio' }, 409)
    // O número é reservado na criação do rascunho e deve permanecer imutável.
    // Nunca gere outro número na finalização, pois outros rascunhos podem ter sido criados depois.
    const statusAtual = statusRelatorioViagem(relatorio.status)
    const statusFinalizado = statusAtual === 'ajuste_necessario' ? 'ajuste_concluido' : 'finalizado'
    const updateStatement = db.prepare(`UPDATE relatorio_despesa_viagem SET
      status = ?1,
      status_aprovacao_tripulante = CASE WHEN ?1 = 'ajuste_concluido' THEN 'pendente' ELSE status_aprovacao_tripulante END,
      status_aprovacao_tripulante_2 = CASE WHEN ?1 = 'ajuste_concluido' THEN 'pendente' ELSE status_aprovacao_tripulante_2 END,
      atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ?2 AND lower(COALESCE(status, 'rascunho')) = ?3`).bind(statusFinalizado, id, statusAtual)
    const result = statusAtual === 'ajuste_necessario'
      ? (await db.batch([
        ajusteAnteriorStatement(db, relatorio, 1),
        ajusteAnteriorStatement(db, relatorio, 2),
        updateStatement,
      ]))[2]
      : await updateStatement.run()
    if (!result.meta.changes) return c.json({ error: 'relatorio_alterado_concorrente' }, 409)
    return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, id) })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:finalizar]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_finalizar_relatorio' }, 400)
  }
})
app.post('/api/financeiro/relatorios-despesa-viagem/:id/voltar-rascunho', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    await validateWorkerSchema(c, [{ table: 'relatorio_despesa_viagem', columns: ['token_aprovacao_tripulante_1', 'token_aprovacao_tripulante_2'] }])
    const id = c.req.param('id')
    const db = c.env.SHARE_DB
    const atual = await db.prepare(`SELECT status, numero_relatorio, pdf_path, token_aprovacao_tripulante_1, token_aprovacao_tripulante_2
      FROM relatorio_despesa_viagem WHERE id = ?1`).bind(id).first<any>()
    if (!atual) return c.notFound()
    if (statusRelatorioViagem(atual.status) !== 'finalizado') return c.json({ error: 'somente_relatorios_finalizados_podem_voltar_a_rascunho' }, 409)
    if (atual.token_aprovacao_tripulante_1 || atual.token_aprovacao_tripulante_2) return c.json({ error: 'relatorio_com_token_de_aprovacao_nao_pode_voltar_a_rascunho' }, 409)
    const result = await db.prepare(`UPDATE relatorio_despesa_viagem SET status = 'rascunho',
      aprovado_tripulante_1_em = NULL, aprovado_tripulante_2_em = NULL, aprovado_tripulante_em = NULL,
      enviado_para_tripulante_em = NULL, enviado_para_tripulante_2_em = NULL, enviado_para_cliente_em = NULL,
      status_aprovacao_tripulante = NULL, status_aprovacao_tripulante_2 = NULL,
      motivo_reprovacao_tripulante_1 = NULL, motivo_reprovacao_tripulante_2 = NULL,
      pdf_url = NULL, pdf_path = NULL, atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ?1 AND lower(COALESCE(status, '')) = 'finalizado'
        AND COALESCE(trim(token_aprovacao_tripulante_1), '') = '' AND COALESCE(trim(token_aprovacao_tripulante_2), '') = ''`).bind(id).run()
    if (!result.meta.changes) return c.json({ error: 'relatorio_alterado_concorrente_ou_com_token_de_aprovacao' }, 409)
    await db.prepare(`INSERT INTO auditoria_financeira (id, entidade, entidade_id, operacao, usuario_id, motivo)
      VALUES (?1, 'relatorio_despesa_viagem', ?2, 'VOLTAR_RASCUNHO', ?3, ?4)`).bind(
      uuid(), id, user.id, JSON.stringify({ numero_relatorio: atual.numero_relatorio || null, usuario_id: user.id, alterado_em: new Date().toISOString() }),
    ).run()
    if (atual.pdf_path) await shareBrasilBucket(c).delete(atual.pdf_path).catch(() => undefined)
    await db.prepare("UPDATE lancamentos SET url_doc = NULL, atualizado_em = CURRENT_TIMESTAMP WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1").bind(id).run()
    return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, id) })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:voltar-rascunho]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_voltar_rascunho' }, 400)
  }
})
app.post('/api/financeiro/relatorios-despesa-viagem/:id/enviar-aprovacao', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    await validateWorkerSchema(c, [{ table: 'relatorio_despesa_viagem', columns: ['token_aprovacao_tripulante_1', 'token_aprovacao_tripulante_2', 'aprovado_tripulante_1_em', 'motivo_reprovacao_tripulante_1', 'motivo_reprovacao_tripulante_2'] }])
    const id = c.req.param('id')
    const body = await c.req.json<{ tripulante_pos?: 1 | 2 }>().catch(() => ({} as { tripulante_pos?: 1 | 2 }))
    const pos = body.tripulante_pos === 2 ? 2 : 1
    const tokenColumn = pos === 1 ? 'token_aprovacao_tripulante_1' : 'token_aprovacao_tripulante_2'
    const sentColumn = pos === 1 ? 'enviado_para_tripulante_em' : 'enviado_para_tripulante_2_em'
    const relatorio = await buscarRelatorioViagemComNomes(c, id)
    if (!relatorio) return c.notFound()
    if (statusRelatorioViagem(relatorio.status) === 'rascunho') return c.json({ error: 'relatorio_precisa_ser_finalizado' }, 409)
    const tripulanteId = pos === 1 ? relatorio.tripulacao_id : relatorio.tripulante_id_2
    if (!tripulanteId) return c.json({ error: 'tripulante_nao_informado' }, 400)
    const tokenAtual = String(relatorio[tokenColumn] || '').trim()
    const novoToken = tokenAtual || crypto.randomUUID()
    const envio = await c.env.SHARE_DB.prepare(`UPDATE relatorio_despesa_viagem SET ${tokenColumn} = COALESCE(NULLIF(trim(${tokenColumn}), ''), ?), ${sentColumn} = COALESCE(NULLIF(trim(${sentColumn}), ''), CURRENT_TIMESTAMP), status = CASE WHEN status IN ('finalizado', 'ajuste_concluido') THEN 'aguardando_aprovacao' ELSE status END, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND lower(COALESCE(status, '')) IN ('finalizado', 'ajuste_concluido', 'aguardando_aprovacao')`).bind(novoToken, id).run()
    if (!envio.meta.changes) return c.json({ error: 'relatorio_nao_pode_ser_enviado_para_aprovacao' }, 409)
    const dadosEnvio = await c.env.SHARE_DB.prepare(`SELECT numero_relatorio, ${tokenColumn} AS token FROM relatorio_despesa_viagem WHERE id = ?1`).bind(id).first<{ numero_relatorio: string; token: string }>()
    if (!dadosEnvio?.token) return c.json({ error: 'token_de_aprovacao_nao_persistido' }, 500)
    const token = dadosEnvio.token
    const numeroRelatorio = encodeURI(String(dadosEnvio.numero_relatorio || ''))
    const link = `https://gestao.share-brasil.com/aprovar-relatorio?${numeroRelatorio}#${encodeURIComponent(token)}`
    const mensagem = `Olá tripulante, segue a sua despesa de viagem para aprovação\n\n${link}`
    return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, id), token, link, mensagem })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:enviar-aprovacao]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_enviar_aprovacao' }, 400)
  }
})
app.get('/api/public/relatorios-despesa-viagem/aprovacao/:token', async c => {
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const token = c.req.param('token')
    const row = await c.env.SHARE_DB.prepare(`SELECT r.*, a.matricula_registro AS aeronave_matricula,
      CASE WHEN r.token_aprovacao_tripulante_1 = ?1 THEN 1 ELSE 2 END AS tripulante_pos
      FROM relatorio_despesa_viagem r LEFT JOIN aeronave a ON a.id = r.aeronave_id
      WHERE r.token_aprovacao_tripulante_1 = ?1 OR r.token_aprovacao_tripulante_2 = ?1 LIMIT 1`).bind(token).first<any>()
    if (!row) return c.json({ error: 'link_invalido_ou_expirado' }, 404)
    const despesas = despesasRelatorioViagem(row.despesas)
    const valor = (item: any) => Number(item?.valor ?? item?.amount ?? 0) || 0
    const pagador = (item: any) => String(item?.pago_por || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_')
    const totais = despesas.reduce((acc: { tripulante: number; cliente: number; sharebrasil: number }, item: any) => {
      const quem = pagador(item)
      if (quem === `tripulante_${row.tripulante_pos}` || quem === `tripulante${row.tripulante_pos}`) acc.tripulante += valor(item)
      if (quem === 'cliente' || quem === 'client') acc.cliente += valor(item)
      if (quem === 'share' || quem === 'sharebrasil' || quem === 'share_brasil') acc.sharebrasil += valor(item)
      return acc
    }, { tripulante: 0, cliente: 0, sharebrasil: 0 })
    const anexos = await c.env.SHARE_DB.prepare('SELECT id, relatorio_despesa_viagem_id, indice_despesa, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em FROM relatorio_despesa_viagem_anexos WHERE relatorio_despesa_viagem_id = ?1 ORDER BY indice_despesa, criado_em').bind(row.id).all()
    const comprovantes = (anexos.results || []).map((anexo: any) => ({ ...anexo, url_arquivo: `/api/public/relatorios-despesa-viagem/aprovacao/${encodeURIComponent(token)}/comprovantes/${encodeURIComponent(anexo.id)}` }))
    return c.json({ relatorio: { ...row, despesas, anexos: comprovantes }, resumo: { total_a_receber: totais.tripulante, cliente_pagou: totais.cliente, share_brasil_pagou: totais.sharebrasil }, tripulante_pos: row.tripulante_pos })
  } catch (error: any) { return c.json({ error: error?.message || 'falha_ao_consultar_aprovacao' }, 400) }
})

app.get('/api/public/relatorios-despesa-viagem/aprovacao/:token/pdf', async c => {
  try {
    const token = c.req.param('token')
    const row = await c.env.SHARE_DB.prepare(`SELECT r.pdf_path, r.numero_relatorio
      FROM relatorio_despesa_viagem r
      WHERE r.pdf_path IS NOT NULL
        AND (r.token_aprovacao_tripulante_1 = ?1 OR r.token_aprovacao_tripulante_2 = ?1)
      LIMIT 1`).bind(token).first<{ pdf_path: string; numero_relatorio: string | null }>()
    if (!row?.pdf_path) return c.notFound()
    const object = await shareBrasilBucket(c).get(row.pdf_path)
    if (!object) return c.notFound()
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${shareBrasilFileName(row.numero_relatorio || 'relatorio')}.pdf"`,
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:pdf-publico]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_carregar_pdf' }, 500)
  }
})

app.get('/api/public/relatorios-despesa-viagem/aprovacao/:token/comprovantes/:anexoId', async c => {
  try {
    const token = c.req.param('token')
    const anexo = await c.env.SHARE_DB.prepare(`SELECT a.caminho_arquivo, a.nome_arquivo, a.tipo_arquivo
      FROM relatorio_despesa_viagem_anexos a JOIN relatorio_despesa_viagem r ON r.id = a.relatorio_despesa_viagem_id
      WHERE a.id = ?1 AND (r.token_aprovacao_tripulante_1 = ?2 OR r.token_aprovacao_tripulante_2 = ?2)`).bind(c.req.param('anexoId'), token).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string | null }>()
    if (!anexo) return c.notFound()
    const object = await shareBrasilBucket(c).get(anexo.caminho_arquivo)
    if (!object) return c.notFound()
    return new Response(object.body, { headers: { 'Content-Type': anexo.tipo_arquivo || 'application/octet-stream', 'Content-Disposition': `inline; filename="${shareBrasilFileName(anexo.nome_arquivo)}"` } })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:comprovante-publico]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_carregar_comprovante' }, 500)
  }
})
app.post('/api/financeiro/relatorios-despesa-viagem/:id/aprovacao', async c => {
  const userId = await getAuthenticatedUserId(c)
  if (!userId) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const id = c.req.param('id')
    let body: { tripulante_pos?: 1 | 2; aprovado?: boolean; observacoes?: string; anexo_rejeicao?: File | null }
    if ((c.req.header('content-type') || '').includes('multipart/form-data')) {
      const form = await c.req.formData()
      const arquivo: unknown = form.get('anexo_rejeicao')
      const rawAprovado = form.get('aprovado')
      body = {
        tripulante_pos: form.get('tripulante_pos') === '2' ? 2 : 1,
        aprovado: rawAprovado === 'true' ? true : rawAprovado === 'false' ? false : undefined,
        observacoes: String(form.get('observacoes') || ''),
        anexo_rejeicao: arquivo instanceof File && arquivo.size > 0 ? arquivo : null,
      }
    } else {
      body = await c.req.json().catch(() => ({} as any))
    }
    const pos = body.tripulante_pos === 2 ? 2 : 1
    const report = await c.env.SHARE_DB.prepare(`SELECT r.*, t1.user_id AS user1_id, t2.user_id AS user2_id FROM relatorio_despesa_viagem r LEFT JOIN tripulacao t1 ON t1.id = r.tripulacao_id LEFT JOIN tripulacao t2 ON t2.id = r.tripulante_id_2 WHERE r.id = ?1`).bind(id).first<any>()
    if (!report) return c.notFound()
    if ((pos === 1 ? report.user1_id : report.user2_id) !== userId) return c.json({ error: 'tripulante_nao_autorizado_para_este_relatorio' }, 403)
    const approvalStatus = String(pos === 1 ? report.status_aprovacao_tripulante || '' : report.status_aprovacao_tripulante_2 || '').toLowerCase()
    const reportStatus = statusRelatorioViagem(report.status)
    const pendingAdjustment = reportStatus === 'ajuste_concluido' && approvalStatus === 'pendente'
    const retryApprovedSync = body.aprovado === true && approvalStatus === 'aprovado' && reportStatus === 'aprovado'
    if (!retryApprovedSync && (!(reportStatus === 'aguardando_aprovacao' || pendingAdjustment) || ['aprovado', 'reprovado'].includes(approvalStatus))) {
      return c.json({ error: 'relatorio_nao_esta_pendente_de_aprovacao' }, 409)
    }
    if (body.aprovado === undefined) return c.json({ error: 'decisao_obrigatoria' }, 400)
    if (!body.aprovado && !String(body.observacoes || '').trim()) return c.json({ error: 'motivo_obrigatorio_para_rejeicao' }, 400)
    if (body.aprovado && body.anexo_rejeicao) return c.json({ error: 'anexo_rejeicao_apenas_para_recusa' }, 400)
    if (body.anexo_rejeicao && (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(body.anexo_rejeicao.type.toLowerCase()) || body.anexo_rejeicao.size > 5 * 1024 * 1024)) {
      return c.json({ error: 'imagem_invalida_limite_5mb_jpg_png_webp_heic' }, 415)
    }
    const statusColumn = pos === 1 ? 'status_aprovacao_tripulante' : 'status_aprovacao_tripulante_2'
    const dateColumn = pos === 1 ? 'aprovado_tripulante_1_em' : 'aprovado_tripulante_2_em'
    const reasonColumn = pos === 1 ? 'motivo_reprovacao_tripulante_1' : 'motivo_reprovacao_tripulante_2'
    const decision = body.aprovado ? 'aprovado' : 'reprovado'
    const nextTripulante1Status = pos === 1 ? decision : report.status_aprovacao_tripulante
    const nextTripulante2Status = pos === 2 ? decision : report.status_aprovacao_tripulante_2
    const requiredSecond = requerAprovacaoTripulanteRelatorio(report.despesas, 2)
    const nextReportStatus = decision === 'reprovado'
      ? 'ajuste_necessario'
      : nextTripulante1Status === 'aprovado' && (!requiredSecond || nextTripulante2Status === 'aprovado')
        ? 'aprovado'
        : 'aguardando_aprovacao'
    const segundoAplicavel = requerAprovacaoTripulanteRelatorio(report.despesas, 2)
    let anexosRejeicaoJson: string | null = null
    let anexoHistorico: any[] = []
    if (!body.aprovado && body.anexo_rejeicao) {
      const arquivo = body.anexo_rejeicao
      const anexoId = uuid()
      const caminho = await salvarArquivoShareBrasil(c, userId, arquivo, `relatorio_despesa_viagem/anexos_notas/${id}`)
      const metadataAnexo = { id: anexoId, nome_arquivo: shareBrasilFileName(arquivo.name), tipo_arquivo: arquivo.type, tamanho_arquivo: arquivo.size, criado_em: new Date().toISOString() }
      anexoHistorico = [metadataAnexo]
      anexosRejeicaoJson = JSON.stringify([
        ...parseRejectionAttachments(report.anexos_rejeicao),
        { ...metadataAnexo, caminho_arquivo: caminho },
      ])
    }
    if (!retryApprovedSync) {
      const updateStatement = c.env.SHARE_DB.prepare(`UPDATE relatorio_despesa_viagem SET ${statusColumn} = ?, ${dateColumn} = CASE WHEN ? = 'aprovado' THEN COALESCE(${dateColumn}, CURRENT_TIMESTAMP) ELSE NULL END, aprovado_tripulante_em = CASE WHEN ? = 1 AND ? = 'aprovado' THEN COALESCE(aprovado_tripulante_em, CURRENT_TIMESTAMP) WHEN ? = 1 THEN NULL ELSE aprovado_tripulante_em END, ${reasonColumn} = CASE WHEN ? = 'reprovado' THEN ? ELSE ${reasonColumn} END, status_aprovacao_tripulante_2 = CASE WHEN ? = 0 AND ? = 'aprovado' THEN 'nao_aplicavel' ELSE status_aprovacao_tripulante_2 END, status = ?, anexos_rejeicao = COALESCE(?, anexos_rejeicao), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(decision, decision, pos, decision, pos, decision, body.observacoes?.trim() || null, segundoAplicavel ? 1 : 0, decision, nextReportStatus, anexosRejeicaoJson, id)
      if (decision === 'reprovado') {
        await c.env.SHARE_DB.batch([...historicoAjusteStatements(c.env.SHARE_DB, report, pos, String(body.observacoes || '').trim(), anexoHistorico), updateStatement])
      } else {
        await updateStatement.run()
      }
    }
    const updated = await buscarRelatorioViagemComNomes(c, id)
    if (!updated) return c.notFound()
    if (body.aprovado && updated.status === 'aprovado') {
      try {
        const dataVencimentoReembolso = calcularVencimentoReembolsoTripulante(updated)
        await persistirMetadadosFinanceirosRelatorio(c.env.SHARE_DB, id, userId, null, false, dataVencimentoReembolso)
        await sincronizarRelatorioViagemFinanceiro(c.env.SHARE_DB, { ...updated, data_vencimento_reembolso: dataVencimentoReembolso }, userId)
        await persistirMetadadosFinanceirosRelatorio(c.env.SHARE_DB, id, userId, null, false, dataVencimentoReembolso)
      } catch (error: any) {
        log.error('[relatorio-despesa-viagem:aprovacao-direta-financeiro]', error?.message || error)
        return c.json({ error: 'aprovacao_registrada_falha_conta_a_pagar', message: 'A aprovação foi registrada, mas a conta a pagar não pôde ser gerada. Reenvie a aprovação para tentar novamente.' }, 500)
      }
    }
    if (!body.aprovado && !retryApprovedSync) await notifyReportRejection(c, updated, String(body.observacoes || '').trim(), userId)
    return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, id) })
  } catch (error: any) { log.error('[relatorio-despesa-viagem:aprovacao-direta]', error?.message || error); return c.json({ error: error?.message || 'falha_ao_decidir_aprovacao' }, 400) }
})
app.get('/api/financeiro/relatorios-despesa-viagem/:id/programacao-reembolso', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare(`SELECT r.id, r.numero_relatorio, r.total_valor, r.total_cliente, r.despesas, r.aeronave_id,
    a.matricula_registro AS aeronave_matricula, r.cliente_id, r.socio_id, r.data_vencimento_reembolso, r.pdf_url, r.pdf_path, r.status
    FROM relatorio_despesa_viagem r LEFT JOIN aeronave a ON a.id = r.aeronave_id WHERE r.id = ?`).bind(c.req.param('id')).first<any>()
  if (!row) return c.notFound()
  const statusAtual = statusRelatorioViagem(row.status)
  const segundoAplicavel = requerAprovacaoTripulanteRelatorio(row.despesas, 2)
  if (statusAtual !== 'aprovado') {
    if (!segundoAplicavel && statusRelatorioViagem(row.status) === 'aguardando_aprovacao' && String(row.status_aprovacao_tripulante || '').toLowerCase() === 'aprovado') {
      await c.env.SHARE_DB.prepare("UPDATE relatorio_despesa_viagem SET status = 'aprovado', status_aprovacao_tripulante_2 = 'nao_aplicavel', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?1").bind(row.id).run()
    } else {
      return c.json({ error: 'aguarde_aprovacao_de_todos_os_tripulantes' }, 409)
    }
  }
  const relatorioAprovado = await buscarRelatorioViagemComNomes(c, row.id)
  if (!relatorioAprovado) return c.notFound()
  try {
    const dataVencimentoReembolso = calcularVencimentoReembolsoTripulante(relatorioAprovado)
    await persistirMetadadosFinanceirosRelatorio(c.env.SHARE_DB, row.id, user.id, null, false, dataVencimentoReembolso)
    await sincronizarRelatorioViagemFinanceiro(c.env.SHARE_DB, { ...relatorioAprovado, data_vencimento_reembolso: dataVencimentoReembolso }, user.id)
    await persistirMetadadosFinanceirosRelatorio(c.env.SHARE_DB, row.id, user.id, null, false, dataVencimentoReembolso)
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:programacao-financeira]', error?.message || error)
    return c.json({ error: 'aprovacao_registrada_falha_conta_a_pagar', message: 'O relatório está aprovado, mas a conta a pagar não pôde ser gerada. Tente novamente.' }, 500)
  }
  return c.json({ descricao: `Relatório Despesa de Viagem - ${row.numero_relatorio}`, valor: Math.max(0, Number(row.total_valor || 0) - Number(row.total_cliente || 0)), fornecedor: 'Share Brasil', grupo_categoria_id: 'b4016b98-7b4c-4f18-9f8d-d7b03cd4d300', subcategoria: 'RELATORIO DE VIAGEM', aeronave_id: row.aeronave_id, aeronave_matricula: row.aeronave_matricula, cliente_id: row.cliente_id, socio_id: row.socio_id, data_vencimento_reembolso: row.data_vencimento_reembolso || null, periodicidade: 'EVENTUAL', tipo_rateio: 'VARIAVEL POR VOO', pdf_url: row.pdf_url, pdf_path: row.pdf_path })
})
app.post('/api/financeiro/relatorios-despesa-viagem/:id/enviar-cliente', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    const id = c.req.param('id'); const body = await c.req.json<{ data_vencimento?: string; periodicidade?: string; tipo_rateio?: string; email_enviado_id?: string }>().catch(() => ({} as any))
    if (!body.data_vencimento) return c.json({ error: 'data_vencimento_obrigatoria' }, 400)
    const report = await c.env.SHARE_DB.prepare('SELECT * FROM relatorio_despesa_viagem WHERE id = ?').bind(id).first<any>()
    if (!report) return c.notFound()
    if (!['aprovado', 'enviado_cliente'].includes(statusRelatorioViagem(report.status))) return c.json({ error: 'aguarde_aprovacao_de_todos_os_tripulantes' }, 409)
    if (!report.pdf_path) return c.json({ error: 'pdf_obrigatorio_antes_do_envio' }, 409)
    const db = c.env.SHARE_DB
    const cotista = await db.prepare(`SELECT id FROM cotista_aeronave WHERE aeronave_id = ?1
      AND ((?2 IS NOT NULL AND socio_id = ?2) OR (?3 IS NOT NULL AND cliente_id = ?3))
      ORDER BY CASE WHEN ?2 IS NOT NULL AND socio_id = ?2 THEN 0 ELSE 1 END LIMIT 1`)
      .bind(report.aeronave_id, report.socio_id || null, report.cliente_id || null).first<{ id: string }>()
    if (!cotista?.id) return c.json({ error: 'cotista_aeronave_nao_encontrado_para_o_relatorio' }, 409)
    const clienteIdLancamentoFk = await findLancamentoClientId(db, report.cliente_id)
    const categoria = await db.prepare(`SELECT id FROM categoria_movimentacao_share
      WHERE id = ?1 OR upper(COALESCE(nome, '')) = upper(?2) LIMIT 1`)
      .bind('b4016b98-7b4c-4f18-9f8d-d7b03cd4d300', 'RELATORIO DE VIAGEM').first<{ id: string }>()
    if (!categoria?.id) return c.json({ error: 'categoria_relatorio_viagem_nao_encontrada' }, 409)
    const valorCentavos = Math.round((Number(report.total_valor || 0) - Number(report.total_cliente || 0)) * 100)
    if (valorCentavos <= 0) return c.json({ error: 'relatorio_sem_valor_a_reembolsar' }, 400)
    const hoje = new Date().toISOString().slice(0, 10)
    const numeroVooId = report.numero_voo
      ? (await db.prepare('SELECT id FROM solicitacoes_reserva_voo WHERE numero_voo = ?1 LIMIT 1').bind(report.numero_voo).first<{ id: string }>())?.id || null
      : null
    const descricao = `Relatório Despesa de Viagem - ${report.numero_relatorio}`
    const categoriaId = categoria.id
    const shareLancamentoId = crypto.randomUUID(); const clienteLancamentoId = crypto.randomUUID(); const contaId = crypto.randomUUID()
    const periodicidade = 'EVENTUAL'; const tipoRateio = body.tipo_rateio || 'VARIAVEL POR VOO'
    const idempotencyBase = `RELATORIO_DESPESA_VIAGEM:${id}:REEMBOLSO_CLIENTE`
    if (report.socio_id) {
      const socio = await db.prepare('SELECT holding_id FROM hold_socios WHERE id = ?1 LIMIT 1').bind(report.socio_id).first<{ holding_id: string | null }>()
      if (!socio?.holding_id) return c.json({ error: 'holding_do_socio_nao_encontrada' }, 409)

      const movimentoExistente = await db.prepare(`SELECT fv.destino_id AS id
        FROM financeiro_vinculos fv INNER JOIN movimentos_holding mh ON mh.id = fv.destino_id
        WHERE fv.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND fv.origem_id = ?1
          AND fv.destino_tipo = 'MOVIMENTO_HOLDING' LIMIT 1`).bind(id).first<{ id: string }>()
      const movimentoId = movimentoExistente?.id || crypto.randomUUID()
      const statements: D1PreparedStatement[] = []
      if (!movimentoExistente) {
        statements.push(db.prepare(`INSERT INTO movimentos_holding
          (id, holding_id, socio_id, aeronave_id, periodicidade, tipo_caixa, data_emissao, data_vencimento, descricao, categoria_id, categoria_nome, grupo_categoria, fluxo, valor_centavos, status, pago_diretamente, url_doc, observacoes, criado_por)
          VALUES (?, ?, ?, ?, ?, 'HOLD', ?, ?, ?, ?, 'RELATORIO DE VIAGEM', 'DESPESAS DE VIAGEM', 'SAIDA', ?, 'EM_ABERTO', 0, ?, ?, ?)`)
          .bind(movimentoId, socio.holding_id, report.socio_id, report.aeronave_id, periodicidade, hoje, body.data_vencimento, descricao, categoriaId, valorCentavos, report.pdf_path || null, `Origem: relatório ${report.numero_relatorio}`, user.id))
        statements.push(db.prepare(`INSERT OR IGNORE INTO financeiro_vinculos (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
          VALUES (?, 'RELATORIO_DESPESA_VIAGEM', ?, 'MOVIMENTO_HOLDING', ?, 'RELATORIO_MOVIMENTO_HOLDING')`).bind(crypto.randomUUID(), id, movimentoId))
      }
      if (body.email_enviado_id) {
        statements.push(db.prepare(`UPDATE movimentos_holding
          SET email_enviado_id = ?, email_enviado_em = COALESCE(email_enviado_em, CURRENT_TIMESTAMP)
          WHERE id = ?`).bind(body.email_enviado_id, movimentoId))
      }
      const holdingReceivable = await ensureRelatorioContaAReceber(db, {
        reportId: id,
        cotistaId: cotista.id,
        values: {
          id: contaId,
          data_vencimento: body.data_vencimento,
          valor_centavos: valorCentavos,
          categoria_id: categoria.id,
          categoria_nome: 'RELATORIO DE VIAGEM',
          descricao,
          aeronave_id: report.aeronave_id,
          movimentos_id: movimentoId,
          lancamentos_id: null,
          status: 'EM_ABERTO',
          criado_por: user.id,
        },
        communicated: true,
      })
      if (holdingReceivable.status === 'reconciliation_required') return c.json({ error: 'conciliacao_conta_receber_necessaria', conta_receber_ids: holdingReceivable.ids }, 409)
      if (holdingReceivable.status === 'cancelled') return c.json({ error: 'conta_receber_cancelada', conta_receber_ids: holdingReceivable.ids }, 409)
      const contaIdHolding = holdingReceivable.id
      statements.push(holdingReceivable.statement)
      statements.push(...repairRelatorioContaReceberLinkStatements(db, id, cotista.id))
      statements.push(db.prepare("UPDATE relatorio_despesa_viagem SET status = 'enviado_cliente', data_vencimento_reembolso = ?, enviado_para_cliente_em = COALESCE(enviado_para_cliente_em, CURRENT_TIMESTAMP), programado_pagamento_em = COALESCE(programado_pagamento_em, CURRENT_TIMESTAMP), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").bind(body.data_vencimento, id))
      await db.batch(statements)
      const contaHoldingPersistida = await db.prepare(`SELECT id FROM contas_areceber
        WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ? AND cotista_id = ?
          AND UPPER(COALESCE(status, '')) <> 'CANCELADO' LIMIT 1`).bind(id, cotista.id).first<{ id: string }>()
      const recebivelHoldingCriado = holdingReceivable.status === 'created' && contaHoldingPersistida?.id === holdingReceivable.id
      await persistirMetadadosFinanceirosRelatorio(db, id, user.id, body.email_enviado_id || null, true, body.data_vencimento)
      return c.json({ success: true, status: 'enviado_cliente', conta_receber_id: contaHoldingPersistida?.id || contaIdHolding, movimento_holding_id: movimentoId, relatorio: await buscarRelatorioViagemComNomes(c, id), message: recebivelHoldingCriado ? 'Reembolso programado ao cliente.' : 'Reembolso já enviado ao cliente.' })
    }
    const clienteKey = `${idempotencyBase}:LANCAMENTO_CLIENTE`
    const shareKey = `${idempotencyBase}:LANCAMENTO_SHARE`
    const existingClientLancamento = await db.prepare('SELECT id FROM lancamentos WHERE idempotency_key = ? LIMIT 1').bind(clienteKey).first<{ id: string }>()
    const existingShareLancamento = await db.prepare('SELECT id FROM lancamentos WHERE idempotency_key = ? LIMIT 1').bind(shareKey).first<{ id: string }>()
    const clienteLancamentoFinalId = existingClientLancamento?.id || clienteLancamentoId
    const shareLancamentoFinalId = existingShareLancamento?.id || shareLancamentoId
    const receivable = await ensureRelatorioContaAReceber(db, {
      reportId: id,
      cotistaId: cotista.id,
      values: {
        id: contaId,
        data_vencimento: body.data_vencimento,
        valor_centavos: valorCentavos,
        categoria_id: categoria.id,
        categoria_nome: 'RELATORIO DE VIAGEM',
        descricao,
        aeronave_id: report.aeronave_id,
        lancamentos_id: shareLancamentoFinalId,
        movimentos_id: null,
        status: 'EM_ABERTO',
        criado_por: user.id,
      },
      communicated: true,
    })
    if (receivable.status === 'reconciliation_required') return c.json({ error: 'conciliacao_conta_receber_necessaria', conta_receber_ids: receivable.ids }, 409)
    if (receivable.status === 'cancelled') return c.json({ error: 'conta_receber_cancelada', conta_receber_ids: receivable.ids }, 409)
    const statements: D1PreparedStatement[] = [receivable.statement]
    statements.push(...repairRelatorioContaReceberLinkStatements(db, id, cotista.id))
    if (!existingClientLancamento) statements.push(db.prepare(`INSERT INTO lancamentos (id, aeronave_id, cotista_aeronave_id, cliente_id, data_emissao, data_vencimento, descricao, categoria_cliente_id, categoria_nome, grupo_categoria, periodicidade, status, fluxo, tipo_caixa, valor_centavos, pago_por, pago_diretamente, reembolsavel, reembolso_quitado, observacoes, criado_por, origem_tipo, origem_id, idempotency_key, url_doc, numero_doc, numero_voo, fornecedor_nome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EM_ABERTO', 'SAIDA', 'CLIENTE', ?, NULL, 0, 0, 0, ?, ?, 'RELATORIO_DESPESA_VIAGEM', ?, ?, ?, ?, ?, ?)`).bind(clienteLancamentoFinalId, report.aeronave_id, cotista.id, clienteIdLancamentoFk, hoje, body.data_vencimento, descricao, 'b4016b98-7b4c-4f18-9f8d-d7b03cd4d300', 'DESPESAS DE VIAGEM', 'CAIXA CLIENTE', periodicidade, valorCentavos, `Tipo de rateio: ${tipoRateio}`, user.id, id, clienteKey, report.pdf_path || null, report.numero_relatorio, numeroVooId, 'SHARE BRASIL'))
    if (!existingShareLancamento) statements.push(db.prepare(`INSERT INTO lancamentos (id, aeronave_id, cotista_aeronave_id, cliente_id, data_emissao, data_vencimento, descricao, categoria_share_id, categoria_nome, grupo_categoria, periodicidade, status, fluxo, tipo_caixa, valor_centavos, pago_por, pago_diretamente, reembolsavel, reembolso_quitado, observacoes, criado_por, origem_tipo, origem_id, idempotency_key, escopo_financeiro, url_doc, numero_doc, numero_voo, fornecedor_nome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EM_ABERTO', 'ENTRADA', 'SHARE', ?, NULL, 0, 0, 0, ?, ?, 'RELATORIO_DESPESA_VIAGEM', ?, ?, 'CAIXA_SHARE', ?, ?, ?, ?)`).bind(shareLancamentoFinalId, report.aeronave_id, cotista.id, clienteIdLancamentoFk, hoje, body.data_vencimento, descricao, 'a7555994-103d-4739-96a5-001c3bec1424', 'REEMBOLSO RELATORIO DE DESPESA DE VIAGENS recebido', 'REEMBOLSOS ENTRADAS', periodicidade, valorCentavos, `Tipo de rateio: ${tipoRateio}`, user.id, id, shareKey, report.pdf_path || null, report.numero_relatorio, numeroVooId, 'SHARE BRASIL'))
    statements.push(db.prepare("UPDATE lancamentos SET escopo_financeiro = 'CAIXA_SHARE' WHERE id = ?").bind(shareLancamentoFinalId))
    if (body.email_enviado_id) statements.push(db.prepare(`UPDATE lancamentos SET email_enviado_id = ?, email_enviado_em = COALESCE(email_enviado_em, CURRENT_TIMESTAMP) WHERE idempotency_key IN (?, ?)`).bind(body.email_enviado_id, clienteKey, shareKey))
    statements.push(db.prepare("UPDATE lancamentos SET cotista_aeronave_id = ?, cliente_id = ?, periodicidade = 'EVENTUAL', fornecedor_nome = ?, numero_doc = ?, numero_voo = ?, data_vencimento = ?, url_doc = ?, pago_por = NULL, grupo_categoria = CASE WHEN tipo_caixa = 'CLIENTE' THEN 'CAIXA CLIENTE' ELSE grupo_categoria END WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?").bind(cotista.id, clienteIdLancamentoFk, 'SHARE BRASIL', report.numero_relatorio, numeroVooId, body.data_vencimento, report.pdf_path || null, id))
    statements.push(db.prepare("UPDATE relatorio_despesa_viagem SET status = 'enviado_cliente', data_vencimento_reembolso = ?, enviado_para_cliente_em = COALESCE(enviado_para_cliente_em, CURRENT_TIMESTAMP), programado_pagamento_em = COALESCE(programado_pagamento_em, CURRENT_TIMESTAMP), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").bind(body.data_vencimento, id))
    await db.batch(statements)
    const contaReceberPersistida = await db.prepare(`SELECT id FROM contas_areceber
      WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ? AND cotista_id = ?
        AND UPPER(COALESCE(status, '')) <> 'CANCELADO' LIMIT 1`).bind(id, cotista.id).first<{ id: string }>()
    const recebivelCriado = receivable.status === 'created' && contaReceberPersistida?.id === receivable.id
    await persistirMetadadosFinanceirosRelatorio(db, id, user.id, body.email_enviado_id || null, true, body.data_vencimento)
    return c.json({ success: true, status: 'enviado_cliente', conta_receber_id: contaReceberPersistida?.id || receivable.id, lancamento_cliente_id: clienteLancamentoFinalId, lancamento_share_id: shareLancamentoFinalId, relatorio: await buscarRelatorioViagemComNomes(c, id), message: existingClientLancamento || existingShareLancamento || !recebivelCriado ? 'Reembolso já enviado ao cliente.' : 'Reembolso programado ao cliente.' })
  } catch (error: any) { log.error('[relatorio-despesa-viagem:enviar-cliente]', error?.message || error); return c.json({ error: error?.message || 'falha_ao_enviar_cliente' }, 400) }
})
app.post('/api/public/relatorios-despesa-viagem/aprovacao/:token', async c => {
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const token = c.req.param('token')
    const contentType = c.req.header('content-type') || ''
    let body: { aprovado?: boolean; motivo?: string; anexo_rejeicao?: File | null }
    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData()
      const rawAprovado = form.get('aprovado')
      const arquivo: unknown = form.get('anexo_rejeicao')
      body = {
        aprovado: rawAprovado === 'true' ? true : rawAprovado === 'false' ? false : undefined,
        motivo: String(form.get('motivo') || ''),
        anexo_rejeicao: arquivo instanceof File && arquivo.size > 0 ? arquivo : null,
      }
    } else {
      body = await c.req.json<{ aprovado?: boolean; motivo?: string }>().catch(() => ({} as { aprovado?: boolean; motivo?: string }))
    }
    if (body.aprovado === undefined) return c.json({ error: 'decisao_obrigatoria' }, 400)
    if (!body.aprovado && !String(body.motivo || '').trim()) return c.json({ error: 'motivo_obrigatorio_para_rejeicao' }, 400)
    if (body.aprovado && body.anexo_rejeicao) return c.json({ error: 'anexo_rejeicao_apenas_para_recusa' }, 400)
    if (body.anexo_rejeicao && (!['image/jpeg', 'image/png', 'image/webp'].includes(body.anexo_rejeicao.type) || body.anexo_rejeicao.size > 5 * 1024 * 1024)) {
      return c.json({ error: 'imagem_invalida_limite_5mb_jpg_png_webp' }, 415)
    }
    const row = await c.env.SHARE_DB.prepare(`SELECT r.*, t1.user_id AS user1_id, t2.user_id AS user2_id FROM relatorio_despesa_viagem r LEFT JOIN tripulacao t1 ON t1.id = r.tripulacao_id LEFT JOIN tripulacao t2 ON t2.id = r.tripulante_id_2 WHERE r.token_aprovacao_tripulante_1 = ?1 OR r.token_aprovacao_tripulante_2 = ?1 LIMIT 1`).bind(token).first<any>()
    if (!row) return c.json({ error: 'link_invalido_ou_expirado' }, 404)
    const pos = row.token_aprovacao_tripulante_1 === token ? 1 : 2
    const decidedBy = pos === 1 ? row.user1_id : row.user2_id || ''
    const statusColumn = pos === 1 ? 'status_aprovacao_tripulante' : 'status_aprovacao_tripulante_2'
    const dateColumn = pos === 1 ? 'aprovado_tripulante_1_em' : 'aprovado_tripulante_2_em'
    const reasonColumn = pos === 1 ? 'motivo_reprovacao_tripulante_1' : 'motivo_reprovacao_tripulante_2'
    const decision = body.aprovado ? 'aprovado' : 'reprovado'
    const currentApprovalStatus = String(pos === 1 ? row.status_aprovacao_tripulante || '' : row.status_aprovacao_tripulante_2 || '').toLowerCase()
    const reportStatus = statusRelatorioViagem(row.status)
    const pendingAdjustment = reportStatus === 'ajuste_concluido' && currentApprovalStatus === 'pendente'
    const retryApprovedSync = body.aprovado === true && currentApprovalStatus === 'aprovado' && reportStatus === 'aprovado'
    if (!retryApprovedSync && (!(reportStatus === 'aguardando_aprovacao' || pendingAdjustment) || ['aprovado', 'reprovado'].includes(currentApprovalStatus))) {
      return c.json({ error: 'relatorio_nao_esta_pendente_de_aprovacao' }, 409)
    }
    const nextTripulante1Status = pos === 1 ? decision : row.status_aprovacao_tripulante
    const nextTripulante2Status = pos === 2 ? decision : row.status_aprovacao_tripulante_2
    const requiredSecond = requerAprovacaoTripulanteRelatorio(row.despesas, 2)
    const nextReportStatus = decision === 'reprovado'
      ? 'ajuste_necessario'
      : nextTripulante1Status === 'aprovado' && (!requiredSecond || nextTripulante2Status === 'aprovado')
        ? 'aprovado'
        : 'aguardando_aprovacao'
    let anexosRejeicaoJson: string | null = null
    let anexoHistorico: any[] = []
    if (!body.aprovado && body.anexo_rejeicao) {
      const arquivo = body.anexo_rejeicao
      const anexosExistentes = Array.isArray(row.anexos_rejeicao) ? row.anexos_rejeicao : (() => {
        try { const parsed = JSON.parse(String(row.anexos_rejeicao || '[]')); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
      })()
      const anexoId = uuid()
      const caminho = await salvarArquivoShareBrasil(c, decidedBy || 'tripulante', arquivo, `relatorio_despesa_viagem/anexos_notas/${row.id}`)
      const metadataAnexo = { id: anexoId, nome_arquivo: shareBrasilFileName(arquivo.name), tipo_arquivo: arquivo.type, tamanho_arquivo: arquivo.size, criado_em: new Date().toISOString() }
      anexoHistorico = [metadataAnexo]
      anexosRejeicaoJson = JSON.stringify([...anexosExistentes, { ...metadataAnexo, caminho_arquivo: caminho }])
    }
    if (!retryApprovedSync) {
      const updateStatement = c.env.SHARE_DB.prepare(`UPDATE relatorio_despesa_viagem SET ${statusColumn} = ?, ${dateColumn} = CASE WHEN ? = 'aprovado' THEN COALESCE(${dateColumn}, CURRENT_TIMESTAMP) ELSE NULL END, aprovado_tripulante_em = CASE WHEN ? = 1 AND ? = 'aprovado' THEN COALESCE(aprovado_tripulante_em, CURRENT_TIMESTAMP) WHEN ? = 1 THEN NULL ELSE aprovado_tripulante_em END, ${reasonColumn} = CASE WHEN ? = 'reprovado' THEN ? ELSE ${reasonColumn} END, status_aprovacao_tripulante_2 = CASE WHEN ? = 0 AND ? = 'aprovado' THEN 'nao_aplicavel' ELSE status_aprovacao_tripulante_2 END, status = ?, anexos_rejeicao = COALESCE(?, anexos_rejeicao), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(decision, decision, pos, decision, pos, decision, body.motivo?.trim() || null, requiredSecond ? 1 : 0, decision, nextReportStatus, anexosRejeicaoJson, row.id)
      if (decision === 'reprovado') {
        await c.env.SHARE_DB.batch([...historicoAjusteStatements(c.env.SHARE_DB, row, pos, String(body.motivo || '').trim(), anexoHistorico), updateStatement])
      } else {
        await updateStatement.run()
      }
    }
    const updatedForNotification = await buscarRelatorioViagemComNomes(c, row.id)
    if (updatedForNotification) {
      if (!retryApprovedSync) {
        try {
          await notifyReportDecision(c, updatedForNotification, decision, String(body.motivo || '').trim(), decidedBy)
        } catch (error: any) {
          log.warn('[relatorio-despesa-viagem:aprovacao-publica-notificacao]', error?.message || error)
        }
      }
    }
    if (body.aprovado && updatedForNotification?.status === 'aprovado') {
      const updated = await buscarRelatorioViagemComNomes(c, row.id)
      if (!updated) return c.notFound()
      try {
        const dataVencimentoReembolso = calcularVencimentoReembolsoTripulante(updated)
        await persistirMetadadosFinanceirosRelatorio(c.env.SHARE_DB, row.id, extractSupabaseUserId(c), null, false, dataVencimentoReembolso)
        await sincronizarRelatorioViagemFinanceiro(c.env.SHARE_DB, { ...updated, data_vencimento_reembolso: dataVencimentoReembolso }, extractSupabaseUserId(c))
        await persistirMetadadosFinanceirosRelatorio(c.env.SHARE_DB, row.id, extractSupabaseUserId(c), null, false, dataVencimentoReembolso)
      } catch (error: any) {
        log.error('[relatorio-despesa-viagem:aprovacao-publica-financeiro]', error?.message || error)
        return c.json({ error: 'aprovacao_registrada_falha_conta_a_pagar', message: 'A aprovação foi registrada, mas a conta a pagar não pôde ser gerada. Reenvie a aprovação para tentar novamente.' }, 500)
      }
    }
    return c.json({ relatorio: await buscarRelatorioViagemComNomes(c, row.id), aprovado: body.aprovado })
  } catch (error: any) { log.error('[relatorio-despesa-viagem:aprovacao-publica]', error?.message || error); return c.json({ error: error?.message || 'falha_ao_decidir_aprovacao' }, 400) }
})
app.delete('/api/financeiro/relatorios-despesa-viagem/:id', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const result = await c.env.SHARE_DB.prepare("DELETE FROM relatorio_despesa_viagem WHERE id = ?1 AND lower(COALESCE(status, 'rascunho')) = 'rascunho'").bind(c.req.param('id')).run()
    if (!result.meta.changes) return c.json({ error: 'somente_rascunhos_podem_ser_excluidos' }, 409)
    return c.json({ success: true })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:excluir]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_excluir_relatorio' }, 500)
  }
})

app.post('/api/financeiro/relatorios-despesa-viagem/:id/anexos', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const idRelatorio = c.req.param('id')
    const relatorio = await c.env.SHARE_DB.prepare('SELECT id FROM relatorio_despesa_viagem WHERE id = ?1').bind(idRelatorio).first<{ id: string }>()
    if (!relatorio) return c.notFound()
    const form = await c.req.formData()
    const file = form.get('arquivo') as unknown
    const indiceDespesa = Math.max(0, Number(form.get('indice_despesa') || 0))
    if (!(file instanceof File) || !file.size) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') return c.json({ error: 'somente_imagem_ou_pdf_permitido' }, 415)
    const anexoId = uuid()
    const key = await salvarArquivoShareBrasil(c, user.id, file, `share/relatorio_despesa_viagem/anexos_notas/${idRelatorio}/${anexoId}`)
    const urlArquivo = `/api/financeiro/relatorios-despesa-viagem/${encodeURIComponent(idRelatorio)}/anexos/${encodeURIComponent(anexoId)}/arquivo`
    await c.env.SHARE_DB.prepare(`INSERT INTO relatorio_despesa_viagem_anexos
      (id, relatorio_despesa_viagem_id, indice_despesa, nome_arquivo, caminho_arquivo, url_arquivo, tipo_arquivo, tamanho_arquivo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(anexoId, idRelatorio, indiceDespesa, file.name, key, urlArquivo, file.type || null, file.size).run()
    return c.json({ anexo: { id: anexoId, relatorio_despesa_viagem_id: idRelatorio, indice_despesa: indiceDespesa, nome_arquivo: file.name, caminho_arquivo: key, url_arquivo: urlArquivo, tipo_arquivo: file.type || null, tamanho_arquivo: file.size } }, 201)
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:anexo]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_salvar_anexo' }, 400)
  }
})

app.delete('/api/financeiro/relatorios-despesa-viagem/:id/anexos/:anexoId', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const db = c.env.SHARE_DB
    const anexo = await db.prepare('SELECT id, caminho_arquivo FROM relatorio_despesa_viagem_anexos WHERE id = ?1 AND relatorio_despesa_viagem_id = ?2').bind(c.req.param('anexoId'), c.req.param('id')).first<{ id: string; caminho_arquivo: string }>()
    if (!anexo) return c.notFound()
    await db.prepare('DELETE FROM relatorio_despesa_viagem_anexos WHERE id = ?1').bind(anexo.id).run()
    await shareBrasilBucket(c).delete(anexo.caminho_arquivo).catch(() => undefined)
    return c.json({ success: true })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:excluir-anexo]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_excluir_anexo' }, 400)
  }
})

app.get('/api/financeiro/relatorios-despesa-viagem/:id/anexos/:anexoId/arquivo', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    const anexo = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, nome_arquivo, tipo_arquivo FROM relatorio_despesa_viagem_anexos WHERE id = ?1 AND relatorio_despesa_viagem_id = ?2').bind(c.req.param('anexoId'), c.req.param('id')).first<{ caminho_arquivo: string; nome_arquivo: string; tipo_arquivo: string | null }>()
    if (!anexo) return c.notFound()
    const object = await shareBrasilBucket(c).get(anexo.caminho_arquivo)
    if (!object) return c.notFound()
    return new Response(object.body, { headers: { 'Content-Type': anexo.tipo_arquivo || 'application/octet-stream', 'Content-Disposition': `inline; filename="${shareBrasilFileName(anexo.nome_arquivo)}"` } })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:baixar-anexo]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_carregar_anexo' }, 500)
  }
})

app.get('/api/financeiro/relatorios-despesa-viagem/:id/anexos-rejeicao/:anexoId/arquivo', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    const row = await c.env.SHARE_DB.prepare('SELECT anexos_rejeicao FROM relatorio_despesa_viagem WHERE id = ?1').bind(c.req.param('id')).first<{ anexos_rejeicao: string | null }>()
    if (!row) return c.notFound()
    let anexos: any[] = []
    try { const parsed = JSON.parse(String(row.anexos_rejeicao || '[]')); if (Array.isArray(parsed)) anexos = parsed } catch { return c.json({ error: 'anexo_invalido' }, 500) }
    const anexo = anexos.find((item) => item?.id === c.req.param('anexoId'))
    if (!anexo?.caminho_arquivo) return c.notFound()
    const object = await shareBrasilBucket(c).get(anexo.caminho_arquivo)
    if (!object) return c.notFound()
    return new Response(object.body, { headers: { 'Content-Type': anexo.tipo_arquivo || 'application/octet-stream', 'Content-Disposition': `inline; filename="${shareBrasilFileName(anexo.nome_arquivo || 'anexo-rejeicao')}"`, 'Cache-Control': 'private, no-store' } })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:anexo-rejeicao]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_carregar_anexo_rejeicao' }, 500)
  }
})
app.post('/api/financeiro/relatorios-despesa-viagem/:id/pdf', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const id = c.req.param('id')
    const db = c.env.SHARE_DB
    const relatorio = await db.prepare('SELECT id, numero_relatorio, matricula_aeronave, pdf_path FROM relatorio_despesa_viagem WHERE id = ?1').bind(id).first<any>()
    if (!relatorio) return c.notFound()
    const form = await c.req.formData()
    const file = form.get('arquivo') as unknown
    if (!file || typeof file !== 'object' || !('size' in file) || Number((file as File).size) <= 0) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    if ((file as File).type !== 'application/pdf' && !/\.pdf$/i.test((file as File).name || '')) return c.json({ error: 'somente_pdf_permitido' }, 400)
    const matriculaSafe = String(relatorio.matricula_aeronave || 'SEM-MATRICULA').replace(/[^A-Z0-9-]/gi, '')
    const numeroSafe = String(relatorio.numero_relatorio || 'REL').replace(/[\/\s]/g, '-')
    const key = await salvarArquivoShareBrasil(c, user.id, file as File, `share/relatorio_despesa_viagem/pdf_relatorios/${matriculaSafe}/${numeroSafe}`)
    if (relatorio.pdf_path) await shareBrasilBucket(c).delete(relatorio.pdf_path).catch(() => undefined)
    const pdfUrl = `/api/financeiro/relatorios-despesa-viagem/${id}/pdf`
    await db.batch([
      db.prepare('UPDATE relatorio_despesa_viagem SET pdf_path = ?, pdf_url = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(key, pdfUrl, id),
      db.prepare("UPDATE lancamentos SET url_doc = ?, atualizado_em = CURRENT_TIMESTAMP WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?").bind(key, id),
    ])
    return c.json({ success: true, pdf_url: pdfUrl, pdf_path: key }, 201)
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:upload-pdf]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_salvar_pdf' }, 400)
  }
})

app.get('/api/financeiro/relatorios-despesa-viagem/:id/pdf', async c => {
  try {
    await garantirTabelaRelatorioDespesaViagem(c)
    const row = await c.env.SHARE_DB.prepare('SELECT pdf_path, numero_relatorio FROM relatorio_despesa_viagem WHERE id = ?1').bind(c.req.param('id')).first<{ pdf_path: string | null; numero_relatorio: string }>()
    if (!row?.pdf_path) return c.notFound()
    const object = await shareBrasilBucket(c).get(row.pdf_path)
    if (!object) return c.notFound()
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${shareBrasilFileName(row.numero_relatorio || 'relatorio')}.pdf"`,
      },
    })
  } catch (error: any) {
    log.error('[relatorio-despesa-viagem:baixar-pdf]', error?.message || error)
    return c.json({ error: error?.message || 'falha_ao_carregar_pdf' }, 500)
  }
})

function parseRejectionAttachments(value: unknown): any[] {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string') : []
  } catch { return [] }
}
function parseAdjustmentAttachments(value: unknown): any[] {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value || '[]'))
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.id === 'string').map(({ id, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em }) => ({ id, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em }))
      : []
  } catch { return [] }
}
function ajusteAnteriorStatement(db: D1Database, report: any, pos: 1 | 2) {
  const previousReason = String(pos === 1 ? report.motivo_reprovacao_tripulante_1 || '' : report.motivo_reprovacao_tripulante_2 || '').trim()
  const legacyId = `legacy-${report.id}-${pos}`
  const legacyAttachments = parseRejectionAttachments(report.anexos_rejeicao).map(({ id, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em }) => ({ id, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em }))
  return db.prepare(`INSERT OR IGNORE INTO relatorio_despesa_viagem_historico_ajustes
    (id, relatorio_despesa_viagem_id, tripulante_pos, motivo, anexos, criado_em)
    SELECT ?1, ?2, ?3, ?4, ?5, COALESCE(?6, CURRENT_TIMESTAMP)
    WHERE trim(?4) <> '' AND NOT EXISTS (
      SELECT 1 FROM relatorio_despesa_viagem_historico_ajustes
      WHERE relatorio_despesa_viagem_id = ?2 AND tripulante_pos = ?3
    )`).bind(legacyId, report.id, pos, previousReason, JSON.stringify(legacyAttachments), report.atualizado_em || null)
}
function historicoAjusteStatements(db: D1Database, report: any, pos: 1 | 2, reason: string, attachments: any[]) {
  const criadoEm = new Date().toISOString()
  const currentInsert = db.prepare(`INSERT INTO relatorio_despesa_viagem_historico_ajustes
    (id, relatorio_despesa_viagem_id, tripulante_pos, motivo, anexos, criado_em)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(uuid(), report.id, pos, reason, JSON.stringify(attachments), criadoEm)
  return [ajusteAnteriorStatement(db, report, pos), currentInsert]
}
function rejectionAttachments(value: unknown, reportId: string): any[] {
  return parseRejectionAttachments(value).map(({ id, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em }) => ({
    id, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em,
    url_arquivo: `/api/financeiro/relatorios-despesa-viagem/${encodeURIComponent(reportId)}/anexos-rejeicao/${encodeURIComponent(id)}/arquivo`,
  }))
}
async function notifyReportRejection(c: Context<{ Bindings: Bindings }>, report: any, reason: string, rejectedBy: string): Promise<void> {
  const db = c.env.SHARE_DB
  const recipients = await db.prepare(`SELECT id FROM user_profiles
    WHERE id <> ?1
      AND (status IS NULL OR lower(status) IN ('ativo', 'active'))
      AND (
        lower(replace(replace(trim(COALESCE(departamento, '')), ' ', '_'), '-', '_')) IN ('financeiro', 'administrativo', 'admin', 'financeiro_master', 'financeiro_admin', 'operacoes', 'operacao')
        OR lower(replace(replace(trim(COALESCE(tipo_user, '')), ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'financeiro_master', 'financeiro_admin', 'financeiro', 'operacoes', 'operacao')
        OR id IN (SELECT user_id FROM usuarios_funcoes WHERE lower(replace(replace(trim(funcao), ' ', '_'), '-', '_')) IN ('financeiro', 'financeiro_admin', 'financeiro_master', 'admin', 'operacoes', 'operacao'))
      )`).bind(rejectedBy || '').all<{ id: string }>()
  const uniqueRecipients = [...new Set((recipients.results || []).map((item) => item.id).filter(Boolean))]
  if (!uniqueRecipients.length) return
  const numero = String(report.numero_relatorio || report.id)
  const mensagem = `O tripulante ${report.nome_tripulante || 'não identificado'} rejeitou o relatório ${numero}. Motivo: ${reason}`
  await notifyUsers(db, uniqueRecipients, `relatorio_despesa_viagem/${report.id}`, mensagem)
}

async function notifyReportDecision(c: Context<{ Bindings: Bindings }>, report: any, decision: string, reason: string, decidedBy: string): Promise<void> {
  const db = c.env.SHARE_DB
  const recipients = await db.prepare(`SELECT id FROM user_profiles
    WHERE id <> ?1 AND (status IS NULL OR lower(status) IN ('ativo', 'active')) AND (
      lower(replace(replace(trim(COALESCE(tipo_user, '')), ' ', '_'), '-', '_')) IN ('financeiro_admin', 'financeiro_master', 'financeiro', 'admin', 'administrador', 'operacoes', 'operacao')
      OR lower(replace(replace(trim(COALESCE(departamento, '')), ' ', '_'), '-', '_')) IN ('financeiro_admin', 'financeiro_master', 'financeiro', 'admin', 'administrativo', 'operacoes', 'operacao')
      OR id IN (SELECT user_id FROM usuarios_funcoes WHERE lower(replace(replace(trim(funcao), ' ', '_'), '-', '_')) IN ('financeiro_admin', 'financeiro_master', 'financeiro', 'admin', 'administrador', 'operacoes', 'operacao'))
    )`).bind(decidedBy || '').all<{ id: string }>()
  const uniqueRecipients = [...new Set((recipients.results || []).map((item) => item.id).filter(Boolean))]
  if (!uniqueRecipients.length) return
  const numero = String(report.numero_relatorio || report.id)
  const aprovado = decision === 'aprovado'
  const mensagem = aprovado
    ? `O tripulante ${report.nome_tripulante || 'não identificado'} aprovou o relatório ${numero}. O pagamento foi lançado para programação.`
    : `O tripulante ${report.nome_tripulante || 'não identificado'} rejeitou o relatório ${numero}. Motivo: ${reason}`
  await notifyUsers(db, uniqueRecipients, `relatorio_despesa_viagem/${report.id}`, mensagem)
}










// ─── Aeronaves Share Brasil ───────────────────────────────────────────────────
app.get('/api/sharebrasil/aeronaves', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const status = String(c.req.query('status') || '').trim().toLowerCase()
  const filtro = status === 'inativa' ? " WHERE lower(COALESCE(a.status, 'ativa')) IN ('inativa', 'cancelada')" : status === 'todas' ? '' : " WHERE lower(COALESCE(a.status, 'ativa')) NOT IN ('inativa', 'cancelada')"
  const rows = await c.env.SHARE_DB.prepare(`SELECT a.*, p.categoria AS performance_categoria, p.teto_servico_ft AS performance_teto_servico_ft, p.nivel_cruzeiro_min_ft AS performance_nivel_cruzeiro_min_ft, p.nivel_cruzeiro_max_ft AS performance_nivel_cruzeiro_max_ft, p.aprovado_rvsm AS performance_aprovado_rvsm, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm FROM aeronave a LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1))${filtro} ORDER BY a.matricula_registro`).all()
  return c.json({ aeronaves: rows.results || [] })
})
app.get('/api/sharebrasil/aeronaves/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare(`SELECT a.*, p.id AS performance_id, p.categoria AS performance_categoria, p.modelo AS performance_modelo, p.teto_servico_ft AS performance_teto_servico_ft, p.nivel_cruzeiro_min_ft AS performance_nivel_cruzeiro_min_ft, p.nivel_cruzeiro_max_ft AS performance_nivel_cruzeiro_max_ft, p.aprovado_rvsm AS performance_aprovado_rvsm, p.velocidade_cruzeiro_kt AS performance_velocidade_cruzeiro_kt, p.taxa_subida_fpm AS performance_taxa_subida_fpm, p.taxa_descida_fpm AS performance_taxa_descida_fpm FROM aeronave a LEFT JOIN performance_aeronave p ON p.id = COALESCE(a.performance_aeronave_id, (SELECT p2.id FROM performance_aeronave p2 WHERE lower(p2.modelo) = lower(a.modelo) ORDER BY p2.atualizado_em DESC LIMIT 1)) WHERE a.id = ?`).bind(c.req.param('id')).first()
  if (!row) return c.json({ error: 'aeronave_nao_encontrada' }, 404)
  return c.json({ aeronave: row })
})
app.post('/api/sharebrasil/aeronaves', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body: Record<string, any> = await c.req.json().catch(() => ({} as Record<string, any>))
  const matricula = String(body.matricula_registro || '').trim().toUpperCase()
  const icaoHex = String(body.icao_hex || '').trim().toUpperCase()
  const fabricante = String(body.fabricante || '').trim()
  const modelo = String(body.modelo || '').trim()
  if (!matricula || !fabricante || !modelo) return c.json({ error: 'matricula_fabricante_modelo_obrigatorios' }, 400)
  if (icaoHex && !/^[0-9A-F]{6}$/.test(icaoHex)) return c.json({ error: 'icao_hex_invalido' }, 400)
  const db = c.env.SHARE_DB
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
  const aircraftData: Record<string, any> = { id: aeronaveId, matricula_registro: matricula, fabricante, modelo, icao_hex: icaoHex || null, numero_serie: body.numero_serie || null, nome_proprietario: body.nome_proprietario || null, status: body.status === 'inativa' ? 'inativa' : 'ativa', consumo_combustivel: body.consumo_combustivel || null, ano: body.ano || null, base: body.base || null, preco_hora: body.preco_hora || null, url_imagem: body.url_imagem || null, velocidade_cruzeiro: body.velocidade_cruzeiro || null, tipo_aeronave: body.tipo_aeronave || null, numero_motores: body.numero_motores || null, performance_aeronave_id: performanceId }
  const schema = await db.prepare("SELECT name FROM pragma_table_info('aeronave')").all<{ name: string }>()
  const existentes = new Set((schema.results || []).map((item) => item.name))
  const colunas = Object.keys(aircraftData).filter((key) => existentes.has(key))
  await db.prepare(`INSERT INTO aeronave (${colunas.join(',')}) VALUES (${colunas.map(() => '?').join(',')})`).bind(...colunas.map((key) => aircraftData[key])).run()
  const criado = await db.prepare('SELECT * FROM aeronave WHERE id = ?').bind(aeronaveId).first()
  return c.json({ aeronave: criado, performance_id: performanceId }, 201)
})

export default {
  fetch: app.fetch,
  async scheduled(_event: any, _env: Bindings, ctx: ExecutionContext) {
    // O cron executa apenas jobs locais: chamadas HTTP ao próprio Worker
    // criavam latência e duplicavam autenticação sem garantir consistência.
    if (_env.SHARE_DB) ctx.waitUntil(processFinanceQueue(_env.SHARE_DB, null, 50))
  },
}
