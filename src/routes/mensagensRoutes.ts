import { Hono, Context } from 'hono'
import { authenticatedColaborador } from '../lib/auth'
import { garantirTabelasAuxiliares } from '../lib/schema'
import { shareBrasilBucket, shareBrasilFileName, salvarArquivoShareBrasil } from '../lib/storage'
import { assinaturaOperacional } from './emailsRoutes'

type Bindings = { SHARE_DB: D1Database; FILES: R2Bucket; SHARE_FILES?: R2Bucket; SUPABASE_URL?: string; SUPABASE_ANON_KEY?: string; SUPABASE_SERVICE_ROLE_KEY?: string; VITE_SUPABASE_PUBLISHABLE_KEY?: string }
type Variables = Record<string, never>

export const mensagensRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const log = { debug: (..._args: unknown[]) => undefined, warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) }
const uuid = () => crypto.randomUUID()
// ─── Routes: Mensageria Interna (Inbox / D1) ──────────────────────────────────

// 📩 1. Enviar nova mensagem
mensagensRoutes.use('/api/mensagens', async (c, next) => { await garantirTabelasAuxiliares(c); return next() })
mensagensRoutes.use('/api/mensagens/*', async (c, next) => { await garantirTabelasAuxiliares(c); return next() })

type PastaMensagem = 'inbox' | 'nao-lidas' | 'favoritas' | 'enviadas' | 'arquivo'

function assinaturaTexto(assinatura: { nome?: string; cargo?: string; telefone?: string; endereco?: string; email?: string }) {
  return ['Atenciosamente,', assinatura.nome, assinatura.cargo, assinatura.telefone, assinatura.endereco, assinatura.email].filter((item) => item && String(item).trim()).join('\n')
}

type AnexoMensagem = { id: string; nome_arquivo: string; caminho_arquivo: string; tipo_arquivo: string; tamanho_arquivo: number; criado_em?: string }
function lerAnexosMensagem(valor: unknown): AnexoMensagem[] {
  try {
    const parsed = typeof valor === 'string' ? JSON.parse(valor) : valor
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object' && item.id && item.nome_arquivo && item.caminho_arquivo).map((item: any) => ({
      id: String(item.id), nome_arquivo: String(item.nome_arquivo), caminho_arquivo: String(item.caminho_arquivo), tipo_arquivo: String(item.tipo_arquivo || 'application/octet-stream'), tamanho_arquivo: Number(item.tamanho_arquivo || 0), criado_em: item.criado_em ? String(item.criado_em) : undefined,
    })) : []
  } catch { return [] }
}
function anexosMensagemPublicos(valor: unknown) {
  return lerAnexosMensagem(valor).map(({ caminho_arquivo, ...anexo }) => anexo)
}

async function prepararEstadosMensagens(c: Context<{ Bindings: Bindings; Variables: Variables }>, usuarioId: string) {
  await c.env.SHARE_DB.prepare(`
    INSERT OR IGNORE INTO mensagens_usuario (mensagem_id, usuario_id, papel, lida)
    SELECT id, ?, CASE WHEN remetente_id = ? THEN 'remetente' ELSE 'destinatario' END,
      CASE WHEN remetente_id = ? THEN 1 ELSE lida END
    FROM mensagens WHERE remetente_id = ? OR destinatario_id = ?
  `).bind(usuarioId, usuarioId, usuarioId, usuarioId, usuarioId).run()
}

