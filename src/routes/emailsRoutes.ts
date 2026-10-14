import { Hono, Context } from 'hono'
import { arrayBufferBase64, SIGNATURE_LOGO_BASE64, SIGNATURE_LOGO_CID } from '../lib/emailAssets'
import { escapeHtml } from '../lib/format'
import { MAX_ATTACHMENT_TOTAL_SIZE, arrayBufferToBase64, uuid } from '../lib/strings'
import { validateWorkerSchema } from '../lib/schema'
import { authenticatedColaborador, checkInternalAuth, extractSupabaseUserId, requireAuthenticatedUser, shareBrasilUser } from '../lib/auth'
import { chaveStorageDeUrl, shareBrasilBucket, shareBrasilFileName } from '../lib/storage'
import { holdingMovementColumn, loadSchema } from '../financeiro/FinanceiroKernel'

type Bindings = { SHARE_DB: D1Database; FILES: R2Bucket; SHARE_FILES?: R2Bucket; RESEND_API_KEY?: string; INTERNAL_TOKEN?: string; SUPABASE_URL?: string; SUPABASE_ANON_KEY?: string; SUPABASE_SERVICE_ROLE_KEY?: string; VITE_SUPABASE_PUBLISHABLE_KEY?: string; EMAIL_FROM?: string; R2_PUBLIC_URL?: string }
type Variables = Record<string, never>

export const emailRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const log = { debug: (...args: unknown[]) => console.debug(...args), warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) }
type SignatureContext = { env: { SHARE_DB: D1Database } }
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

emailRoutes.post('/api/send-email', async (c) => {
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

    await c.env.SHARE_DB.prepare(
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
      return c.json({ error: 'Falha ao enviar email' }, 502)
    }

    return c.json(data)
  } catch (e: any) {
    log.error('[send-email]', e.message)
    throw e
  }
})

emailRoutes.get('/api/email-envios', async (c) => {
  if (!(await checkInternalAuth(c))) return c.json({ error: 'Unauthorized' }, 401)
  const referenceId = c.req.query('reference_id')
  try {
    const query = referenceId
      ? c.env.SHARE_DB.prepare('SELECT * FROM email_envios WHERE reference_id = ? ORDER BY created_at DESC').bind(referenceId)
      : c.env.SHARE_DB.prepare('SELECT * FROM email_envios ORDER BY created_at DESC LIMIT 100')
    const { results } = await query.all()
    return c.json(results)
  } catch (e: any) {
    throw e
  }
})


