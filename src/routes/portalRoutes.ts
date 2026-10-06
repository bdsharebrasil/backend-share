import { Hono, Context } from "hono"
import { checkRateLimit, clientIp } from "../lib/cache"
import { normalizarHorarioAgendamento } from "../lib/schedule"

type Bindings = { SHARE_DB: D1Database; CACHE_KV: KVNamespace; RATE_LIMITER: DurableObjectNamespace; CLIENT_SESSION_SECRET?: string; CLIENT_SESSION_TTL_SECONDS?: string; INTERNAL_TOKEN?: string; TELEGRAM_BOT_TOKEN?: string }
type Variables = Record<string, never>

export const portalRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const log = { debug: (..._args: unknown[]) => undefined, warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) }
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

async function portalCreateSession(user: PortalUser, c: Context<{ Bindings: Bindings; Variables: Variables }>): Promise<{ token: string; expires_at: string }> {
  const exp = Math.floor(Date.now() / 1000) + Number(c.env.CLIENT_SESSION_TTL_SECONDS || PORTAL_SESSION_TTL)
  const encoded = portalBase64Url(portalEncoder.encode(JSON.stringify({ ...user, exp })))
  const signature = portalBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await portalHmacKey(portalSessionSecret(c)), portalEncoder.encode(encoded))))
  return { token: `${encoded}.${signature}`, expires_at: new Date(exp * 1000).toISOString() }
}

