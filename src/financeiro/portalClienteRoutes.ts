import { Hono } from 'hono'
import { escapeHtml } from '../lib/format'
import { validateWorkerSchema } from '../lib/schema'
import { portalCreatePasswordHash } from '../routes/portalRoutes'

type Bindings = {
  SHARE_DB: D1Database
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
}
type Variables = { userId: string | null }

type Cotista = {
  id: string
  cliente_id: string | null
  socio_id: string | null
  codigo_cliente: string | null
  percentual_sociedade: number | null
  nome: string
  email: string | null
  matricula_registro: string | null
}
type UsuarioCliente = { id: string; login: string; senha: string }

export const portalClienteRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const PORTAL_SCHEMA = [{
  table: 'user_cliente',
  columns: ['id', 'login', 'senha', 'nome_exibicao', 'url_avatar', 'cliente_id', 'socio_id', 'criado_em', 'atualizado_em'],
}]

async function validarSchema(c: Parameters<typeof validateWorkerSchema>[0]): Promise<void> {
  await validateWorkerSchema(c, PORTAL_SCHEMA)
}

async function buscarCotista(c: { env: Bindings }, id: string): Promise<Cotista | null> {
  return c.env.SHARE_DB.prepare(`
    SELECT ca.id, ca.cliente_id, ca.socio_id, ca.codigo_cliente, ca.percentual_sociedade,
      COALESCE(NULLIF(TRIM(cl.razao_social), ''), NULLIF(TRIM(hs.nome), ''), ca.codigo_cliente, 'Cotista') AS nome,
      COALESCE(NULLIF(TRIM(cl.email_principal), ''), NULLIF(TRIM(hs.email_principal), '')) AS email,
      a.matricula_registro
    FROM cotista_aeronave ca
    LEFT JOIN cliente cl ON cl.id = ca.cliente_id
    LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
    LEFT JOIN aeronave a ON a.id = ca.aeronave_id
    WHERE ca.id = ?1
    LIMIT 1
  `).bind(id).first<Cotista>()
}

async function buscarUsuario(c: { env: Bindings }, cotista: Cotista): Promise<UsuarioCliente | null> {
  return c.env.SHARE_DB.prepare(`
    SELECT id, login, senha FROM user_cliente
    WHERE (?1 IS NOT NULL AND cliente_id = ?1)
       OR (?2 IS NOT NULL AND socio_id = ?2)
    ORDER BY criado_em DESC LIMIT 1
  `).bind(cotista.cliente_id, cotista.socio_id).first<UsuarioCliente>()
}

function gerarSenhaTemporaria(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `A7!${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`
}

function normalizarLogin(valor: string): string {
  return valor.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^[._-]+|[._-]+$/g, '').slice(0, 38) || 'cotista'
}

async function gerarLogin(db: D1Database, cotista: Cotista): Promise<string> {
  const baseEmail = cotista.email?.split('@')[0] || ''
  const base = normalizarLogin(baseEmail || cotista.codigo_cliente || cotista.nome)
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const sufixo = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
    const login = `${base}.${sufixo}`
    const existente = await db.prepare('SELECT id FROM user_cliente WHERE lower(login) = lower(?1) LIMIT 1').bind(login).first()
    if (!existente) return login
  }
  throw new Error('nao_foi_possivel_gerar_login_unico')
}

function cotistaComVinculoValido(cotista: Cotista): boolean {
  return Boolean(cotista.cliente_id) !== Boolean(cotista.socio_id)
}

portalClienteRoutes.get('/cotista/portal-cliente', async c => {
  try {
    await validarSchema(c)
    const aeronaveId = c.req.query('aeronave_id')?.trim()
    if (!aeronaveId) return c.json({ error: 'aeronave_obrigatoria' }, 400)
    const aeronave = await c.env.SHARE_DB.prepare('SELECT id FROM aeronave WHERE id = ?1').bind(aeronaveId).first()
    if (!aeronave) return c.json({ error: 'aeronave_nao_encontrada' }, 404)
    const result = await c.env.SHARE_DB.prepare(`
      SELECT ca.id AS cotista_aeronave_id, ca.cliente_id, ca.socio_id, ca.codigo_cliente,
        ca.percentual_sociedade,
        COALESCE(NULLIF(TRIM(cl.razao_social), ''), NULLIF(TRIM(hs.nome), ''), ca.codigo_cliente, 'Cotista') AS nome,
        COALESCE(NULLIF(TRIM(cl.email_principal), ''), NULLIF(TRIM(hs.email_principal), '')) AS email,
        a.matricula_registro,
        EXISTS (
          SELECT 1 FROM user_cliente u
          WHERE (ca.cliente_id IS NOT NULL AND u.cliente_id = ca.cliente_id)
             OR (ca.socio_id IS NOT NULL AND u.socio_id = ca.socio_id)
        ) AS possui_acesso,
        (SELECT u.login FROM user_cliente u
          WHERE (ca.cliente_id IS NOT NULL AND u.cliente_id = ca.cliente_id)
             OR (ca.socio_id IS NOT NULL AND u.socio_id = ca.socio_id)
          ORDER BY u.criado_em DESC LIMIT 1) AS login
      FROM cotista_aeronave ca
      LEFT JOIN cliente cl ON cl.id = ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
      LEFT JOIN aeronave a ON a.id = ca.aeronave_id
      WHERE ca.aeronave_id = ?1
      ORDER BY nome, ca.id
    `).bind(aeronaveId).all()
    return c.json({ cotistas: result.results })
  } catch {
    return c.json({ error: 'portal_cliente_indisponivel' }, 500)
  }
})

