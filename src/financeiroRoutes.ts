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

async function listar(db: D1Database, sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
  const statement = db.prepare(sql)
  const result = params.length
    ? await statement.bind(...params).all<Record<string, unknown>>()
    : await statement.all<Record<string, unknown>>()
  return result.results ?? []
}

function mapConta(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    dataVencimento: row.data_vencimento,
    valor: Number(row.valor ?? Number(row.valor_centavos ?? 0) / 100),
    categoriaId: row.categoria_id ?? null,
    categoriaNome: row.categoria_nome ?? null,
    descricao: row.descricao ?? null,
    criadoPor: row.criado_por ?? null,
    aeronaveId: row.aeronave_id ?? null,
    fornecedorId: row.fornecedor_id ?? null,
    cotistaId: row.cotista_id ?? null,
    boletoUrl: row.boleto_url ?? null,
    nfUrl: row.nf_url ?? null,
    nfSaidaId: row.nf_saida_id ?? null,
    dataPagamento: row.data_pagamento ?? row.data_recebimento ?? null,
    bancoPagamento: row.banco_pagamento ?? row.banco_recebimento ?? null,
    comprovantePagamentoUrl: row.comprovante_pagamento_url ?? row.comprovante_recebimento_url ?? null,
    lancamentoId: row.lancamento_id ?? row.lancamentos_id ?? row.lancamento_receita_id ?? null,
    status: row.status,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  }
}

