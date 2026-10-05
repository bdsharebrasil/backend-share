type Row = Record<string, unknown>

export type PaymentRequest = {
  tipo: 'share' | 'cliente' | 'reembolso'
  descricao: string
  valor_centavos: number
  // Valor total da despesa. Se maior que valor_centavos, o recibo cobre apenas
  // a parte de um cotista (cada um reembolsa a sua parte, sem ajuste).
  valor_total_despesa_centavos: number | null
  // Cotista que pagou (envio cliente direto) ou que devolve o total (reembolso).
  cotista_pagador_id: string | null
  data_despesa: string
  data_vencimento: string | null
  aeronave_id: string | null
  rateio_linhas: Array<{ cotista_id: string; percentual: number; percentual_sociedade: number; valor_centavos: number }>
  anexos: Array<{ id: string; tipo: string; numero: string; url: string | null; cotista_id?: string }>
  periodicidade: string | null
  tipo_rateio: string | null
  categoria_id: string
  categoria_cliente_id: string | null
  colaborador_id: string | null
  fornecedor_id: string | null
  fornecedor: string | null
  categoria_nome: string | null
  grupo_categoria: string | null
  subcategoria_1: string | null
  subcategoria_2: string | null
  subcategoria_3: string | null
  subcategoria_4: string | null
  observacoes: string | null
  abastecimento: Row | null
  idempotency_key: string
}

export function validatePaymentRequest(body: Row): PaymentRequest {
  const tipo = String(body.tipo ?? '').trim()
  const valor = Number(body.valor_centavos)
  const linhas = Array.isArray(body.rateio_linhas) ? body.rateio_linhas : []
  const anexos = Array.isArray(body.anexos) ? body.anexos : []
  const categoriaClienteId = body.categoria_cliente_id ? String(body.categoria_cliente_id) : null
  const abastecimento = body.abastecimento && typeof body.abastecimento === 'object' ? body.abastecimento as Row : null
  const totalInformado = body.valor_total_despesa_centavos == null || body.valor_total_despesa_centavos === ''
    ? null
    : Number(body.valor_total_despesa_centavos)
  if (!['share', 'cliente', 'reembolso'].includes(tipo)) throw new Error('tipo de solicitação inválido')
  if (!String(body.descricao ?? '').trim() || !Number.isInteger(valor) || valor <= 0) throw new Error('descrição e valor_centavos são obrigatórios')
  if (!String(body.data_despesa ?? '').match(/^\d{4}-\d{2}-\d{2}/)) throw new Error('data_despesa inválida')
  if (!String(body.categoria_id ?? '').trim()) throw new Error('categoria_id é obrigatório')
  if (totalInformado !== null && (!Number.isInteger(totalInformado) || totalInformado < valor)) {
    throw new Error('valor_total_despesa_centavos deve ser um inteiro maior ou igual ao valor')
  }
  const rateioLinhas = linhas.map((linha) => ({ cotista_id: String(linha.cotista_id ?? ''), percentual: Number(linha.percentual), valor_centavos: Number(linha.valor_centavos), percentual_sociedade: Number(linha.percentual_sociedade ?? linha.percentual) }))
  if (tipo !== 'share') {
    const percentualTotal = rateioLinhas.reduce((total, linha) => total + linha.percentual, 0)
    const valorTotal = rateioLinhas.reduce((total, linha) => total + linha.valor_centavos, 0)
    const linhasInvalidas = rateioLinhas.some((linha) =>
      !linha.cotista_id ||
      !Number.isFinite(linha.percentual) ||
      linha.percentual < 0 ||
      !Number.isInteger(linha.valor_centavos) ||
      linha.valor_centavos <= 0,
    )
    // Com valor menor que o total da despesa, a solicitação representa a parte
    // de um único cotista; os percentuais são calculados sobre o total.
    const parteDeUmCotista = totalInformado !== null && totalInformado > valor
    if (!rateioLinhas.length || linhasInvalidas || valorTotal !== valor) {
      throw new Error('rateio_linhas inválido')
    }
    if (parteDeUmCotista) {
      if (rateioLinhas.length !== 1) throw new Error('Quando o valor é menor que o total da despesa, informe uma única linha de rateio')
    } else if (Math.abs(percentualTotal - 100) > 0.01) {
      throw new Error('rateio_linhas inválido')
    }
  }
  return {
    tipo: tipo as PaymentRequest['tipo'], descricao: String(body.descricao).trim(), valor_centavos: valor,
    valor_total_despesa_centavos: totalInformado,
    cotista_pagador_id: body.cotista_pagador_id ? String(body.cotista_pagador_id) : null,
    data_despesa: String(body.data_despesa), data_vencimento: body.data_vencimento ? String(body.data_vencimento) : null,
    aeronave_id: body.aeronave_id ? String(body.aeronave_id) : null, rateio_linhas: rateioLinhas,
    anexos: anexos.map((anexo) => ({ id: String(anexo.id ?? ''), tipo: String(anexo.tipo ?? 'outro'), numero: String(anexo.numero ?? ''), url: anexo.url ? String(anexo.url) : null, ...(anexo.cotista_id ? { cotista_id: String(anexo.cotista_id) } : {}) })),
    periodicidade: body.periodicidade ? String(body.periodicidade) : null, tipo_rateio: body.tipo_rateio ? String(body.tipo_rateio) : null,
    categoria_id: String(body.categoria_id), categoria_cliente_id: categoriaClienteId, colaborador_id: body.colaborador_id ? String(body.colaborador_id) : null, fornecedor_id: body.fornecedor_id ? String(body.fornecedor_id) : null,
    fornecedor: (body.fornecedor ?? body.fornecedor_nome) ? String(body.fornecedor ?? body.fornecedor_nome) : null, categoria_nome: body.categoria_nome ? String(body.categoria_nome) : null, grupo_categoria: body.grupo_categoria ? String(body.grupo_categoria) : null,
    subcategoria_1: body.subcategoria_1 ? String(body.subcategoria_1) : null, subcategoria_2: body.subcategoria_2 ? String(body.subcategoria_2) : null, subcategoria_3: body.subcategoria_3 ? String(body.subcategoria_3) : null, subcategoria_4: body.subcategoria_4 ? String(body.subcategoria_4) : null,
    observacoes: body.observacoes ? String(body.observacoes) : null,
    abastecimento,
    idempotency_key: String(body.idempotency_key ?? '').trim() || crypto.randomUUID(),
  }
}

