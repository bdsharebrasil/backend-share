import { Hono } from 'hono'
import {
  createExpense,
  createReimbursement,
  enqueueFinance,
  FinanceError,
  issueRevenue,
  emitirReciboReembolso,
  finalizarRecibo,
  emitirReciboColaborador,
  emitirReciboPagamento,
  emitirReciboSaida,
  programarReciboReembolso,
  processFinanceQueue,
  settlePayable,
  settleReceivable,
  validateFinanceSchema,
} from './financeiro/FinanceiroKernel'
import { createPaymentRequest, convertPaymentRequest, validatePaymentRequest } from './financeiro/paymentAgents'

type Bindings = {
  SHARE_DB: D1Database
  FILES?: R2Bucket
  SHARE_FILES?: R2Bucket
  R2_PUBLIC_URL?: string
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

function storage(c: any): R2Bucket | undefined {
  return c.env.SHARE_FILES || c.env.FILES
}

async function listar(db: D1Database, sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
  const statement = db.prepare(sql)
  const result = params.length
    ? await statement.bind(...params).all<Record<string, unknown>>()
    : await statement.all<Record<string, unknown>>()
  return result.results ?? []
}

const CONFIG_TABLES = {
  fornecedores: 'fornecedores_favoritos',
  contas_bancarias: 'contas_bancarias',
  categorias_share: 'categoria_movimentacao_share',
  categorias_cliente: 'categoria_movimentacao_cliente',
} as const
const configId = () => crypto.randomUUID()
const configText = (value: unknown, fallback = '') => String(value ?? fallback).trim()

financeiroRoutes.get('/configuracoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [fornecedores, contas, categoriasShare, categoriasCliente] = await Promise.all([
      listar(db, 'SELECT * FROM fornecedores_favoritos ORDER BY COALESCE(apelido, nome_completo) COLLATE NOCASE'),
      listar(db, 'SELECT * FROM contas_bancarias ORDER BY banco COLLATE NOCASE, nome COLLATE NOCASE'),
      listar(db, 'SELECT * FROM categoria_movimentacao_share ORDER BY nome COLLATE NOCASE'),
      listar(db, 'SELECT * FROM categoria_movimentacao_cliente ORDER BY nome COLLATE NOCASE'),
    ])
    return c.json({ fornecedores, contas_bancarias: contas, categorias_share: categoriasShare, categorias_cliente: categoriasCliente })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/configuracoes/:tipo', async (c) => {
  try {
    const table = CONFIG_TABLES[c.req.param('tipo') as keyof typeof CONFIG_TABLES]
    if (!table) return c.json({ error: 'tipo_configuracao_invalido' }, 400)
    const body = await c.req.json<Record<string, unknown>>()
    const id = configText(body.id) || configId()
    const userId = c.get('userId') || null
    let columns: string[]; let values: unknown[]
    if (table === 'fornecedores_favoritos') {
      const nome = configText(body.nome_completo ?? body.nome)
      if (!nome) return c.json({ error: 'nome_fornecedor_obrigatorio' }, 400)
      columns = ['id','nome_completo','apelido','documento','telefone','endereco','cidade','uf','pessoa_contato','categoria_fornecedor']
      values = [id, nome, configText(body.apelido) || null, configText(body.documento) || null, configText(body.telefone) || null, configText(body.endereco) || null, configText(body.cidade) || null, configText(body.uf) || null, configText(body.pessoa_contato) || null, configText(body.categoria_fornecedor, 'nenhum')]
    } else if (table === 'contas_bancarias') {
      const banco = configText(body.banco); const nome = configText(body.nome || body.razao_social, banco)
      if (!banco || !nome) return c.json({ error: 'banco_e_nome_obrigatorios' }, 400)
      columns = ['id','razao_social','cnpj','chave_pix','nome','banco','numero_conta','tipo_caixa','cliente_id','holding_id','ativo']
      values = [id, configText(body.razao_social, nome), configText(body.cnpj, 'NAO_INFORMADO'), configText(body.chave_pix, 'NAO_INFORMADO'), nome, banco, configText(body.numero_conta) || null, configText(body.tipo_caixa, 'SHARE').toUpperCase(), configText(body.cliente_id) || null, configText(body.holding_id) || null, body.ativo === false ? 0 : 1]
    } else if (table === 'categoria_movimentacao_share') {
      const nome = configText(body.nome)
      if (!nome) return c.json({ error: 'nome_categoria_obrigatorio' }, 400)
      columns = ['id','nome','tipo','grupo_categoria','tipo_despesa','reembolsavel','categoria_cliente_id','criado_por']
      values = [id, nome, configText(body.tipo).toLowerCase() || null, configText(body.grupo_categoria) || null, configText(body.tipo_despesa) || null, body.reembolsavel ? 1 : 0, configText(body.categoria_cliente_id) || null, userId]
    } else {
      const nome = configText(body.nome)
      if (!nome) return c.json({ error: 'nome_categoria_obrigatorio' }, 400)
      columns = ['id','nome','subcategoria_1','subcategoria_2','subcategoria_3','subcategoria_4']
      values = [id, nome, configText(body.subcategoria_1) || null, configText(body.subcategoria_2) || null, configText(body.subcategoria_3) || null, configText(body.subcategoria_4) || null]
    }
    const placeholders = columns.map(() => '?').join(', ')
    await c.env.SHARE_DB.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map((column) => `${column} = excluded.${column}`).join(', ')}`).bind(...values).run()
    const saved = await c.env.SHARE_DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first()
    return c.json({ item: saved }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.delete('/configuracoes/:tipo/:id', async (c) => {
  try {
    const table = CONFIG_TABLES[c.req.param('tipo') as keyof typeof CONFIG_TABLES]
    if (!table) return c.json({ error: 'tipo_configuracao_invalido' }, 400)
    const result = await c.env.SHARE_DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(c.req.param('id')).run()
    if (!result.meta.changes) return c.json({ error: 'configuracao_nao_encontrada' }, 404)
    return c.json({ ok: true })
  } catch (error) { return errorResponse(c, error) }
})

async function alocarNumeroReciboSaida(db: D1Database, cotistaId: string, dataEmissao: string, codigoInformado?: unknown): Promise<string> {
  const cotista = await db.prepare(`
    SELECT COALESCE(ca.codigo_cliente, cl.codigo_cliente, 'CLI') AS codigo_cliente
    FROM cotista_aeronave ca
    LEFT JOIN cliente cl ON cl.id = ca.cliente_id
    WHERE ca.id = ?
    LIMIT 1
  `).bind(cotistaId).first<{ codigo_cliente: string | null }>()
  const codigo = String(codigoInformado ?? cotista?.codigo_cliente ?? 'CLI').trim().toUpperCase() || 'CLI'
  const anoCompleto = dataEmissao.slice(0, 4)
  const anoCurto = anoCompleto.slice(-2)
  const anoCadastrado = await db.prepare('SELECT ano FROM sequencia_numeros_recibo_saida WHERE codigo_cliente = ? AND ano IN (?, ?) ORDER BY CASE WHEN ano = ? THEN 0 ELSE 1 END LIMIT 1').bind(codigo, anoCompleto, anoCurto, anoCompleto).first<{ ano: string }>()
  const ano = anoCadastrado?.ano ?? anoCompleto
  const existentes = await listar(db, 'SELECT numero_recibo FROM recibos_saida WHERE numero_recibo LIKE ?', `REC-${codigo}%/${anoCurto}`)
  const maiorExistente = existentes.reduce((maior, row) => {
    const match = String(row.numero_recibo ?? '').match(new RegExp(`^REC-${codigo}(\\d+)/${anoCurto}$`))
    return Math.max(maior, match ? Number(match[1]) : 0)
  }, 0)
  const proximoNumero = Math.max(maiorExistente + 1, 101)
  const sequencia = await db.prepare(`
    INSERT INTO sequencia_numeros_recibo_saida (id, cotista_aeronave_id, codigo_cliente, ano, proximo_numero)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(codigo_cliente, ano) DO UPDATE SET proximo_numero = ?
    RETURNING proximo_numero - 1 AS numero
  `).bind(crypto.randomUUID(), cotistaId, codigo, ano, proximoNumero, proximoNumero).first<{ numero: number }>()
  if (!sequencia) throw new Error('falha_ao_gerar_sequencia_recibo_saida')
  return `REC-${codigo}${String(sequencia.numero).padStart(3, '0')}/${anoCurto}`
}

async function enriquecerFornecedores(db: D1Database, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (!rows.length) return rows
  const cotistaIds = [...new Set(rows.map((row) => String(row.cotista_aeronave_id ?? row.cotista_id ?? '').trim()).filter(Boolean))]
  const fornecedorIds = [...new Set(rows.map((row) => String(row.fornecedor_id ?? row.fornecedores_favoritos_id ?? '').trim()).filter(Boolean))]
  const porCotista = new Map<string, string>()
  const porFornecedor = new Map<string, string>()
  if (cotistaIds.length) {
    const placeholders = cotistaIds.map(() => '?').join(', ')
    const cotistas = await listar(db, `SELECT ca.id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome
      FROM cotista_aeronave ca
      LEFT JOIN cliente cl ON cl.id = ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
      WHERE ca.id IN (${placeholders})`, ...cotistaIds)
    cotistas.forEach((row) => { if (row.id && row.nome) porCotista.set(String(row.id), String(row.nome)) })
  }
  if (fornecedorIds.length) {
    const placeholders = fornecedorIds.map(() => '?').join(', ')
    const fornecedores = await listar(db, `SELECT id, nome_completo FROM fornecedores_favoritos WHERE id IN (${placeholders})`, ...fornecedorIds)
    fornecedores.forEach((row) => { if (row.id && row.nome_completo) porFornecedor.set(String(row.id), String(row.nome_completo)) })
  }
  return rows.map((row) => {
    const fornecedorId = String(row.fornecedor_id ?? row.fornecedores_favoritos_id ?? '').trim()
    const cotistaId = String(row.cotista_aeronave_id ?? row.cotista_id ?? '').trim()
    const fornecedorNome = row.fornecedor_nome ?? row.fornecedor ?? porFornecedor.get(fornecedorId) ?? porCotista.get(cotistaId) ?? null
    return { ...row, fornecedor_id: row.fornecedor_id ?? row.fornecedores_favoritos_id ?? null, fornecedor_nome: fornecedorNome }
  })
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
    fornecedorId: row.fornecedor_id ?? row.fornecedores_favoritos_id ?? null,
    fornecedor: row.fornecedor_nome ?? row.fornecedor ?? null,
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
  const rowsComFornecedor = await enriquecerFornecedores(c.env.SHARE_DB, rows)
  const mapped = rowsComFornecedor.map(mapConta)
  if (table !== 'contas_areceber') return mapped
  return Promise.all(mapped.map(async (conta) => ({
    ...conta,
    rateios: await listar(c.env.SHARE_DB,
      'SELECT id, cotista_id, valor_rateado_centavos, valor_pago_real_centavos, status FROM rateio_despesas WHERE lancamento_id = ? ORDER BY rowid',
      conta.lancamentoId,
    ),
  })))
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

financeiroRoutes.get('/recibos-saida', async (c) => {
  try {
    const rows = await listar(c.env.SHARE_DB, 'SELECT * FROM recibos_saida ORDER BY date(data_emissao) DESC, criado_em DESC LIMIT 500')
    return c.json({ recibos: rows })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos-saida', async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>()
    const cotistaId = String(body.cotista_aeronave_id ?? body.cotista_id ?? '').trim()
    const aeronaveId = String(body.aeronave_id ?? '').trim()
    const valor = Number(body.valor_total ?? body.valor ?? 0)
    const dataEmissao = String(body.data_emissao ?? '').trim()
    const dataVencimento = String(body.data_vencimento ?? dataEmissao).trim()
    const descricao = String(body.descricao_servico ?? body.descricao ?? '').trim()
    if (!cotistaId || !aeronaveId || !(valor > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(dataEmissao) || !descricao) {
      return c.json({ error: 'cotista_aeronave_id, aeronave_id, valor_total, data_emissao e descricao_servico são obrigatórios' }, 400)
    }
    const id = crypto.randomUUID()
    const numero = await alocarNumeroReciboSaida(c.env.SHARE_DB, cotistaId, dataEmissao, body.codigo_cliente)
    const categoriaInformada = String(body.categoria_receita_id ?? body.categoria_id ?? '').trim()
    const categoriaExiste = categoriaInformada
      ? Boolean(await c.env.SHARE_DB.prepare('SELECT id FROM categoria_movimentacao_share WHERE id = ?').bind(categoriaInformada).first())
      : false
    const financeiro = await issueRevenue(c.env.SHARE_DB, {
      idempotency_key: `recibo_saida:${id}`,
      valor_centavos: Math.round(valor * 100), descricao,
      data_emissao: dataEmissao, data_vencimento: dataVencimento,
      aeronave_id: aeronaveId, cotista_aeronave_id: cotistaId,
      categoria_id: categoriaExiste ? categoriaInformada : null,
      categoria_cliente_id: body.categoria_cliente_id ?? body.categoria_despesa_id ?? null,
      categoria_cliente_nome: body.categoria_cliente_nome ?? body.categoria_despesa_subcategoria ?? null,
      categoria_nome: body.categoria_receita_nome ?? body.nome_categoria,
      numero_recibo: numero,
      origem_tipo: 'RECIBO_SAIDA', origem_id: id,
      periodicidade: 'MENSAL',
    }, c.get('userId') || null)
    if (financeiro.lancamentoClienteId) {
      await c.env.SHARE_DB.prepare(`
        UPDATE rateio_despesas
        SET percentual_sociedade = COALESCE((SELECT percentual_sociedade FROM cotista_aeronave WHERE id = ?), 100),
            percentual_uso = 100,
            periodicidade = 'MENSAL',
            valor_pago_real_centavos = 0,
            status = 'AGUARDANDO_REEMBOLSO',
            atualizado_em = CURRENT_TIMESTAMP
        WHERE lancamento_id = ?
      `).bind(cotistaId, financeiro.lancamentoClienteId).run()
    }
    await c.env.SHARE_DB.prepare(`INSERT INTO recibos_saida
      (id, numero_recibo, cotista_id, aeronave_id, valor_total, percentual, descricao_servico,
       nome_categoria, categoria_id, subcategoria_1, data_emissao, data_vencimento,
       status, contas_areceber_id, lancamentos_id, criado_por)
      VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?, ?, ?, ?, 'EM_ABERTO', ?, ?, ?)`)
      .bind(id, numero, cotistaId, aeronaveId, valor, descricao,
        body.categoria_receita_nome ?? body.nome_categoria ?? null,
        categoriaExiste ? categoriaInformada : null,
        body.categoria_despesa_subcategoria ?? null, dataEmissao, dataVencimento,
        financeiro.contaReceberId ?? null, financeiro.id ?? financeiro.lancamento_id ?? null, c.get('userId') || null).run()
    if (financeiro.contaReceberId) {
      await c.env.SHARE_DB.prepare('UPDATE contas_areceber SET recibos_saida_id = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(id, financeiro.contaReceberId).run()
    }
    const recibo = await c.env.SHARE_DB.prepare('SELECT * FROM recibos_saida WHERE id = ?').bind(id).first()
    return c.json({ recibo }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.patch('/recibos-saida/:id', async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>()
    const pdfUrl = String(body.pdf_url ?? '').trim()
    if (!pdfUrl) return c.json({ error: 'pdf_url_obrigatorio' }, 400)
    const result = await c.env.SHARE_DB.prepare('UPDATE recibos_saida SET pdf_url = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(pdfUrl, c.req.param('id')).run()
    if (!result.meta.changes) return c.json({ error: 'recibo_saida_nao_encontrado' }, 404)
    const recibo = await c.env.SHARE_DB.prepare('SELECT numero_recibo, lancamentos_id FROM recibos_saida WHERE id = ?').bind(c.req.param('id')).first<{ numero_recibo: string | null; lancamentos_id: string | null }>()
    const principalId = String(recibo?.lancamentos_id ?? '').trim()
    const principal = principalId ? await c.env.SHARE_DB.prepare('SELECT id FROM lancamentos WHERE id = ?').bind(principalId).first<{ id: string }>() : null
    const cliente = principal ? await c.env.SHARE_DB.prepare('SELECT id FROM lancamentos WHERE origem_id = ? AND tipo_caixa = ? LIMIT 1').bind(principal.id, 'CLIENTE').first<{ id: string }>() : null
    const ids = [principal?.id, cliente?.id].filter((id): id is string => Boolean(id))
    for (const lancamentoId of ids) {
      await c.env.SHARE_DB.prepare(`UPDATE lancamentos SET numero_recibo = ?, url_recibo = ?, origem_tipo = CASE WHEN tipo_caixa = 'CLIENTE' THEN 'RECIBO_SAIDA' ELSE origem_tipo END, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(recibo?.numero_recibo ?? null, pdfUrl, lancamentoId).run()
      await c.env.SHARE_DB.prepare('UPDATE rateio_despesas SET numero_recibo = ?, recibo_url = ? WHERE lancamento_id = ?').bind(recibo?.numero_recibo ?? null, pdfUrl, lancamentoId).run().catch(() => undefined)
    }
    const reciboAtualizado = await c.env.SHARE_DB.prepare('SELECT * FROM recibos_saida WHERE id = ?').bind(c.req.param('id')).first()
    return c.json({ recibo: reciboAtualizado })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.delete('/recibos-saida/:id', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const reciboId = c.req.param('id')
    const recibo = await db.prepare('SELECT * FROM recibos_saida WHERE id = ?').bind(reciboId).first<Record<string, unknown>>()
    if (!recibo) return c.json({ error: 'recibo_saida_nao_encontrado' }, 404)

    const contaId = String(recibo.contas_areceber_id ?? '').trim()
    const reciboLancamentoId = String(recibo.lancamentos_id ?? '').trim()
    const conta = contaId
      ? await db.prepare('SELECT lancamentos_id, movimentos_id FROM contas_areceber WHERE id = ?').bind(contaId).first<{ lancamentos_id: string | null; movimentos_id: string | null }>()
      : null
    const lancamentoIds = [...new Set([reciboLancamentoId, conta?.lancamentos_id ?? ''].filter(Boolean))]
    const movimentoIds = [...new Set([conta?.movimentos_id ?? '', reciboLancamentoId].filter(Boolean))]
    if (reciboLancamentoId) {
      const espelho = await listar(db, 'SELECT id FROM lancamentos WHERE origem_id = ?', reciboLancamentoId)
      lancamentoIds.push(...espelho.map((row) => String(row.id)).filter(Boolean))
    }
    const ids = [...new Set(lancamentoIds)]
    const movimentos = [...new Set(movimentoIds)]
    const placeholders = ids.map(() => '?').join(', ')
    const movimentoPlaceholders = movimentos.map(() => '?').join(', ')
    const rateioIds = ids.length
      ? (await listar(db, `SELECT id FROM rateio_despesas WHERE lancamento_id IN (${placeholders})`, ...ids)).map((row) => String(row.id)).filter(Boolean)
      : []

    const statements: D1PreparedStatement[] = []
    if (ids.length) statements.push(db.prepare(`DELETE FROM financeiro_vinculos WHERE (origem_id IN (${placeholders}) OR destino_id IN (${placeholders}) OR origem_id = ? OR destino_id = ?)`).bind(...ids, ...ids, reciboId, reciboId))
    else statements.push(db.prepare('DELETE FROM financeiro_vinculos WHERE origem_id = ? OR destino_id = ?').bind(reciboId, reciboId))
    if (rateioIds.length) {
      const rateioPlaceholders = rateioIds.map(() => '?').join(', ')
      statements.push(db.prepare(`DELETE FROM rateio_pagamentos WHERE rateio_id IN (${rateioPlaceholders})`).bind(...rateioIds))
    }
    if (ids.length) statements.push(db.prepare(`DELETE FROM rateio_despesas WHERE lancamento_id IN (${placeholders})`).bind(...ids))
    if (movimentos.length) statements.push(db.prepare(`DELETE FROM rateio_hold WHERE movimento_holding_id IN (${movimentoPlaceholders})`).bind(...movimentos))
    if (contaId) statements.push(db.prepare('UPDATE contas_areceber SET recibos_saida_id = NULL WHERE id = ?').bind(contaId))
    if (contaId) statements.push(db.prepare('DELETE FROM contas_areceber WHERE id = ?').bind(contaId))
    statements.push(db.prepare('DELETE FROM recibos_saida WHERE id = ?').bind(reciboId))
    if (ids.length) statements.push(db.prepare(`DELETE FROM lancamentos WHERE id IN (${placeholders})`).bind(...ids))
    if (movimentos.length) statements.push(db.prepare(`DELETE FROM movimentos_holding WHERE id IN (${movimentoPlaceholders})`).bind(...movimentos))
    await db.batch(statements)

    const pdfUrl = String(recibo.pdf_url ?? '')
    if (pdfUrl) {
      try {
        const parsed = new URL(pdfUrl)
        const key = parsed.searchParams.get('key') || decodeURIComponent(parsed.pathname.replace(/^\//, ''))
        if (key) await storage(c)?.delete(key)
      } catch (error) {
        console.warn('[financeiro] não foi possível excluir o PDF do recibo:', error)
      }
    }
    return c.json({ ok: true, id: reciboId })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos-saida/:id/dar-baixa', async (c) => {
  try {
    const reciboId = c.req.param('id')
    const recibo = await c.env.SHARE_DB.prepare('SELECT contas_areceber_id FROM recibos_saida WHERE id = ?').bind(reciboId).first<{ contas_areceber_id: string | null }>()
    if (!recibo) return c.json({ error: 'recibo_saida_nao_encontrado' }, 404)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const contaId = String(recibo.contas_areceber_id ?? '').trim()
    if (!contaId) return c.json({ error: 'conta_a_receber_nao_vinculada' }, 409)
    const result = await settleReceivable(c.env.SHARE_DB, contaId, {
      data_recebimento: body.data_recebimento ?? body.data_pagamento ?? body.dataRecebimento,
      conta_bancaria_id: body.conta_bancaria_id ?? body.conta_bancaria ?? body.bancoRecebimento,
      forma_pagamento: body.forma_pagamento ?? body.formaPagamento,
      comprovante_url: body.comprovante_url ?? body.comprovanteRecebimentoUrl,
      pagamentos: body.pagamentos,
    }, c.get('userId') || null)
    return c.json({ ok: true, conta: result })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/lancamentos/opcoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const opcional = async (sql: string) => (await db.prepare(sql).all().catch(() => ({ results: [] }))).results ?? []
    const [categorias, contas, cotistas, holdings] = await Promise.all([
      opcional('SELECT id, nome, grupo_categoria, tipo_despesa FROM categoria_movimentacao_share ORDER BY nome'),
      opcional('SELECT id, banco, numero_conta, tipo_conta FROM contas_bancarias ORDER BY banco'),
      opcional("SELECT ca.id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome, ca.aeronave_id, ca.percentual_sociedade FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id ORDER BY nome"),
      opcional('SELECT id, nome, conta_bancaria FROM holdings ORDER BY nome'),
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
    if (inicio) { filtros.push('date(COALESCE(data_emissao, criado_em)) >= date(?)'); params.push(inicio) }
    if (fim) { filtros.push('date(COALESCE(data_emissao, criado_em)) <= date(?)'); params.push(fim) }
    if (caixa) { filtros.push('tipo_caixa = ?'); params.push(caixa.toUpperCase()) }
    const rows = await listar(c.env.SHARE_DB, `SELECT * FROM lancamentos${filtros.length ? ` WHERE ${filtros.join(' AND ')}` : ''} ORDER BY date(COALESCE(data_emissao, criado_em)) DESC, criado_em DESC LIMIT 500`, ...params)
    return c.json({ lancamentos: await enriquecerFornecedores(c.env.SHARE_DB, rows) })
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

financeiroRoutes.post('/notas-saida/anexos', async (c) => {
  try {
    const bucket = storage(c)
    if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
    const form = await c.req.parseBody()
    const arquivo = form.arquivo
    if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    const origem = String(form.origem ?? 'nota_fiscal_saida')
    const documentoId = String(form.documento_id ?? '').trim() || crypto.randomUUID()
    const prefixo = origem === 'recibo_saida' ? 'recibo_saida' : 'nota_fiscal_saida'
    const id = crypto.randomUUID()
    const key = `share/${prefixo}/${documentoId}/${id}-${arquivo.name}`
    await bucket.put(key, await arquivo.arrayBuffer(), { httpMetadata: { contentType: arquivo.type || 'application/octet-stream' } })
    const publicBase = String(c.env.R2_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
    const url = publicBase
      ? `${publicBase}/${key.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
      : `/api/financeiro/notas-saida/anexos/${id}/arquivo?key=${encodeURIComponent(key)}`
    return c.json({ id, url }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/notas-saida/anexos/:id/arquivo', async (c) => {
  const bucket = storage(c)
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const key = c.req.query('key')
  if (!key) return c.notFound()
  const object = await bucket.get(key)
  if (!object) return c.notFound()
  return c.body(await object.arrayBuffer(), 200, { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' })
})

financeiroRoutes.get('/dashboard/financeiro', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [receber, pagar, movimentacoes] = await Promise.all([
      listar(db, "SELECT valor_centavos, status FROM contas_areceber WHERE status <> 'CANCELADO'"),
      listar(db, "SELECT valor_centavos, status FROM contas_apagar WHERE status <> 'CANCELADO'"),
      listar(db, 'SELECT * FROM lancamentos ORDER BY criado_em DESC LIMIT 100'),
    ])
    const totalAReceber = receber.reduce((total, row) => total + Number(row.valor_centavos || 0) / 100, 0)
    const totalPago = pagar.filter((row) => row.status === 'PAGO').reduce((total, row) => total + Number(row.valor_centavos || 0) / 100, 0)
    const movimentacoesComFornecedor = await enriquecerFornecedores(db, movimentacoes)
    return c.json({ resumo: { total_a_receber: totalAReceber, total_pago: totalPago, pendencias: pagar.filter((row) => row.status === 'EM_ABERTO').length, pagamentos_confirmados: pagar.filter((row) => row.status === 'PAGO').length }, movimentacoes: movimentacoesComFornecedor.map((row) => ({ ...row, fornecedor: row.fornecedor_nome ?? row.fornecedor ?? null, valor: Number(row.valor_centavos || 0) / 100 })) })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/cotista/dashboard', async (c) => {
  try {
    const rows = await listar(c.env.SHARE_DB, `
      SELECT id, data_emissao AS data, descricao_despesa AS descricao,
             NULL AS numero_doc, fornecedor_id, categoria_nome, NULL AS grupo_categoria,
             data_vencimento, 'SAIDA' AS fluxo, valor_rateado_centavos AS valor_centavos,
             pago_por_cotista_id AS pago_por, 'CLIENTE' AS tipo_caixa,
             pago_diretamente, 0 AS reembolsavel, 0 AS reembolso_quitado,
             status, observacoes, 'rateio_despesas' AS origem_rateio
        FROM rateio_despesas
      UNION ALL
      SELECT id, data_emissao AS data, descricao_despesa AS descricao,
              NULL AS numero_doc, NULL AS fornecedor_id, categoria_nome, NULL AS grupo_categoria,
             data_vencimento, 'SAIDA' AS fluxo, valor_rateado_centavos AS valor_centavos,
             pago_por_socio_id AS pago_por, 'HOLDING' AS tipo_caixa,
             pago_diretamente, 0 AS reembolsavel, 0 AS reembolso_quitado,
             status, observacoes, 'rateio_hold' AS origem_rateio
        FROM rateio_hold
      ORDER BY data DESC, id DESC
       LIMIT 500
    `)
    const lancamentos = rows.map((row) => ({ id: row.id, data: row.data, descricao: row.descricao, documento: row.numero_doc ?? null, fornecedor: row.fornecedor_id ?? null, categoria: row.categoria_nome ?? 'SEM CATEGORIA', grupoCategoria: row.grupo_categoria ?? '', tipo: row.origem_rateio ?? null, prazo: row.data_vencimento ?? null, fluxo: 'SAIDA', valorCentavos: Number(row.valor_centavos || 0), pagoPor: row.pago_por ?? '', caixa: row.tipo_caixa ?? 'SHARE', pagoDiretamente: Boolean(row.pago_diretamente), reembolsavel: Boolean(row.reembolsavel), reembolsoQuitado: Boolean(row.reembolso_quitado), status: row.status ?? 'EM_ABERTO', observacoes: row.observacoes ?? null, rateios: [] }))
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
    const body = await c.req.json<Record<string, unknown>>()
    const handlers: Record<string, (db: D1Database, body: Record<string, unknown>, userId: string | null) => Promise<Record<string, unknown>>> = {
      recibo_reembolso: emitirReciboReembolso,
      recibo_colaborador: emitirReciboColaborador,
      recibo_pagamento: emitirReciboPagamento,
      recibo_saida: emitirReciboSaida,
    }
    const tipo = String(body.tipo_recibo ?? '')
    const handler = handlers[tipo]
    if (!handler) return c.json({ error: 'tipo_recibo_invalido', message: 'Tipo de recibo não suportado' }, 400)
    const result = await handler(c.env.SHARE_DB, body, c.get('userId') || null)
    return c.json(result, 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.get('/recibos', async (c) => {
  const db = c.env.SHARE_DB
  const status = c.req.query('status')
  const result = status
    ? await db.prepare('SELECT * FROM recibos WHERE status = ? ORDER BY criado_em DESC LIMIT 200').bind(status).all<Record<string, unknown>>()
    : await db.prepare('SELECT * FROM recibos ORDER BY criado_em DESC LIMIT 200').all<Record<string, unknown>>()
  const recibos = result.results ?? []
  const cotistaIds = [...new Set(recibos.filter((row) => row.pagador_tipo === 'cotista_aeronave').map((row) => String(row.pagador_id ?? '')).filter(Boolean))]
  const reciboIds = recibos.map((row) => String(row.id ?? '')).filter(Boolean)
  const cotistas = cotistaIds.length
    ? await listar(db, `SELECT ca.id, ca.cliente_id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome, COALESCE(cl.cnpj, hs.cpf) AS documento, COALESCE(cl.endereco, hs.endereco) AS endereco, COALESCE(cl.cidade, hs.cidade) AS cidade, COALESCE(cl.uf, hs.uf) AS uf FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE ca.id IN (${cotistaIds.map(() => '?').join(', ')}) OR ca.cliente_id IN (${cotistaIds.map(() => '?').join(', ')})`, ...cotistaIds, ...cotistaIds)
    : []
  const cotistaPorId = new Map<string, Record<string, unknown>>()
  cotistas.forEach((row) => {
    for (const chave of [row.id, row.cliente_id]) {
      if (chave) cotistaPorId.set(String(chave), row)
    }
  })
  const rateios = reciboIds.length
    ? await listar(db, `SELECT rr.id, rr.recibo_id, rr.rateio_id, rr.percentual, rr.valor, rr.cotista_id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS cotista_nome FROM recibo_rateio rr LEFT JOIN cotista_aeronave ca ON ca.id = rr.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE rr.recibo_id IN (${reciboIds.map(() => '?').join(', ')}) ORDER BY rr.rowid`, ...reciboIds)
    : []
  const rateiosPorRecibo = new Map<string, Record<string, unknown>[]>()
  for (const rateio of rateios) {
    const lista = rateiosPorRecibo.get(String(rateio.recibo_id)) ?? []
    lista.push(rateio)
    rateiosPorRecibo.set(String(rateio.recibo_id), lista)
  }
  return c.json({ recibos: recibos.map((recibo) => {
    const cotista = cotistaPorId.get(String(recibo.pagador_id ?? ''))
    return {
      ...recibo,
      nome_pagador: recibo.pagador_tipo === 'cotista_aeronave' ? cotista?.nome ?? recibo.nome_pagador ?? null : 'Share Brasil',
      documento_pagador: recibo.pagador_tipo === 'cotista_aeronave' ? cotista?.documento ?? recibo.documento_pagador ?? null : recibo.documento_pagador ?? null,
      endereco_pagador: recibo.pagador_tipo === 'cotista_aeronave' ? cotista?.endereco ?? recibo.endereco_pagador ?? null : recibo.endereco_pagador ?? null,
      cidade_pagador: recibo.pagador_tipo === 'cotista_aeronave' ? cotista?.cidade ?? recibo.cidade_pagador ?? null : recibo.cidade_pagador ?? null,
      uf_pagador: recibo.pagador_tipo === 'cotista_aeronave' ? cotista?.uf ?? recibo.uf_pagador ?? null : recibo.uf_pagador ?? null,
      rateio_linhas: rateiosPorRecibo.get(String(recibo.id)) ?? [],
    }
  }) })
})

financeiroRoutes.get('/recibos/opcoes', async (c) => {
  const db = c.env.SHARE_DB
  const read = async (sql: string) => (await db.prepare(sql).all().catch(() => ({ results: [] }))).results ?? []
  const [clientes, colaboradores, freelancers, aeronaves, cotistas, categorias, categoriasCliente] = await Promise.all([
    read('SELECT id, razao_social, cnpj, endereco, cidade, uf, holding, status FROM cliente ORDER BY razao_social'),
    read("SELECT id, nome_completo, nome_exibicao, cpf, endereco, cidade, uf, email, telefone, canac, nome_banco, tipo_conta, conta_numero, agencia_numero, pix, 'user_profiles' AS origem FROM user_profiles ORDER BY nome_completo"),
    read("SELECT id, nome_completo, cpf, endereco, cidade, uf, telefone, canac, 'tripulacao_freelancer' AS origem FROM tripulacao_freelancer WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo"),
    read('SELECT id, matricula_registro, fabricante, modelo FROM aeronave ORDER BY matricula_registro'),
    read(`SELECT ca.id, ca.aeronave_id, ca.cliente_id, ca.socio_id, ca.codigo_cliente, ca.percentual_sociedade,
                 COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome,
                 cl.cnpj, hs.cpf,
                 COALESCE(cl.endereco, hs.endereco) AS endereco,
                 COALESCE(cl.cidade, hs.cidade) AS cidade,
                 COALESCE(cl.uf, hs.uf) AS uf
            FROM cotista_aeronave ca
            LEFT JOIN cliente cl ON cl.id = ca.cliente_id
            LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
           ORDER BY COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente), ca.codigo_cliente`),
    read('SELECT id, nome, grupo_categoria, tipo_despesa FROM categoria_movimentacao_share ORDER BY nome'),
    read('SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome'),
  ])
  const recebedores = [
    ...colaboradores.map((item: any) => ({ ...item, id: `perfil:${item.id}`, nome: item.nome_completo || item.nome_exibicao || item.email || '', tipo_user: item.tipo_user || 'colaborador' })),
    ...freelancers.map((item: any) => ({ ...item, id: `freelancer:${item.id}`, nome: item.nome_completo || '', tipo_user: 'freelancer' })),
  ].sort((a: any, b: any) => String(a.nome_completo || '').localeCompare(String(b.nome_completo || ''), 'pt-BR'))
  return c.json({ clientes, colaboradores, freelancers, aeronaves, cotistas, categorias, categorias_cliente: categoriasCliente, recebedores })
})

financeiroRoutes.patch('/recibos/:id/status', async (c) => {
  try {
    const body = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }))
    const status = String(body.status ?? '').toUpperCase()
    const permitidos = new Set(['ANEXO_PENDENTE', 'PDF_PENDENTE', 'EMAIL_ENVIADO', 'ERRO_ANEXO', 'ERRO_PDF'])
    if (!permitidos.has(status)) return c.json({ error: 'status_recibo_invalido' }, 400)
    const result = await c.env.SHARE_DB.prepare('UPDATE recibos SET status = ? WHERE id = ?').bind(status, c.req.param('id')).run()
    if (!result.meta.changes) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    return c.json({ ok: true, status })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/:id/programar-contas-apagar', async (c) => {
  try {
    const reciboId = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>()
    const receipt = await c.env.SHARE_DB.prepare(`SELECT id, lancamento_id, aeronave_id, tipo_caixa, status, valor, descricao, data_emissao, data_vencimento, categoria_movimentacao_id, grupo_categoria, url_recibo FROM recibos WHERE id = ?`).bind(reciboId).first<Record<string, unknown>>()
    if (!receipt) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    if (String(receipt.tipo_caixa).toLowerCase() !== 'share') return c.json({ error: 'recibo_deve_ser_do_caixa_share' }, 409)
    if (String(receipt.status).toUpperCase() !== 'EMAIL_ENVIADO') return c.json({ error: 'recibo_precisa_ser_enviado_por_email' }, 409)
    const lancamentoId = String(receipt.lancamento_id ?? '')
    if (!lancamentoId) return c.json({ error: 'lancamento_do_recibo_nao_encontrado' }, 409)
    const lancamento = await c.env.SHARE_DB.prepare(`SELECT id, status, tipo_caixa, valor_centavos FROM lancamentos WHERE id = ?`).bind(lancamentoId).first<Record<string, unknown>>()
    if (!lancamento || String(lancamento.tipo_caixa).toUpperCase() !== 'SHARE' || String(lancamento.status).toUpperCase() !== 'EM_ABERTO') return c.json({ error: 'lancamento_share_em_aberto_nao_encontrado' }, 409)
    const existing = await c.env.SHARE_DB.prepare(`SELECT id FROM contas_apagar WHERE lancamentos_id = ? AND status <> 'CANCELADO' LIMIT 1`).bind(lancamentoId).first<{ id: string }>()
    if (existing) return c.json({ ok: true, conta_pagar_id: existing.id, rateio_ids: [], idempotent: true })
    const aeronaveId = String(body.aeronave_id ?? receipt.aeronave_id ?? '').trim()
    const dataVencimento = String(body.data_vencimento ?? receipt.data_vencimento ?? receipt.data_emissao ?? '').trim()
    const tipoRateio = String(body.tipo_rateio ?? 'FIXO').toUpperCase()
    const periodicidade = body.periodicidade ? String(body.periodicidade) : 'ÚNICO'
    const linhas = Array.isArray(body.linhas) ? body.linhas as Array<Record<string, unknown>> : []
    const valorCentavos = Number(lancamento.valor_centavos ?? receipt.valor ?? 0)
    const percentualTotal = linhas.reduce((total, linha) => total + Number(linha.percentual_uso ?? 0), 0)
    if (!aeronaveId || !dataVencimento || !linhas.length || Math.abs(percentualTotal - 100) > 0.01 || !['FIXO', 'VARIAVEL_POR_VOO', 'VARIAVEL_POR_HORA', 'EXTRA'].includes(tipoRateio)) return c.json({ error: 'dados_de_rateio_invalidos' }, 400)
    const cotistaIds = linhas.map((linha) => String(linha.cotista_id ?? '').trim()).filter(Boolean)
    const cotistas = await listar(c.env.SHARE_DB, `SELECT id, aeronave_id, socio_id, percentual_sociedade FROM cotista_aeronave WHERE id IN (${cotistaIds.map(() => '?').join(',')})`, ...cotistaIds)
    if (cotistas.length !== cotistaIds.length || cotistas.some((cotista) => String(cotista.aeronave_id) !== aeronaveId)) return c.json({ error: 'cotistas_invalidos_para_aeronave' }, 400)
    const contaId = crypto.randomUUID()
    const rateioIds = linhas.map(() => crypto.randomUUID())
    const categoriaId = body.categoria_id ?? receipt.categoria_movimentacao_id ?? null
    const categoriaNome = body.categoria_nome ?? receipt.grupo_categoria ?? null
    const statements = [c.env.SHARE_DB.prepare(`INSERT INTO contas_apagar (id, data_vencimento, valor_centavos, categoria_id, categoria_nome, descricao, aeronave_id, lancamentos_id, nf_url, criado_por, origem_tipo, idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECIBO', ?, 'EM_ABERTO')`).bind(contaId, dataVencimento, valorCentavos, categoriaId, categoriaNome, receipt.descricao ?? 'Recibo', aeronaveId, lancamentoId, receipt.url_recibo ?? null, c.get('userId') || null, `recibo:${reciboId}`)]
    linhas.forEach((linha, index) => {
      const cotista = cotistas.find((item) => String(item.id) === String(linha.cotista_id))!
      const percentual = Number(linha.percentual_uso)
      const rateado = Math.round(valorCentavos * percentual / 100)
      const campos = String(cotista.socio_id ?? '').trim() ? `INSERT INTO rateio_hold (id, movimento_holding_id, aeronave_id, socio_id, data_emissao, data_vencimento, categoria_id, categoria_nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4, tipo_rateio, periodicidade, percentual_sociedade, percentual_uso, valor_total_centavos, valor_rateado_centavos, valor_pago_real_centavos, status, descricao_despesa, observacoes, origem_id, origem_tipo, documento_url) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'EM_ABERTO', ?, ?, ?, 'RECIBO', ?)` : `INSERT INTO rateio_despesas (id, lancamento_id, aeronave_id, cotista_id, data_emissao, data_vencimento, categoria_id, categoria_nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4, tipo_rateio, periodicidade, percentual_sociedade, percentual_uso, valor_total_centavos, valor_rateado_centavos, valor_pago_real_centavos, status, descricao_despesa, observacoes, origem_id, origem_tipo, documento_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'EM_ABERTO', ?, ?, ?, 'RECIBO', ?)`
      const parametros = String(cotista.socio_id ?? '').trim()
        ? [rateioIds[index], aeronaveId, cotista.socio_id, receipt.data_emissao, dataVencimento, categoriaId, categoriaNome, body.subcategoria_1 ?? null, body.subcategoria_2 ?? null, body.subcategoria_3 ?? null, body.subcategoria_4 ?? null, tipoRateio, periodicidade, Number(cotista.percentual_sociedade ?? 0), percentual, valorCentavos, rateado, receipt.descricao ?? 'Recibo', body.observacoes ?? null, reciboId, receipt.url_recibo ?? null]
        : [rateioIds[index], lancamentoId, aeronaveId, cotista.id, receipt.data_emissao, dataVencimento, categoriaId, categoriaNome, body.subcategoria_1 ?? null, body.subcategoria_2 ?? null, body.subcategoria_3 ?? null, body.subcategoria_4 ?? null, tipoRateio, periodicidade, Number(cotista.percentual_sociedade ?? 0), percentual, valorCentavos, rateado, receipt.descricao ?? 'Recibo', body.observacoes ?? null, reciboId, receipt.url_recibo ?? null]
      statements.push(c.env.SHARE_DB.prepare(campos).bind(...parametros))
    })
    await c.env.SHARE_DB.batch(statements)
    return c.json({ ok: true, conta_pagar_id: contaId, rateio_ids: rateioIds }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/:id/cancelar', async (c) => {
  await c.env.SHARE_DB.prepare("UPDATE recibos SET status = 'CANCELADO' WHERE id = ?").bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

financeiroRoutes.post('/recibos/:id/reembolso', async (c) => {
  try {
    const result = await programarReciboReembolso(
      c.env.SHARE_DB,
      c.req.param('id'),
      await c.req.json().catch(() => ({})),
      c.get('userId') || null,
    )
    return c.json({ ok: true, ...result }, result.idempotent ? 200 : 201)
  } catch (error) { return errorResponse(c, error) }
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
  const result = await c.env.SHARE_DB.prepare(`
    SELECT ca.id, ca.aeronave_id, ca.cliente_id, ca.socio_id, ca.codigo_cliente,
           ca.percentual_sociedade,
           COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, 'Cotista não identificado') AS nome,
           CASE WHEN ca.socio_id IS NOT NULL THEN 1 ELSE 0 END AS eh_holding
      FROM cotista_aeronave ca
      LEFT JOIN cliente cl ON cl.id = ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
     WHERE ca.aeronave_id = ?
     ORDER BY COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente)
  `).bind(c.req.param('id')).all()
  return c.json({ cotistas: result.results ?? [] })
})

financeiroRoutes.patch('/envios-pagamento/:id', async (c) => {
  const body: { status?: string } = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }))
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
    const bucket = storage(c)
    if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
    const form = await c.req.parseBody()
    const arquivo = form.arquivo
    if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    const reciboId = String(form.recibo_id || '')
    if (!reciboId) return c.json({ error: 'recibo_id_obrigatorio' }, 400)
    const id = crypto.randomUUID()
    const key = `recibos/${reciboId}/original/${id}-${arquivo.name}`
    await bucket.put(key, await arquivo.arrayBuffer(), { httpMetadata: { contentType: arquivo.type || 'application/octet-stream' } })
    await c.env.SHARE_DB.prepare('INSERT INTO recibo_anexos (id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, recibo_id, finalidade) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, arquivo.name, key, arquivo.type || 'application/octet-stream', arquivo.size, c.get('userId') || null, reciboId, 'ORIGINAL').run()
    return c.json({ id, url: `/api/financeiro/recibos/anexos/${id}/arquivo`, nome_arquivo: arquivo.name, tipo_arquivo: arquivo.type, tamanho_arquivo: arquivo.size }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/:id/pdf', async (c) => {
  try {
    await validateFinanceSchema(c.env.SHARE_DB)
    const bucket = storage(c)
    if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
    const form = await c.req.parseBody()
    const arquivo = form.arquivo
    if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    if (arquivo.size <= 0 || (arquivo.type && arquivo.type !== 'application/pdf')) return c.json({ error: 'arquivo_pdf_invalido' }, 400)
    const reciboId = c.req.param('id')
    const recibo = await c.env.SHARE_DB.prepare('SELECT status FROM recibos WHERE id = ?').bind(reciboId).first<{ status: string }>()
    if (!recibo) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    if (!['CRIADO', 'PDF_PENDENTE', 'ANEXO_PENDENTE', 'ERRO_ANEXO', 'ERRO_PDF'].includes(String(recibo.status).toUpperCase())) return c.json({ error: 'recibo_nao_aguarda_pdf', status_atual: recibo.status }, 409)
    const bytes = new Uint8Array(await arquivo.arrayBuffer())
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') return c.json({ error: 'conteudo_pdf_invalido' }, 400)
    const anexoId = crypto.randomUUID()
    const key = `share/recibos/recibos-gerados/${reciboId}.pdf`
    await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } })
    await c.env.SHARE_DB.prepare('INSERT INTO recibo_anexos (id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, recibo_id, finalidade) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(anexoId, arquivo.name || `${reciboId}.pdf`, key, 'application/pdf', arquivo.size, c.get('userId') || null, reciboId, 'PDF').run()
    const pdfUrl = `/api/financeiro/recibos/anexos/${anexoId}/arquivo`
    await c.env.SHARE_DB.prepare('UPDATE recibos SET url_recibo = ? WHERE id = ?').bind(pdfUrl, reciboId).run()
    const financeiro = await finalizarRecibo(c.env.SHARE_DB, reciboId, c.get('userId') || null)
    await c.env.SHARE_DB.prepare("UPDATE recibos SET status = 'EMITIDO' WHERE id = ?").bind(reciboId).run()
    return c.json({ anexo_id: anexoId, pdf_url: pdfUrl, ...financeiro }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/recibos/anexos/:id/arquivo', async (c) => {
  const bucket = storage(c)
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const row = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, tipo_arquivo FROM recibo_anexos WHERE id = ?').bind(c.req.param('id')).first<{ caminho_arquivo: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await bucket.get(row.caminho_arquivo)
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
