import { Hono } from "hono"
import { holdingMovementColumn, issueRevenue, loadSchema, settleReceivable } from "./FinanceiroKernel"
import { errorResponse } from "./errorResponse"
import { requireCaixaShareAccess } from "./access"
import { listar } from "./repositories/d1"

type Bindings = { SHARE_DB: D1Database; SHARE_FILES?: R2Bucket; FILES?: R2Bucket; R2_PUBLIC_URL?: string }
type Variables = { userId: string | null }

const tiposImagemLancamentoPermitidos = new Set([
  'image/jpeg', 'image/png', 'image/apng', 'image/gif', 'image/webp',
  'image/avif', 'image/bmp', 'image/svg+xml', 'image/x-icon',
])

export const notasSaidaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
notasSaidaRoutes.get('/notas-saida/opcoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [cotistas, aeronaves, categoriasReceita, categoriasDespesa, contasBancarias] = await Promise.all([
      listar(db, "SELECT ca.id AS cotista_aeronave_id, ca.aeronave_id, ca.cliente_id, ca.socio_id, ca.codigo_cliente, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome, COALESCE(cl.cnpj, hs.cpf) AS documento, COALESCE(cl.endereco, hs.endereco) AS endereco, COALESCE(cl.cidade, hs.cidade) AS cidade, COALESCE(cl.uf, hs.uf) AS uf, CASE WHEN ca.socio_id IS NULL THEN 'cliente' ELSE 'socio_hold' END AS tipo_cotista, ca.percentual_sociedade FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id ORDER BY nome"),
      listar(db, 'SELECT id, matricula_registro FROM aeronave ORDER BY matricula_registro'),
      listar(db, "SELECT id, nome, grupo_categoria, tipo_despesa FROM categoria_movimentacao_share WHERE upper(COALESCE(grupo_categoria, '')) LIKE '%RECEIT%' OR upper(COALESCE(nome, '')) LIKE '%N.F%' OR upper(COALESCE(nome, '')) LIKE '%RECIBO%' ORDER BY nome"),
      listar(db, 'SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome'),
      listar(db, 'SELECT id, banco, numero_conta FROM contas_bancarias WHERE ativo = 1 ORDER BY banco'),
    ])
    return c.json({ cotistas, aeronaves, categoriasReceita, categoriasDespesa, contasBancarias })
  } catch (error) { return errorResponse(c, error) }
})

notasSaidaRoutes.get('/notas-saida', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const db = c.env.SHARE_DB
    const notas = await listar(db, `SELECT n.id, 'nf_saida' AS origem, n.numero, n.cotista_id AS cotista_aeronave_id, ca.cliente_id, ca.socio_id, hs.holding_id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS cliente_nome, COALESCE(cl.cnpj, hs.cpf) AS cliente_cnpj, COALESCE(cl.endereco, hs.endereco) AS cliente_endereco, COALESCE(cl.cidade, hs.cidade) AS cliente_cidade, COALESCE(cl.uf, hs.uf) AS cliente_uf, COALESCE(cl.email_principal, hs.email_principal) AS cliente_email, n.aeronave_id, a.matricula_registro AS aeronave_matricula, n.data_emissao AS data_criacao, n.data_vencimento, n.valor_total, COALESCE(NULLIF(l.email_enviado_em, ''), (SELECT MAX(ee.email_enviado_em) FROM emails_enviados ee WHERE lower(ee.referencia_tipo) = 'nf_saida' AND ee.referencia_id = n.id AND lower(ee.status) = 'enviado')) AS email_enviado_em, n.nome_categoria AS categoria, n.descricao_servico AS descricao, COALESCE(cr.status, n.status) AS status, n.arquivo_pdf_url, n.criado_em, n.atualizado_em, cr.id AS contas_areceber_id FROM notas_fiscais_saida n LEFT JOIN cotista_aeronave ca ON ca.id = n.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id LEFT JOIN aeronave a ON a.id = n.aeronave_id LEFT JOIN contas_areceber cr ON cr.nf_saida_id = n.id LEFT JOIN lancamentos l ON l.id = n.lancamentos_id ORDER BY date(n.data_emissao) DESC, n.criado_em DESC`)
    const recibos = await listar(db, `SELECT r.id, 'recibo_saida' AS origem, r.numero_recibo, r.cotista_id AS cotista_aeronave_id, ca.cliente_id, ca.socio_id, hs.holding_id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS cliente_nome, COALESCE(cl.cnpj, hs.cpf) AS cliente_cnpj, COALESCE(cl.endereco, hs.endereco) AS cliente_endereco, COALESCE(cl.cidade, hs.cidade) AS cliente_cidade, COALESCE(cl.uf, hs.uf) AS cliente_uf, COALESCE(cl.email_principal, hs.email_principal) AS cliente_email, r.aeronave_id, a.matricula_registro AS aeronave_matricula, r.data_emissao, r.data_vencimento, r.valor_total, r.nome_categoria, r.descricao_servico, COALESCE(cr.status, r.status) AS status, r.pdf_url, r.contas_areceber_id, r.criado_em, r.atualizado_em FROM recibos_saida r LEFT JOIN contas_areceber cr ON cr.id = r.contas_areceber_id LEFT JOIN cotista_aeronave ca ON ca.id = r.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id LEFT JOIN aeronave a ON a.id = r.aeronave_id ORDER BY date(r.data_emissao) DESC, r.criado_em DESC`)
    return c.json({ notas, recibos })
  } catch (error) { return errorResponse(c, error) }
})