portalClienteRoutes.post('/cotista/portal-cliente/:cotistaId/credenciais', async c => {
  try {
    await validarSchema(c)
    const cotista = await buscarCotista(c, c.req.param('cotistaId'))
    if (!cotista) return c.json({ error: 'cotista_nao_encontrado' }, 404)
    if (!cotistaComVinculoValido(cotista)) return c.json({ error: 'vinculo_cotista_invalido' }, 409)
    if (await buscarUsuario(c, cotista)) return c.json({ error: 'portal_usuario_ja_existe' }, 409)

    const login = await gerarLogin(c.env.SHARE_DB, cotista)
    const senhaTemporaria = gerarSenhaTemporaria()
    const hash = await portalCreatePasswordHash(senhaTemporaria)
    await c.env.SHARE_DB.prepare(`
      INSERT INTO user_cliente (id, login, senha, nome_exibicao, url_avatar, cliente_id, socio_id, criado_em, atualizado_em)
      VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(crypto.randomUUID(), login, hash, cotista.nome, cotista.cliente_id, cotista.socio_id).run()
    return c.json({ success: true, login, senha_temporaria: senhaTemporaria }, 201)
  } catch {
    return c.json({ error: 'nao_foi_possivel_criar_acesso' }, 500)
  }
})

portalClienteRoutes.post('/cotista/portal-cliente/:cotistaId/enviar-acesso', async c => {
  try {
    await validarSchema(c)
    if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) return c.json({ error: 'email_nao_configurado' }, 503)
    const cotista = await buscarCotista(c, c.req.param('cotistaId'))
    if (!cotista) return c.json({ error: 'cotista_nao_encontrado' }, 404)
    if (!cotista.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cotista.email)) return c.json({ error: 'email_cotista_nao_cadastrado' }, 422)
    const usuario = await buscarUsuario(c, cotista)
    if (!usuario) return c.json({ error: 'portal_usuario_nao_encontrado' }, 409)

    const senhaTemporaria = gerarSenhaTemporaria()
    const novoHash = await portalCreatePasswordHash(senhaTemporaria)
    const atualizado = await c.env.SHARE_DB.prepare('UPDATE user_cliente SET senha = ?1, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?2 AND senha = ?3')
      .bind(novoHash, usuario.id, usuario.senha).run()
    if (!atualizado.meta?.changes) return c.json({ error: 'portal_usuario_alterado_tente_novamente' }, 409)

    let respostaEmail: Response
    try {
      respostaEmail = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: c.env.EMAIL_FROM,
          to: [cotista.email],
          subject: 'Acesso ao Portal Cliente Share Brasil',
          html: `<p>Olá, ${escapeHtml(cotista.nome)}.</p><p>Seu acesso ao Portal Cliente foi atualizado.</p><p><strong>Login:</strong> ${escapeHtml(usuario.login)}<br><strong>Senha temporária:</strong> <code>${escapeHtml(senhaTemporaria)}</code></p><p>Guarde esta mensagem em local seguro. Se não solicitou esta atualização, entre em contato com a Share Brasil.</p>`,
        }),
      })
    } catch {
      respostaEmail = new Response(null, { status: 503 })
    }

    if (!respostaEmail.ok) {
      const restaurado = await c.env.SHARE_DB.prepare('UPDATE user_cliente SET senha = ?1, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?2 AND senha = ?3')
        .bind(usuario.senha, usuario.id, novoHash).run()
      return c.json({ error: restaurado.meta?.changes ? 'falha_envio_email' : 'falha_envio_email_verifique_acesso' }, 502)
    }
    return c.json({ success: true, destinatario: cotista.email })
  } catch {
    return c.json({ error: 'nao_foi_possivel_enviar_acesso' }, 500)
  }
})