async function marcarEmailEnviadoParaOrigens(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  ids: string[],
  emailId: string,
): Promise<void> {
  const db = c.env.SHARE_DB
  const agora = new Date().toISOString()

  for (const referencia of ids) {
    const [prefix, rawId] = referencia.includes(':') ? referencia.split(':', 2) : [referencia, '']
    if (!rawId) continue

    let lancamentoIds: string[] = []
    let movimentoIds: string[] = []

    if (prefix === 'lancamento') {
      lancamentoIds.push(rawId)
    } else if (prefix === 'movimento_holding') {
      movimentoIds.push(rawId)
    } else if (prefix === 'recibo') {

      // Aceita recibo:<id do recibo> e recibo:<id do anexo>.
      const reciboDireto = await db.prepare('SELECT id, lancamento_id FROM recibos WHERE id = ?1').bind(rawId).first<{ id: string; lancamento_id: string | null }>()
      const anexo = reciboDireto ? null : await db.prepare('SELECT recibo_id FROM recibo_anexos WHERE id = ?1').bind(rawId).first<{ recibo_id: string | null }>()
      const reciboId = reciboDireto?.id ?? anexo?.recibo_id ?? null
      const lancamentoId = reciboDireto?.lancamento_id ?? (reciboId
        ? (await db.prepare('SELECT lancamento_id FROM recibos WHERE id = ?1').bind(reciboId).first<{ lancamento_id: string | null }>())?.lancamento_id
        : null)
      if (reciboId) await db.prepare("UPDATE recibos SET status = 'EMAIL_ENVIADO' WHERE id = ?1 AND status <> 'CANCELADO'").bind(reciboId).run()
      if (lancamentoId) lancamentoIds.push(lancamentoId)
    } else if (prefix === 'recibo_saida') {
      const row = await db.prepare('SELECT lancamentos_id FROM recibos_saida WHERE id = ?1').bind(rawId).first<{ lancamentos_id: string | null }>()
      if (row?.lancamentos_id) lancamentoIds.push(row.lancamentos_id)
    } else if (prefix === 'nf_saida') {
      const conta = await db.prepare('SELECT lancamentos_id, movimentos_id FROM contas_areceber WHERE nf_saida_id = ?1 LIMIT 1').bind(rawId).first<{ lancamentos_id: string | null; movimentos_id: string | null }>()
      if (conta?.lancamentos_id) {
        lancamentoIds.push(conta.lancamentos_id)
        const espelhos = await db.prepare("SELECT id FROM lancamentos WHERE origem_id = ?1 AND tipo_caixa = 'CLIENTE'").bind(conta.lancamentos_id).all<{ id: string }>()
        lancamentoIds.push(...(espelhos.results || []).map((row) => row.id))
      }
      if (conta?.movimentos_id) movimentoIds.push(conta.movimentos_id)
    } else if (prefix === 'relatorio') {
      const anexo = await db.prepare('SELECT relatorio_despesa_viagem_id FROM relatorio_despesa_viagem_anexos WHERE id = ?1').bind(rawId).first<{ relatorio_despesa_viagem_id: string | null }>()
      if (anexo?.relatorio_despesa_viagem_id) {
        const vinculos = await db.prepare(
          `SELECT destino_tipo, destino_id FROM financeiro_vinculos
           WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1`
        ).bind(anexo.relatorio_despesa_viagem_id).all<{ destino_tipo: string; destino_id: string }>()
        for (const v of vinculos.results || []) {
          if (v.destino_tipo === 'LANCAMENTO') lancamentoIds.push(v.destino_id)
          if (v.destino_tipo === 'MOVIMENTO_HOLDING') movimentoIds.push(v.destino_id)
        }
      }
    } else if (prefix === 'relatorio_pdf') {
      const vinculos = await db.prepare(
        `SELECT destino_tipo, destino_id FROM financeiro_vinculos
         WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1`
      ).bind(rawId).all<{ destino_tipo: string; destino_id: string }>()
      for (const v of vinculos.results || []) {
        if (v.destino_tipo === 'LANCAMENTO') lancamentoIds.push(v.destino_id)
        if (v.destino_tipo === 'MOVIMENTO_HOLDING') movimentoIds.push(v.destino_id)
      }
      const lancamentosRelatorio = await db.prepare(
        `SELECT id FROM lancamentos
         WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1`
      ).bind(rawId).all<{ id: string }>()
      lancamentoIds.push(...(lancamentosRelatorio.results || []).map((row) => row.id))
    } else if (prefix === 'envio_despesa') {
      const row = await db.prepare('SELECT id, lancamento_id, movimentos_holding_id FROM envio_despesas WHERE id = ?1').bind(rawId).first<any>()
      if (row) {
        await db.prepare(`UPDATE envio_despesas SET email_enviado = 1, email_enviado_em = ?, email_id = ? WHERE id = ?`)
          .bind(agora, emailId, row.id).run()
        if (row.lancamento_id) lancamentoIds.push(row.lancamento_id)
        if (row.movimentos_holding_id) movimentoIds.push(row.movimentos_holding_id)
      }
    }

    for (const lid of lancamentoIds) {
      await db.prepare(`UPDATE lancamentos SET email_enviado_em = COALESCE(email_enviado_em, ?), email_enviado_id = COALESCE(email_enviado_id, ?) WHERE id = ?`).bind(agora, emailId, lid).run()
      await db.prepare('UPDATE rateio_despesas SET email_enviado_em = COALESCE(email_enviado_em, ?) WHERE lancamento_id = ?').bind(agora, lid).run()
      await db.prepare(
        `INSERT OR IGNORE INTO financeiro_vinculos (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
         VALUES (?, 'EMAIL', ?, 'LANCAMENTO', ?, 'EMAIL_ENVIADO')`
      ).bind(uuid(), emailId, lid).run()
    }
    for (const mid of movimentoIds) {
      await db.prepare(`UPDATE movimentos_holding SET email_enviado_em = COALESCE(email_enviado_em, ?), email_enviado_id = COALESCE(email_enviado_id, ?) WHERE id = ?`).bind(agora, emailId, mid).run()
      const holdingColumn = holdingMovementColumn(await loadSchema(db))
      await db.prepare(`UPDATE rateio_hold SET email_enviado_em = COALESCE(email_enviado_em, ?) WHERE ${holdingColumn} = ?`).bind(agora, mid).run()
      await db.prepare(
        `INSERT OR IGNORE INTO financeiro_vinculos (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
         VALUES (?, 'EMAIL', ?, 'MOVIMENTO_HOLDING', ?, 'EMAIL_ENVIADO')`
      ).bind(uuid(), emailId, mid).run()
    }
  }
}

