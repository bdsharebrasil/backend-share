import { Hono } from 'hono'
import {
  createExpense,
  createReimbursement,
  enqueueFinance,
  FinanceError,
  issueRevenue,
  issueReceipt,
  processFinanceQueue,
  settlePayable,
  settleReceivable,
  validateFinanceSchema,
} from './financeiro/FinanceiroKernel'
import { createPaymentRequest, convertPaymentRequest, validatePaymentRequest } from './financeiro/paymentAgents'

type Bindings = {
  SHARE_DB: D1Database
  FILES?: R2Bucket
}

type Variables = {
  userId: string | null
}

export const financeiroRoutes = new Hono<{
  Bindings: Bindings
  Variables: Variables
}>()

function errorResponse(c: any, error: unknown) {
  if (error instanceof FinanceError) {
    return c.json(
      {
        error: error.message,
        code: error.code,
      },
      error.status,
    )
  }

  console.error('[financeiro]', error)
  return c.json(
    {
      error: 'falha_ao_processar_financeiro',
      code: 'erro_interno',
    },
    500,
  )
}

/*
 * Esta rota somente valida o schema. Ela não cria, altera ou exclui tabelas.
 * Pode ser usada no health check ou no deploy para detectar incompatibilidade.
 */
financeiroRoutes.get('/schema/validate', async (c) => {
  try {
    await validateFinanceSchema(c.env.SHARE_DB)
    return c.json({ valido: true })
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/lancamentos/despesa', async (c) => {
  try {
    const body = await c.req.json()
    const result = await createExpense(
      c.env.SHARE_DB,
      body,
      c.get('userId') || null,
    )
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/lancamentos/receita', async (c) => {
  try {
    const body = await c.req.json()
    const result = await issueRevenue(
      c.env.SHARE_DB,
      body,
      c.get('userId') || null,
    )
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/reembolsos', async (c) => {
  try {
    const body = await c.req.json()
    const result = await createReimbursement(
      c.env.SHARE_DB,
      body,
      c.get('userId') || null,
    )
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/recibos', async (c) => {
  try {
    const result = await issueReceipt(
      c.env.SHARE_DB,
      await c.req.json(),
      c.get('userId') || null,
    )
    return c.json(result, 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.get('/recibos', async (c) => {
  const status = c.req.query('status')
  const result = status
    ? await c.env.SHARE_DB.prepare('SELECT * FROM recibos WHERE status = ? ORDER BY criado_em DESC LIMIT 200').bind(status).all()
    : await c.env.SHARE_DB.prepare('SELECT * FROM recibos ORDER BY criado_em DESC LIMIT 200').all()
  return c.json({ recibos: result.results ?? [] })
})

financeiroRoutes.get('/recibos/opcoes', async (c) => {
  const db = c.env.SHARE_DB
  const read = async (sql: string) => (await db.prepare(sql).all().catch(() => ({ results: [] }))).results ?? []
  const [clientes, colaboradores, aeronaves, cotistas, categorias, categoriasCliente] = await Promise.all([
    read('SELECT id, razao_social, cnpj, endereco, cidade, uf, holding, status FROM cliente ORDER BY razao_social'),
    read('SELECT id, nome_completo, nome_exibicao, cpf, nome_banco, tipo_conta, conta_numero, agencia_numero, pix FROM user_profiles ORDER BY nome_completo'),
    read('SELECT id, matricula_registro, fabricante, modelo FROM aeronave ORDER BY matricula_registro'),
    read('SELECT id, aeronave_id, cliente_id, socio_id, codigo_cliente, percentual_sociedade FROM cotista_aeronave ORDER BY codigo_cliente'),
    read('SELECT id, nome, grupo_categoria, tipo_despesa FROM categoria_movimentacao_share ORDER BY nome'),
    read('SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome'),
  ])
  return c.json({ clientes, colaboradores, aeronaves, cotistas, categorias, categorias_cliente: categoriasCliente, recebedores: colaboradores })
})

financeiroRoutes.patch('/recibos/:id/status', async (c) => {
  const body = await c.req.json<{ status?: string }>().catch(() => ({}))
  const allowed = new Set(['CRIADO', 'ANEXO_PENDENTE', 'PDF_PENDENTE', 'EMITIDO', 'ERRO_ANEXO', 'ERRO_PDF', 'CANCELADO'])
  if (!body.status || !allowed.has(body.status)) return c.json({ error: 'status_recibo_invalido' }, 400)
  await c.env.SHARE_DB.prepare('UPDATE recibos SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(body.status, c.req.param('id')).run()
  return c.json({ ok: true, status: body.status })
})

financeiroRoutes.post('/recibos/:id/cancelar', async (c) => {
  await c.env.SHARE_DB.prepare("UPDATE recibos SET status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

financeiroRoutes.post('/envios-pagamento', async (c) => {
  try {
    const input = validatePaymentRequest(await c.req.json())
    return c.json(await createPaymentRequest(c.env.SHARE_DB, input, c.get('userId') || null), 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/envios-pagamento', async (c) => {
  const tipo = c.req.query('tipo')
  const query = tipo ? 'SELECT * FROM envio_despesas WHERE tipo = ? ORDER BY criado_em DESC LIMIT 200' : 'SELECT * FROM envio_despesas ORDER BY criado_em DESC LIMIT 200'
  const result = tipo ? await c.env.SHARE_DB.prepare(query).bind(tipo).all() : await c.env.SHARE_DB.prepare(query).all()
  return c.json({ envios: result.results ?? [] })
})

financeiroRoutes.get('/envios-pagamento/opcoes', async (c) => {
  const db = c.env.SHARE_DB
  const read = async (sql: string) => (await db.prepare(sql).all().catch(() => ({ results: [] }))).results ?? []
  const [fornecedores, aeronaves, categorias, categoriasCliente] = await Promise.all([
    read('SELECT id, COALESCE(apelido, razao_social, nome) AS label FROM fornecedores_favoritos ORDER BY label'),
    read('SELECT id, matricula_registro, fabricante, modelo FROM aeronave ORDER BY matricula_registro'),
    read('SELECT id, nome, grupo_categoria, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_share ORDER BY nome'),
    read('SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome'),
  ])
  return c.json({ fornecedores, aeronaves, voos: [], categorias, categorias_cliente: categoriasCliente })
})

financeiroRoutes.get('/envios-pagamento/anexos-opcoes', async (c) => c.json({ recibos: [], relatorios: [], abastecimentos: [] }))

financeiroRoutes.get('/envios-pagamento/aeronave/:id/cotistas', async (c) => {
  const result = await c.env.SHARE_DB.prepare('SELECT id, aeronave_id, cliente_id, socio_id, codigo_cliente, percentual_sociedade FROM cotista_aeronave WHERE aeronave_id = ? ORDER BY codigo_cliente').bind(c.req.param('id')).all()
  return c.json({ cotistas: result.results ?? [] })
})

financeiroRoutes.patch('/envios-pagamento/:id', async (c) => {
  const body = await c.req.json<{ status?: string }>().catch(() => ({}))
  const allowed = new Set(['PENDENTE', 'APROVADO', 'CONVERTIDO', 'CANCELADO', 'EMAIL_ENVIADO'])
  if (!body.status || !allowed.has(body.status)) return c.json({ error: 'status_solicitacao_invalido' }, 400)
  await c.env.SHARE_DB.prepare('UPDATE envio_despesas SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(body.status, c.req.param('id')).run()
  return c.env.SHARE_DB.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(c.req.param('id')).first().then((row) => c.json(row))
})

financeiroRoutes.post('/envios-pagamento/:id/aprovar', async (c) => {
  const result = await c.env.SHARE_DB.prepare("UPDATE envio_despesas SET status = 'APROVADO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDENTE'").bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.json({ error: 'solicitacao_nao_pendente' }, 409)
  return c.json({ ok: true, id: c.req.param('id'), status: 'APROVADO' })
})

financeiroRoutes.post('/envios-pagamento/:id/converter', async (c) => {
  try {
    const request = await c.env.SHARE_DB.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(c.req.param('id')).first<Record<string, unknown>>()
    if (!request) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
    if (request.status !== 'APROVADO' && request.status !== 'CONVERTIDO') return c.json({ error: 'solicitacao_nao_aprovada' }, 409)
    return c.json(await convertPaymentRequest(c.env.SHARE_DB, request, createExpense, c.get('userId') || null))
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/anexos', async (c) => {
  try {
    // O upload é uma etapa de arquivo. A criação do recibo permanece no
    // ReceiptAgent e o Worker não cria nem altera tabelas.
    await validateFinanceSchema(c.env.SHARE_DB)
    if (!c.env.FILES) return c.json({ error: 'storage_nao_configurado' }, 503)
    const form = await c.req.parseBody()
    const arquivo = form.arquivo
    if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    const reciboId = String(form.recibo_id || '')
    if (!reciboId) return c.json({ error: 'recibo_id_obrigatorio' }, 400)
    const id = crypto.randomUUID()
    const key = `recibos/${reciboId}/original/${id}-${arquivo.name}`
    await c.env.FILES.put(key, await arquivo.arrayBuffer(), { httpMetadata: { contentType: arquivo.type || 'application/octet-stream' } })
    await c.env.SHARE_DB.prepare('INSERT INTO recibo_anexos (id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, recibo_id, finalidade) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, arquivo.name, key, arquivo.type || 'application/octet-stream', arquivo.size, c.get('userId') || null, reciboId, 'ORIGINAL').run()
    await c.env.SHARE_DB.prepare("UPDATE recibos SET status = 'PDF_PENDENTE', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").bind(reciboId).run()
    return c.json({ id, url: `/api/financeiro/recibos/anexos/${id}/arquivo`, nome_arquivo: arquivo.name, tipo_arquivo: arquivo.type, tamanho_arquivo: arquivo.size }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/:id/pdf', async (c) => {
  try {
    await validateFinanceSchema(c.env.SHARE_DB)
    if (!c.env.FILES) return c.json({ error: 'storage_nao_configurado' }, 503)
    const form = await c.req.parseBody()
    const arquivo = form.arquivo
    if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    const reciboId = c.req.param('id')
    const anexoId = crypto.randomUUID()
    const key = `recibos/${reciboId}/pdf/${anexoId}.pdf`
    await c.env.FILES.put(key, await arquivo.arrayBuffer(), { httpMetadata: { contentType: 'application/pdf' } })
    await c.env.SHARE_DB.prepare('INSERT INTO recibo_anexos (id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, recibo_id, finalidade) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(anexoId, arquivo.name || `${reciboId}.pdf`, key, 'application/pdf', arquivo.size, c.get('userId') || null, reciboId, 'PDF').run()
    await c.env.SHARE_DB.prepare("UPDATE recibos SET status = 'EMITIDO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").bind(reciboId).run()
    return c.json({ anexo_id: anexoId, pdf_url: `/api/financeiro/recibos/anexos/${anexoId}/arquivo` }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/recibos/anexos/:id/arquivo', async (c) => {
  if (!c.env.FILES) return c.json({ error: 'storage_nao_configurado' }, 503)
  const row = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, tipo_arquivo FROM recibo_anexos WHERE id = ?').bind(c.req.param('id')).first<{ caminho_arquivo: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await c.env.FILES.get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return c.body(await object.arrayBuffer(), 200, { 'Content-Type': row.tipo_arquivo, 'Cache-Control': 'private, max-age=3600' })
})

financeiroRoutes.post('/contas-apagar/:id/baixa', async (c) => {
  try {
    const result = await settlePayable(
      c.env.SHARE_DB,
      c.req.param('id'),
      await c.req.json().catch(() => ({})),
      c.get('userId') || null,
    )
    return c.json(result)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/contas-areceber/:id/baixa', async (c) => {
  try {
    const result = await settleReceivable(
      c.env.SHARE_DB,
      c.req.param('id'),
      await c.req.json().catch(() => ({})),
      c.get('userId') || null,
    )
    return c.json(result)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/fila', async (c) => {
  try {
    const body = await c.req.json()
    const result = await enqueueFinance(
      c.env.SHARE_DB,
      body.operacao,
      body.payload,
    )
    return c.json(result, 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/fila/processar', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const result = await processFinanceQueue(
      c.env.SHARE_DB,
      c.get('userId') || null,
      Number(body.limit || 20),
    )
    return c.json({ result })
  } catch (error) {
    return errorResponse(c, error)
  }
})