async function categoriaClienteNota(db: D1Database, id: string, subcategoria: string | null) {
  if (!id) return { id: null, nome: null, subcategoria }
  const row = await db.prepare('SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!row) return { id: null, nome: null, subcategoria }
  const subcategorias = [row.subcategoria_1, row.subcategoria_2, row.subcategoria_3, row.subcategoria_4].map((value) => String(value ?? '').trim()).filter(Boolean)
  return { id: String(row.id), nome: String(row.nome ?? '').trim() || null, subcategoria: subcategoria || subcategorias[0] || null }
}

function documentoSaidaRow(db: D1Database, id: string) {
  return db.prepare(`SELECT n.*, cr.id AS contas_areceber_id
    FROM notas_fiscais_saida n
    LEFT JOIN contas_areceber cr ON cr.nf_saida_id = n.id
    WHERE n.id = ?`).bind(id).first<Record<string, unknown>>()
}

function notaSaidaStatements(db: D1Database, nota: {
  id: string
  numero: string
  cotistaId: string
  aeronaveId: string
  valor: number
  descricao: string
  categoriaNome: string
  categoriaId: string
  subcategoria: string | null
  dataEmissao: string
  dataVencimento: string
  status: string
  arquivoPdfUrl: string | null
  lancamentoId: string
  contaReceberId: string
}): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  statements.push(db.prepare(`INSERT INTO notas_fiscais_saida
    (id, numero, cotista_id, aeronave_id, valor_total, percentual, descricao_servico, nome_categoria,
     categoria_id, subcategoria_1, data_emissao, data_vencimento, status, arquivo_pdf_url, lancamentos_id)
    VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(nota.id, nota.numero, nota.cotistaId, nota.aeronaveId, nota.valor, nota.descricao,
      nota.categoriaNome, nota.categoriaId, nota.subcategoria, nota.dataEmissao, nota.dataVencimento,
      nota.status, nota.arquivoPdfUrl, nota.lancamentoId))
  statements.push(db.prepare(`UPDATE contas_areceber
    SET nf_saida_id = ?, atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ? AND (nf_saida_id IS NULL OR nf_saida_id = ?)`)
    .bind(nota.id, nota.contaReceberId, nota.id))
  return statements
}

notasSaidaRoutes.post('/notas-saida', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const db = c.env.SHARE_DB
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const numero = String(body.numero ?? '').trim()
    const cotistaId = String(body.cotista_id ?? body.cotista_aeronave_id ?? '').trim()
    const aeronaveId = String(body.aeronave_id ?? '').trim()
    const dataEmissao = String(body.data_emissao ?? '').trim()
    const dataVencimento = String(body.data_vencimento ?? dataEmissao).trim()
    const descricao = String(body.descricao_servico ?? body.descricao ?? '').trim()
    const valor = Number(body.valor_total ?? body.valor ?? 0)
    const categoriaReceitaId = String(body.categoria_receita_id ?? '').trim()
    const categoriaClienteId = String(body.categoria_id ?? '').trim()
    if (!numero || !cotistaId || !aeronaveId || !categoriaReceitaId || !(valor > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(dataEmissao) || !descricao) {
      return c.json({ error: 'numero, cotista_id, aeronave_id, categoria_receita_id, valor_total, data_emissao e descricao_servico são obrigatórios' }, 400)
    }
    const cotista = await db.prepare('SELECT id FROM cotista_aeronave WHERE id = ? AND aeronave_id = ?').bind(cotistaId, aeronaveId).first()
    if (!cotista) return c.json({ error: 'cotista_aeronave_invalido' }, 400)
    const categoriaReceita = await db.prepare('SELECT id, nome FROM categoria_movimentacao_share WHERE id = ?').bind(categoriaReceitaId).first<{ id: string; nome: string }>()
    if (!categoriaReceita) return c.json({ error: 'categoria_receita_invalida' }, 400)
    const categoriaCliente = await categoriaClienteNota(db, categoriaClienteId, String(body.subcategoria_1 ?? '').trim() || null)
    if (categoriaClienteId && !categoriaCliente.id) return c.json({ error: 'categoria_despesa_invalida' }, 400)
    const id = crypto.randomUUID()
    const requestKey = String(body.idempotency_key ?? '').trim() || id
    const idempotencyKey = `nf_saida:${requestKey}`
    const dadosNota = {
      numero,
      cotistaId,
      aeronaveId,
      valor,
      descricao,
      categoriaNome: String(body.categoria_receita_nome ?? categoriaReceita.nome),
      categoriaId: categoriaReceitaId,
      subcategoria: categoriaCliente.subcategoria,
      dataEmissao,
      dataVencimento,
      status: 'EM_ABERTO',
      arquivoPdfUrl: body.arquivo_pdf_url ? String(body.arquivo_pdf_url) : null,
    }
    const financeiro = await issueRevenue(db, {
      idempotency_key: idempotencyKey,
      valor_centavos: Math.round(valor * 100),
      descricao,
      data: dataEmissao,
      data_emissao: dataEmissao,
      data_vencimento: dataVencimento,
      aeronave_id: aeronaveId,
      cotista_aeronave_id: cotistaId,
      categoria_id: categoriaReceitaId,
      categoria_nome: body.categoria_receita_nome ?? categoriaReceita.nome,
      categoria_cliente_id: categoriaCliente.id,
      categoria_cliente_nome: categoriaCliente.nome,
      categoria_despesa_subcategoria: categoriaCliente.subcategoria,
      numero_nf: numero,
      url_nf: dadosNota.arquivoPdfUrl,
      origem_tipo: 'NF_SAIDA',
      origem_id: id,
      periodicidade: 'MENSAL',
    }, c.get('userId') || null, {}, ({ lancamentoId, contaReceberId }) =>
      notaSaidaStatements(db, { ...dadosNota, id, lancamentoId, contaReceberId }),
      ['PAGO', 'RECEBIDO', 'PAID'].includes(String(body.status ?? '').trim().toUpperCase()) ? {
        data_pagamento: body.data_pagamento,
        conta_bancaria_id: body.conta_bancaria_id ?? body.conta_bancaria,
        forma_pagamento: body.forma_pagamento, comprovante_url: body.comprovante_url,
        saida_pagamento: body.saida_pagamento,
      } : undefined)

    if (financeiro.idempotent) {
      const conta = await db.prepare(`SELECT id, nf_saida_id, lancamentos_id
        FROM contas_areceber WHERE idempotency_key = ? LIMIT 1`).bind(idempotencyKey)
        .first<{ id: string; nf_saida_id: string | null; lancamentos_id: string | null }>()
      if (!conta?.id || !conta.lancamentos_id) return c.json({ error: 'operacao_financeira_incompleta' }, 409)
      const notaExistente = conta.nf_saida_id
        ? await documentoSaidaRow(db, conta.nf_saida_id)
        : await db.prepare('SELECT id FROM notas_fiscais_saida WHERE lancamentos_id = ? LIMIT 1')
          .bind(conta.lancamentos_id).first<{ id: string }>()
      if (notaExistente) {
        if (!conta.nf_saida_id) {
          await db.prepare(`UPDATE contas_areceber SET nf_saida_id = ?, atualizado_em = CURRENT_TIMESTAMP
            WHERE id = ? AND nf_saida_id IS NULL`).bind(notaExistente.id, conta.id).run()
        }
        return c.json({ nota: await documentoSaidaRow(db, String(notaExistente.id)) }, 200)
      }
      const notaId = conta.nf_saida_id || id
      await db.batch(notaSaidaStatements(db, {
        ...dadosNota, id: notaId, lancamentoId: conta.lancamentos_id, contaReceberId: conta.id,
      }))
      return c.json({ nota: await documentoSaidaRow(db, notaId) }, 200)
    }

    const nota = await documentoSaidaRow(db, id)
    if (!nota) return c.json({ error: 'nota_saida_nao_persistida' }, 500)
    return c.json({ nota }, 201)
  } catch (error) { return errorResponse(c, error) }
})

notasSaidaRoutes.patch('/notas-saida/:id', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const nota = await documentoSaidaRow(db, id)
    if (!nota) return c.json({ error: 'nota_saida_nao_encontrada' }, 404)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const fields: Array<[string, unknown]> = []
    const add = (column: string, value: unknown) => { if (value !== undefined) fields.push([column, value === '' ? null : value]) }
    add('numero', body.numero); add('cotista_id', body.cotista_id ?? body.cotista_aeronave_id); add('aeronave_id', body.aeronave_id)
    add('data_emissao', body.data_emissao); add('data_vencimento', body.data_vencimento); add('valor_total', body.valor_total ?? body.valor)
    if (body.status !== undefined && String(body.status).toUpperCase() !== String(nota.status).toUpperCase()) {
      return c.json({ error: 'Use a baixa de pagamento para alterar a situação financeira da nota.', code: 'status_exige_baixa' }, 409)
    }
    add('nome_categoria', body.nome_categoria); add('descricao_servico', body.descricao_servico ?? body.descricao)
    add('arquivo_pdf_url', body.arquivo_pdf_url)
    if (!fields.length) return c.json({ error: 'nenhum_campo_atualizavel' }, 400)
    const assignments = fields.map(([column]) => `${column} = ?`).join(', ')
    const statements: D1PreparedStatement[] = [db.prepare(`UPDATE notas_fiscais_saida SET ${assignments}, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(...fields.map(([, value]) => value), id)]
    const documentosFinanceiros: Array<[string, unknown]> = []
    if (body.numero !== undefined) documentosFinanceiros.push(['numero_nf', body.numero === '' ? null : body.numero])
    if (body.arquivo_pdf_url !== undefined) documentosFinanceiros.push(['url_nf', body.arquivo_pdf_url === '' ? null : body.arquivo_pdf_url])
    if (documentosFinanceiros.length) {
      const lancamentoId = String(nota.lancamentos_id ?? '').trim()
      const lancamentoIds = new Set([lancamentoId].filter(Boolean))
      if (lancamentoId) {
        const espelhos = await db.prepare("SELECT id FROM lancamentos WHERE origem_id = ? AND tipo_caixa = 'CLIENTE'").bind(lancamentoId).all<{ id: string }>()
        for (const espelho of espelhos.results || []) lancamentoIds.add(espelho.id)
      }
      if (lancamentoIds.size) {
        const ids = [...lancamentoIds]
        const placeholders = ids.map(() => '?').join(', ')
        const setClause = documentosFinanceiros.map(([column]) => `${column} = ?`).join(', ')
        const values = documentosFinanceiros.map(([, value]) => value)
        statements.push(db.prepare(`UPDATE lancamentos SET ${setClause} WHERE id IN (${placeholders})`).bind(...values, ...ids))
        statements.push(db.prepare(`UPDATE rateio_despesas SET ${setClause} WHERE lancamento_id IN (${placeholders})`).bind(...values, ...ids))
      }
      const conta = await db.prepare('SELECT movimentos_id FROM contas_areceber WHERE nf_saida_id = ? LIMIT 1').bind(id).first<{ movimentos_id: string | null }>()
      const movimentoId = String(conta?.movimentos_id ?? '').trim()
      if (movimentoId) {
        const setClause = documentosFinanceiros.map(([column]) => `${column} = ?`).join(', ')
        const values = documentosFinanceiros.map(([, value]) => value)
        statements.push(db.prepare(`UPDATE movimentos_holding SET ${setClause} WHERE id = ?`).bind(...values, movimentoId))
        const holdingColumn = holdingMovementColumn(await loadSchema(db))
        statements.push(db.prepare(`UPDATE rateio_hold SET ${setClause} WHERE ${holdingColumn} = ?`).bind(...values, movimentoId))
      }
    }
    await db.batch(statements)
    return c.json({ nota: await documentoSaidaRow(db, id) })
  } catch (error) { return errorResponse(c, error) }
})

