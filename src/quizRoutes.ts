import { Hono } from 'hono'
import type { Env } from './types/env'
import { checkRateLimit, clientIp } from './lib/cache'

type QuizBindings = Pick<Env, 'SHARE_DB' | 'ALLOWED_ORIGINS' | 'RATE_LIMITER' | 'INTERNAL_TOKEN'>
const quizRoutes = new Hono<{ Bindings: QuizBindings }>()
const VERSAO_QUIZ = '2026-11-v1'
const MAX_BODY = 12_000
const perfis = new Set(['cirrus', 'matrix', 'seneca', 'cheyenne', 'citation'])
const momentos = new Set(['EXPLORANDO', 'ATE_3_MESES', 'ATE_6_MESES', 'ESTE_ANO'])
const opcoes: Record<string, Set<string>> = {
  uso: new Set(['familia', 'negocios', 'fazendas', 'equipe']),
  pax: new Set(['1-2', '3-4', '5-6', '7+']),
  distancia: new Set(['regional', 'media', 'longa', 'muito-longa']),
  horas: new Set(['ate-3', '3-6', '6-12', '12+', 'nao-sei']),
  pista: new Set(['asfalto', 'misto', 'terra', 'nao-sei']),
  prioridade: new Set(['tempo', 'equilibrio', 'custo']),
  conforto: new Set(['sim', 'indiferente']),
  seguranca: new Set(['dois-motores', 'caps', 'indiferente']),
}
const encoder = new TextEncoder()
const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const sha256 = async (value: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
async function sign(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}
function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : ''
}
function normalizar(body: any) {
  if (!body || typeof body !== 'object' || body.website) throw new Error('Envio inválido.')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.chave_reenvio || '') || body.versao !== VERSAO_QUIZ) throw new Error('Atualize a página e revise as respostas.')
  const answers = body.respostas
  if (!answers || Object.keys(answers).length !== Object.keys(opcoes).length || Object.entries(opcoes).some(([id, values]) => !values.has(answers[id]))) throw new Error('Respostas inválidas ou incompletas.')
  const c = body.contato
  if (!c || c.consentimento !== true) throw new Error('É necessário autorizar o registro e contato.')
  const nome = text(c.nome, 100)
  const telefone = String(c.telefone || '').replace(/\D/g, '')
  const telefoneBR = telefone.length === 10 || telefone.length === 11 ? `55${telefone}` : telefone
  const cidade = text(c.cidade, 100) || 'Não informado'
  if (nome.length < 2 || !/^55[1-9]{2}[2-9][0-9]{7,8}$/.test(telefoneBR)) throw new Error('Confira nome e WhatsApp com DDD.')
  const momento = momentos.has(c.momento) ? c.momento : 'EXPLORANDO'
  const resultado = body.resultado
  if (!resultado || !(resultado.principal == null || perfis.has(resultado.principal)) || !(resultado.segunda == null || perfis.has(resultado.segunda)) || !Array.isArray(resultado.motivos) || !Array.isArray(resultado.avisos)) throw new Error('Resultado inválido.')
  const sanitizeList = (value: unknown) => (value as unknown[]).slice(0, 20).map((item) => text(item, 300))
  const resultadoSeguro = { principal: resultado.principal ?? null, segunda: resultado.segunda ?? null, motivos: sanitizeList(resultado.motivos), avisos: sanitizeList(resultado.avisos) }
  const origem: Record<string, string> = {}
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) if (body.origem?.[key]) origem[key] = text(body.origem[key], 150)
  const respostas = Object.fromEntries(Object.keys(opcoes).map((key) => [key, answers[key]]))
  return {
    chave: String(body.chave_reenvio).toLowerCase(), nome, telefone: telefoneBR, cidade,
    rotas: text(c.rotas, 250), momento, respostas, resultado: resultadoSeguro, origem,
    duracao: Number.isFinite(body.duracao_segundos) ? Math.max(0, Math.min(86400, Math.floor(body.duracao_segundos))) : 0,
  }
}