// ─── Financeiro: central de e-mail ───────────────────────────────────────────
async function garantirTabelaEmails(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  await validateWorkerSchema(c, [
    { table: 'user_profiles', columns: ['id', 'email_envio'] },
    { table: 'assinaturas_email', columns: ['id'] },
    { table: 'emails_enviados', columns: ['id', 'anexos_detalhes', 'email_enviado_em'] },
  ])
}
function normalizarEmail(valor: unknown): string | null {
  // O Resend aceita apenas endereços ASCII. Corrige contatos cadastrados como
  // "gestão@..." para "gestao@..." antes de montar o payload do provedor.
  const email = String(valor ?? '').trim().replace(/^['"\s]+|['"\s]+$/g, '').replace(/[;,]+$/g, '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}
function enderecoEmail(valor: unknown): string | null {
  const texto = String(valor ?? '').trim()
  const entreAngulos = texto.match(/<([^>]+)>/)?.[1] || texto
  return normalizarEmail(entreAngulos)
}
function dominioEmail(valor: unknown): string | null {
  return enderecoEmail(valor)?.split('@')[1] || null
}
function emailArray(value: unknown): string[] {
  const valores: unknown[] = []
  const adicionar = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(adicionar)
      return
    }
    const texto = String(item ?? '').trim()
    if (!texto) return
    // parseBody({ all: true }) retorna campos repetidos em arrays; o campo JSON
    // destinatarios pode, portanto, vir como ['["cliente@dominio.com"]'].
    if (texto.startsWith('[') && texto.endsWith(']')) {
      try {
        const parsed = JSON.parse(texto)
        if (Array.isArray(parsed)) {
          parsed.forEach(adicionar)
          return
        }
      } catch {
        // Compatibilidade com entradas legadas separadas por vírgula/ponto e vírgula.
      }
    }
    texto.split(/[;,\s]+/).forEach((parte) => valores.push(parte))
  }
  adicionar(value)
  return [...new Set(valores.map(normalizarEmail).filter((item): item is string => Boolean(item)))]
}
function base64ArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value); const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