notasSaidaRoutes.delete('/notas-saida/:id', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const nota = await documentoSaidaRow(db, id)
    if (!nota) return c.json({ error: 'nota_saida_nao_encontrada' }, 404)
    const contaId = String(nota.contas_areceber_id ?? '').trim()
    const lancamentoId = String(nota.lancamentos_id ?? '').trim()
    const conta = contaId ? await db.prepare('SELECT lancamentos_id, movimentos_id FROM contas_areceber WHERE id = ?').bind(contaId).first<{ lancamentos_id: string | null; movimentos_id: string | null }>() : null
    const lancamentos = [...new Set([lancamentoId, conta?.lancamentos_id ?? ''].filter(Boolean))]
    const espelhos = lancamentos.length ? await listar(db, `SELECT id FROM lancamentos WHERE origem_id IN (${lancamentos.map(() => '?').join(', ')})`, ...lancamentos) : []
    lancamentos.push(...espelhos.map((row) => String(row.id)).filter(Boolean))
    const ids = [...new Set(lancamentos)]
    const schema = await loadSchema(db)
    const movimentos = new Set([String(conta?.movimentos_id ?? '').trim()].filter(Boolean))
    if (!movimentos.size) {
      const movimentoVinculado = await db.prepare("SELECT destino_id AS id FROM financeiro_vinculos WHERE origem_tipo = 'NF_SAIDA' AND origem_id = ? AND destino_tipo = 'MOVIMENTO_HOLDING' AND tipo_vinculo = 'NF_SAIDA_MOVIMENTO' LIMIT 1").bind(id).first<{ id: string }>()
      const movimentoOrigem = movimentoVinculado?.id
        ? movimentoVinculado
        : schema.get('movimentos_holding')?.has('origem_tipo') && schema.get('movimentos_holding')?.has('origem_id')
          ? await db.prepare("SELECT id FROM movimentos_holding WHERE origem_tipo = 'NF_SAIDA' AND origem_id = ? LIMIT 1").bind(id).first<{ id: string }>()
          : null
      if (movimentoOrigem?.id) movimentos.add(movimentoOrigem.id)
    }
    const holdingColumn = holdingMovementColumn(schema)
    const statements: D1PreparedStatement[] = []
    const removerLancamentos: D1PreparedStatement[] = []
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(', ')
      statements.push(db.prepare(`DELETE FROM rateio_despesas WHERE lancamento_id IN (${placeholders})`).bind(...ids))
      removerLancamentos.push(db.prepare(`DELETE FROM lancamentos WHERE id IN (${placeholders})`).bind(...ids))
    }
    for (const movimentoId of movimentos) {
      statements.push(db.prepare(`DELETE FROM rateio_hold WHERE ${holdingColumn} = ?`).bind(movimentoId))
    }
    const vinculoIds = [...new Set([...ids, ...movimentos, id])]
    if (vinculoIds.length) {
      const placeholders = vinculoIds.map(() => '?').join(', ')
      statements.push(db.prepare(`DELETE FROM financeiro_vinculos WHERE origem_id IN (${placeholders}) OR destino_id IN (${placeholders})`).bind(...vinculoIds, ...vinculoIds))
    }
    if (contaId) statements.push(db.prepare('DELETE FROM contas_areceber WHERE id = ?').bind(contaId))
    statements.push(...removerLancamentos)
    for (const movimentoId of movimentos) statements.push(db.prepare('DELETE FROM movimentos_holding WHERE id = ?').bind(movimentoId))
    statements.push(db.prepare('DELETE FROM notas_fiscais_saida WHERE id = ?').bind(id))
    await db.batch(statements)
    return c.json({ ok: true, id })
  } catch (error) { return errorResponse(c, error) }
})

