import { Hono } from "hono"
import { createClientExpenseRateios, createDirectExternalExpense, createExpense, createReimbursement } from "./FinanceiroKernel"
import { convertPaymentRequest, createPaymentRequest, findMatchingClientRateios, validatePaymentRequest } from "./paymentAgents"
import { mensagemFinanceiraStatements } from "./financeiroNotifications"
import { errorResponse } from "./errorResponse"
import { usuarioPodeGerenciarFinanceiro } from "./financeiroAuth"

type Bindings = { SHARE_DB: D1Database; SHARE_FILES?: R2Bucket; FILES?: R2Bucket; R2_PUBLIC_URL?: string }
type Variables = { userId: string | null }

export const enviosPagamentoRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
async function garantirTabelasRascunho(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS envio_pagamento_rascunhos (
      id TEXT PRIMARY KEY, criado_por TEXT NOT NULL, tipo_envio TEXT NOT NULL,
      etapa_atual INTEGER NOT NULL DEFAULT 0, dados_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT NOT NULL UNIQUE, envio_id TEXT, status TEXT NOT NULL DEFAULT 'PREENCHIMENTO',
      atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS envio_pagamento_email_destinatarios (
      id TEXT PRIMARY KEY, rascunho_id TEXT NOT NULL, cotista_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'PENDENTE',
      email_id TEXT, erro TEXT, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (rascunho_id, cotista_id)
    )`),
  ])
}

enviosPagamentoRoutes.get('/envios-pagamento/rascunhos', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  await garantirTabelasRascunho(db)
  const { results } = await db.prepare(`SELECT r.*,
      e.status AS envio_status, e.lancamento_id AS envio_lancamento_id, e.movimentacao_id AS envio_movimentacao_id,
      (SELECT COUNT(*) FROM envio_pagamento_email_destinatarios ed WHERE ed.rascunho_id = r.id AND ed.status = 'ENVIADO') AS emails_enviados,
      (SELECT COUNT(*) FROM envio_pagamento_email_destinatarios ed WHERE ed.rascunho_id = r.id) AS total_destinatarios,
      (SELECT COUNT(*) FROM envio_pagamento_email_destinatarios ed WHERE ed.rascunho_id = r.id AND ed.status = 'FALHOU') AS emails_falhos,
      (SELECT COUNT(*) FROM rateio_despesas rd
        WHERE rd.lancamento_id = COALESCE(e.lancamento_id, e.id)
          AND UPPER(COALESCE(rd.status, '')) <> 'CANCELADO') AS rateio_total,
      (SELECT COUNT(*) FROM rateio_despesas rd
        WHERE rd.lancamento_id = COALESCE(e.lancamento_id, e.id)
          AND UPPER(COALESCE(rd.status, '')) IN ('PAGO', 'PAGO_DIRETAMENTE', 'REEMBOLSADO')) AS rateio_concluidos
    FROM envio_pagamento_rascunhos r
    LEFT JOIN envio_despesas e ON e.id = r.envio_id
    WHERE r.criado_por = ? AND r.status <> 'CONCLUIDO'
      AND (e.id IS NULL OR UPPER(COALESCE(e.status, '')) <> 'CONCLUIDO')
    ORDER BY r.atualizado_em DESC`).bind(userId).all<Record<string, unknown>>()
  return c.json({ rascunhos: results ?? [] })
})

enviosPagamentoRoutes.get('/envios-pagamento/rascunhos/:id', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  await garantirTabelasRascunho(db)
  const rascunho = await db.prepare('SELECT * FROM envio_pagamento_rascunhos WHERE id = ? AND criado_por = ?').bind(c.req.param('id'), userId).first<Record<string, unknown>>()
  if (!rascunho) return c.json({ error: 'rascunho_nao_encontrado' }, 404)
  const { results: destinatarios } = await db.prepare('SELECT cotista_id, status, email_id, erro, atualizado_em FROM envio_pagamento_email_destinatarios WHERE rascunho_id = ? ORDER BY atualizado_em').bind(rascunho.id).all()
  return c.json({ rascunho, destinatarios: destinatarios ?? [] })
})

enviosPagamentoRoutes.delete('/envios-pagamento/rascunhos/:id', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  await garantirTabelasRascunho(db)
  const id = c.req.param('id')
  const rascunho = await db.prepare('SELECT id FROM envio_pagamento_rascunhos WHERE id = ? AND criado_por = ?')
    .bind(id, userId).first<{ id: string }>()
  if (!rascunho) return c.json({ error: 'rascunho_nao_encontrado' }, 404)
  await db.batch([
    db.prepare('DELETE FROM envio_pagamento_email_destinatarios WHERE rascunho_id = ?').bind(id),
    db.prepare('DELETE FROM envio_pagamento_rascunhos WHERE id = ? AND criado_por = ?').bind(id, userId),
  ])
  return c.json({ ok: true })
})

enviosPagamentoRoutes.post('/envios-pagamento/rascunhos', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const id = String(body.id ?? '').trim()
  const tipo = String(body.tipo_envio ?? '').trim()
  const idempotencyKey = String(body.idempotency_key ?? '').trim()
  const etapa = Number(body.etapa_atual)
  if (!id || !idempotencyKey || !['share', 'cliente', 'reembolso'].includes(tipo) || !Number.isInteger(etapa) || etapa < 0 || etapa > 3 || !body.dados || typeof body.dados !== 'object') {
    return c.json({ error: 'dados_de_rascunho_invalidos' }, 400)
  }
  const db = c.env.SHARE_DB
  await garantirTabelasRascunho(db)
  const atual = await db.prepare('SELECT id, idempotency_key FROM envio_pagamento_rascunhos WHERE id = ? AND criado_por = ?').bind(id, userId).first<{ id: string; idempotency_key: string }>()
  if (atual && atual.idempotency_key !== idempotencyKey) return c.json({ error: 'chave_de_idempotencia_nao_pode_mudar' }, 409)
  const status = String(body.status ?? 'PREENCHIMENTO')
  if (!['PREENCHIMENTO', 'EMAIL_PENDENTE', 'CONCLUIDO'].includes(status)) return c.json({ error: 'status_de_rascunho_invalido' }, 400)
  if (atual) {
    await db.prepare(`UPDATE envio_pagamento_rascunhos SET tipo_envio = ?, etapa_atual = ?, dados_json = ?, envio_id = ?, status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND criado_por = ?`)
      .bind(tipo, etapa, JSON.stringify(body.dados), body.envio_id ? String(body.envio_id) : null, status, id, userId).run()
  } else {
    await db.prepare(`INSERT INTO envio_pagamento_rascunhos (id, criado_por, tipo_envio, etapa_atual, dados_json, idempotency_key, envio_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, userId, tipo, etapa, JSON.stringify(body.dados), idempotencyKey, body.envio_id ? String(body.envio_id) : null, status).run()
  }
  const cotistas = Array.isArray(body.destinatarios) ? [...new Set(body.destinatarios.map((value) => String(value ?? '').trim()).filter(Boolean))] : []
  for (const cotistaId of cotistas) {
    await db.prepare(`INSERT OR IGNORE INTO envio_pagamento_email_destinatarios (id, rascunho_id, cotista_id, idempotency_key, status)
      VALUES (?, ?, ?, ?, 'PENDENTE')`).bind(crypto.randomUUID(), id, cotistaId, `email:${id}:${cotistaId}`).run()
  }
  return c.json({ ok: true, atualizado_em: new Date().toISOString() })
})