emailRoutes.get('/api/interno/emails', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  await garantirTabelaEmails(c)
  const [clientes, socios, recibos, relatorios, abastecimentos, historico] = await Promise.all([
    db.prepare("SELECT id, razao_social, email_principal, emails FROM cliente WHERE lower(COALESCE(status,'ativo')) = 'ativo' ORDER BY razao_social").all(),
    db.prepare("SELECT id, nome, email_principal, emails, cotista_id, holding_id FROM hold_socios WHERE (email_principal IS NOT NULL AND trim(email_principal) <> '') OR (emails IS NOT NULL AND trim(emails) <> '') ORDER BY nome").all(),
    // Recibos gerados pela IA podem ter o PDF referenciado em recibos.url_recibo
    // mesmo quando a linha de recibo_anexos não está disponível para a central.
    // Partir de recibos garante que eles apareçam no seletor de e-mail; quando
    // houver o anexo PDF, usamos seu ID real, caso contrário usamos o ID do
    // recibo e o endpoint de envio resolve o PDF relacionado.
    db.prepare("SELECT r.id AS recibo_id, r.numero_recibo, r.url_recibo, COALESCE(a.id, r.id) AS id, COALESCE(a.nome_arquivo, r.numero_recibo || '.pdf') AS nome_arquivo, COALESCE(a.tipo_arquivo, 'application/pdf') AS tipo_arquivo, a.tamanho_arquivo, COALESCE(a.criado_em, r.criado_em) AS criado_em FROM recibos r LEFT JOIN recibo_anexos a ON a.recibo_id = r.id AND (UPPER(COALESCE(a.finalidade, '')) = 'PDF' OR a.tipo_arquivo = 'application/pdf') WHERE a.id IS NOT NULL OR r.url_recibo IS NOT NULL ORDER BY COALESCE(a.criado_em, r.criado_em) DESC LIMIT 300").all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, nome_arquivo, tipo_arquivo, tamanho_arquivo, criado_em FROM relatorio_despesa_viagem_anexos ORDER BY criado_em DESC LIMIT 200").all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, local, numero_comanda, numero_nf, comanda_url, nota_url, boleto_url FROM abastecimentos WHERE comanda_url IS NOT NULL OR nota_url IS NOT NULL OR boleto_url IS NOT NULL ORDER BY data DESC LIMIT 200").all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, destinatarios, assunto, mensagem, status, anexos, anexos_detalhes, quantidade_anexos, erro_mensagem AS erro, enviado_por, referencia_tipo, referencia_id, criado_em, email_enviado_em FROM emails_enviados WHERE enviado_por = ?1 ORDER BY criado_em DESC LIMIT 100").bind(user.id).all(),
  ])
  const contatos: any[] = []
  for (const row of (clientes.results as any[])) {
    for (const email of emailArray([row.email_principal, ...emailArray(row.emails)])) contatos.push({ id: `${row.id}:${email}`, nome: row.razao_social, email, tipo: 'cliente', cliente_id: row.id })
  }
  for (const row of (socios.results as any[])) for (const email of emailArray([row.email_principal, ...emailArray(row.emails)])) contatos.push({ id: `socio:${row.id}:${email}`, nome: row.nome, email, tipo: 'socio', cotista_id: row.cotista_id, holding_id: row.holding_id || null })
  const anexosAbastecimento = (abastecimentos.results as any[]).flatMap((row) => ([['comanda_url', 'Comanda'], ['nota_url', 'Nota fiscal'], ['boleto_url', 'Boleto']] as const).filter(([campo]) => row[campo]).map(([campo, titulo]) => ({ id: `abastecimento:${row.id}:${campo.replace('_url', '')}`, nome: `${titulo} · ${row.numero_comanda || row.numero_nf || row.local || 'Abastecimento'}`, origem: 'abastecimento', tipo_arquivo: null, tamanho_arquivo: null, arquivo_url: row[campo] })))
  const anexos = [...(recibos.results as any[]).map((row) => ({ id: `recibo:${row.id}`, nome: row.nome_arquivo || `${row.numero_recibo || row.recibo_id}.pdf`, origem: 'recibo', tipo_arquivo: row.tipo_arquivo, tamanho_arquivo: row.tamanho_arquivo, arquivo_url: `/api/financeiro/recibos/anexos/${row.id}/arquivo` })), ...(relatorios.results as any[]).map((row) => ({ id: `relatorio:${row.id}`, nome: row.nome_arquivo, origem: 'relatorio_despesa_viagem', tipo_arquivo: row.tipo_arquivo, tamanho_arquivo: row.tamanho_arquivo, arquivo_url: `/api/financeiro/relatorios-despesa-viagem/anexos/${row.id}/arquivo` })), ...anexosAbastecimento]
  return c.json({ contatos, anexos, historico: (historico.results as any[]).map((row) => ({ ...row, mensagem: row.mensagem || '', destinatarios: emailArray(row.destinatarios), quantidade_anexos: row.quantidade_anexos || emailArray(row.anexos).length, anexos_detalhes: (() => { try { return JSON.parse(row.anexos_detalhes || '[]') } catch { return [] } })() })) })
})
emailRoutes.get('/api/interno/emails/:id/anexos/:indice', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare('SELECT anexos_detalhes FROM emails_enviados WHERE id = ?1 AND enviado_por = ?2').bind(c.req.param('id'), user.id).first<{ anexos_detalhes: string | null }>()
  if (!row) return c.notFound()
  let detalhes: Array<{ nome_arquivo?: string; tipo_arquivo?: string; key?: string }> = []
  try { detalhes = JSON.parse(row.anexos_detalhes || '[]') } catch { detalhes = [] }
  const detalhe = detalhes[Number(c.req.param('indice'))]
  if (!detalhe?.key) return c.notFound()
  const object = await shareBrasilBucket(c).get(detalhe.key)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': detalhe.tipo_arquivo || object.httpMetadata?.contentType || 'application/octet-stream', 'Content-Disposition': `inline; filename="${shareBrasilFileName(detalhe.nome_arquivo || 'anexo')}"` } })
})
const ASSINATURA_EMPRESA_OPERACIONAL = 'SHARE BRASIL SERVICOS AEROPORTUARIOS LTDA'
function campoDepartamento(row: any, nomes: string[]) {
  for (const nome of nomes) if (row?.[nome] !== undefined && row[nome] !== null && String(row[nome]).trim()) return String(row[nome]).trim()
  return ''
}
function normalizarChaveDepartamento(valor: unknown) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}
export async function assinaturaOperacional(c: SignatureContext, user: any) {
  const rows = await c.env.SHARE_DB.prepare('SELECT * FROM departamentos_email').all<any>().catch(() => ({ results: [] as any[] }))
  // O perfil pode guardar o nome ou o id do departamento, conforme a versão
  // do cadastro. Aceitar os dois evita cair silenciosamente no remetente global.
  const departamento = normalizarChaveDepartamento(user.departamentos_email || user.departamento)
  const row = (rows.results || []).find((item: any) => [item?.id, item?.nome].some((valor) => normalizarChaveDepartamento(valor) === departamento)) || {}
  return {
    nome: String(user.email_envio || user.nome_completo || ASSINATURA_EMPRESA_OPERACIONAL),
    cargo: campoDepartamento(row, ['nome']),
    email: campoDepartamento(row, ['email_from']) || undefined,
    telefone: campoDepartamento(row, ['telefone_padrao']),
    endereco: campoDepartamento(row, ['endereco_padrao']),
    logo_url: campoDepartamento(row, ['logo_url_padrao', 'logo_url', 'logo', 'url_logo']) || null,
  }
}
emailRoutes.get('/api/minha-assinatura', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaEmails(c)
  return c.json(await assinaturaOperacional(c, user))
})
emailRoutes.patch('/api/minha-assinatura', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  await garantirTabelaEmails(c)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const nome = String(body.nome || '').trim()
  if (!nome) return c.json({ error: 'nome_obrigatorio' }, 400)
  await c.env.SHARE_DB.prepare('UPDATE user_profiles SET email_envio = ? WHERE id = ?').bind(nome, user.id).run()
  return c.json(await assinaturaOperacional(c, { ...user, email_envio: nome }))
})
emailRoutes.get('/api/interno/emails/contas-bancarias', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const rows = await c.env.SHARE_DB.prepare('SELECT * FROM contas_bancarias ORDER BY banco').all<any>().catch(() => ({ results: [] as any[] }))
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
emailRoutes.patch('/api/interno/emails/contas-bancarias/:id', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB; const id = c.req.param('id')
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
emailRoutes.post('/api/interno/emails', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const multipart = c.req.header('content-type')?.includes('multipart/form-data')
  const body = multipart ? await c.req.parseBody({ all: true }) : await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const destinatarios = emailArray(body.destinatarios)
  const copias = emailArray(body.cc).filter((email) => !destinatarios.includes(email))
  const todosDestinatarios = [...destinatarios, ...copias]
  const assunto = String(body.assunto || '').trim(); const mensagem = [String(body.mensagem || '').trim(), String(body.dados_bancarios || '').trim()].filter(Boolean).join('\n\n'); const ids = [...new Set(Array.isArray(body.anexos) ? body.anexos.map(String) : (() => { try { const parsed = JSON.parse(String(body.anexos || '[]')); return Array.isArray(parsed) ? parsed.map(String) : [] } catch { return [] } })())]
  const referencias = Array.isArray(body.referencias) ? body.referencias.map(String) : (() => { try { const parsed = JSON.parse(String(body.referencias || '[]')); return Array.isArray(parsed) ? parsed.map(String) : [] } catch { return [] } })()
  const origens = [...new Set([...referencias, ...ids])]
  if (!destinatarios.length || !assunto || !mensagem) return c.json({ error: 'destinatario_assunto_e_mensagem_obrigatorios' }, 400)
  if (todosDestinatarios.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return c.json({ error: 'destinatario_invalido' }, 400)
  const assinaturaAtual = await assinaturaOperacional(c, user)
  const remetenteConfigurado = enderecoEmail(c.env.EMAIL_FROM) || ''
  const emailFromDepartamento = enderecoEmail(assinaturaAtual.email)
  // Um departamento pode conter um remetente antigo ou de domínio não
  // verificado no Resend. Nesse caso, use o remetente global verificado em vez
  // de enviar um payload que o provedor certamente rejeitará.
  const emailFrom = emailFromDepartamento && dominioEmail(emailFromDepartamento) === dominioEmail(remetenteConfigurado)
    ? emailFromDepartamento
    : remetenteConfigurado
  if (!c.env.RESEND_API_KEY || !emailFrom) return c.json({ error: 'email_nao_configurado' }, 503)
  await garantirTabelaEmails(c).catch(error => { log.error('[interno/emails] schema de histórico indisponível', error) })
  const db = c.env.SHARE_DB; const anexos: any[] = []; let erroAnexo: string | null = null
  for (const id of ids) {
    const [prefix, rawId, tipoAbastecimento] = id.includes(':') ? id.split(':', 3) : ['', id]
    if (prefix === 'abastecimento') {
      const column = tipoAbastecimento === 'nota' ? 'nota_url' : tipoAbastecimento === 'boleto' ? 'boleto_url' : 'comanda_url'
      const row = await db.prepare(`SELECT ${column} AS caminho FROM abastecimentos WHERE id = ?1`).bind(rawId).first<any>().catch(() => null)
      if (!row?.caminho) { erroAnexo = `anexo_abastecimento_nao_encontrado:${rawId}:${tipoAbastecimento}`; continue }
      const key = chaveStorageDeUrl(row.caminho)
      const bucket = shareBrasilBucket(c); const object = key && bucket ? await bucket.get(key) : null
      if (object) anexos.push({ filename: key.split('/').pop() || `abastecimento-${tipoAbastecimento}`, content: arrayBufferBase64(await object.arrayBuffer()), content_type: object.httpMetadata?.contentType || 'application/octet-stream' })
      else erroAnexo = `anexo_abastecimento_indisponivel:${rawId}:${tipoAbastecimento}`
      continue
    }
    if (prefix === 'lancamento') {
      const row = await db.prepare('SELECT anexos_json, url_doc, url_nf, url_boleto, url_demonstrativo FROM lancamentos WHERE id = ?1').bind(rawId).first<any>().catch(() => null)
      let anexosLancamento: any[] = []
      try { const parsed = JSON.parse(String(row?.anexos_json || '[]')); if (Array.isArray(parsed)) anexosLancamento = parsed } catch { /* formato legado inválido */ }
      const urls = [row?.url_doc, row?.url_nf, row?.url_boleto, row?.url_demonstrativo].filter(Boolean).map((url) => ({ url: String(url), nome: 'Documento da despesa' }))
      for (const anexo of [...anexosLancamento, ...urls]) {
        const caminho = chaveStorageDeUrl(anexo.url || anexo.url_arquivo || anexo.caminho_arquivo)
        const object = caminho && shareBrasilBucket(c) ? await shareBrasilBucket(c).get(caminho) : null
        if (object) anexos.push({ filename: anexo.nome || anexo.filename || 'documento-da-despesa', content: arrayBufferBase64(await object.arrayBuffer()), content_type: anexo.tipo || anexo.tipo_arquivo || object.httpMetadata?.contentType || 'application/octet-stream' })
      }
      continue
    }
    if (prefix === 'movimento_holding' || prefix === 'movimentos_holding') {
      const row = await db.prepare('SELECT url_doc, url_nf, url_boleto, comprovante_url FROM movimentos_holding WHERE id = ?1').bind(rawId).first<any>().catch(() => null)
      const urls = [row?.url_doc, row?.url_nf, row?.url_boleto, row?.comprovante_url].filter(Boolean).map((url) => ({ url: String(url), nome: 'Documento da despesa' }))
      for (const anexo of urls) {
        const caminho = chaveStorageDeUrl(anexo.url)
        const object = caminho && shareBrasilBucket(c) ? await shareBrasilBucket(c).get(caminho) : null
        if (object) anexos.push({ filename: caminho.split('/').pop() || 'documento-da-despesa', content: arrayBufferBase64(await object.arrayBuffer()), content_type: object.httpMetadata?.contentType || 'application/octet-stream' })
      }
      continue
    }
    if (prefix === 'nf_saida' || prefix === 'recibo_saida') {
      const table = prefix === 'nf_saida' ? 'notas_fiscais_saida' : 'recibos_saida'
      const column = prefix === 'nf_saida' ? 'arquivo_pdf_url' : 'pdf_url'
      const row = await db.prepare(`SELECT ${column} AS arquivo FROM ${table} WHERE id = ?1`).bind(rawId).first<any>().catch(() => null)
      const key = chaveStorageDeUrl(row?.arquivo)
      const bucket = shareBrasilBucket(c); const object = key && bucket ? await bucket.get(key) : null
      if (object) anexos.push({ filename: `${prefix}-${rawId}.pdf`, content: arrayBufferBase64(await object.arrayBuffer()), content_type: object.httpMetadata?.contentType || 'application/pdf' })
      else erroAnexo = `anexo_${prefix}_indisponivel:${rawId}`
      continue
    }
    if (prefix === 'relatorio_pdf') {
      const row = await db.prepare('SELECT pdf_path, numero_relatorio FROM relatorio_despesa_viagem WHERE id = ?1').bind(rawId).first<any>().catch(() => null)
      const bucket = shareBrasilBucket(c); const object = row?.pdf_path && bucket ? await bucket.get(row.pdf_path) : null
      if (object) anexos.push({ filename: `${row.numero_relatorio || rawId}.pdf`, content: arrayBufferBase64(await object.arrayBuffer()), content_type: object.httpMetadata?.contentType || 'application/pdf' })
      else erroAnexo = `anexo_relatorio_pdf_indisponivel:${rawId}`
      continue
    }
    const table = prefix === 'recibo' ? 'recibo_anexos' : prefix === 'relatorio' ? 'relatorio_despesa_viagem_anexos' : ''
    if (!table) continue
    let row = await db.prepare(`SELECT nome_arquivo, caminho_arquivo, tipo_arquivo FROM ${table} WHERE id = ?1`).bind(rawId).first<any>().catch(() => null)

    // O fluxo de programação pode receber o ID do recibo quando o PDF foi
    // persistido em url_recibo sem uma linha correspondente em recibo_anexos.
    // Resolve também esse formato legado para que o e-mail não seja enviado
    // sem o recibo selecionado.
    if (!row && prefix === 'recibo') {
      row = await db.prepare("SELECT nome_arquivo, caminho_arquivo, tipo_arquivo FROM recibo_anexos WHERE recibo_id = ?1 AND (UPPER(COALESCE(finalidade, '')) = 'PDF' OR tipo_arquivo = 'application/pdf') ORDER BY criado_em DESC LIMIT 1").bind(rawId).first<any>().catch(() => null)
    }
    if (!row && prefix === 'recibo') {
      const recibo = await db.prepare('SELECT id, url_recibo, numero_recibo FROM recibos WHERE id = ?1').bind(rawId).first<any>().catch(() => null)
      const caminho = chaveStorageDeUrl(recibo?.url_recibo)
      if (caminho) row = { nome_arquivo: `${recibo?.numero_recibo || rawId}.pdf`, caminho_arquivo: caminho, tipo_arquivo: 'application/pdf' }
    }
    if (!row) { erroAnexo = `anexo_${prefix}_nao_encontrado:${rawId}`; continue }
    const bucket = shareBrasilBucket(c); const object = bucket ? await bucket.get(chaveStorageDeUrl(row.caminho_arquivo)) : null
    if (!object) { erroAnexo = `anexo_${prefix}_indisponivel:${rawId}`; continue }
    anexos.push({ filename: row.nome_arquivo, content: arrayBufferBase64(await object.arrayBuffer()), content_type: row.tipo_arquivo || 'application/octet-stream' })
  }
  const arquivosLocais = (Array.isArray(body.arquivos) ? body.arquivos : body.arquivos ? [body.arquivos] : []).filter((file): file is File => file instanceof File && !!file.size)
  // Preserve every file selected in the multipart request. The frontend sends
  // repeated `arquivos` fields, so truncating here silently dropped attachments
  // after the tenth one (and made multi-image uploads incomplete).
  for (const file of arquivosLocais) anexos.push({ filename: file.name, content: arrayBufferBase64(await file.arrayBuffer()), content_type: file.type || 'application/octet-stream' })
  const id = uuid(); let status = erroAnexo ? 'erro' : 'enviado'; let erro: string | null = erroAnexo
  const anexosDetalhes: Array<{ nome_arquivo: string; tipo_arquivo: string; tamanho_bytes: number; key: string }> = []
  if (!erroAnexo) {
    for (let index = 0; index < anexos.length; index++) {
      const anexo = anexos[index]
      const key = `emails/${user.id}/${id}/${index}-${shareBrasilFileName(anexo.filename)}`
      const buffer = base64ArrayBuffer(anexo.content)
      await shareBrasilBucket(c).put(key, buffer, { httpMetadata: { contentType: anexo.content_type || 'application/octet-stream' } })
      anexosDetalhes.push({ nome_arquivo: anexo.filename, tipo_arquivo: anexo.content_type || 'application/octet-stream', tamanho_bytes: buffer.byteLength, key })
    }
  }
  const logoRemota = /^https?:\/\//i.test(String(assinaturaAtual.logo_url || '').trim())
  const logoInline = logoRemota ? [] : [{ filename: 'share-brasil-logo.png', content: SIGNATURE_LOGO_BASE64, content_type: 'image/png', content_id: SIGNATURE_LOGO_CID }]
  if (!erroAnexo) {
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: emailFrom, reply_to: emailFromDepartamento || user.email, to: destinatarios, ...(copias.length ? { cc: copias } : {}), subject: assunto, html: `<p>${escapeHtml(mensagem).replace(/\n/g, '<br>')}</p>${assinaturaHtml(assinaturaAtual)}`, attachments: [...logoInline, ...anexos] }) })
    if (!response.ok) { status = 'erro'; erro = await response.text().catch(() => 'falha_ao_enviar_email') }
  }
  const [primeiroPrefix, primeiroRawId] = (origens[0] || '').includes(':') ? origens[0].split(':', 2) : [null, null]
  const emailEnviadoEm = status === 'enviado' ? new Date().toISOString() : null
  await db.prepare('INSERT INTO emails_enviados (id, destinatarios, assunto, mensagem, anexos, anexos_detalhes, quantidade_anexos, status, erro_mensagem, enviado_por, referencia_tipo, referencia_id, email_enviado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, JSON.stringify(destinatarios), assunto, mensagem, JSON.stringify(ids), JSON.stringify(anexosDetalhes), anexos.length, status, erro, user.id, primeiroPrefix, primeiroRawId, emailEnviadoEm).run()
  if (status === 'enviado') {
    // A FK de lancamentos.email_enviado_id exige que o registro pai exista
    // antes da atualização do lançamento.
    await marcarEmailEnviadoParaOrigens(c, origens, id).catch(error => { log.error('[interno/emails] origem não atualizada após envio', error) })
  }
  if (status === 'erro') {
    let detalhe: Record<string, unknown> | null = null
    try { detalhe = erro ? JSON.parse(erro) : null } catch { /* mantém erro bruto no histórico */ }
    return c.json({ error: 'falha_ao_enviar_email', message: detalhe?.message || erro || 'O provedor recusou o envio.', id }, 502)
  }
  return c.json({ success: true, id }, 201)
})