async function portalSession(c: Context<{ Bindings: Bindings; Variables: Variables }>): Promise<PortalUser | null> {
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

async function portalTelegram(c: Context<{ Bindings: Bindings; Variables: Variables }>, message: string): Promise<void> {
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

portalRoutes.post('/api/portal/login', async c => {
  try {
    if (!(await checkRateLimit(c, `portal-login:${clientIp(c)}`, 12))) return c.json({ error: 'muitas_tentativas' }, 429)
    const body = await c.req.json<{ login?: string; senha?: string }>().catch(() => null)
    const login = body?.login?.trim().toLowerCase()
    const senha = body?.senha || ''
    if (!login || !senha) return c.json({ error: 'login_e_senha_obrigatorios' }, 400)

    const row = await c.env.SHARE_DB.prepare('SELECT id, login, senha, nome_exibicao, url_avatar, cliente_id, socio_id FROM user_cliente WHERE lower(login) = ?1 LIMIT 1').bind(login).first<PortalUser & { senha: string }>()
    const verification = row ? await portalVerifyPassword(senha, row.senha) : null
    if (!row || !verification?.valid) return c.json({ error: 'credenciais_invalidas' }, 401)
    if (Boolean(row.cliente_id) === Boolean(row.socio_id)) return c.json({ error: 'vinculo_usuario_invalido' }, 409)
    if (verification.legacy) await c.env.SHARE_DB.prepare('UPDATE user_cliente SET senha = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(await portalCreatePasswordHash(senha), row.id).run()

    const user: PortalUser = { id: row.id, login: row.login, nome_exibicao: row.nome_exibicao, url_avatar: row.url_avatar, cliente_id: row.cliente_id, socio_id: row.socio_id }
    return c.json({ user, ...(await portalCreateSession(user, c)) })
  } catch (error: any) {
    log.error('[portal/login]', error?.message ?? error)
    return c.json({ error: 'portal_login_indisponivel' }, 500)
  }
})

portalRoutes.use('/api/portal/*', async (c, next) => {
  if (c.req.path === '/api/portal/login') return next()
  if (!(await portalSession(c))) return c.json({ error: 'client_auth_required' }, 401)
  return next()
})

portalRoutes.get('/api/portal/me', async c => c.json({ user: await portalSession(c) }))

portalRoutes.get('/api/portal/contexto', async c => {
  const user = await portalSession(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  return c.json(await portalContext(c, user))
})

portalRoutes.get('/api/portal/aerodromos', async c => {
  const query = (c.req.query('q') || '').trim().toLowerCase()
  const pattern = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
  const result = await c.env.SHARE_DB.prepare("SELECT id, nome, designativo_icao FROM aerodromo WHERE lower(nome) LIKE ?1 ESCAPE '\\' OR lower(designativo_icao) LIKE ?1 ESCAPE '\\' ORDER BY designativo_icao LIMIT 50").bind(pattern).all<{ id: string; nome: string; designativo_icao: string }>()
  return c.json({ aerodromos: result.results })
})

portalRoutes.get('/api/portal/disponibilidade', async c => {
  const user = await portalSession(c)
  if (!user?.cliente_id && !user?.socio_id) return c.json({ error: 'cliente_nao_vinculado' }, 409)
  const from = c.req.query('de') || new Date().toISOString().slice(0, 10)
  const to = c.req.query('ate') || from
  const [aircraft, reservations] = await Promise.all([
    c.env.SHARE_DB.prepare("SELECT DISTINCT a.id, a.matricula_registro, a.fabricante, a.modelo, a.tipo_aeronave, a.status FROM aeronave a JOIN cotista_aeronave ca ON ca.aeronave_id = a.id WHERE lower(a.status) = 'ativa' AND (ca.cliente_id = ?1 OR ca.socio_id = ?2) ORDER BY a.matricula_registro").bind(user.cliente_id, user.socio_id).all(),
    c.env.SHARE_DB.prepare("SELECT aeronave_id, data_agendada, dias_duracao, status FROM solicitacoes_reserva_voo WHERE data_agendada BETWEEN ?1 AND ?2 AND status IN ('pendente', 'aprovada') ORDER BY data_agendada").bind(from, to).all(),
  ])
  return c.json({ from, to, aeronaves: aircraft.results, reservas: reservations.results })
})

portalRoutes.get('/api/portal/solicitacoes', async c => {
  const user = await portalSession(c)
  const clientId = user ? await portalClientId(c, user) : null
  if (!clientId) return c.json([])
  const result = await c.env.SHARE_DB.prepare("SELECT s.id, s.aeronave_id, s.origem, s.destino, s.data_agendada, s.horario_previsto_agendamento, s.dias_duracao, s.numero_passageiros, s.voo_emprestado, s.status, s.motivo_rejeicao, s.numero_voo, s.criado_em, a.matricula_registro, a.modelo FROM solicitacoes_reserva_voo s LEFT JOIN aeronave a ON a.id = s.aeronave_id WHERE s.cliente_id = ?1 ORDER BY s.criado_em DESC").bind(clientId).all()
  return c.json(result.results)
})

portalRoutes.post('/api/portal/solicitacoes', async c => {
  const user = await portalSession(c)
  const clientId = user ? await portalClientId(c, user) : null
  if (!clientId) return c.json({ error: 'cliente_nao_vinculado' }, 409)
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
  const conflict = await c.env.SHARE_DB.prepare("SELECT id FROM solicitacoes_reserva_voo WHERE aeronave_id = ?1 AND status IN ('pendente', 'aprovada') AND date(data_agendada) <= date(?2) AND date(data_agendada, '+' || (COALESCE(dias_duracao, 1) - 1) || ' days') >= date(?3) LIMIT 1").bind(aircraft.id, dataFim, dataAgendada).first<{ id: string }>()
  if (conflict) return c.json({ error: 'aeronave_indisponivel_no_periodo' }, 409)
  const id = crypto.randomUUID()
  await c.env.SHARE_DB.prepare("INSERT INTO solicitacoes_reserva_voo (id, cliente_id, aeronave_id, voo_emprestado, origem, destino, data_agendada, horario_previsto_agendamento, dias_duracao, numero_passageiros, status, observacoes, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").bind(id, clientId, String(body.aeronave_id), String(body.voo_emprestado || 'nao'), String(body.origem), String(body.destino), dataAgendada, horarioPrevisto, diasDuracao, numeroPassageiros, body.observacoes ? String(body.observacoes) : null).run()
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
