import { Hono, Context } from 'hono'
import { portalSession, portalTelegram } from './portalRoutes'

// Rotas complementares do Portal Cliente (Fase 1):
// diário de bordo do cliente, balanço multi-mês, abastecimentos,
// envio de comprovante de pagamento e download de anexos de abastecimento.

type Bindings = {
  SHARE_DB: D1Database
  SHARE_FILES: R2Bucket
  CACHE_KV: KVNamespace
  RATE_LIMITER: DurableObjectNamespace
  CLIENT_SESSION_SECRET?: string
  CLIENT_SESSION_TTL_SECONDS?: string
  INTERNAL_TOKEN?: string
  TELEGRAM_BOT_TOKEN?: string
}
type Ctx = Context<{ Bindings: Bindings; Variables: Record<string, never> }>

export const portalClienteExtrasRoutes = new Hono<{ Bindings: Bindings; Variables: Record<string, never> }>()

const MARCADOR_COMPROVANTE = '[PORTAL_COMPROVANTE]'
const MAX_ARQUIVO_BYTES = 10 * 1024 * 1024
const TIPOS_PERMITIDOS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function mesesDaQuery(raw: string | undefined): string[] {
  const meses = String(raw || '')
    .split(',')
    .map(v => v.trim())
    .filter(v => /^\d{4}-(0[1-9]|1[0-2])$/.test(v))
  const unicos = Array.from(new Set(meses)).slice(0, 36)
  return unicos.length ? unicos : [new Date().toISOString().slice(0, 7)]
}

function placeholders(start: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(', ')
}

async function usuario(c: Ctx) {
  const user = await portalSession(c as any)
  if (!user) return null
  if (!user.cliente_id && !user.socio_id) return null
  return user
}

// ── Diário de bordo resumido (apenas voos do cliente) ──────────────────────
portalClienteExtrasRoutes.get('/api/portal/diario-bordo', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const hoje = new Date().toISOString().slice(0, 10)
  const de = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('de') || '') ? c.req.query('de')! : new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('ate') || '') ? c.req.query('ate')! : hoje
  const result = await c.env.SHARE_DB.prepare(`
    SELECT l.id, l.numero_voo, l.data_registro, l.aerodromo_partida, l.aerodromo_chegada, l.trecho,
           l.pic_nome, l.sic_nome, l.tempo_dep, l.tempo_pou, l.tempo_voo, l.tempo_total, l.pousos_total,
           l.distancia_nm, l.litros_combustivel_abastecido, l.voo_emprestado, a.matricula_registro, a.modelo
      FROM lancamentos_diario_bordo l
      LEFT JOIN aeronave a ON a.id = l.aeronave_id
     WHERE (l.cliente_id = ?1 OR l.socio_id = ?2 OR l.cliente_tomador_emprestimo_id = ?1 OR l.socio_tomador_emprestimo_id = ?2)
       AND date(l.data_registro) BETWEEN date(?3) AND date(?4)
     ORDER BY date(l.data_registro) DESC, l.tempo_dep DESC
     LIMIT 500`).bind(user.cliente_id, user.socio_id, de, ate).all<Record<string, unknown>>()
  return c.json({ de, ate, voos: result.results || [] })
})