quizRoutes.post('/api/quiz/leads', async (c) => {
  const origin = c.req.header('Origin') || ''
  const allowed = c.env.ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? []
  if (!origin || !allowed.includes(origin)) return c.json({ erro: 'Origem não autorizada.' }, 403)
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return c.json({ erro: 'Use application/json.' }, 415)
  const length = Number(c.req.header('content-length') || 0)
  if (length > MAX_BODY) return c.json({ erro: 'Envio muito grande.' }, 413)
  try {
    if (!(await checkRateLimit(c as any, `quiz-lead:${clientIp(c as any)}`, 60))) return c.json({ erro: 'Muitas tentativas. Tente novamente mais tarde.' }, 429)
    const raw = await c.req.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY) return c.json({ erro: 'Envio muito grande.' }, 413)
    let body: any
    try { body = JSON.parse(raw) } catch { return c.json({ erro: 'JSON inválido.' }, 400) }
    let data
    try { data = normalizar(body) } catch (error: any) { return c.json({ erro: error.message || 'Envio inválido.' }, 400) }
    const db = c.env.SHARE_DB
    const keyHash = await sha256(data.chave)
    const summary = await sha256(JSON.stringify(data))
    const token = await sign(c.env.INTERNAL_TOKEN, `quiz-event:${data.chave}`)
    const id = crypto.randomUUID()
    const protocol = `SH-${id.replace(/-/g, '').slice(0, 12).toUpperCase()}`
    const result = data.resultado
    await db.batch([
      db.prepare(`INSERT INTO leads_quiz (id,protocolo,chave_reenvio,resumo_envio,nome,telefone,cidade,rotas,momento,respostas_json,resultado_json,aeronave_sugerida,aeronave_alternativa,versao_quiz,origem_json,duracao_segundos,consentimento,versao_consentimento,token_evento_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'2026-11-v1',?) ON CONFLICT(chave_reenvio) DO NOTHING`).bind(id, protocol, keyHash, summary, data.nome, data.telefone, data.cidade, data.rotas || null, data.momento, JSON.stringify(data.respostas), JSON.stringify(result), result.principal, result.segunda, VERSAO_QUIZ, JSON.stringify(data.origem), data.duracao, await sha256(token)),
      db.prepare("INSERT OR IGNORE INTO eventos_quiz (id,lead_id,tipo) SELECT ?,id,'PERFIL_SALVO' FROM leads_quiz WHERE chave_reenvio=?").bind(crypto.randomUUID(), keyHash),
    ])
    const saved = await db.prepare('SELECT id,protocolo,resumo_envio,resultado_json FROM leads_quiz WHERE chave_reenvio=?').bind(keyHash).first<any>()
    if (!saved || saved.resumo_envio !== summary) return c.json({ erro: 'Este envio já foi registrado com outros dados. Refaça o quiz para criar outro perfil.' }, 409)
    c.header('Cache-Control', 'no-store')
    return c.json({ id: saved.id, protocolo: saved.protocolo, token_evento: token, resultado: JSON.parse(saved.resultado_json) }, 201)
  } catch {
    return c.json({ erro: 'Não foi possível salvar agora. Tente novamente.' }, 503)
  }
})

quizRoutes.post('/api/quiz/leads/:id/eventos', async (c) => {
  const origin = c.req.header('Origin') || ''
  const allowed = c.env.ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? []
  if (!origin || !allowed.includes(origin)) return c.json({ erro: 'Origem não autorizada.' }, 403)
  try {
    if (!(await checkRateLimit(c as any, `quiz-event:${clientIp(c as any)}`, 60))) return c.json({ erro: 'Muitas tentativas.' }, 429)
    const body = await c.req.json<any>()
    if (body?.tipo !== 'WHATSAPP_CLICADO' || typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) return c.json({ erro: 'Evento inválido.' }, 400)
    const lead = await c.env.SHARE_DB.prepare('SELECT id FROM leads_quiz WHERE id=? AND token_evento_hash=?').bind(c.req.param('id'), await sha256(body.token)).first<{ id: string }>()
    if (!lead) return c.json({ erro: 'Registro não encontrado.' }, 404)
    await c.env.SHARE_DB.batch([
      c.env.SHARE_DB.prepare("INSERT OR IGNORE INTO eventos_quiz (id,lead_id,tipo) VALUES (?,?,'WHATSAPP_CLICADO')").bind(crypto.randomUUID(), lead.id),
      c.env.SHARE_DB.prepare('UPDATE leads_quiz SET whatsapp_clicado_em=COALESCE(whatsapp_clicado_em,CURRENT_TIMESTAMP),atualizado_em=CURRENT_TIMESTAMP WHERE id=?').bind(lead.id),
    ])
    c.header('Cache-Control', 'no-store')
    return c.json({ registrado: true })
  } catch {
    return c.json({ erro: 'Não foi possível registrar o evento.' }, 503)
  }
})

export { quizRoutes }