enviosPagamentoRoutes.post('/envios-pagamento', async (c) => {
  try {
    let input
    let body: Record<string, unknown>
    try {
      body = await c.req.json<Record<string, unknown>>()
      input = validatePaymentRequest(body)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'dados_de_envio_invalidos', code: 'dados_de_envio_invalidos' }, 400)
    }
    if (input.tipo === 'cliente' && body.confirmar_duplicidade !== true) {
      const rateios = await findMatchingClientRateios(c.env.SHARE_DB, input)
      if (rateios.length) return c.json({ error: 'duplicidade_rateio', rateios }, 409)
    }
    const result = await createPaymentRequest(c.env.SHARE_DB, input, c.get('userId') || null)
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) { return errorResponse(c, error) }
})

enviosPagamentoRoutes.get('/envios-pagamento', async (c) => {
  const userId = c.get('userId')
  const tipo = c.req.query('tipo')
  const podeConsultarTodos = userId
    ? await usuarioPodeGerenciarFinanceiro(c.env.SHARE_DB, userId)
    : false
  const filtros: string[] = []
  const parametros: string[] = []
  if (!podeConsultarTodos) {
    filtros.push('e.criado_por = ?')
    parametros.push(userId ?? '')
  }
  if (tipo) {
    filtros.push('e.tipo = ?')
    parametros.push(tipo)
  }
  const query = `SELECT e.*, COALESCE(u.nome_exibicao, u.nome_completo, u.email, e.criado_por) AS solicitante_nome
    FROM envio_despesas e LEFT JOIN user_profiles u ON u.id = e.criado_por
    ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''} ORDER BY e.criado_em DESC LIMIT 200`
  const result = await c.env.SHARE_DB.prepare(query).bind(...parametros).all()
  return c.json({ envios: result.results ?? [] })
})