// ── Meu Balanço (rateio_despesas p/ cliente, rateio_hold p/ holding) ───────
portalClienteExtrasRoutes.get('/api/portal/balanco', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const meses = mesesDaQuery(c.req.query('meses'))
  const db = c.env.SHARE_DB
  const mesExpr = "substr(COALESCE(NULLIF(r.data_competencia_demonstrativo, ''), r.data_emissao), 1, 7)"
  const ph = placeholders(3, meses.length)

  if (user.cliente_id) {
    const [lancamentos, cotistas] = await Promise.all([
      db.prepare(`
        SELECT r.id, ${mesExpr} AS mes, r.data_emissao, r.data_vencimento, r.data_pagamento, r.descricao_despesa,
               r.categoria_nome, r.tipo_rateio, r.percentual_sociedade, r.percentual_uso,
               r.valor_total_centavos, r.valor_rateado_centavos, r.valor_pago_real_centavos,
               r.pago_por, r.pago_diretamente, r.status, a.matricula_registro, r.aeronave_id,
               (SELECT e.fornecedor FROM envio_despesas e WHERE e.id = r.lancamento_id LIMIT 1) AS fornecedor
          FROM rateio_despesas r
          JOIN cotista_aeronave ca ON ca.id = r.cotista_id
          LEFT JOIN aeronave a ON a.id = r.aeronave_id
         WHERE ca.cliente_id = ?1 AND ?2 IS NULL AND UPPER(COALESCE(r.status, '')) <> 'CANCELADO'
           AND ${mesExpr} IN (${ph})
         ORDER BY date(r.data_emissao) DESC`).bind(user.cliente_id, null, ...meses).all<Record<string, unknown>>(),
      db.prepare(`
        SELECT ca.id AS cotista_id, COALESCE(cl.razao_social, hs.nome, 'Cotista') AS nome,
               ca.percentual_sociedade, a.matricula_registro,
               CASE WHEN ca.cliente_id = ?1 THEN 1 ELSE 0 END AS eu,
               COALESCE(SUM(r.valor_rateado_centavos), 0) AS total_centavos,
               COALESCE(SUM(MIN(r.valor_pago_real_centavos, r.valor_rateado_centavos)), 0) AS pago_centavos,
               COUNT(r.id) AS lancamentos
          FROM rateio_despesas r
          JOIN cotista_aeronave ca ON ca.id = r.cotista_id
          LEFT JOIN cliente cl ON cl.id = ca.cliente_id
          LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
          LEFT JOIN aeronave a ON a.id = r.aeronave_id
         WHERE r.aeronave_id IN (SELECT aeronave_id FROM cotista_aeronave WHERE cliente_id = ?1 OR (?2 IS NOT NULL AND socio_id = ?2))
           AND UPPER(COALESCE(r.status, '')) <> 'CANCELADO'
           AND ${mesExpr} IN (${ph})
         GROUP BY ca.id
         ORDER BY eu DESC, total_centavos DESC`).bind(user.cliente_id, null, ...meses).all<Record<string, unknown>>(),
    ])
    return c.json({ tipo: 'CLIENTE', meses, lancamentos: lancamentos.results || [], cotistas: cotistas.results || [] })
  }

  const [lancamentos, cotistas] = await Promise.all([
    db.prepare(`
      SELECT r.id, ${mesExpr} AS mes, r.data_emissao, r.data_vencimento, r.data_pagamento, r.descricao_despesa,
             r.categoria_nome, r.tipo_rateio, r.percentual_sociedade, r.percentual_uso,
             r.valor_total_centavos, r.valor_rateado_centavos, r.valor_pago_real_centavos,
             r.pago_por, r.pago_diretamente, r.status, a.matricula_registro, r.aeronave_id, r.fornecedor
        FROM rateio_hold r
        LEFT JOIN aeronave a ON a.id = r.aeronave_id
       WHERE r.socio_id = ?1 AND ?2 IS NULL AND UPPER(COALESCE(r.status, '')) <> 'CANCELADO'
         AND ${mesExpr} IN (${ph})
       ORDER BY date(r.data_emissao) DESC`).bind(user.socio_id, null, ...meses).all<Record<string, unknown>>(),
    db.prepare(`
      SELECT hs.id AS cotista_id, hs.nome AS nome,
             (SELECT ca.percentual_sociedade FROM cotista_aeronave ca WHERE ca.socio_id = hs.id LIMIT 1) AS percentual_sociedade,
             a.matricula_registro,
             CASE WHEN hs.id = ?1 THEN 1 ELSE 0 END AS eu,
             COALESCE(SUM(r.valor_rateado_centavos), 0) AS total_centavos,
             COALESCE(SUM(MIN(r.valor_pago_real_centavos, r.valor_rateado_centavos)), 0) AS pago_centavos,
             COUNT(r.id) AS lancamentos
        FROM rateio_hold r
        JOIN hold_socios hs ON hs.id = r.socio_id
        LEFT JOIN aeronave a ON a.id = r.aeronave_id
       WHERE r.aeronave_id IN (SELECT aeronave_id FROM cotista_aeronave WHERE socio_id = ?1)
         AND ?2 IS NULL AND UPPER(COALESCE(r.status, '')) <> 'CANCELADO'
         AND ${mesExpr} IN (${ph})
       GROUP BY hs.id
       ORDER BY eu DESC, total_centavos DESC`).bind(user.socio_id, null, ...meses).all<Record<string, unknown>>(),
  ])
  return c.json({ tipo: 'HOLDING', meses, lancamentos: lancamentos.results || [], cotistas: cotistas.results || [] })
})