notasSaidaRoutes.post('/notas-saida/:id/dar-baixa', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const nota = await documentoSaidaRow(c.env.SHARE_DB, c.req.param('id'))
    if (!nota) return c.json({ error: 'nota_saida_nao_encontrada' }, 404)
    const contaId = String(nota.contas_areceber_id ?? '').trim()
    if (!contaId) return c.json({ error: 'conta_a_receber_nao_vinculada' }, 409)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const dataPagamento = body.data_pagamento ?? body.data_recebimento
    const contaBancaria = body.conta_bancaria_id ?? body.conta_bancaria ?? body.banco_recebimento
    const cotista = await c.env.SHARE_DB.prepare('SELECT ca.socio_id, hs.holding_id FROM cotista_aeronave ca LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE ca.id = ?').bind(nota.cotista_id).first<{ socio_id: string | null; holding_id: string | null }>()
    const holdingSaida = Boolean(cotista?.socio_id)
    const saidaPagamento = String(body.saida_pagamento ?? '').trim().toUpperCase()
    if (holdingSaida && !['DGA_BRADESCO', 'CONTA_COTISTA'].includes(saidaPagamento)) {
      return c.json({ error: 'saida_pagamento_obrigatoria' }, 400)
    }
    const pagamentos = Array.isArray(body.pagamentos) && body.pagamentos.length
      ? body.pagamentos.map((pagamento) => ({ ...pagamento, saida_pagamento: pagamento.saida_pagamento ?? (holdingSaida ? saidaPagamento : null) }))
      : [{
          idempotency_key: body.idempotency_key,
          tipo_pagador: holdingSaida && saidaPagamento === 'DGA_BRADESCO' ? 'HOLDING' : 'COTISTA',
          pagador_cotista_id: holdingSaida && saidaPagamento === 'DGA_BRADESCO' ? null : nota.cotista_id,
          pagador_holding_id: holdingSaida && saidaPagamento === 'DGA_BRADESCO' ? cotista?.holding_id ?? null : null,
          saida_pagamento: holdingSaida ? saidaPagamento : null,
          valor_centavos: Math.round(Number(nota.valor_total ?? 0) * 100),
          data_pagamento: dataPagamento,
          conta_bancaria_id: contaBancaria,
          forma_pagamento: body.forma_pagamento,
          comprovante_url: body.comprovante_url,
        }] as Record<string, unknown>[]
    const conta = await settleReceivable(c.env.SHARE_DB, contaId, {
      data_recebimento: dataPagamento,
      conta_bancaria_id: contaBancaria,
      forma_pagamento: body.forma_pagamento,
      comprovante_url: body.comprovante_url,
      pagamentos,
    }, c.get('userId') || null)
    return c.json({ ok: true, conta })
  } catch (error) { return errorResponse(c, error) }
})