enviosPagamentoRoutes.get('/envios-pagamento/opcoes', async (c) => {
  const db = c.env.SHARE_DB
  const read = async (sql: string) => (await db.prepare(sql).all().catch((error) => { console.warn('[financeiro/envios] consulta opcional indisponível', error); return { results: [] } })).results ?? []
  const [fornecedores, fornecedoresCombustivel, aeronaves, voos, categorias, categoriasCliente] = await Promise.all([
    read('SELECT id, COALESCE(apelido, nome_completo) AS label FROM fornecedores_favoritos ORDER BY label'),
    read('SELECT * FROM fornecedores_combustivel ORDER BY nome_cidade, nome_fornecedor'),
    read('SELECT id, matricula_registro, fabricante, modelo FROM aeronave ORDER BY matricula_registro'),
    read("SELECT s.numero_voo, s.data_agendada AS ultima_data, s.aeronave_id, s.origem, s.destino FROM solicitacoes_reserva_voo s WHERE NULLIF(TRIM(s.numero_voo), '') IS NOT NULL AND s.id = (SELECT s2.id FROM solicitacoes_reserva_voo s2 WHERE s2.numero_voo = s.numero_voo AND s2.aeronave_id = s.aeronave_id ORDER BY date(s2.data_agendada) DESC, s2.id DESC LIMIT 1) ORDER BY date(s.data_agendada) DESC, s.numero_voo"),
    read('SELECT id, nome, grupo_categoria, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_share ORDER BY nome'),
    read('SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome'),
  ])
  return c.json({ fornecedores, fornecedores_combustivel: fornecedoresCombustivel, aeronaves, voos, categorias, categorias_cliente: categoriasCliente })
})

