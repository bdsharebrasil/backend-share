import { Hono } from "hono"
import { createClientExpenseRateios, createDirectExternalExpense, createExpense, createReimbursement } from "./FinanceiroKernel"
import { convertPaymentRequest, createPaymentRequest, validatePaymentRequest } from "./paymentAgents"
import { mensagemFinanceiraStatements } from "./financeiroNotifications"
import { errorResponse } from "./errorResponse"

type Bindings = { SHARE_DB: D1Database; SHARE_FILES?: R2Bucket; FILES?: R2Bucket; R2_PUBLIC_URL?: string }
type Variables = { userId: string | null }

export const enviosPagamentoRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
enviosPagamentoRoutes.post('/envios-pagamento', async (c) => {
  try {
    let input
    try {
      input = validatePaymentRequest(await c.req.json())
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'dados_de_envio_invalidos', code: 'dados_de_envio_invalidos' }, 400)
    }
    const result = await createPaymentRequest(c.env.SHARE_DB, input, c.get('userId') || null)
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) { return errorResponse(c, error) }
})

enviosPagamentoRoutes.get('/envios-pagamento', async (c) => {
  const tipo = c.req.query('tipo')
  const query = `SELECT e.*, COALESCE(u.nome_exibicao, u.nome_completo, u.email, e.criado_por) AS solicitante_nome
    FROM envio_despesas e LEFT JOIN user_profiles u ON u.id = e.criado_por
    ${tipo ? 'WHERE e.tipo = ?' : ''} ORDER BY e.criado_em DESC LIMIT 200`
  const result = tipo ? await c.env.SHARE_DB.prepare(query).bind(tipo).all() : await c.env.SHARE_DB.prepare(query).all()
  return c.json({ envios: result.results ?? [] })
})

enviosPagamentoRoutes.get('/envios-pagamento/opcoes', async (c) => {
  const db = c.env.SHARE_DB
  const read = async (sql: string) => (await db.prepare(sql).all().catch((error) => { console.warn('[financeiro/envios] consulta opcional indisponível', error); return { results: [] } })).results ?? []
  const [fornecedores, fornecedoresCombustivel, aeronaves, voos, categorias, categoriasCliente] = await Promise.all([
    read('SELECT id, COALESCE(apelido, nome_completo) AS label FROM fornecedores_favoritos ORDER BY label'),
    read('SELECT * FROM fornecedores_combustivel ORDER BY nome_cidade, nome_fornecedor'),
    read('SELECT id, matricula_registro, fabricante, modelo FROM aeronave ORDER BY matricula_registro'),
    read("SELECT numero_voo, MAX(data_agendada) AS ultima_data, aeronave_id FROM solicitacoes_reserva_voo WHERE NULLIF(TRIM(numero_voo), '') IS NOT NULL GROUP BY numero_voo, aeronave_id ORDER BY ultima_data DESC, numero_voo"),
    read('SELECT id, nome, grupo_categoria, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_share ORDER BY nome'),
    read('SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome'),
  ])
  return c.json({ fornecedores, fornecedores_combustivel: fornecedoresCombustivel, aeronaves, voos, categorias, categorias_cliente: categoriasCliente })
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
  const result = await c.env.SHARE_DB.prepare(`
    SELECT ca.id, ca.aeronave_id, ca.cliente_id, ca.socio_id, ca.codigo_cliente,
           ca.percentual_sociedade,
           COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, 'Cotista não identificado') AS nome,
           COALESCE(cl.email_principal, hs.email_principal) AS email,
           CASE WHEN ca.socio_id IS NOT NULL THEN 1 ELSE 0 END AS eh_holding
      FROM cotista_aeronave ca
      LEFT JOIN cliente cl ON cl.id = ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
     WHERE ca.aeronave_id = ?
     ORDER BY COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente)
  `).bind(c.req.param('id')).all()
  return c.json({ cotistas: result.results ?? [] })
})

enviosPagamentoRoutes.patch('/envios-pagamento/:id', async (c) => {
  const body: { status?: string } = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }))
  const requested = String(body.status ?? '').toUpperCase()
  const id = c.req.param('id')
  const current = await c.env.SHARE_DB.prepare('SELECT id, tipo, status FROM envio_despesas WHERE id = ?').bind(id).first<{ id: string; tipo: string; status: string }>()
  if (!current) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  const currentStatus = String(current.status ?? '').toUpperCase()
  if (currentStatus === 'CONVERTIDO' && requested === 'EMAIL_ENVIADO') {
    await c.env.SHARE_DB.prepare(`UPDATE envio_despesas
      SET email_enviado = 1, email_enviado_em = CURRENT_TIMESTAMP, atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'CONVERTIDO'`).bind(id).run()
    return c.env.SHARE_DB.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(id).first().then((row) => c.json(row))
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
  await c.env.SHARE_DB.prepare('UPDATE envio_despesas SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = ?').bind(requested, id, current.status).run()
  return c.env.SHARE_DB.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(id).first().then((row) => c.json(row))
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
    const request = await c.env.SHARE_DB.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(c.req.param('id')).first<Record<string, unknown>>()
    if (!request) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
    if (request.tipo === 'share' && !['APROVADO', 'CONVERTIDO'].includes(String(request.status))) return c.json({ error: 'solicitacao_nao_aprovada' }, 409)
    if (request.tipo !== 'share' && !['PENDENTE', 'APROVADO', 'EMAIL_ENVIADO', 'CONVERTIDO'].includes(String(request.status))) return c.json({ error: 'solicitacao_nao_aprovada' }, 409)
    return c.json(await convertPaymentRequest(
      c.env.SHARE_DB,
      request,
      { createExpense, createReimbursement, createDirectExternalExpense, createClientExpenseRateios },
      c.get('userId') || null,
    ))
  } catch (error) { return errorResponse(c, error) }
})