async function listarMensagensPasta(c: Context<{ Bindings: Bindings; Variables: Variables }>, usuarioId: string, pasta: PastaMensagem) {
  await prepararEstadosMensagens(c, usuarioId)
  const filtros: Record<PastaMensagem, string> = {
    inbox: "e.papel = 'destinatario' AND e.arquivada = 0 AND e.excluida = 0",
    'nao-lidas': "e.papel = 'destinatario' AND e.lida = 0 AND e.arquivada = 0 AND e.excluida = 0",
    favoritas: 'e.favorita = 1 AND e.excluida = 0',
    enviadas: "e.papel = 'remetente' AND e.excluida = 0",
    arquivo: 'e.arquivada = 1 AND e.excluida = 0',
  }
  const result = await c.env.SHARE_DB.prepare(`
    SELECT m.id, m.remetente_id, m.destinatario_id, m.assunto, m.conteudo, m.criado_em, m.anexos_mensagens,
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
  return (result.results as any[]).map((mensagem) => ({
    ...mensagem,
    anexos: anexosMensagemPublicos(mensagem.anexos_mensagens),
    anexos_mensagens: undefined,
  }))
}

mensagensRoutes.get('/api/mensagens/usuarios', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  try {
    const { results } = await c.env.SHARE_DB.prepare(
      "SELECT id, COALESCE(NULLIF(trim(nome_exibicao),''), NULLIF(trim(nome_completo),''), email) AS nome, email, departamento FROM user_profiles WHERE id <> ?1 AND lower(COALESCE(status,'ativo')) = 'ativo' ORDER BY nome"
    ).bind(usuarioId).all()
    return c.json({ usuarios: results })
  } catch (e: any) {
    log.error('[mensagens:usuarios]', e.message)
    return c.json({ error: 'Não foi possível carregar os usuários' }, 500)
  }
})

mensagensRoutes.post('/api/mensagens', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)

  const remetenteId = user.id
  try {
    const multipart = c.req.header('content-type')?.includes('multipart/form-data')
    const body = multipart ? await c.req.parseBody() : await c.req.json<Record<string, any>>()
    const destinatarioId = String(body.destinatario_id || '').trim()
    const conteudo = String(body.conteudo || '').trim()
    if (!destinatarioId || !conteudo) return c.json({ error: 'destinatario_id e conteudo são obrigatórios' }, 400)
    if (destinatarioId === remetenteId) return c.json({ error: 'destinatario_invalido' }, 400)

    const destinatario = await c.env.SHARE_DB.prepare("SELECT id FROM user_profiles WHERE id = ?1 AND lower(COALESCE(status, 'ativo')) = 'ativo'").bind(destinatarioId).first<{ id: string }>()
    if (!destinatario) return c.json({ error: 'destinatario_nao_encontrado' }, 404)

    const arquivos = (Array.isArray(body.arquivos) ? body.arquivos : body.arquivos ? [body.arquivos] : [])
      .filter((arquivo): arquivo is File => arquivo instanceof File && arquivo.size > 0)
      .slice(0, 10)
    const id = uuid()
    const assinatura = await assinaturaOperacional(c, user)
    const conteudoFinal = `${conteudo}\n\n${assinaturaTexto(assinatura)}`
    const anexos: AnexoMensagem[] = []
    for (const arquivo of arquivos) {
      const anexoId = uuid()
      const caminho = await salvarArquivoShareBrasil(c, remetenteId, arquivo, `anexo_mensagens/${id}`)
      anexos.push({ id: anexoId, nome_arquivo: arquivo.name, caminho_arquivo: caminho, tipo_arquivo: arquivo.type || 'application/octet-stream', tamanho_arquivo: arquivo.size })
    }
    await c.env.SHARE_DB.batch([
      c.env.SHARE_DB.prepare('INSERT INTO mensagens (id, remetente_id, destinatario_id, assunto, conteudo, anexos_mensagens) VALUES (?, ?, ?, ?, ?, ?)').bind(id, remetenteId, destinatarioId, String(body.assunto || '').trim() || null, conteudoFinal, JSON.stringify(anexos)),
      c.env.SHARE_DB.prepare("INSERT INTO mensagens_usuario (mensagem_id, usuario_id, papel, lida) VALUES (?, ?, 'remetente', 1)").bind(id, remetenteId),
      c.env.SHARE_DB.prepare("INSERT INTO mensagens_usuario (mensagem_id, usuario_id, papel, lida) VALUES (?, ?, 'destinatario', 0)").bind(id, destinatarioId),
    ])

    return c.json({ success: true, id, destinatario_id: destinatarioId, anexos: anexosMensagemPublicos(anexos), message: 'Mensagem enviada com sucesso' }, 201)
  } catch (e: any) {
    log.error('[mensagens:send]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// 📬 2. Listar Caixa de Entrada (Inbox)
mensagensRoutes.get('/api/mensagens/inbox', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  try { return c.json(await listarMensagensPasta(c, usuarioId, 'inbox')) }
  catch (e: any) { log.error('[mensagens:inbox]', e.message); return c.json({ error: e.message }, 500) }
})

mensagensRoutes.get('/api/mensagens/pasta/:pasta', async (c) => {
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
mensagensRoutes.get('/api/mensagens/outbox', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  try { return c.json(await listarMensagensPasta(c, usuarioId, 'enviadas')) }
  catch (e: any) { log.error('[mensagens:outbox]', e.message); return c.json({ error: e.message }, 500) }
})

// 🔔 4. Obter contagem de mensagens NÃO LIDAS (para badges de notificação)
mensagensRoutes.get('/api/mensagens/unread-count', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  try {
    await prepararEstadosMensagens(c, usuarioId)
    const result = await c.env.SHARE_DB.prepare("SELECT COUNT(*) AS unread FROM mensagens_usuario WHERE usuario_id = ?1 AND papel = 'destinatario' AND lida = 0 AND excluida = 0 AND arquivada = 0").bind(usuarioId).first<{ unread: number }>()
    return c.json({ unread: Number(result?.unread || 0) })
  } catch (e: any) {
    log.error('[mensagens:unread-count]', e.message)
    return c.json({ error: 'Não foi possível contar as mensagens não lidas' }, 500)
  }
})

mensagensRoutes.patch('/api/mensagens/:id/estado', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  const mensagemId = c.req.param('id')
  try {
    await prepararEstadosMensagens(c, usuarioId)
    const estado = await c.env.SHARE_DB.prepare('SELECT mensagem_id FROM mensagens_usuario WHERE mensagem_id = ?1 AND usuario_id = ?2').bind(mensagemId, usuarioId).first()
    if (!estado) return c.json({ error: 'Mensagem não encontrada ou sem permissão' }, 404)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const campos: string[] = []
    const valores: unknown[] = []
    for (const campo of ['lida', 'favorita', 'arquivada', 'excluida'] as const) {
      if (body[campo] !== undefined) { campos.push(`${campo} = ?`); valores.push(body[campo] ? 1 : 0) }
    }
    if (!campos.length) return c.json({ error: 'nenhuma_atualizacao' }, 400)
    campos.push('atualizado_em = CURRENT_TIMESTAMP')
    await c.env.SHARE_DB.prepare(`UPDATE mensagens_usuario SET ${campos.join(', ')} WHERE mensagem_id = ? AND usuario_id = ?`).bind(...valores, mensagemId, usuarioId).run()
    return c.json({ success: true, mensagem_id: mensagemId })
  } catch (e: any) {
    log.error('[mensagens:estado]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// 🔍 5. Obter uma mensagem específica e marcar como LIDA
mensagensRoutes.get('/api/mensagens/:id', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  const id = c.req.param('id')
  try {
    await prepararEstadosMensagens(c, usuarioId)
    const msg = await c.env.SHARE_DB.prepare(`
      SELECT m.*, e.papel, e.lida, e.favorita, e.arquivada, e.excluida
      FROM mensagens m INNER JOIN mensagens_usuario e ON e.mensagem_id = m.id AND e.usuario_id = ?
      WHERE m.id = ? AND e.excluida = 0
    `).bind(usuarioId, id).first<any>()
    if (!msg) return c.json({ error: 'Mensagem não encontrada' }, 404)
    if (msg.papel === 'destinatario' && !msg.lida) {
      await c.env.SHARE_DB.prepare('UPDATE mensagens_usuario SET lida = 1, atualizado_em = CURRENT_TIMESTAMP WHERE mensagem_id = ? AND usuario_id = ?').bind(id, usuarioId).run()
      msg.lida = 1
    }
    msg.anexos = anexosMensagemPublicos(msg.anexos_mensagens)
    delete msg.anexos_mensagens
    return c.json(msg)
  } catch (e: any) {
    log.error('[mensagens:get]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// 🗑️ 6. Deletar mensagem
mensagensRoutes.delete('/api/mensagens/:id', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const usuarioId = user.id
  const id = c.req.param('id')
  try {
    await prepararEstadosMensagens(c, usuarioId)
    const res = await c.env.SHARE_DB.prepare('UPDATE mensagens_usuario SET excluida = 1, atualizado_em = CURRENT_TIMESTAMP WHERE mensagem_id = ? AND usuario_id = ? AND excluida = 0').bind(id, usuarioId).run()
    if (!res.meta.changes) return c.json({ error: 'Mensagem não encontrada ou sem permissão' }, 404)
    return c.json({ success: true, message: 'Mensagem movida para a lixeira' })
  } catch (e: any) {
    log.error('[mensagens:delete]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

mensagensRoutes.get('/api/mensagens/:id/anexos/:anexoId', async (c) => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'Não autorizado' }, 401)
  const mensagemId = c.req.param('id')
  const mensagemComAnexos = await c.env.SHARE_DB.prepare(`
    SELECT m.anexos_mensagens
    FROM mensagens m
    INNER JOIN mensagens_usuario mu ON mu.mensagem_id = m.id AND mu.usuario_id = ?1 AND mu.excluida = 0
    WHERE m.id = ?2
  `).bind(user.id, mensagemId).first<{ anexos_mensagens: unknown }>()
  const anexo = lerAnexosMensagem(mensagemComAnexos?.anexos_mensagens).find((item) => item.id === c.req.param('anexoId'))
  if (!anexo) return c.notFound()
  const object = await shareBrasilBucket(c).get(anexo.caminho_arquivo)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': anexo.tipo_arquivo || 'application/octet-stream', 'Content-Disposition': `inline; filename="${shareBrasilFileName(anexo.nome_arquivo)}"`, 'Cache-Control': 'private, max-age=3600' } })
})