// ── Abastecimentos do cliente ──────────────────────────────────────────────
portalClienteExtrasRoutes.get('/api/portal/abastecimentos', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const meses = mesesDaQuery(c.req.query('meses'))
  const result = await c.env.SHARE_DB.prepare(`
    SELECT ab.id, ab.data, ab.tipo_combustivel, ab.trecho, ab.local, ab.numero_comanda, ab.numero_nf,
           ab.litros, ab.valor_unitario, ab.valor_total, ab.desconto, ab.status, ab.forma_pagamento,
           ab.data_vencimento_boleto, ab.numero_voo,
           CASE WHEN ab.comanda_url IS NOT NULL AND ab.comanda_url <> '' THEN 1 ELSE 0 END AS tem_comanda,
           CASE WHEN ab.nota_url IS NOT NULL AND ab.nota_url <> '' THEN 1 ELSE 0 END AS tem_nota,
           CASE WHEN ab.boleto_url IS NOT NULL AND ab.boleto_url <> '' THEN 1 ELSE 0 END AS tem_boleto,
           CASE WHEN COALESCE(ab.observacao, '') LIKE '%${MARCADOR_COMPROVANTE}%' THEN 1 ELSE 0 END AS baixa_solicitada,
           f.nome_fornecedor AS fornecedor, a.matricula_registro,
           l.data_registro AS voo_data, l.aerodromo_partida AS voo_origem, l.aerodromo_chegada AS voo_destino,
           COALESCE(NULLIF(l.numero_voo, ''), ab.numero_voo) AS voo_numero
      FROM abastecimentos ab
      LEFT JOIN fornecedores_combustivel f ON f.id = ab.fornecedor_id
      LEFT JOIN aeronave a ON a.id = ab.aeronave_id
      LEFT JOIN lancamentos_diario_bordo l ON l.id = ab.lancamento_diario_id
     WHERE (ab.cliente_id = ?1 OR ab.socio_id = ?2)
       AND substr(ab.data, 1, 7) IN (${placeholders(3, meses.length)})
     ORDER BY date(ab.data) DESC`).bind(user.cliente_id, user.socio_id, ...meses).all<Record<string, unknown>>()
  return c.json({ meses, abastecimentos: result.results || [] })
})

// ── Anexos de abastecimento (comanda, nota, boleto) ────────────────────────
const colunasArquivo: Record<string, string> = { comanda: 'comanda_url', nota: 'nota_url', boleto: 'boleto_url' }
portalClienteExtrasRoutes.get('/api/portal/abastecimentos/:id/arquivo/:tipo', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const coluna = colunasArquivo[c.req.param('tipo')]
  if (!coluna) return c.json({ error: 'tipo_arquivo_invalido' }, 400)
  const row = await c.env.SHARE_DB.prepare(`SELECT ${coluna} AS caminho FROM abastecimentos WHERE id = ?1 AND (cliente_id = ?2 OR socio_id = ?3)`)
    .bind(c.req.param('id'), user.cliente_id, user.socio_id).first<{ caminho: string | null }>()
  if (!row?.caminho) return c.json({ error: 'arquivo_nao_encontrado' }, 404)
  if (/^https?:\/\//i.test(row.caminho)) return c.redirect(row.caminho, 302)
  const object = await c.env.SHARE_FILES.get(row.caminho)
  if (!object) return c.json({ error: 'arquivo_nao_encontrado' }, 404)
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=600' } })
})

// ── Baixas solicitadas (para marcar na interface) ──────────────────────────
portalClienteExtrasRoutes.get('/api/portal/baixas', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const result = user.cliente_id
    ? await c.env.SHARE_DB.prepare(`SELECT DISTINCT p.rateio_id AS id FROM rateio_pagamentos p
        JOIN cotista_aeronave ca ON ca.id = p.pagador_cotista_id
       WHERE ca.cliente_id = ?1 AND p.status = 'PENDENTE'`).bind(user.cliente_id).all<{ id: string }>()
    : await c.env.SHARE_DB.prepare(`SELECT id FROM rateio_hold WHERE socio_id = ?1 AND COALESCE(observacoes, '') LIKE '%${MARCADOR_COMPROVANTE}%'`).bind(user.socio_id).all<{ id: string }>()
  return c.json({ ids: (result.results || []).map(r => r.id) })
})