enviosPagamentoRoutes.get('/envios-pagamento/despesas-origem', async (c) => {
  const db = c.env.SHARE_DB
  const aeronaveId = c.req.query('aeronave_id')?.trim()
  const numeroVoo = c.req.query('numero_voo')?.trim()
  const origem = c.req.query('origem')?.trim().toUpperCase()
  if (!aeronaveId || !['ABASTECIMENTO', 'RECIBOS', 'RELATORIOS DE VIAGEM'].includes(origem || '')) {
    return c.json({ error: 'aeronave_id e origem são obrigatórios' }, 400)
  }
  try {
    let registros: Record<string, unknown>[] = []
    if (origem === 'ABASTECIMENTO') {
      const result = await db.prepare(`SELECT a.id, a.numero_voo, a.aeronave_id, a.data AS data_despesa,
        a.valor_total AS valor, COALESCE(f.nome_fornecedor, '') AS fornecedor,
        a.comanda_url, a.nota_url, a.boleto_url, a.numero_comanda, a.numero_nf,
        a.trecho, a.local, a.tipo_combustivel AS descricao
        FROM abastecimentos a LEFT JOIN fornecedores_combustivel f ON f.id = a.fornecedor_id
        WHERE a.aeronave_id = ?${numeroVoo ? ' AND TRIM(a.numero_voo) = ?' : ''}
        ORDER BY date(a.data) DESC, a.id DESC LIMIT 100`).bind(...([aeronaveId, ...(numeroVoo ? [numeroVoo] : [])] as string[])).all<Record<string, unknown>>()
      registros = result.results ?? []
    } else if (origem === 'RECIBOS') {
      const result = await db.prepare(`SELECT r.id, r.numero_voo, r.aeronave_id, r.data_emissao AS data_despesa,
        r.valor / 100.0 AS valor, '' AS fornecedor,
        r.descricao, r.categoria_nome, r.grupo_categoria, r.numero_recibo, r.url_recibo,
        NULL AS url_nf, NULL AS url_boleto, NULL AS url_demonstrativo, NULL AS url_doc
        FROM recibos r WHERE r.aeronave_id = ?${numeroVoo ? ' AND TRIM(r.numero_voo) = ?' : ''}
        ORDER BY date(r.data_emissao) DESC, r.criado_em DESC LIMIT 100`).bind(...([aeronaveId, ...(numeroVoo ? [numeroVoo] : [])] as string[])).all<Record<string, unknown>>()
      registros = result.results ?? []
    } else {
      await db.prepare('SELECT id FROM relatorio_despesa_viagem LIMIT 0').all()
      const result = await db.prepare(`SELECT r.id, r.numero_voo, r.aeronave_id, r.data_inicio AS data_despesa,
        r.numero_relatorio, r.rota, r.pdf_url, r.despesas, r.cliente_id, r.socio_id
        FROM relatorio_despesa_viagem r WHERE r.aeronave_id = ?${numeroVoo ? ' AND TRIM(r.numero_voo) = ?' : ''}
        ORDER BY date(r.data_inicio) DESC, r.criado_em DESC LIMIT 100`).bind(...([aeronaveId, ...(numeroVoo ? [numeroVoo] : [])] as string[])).all<Record<string, unknown>>()
      registros = (result.results ?? []).flatMap((row) => {
        let despesas: unknown[] = []
        try { const parsed = typeof row.despesas === 'string' ? JSON.parse(row.despesas) : row.despesas; if (Array.isArray(parsed)) despesas = parsed } catch { /* relatório legado sem despesas válidas */ }
        return despesas.map((despesa: any, index) => ({ id: `${row.id}:${index}`, relatorio_id: row.id, numero_voo: row.numero_voo,
          aeronave_id: row.aeronave_id, data_despesa: despesa.data || row.data_despesa, descricao: despesa.descricao || despesa.categoria || row.numero_relatorio,
          valor: Number(despesa.valor ?? despesa.amount ?? 0), fornecedor: despesa.fornecedor || '', categoria_nome: despesa.categoria || '',
          grupo_categoria: despesa.grupo_categoria || '', url_demonstrativo: row.pdf_url || null, url_doc: row.pdf_url || null }))
      })
    }
    return c.json({ registros })
  } catch (error) {
    console.warn('[financeiro/envios] falha ao buscar despesas da origem selecionada', error)
    return c.json({ error: 'falha_ao_buscar_despesas_da_origem' }, 500)
  }
})