notasSaidaRoutes.post('/notas-saida/anexos', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const bucket = c.env.SHARE_FILES || c.env.FILES
    if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
    const form = await c.req.parseBody()
    const arquivo = form.arquivo
    if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    const origem = String(form.origem ?? 'nota_fiscal_saida')
    if (!['nota_fiscal_saida', 'recibo_saida', 'lancamento'].includes(origem)) return c.json({ error: 'origem_invalida' }, 400)
    const tipoArquivo = arquivo.type.toLowerCase().split(';')[0].trim()
    if (origem === 'lancamento' && tipoArquivo !== 'application/pdf' && !tiposImagemLancamentoPermitidos.has(tipoArquivo)) return c.json({ error: 'formato_de_anexo_nao_permitido' }, 415)
    if (arquivo.size > 20 * 1024 * 1024) return c.json({ error: 'arquivo_maior_que_20_mb' }, 413)
    let conteudoPdf: ArrayBuffer | null = null
    if (origem === 'lancamento' && tipoArquivo === 'application/pdf') {
      conteudoPdf = await arquivo.arrayBuffer()
      const assinatura = new TextDecoder().decode(new Uint8Array(conteudoPdf, 0, Math.min(5, conteudoPdf.byteLength)))
      if (!assinatura.startsWith('%PDF-')) return c.json({ error: 'conteudo_pdf_invalido' }, 415)
    }
    const documentoId = String(form.documento_id ?? '').trim() || crypto.randomUUID()
    const prefixo = origem === 'recibo_saida' ? 'recibo_saida' : origem === 'lancamento' ? 'lancamento' : 'nota_fiscal_saida'
    const id = crypto.randomUUID()
    const key = `share/${prefixo}/${documentoId}/${id}-${arquivo.name}`
    await bucket.put(key, conteudoPdf ?? await arquivo.arrayBuffer(), { httpMetadata: { contentType: arquivo.type || 'application/octet-stream' } })
    const publicBase = String(c.env.R2_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
    const url = origem !== 'lancamento' && publicBase
      ? `${publicBase}/${key.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
      : `/api/financeiro/notas-saida/anexos/${id}/arquivo?key=${encodeURIComponent(key)}`
    return c.json({ id, url }, 201)
  } catch (error) { return errorResponse(c, error) }
})

notasSaidaRoutes.get('/notas-saida/anexos/:id/arquivo', async (c) => {
  const denied = await requireCaixaShareAccess(c); if (denied) return denied
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const key = c.req.query('key')
  if (!key) return c.notFound()
  const object = await bucket.get(key)
  if (!object) return c.notFound()
  return c.body(await object.arrayBuffer(), 200, { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' })
})
