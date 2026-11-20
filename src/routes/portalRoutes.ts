import { Hono, Context } from "hono"
import { carregarCustosPortal, mesesAte, premissasHistoricasPortal, calcularCamadasPortal } from "../financeiro/portalCustos"
import { checkRateLimit, clientIp } from "../lib/cache"
import { normalizarHorarioAgendamento } from "../lib/schedule"
import { haversineKm } from "../lib/geo"
import { buscarPosicoes, configurarProvedor, type PosicaoAeronave } from "../lib/adsbProvider"
import { jornadaOperacionalDisponivel, statusAgendamentoComJornadaSql } from "../lib/flightStatus"

type Bindings = { SHARE_DB: D1Database; CACHE_KV: KVNamespace; RATE_LIMITER: DurableObjectNamespace; CLIENT_SESSION_SECRET?: string; CLIENT_SESSION_TTL_SECONDS?: string; INTERNAL_TOKEN?: string; ADSB_PROVIDER?: string; TELEGRAM_BOT_TOKEN?: string }
type Variables = Record<string, never>

export const portalRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const log = { debug: (...args: unknown[]) => console.debug(...args), warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) }
type PortalUser = {
  id: string
  login: string
  nome_exibicao: string | null
  url_avatar: string | null
  cliente_id: string | null
  socio_id: string | null
  principal_id: string | null
  permissoes: PortalFeature[] | null
}

export type PortalFeature = 'agendamento' | 'financeiro' | 'aeronave' | 'manutencao'

function parsePortalPermissions(value: unknown): PortalFeature[] | null {
  if (value == null || value === '') return null
  try {
    const parsed = JSON.parse(String(value))
    if (!Array.isArray(parsed)) return []
    const valid = new Set<PortalFeature>(['agendamento', 'financeiro', 'aeronave', 'manutencao'])
    return [...new Set(parsed.filter((item): item is PortalFeature => typeof item === 'string' && valid.has(item as PortalFeature)))]
  } catch {
    return []
  }
}

export function portalHasFeature(user: PortalUser, feature: PortalFeature): boolean {
  return !user.principal_id || user.permissoes === null || user.permissoes.includes(feature)
}

export function portalFeatureForPath(path: string): PortalFeature | null {
  if (/^\/api\/portal\/(aerodromos|disponibilidade|solicitacoes|simulador)(\/|$)/.test(path) || path === '/api/portal/diario-bordo') return 'agendamento'
  if (/^\/api\/portal\/(financeiro|balanco|abastecimentos|baixas|comprovantes)(\/|$)/.test(path)) return 'financeiro'
  if (/^\/api\/portal\/aeronave(\/|$)/.test(path)) return 'aeronave'
  if (path === '/api/portal/manutencao') return 'manutencao'
  return null
}

async function portalUserColumns(db: D1Database): Promise<Set<string>> {
  const schema = await db.prepare('SELECT name FROM pragma_table_info(?1)').bind('user_cliente').all<{ name: string }>()
  return new Set((schema.results || []).map(column => String(column.name)))
}

async function portalUserForLogin(db: D1Database, login: string): Promise<(PortalUser & { senha: string }) | null> {
  const columns = await portalUserColumns(db)
  if (!columns.has('cotista_id')) throw new Error('user_cliente sem coluna cotista_id')
  const principalSelect = columns.has('principal_id') ? 'u.principal_id' : 'NULL AS principal_id'
  const permissionsSelect = columns.has('permissoes') ? 'u.permissoes' : 'NULL AS permissoes'
  const row = await db.prepare(`
    SELECT u.id, u.login, u.senha, u.nome_exibicao, u.url_avatar, ${principalSelect}, ${permissionsSelect},
      ca.cliente_id AS cliente_id, ca.socio_id AS socio_id
    FROM user_cliente u
    LEFT JOIN cotista_aeronave ca ON ca.id = u.cotista_id
    WHERE lower(u.login) = ?1
    LIMIT 1
  `).bind(login).first<Record<string, unknown>>()
  if (!row) return null
  return {
    id: String(row.id), login: String(row.login), senha: String(row.senha || ''),
    nome_exibicao: row.nome_exibicao == null ? null : String(row.nome_exibicao),
    url_avatar: row.url_avatar == null ? null : String(row.url_avatar),
    cliente_id: row.cliente_id == null ? null : String(row.cliente_id),
    socio_id: row.socio_id == null ? null : String(row.socio_id),
    principal_id: row.principal_id == null ? null : String(row.principal_id),
    permissoes: parsePortalPermissions(row.permissoes),
  }
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
const MAX_RESERVATION_DAYS = 30
const MAX_RESERVATION_PASSENGERS = 20
// O workerd em produção limita PBKDF2 a 100.000 iterações.
const PORTAL_PBKDF2_ITERATIONS = 100_000

function portalValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function portalReservationEnd(start: string, days: number): string {
  return new Date(Date.parse(`${start}T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10)
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

export async function portalCreatePasswordHash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2_sha256$${PORTAL_PBKDF2_ITERATIONS}$${portalBase64Url(salt)}$${portalBase64Url(await portalHashPassword(password, salt))}`
}

function portalSessionSecret(c: Context<{ Bindings: Bindings; Variables: Variables }>): string {
  const secret = c.env.CLIENT_SESSION_SECRET || c.env.INTERNAL_TOKEN
  if (!secret) throw new Error('Segredo de sessão não configurado')
  return secret
}

async function portalTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', portalEncoder.encode(token))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function portalCreateSession(user: PortalUser, c: Context<{ Bindings: Bindings; Variables: Variables }>): Promise<{ token: string; expires_at: string }> {
  const exp = Math.floor(Date.now() / 1000) + Number(c.env.CLIENT_SESSION_TTL_SECONDS || PORTAL_SESSION_TTL)
  const encoded = portalBase64Url(portalEncoder.encode(JSON.stringify({ ...user, exp })))
  const signature = portalBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await portalHmacKey(portalSessionSecret(c)), portalEncoder.encode(encoded))))
  return { token: `${encoded}.${signature}`, expires_at: new Date(exp * 1000).toISOString() }
}

export async function portalSession(c: Context<{ Bindings: Bindings; Variables: Variables }>): Promise<PortalUser | null> {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  const [encoded, signature] = authorization.slice(7).trim().split('.')
  if (!encoded || !signature) return null
  try {
    const valid = await crypto.subtle.verify('HMAC', await portalHmacKey(portalSessionSecret(c)), portalFromBase64Url(signature), portalEncoder.encode(encoded))
    const session = JSON.parse(portalDecoder.decode(portalFromBase64Url(encoded))) as PortalSession
    if (!valid || !session.id || !session.login || session.exp <= Math.floor(Date.now() / 1000)) return null
    const revoked = await c.env.SHARE_DB.prepare('SELECT token_hash FROM portal_sessoes_revogadas WHERE token_hash = ?1 AND expires_at > ?2 LIMIT 1')
      .bind(await portalTokenHash(authorization.slice(7).trim()), Math.floor(Date.now() / 1000)).first()
    if (revoked) return null
    const columns = await portalUserColumns(c.env.SHARE_DB)
    const principalSelect = columns.has('principal_id') ? 'u.principal_id' : 'NULL AS principal_id'
    const permissionsSelect = columns.has('permissoes') ? 'u.permissoes' : 'NULL AS permissoes'
    const current = await c.env.SHARE_DB.prepare(`
      SELECT u.id, u.login, u.nome_exibicao, u.url_avatar, ${principalSelect}, ${permissionsSelect},
             ca.cliente_id, ca.socio_id
        FROM user_cliente u
        LEFT JOIN cotista_aeronave ca ON ca.id = u.cotista_id
       WHERE u.id = ?1 LIMIT 1
    `).bind(session.id).first<Record<string, unknown>>()
    if (!current || !current.cliente_id && !current.socio_id) return null
    return {
      id: String(current.id), login: String(current.login),
      nome_exibicao: current.nome_exibicao == null ? null : String(current.nome_exibicao),
      url_avatar: current.url_avatar == null ? null : String(current.url_avatar),
      cliente_id: current.cliente_id == null ? null : String(current.cliente_id),
      socio_id: current.socio_id == null ? null : String(current.socio_id),
      principal_id: current.principal_id == null ? null : String(current.principal_id),
      permissoes: parsePortalPermissions(current.permissoes),
    }
  } catch {
    return null
  }
}

async function portalClientId(c: Context<{ Bindings: Bindings; Variables: Variables }>, user: PortalUser): Promise<string |null> {
  if (user.cliente_id) return user.cliente_id
  return null
}