enviosPagamentoRoutes.get('/envios-pagamento/anexos-opcoes', async (c) => {
  const db = c.env.SHARE_DB
  const read = async (sql: string) => (await db.prepare(sql).all().catch((error) => { console.warn('[financeiro/anexos] consulta opcional indisponível', error); return { results: [] } })).results ?? []
  const [recibos, relatorios, abastecimentos] = await Promise.all([
    read(`SELECT r.id, r.numero_recibo, r.descricao, r.descricao AS descricao_servico, r.data_emissao, COALESCE(a.id, r.id) AS anexo_id, a.nome_arquivo, a.tipo_arquivo, COALESCE(r.url_recibo, '/api/financeiro/recibos/anexos/' || a.id || '/arquivo') AS arquivo_url, (COUNT(a.id) + CASE WHEN r.url_recibo IS NOT NULL THEN 1 ELSE 0 END) AS quantidade_anexos FROM recibos r LEFT JOIN recibo_anexos a ON a.recibo_id = r.id AND (UPPER(COALESCE(a.finalidade, '')) = 'PDF' OR a.tipo_arquivo = 'application/pdf') WHERE a.id IS NOT NULL OR r.url_recibo IS NOT NULL GROUP BY r.id, r.numero_recibo, r.descricao, r.data_emissao, r.url_recibo, a.id, a.nome_arquivo, a.tipo_arquivo ORDER BY r.data_emissao DESC, r.numero_recibo LIMIT 300`),
    read(`SELECT r.id, r.numero_voo, r.numero_relatorio, COALESCE(r.pdf_url, '/api/financeiro/relatorios-despesa-viagem/' || r.id || '/pdf') AS arquivo_url, r.id AS anexo_id, 'relatorio.pdf' AS nome_arquivo, 'application/pdf' AS tipo_arquivo, 1 AS quantidade_anexos FROM relatorio_despesa_viagem r WHERE r.pdf_path IS NOT NULL OR r.pdf_url IS NOT NULL ORDER BY r.criado_em DESC, r.numero_relatorio LIMIT 300`),
    read(`SELECT a.id, a.numero_voo, a.trecho, a.data, a.numero_comanda, a.numero_nf, a.local, a.comanda_url, a.nota_url, a.boleto_url, ar.matricula_registro, COALESCE(cl.razao_social, hs.nome, a.cliente_id, a.socio_id, 'Cotista não informado') AS cotista_nome, (CASE WHEN a.comanda_url IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN a.nota_url IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN a.boleto_url IS NOT NULL THEN 1 ELSE 0 END) AS quantidade_anexos FROM abastecimentos a LEFT JOIN aeronave ar ON ar.id = a.aeronave_id LEFT JOIN cliente cl ON cl.id = a.cliente_id LEFT JOIN hold_socios hs ON hs.id = a.socio_id WHERE a.comanda_url IS NOT NULL OR a.nota_url IS NOT NULL OR a.boleto_url IS NOT NULL ORDER BY a.data DESC, a.numero_voo LIMIT 300`),
  ])
  return c.json({ recibos, relatorios, abastecimentos })
})
enviosPagamentoRoutes.post('/envios-pagamento/anexos', async (c) => {
  const arquivo = (await c.req.formData()).get('arquivo') as unknown
  if (!(arquivo instanceof File) || !arquivo.size) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  if (arquivo.size > 25 * 1024 * 1024) return c.json({ error: 'arquivo_excede_25mb' }, 413)
  if (!/^application\/pdf$|^image\//.test(arquivo.type)) return c.json({ error: 'somente_imagem_ou_pdf_permitido' }, 415)
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const userId = c.get('userId') || 'interno'
  const safeName = arquivo.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const key = `share/nf-boletos-clients/${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`
  await bucket.put(key, await arquivo.arrayBuffer(), { httpMetadata: { contentType: arquivo.type || 'application/octet-stream' } })
  const publicUrl = c.env.R2_PUBLIC_URL ? `${c.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}` : `${new URL(c.req.url).origin}/api/financeiro/envios-pagamento/anexos/arquivo?key=${encodeURIComponent(key)}`
  return c.json({ key, url: publicUrl }, 201)
})
enviosPagamentoRoutes.get('/envios-pagamento/anexos/arquivo', async (c) => {
  const key = c.req.query('key')
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!key || !bucket || !key.startsWith('share/nf-boletos-clients/')) return c.notFound()
  const object = await bucket.get(key)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Content-Disposition': 'inline' } })
})

enviosPagamentoRoutes.get('/envios-pagamento/aeronave/:id/cotistas', async (c) => {
  if (!c.get('userId')) return c.json({ error: 'nao_autorizado' }, 401)
  const result = await c.env.SHARE_DB.prepare(`
    SELECT ca.id, ca.aeronave_id, ca.cliente_id, ca.socio_id, ca.codigo_cliente,
           ca.percentual_sociedade,
           COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, 'Cotista não identificado') AS nome,
           COALESCE(cl.email_principal, hs.email_principal) AS email,
           CASE WHEN ca.socio_id IS NOT NULL THEN 1 ELSE 0 END AS eh_holding
      FROM cotista_aeronave ca
      LEFT JOIN cliente cl ON cl.id = ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
     WHERE ca.aeronave_id = ? AND lower(COALESCE(ca.status, 'ativo')) = 'ativo'
     ORDER BY COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente)
  `).bind(c.req.param('id')).all()
  return c.json({ cotistas: result.results ?? [] })
})