// ── Envio de comprovante e solicitação de baixa ────────────────────────────
portalClienteExtrasRoutes.post('/api/portal/comprovantes', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const form = await c.req.formData().catch(() => null)
  if (!form) return c.json({ error: 'formulario_invalido' }, 400)
  const tipo = String(form.get('tipo') || '')
  const referenciaId = String(form.get('referencia_id') || '').trim()
  const observacao = String(form.get('observacao') || '').trim().slice(0, 500)
  const arquivo = form.get('arquivo')
  if (!['rateio', 'abastecimento'].includes(tipo) || !referenciaId) return c.json({ error: 'parametros_invalidos' }, 400)
  if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const ext = TIPOS_PERMITIDOS[arquivo.type]
  if (!ext) return c.json({ error: 'tipo_arquivo_nao_permitido' }, 400)
  if (arquivo.size > MAX_ARQUIVO_BYTES) return c.json({ error: 'arquivo_muito_grande' }, 400)

  const db = c.env.SHARE_DB
  const chave = `portal-cliente/comprovantes/${tipo}/${referenciaId}/${crypto.randomUUID()}.${ext}`
  const marcador = `${MARCADOR_COMPROVANTE} ${new Date().toISOString()} ${chave}${observacao ? ` — ${observacao}` : ''}`
  let descricao = ''

  if (tipo === 'abastecimento') {
    const row = await db.prepare('SELECT id, valor_total, data, local FROM abastecimentos WHERE id = ?1 AND (cliente_id = ?2 OR socio_id = ?3)')
      .bind(referenciaId, user.cliente_id, user.socio_id).first<Record<string, unknown>>()
    if (!row) return c.json({ error: 'referencia_nao_encontrada' }, 404)
    await c.env.SHARE_FILES.put(chave, arquivo.stream(), { httpMetadata: { contentType: arquivo.type } })
    await db.prepare("UPDATE abastecimentos SET observacao = trim(COALESCE(observacao, '') || char(10) || ?1), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?2")
      .bind(marcador, referenciaId).run()
    descricao = `Abastecimento ${row.local || ''} em ${row.data || ''}`
  } else if (user.cliente_id) {
    const row = await db.prepare(`SELECT r.id, r.cotista_id, r.valor_rateado_centavos, r.valor_pago_real_centavos, r.descricao_despesa
        FROM rateio_despesas r JOIN cotista_aeronave ca ON ca.id = r.cotista_id
       WHERE r.id = ?1 AND ca.cliente_id = ?2`).bind(referenciaId, user.cliente_id).first<Record<string, unknown>>()
    if (!row) return c.json({ error: 'referencia_nao_encontrada' }, 404)
    const pendente = await db.prepare("SELECT id FROM rateio_pagamentos WHERE rateio_id = ?1 AND status = 'PENDENTE' LIMIT 1").bind(referenciaId).first()
    if (pendente) return c.json({ error: 'baixa_ja_solicitada' }, 409)
    const valor = Math.max(1, Number(row.valor_rateado_centavos || 0) - Number(row.valor_pago_real_centavos || 0))
    await c.env.SHARE_FILES.put(chave, arquivo.stream(), { httpMetadata: { contentType: arquivo.type } })
    await db.prepare(`INSERT INTO rateio_pagamentos (id, rateio_id, tipo_pagador, pagador_cotista_id, valor_centavos, data_pagamento, comprovante_url, forma_pagamento, status, observacoes, criado_por, criado_em)
      VALUES (?1, ?2, 'COTISTA', ?3, ?4, ?5, ?6, 'COMPROVANTE_PORTAL', 'PENDENTE', ?7, ?8, CURRENT_TIMESTAMP)`)
      .bind(crypto.randomUUID(), referenciaId, row.cotista_id, valor, new Date().toISOString().slice(0, 10), chave, observacao || 'Solicitação de baixa enviada pelo Portal Cliente', `portal:${user.id}`).run()
    descricao = String(row.descricao_despesa || 'Despesa')
  } else {
    const row = await db.prepare('SELECT id, descricao_despesa FROM rateio_hold WHERE id = ?1 AND socio_id = ?2').bind(referenciaId, user.socio_id).first<Record<string, unknown>>()
    if (!row) return c.json({ error: 'referencia_nao_encontrada' }, 404)
    await c.env.SHARE_FILES.put(chave, arquivo.stream(), { httpMetadata: { contentType: arquivo.type } })
    await db.prepare("UPDATE rateio_hold SET observacoes = trim(COALESCE(observacoes, '') || char(10) || ?1), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?2")
      .bind(marcador, referenciaId).run()
    descricao = String(row.descricao_despesa || 'Despesa')
  }

  let notificado = true
  try {
    await portalTelegram(c as any, `<b>Comprovante enviado pelo Portal Cliente</b>\nCliente: ${user.nome_exibicao || user.login}\nTipo: ${tipo}\nReferência: ${descricao}\nID: <code>${referenciaId}</code>\nSolicitação de baixa aguardando conferência.`)
  } catch {
    notificado = false
  }
  return c.json({ success: true, arquivo: chave, notificado }, 201)
})