async function portalContext(c: Context<{ Bindings: Bindings; Variables: Variables }>, user: PortalUser) {
  const db = c.env.SHARE_DB
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

export async function portalTelegram(c: Context<{ Bindings: Bindings; Variables: Variables }>, message: string): Promise<void> {
  if (!c.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN não configurado')
  const company = await c.env.SHARE_DB.prepare('SELECT telegram_chat_id FROM empresa ORDER BY criado_em LIMIT 1').first<{ telegram_chat_id: string | null }>()
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

function portalConfirmationMessage(row: Record<string, unknown>): string | null {
  if (String(row.status || '').toLowerCase() !== 'aprovada' || !row.numero_voo) return null
  const nome = String(row.cotista_nome || 'cotista').trim()
  const data = String(row.data_agendada || '').slice(0, 10)
  const dataFormatada = data ? new Date(`${data}T00:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : data
  const tripulante = String(row.piloto_nome || 'tripulante não informado').trim()
  return `Olá ${nome}, seu voo ${row.numero_voo} foi confirmado para o dia ${dataFormatada} com o tripulante ${tripulante}.`
}

portalRoutes.post('/api/portal/login', async c => {
  try {
    if (!(await checkRateLimit(c, `portal-login:${clientIp(c)}`, 12))) return c.json({ error: 'muitas_tentativas' }, 429)
    const body = await c.req.json<{ login?: string; senha?: string }>().catch(() => null)
    if (typeof body?.login !== 'string' || typeof body.senha !== 'string') {
      return c.json({ error: 'login_e_senha_obrigatorios' }, 400)
    }
    const login = body.login.trim().toLowerCase()
    const senha = body.senha
    if (!login || !senha) return c.json({ error: 'login_e_senha_obrigatorios' }, 400)
    if (login.length > 80 || senha.length > 128) return c.json({ error: 'credenciais_invalidas' }, 401)

    const row = await portalUserForLogin(c.env.SHARE_DB, login)
    const verification = row ? await portalVerifyPassword(senha, row.senha) : null
    if (!row || !verification?.valid) return c.json({ error: 'credenciais_invalidas' }, 401)
    if (Boolean(row.cliente_id) === Boolean(row.socio_id)) return c.json({ error: 'vinculo_usuario_invalido' }, 409)
    if (verification.legacy) await c.env.SHARE_DB.prepare('UPDATE user_cliente SET senha = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(await portalCreatePasswordHash(senha), row.id).run()

    const user: PortalUser = {
      id: row.id, login: row.login, nome_exibicao: row.nome_exibicao, url_avatar: row.url_avatar,
      cliente_id: row.cliente_id, socio_id: row.socio_id, principal_id: row.principal_id, permissoes: row.permissoes,
    }
    return c.json({ user, ...(await portalCreateSession(user, c)) })
  } catch (error: any) {
    log.error('[portal/login]', error?.message ?? error)
    return c.json({ error: 'portal_login_indisponivel' }, 500)
  }
})

portalRoutes.use('/api/portal/*', async (c, next) => {
  if (c.req.path === '/api/portal/login') return next()
  const user = await portalSession(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const feature = portalFeatureForPath(c.req.path)
  if (feature && !portalHasFeature(user, feature)) return c.json({ error: 'portal_feature_forbidden' }, 403)
  return next()
})

portalRoutes.post('/api/portal/logout', async c => {
  const token = c.req.header('authorization')?.slice(7).trim()
  if (!token) return c.json({ error: 'client_auth_required' }, 401)
  const encoded = token.split('.')[0]
  if (!encoded) return c.json({ error: 'client_auth_required' }, 401)
  const session = JSON.parse(portalDecoder.decode(portalFromBase64Url(encoded))) as PortalSession
  await c.env.SHARE_DB.prepare('INSERT INTO portal_sessoes_revogadas (token_hash, expires_at) VALUES (?1, ?2) ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at')
    .bind(await portalTokenHash(token), session.exp).run()
  try {
    await c.env.SHARE_DB.prepare('DELETE FROM portal_sessoes_revogadas WHERE expires_at <= ?1')
      .bind(Math.floor(Date.now() / 1000)).run()
  } catch {
    // A revogação já foi persistida; a limpeza de registros expirados é acessória.
  }
  return c.body(null, 204)
})

portalRoutes.get('/api/portal/me', async c => c.json({ user: await portalSession(c) }))

portalRoutes.get('/api/portal/contexto', async c => {
  const user = await portalSession(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const contexto = await portalContext(c, user)
  if (!portalHasFeature(user, 'aeronave')) contexto.participacoes = []
  if (user.principal_id) {
    if (contexto.cliente) contexto.cliente = {
      ...contexto.cliente, cnpj: null, inscricao_estadual: null, proprietario: null,
      endereco: null, cidade: null, uf: null, contato_financeiro: null,
      telefone_financeiro: null, telefone_cliente: null, telefone_outro: null,
      email_principal: null, emails: '[]', url_logo: null, codigo_cliente: null, observacoes: null,
    }
    if (contexto.socio) contexto.socio = {
      ...contexto.socio, cpf: '', email_principal: null, emails: '[]', endereco: null,
      cidade: null, uf: null, contato_financeiro: null, telefone_financeiro: null,
      telefone: null, observacoes: null,
    }
  }
  return c.json(contexto)
})

portalRoutes.get('/api/portal/financeiro', async c => {
  const user = await portalSession(c)
  if (!user?.cliente_id && !user?.socio_id) return c.json({ error: 'cotista_nao_vinculado' }, 409)
  const participantId = user.cliente_id || user.socio_id
  const ownedAircraftFilter = user.cliente_id ? 'ca.cliente_id = ?1' : 'ca.socio_id = ?1'
  const paymentTotals = `LEFT JOIN (
    SELECT rateio_id,
           SUM(CASE WHEN UPPER(COALESCE(status, '')) = 'CONFIRMADO' THEN valor_centavos ELSE 0 END) AS valor_pago_centavos
      FROM rateio_pagamentos
     GROUP BY rateio_id
  ) pagamentos ON pagamentos.rateio_id = r.id`
  const query = user.cliente_id
    ? `SELECT r.id, r.aeronave_id, r.data_emissao, r.data_vencimento, r.data_pagamento,
          r.descricao_despesa, r.categoria_nome, r.valor_rateado_centavos,
          COALESCE(pagamentos.valor_pago_centavos, r.valor_pago_real_centavos, 0) AS valor_pago_real_centavos,
          CASE WHEN pagamentos.rateio_id IS NOT NULL
                 THEN CASE WHEN pagamentos.valor_pago_centavos >= r.valor_rateado_centavos THEN 'PAGO'
                           WHEN pagamentos.valor_pago_centavos > 0 THEN 'PAGO_PARCIAL' ELSE 'EM_ABERTO' END
                 WHEN COALESCE(r.valor_pago_real_centavos, 0) >= r.valor_rateado_centavos
                   OR UPPER(COALESCE(r.status, '')) IN ('PAGO', 'REEMBOLSADO', 'PAGO_DIRETAMENTE')
                 THEN 'PAGO' ELSE 'EM_ABERTO' END AS status,
          'CLIENTE' AS tipo, a.matricula_registro
       FROM rateio_despesas r
       INNER JOIN cotista_aeronave ca ON ca.id = r.cotista_id
       LEFT JOIN aeronave a ON a.id = r.aeronave_id
       ${paymentTotals}
      WHERE ${ownedAircraftFilter} AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELADO', 'CANCELADA', 'ESTORNO', 'ESTORNADO')
      ORDER BY date(r.data_emissao) DESC, r.id DESC`
    : `SELECT r.id, r.aeronave_id, r.data_emissao, r.data_vencimento, r.data_pagamento,
          r.descricao_despesa, r.categoria_nome, r.valor_rateado_centavos,
          COALESCE(pagamentos.valor_pago_centavos, r.valor_pago_real_centavos, 0) AS valor_pago_real_centavos,
          CASE WHEN pagamentos.rateio_id IS NOT NULL
                 THEN CASE WHEN pagamentos.valor_pago_centavos >= r.valor_rateado_centavos THEN 'PAGO'
                           WHEN pagamentos.valor_pago_centavos > 0 THEN 'PAGO_PARCIAL' ELSE 'EM_ABERTO' END
                 WHEN COALESCE(r.valor_pago_real_centavos, 0) >= r.valor_rateado_centavos
                   OR UPPER(COALESCE(r.status, '')) IN ('PAGO', 'REEMBOLSADO', 'PAGO_DIRETAMENTE')
                 THEN 'PAGO' ELSE 'EM_ABERTO' END AS status,
          'HOLDING' AS tipo, a.matricula_registro
       FROM rateio_hold r
       INNER JOIN hold_socios hs ON hs.id = r.socio_id
       INNER JOIN cotista_aeronave ca ON ca.socio_id = hs.id AND ca.aeronave_id = r.aeronave_id
       LEFT JOIN aeronave a ON a.id = r.aeronave_id
       ${paymentTotals}
      WHERE ${ownedAircraftFilter} AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELADO', 'CANCELADA', 'ESTORNO', 'ESTORNADO')
      ORDER BY date(r.data_emissao) DESC, r.id DESC`
  const result = await c.env.SHARE_DB.prepare(query).bind(participantId).all<Record<string, unknown>>()
  const despesas = result.results || []
  const resumo = despesas.reduce<{ totalCentavos: number; pagoCentavos: number; abertas: number; pagas: number }>((acc, row) => {
    const esperado = Number(row.valor_rateado_centavos || 0)
    const pago = Number(row.valor_pago_real_centavos || 0)
    acc.totalCentavos += esperado
    acc.pagoCentavos += Math.min(pago, esperado)
    if (String(row.status).toUpperCase() === 'PAGO') acc.pagas += 1
    else acc.abertas += 1
    return acc
  }, { totalCentavos: 0, pagoCentavos: 0, abertas: 0, pagas: 0 })
  return c.json({ tipo: user.cliente_id ? 'CLIENTE' : 'HOLDING', despesas, resumo: { ...resumo, abertoCentavos: resumo.totalCentavos - resumo.pagoCentavos } })
})

// Indicadores financeiros consolidados: somente para a aeronave do vínculo autenticado.
portalRoutes.get('/api/portal/financeiro/custos', async c => {
  const user = await portalSession(c)
  if (!user?.cliente_id && !user?.socio_id) return c.json({ error: 'cotista_nao_vinculado' }, 409)
  const aeronaveId = String(c.req.query('aeronave_id') || '')
  const meses = [...new Set(String(c.req.query('meses') || new Date().toISOString().slice(0, 7)).split(','))].sort()
  if (!/^[0-9a-f-]{8,}$/i.test(aeronaveId) || !meses.length || meses.length > 36 || meses.some(m => !/^(20\d{2})-(0[1-9]|1[0-2])$/.test(m))) return c.json({ error: 'parametros_invalidos' }, 400)
  const vinculo = await c.env.SHARE_DB.prepare(`SELECT ca.id AS cotista_id, ca.percentual_sociedade, a.matricula_registro,
      (SELECT COUNT(*) FROM cotista_aeronave outras WHERE outras.aeronave_id = a.id AND LOWER(TRIM(COALESCE(outras.status, 'ativo'))) IN ('ativo', 'ativa')) AS quantidade_cotas
    FROM aeronave a JOIN cotista_aeronave ca ON ca.aeronave_id = a.id
    WHERE a.id = ?1 AND (ca.cliente_id = ?2 OR ca.socio_id = ?3)
      AND ca.id = (SELECT cotista_id FROM user_cliente WHERE id = ?4 LIMIT 1) LIMIT 1`)
    .bind(aeronaveId, user.cliente_id, user.socio_id, user.id).first<{ cotista_id: string; percentual_sociedade: number; matricula_registro: string; quantidade_cotas: number }>()
  if (!vinculo) return c.json({ error: 'aeronave_nao_vinculada' }, 404)
  c.header('Cache-Control', 'private, no-store')
  const dados = await carregarCustosPortal(c.env.SHARE_DB, aeronaveId, vinculo.cotista_id, user.cliente_id, user.socio_id, meses)
  return c.json({ ...dados.resposta, vinculo, premissas: premissasHistoricasPortal(dados.rateios, dados.voos) })
})

portalRoutes.get('/api/portal/aeronave/:aeronaveId/dashboard', async c => {
  const user = await portalSession(c)
  if (!user?.cliente_id && !user?.socio_id) return c.json({ error: 'cotista_nao_vinculado' }, 409)
  const aeronaveId = c.req.param('aeronaveId')
  const ano = Number(c.req.query('ano') || new Date().getFullYear())
  if (!/^[0-9a-f-]{8,}$/i.test(aeronaveId) || !Number.isInteger(ano) || ano < 2000 || ano > 2100) return c.json({ error: 'parametros_invalidos' }, 400)
  const inicio = `${ano}-01-01`
  const fim = `${ano}-12-31`
  const vinculo = await c.env.SHARE_DB.prepare(`SELECT ca.id AS cotista_id, ca.percentual_sociedade, a.id, a.matricula_registro, a.fabricante, a.modelo, a.tipo_aeronave, a.ano, a.base, a.status, a.url_imagem
    FROM aeronave a JOIN cotista_aeronave ca ON ca.aeronave_id = a.id
   WHERE a.id = ?1 AND (ca.cliente_id = ?2 OR ca.socio_id = ?3)
     AND ca.id = (SELECT cotista_id FROM user_cliente WHERE id = ?4 LIMIT 1) LIMIT 1`).bind(aeronaveId, user.cliente_id, user.socio_id, user.id).first<Record<string, unknown>>()
  if (!vinculo) return c.json({ error: 'aeronave_nao_vinculada' }, 404)
  const rateioTable = user.cliente_id ? 'rateio_despesas' : 'rateio_hold'
  const rateioJoin = user.cliente_id ? 'JOIN cotista_aeronave ca ON ca.id = r.cotista_id' : ''
  const rateioOwner = user.cliente_id ? 'ca.id = ?2' : 'r.socio_id = ?2'
  const rateioOwnerId = user.cliente_id ? String(vinculo.cotista_id || '') : String(user.socio_id || '')
  const [voos, destinos, vooMaisLongo, categorias, usoCotista] = await Promise.all([
    c.env.SHARE_DB.prepare(`SELECT COUNT(DISTINCT id) AS voos, COALESCE(SUM(COALESCE(tempo_total, tempo_voo, 0)), 0) AS horas,
        COALESCE(SUM(COALESCE(tempo_voo, 0)), 0) AS tempo_voo_horas, COALESCE(SUM(COALESCE(pousos_total, 0)), 0) AS pousos
      FROM lancamentos_diario_bordo WHERE aeronave_id = ?1 AND date(data_registro) BETWEEN date(?2) AND date(?3)`).bind(aeronaveId, inicio, fim).first<Record<string, unknown>>(),
    c.env.SHARE_DB.prepare(`SELECT COALESCE(NULLIF(TRIM(l.aerodromo_chegada), ''), NULLIF(TRIM(l.trecho), ''), 'Não informado') AS destino, COUNT(*) AS quantidade
      FROM lancamentos_diario_bordo l JOIN aeronave a ON a.id = l.aeronave_id
     WHERE l.aeronave_id = ?1 AND date(l.data_registro) BETWEEN date(?2) AND date(?3)
       AND TRIM(COALESCE(NULLIF(l.aerodromo_chegada, ''), NULLIF(l.trecho, ''), '')) <> ''
       AND (TRIM(COALESCE(a.base, '')) = '' OR UPPER(TRIM(COALESCE(NULLIF(l.aerodromo_chegada, ''), NULLIF(l.trecho, ''), ''))) <> UPPER(TRIM(a.base)))
     GROUP BY destino ORDER BY quantidade DESC, destino LIMIT 5`).bind(aeronaveId, inicio, fim).all<Record<string, unknown>>(),
    c.env.SHARE_DB.prepare(`SELECT data_registro, aerodromo_partida, aerodromo_chegada,
        COALESCE(NULLIF(tempo_voo, 0), tempo_total, 0) AS tempo_voo
      FROM lancamentos_diario_bordo WHERE aeronave_id = ?1 AND date(data_registro) BETWEEN date(?2) AND date(?3)
      ORDER BY COALESCE(NULLIF(tempo_voo, 0), tempo_total, 0) DESC, date(data_registro) DESC LIMIT 1`).bind(aeronaveId, inicio, fim).first<Record<string, unknown>>(),
    c.env.SHARE_DB.prepare(`SELECT COALESCE(NULLIF(TRIM(r.categoria_nome), ''), 'Sem categoria') AS categoria, COALESCE(SUM(r.valor_rateado_centavos), 0) AS valor_centavos
      FROM ${rateioTable} r ${rateioJoin}
     WHERE r.aeronave_id = ?1 AND ${rateioOwner} AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELADO', 'CANCELADA', 'ESTORNO', 'ESTORNADO')
       AND date(r.data_emissao) BETWEEN date(?3) AND date(?4) GROUP BY categoria ORDER BY valor_centavos DESC LIMIT 5`).bind(aeronaveId, rateioOwnerId, inicio, fim).all<Record<string, unknown>>(),
    c.env.SHARE_DB.prepare(`SELECT COUNT(DISTINCT l.id) AS etapas, COALESCE(SUM(COALESCE(l.tempo_total, l.tempo_voo, 0)), 0) AS horas,
        COALESCE(SUM(COALESCE(l.pousos_total, 0)), 0) AS pousos
      FROM lancamentos_diario_bordo l WHERE l.aeronave_id = ?1 AND date(l.data_registro) BETWEEN date(?2) AND date(?3)
        AND ((COALESCE(NULLIF(l.cliente_tomador_emprestimo_id, ''), l.cliente_id) = ?4 AND ?4 IS NOT NULL)
          OR (COALESCE(NULLIF(l.socio_tomador_emprestimo_id, ''), l.socio_id) = ?5 AND ?5 IS NOT NULL))`).bind(aeronaveId, inicio, fim, user.cliente_id, user.socio_id).first<Record<string, unknown>>()
  ])
  // As duas visões são apuradas pela mesma fonte do Balanço: rateio por
  // emissão e horas atribuídas pelo diário (AC–COR / DEP–POU / TR/VT).
  const mesesAno = Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, '0')}`)
  const espelho = (await carregarCustosPortal(c.env.SHARE_DB, aeronaveId,
    String(vinculo.cotista_id), user.cliente_id, user.socio_id, mesesAno, 12)).resposta
  const aeronaveResumo = espelho.resumo.aeronave
  const cotaResumo = espelho.resumo.cotista
  const horas = aeronaveResumo.minutos_operacionais / 60
  const custoCentavos = aeronaveResumo.total_centavos
  const horasUso = cotaResumo.minutos_operacionais / 60
  const percentualSociedade = Number(vinculo.percentual_sociedade || 0)
  const percentualUso = horas > 0 ? Number(((horasUso / horas) * 100).toFixed(1)) : 0
  const valoresCustosMes = new Map(espelho.mensal.map(row => [row.mes, row.cotista.total_centavos]))
  const horasVoadaMes = new Map(espelho.mensal.map(row => [row.mes, row.cotista.minutos_operacionais / 60]))
  const mensal = Array.from({ length: 12 }, (_, index) => {
    const mes = `${ano}-${String(index + 1).padStart(2, '0')}`
    const valorCentavos = valoresCustosMes.get(mes) || 0
    const horasMesAtual = horasVoadaMes.get(mes) || 0
    const resumoMes = espelho.mensal.find(item => item.mes === mes)?.cotista
    return { mes, valorCentavos, horas: Number(horasMesAtual.toFixed(4)),
      custoHoraCentavos: resumoMes?.custo_hora_centavos ?? 0 }
  })
  const destinosMaisVisitados = (destinos.results || []).map(row => ({ destino: String(row.destino || 'Não informado'), quantidade: Number(row.quantidade || 0) }))
  return c.json({
    aeronave: vinculo,
    ano,
    estatisticas: {
      voos: Number(voos?.voos || 0), etapasRegistradas: Number(voos?.voos || 0), pousos: Number(voos?.pousos || 0),
      horas: Number(horas.toFixed(4)), tempoVooHoras: Number((aeronaveResumo.minutos_voo / 60).toFixed(4)),
      horasOperacionaisAeronave: Number(horas.toFixed(4)),
      horasOperacionaisCotista: Number(horasUso.toFixed(4)),
      horasVooAeronave: Number((aeronaveResumo.minutos_voo / 60).toFixed(4)),
      horasVooCotista: Number((cotaResumo.minutos_voo / 60).toFixed(4)),
      custoTotalAeronaveCentavos: custoCentavos,
      custoCotistaCentavos: cotaResumo.total_centavos,
      custoHoraAeronaveCentavos: aeronaveResumo.custo_hora_centavos,
      custoHoraCotistaCentavos: cotaResumo.custo_hora_centavos,
      destinoMaisVisitado: destinosMaisVisitados[0]?.destino || 'Não informado',
      custoHoraCentavos: aeronaveResumo.custo_hora_centavos ?? 0, custoTotalCentavos: custoCentavos,
      vooMaisLongo: vooMaisLongo ? {
        data: String(vooMaisLongo.data_registro || ''), origem: String(vooMaisLongo.aerodromo_partida || ''),
        destino: String(vooMaisLongo.aerodromo_chegada || ''), horas: Number(Number(vooMaisLongo.tempo_voo || 0).toFixed(2)),
      } : null,
    },
    destinosMaisVisitados,
    usoCota: {
      percentualSociedade, horasCotista: Number(horasUso.toFixed(2)),
      etapasCotista: cotaResumo.etapas_atribuidas, pousosCotista: Number(usoCotista?.pousos || 0),
      percentualUso, diferencaPontos: Number((percentualUso - percentualSociedade).toFixed(1)),
    },
    mensal,
    projecaoCustos: {
      // Natureza econômica do mesmo classificador do fechamento, nunca tipo_rateio.
      fixoCentavos: cotaResumo.grupos.fixos.valor_centavos,
      variavelPorVooCentavos: 0,
      variavelPorHoraCentavos: cotaResumo.grupos.variaveis.valor_centavos,
      extraCentavos: cotaResumo.grupos.extras.valor_centavos,
      naoClassificadosCentavos: cotaResumo.grupos.nao_classificados.valor_centavos,
      combustivelCentavos: espelho.combustivel_cotista_centavos,
    },
    categorias: (categorias.results || []).map(row => ({ categoria: String(row.categoria || 'Sem categoria'), valorCentavos: Number(row.valor_centavos || 0) })),
  })
})
portalRoutes.get('/api/portal/overview', async c => {
  const user = await portalSession(c)
  if (!user?.cliente_id && !user?.socio_id) return c.json({ error: 'cotista_nao_vinculado' }, 409)
  const today = new Date().toISOString().slice(0, 10)
  const inicioMes = `${today.slice(0, 8)}01`
  const rateioTable = user.cliente_id ? 'rateio_despesas' : 'rateio_hold'
  const rateioJoin = user.cliente_id
    ? 'JOIN cotista_aeronave ca ON ca.id = r.cotista_id'
    : 'JOIN cotista_aeronave ca ON ca.socio_id = r.socio_id AND ca.aeronave_id = r.aeronave_id'
  const rateioOwner = user.cliente_id ? '(ca.cliente_id = ?1 OR ca.socio_id = ?2)' : '(ca.socio_id = ?1 OR ca.socio_id = ?2)'
  const recenteRateioJoin = user.cliente_id ? 'JOIN cotista_aeronave rca ON rca.id = r.cotista_id' : 'JOIN cotista_aeronave rca ON rca.socio_id = r.socio_id AND rca.aeronave_id = r.aeronave_id'
  const recenteRateioOwner = user.cliente_id ? '(rca.cliente_id = ?1 OR rca.socio_id = ?2)' : '(rca.socio_id = ?1 OR rca.socio_id = ?2)'
  const [proximoVoo, voosRecentes, rateios] = await Promise.all([
    c.env.SHARE_DB.prepare(`SELECT s.id, s.aeronave_id, s.origem, s.destino, s.data_agendada, s.horario_previsto_agendamento, s.status, a.matricula_registro
      FROM solicitacoes_reserva_voo s JOIN cotista_aeronave ca ON ca.aeronave_id = s.aeronave_id LEFT JOIN aeronave a ON a.id = s.aeronave_id
     WHERE (ca.cliente_id = ?1 OR ca.socio_id = ?2) AND date(s.data_agendada) >= date(?3)
       AND lower(trim(COALESCE(s.status, ''))) IN ('pendente', 'aprovada', 'acionado', 'decolado', 'em_voo', 'em_solo')
     ORDER BY date(s.data_agendada), s.horario_previsto_agendamento LIMIT 1`).bind(user.cliente_id, user.socio_id, today).first<Record<string, unknown>>(),
    c.env.SHARE_DB.prepare(`SELECT DISTINCT l.id, l.data_registro, l.aerodromo_partida, l.aerodromo_chegada, l.tempo_total, l.tempo_voo, a.matricula_registro,
        COALESCE((SELECT SUM(r.valor_rateado_centavos) FROM ${rateioTable} r ${recenteRateioJoin}
          WHERE r.aeronave_id = l.aeronave_id AND date(r.data_emissao) = date(l.data_registro) AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELADO', 'CANCELADA', 'ESTORNO', 'ESTORNADO')
            AND ${recenteRateioOwner}), 0) AS custo_centavos
      FROM lancamentos_diario_bordo l JOIN cotista_aeronave ca ON ca.aeronave_id = l.aeronave_id LEFT JOIN aeronave a ON a.id = l.aeronave_id
     WHERE (ca.cliente_id = ?1 OR ca.socio_id = ?2) ORDER BY date(l.data_registro) DESC, l.id DESC LIMIT 3`).bind(user.cliente_id, user.socio_id).all<Record<string, unknown>>(),
    c.env.SHARE_DB.prepare(`SELECT r.valor_rateado_centavos, r.valor_pago_real_centavos, r.status, r.data_emissao
      FROM ${rateioTable} r ${rateioJoin}
     WHERE ${rateioOwner} AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELADO', 'CANCELADA', 'ESTORNO', 'ESTORNADO')`).bind(user.cliente_id, user.socio_id).all<Record<string, unknown>>()
  ])
  const resumo = (rateios.results || []).reduce<{ totalCentavos: number; pagoCentavos: number; mesCentavos: number; abertas: number; pagas: number }>((acc, row) => {
    const esperado = Number(row.valor_rateado_centavos || 0)
    const pago = Math.min(Number(row.valor_pago_real_centavos || 0), esperado)
    acc.totalCentavos += esperado
    acc.pagoCentavos += pago
    if (pago >= esperado || ['PAGO', 'REEMBOLSADO'].includes(String(row.status || '').toUpperCase())) acc.pagas += 1
    else acc.abertas += 1
    if (String(row.data_emissao || '').slice(0, 7) === inicioMes.slice(0, 7)) acc.mesCentavos += esperado
    return acc
  }, { totalCentavos: 0, pagoCentavos: 0, mesCentavos: 0, abertas: 0, pagas: 0 })
  const podeAgendar = portalHasFeature(user, 'agendamento')
  const podeVerFinanceiro = portalHasFeature(user, 'financeiro')
  const financeiroVazio = { totalCentavos: 0, pagoCentavos: 0, mesCentavos: 0, abertas: 0, pagas: 0, abertoCentavos: 0 }
  return c.json({
    proximoVoo: podeAgendar ? proximoVoo : null,
    voosRecentes: podeAgendar ? (voosRecentes.results || []).map(row => ({
      ...row, custo_centavos: podeVerFinanceiro ? row.custo_centavos : 0,
    })) : [],
    resumo: podeVerFinanceiro ? { ...resumo, abertoCentavos: resumo.totalCentavos - resumo.pagoCentavos } : financeiroVazio,
    manutencao: { mensagem: 'Consulte a área de Manutenções para ver os registros disponíveis.' },
  })
})
portalRoutes.get('/api/portal/aerodromos', async c => {
  const query = (c.req.query('q') || '').trim().toLowerCase()
  const pattern = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
  const result = await c.env.SHARE_DB.prepare("SELECT id, nome, designativo_icao, coordenadas FROM aerodromo WHERE lower(nome) LIKE ?1 ESCAPE '\\' OR lower(designativo_icao) LIKE ?1 ESCAPE '\\' ORDER BY designativo_icao LIMIT 50").bind(pattern).all<{ id: string; nome: string; designativo_icao: string; coordenadas: string | null }>()
  return c.json({ aerodromos: result.results })
})

function parseAeroportoCoordinates(value: unknown): { lat: number; lon: number } | null {
  const parts = String(value || '').split(',').map(part => Number(part.trim()))
  if (parts.length !== 2 || !parts.every(Number.isFinite) || Math.abs(parts[0]!) > 90 || Math.abs(parts[1]!) > 180) return null
  return { lat: parts[0]!, lon: parts[1]! }
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value ?? '').trim().replace(',', '.'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizarTextoCombustivel(value: unknown): string {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim()
}

function combustivelPorTexto(value: unknown): 'JET' | 'AVGAS' | null {
  const text = normalizarTextoCombustivel(value)
  if (!text) return null
  if (/TURBO|TURBINA|JATO|JET|QAV|QUEROSENE|PT6/.test(text)) return 'JET'
  if (/PISTAO|PISTON|AVGAS|GAV|100LL/.test(text)) return 'AVGAS'
  return null
}

async function resolverTipoCombustivel(db: D1Database, aircraft: Record<string, unknown>): Promise<'JET' | 'AVGAS' | null> {
  if (!String(aircraft.tipo_aeronave || '').trim()) return null
  return combustivelPorTexto(aircraft.tipo_aeronave)
}
portalRoutes.post('/api/portal/simulador/voo', async c => {
  const user = await portalSession(c)
  if (!user?.cliente_id && !user?.socio_id) return c.json({ error: 'cotista_nao_vinculado' }, 409)
  const body = await c.req.json<{ aeronave_id?: string; origem?: string; destino?: string; ida_e_volta?: boolean; dias_fora?: number; incluir_estrutura?: boolean; horas_ano?: number; quantidade_cotas?: number; dias_jornada?: number; passageiros?: number }>().catch(() => null)
  const aeronaveId = String(body?.aeronave_id || '').trim()
  const origem = String(body?.origem || '').trim().toUpperCase()
  const destino = String(body?.destino || '').trim().toUpperCase()
  if (!/^[0-9a-f-]{8,}$/i.test(aeronaveId) || !/^[A-Z0-9]{4}$/.test(origem) || !/^[A-Z0-9]{4}$/.test(destino) || origem === destino) {
    return c.json({ error: 'parametros_invalidos' }, 400)
  }
  const incluirEstrutura = body?.incluir_estrutura === true
  if (incluirEstrutura && !portalHasFeature(user, 'financeiro')) return c.json({ error: 'portal_feature_forbidden' }, 403)
  const horasAno = Number(body?.horas_ano), passageiros = Number(body?.passageiros), diasJornada = Number(body?.dias_jornada)
  const cotasCenario = body?.quantidade_cotas == null ? null : Number(body.quantidade_cotas)
  if (incluirEstrutura && (!Number.isFinite(horasAno) || horasAno < 1 || horasAno > 2000 || !Number.isInteger(passageiros) || passageiros < 1 || passageiros > MAX_RESERVATION_PASSENGERS || !Number.isInteger(diasJornada) || diasJornada < 1 || diasJornada > 31 || (cotasCenario !== null && (!Number.isInteger(cotasCenario) || cotasCenario < 1 || cotasCenario > 100)))) return c.json({ error: 'parametros_invalidos' }, 400)
  const idaVolta = body?.ida_e_volta === true
  const diasFora = idaVolta ? Math.min(30, Math.max(0, Math.trunc(Number(body?.dias_fora) || 0))) : 0
  const aircraftColumns = new Set((await c.env.SHARE_DB.prepare("SELECT name FROM pragma_table_info('aeronave')").all<{ name: string }>().catch(() => ({ results: [] }))).results?.map(column => column.name) || [])
  const optionalAircraftColumn = (name: string) => aircraftColumns.has(name) ? `a.${name}` : 'NULL'
  const aircraft = await c.env.SHARE_DB.prepare(`SELECT a.id, a.consumo_combustivel, a.velocidade_cruzeiro, ca.id AS cotista_id, ca.percentual_sociedade,
      a.tipo_aeronave, ${optionalAircraftColumn('custo_hora_complementar_centavos')} AS custo_hora_complementar_centavos,
      ${optionalAircraftColumn('taxas_trecho_centavos')} AS taxas_trecho_centavos,
      ${optionalAircraftColumn('custo_dia_pernoite_centavos')} AS custo_dia_pernoite_centavos,
      ${optionalAircraftColumn('reserva_manutencao_hora_centavos')} AS reserva_manutencao_hora_centavos,
      p.categoria AS performance_categoria, COALESCE(p.velocidade_cruzeiro_kt,
        (SELECT p2.velocidade_cruzeiro_kt FROM performance_aeronave p2
          WHERE lower(trim(p2.modelo)) = lower(trim(a.modelo)) ORDER BY p2.atualizado_em DESC LIMIT 1)) AS velocidade_cruzeiro_kt
    FROM aeronave a LEFT JOIN performance_aeronave p ON p.id = a.performance_aeronave_id
    JOIN cotista_aeronave ca ON ca.aeronave_id = a.id
    WHERE a.id = ?1 AND (ca.cliente_id = ?2 OR ca.socio_id = ?3)
      AND ca.id = (SELECT cotista_id FROM user_cliente WHERE id = ?4 LIMIT 1) LIMIT 1`)
    .bind(aeronaveId, user.cliente_id, user.socio_id, user.id).first<Record<string, unknown>>()
  if (!aircraft) return c.json({ error: 'aeronave_nao_vinculada' }, 404)
  const aerodromos = await c.env.SHARE_DB.prepare(`SELECT designativo_icao, coordenadas FROM aerodromo
    WHERE upper(trim(designativo_icao)) IN (?1, ?2)`).bind(origem, destino).all<{ designativo_icao: string; coordenadas: string | null }>()
  const airportByCode = new Map((aerodromos.results || []).map(item => [String(item.designativo_icao).toUpperCase(), item]))
  const origemCoord = parseAeroportoCoordinates(airportByCode.get(origem)?.coordenadas)
  const destinoCoord = parseAeroportoCoordinates(airportByCode.get(destino)?.coordenadas)
  if (!origemCoord || !destinoCoord) return c.json({ error: 'coordenadas_aerodromo_indisponiveis' }, 422)
  const velocidade = positiveNumber(aircraft.velocidade_cruzeiro_kt) || positiveNumber(aircraft.velocidade_cruzeiro)
  const consumo = positiveNumber(aircraft.consumo_combustivel)
  if (!velocidade || !consumo) return c.json({ error: 'dados_aeronave_indisponiveis' }, 422)
  const distanciaNm = haversineKm(origemCoord.lat, origemCoord.lon, destinoCoord.lat, destinoCoord.lon) / 1.852
  const distanciaRotaNm = distanciaNm * 1.05
  const tempoHoras = distanciaRotaNm / velocidade + 0.15
  const trechos = idaVolta ? 2 : 1
  const tipoCombustivel = await resolverTipoCombustivel(c.env.SHARE_DB, aircraft)
  if (!tipoCombustivel) return c.json({ error: 'tipo_combustivel_indisponivel' }, 422)
  const colunaPreco = tipoCombustivel === 'JET' ? 'preco_jet' : 'preco_avgas'
  const airportPrices = await Promise.all([origem, destino].map(async icao => {
    const local = await c.env.SHARE_DB.prepare(`SELECT AVG(${colunaPreco}) AS media FROM fornecedores_combustivel
      WHERE upper(COALESCE(codigo_icao, '')) = ?1 AND COALESCE(${colunaPreco}, 0) > 0`).bind(icao).first<{ media: number | null }>().catch(() => null)
    if (positiveNumber(local?.media)) return { price: positiveNumber(local?.media)!, source: 'fornecedores_combustivel_icao' }
    const historico = await c.env.SHARE_DB.prepare(`SELECT AVG(valor_unitario) AS media FROM abastecimentos
      WHERE (upper(COALESCE(local, '')) = ?1 OR upper(COALESCE(trecho, '')) LIKE ?2)
        AND upper(COALESCE(tipo_combustivel, '')) LIKE ?3 AND COALESCE(valor_unitario, 0) > 0
        AND date(data) >= date('now', '-365 days')`).bind(icao, `%${icao}%`, tipoCombustivel === 'JET' ? '%JET%' : '%AVGAS%').first<{ media: number | null }>().catch(() => null)
    if (positiveNumber(historico?.media)) return { price: positiveNumber(historico?.media)!, source: 'abastecimentos_historico_12m' }
    const nacional = await c.env.SHARE_DB.prepare(`SELECT AVG(${colunaPreco}) AS media FROM fornecedores_combustivel
      WHERE COALESCE(${colunaPreco}, 0) > 0`).first<{ media: number | null }>().catch(() => null)
    return positiveNumber(nacional?.media) ? { price: positiveNumber(nacional?.media)!, source: 'fornecedores_combustivel_media_banco' } : null
  }))
  const validPrices = airportPrices.filter((item): item is { price: number; source: string } => Boolean(item))
  if (!validPrices.length) return c.json({ error: 'preco_combustivel_indisponivel' }, 422)
  const precoMedio = validPrices.reduce((sum, item) => sum + item.price, 0) / validPrices.length
  const combustivel = Math.round(consumo * tempoHoras * precoMedio * 100) * trechos
  const complementar = Number(aircraft.custo_hora_complementar_centavos) > 0
    ? Math.round(Number(aircraft.custo_hora_complementar_centavos) * tempoHoras) * trechos : 0
  const taxas = Number(aircraft.taxas_trecho_centavos || 0) * trechos
  const pernoite = Number(aircraft.custo_dia_pernoite_centavos || 0) * diasFora
  const custosCompletos = aircraft.custo_hora_complementar_centavos != null
  let projecao = null
  if (incluirEstrutura) {
    const calendario = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date())
    const ano = Number(calendario.find(p => p.type === 'year')?.value)
    const mes = Number(calendario.find(p => p.type === 'month')?.value)
    const anterior = new Date(Date.UTC(ano, mes - 2, 1))
    const referencia = `${anterior.getUTCFullYear()}-${String(anterior.getUTCMonth() + 1).padStart(2, '0')}`
    const meses = mesesAte(referencia, 12)
    const historico = await carregarCustosPortal(c.env.SHARE_DB, aeronaveId, String(aircraft.cotista_id), user.cliente_id, user.socio_id, meses)
    const premissas = premissasHistoricasPortal(historico.rateios, historico.voos)
    const cadastrado = (value: unknown) => value !== null && value !== undefined && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
    const taxaCadastrada = cadastrado(aircraft.taxas_trecho_centavos)
    const taxaTrecho = taxaCadastrada ?? premissas.taxas_trecho_centavos
    const pernoiteCadastrado = cadastrado(aircraft.custo_dia_pernoite_centavos)
    const viagem = pernoiteCadastrado !== null ? pernoiteCadastrado * (diasJornada - 1) : premissas.viagem_dia_centavos !== null ? premissas.viagem_dia_centavos * diasJornada : null
    const reservaCadastrada = cadastrado(aircraft.reserva_manutencao_hora_centavos)
    const reservaHora = reservaCadastrada ?? cadastrado(aircraft.custo_hora_complementar_centavos) ?? premissas.reserva_hora_centavos
    const percentual = cotasCenario === null ? Number(aircraft.percentual_sociedade) / 100 : 1 / cotasCenario
    if (!Number.isFinite(percentual) || percentual <= 0 || percentual > 1) return c.json({ error: 'participacao_sociedade_indisponivel' }, 422)
    const camadas = calcularCamadasPortal({ horas: tempoHoras * trechos, horasAno, participacao: percentual, passageiros, dias: diasJornada,
      combustivel, taxas: taxaTrecho !== null ? taxaTrecho * trechos : null, viagem, fixoAnual: premissas.fixo_anual_centavos, reservaHora })
    const pendencias = [
      ...(taxaTrecho === null ? ['Taxas por trecho sem cadastro ou histórico.'] : []),
      ...(viagem === null ? ['Despesas de viagem sem cadastro ou histórico.'] : []),
      ...(premissas.fixo_anual_centavos === null ? ['Custos fixos sem histórico classificado.'] : []),
      ...(reservaHora === null ? ['Reserva de manutenção por hora sem cadastro ou histórico.'] : []),
      ...(premissas.nao_classificados_centavos > 0 ? ['Há despesas históricas sem natureza de custo; elas não foram projetadas.'] : []),
    ]
    projecao = { ...camadas, completo: camadas.completo && premissas.nao_classificados_centavos === 0,
      total_alocado_centavos: premissas.nao_classificados_centavos === 0 ? camadas.total_alocado_centavos : null,
      custo_hora_centavos: premissas.nao_classificados_centavos === 0 ? camadas.custo_hora_centavos : null,
      por_passageiro_centavos: premissas.nao_classificados_centavos === 0 ? camadas.por_passageiro_centavos : null,
      componentes: { combustivel_centavos: combustivel, taxas_centavos: taxaTrecho !== null ? taxaTrecho * trechos : null, viagem_centavos: viagem },
      meses_base: meses, meses_observados: premissas.meses_observados, percentual_participacao: percentual * 100,
      cotas_hipoteticas: cotasCenario, passageiros, pendencias,
      fontes: { fixos: 'media_mensal_historica_anualizada', taxas: taxaCadastrada !== null ? 'cadastro_aeronave' : 'media_por_etapa_registrada', viagem: pernoiteCadastrado !== null ? 'pernoite_cadastrado' : 'media_por_dia_com_voo', reservas: reservaCadastrada !== null ? 'reserva_cadastrada' : cadastrado(aircraft.custo_hora_complementar_centavos) !== null ? 'manutencao_e_reservas_cadastradas' : 'reserva_historica_por_hora' } }
  }
  return c.json({
    total_centavos: combustivel + complementar + taxas + pernoite,
    ...(projecao ? { projecao } : {}),
    distancia_nm: Number(distanciaRotaNm.toFixed(1)),
    tempo_voo_minutos: Math.max(1, Math.round(tempoHoras * 60)) * trechos,
    ida_e_volta: idaVolta,
    aviso: custosCompletos ? null : 'estimativa parcial',
    componentes: { combustivel_centavos: combustivel, manutencao_reservas_centavos: complementar, taxas_centavos: taxas, pernoite_centavos: pernoite },
    combustivel: { tipo: tipoCombustivel, preco_medio: precoMedio, fonte: validPrices.map(item => item.source) },
  })
})

portalRoutes.get('/api/portal/aeronave/:aeronaveId/rastreio', async c => {
  const user = await portalSession(c)
  if (!user?.cliente_id && !user?.socio_id) return c.json({ error: 'cotista_nao_vinculado' }, 409)
  const aeronaveId = c.req.param('aeronaveId')
  if (!/^[0-9a-f-]{8,}$/i.test(aeronaveId)) return c.json({ error: 'parametros_invalidos' }, 400)
  c.header('Cache-Control', 'private, no-store, no-cache, must-revalidate')
  if (!(await checkRateLimit(c, `portal-rastreio:${user.id}:${clientIp(c)}`, 120))) return c.json({ error: 'muitas_tentativas' }, 429)
  const ownedAircraft = await c.env.SHARE_DB.prepare(`SELECT a.id FROM aeronave a JOIN cotista_aeronave ca ON ca.aeronave_id = a.id
    WHERE a.id = ?1 AND (ca.cliente_id = ?2 OR ca.socio_id = ?3)
      AND ca.id = (SELECT cotista_id FROM user_cliente WHERE id = ?4 LIMIT 1) LIMIT 1`)
    .bind(aeronaveId, user.cliente_id, user.socio_id, user.id).first<{ id: string }>()
  if (!ownedAircraft) return c.json({ error: 'aeronave_nao_vinculada' }, 404)
  const schema = await c.env.SHARE_DB.prepare("SELECT name FROM pragma_table_info('aeronave')").all<{ name: string }>()
  const icaoColumn = (schema.results || []).some(column => column.name === 'icao_hex') ? 'a.icao_hex' : 'NULL AS icao_hex'
  const statusSql = statusAgendamentoComJornadaSql(await jornadaOperacionalDisponivel(c.env.SHARE_DB))
  const flight = await c.env.SHARE_DB.prepare(`WITH voos AS (
      SELECT ${statusSql} AS status, s.data_agendada, s.horario_previsto_agendamento,
        s.atualizado_em, s.criado_em, s.cliente_id, s.socio_id, s.cliente_emprestimo_id,
        s.socio_emprestimo_id, a.matricula_registro, ${icaoColumn}
      FROM solicitacoes_reserva_voo s LEFT JOIN aeronave a ON a.id = s.aeronave_id
      WHERE s.aeronave_id = ?1
    )
    SELECT * FROM voos
    WHERE status IN ('decolado', 'em_voo', 'em voo', 'em_rota', 'em rota')
      OR (status = 'aprovada' AND datetime(COALESCE(horario_previsto_agendamento, data_agendada || 'T00:00:00Z'))
        BETWEEN datetime('now', '-6 hours') AND datetime('now', '+2 hours'))
    ORDER BY COALESCE(atualizado_em, criado_em) DESC LIMIT 1`).bind(aeronaveId).first<Record<string, unknown>>()
  if (!flight) return c.json({ status: 'sem_voo' })
  const isOwnFlight = (user.cliente_id && [flight.cliente_id, flight.cliente_emprestimo_id].includes(user.cliente_id))
    || (user.socio_id && [flight.socio_id, flight.socio_emprestimo_id].includes(user.socio_id))
  if (!isOwnFlight) return c.json({ status: 'em_voo' })
  configurarProvedor(c.env.ADSB_PROVIDER)
  const positions = await buscarPosicoes({
    hex: flight.icao_hex ? [String(flight.icao_hex)] : [],
    matriculas: flight.matricula_registro ? [String(flight.matricula_registro)] : [],
  })
  const identifier = String(flight.icao_hex || '').trim().toUpperCase()
  const registration = String(flight.matricula_registro || '').trim().toUpperCase()
  const position: PosicaoAeronave | undefined = positions.find(item => item.hex === identifier || item.matricula === registration)
  const vooAprovadoConfirmado = flight.status === 'aprovada'
    && Boolean(position && !position.no_solo && position.visto_ha_s !== null && position.visto_ha_s <= 30)
  if (flight.status === 'aprovada' && !vooAprovadoConfirmado) return c.json({ status: 'sem_voo' })
  if (!position || position.visto_ha_s === null || position.visto_ha_s > 300) return c.json({ status: 'em_voo', posicao: null })
  return c.json({ status: 'em_voo', posicao: {
    lat: position.lat, lon: position.lon, altitude_ft: position.alt_ft, velocidade_kt: position.gs_kt,
    rumo_graus: position.rumo_graus, atualizado_ha_s: position.visto_ha_s,
  } })
})

portalRoutes.get('/api/portal/simulador/combustivel', async c => {
  const user = await portalSession(c)
  if (!user?.cliente_id && !user?.socio_id) return c.json({ error: 'cliente_nao_vinculado' }, 409)
  const icao = (c.req.query('icao') || '').trim().toUpperCase()
  const tipo = (c.req.query('tipo') || '').trim().toUpperCase()
  if (!/^[A-Z]{4}$/.test(icao) || !['AVGAS', 'JET'].includes(tipo)) return c.json({ error: 'parametros_invalidos' }, 400)
  const coluna = tipo === 'JET' ? 'preco_jet' : 'preco_avgas'
  const db = c.env.SHARE_DB
  const local = await db.prepare(`SELECT AVG(${coluna}) AS media, COUNT(*) AS amostras FROM fornecedores_combustivel WHERE upper(COALESCE(codigo_icao, '')) = ?1 AND COALESCE(${coluna}, 0) > 0`).bind(icao).first<{ media: number | null; amostras: number }>().catch(() => null)
  if (local?.media && local.media > 0) return c.json({ icao, tipo, preco_medio: local.media, fonte: 'fornecedores_combustivel_icao', amostras: local.amostras })
  const nacional = await db.prepare(`SELECT AVG(${coluna}) AS media, COUNT(*) AS amostras FROM fornecedores_combustivel WHERE COALESCE(${coluna}, 0) > 0`).first<{ media: number | null; amostras: number }>().catch(() => null)
  if (nacional?.media && nacional.media > 0) return c.json({ icao, tipo, preco_medio: nacional.media, fonte: 'fornecedores_combustivel_media_banco', amostras: nacional.amostras })
  const historico = await db.prepare("SELECT AVG(valor_unitario) AS media, COUNT(*) AS amostras FROM abastecimentos WHERE (upper(COALESCE(local, '')) = ?1 OR upper(COALESCE(trecho, '')) LIKE ?2) AND upper(COALESCE(tipo_combustivel, '')) LIKE ?3 AND COALESCE(valor_unitario, 0) > 0 AND date(data) >= date('now', '-365 days')").bind(icao, `%${icao}%`, tipo === 'JET' ? '%JET%' : '%AVGAS%').first<{ media: number | null; amostras: number }>().catch(() => null)
  return c.json({ icao, tipo, preco_medio: historico?.media && historico.media > 0 ? historico.media : null, fonte: historico?.media ? 'abastecimentos_historico_12m' : 'indisponivel', amostras: historico?.amostras || 0 })
})

portalRoutes.get('/api/portal/disponibilidade', async c => {
  const user = await portalSession(c)
  if (!user?.cliente_id && !user?.socio_id) return c.json({ error: 'cliente_nao_vinculado' }, 409)
  const from = c.req.query('de') || new Date().toISOString().slice(0, 10)
  const to = c.req.query('ate') || from
  const aircraftSql = "SELECT DISTINCT a.id, a.matricula_registro, a.fabricante, a.modelo, a.tipo_aeronave, a.status, a.consumo_combustivel, a.velocidade_cruzeiro, a.preco_hora, COALESCE(p.velocidade_cruzeiro_kt, (SELECT p2.velocidade_cruzeiro_kt FROM performance_aeronave p2 WHERE lower(trim(p2.modelo)) = lower(trim(a.modelo)) ORDER BY p2.atualizado_em DESC LIMIT 1)) AS velocidade_cruzeiro_kt FROM aeronave a LEFT JOIN performance_aeronave p ON p.id = a.performance_aeronave_id JOIN cotista_aeronave ca ON ca.aeronave_id = a.id WHERE lower(a.status) = 'ativa' AND (ca.cliente_id = ?1 OR ca.socio_id = ?2) ORDER BY a.matricula_registro"
  const aircraftWithWeightSql = aircraftSql.replace('AS velocidade_cruzeiro_kt FROM aeronave', 'AS velocidade_cruzeiro_kt, (SELECT MAX(pb.peso_maximo_decolagem) FROM ctm_peso_balanceamento pb WHERE pb.aeronave_id = a.id) AS peso_maximo_decolagem FROM aeronave')
  const aircraftPromise = c.env.SHARE_DB.prepare(aircraftWithWeightSql).bind(user.cliente_id, user.socio_id).all().catch(async error => {
    log.warn('[portal] MTOW indisponível; usando a performance da aeronave sem peso máximo', error)
    return c.env.SHARE_DB.prepare(aircraftSql).bind(user.cliente_id, user.socio_id).all()
  })
  const [aircraft, reservations] = await Promise.all([
    aircraftPromise,
    c.env.SHARE_DB.prepare("SELECT aeronave_id, data_agendada, dias_duracao, status FROM solicitacoes_reserva_voo WHERE date(data_agendada) <= date(?2) AND date(data_agendada, '+' || (COALESCE(dias_duracao, 1) - 1) || ' days') >= date(?1) AND lower(trim(COALESCE(status, ''))) IN ('pendente', 'aprovada', 'acionado', 'decolado', 'em_voo', 'em_solo') ORDER BY data_agendada").bind(from, to).all(),
  ])
  return c.json({ from, to, aeronaves: aircraft.results, reservas: reservations.results })
})

portalRoutes.get('/api/portal/solicitacoes', async c => {
  const user = await portalSession(c)
  if (!user?.cliente_id && !user?.socio_id) return c.json([])
  const result = await c.env.SHARE_DB.prepare(`SELECT s.id, s.aeronave_id, s.origem, s.destino, s.data_agendada, s.horario_previsto_agendamento,
    s.dias_duracao, s.numero_passageiros, s.voo_emprestado,
    CASE WHEN lower(trim(COALESCE(s.status, ''))) = 'pendente'
      AND EXISTS (SELECT 1 FROM jornadas_voo j WHERE j.solicitacao_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM jornadas_voo j WHERE j.solicitacao_id = s.id AND lower(trim(COALESCE(j.status, ''))) <> 'encerrada')
      THEN 'encerrada' ELSE s.status END AS status,
    s.motivo_rejeicao, COALESCE(NULLIF(TRIM(s.numero_voo), ''),
      (SELECT NULLIF(TRIM(l.numero_voo), '') FROM pernas_jornada_voo p
        JOIN jornadas_voo j ON j.id = p.jornada_id JOIN lancamentos_diario_bordo l ON l.id = p.lancamento_diario_id
        WHERE j.solicitacao_id = s.id AND date(l.data_registro) = date(s.data_agendada)
          AND NULLIF(TRIM(l.numero_voo), '') IS NOT NULL ORDER BY p.numero LIMIT 1)) AS numero_voo,
    s.criado_em, a.matricula_registro, a.modelo,
    COALESCE(c.razao_social, hs.nome, 'Cotista') AS cotista_nome, COALESCE(t.nome_completo, tf.nome_completo) AS piloto_nome,
    COALESCE((SELECT MIN(l.data_registro || 'T' || l.tempo_dep || ':00Z') FROM pernas_jornada_voo p
      JOIN jornadas_voo j ON j.id = p.jornada_id JOIN lancamentos_diario_bordo l ON l.id = p.lancamento_diario_id
      WHERE j.solicitacao_id = s.id AND date(l.data_registro) = date(s.data_agendada)
        AND NULLIF(TRIM(l.tempo_dep), '') IS NOT NULL),
      (SELECT MIN(COALESCE(p.horario_dep, j.horario_acionamento)) FROM jornadas_voo j
      LEFT JOIN pernas_jornada_voo p ON p.jornada_id = COALESCE(j.jornada_principal_id, j.id)
      WHERE j.solicitacao_id = s.id AND COALESCE(p.horario_dep, j.horario_acionamento) IS NOT NULL),
      (SELECT MIN(j.horario_acionamento) FROM jornadas_voo j WHERE j.solicitacao_id = s.id)) AS horario_decolagem_real,
    COALESCE((SELECT MAX(l.data_registro || 'T' || l.tempo_pou || ':00Z') FROM pernas_jornada_voo p
      JOIN jornadas_voo j ON j.id = p.jornada_id JOIN lancamentos_diario_bordo l ON l.id = p.lancamento_diario_id
      WHERE j.solicitacao_id = s.id AND date(l.data_registro) = date(s.data_agendada)
        AND NULLIF(TRIM(l.tempo_pou), '') IS NOT NULL),
      (SELECT MAX(COALESCE(p.horario_pouso, j.horario_pouso)) FROM jornadas_voo j
      LEFT JOIN pernas_jornada_voo p ON p.jornada_id = COALESCE(j.jornada_principal_id, j.id)
      WHERE j.solicitacao_id = s.id AND COALESCE(p.horario_pouso, j.horario_pouso) IS NOT NULL),
      (SELECT MAX(j.horario_pouso) FROM jornadas_voo j WHERE j.solicitacao_id = s.id)) AS horario_pouso_real,
    COALESCE((SELECT CAST(ROUND(SUM(voo.tempo_voo) * 60) AS INTEGER) FROM (
      SELECT DISTINCT l.id, l.tempo_voo FROM pernas_jornada_voo p
      JOIN jornadas_voo j ON j.id = p.jornada_id JOIN lancamentos_diario_bordo l ON l.id = p.lancamento_diario_id
      WHERE j.solicitacao_id = s.id AND date(l.data_registro) = date(s.data_agendada) AND l.tempo_voo IS NOT NULL) voo),
    (SELECT CAST(ROUND(SUM((julianday(voo.horario_pouso) - julianday(voo.horario_dep)) * 1440)) AS INTEGER)
      FROM (SELECT DISTINCT p.id, p.horario_dep, p.horario_pouso FROM jornadas_voo j
        JOIN pernas_jornada_voo p ON p.jornada_id = COALESCE(j.jornada_principal_id, j.id)
        WHERE j.solicitacao_id = s.id AND p.horario_dep IS NOT NULL AND p.horario_pouso IS NOT NULL) voo)) AS tempo_voo_minutos
    FROM solicitacoes_reserva_voo s
    LEFT JOIN aeronave a ON a.id = s.aeronave_id LEFT JOIN cliente c ON c.id = s.cliente_id
    LEFT JOIN hold_socios hs ON hs.id = s.socio_id LEFT JOIN tripulacao t ON t.id = s.piloto_id
    LEFT JOIN tripulacao_freelancer tf ON tf.id = s.piloto_id
    WHERE s.cliente_id = ?1 OR s.socio_id = ?2 ORDER BY s.criado_em DESC`).bind(user?.cliente_id, user?.socio_id).all<Record<string, unknown>>()
  return c.json(result.results.map(row => ({ ...row, mensagem_confirmacao: portalConfirmationMessage(row) })))
})

portalRoutes.post('/api/portal/solicitacoes', async c => {
  const user = await portalSession(c)
  const clientId = user ? await portalClientId(c, user) : null
  if (!user?.cliente_id && !user?.socio_id) return c.json({ error: 'cotista_nao_vinculado' }, 409)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || !body.aeronave_id || !body.origem || !body.destino || !body.data_agendada) return c.json({ error: 'campos_obrigatorios_ausentes' }, 400)
  const dataAgendada = String(body.data_agendada).trim()
  const hoje = new Date().toISOString().slice(0, 10)
  if (!portalValidIsoDate(dataAgendada) || dataAgendada < hoje) return c.json({ error: 'data_agendada_invalida' }, 400)
  const horarioPrevisto = body.horario_previsto_agendamento ? normalizarHorarioAgendamento(dataAgendada, body.horario_previsto_agendamento) : null
  if (body.horario_previsto_agendamento && !horarioPrevisto) return c.json({ error: 'horario_previsto_invalido' }, 400)
  const diasDuracao = body.dias_duracao == null ? 1 : Number(body.dias_duracao)
  const numeroPassageiros = body.numero_passageiros == null ? 1 : Number(body.numero_passageiros)
  if (!Number.isInteger(diasDuracao) || diasDuracao < 1 || diasDuracao > MAX_RESERVATION_DAYS) return c.json({ error: 'dias_duracao_invalido' }, 400)
  if (!Number.isInteger(numeroPassageiros) || numeroPassageiros < 1 || numeroPassageiros > MAX_RESERVATION_PASSENGERS) return c.json({ error: 'numero_passageiros_invalido' }, 400)
  const dataFim = portalReservationEnd(dataAgendada, diasDuracao)
  const aircraft = await c.env.SHARE_DB.prepare("SELECT DISTINCT a.id, a.status FROM aeronave a JOIN cotista_aeronave ca ON ca.aeronave_id = a.id WHERE a.id = ?1 AND lower(a.status) = 'ativa' AND (ca.cliente_id = ?2 OR ca.socio_id = ?3)").bind(String(body.aeronave_id), user?.cliente_id, user?.socio_id).first<{ id: string; status: string }>()
  if (!aircraft) return c.json({ error: 'aeronave_indisponivel' }, 409)
  const conflict = await c.env.SHARE_DB.prepare("SELECT id FROM solicitacoes_reserva_voo WHERE aeronave_id = ?1 AND lower(trim(COALESCE(status, ''))) IN ('pendente', 'aprovada', 'acionado', 'decolado', 'em_voo', 'em_solo') AND date(data_agendada) <= date(?2) AND date(data_agendada, '+' || (COALESCE(dias_duracao, 1) - 1) || ' days') >= date(?3) LIMIT 1").bind(aircraft.id, dataFim, dataAgendada).first<{ id: string }>()
  if (conflict) return c.json({ error: 'aeronave_indisponivel_no_periodo' }, 409)
  const id = crypto.randomUUID()
  await c.env.SHARE_DB.prepare("INSERT INTO solicitacoes_reserva_voo (id, cliente_id, socio_id, aeronave_id, voo_emprestado, origem, destino, data_agendada, horario_previsto_agendamento, dias_duracao, numero_passageiros, status, observacoes, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").bind(id, clientId, user?.socio_id || null, String(body.aeronave_id), String(body.voo_emprestado || 'nao'), String(body.origem), String(body.destino), dataAgendada, horarioPrevisto, diasDuracao, numeroPassageiros, body.observacoes ? String(body.observacoes) : null).run()
  const row = await c.env.SHARE_DB.prepare("SELECT s.*, c.razao_social AS cliente_razao_social, a.matricula_registro, a.fabricante, a.modelo FROM solicitacoes_reserva_voo s LEFT JOIN cliente c ON c.id = s.cliente_id LEFT JOIN aeronave a ON a.id = s.aeronave_id WHERE s.id = ?1").bind(id).first<Record<string, unknown>>()
  let notificationSent = true
  try {
    await portalTelegram(c, portalTelegramText(row || { ...body, id }, user?.nome_exibicao || 'Cliente'))
  } catch (error) {
    notificationSent = false
    log.error('[portal] telegram notification failed after saving request', error)
  }
  return c.json({ success: true, solicitacao_id: id, notification_sent: notificationSent, message: 'Solicitação enviada com sucesso. Aguarde a confirmação da coordenação.' }, 201)
})