enviosPagamentoRoutes.patch('/envios-pagamento/cotistas/:id', async (c) => {
  if (!c.get('userId')) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const id = c.req.param('id')
  const body = await c.req.json<{ aeronave_id?: unknown; percentual_sociedade?: unknown }>().catch(() => null)
  if (!body) return c.json({ error: 'dados_invalidos' }, 400)
  const current = await db.prepare("SELECT id, cliente_id, socio_id, aeronave_id FROM cotista_aeronave WHERE id = ? AND lower(COALESCE(status, 'ativo')) = 'ativo'").bind(id).first<{ id: string; cliente_id: string | null; socio_id: string | null; aeronave_id: string }>()
  if (!current) return c.json({ error: 'participacao_nao_encontrada' }, 404)
  const percentual = Number(body.percentual_sociedade)
  const aeronaveId = String(body.aeronave_id ?? current.aeronave_id).trim()
  if (body.percentual_sociedade === undefined || !Number.isFinite(percentual) || percentual < 0 || percentual > 100) return c.json({ error: 'percentual_invalido' }, 400)
  const aeronave = await db.prepare('SELECT id FROM aeronave WHERE id = ?').bind(aeronaveId).first<{ id: string }>()
  if (!aeronave) return c.json({ error: 'aeronave_nao_encontrada' }, 404)
  if (aeronaveId !== current.aeronave_id) {
    const duplicado = await db.prepare("SELECT id FROM cotista_aeronave WHERE aeronave_id = ? AND id <> ? AND lower(COALESCE(status, 'ativo')) = 'ativo' AND ((? IS NOT NULL AND cliente_id = ?) OR (? IS NOT NULL AND socio_id = ?)) LIMIT 1")
      .bind(aeronaveId, id, current.cliente_id, current.cliente_id, current.socio_id, current.socio_id).first()
    if (duplicado) return c.json({ error: 'cotista_ja_vinculado_a_aeronave' }, 409)
    const historico = await db.prepare('SELECT 1 AS existe FROM rateio_despesas WHERE cotista_id = ? UNION ALL SELECT 1 FROM rateio_pagamentos WHERE pagador_cotista_id = ? UNION ALL SELECT 1 FROM recibos_saida WHERE cotista_id = ? LIMIT 1').bind(id, id, id).first()
    if (historico) return c.json({ error: 'aeronave_nao_pode_ser_alterada_com_historico_financeiro' }, 409)
  }
  await db.prepare("UPDATE cotista_aeronave SET aeronave_id = ?, percentual_sociedade = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND lower(COALESCE(status, 'ativo')) = 'ativo'").bind(aeronaveId, percentual, id).run()
  return c.json({ success: true, id, aeronave_id: aeronaveId, percentual_sociedade: percentual })
})
enviosPagamentoRoutes.delete('/envios-pagamento/cotistas/:id', async (c) => {
  if (!c.get('userId')) return c.json({ error: 'nao_autorizado' }, 401)
  const id = c.req.param('id')
  const result = await c.env.SHARE_DB.prepare("UPDATE cotista_aeronave SET status = 'inativo', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND lower(COALESCE(status, 'ativo')) = 'ativo'").bind(id).run()
  if (!result.meta?.changes) return c.json({ error: 'participacao_nao_encontrada' }, 404)
  return c.json({ success: true, id, status: 'inativo' })
})

async function atualizarStatusEnvioPagamento(c: any, id: string, requested: string, somenteProprietario = false) {
  const db = c.env.SHARE_DB
  const current = await db.prepare('SELECT id, tipo, status, criado_por FROM envio_despesas WHERE id = ?').bind(id).first() as { id: string; tipo: string; status: string; criado_por: string | null } | null
  if (!current) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  if (somenteProprietario) {
    const userId = c.get('userId') as string | null
    const podeGerenciar = userId ? await usuarioPodeGerenciarFinanceiro(db, userId) : false
    if (!podeGerenciar && current.criado_por !== userId) return c.notFound()
    if (requested !== 'EMAIL_ENVIADO') return c.json({ error: 'transicao_status_solicitacao_invalida' }, 400)
  }
  const currentStatus = String(current.status ?? '').toUpperCase()
  if (currentStatus === 'CONVERTIDO' && requested === 'EMAIL_ENVIADO') {
    await db.prepare(`UPDATE envio_despesas
      SET email_enviado = 1, email_enviado_em = CURRENT_TIMESTAMP, atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'CONVERTIDO'`).bind(id).run()
    return db.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(id).first().then((row: unknown) => c.json(row))
  }
  const transitions: Record<string, string[]> = {
    PENDENTE: current.tipo === 'share' ? ['APROVADO', 'CANCELADO'] : ['EMAIL_ENVIADO', 'CANCELADO'],
    APROVADO: ['EMAIL_ENVIADO', 'CANCELADO'],
    EMAIL_ENVIADO: ['CANCELADO'],
    CONVERTIDO: [],
    CANCELADO: [],
  }
  if (!transitions[currentStatus]?.includes(requested)) {
    return c.json({ error: 'transicao_status_solicitacao_invalida', de: currentStatus, para: requested }, 409)
  }
  await db.prepare('UPDATE envio_despesas SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = ?').bind(requested, id, current.status).run()
  return db.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(id).first().then((row: unknown) => c.json(row))
}