export async function findPaymentRequestByKey(db: D1Database, key: string): Promise<Row | null> {
  return db.prepare(`SELECT v.destino_id AS id FROM financeiro_vinculos v WHERE v.origem_tipo = 'IDEMPOTENCY_KEY' AND v.origem_id = ? AND v.destino_tipo = 'ENVIO_DESPESA' LIMIT 1`).bind(key).first<Row>()
}

export async function createPaymentRequest(db: D1Database, input: PaymentRequest, userId: string | null): Promise<Row> {
  const existing = await findPaymentRequestByKey(db, input.idempotency_key)
  if (existing?.id) {
    const request = await db.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(existing.id).first<Row>()
    if (!request) throw new Error('solicitacao_pagamento_nao_encontrada')
    return { ...request, idempotent: true }
  }
  const cotistaId = input.rateio_linhas[0]?.cotista_id || null
  const cotistaIds = [...new Set(input.rateio_linhas.map((linha) => linha.cotista_id))]
  const titulares = input.tipo !== 'share' && cotistaIds.length
    ? (await db.prepare(`
        SELECT ca.id, ca.aeronave_id, ca.cliente_id, ca.socio_id, hs.holding_id
          FROM cotista_aeronave ca
          LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
         WHERE ca.id IN (${cotistaIds.map(() => '?').join(', ')})
      `).bind(...cotistaIds).all<{ id: string; aeronave_id: string; cliente_id: string | null; socio_id: string | null; holding_id: string | null }>()).results ?? []
    : []
  if (input.tipo !== 'share' && titulares.length !== cotistaIds.length) throw new Error('cotista_da_aeronave_nao_encontrado')
  const titular = titulares.find((item) => item.id === cotistaId) ?? null
  if (input.tipo !== 'share' && !titular) throw new Error('cotista_da_aeronave_nao_encontrado')
  const aeronaveId = input.aeronave_id || titular?.aeronave_id || null
  if (input.tipo !== 'share' && titulares.some((item) => item.aeronave_id !== aeronaveId)) {
    throw new Error('cotista_nao_vinculado_a_aeronave_informada')
  }
  const ehHolding = Boolean(titular?.socio_id)
  const id = crypto.randomUUID()
  const solicitacaoCompraId = input.tipo === 'share' && userId ? crypto.randomUUID() : null
  // O fluxo de cliente não define pagador antes da baixa; os demais preservam o responsável informado.
  const pagador = input.tipo === 'cliente' ? null : input.cotista_pagador_id || (input.tipo !== 'share' ? cotistaId : null)
  const statements = [
    db.prepare(`INSERT INTO envio_despesas (id, tipo, descricao, valor, valor_total_despesa, data_despesa, vencimento, aeronave_id, observacoes, status, criado_por, grupo_categoria, tipo_caixa, pago_diretamente, pago_por, fornecedor_id, categoria_id, categoria_cliente_id, rateio_linhas_json, anexos_json, periodicidade, tipo_rateio, colaborador_id, abastecimento_json, solicitacao_compra_id, criado_em, fornecedor, categoria_nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.tipo, input.descricao, input.valor_centavos / 100, input.valor_total_despesa_centavos != null ? input.valor_total_despesa_centavos / 100 : null, input.data_despesa, input.data_vencimento, aeronaveId, input.observacoes, userId, ehHolding ? 'CAIXA HOLDING' : input.tipo === 'cliente' ? 'CAIXA CLIENTE' : input.tipo === 'reembolso' ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA', ehHolding ? 'HOLDING' : input.tipo === 'cliente' ? 'CLIENTE' : 'SHARE', 0, pagador, input.fornecedor_id, input.categoria_id, input.categoria_cliente_id, JSON.stringify(input.rateio_linhas), JSON.stringify(input.anexos), input.periodicidade, input.tipo_rateio, input.colaborador_id, input.abastecimento ? JSON.stringify(input.abastecimento) : null, solicitacaoCompraId, input.fornecedor, input.categoria_nome, input.subcategoria_1, input.subcategoria_2, input.subcategoria_3, input.subcategoria_4),
    db.prepare(`INSERT INTO financeiro_vinculos (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo) VALUES (?, 'IDEMPOTENCY_KEY', ?, 'ENVIO_DESPESA', ?, 'SOLICITACAO')`).bind(crypto.randomUUID(), input.idempotency_key, id),
  ]
  if (solicitacaoCompraId) {
    statements.unshift(db.prepare(`INSERT INTO solicitacoes_compra (id, numero_solicitacao, tipo, descricao, observacoes, user_id, data_solicitacao, data_necessaria, status, solicitante_nome) VALUES (?, ?, 'DESPESA', ?, ?, ?, ?, ?, 'RASCUNHO', ?)`)
      .bind(solicitacaoCompraId, `ENV-${id.slice(0, 8).toUpperCase()}`, input.descricao, input.observacoes, userId, input.data_despesa, input.data_vencimento, userId))
  }
  await db.batch(statements)
  const request = await db.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(id).first<Row>()
  if (!request) throw new Error('solicitacao_pagamento_nao_encontrada')
  return { ...request, idempotent: false }
}

type ConvertOptions = { internal?: boolean }

export type ConvertHandlers = {
  createExpense: (db: D1Database, body: Row, userId: string | null, options?: ConvertOptions) => Promise<Row>
  createReimbursement?: (db: D1Database, body: Row, userId: string | null, options?: ConvertOptions) => Promise<Row>
  createDirectExternalExpense?: (db: D1Database, body: Row, userId: string | null, options?: ConvertOptions) => Promise<Row>
}

export async function convertPaymentRequest(
  db: D1Database,
  request: Row,
  handlers: ConvertHandlers,
  userId: string | null,
): Promise<Row> {
  const previousStatus = String(request.status || 'PENDENTE').toUpperCase()
  const existing = await db.prepare('SELECT lancamento_id, movimentacao_id, status FROM envio_despesas WHERE id = ?').bind(request.id).first<Row>()
  if (existing?.lancamento_id || existing?.movimentacao_id) return { ...existing, idempotent: true }
  const claim = await db.prepare(`UPDATE envio_despesas SET status = 'PROCESSANDO', atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ? AND status = ? AND lancamento_id IS NULL AND movimentacao_id IS NULL`).bind(request.id, previousStatus).run()
  if (!claim.meta.changes) {
    const current = await db.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(request.id).first<Row>()
    if (current?.lancamento_id || current?.movimentacao_id) return { ...current, idempotent: true }
    throw new Error('solicitacao_em_processamento')
  }
  const linhasRecebidas = JSON.parse(String(request.rateio_linhas_json || '[]')) as Row[]
  // O envio representa uma obrigação ainda em aberto. A baixa real é que registra o pagamento.
  const linhas: Row[] = request.tipo === 'cliente'
    ? linhasRecebidas.map((linha) => ({ ...linha, pago_por: null, pago_diretamente: false, valor_pago_real_centavos: 0 }))
    : linhasRecebidas
  const anexos = JSON.parse(String(request.anexos_json || '[]'))
  const cotistaAeronaveId = String(linhas[0]?.cotista_id || request.cotista_id || '').trim() || null
  const titular = cotistaAeronaveId
    ? await db.prepare(`
        SELECT ca.aeronave_id, ca.cliente_id, ca.socio_id, hs.holding_id
          FROM cotista_aeronave ca
          LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
         WHERE ca.id = ?
         LIMIT 1
      `).bind(cotistaAeronaveId).first<{ aeronave_id: string; cliente_id: string | null; socio_id: string | null; holding_id: string | null }>()
    : null
  const ehHolding = Boolean(titular?.socio_id || String(request.tipo_caixa || '').toUpperCase() === 'HOLDING')
  let abastecimentoId: string | null = null
  if (request.tipo === 'cliente' && request.abastecimento_json) {
    const abastecimento = JSON.parse(String(request.abastecimento_json)) as Row
    abastecimentoId = String(abastecimento.id || crypto.randomUUID())
    await db.prepare(`INSERT OR IGNORE INTO abastecimentos (id, cliente_id, socio_id, aeronave_id, data, tipo_combustivel, trecho, local, numero_comanda, numero_nf, litros, valor_unitario, valor_total, fornecedor_id, status, observacao, forma_pagamento, data_vencimento_boleto, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(abastecimentoId, titular?.socio_id ? null : titular?.cliente_id, titular?.socio_id || null, request.aeronave_id || titular?.aeronave_id, request.data_despesa, abastecimento.tipo_combustivel || null, abastecimento.trecho || null, abastecimento.local || null, abastecimento.numero_comanda || null, abastecimento.numero_nf || null, abastecimento.litros ?? null, abastecimento.valor_unitario ?? null, Number(request.valor || 0), request.fornecedor_id || null, 'PAGO', abastecimento.observacao || request.descricao, abastecimento.forma_pagamento || null, request.vencimento || null, userId).run()
  }

  const valorCentavos = Math.round(Number(request.valor || 0) * 100)
  const totalDespesa = Number(request.valor_total_despesa || 0)
  const totalDespesaCentavos = totalDespesa > 0 ? Math.round(totalDespesa * 100) : null
  const pagador = request.tipo === 'cliente' ? null : String(request.pago_por || linhas[0]?.cotista_id || cotistaAeronaveId || '').trim() || null
  const semRateio = request.tipo === 'share' || (request.tipo === 'reembolso' && !ehHolding)

  const comando: Row = {
    idempotency_key: `envio:${request.id}`,
    tipo: request.tipo,
    descricao: request.descricao,
    valor_centavos: valorCentavos,
    valor_total_despesa_centavos: totalDespesaCentavos,
    data: request.data_despesa,
    data_vencimento: request.vencimento,
    aeronave_id: request.aeronave_id || titular?.aeronave_id,
    cotista_aeronave_id: cotistaAeronaveId,
    cotista_pagador_id: pagador,
    socio_id: titular?.socio_id || null,
    holding_id: titular?.holding_id || null,
    categoria_id: request.categoria_id,
    categoria_cliente_id: request.categoria_cliente_id,
    colaborador_id: request.colaborador_id,
    fornecedor_id: request.fornecedor_id,
    fornecedor_nome: request.fornecedor || request.fornecedor_nome,
    categoria_nome: request.categoria_nome,
    grupo_categoria: request.grupo_categoria,
    subcategoria_1: request.subcategoria_1, subcategoria_2: request.subcategoria_2, subcategoria_3: request.subcategoria_3, subcategoria_4: request.subcategoria_4,
    observacoes: request.observacoes,
    abastecimentos_id: abastecimentoId,
    rateio_linhas: linhas,
    sem_rateio: semRateio,
    anexos_json: anexos,
    periodicidade: request.periodicidade,
    tipo_rateio: request.tipo_rateio,
    pago_diretamente: false,
    tipo_caixa: ehHolding ? 'HOLDING' : request.tipo === 'cliente' ? 'CLIENTE' : 'SHARE',
    reembolsavel: request.tipo === 'reembolso',
    // Marca a conta a pagar gerada: não aparece em "Contas a pagar" da empresa.
    origem_tipo_conta: request.tipo === 'share' ? 'SOLICITACAO_COMPRA' : 'SOLICITACAO_PAGAMENTO',
  }

  try {
    // O envio direto cria o rateio em aberto; apenas a baixa pode confirmar pagamento.
    const lancamento = request.tipo === 'cliente' && handlers.createDirectExternalExpense
      ? await handlers.createDirectExternalExpense(db, comando, userId, { internal: true })
      : await handlers.createExpense(db, comando, userId, { internal: true })
    const lancamentoId = String(lancamento.lancamento_id ?? lancamento.id)

    let reimbursement: Row | null = null
    if (request.tipo === 'reembolso' && handlers.createReimbursement && !ehHolding) {
      reimbursement = await handlers.createReimbursement(db, {
      idempotency_key: `reembolso:${request.id}`,
      lancamento_origem_id: lancamentoId,
      lancamento_id: lancamentoId,
      descricao: request.descricao,
      valor_centavos: valorCentavos,
      valor_total_despesa_centavos: totalDespesaCentavos,
      cotista_pagador_id: pagador,
      data: request.data_despesa,
      data_vencimento: request.vencimento,
      aeronave_id: request.aeronave_id || titular?.aeronave_id,
      cotista_aeronave_id: cotistaAeronaveId,
      categoria_id: request.categoria_id,
      categoria_cliente_id: request.categoria_cliente_id,
      categoria_nome: request.categoria_nome,
      fornecedor_id: request.fornecedor_id,
      fornecedor: request.fornecedor,
      colaborador_id: request.colaborador_id,
      rateio_linhas: linhas,
      anexos_json: anexos,
      tipo_rateio: request.tipo_rateio,
      periodicidade: request.periodicidade,
      subcategoria_1: request.subcategoria_1,
      subcategoria_2: request.subcategoria_2,
      subcategoria_3: request.subcategoria_3,
      subcategoria_4: request.subcategoria_4,
      }, userId, { internal: true })
    }
    const destinoTipo = ehHolding ? 'MOVIMENTO_HOLDING' : 'LANCAMENTO'
    await db.batch([
      db.prepare('UPDATE envio_despesas SET lancamento_id = ?, movimentacao_id = ?, movimentos_holding_id = ?, status = ? WHERE id = ? AND status = ? AND lancamento_id IS NULL').bind(ehHolding ? null : lancamentoId, lancamentoId, ehHolding ? lancamentoId : null, 'CONVERTIDO', request.id, 'PROCESSANDO'),
      db.prepare(`INSERT OR IGNORE INTO financeiro_vinculos (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo) VALUES (?, 'ENVIO_DESPESA', ?, ?, ?, 'CONVERSAO')`).bind(crypto.randomUUID(), request.id, destinoTipo, lancamentoId),
    ])
    return { id: request.id, lancamento_id: ehHolding ? null : lancamentoId, movimentacao_id: lancamentoId, reimbursement, idempotent: false }
  } catch (error) {
    await db.prepare('UPDATE envio_despesas SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = ? AND lancamento_id IS NULL AND movimentacao_id IS NULL').bind(previousStatus, request.id, 'PROCESSANDO').run().catch(() => undefined)
    throw error
  }
}