async function consultarContas(c: any, table: 'contas_apagar' | 'contas_areceber') {
  const status = c.req.query('status')
  const cotistaId = c.req.query('cotistaId')
  const fornecedorId = c.req.query('fornecedorId')
  const vencidasAte = c.req.query('vencidasAte')
  const filtros: string[] = []
  const params: unknown[] = []
  if (status) { filtros.push('status = ?'); params.push(status) }
  if (cotistaId && table === 'contas_areceber') { filtros.push('cotista_id = ?'); params.push(cotistaId) }
  if (fornecedorId && table === 'contas_apagar') { filtros.push('fornecedor_id = ?'); params.push(fornecedorId) }
  if (vencidasAte) { filtros.push("date(data_vencimento) <= date(?)"); params.push(vencidasAte) }
  const rows = await listar(c.env.SHARE_DB, `SELECT * FROM ${table}${filtros.length ? ` WHERE ${filtros.join(' AND ')}` : ''} ORDER BY date(data_vencimento) ASC, criado_em DESC LIMIT 500`, ...params)
  return rows.map(mapConta)
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

financeiroRoutes.get('/contas-apagar', async (c) => {
  try { return c.json(await consultarContas(c, 'contas_apagar')) } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/contas-areceber', async (c) => {
  try { return c.json(await consultarContas(c, 'contas_areceber')) } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/lancamentos/opcoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [categorias, contas, cotistas, holdings] = await Promise.all([
      listar(db, 'SELECT id, nome, tipo, grupo_categoria, tipo_despesa FROM categoria_movimentacao_share ORDER BY nome'),
      listar(db, 'SELECT id, banco, numero_conta, tipo_conta FROM contas_bancarias ORDER BY banco'),
      listar(db, "SELECT ca.id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome, ca.aeronave_id, ca.percentual_sociedade FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id ORDER BY nome"),
      listar(db, 'SELECT id, nome, conta_bancaria FROM holdings ORDER BY nome'),
    ])
    return c.json({ categorias, contas_bancarias: contas, cotistas, holdings, pagadores: cotistas })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/share/opcoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [categorias, contas, empresas] = await Promise.all([
      listar(db, 'SELECT id, nome, tipo, grupo_categoria AS grupo, tipo_despesa AS classificacao, empresa_id, 0 AS reembolsavel FROM categoria_movimentacao_share ORDER BY nome'),
      listar(db, 'SELECT id, banco, numero_conta, tipo_conta FROM contas_bancarias ORDER BY banco'),
      listar(db, 'SELECT id, razao_social, cnpj FROM empresa ORDER BY razao_social'),
    ])
    return c.json({ categorias, contas_bancarias: contas, empresas })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/lancamentos', async (c) => {
  try {
    const inicio = c.req.query('inicio')
    const fim = c.req.query('fim')
    const caixa = c.req.query('caixa')
    const filtros: string[] = []
    const params: unknown[] = []
    if (inicio) { filtros.push('date(COALESCE(data, data_emissao, criado_em)) >= date(?)'); params.push(inicio) }
    if (fim) { filtros.push('date(COALESCE(data, data_emissao, criado_em)) <= date(?)'); params.push(fim) }
    if (caixa) { filtros.push('tipo_caixa = ?'); params.push(caixa.toUpperCase()) }
    const rows = await listar(c.env.SHARE_DB, `SELECT * FROM lancamentos${filtros.length ? ` WHERE ${filtros.join(' AND ')}` : ''} ORDER BY date(COALESCE(data, data_emissao, criado_em)) DESC, criado_em DESC LIMIT 500`, ...params)
    return c.json({ lancamentos: rows })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/notas-saida/opcoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [cotistas, aeronaves, categoriasReceita, categoriasDespesa, contasBancarias] = await Promise.all([
      listar(db, "SELECT ca.id AS cotista_aeronave_id, ca.aeronave_id, ca.cliente_id, ca.socio_id, ca.codigo_cliente, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome, COALESCE(cl.cnpj, hs.cpf) AS documento, COALESCE(cl.endereco, hs.endereco) AS endereco, COALESCE(cl.cidade, hs.cidade) AS cidade, COALESCE(cl.uf, hs.uf) AS uf, CASE WHEN ca.socio_id IS NULL THEN 'cliente' ELSE 'socio_hold' END AS tipo_cotista, ca.percentual_sociedade FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id ORDER BY nome"),
      listar(db, 'SELECT id, matricula_registro FROM aeronave ORDER BY matricula_registro'),
      listar(db, "SELECT id, nome, grupo_categoria, tipo_despesa FROM categoria_movimentacao_share WHERE upper(COALESCE(grupo_categoria, '')) LIKE '%RECEIT%' OR upper(COALESCE(nome, '')) LIKE '%N.F%' OR upper(COALESCE(nome, '')) LIKE '%RECIBO%' ORDER BY nome"),
      listar(db, 'SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome'),
      listar(db, 'SELECT id, banco, numero_conta FROM contas_bancarias ORDER BY banco'),
    ])
    return c.json({ cotistas, aeronaves, categoriasReceita, categoriasDespesa, contasBancarias })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/notas-saida', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const notas = await listar(db, `SELECT n.id, 'nf_saida' AS origem, n.numero, n.cotista_id AS cotista_aeronave_id, ca.cliente_id, ca.socio_id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS cliente_nome, COALESCE(cl.cnpj, hs.cpf) AS cliente_cnpj, COALESCE(cl.endereco, hs.endereco) AS cliente_endereco, COALESCE(cl.cidade, hs.cidade) AS cliente_cidade, COALESCE(cl.uf, hs.uf) AS cliente_uf, cl.email_principal AS cliente_email, n.aeronave_id, a.matricula_registro AS aeronave_matricula, n.data_emissao AS data_criacao, n.data_vencimento, n.valor_total, n.nome_categoria AS categoria, n.descricao_servico AS descricao, n.status, n.arquivo_pdf_url, n.criado_em, n.atualizado_em, cr.id AS contas_areceber_id FROM notas_fiscais_saida n LEFT JOIN cotista_aeronave ca ON ca.id = n.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id LEFT JOIN aeronave a ON a.id = n.aeronave_id LEFT JOIN contas_areceber cr ON cr.nf_saida_id = n.id ORDER BY date(n.data_emissao) DESC, n.criado_em DESC`)
    const recibos = await listar(db, `SELECT r.id, 'recibo_saida' AS origem, r.numero_recibo, r.cotista_id AS cotista_aeronave_id, ca.cliente_id, ca.socio_id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS cliente_nome, COALESCE(cl.cnpj, hs.cpf) AS cliente_cnpj, COALESCE(cl.endereco, hs.endereco) AS cliente_endereco, COALESCE(cl.cidade, hs.cidade) AS cliente_cidade, COALESCE(cl.uf, hs.uf) AS cliente_uf, cl.email_principal AS cliente_email, r.aeronave_id, a.matricula_registro AS aeronave_matricula, r.data_emissao, r.data_vencimento, r.valor_total, r.nome_categoria, r.descricao_servico, r.status, r.pdf_url, r.contas_areceber_id, r.criado_em, r.atualizado_em FROM recibos_saida r LEFT JOIN cotista_aeronave ca ON ca.id = r.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id LEFT JOIN aeronave a ON a.id = r.aeronave_id ORDER BY date(r.data_emissao) DESC, r.criado_em DESC`)
    return c.json({ notas, recibos })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/dashboard/financeiro', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [receber, pagar, movimentacoes] = await Promise.all([
      listar(db, "SELECT valor_centavos, status FROM contas_areceber WHERE status <> 'CANCELADO'"),
      listar(db, "SELECT valor_centavos, status FROM contas_apagar WHERE status <> 'CANCELADO'"),
      listar(db, 'SELECT id, descricao, status, data_pagamento, valor_centavos, observacoes, criado_em FROM lancamentos ORDER BY criado_em DESC LIMIT 100'),
    ])
    const totalAReceber = receber.reduce((total, row) => total + Number(row.valor_centavos || 0) / 100, 0)
    const totalPago = pagar.filter((row) => row.status === 'PAGO').reduce((total, row) => total + Number(row.valor_centavos || 0) / 100, 0)
    return c.json({ resumo: { total_a_receber: totalAReceber, total_pago: totalPago, pendencias: pagar.filter((row) => row.status === 'EM_ABERTO').length, pagamentos_confirmados: pagar.filter((row) => row.status === 'PAGO').length }, movimentacoes: movimentacoes.map((row) => ({ ...row, valor: Number(row.valor_centavos || 0) / 100 })) })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/cotista/dashboard', async (c) => {
  try {
    const rows = await listar(c.env.SHARE_DB, 'SELECT id, data, descricao, numero_doc, fornecedor_nome, categoria_nome, grupo_categoria, tipo, data_vencimento, fluxo, valor_centavos, pago_por, tipo_caixa, pago_diretamente, reembolsavel, reembolso_quitado, status, observacoes FROM lancamentos ORDER BY date(data) DESC, criado_em DESC LIMIT 500')
    const lancamentos = rows.map((row) => ({ id: row.id, data: row.data, descricao: row.descricao, documento: row.numero_doc ?? null, fornecedor: row.fornecedor_nome ?? null, categoria: row.categoria_nome ?? 'SEM CATEGORIA', grupoCategoria: row.grupo_categoria ?? '', tipo: row.tipo ?? null, prazo: row.data_vencimento ?? null, fluxo: row.fluxo === 'ENTRADA' ? 'ENTRADA' : 'SAIDA', valorCentavos: Number(row.valor_centavos || 0), pagoPor: row.pago_por ?? '', caixa: row.tipo_caixa ?? 'SHARE', pagoDiretamente: Boolean(row.pago_diretamente), reembolsavel: Boolean(row.reembolsavel), reembolsoQuitado: Boolean(row.reembolso_quitado), status: row.status ?? 'EM_ABERTO', observacoes: row.observacoes ?? null, rateios: [] }))
    const entradas = lancamentos.filter((row) => row.fluxo === 'ENTRADA').reduce((total, row) => total + row.valorCentavos / 100, 0)
    const saidas = lancamentos.filter((row) => row.fluxo === 'SAIDA').reduce((total, row) => total + row.valorCentavos / 100, 0)
    return c.json({ lancamentos, saldos: [], matrizCompensacao: {}, holdings: [], resumo: { entradas, saidas, saldo: entradas - saidas, custo_rateado: saidas, pendentes: lancamentos.filter((row) => row.status === 'EM_ABERTO').length, media_mensal: 0, media_lancamento: lancamentos.length ? (entradas + saidas) / lancamentos.length : 0 }, fechamento_mensal: [], ranking_gastos: [], ranking_cotistas: [] })
  } catch (error) { return errorResponse(c, error) }
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