enviosPagamentoRoutes.post('/envios-pagamento/:id/email-enviado', async (c) =>
  atualizarStatusEnvioPagamento(c, c.req.param('id'), 'EMAIL_ENVIADO', true))

enviosPagamentoRoutes.patch('/envios-pagamento/:id', async (c) => {
  const body: { status?: string } = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }))
  return atualizarStatusEnvioPagamento(c, c.req.param('id'), String(body.status ?? '').toUpperCase())
})

enviosPagamentoRoutes.post('/envios-pagamento/:id/aprovar', async (c) => {
  const db = c.env.SHARE_DB
  const id = c.req.param('id')
  const request = await db.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!request) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  if (request.tipo !== 'share') return c.json({ error: 'somente_solicitacoes_de_compra_share_podem_ser_aprovadas' }, 409)
  const result = await db.prepare("UPDATE envio_despesas SET status = 'APROVADO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDENTE'").bind(id).run()
  if (!result.meta.changes) return c.json({ error: 'solicitacao_nao_pendente' }, 409)
  const userId = c.get('userId') || null
  const statements = mensagemFinanceiraStatements(db, String(request.criado_por ?? '') || null, userId, 'Solicitação de compra aprovada', `Sua solicitação “${String(request.descricao ?? '')}” foi aprovada e está sendo preparada para pagamento.`)
  if (statements.length) await db.batch(statements)
  try {
    const conversion = await convertPaymentRequest(db, { ...request, status: 'APROVADO' }, { createExpense, createReimbursement, createDirectExternalExpense, createClientExpenseRateios }, userId)
    if (request.solicitacao_compra_id) {
      await db.prepare("UPDATE solicitacoes_compra SET status = 'APROVADA', data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?").bind(request.solicitacao_compra_id).run()
    }
    return c.json({ ok: true, ...conversion, status: 'CONVERTIDO' })
  } catch (error) {
    return c.json({ ok: false, id, status: 'APROVADO', error: 'falha_ao_converter_solicitacao', detail: error instanceof Error ? error.message : 'Falha ao criar a conta a pagar.' }, 502)
  }
})

enviosPagamentoRoutes.post('/envios-pagamento/:id/converter', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const request = await db.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(c.req.param('id')).first<Record<string, unknown>>()
    if (!request) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
    const userId = c.get('userId') as string | null
    const podeGerenciar = userId ? await usuarioPodeGerenciarFinanceiro(db, userId) : false
    if (!podeGerenciar && (request.criado_por !== userId || !['cliente', 'reembolso'].includes(String(request.tipo)))) return c.notFound()
    if (!podeGerenciar && request.tipo === 'reembolso' && !['EMAIL_ENVIADO', 'CONVERTIDO'].includes(String(request.status).toUpperCase())) {
      return c.json({ error: 'envie_o_email_antes_de_converter' }, 409)
    }
    if (request.tipo === 'share' && !['APROVADO', 'CONVERTIDO'].includes(String(request.status))) return c.json({ error: 'solicitacao_nao_aprovada' }, 409)
    if (request.tipo !== 'share' && !['PENDENTE', 'APROVADO', 'EMAIL_ENVIADO', 'CONVERTIDO'].includes(String(request.status))) return c.json({ error: 'solicitacao_nao_aprovada' }, 409)
    return c.json(await convertPaymentRequest(
      c.env.SHARE_DB,
      request,
      { createExpense, createReimbursement, createDirectExternalExpense, createClientExpenseRateios },
      userId,
    ))
  } catch (error) { return errorResponse(c, error) }
})
