type Row = Record<string, unknown>

export type PaymentRequest = {
  tipo: 'share' | 'cliente' | 'reembolso'
  descricao: string
  valor_centavos: number
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
  if (!['share', 'cliente', 'reembolso'].includes(tipo)) throw new Error('tipo de solicitação inválido')
  if (!String(body.descricao ?? '').trim() || !Number.isInteger(valor) || valor <= 0) throw new Error('descrição e valor_centavos são obrigatórios')
  if (!String(body.data_despesa ?? '').match(/^\d{4}-\d{2}-\d{2}/)) throw new Error('data_despesa inválida')
  if (!String(body.categoria_id ?? '').trim()) throw new Error('categoria_id é obrigatório')
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
    if (!rateioLinhas.length || linhasInvalidas || Math.abs(percentualTotal - 100) > 0.01 || valorTotal !== valor) {
      throw new Error('rateio_linhas inválido')
    }
  }
  return {
    tipo: tipo as PaymentRequest['tipo'], descricao: String(body.descricao).trim(), valor_centavos: valor,
    data_despesa: String(body.data_despesa), data_vencimento: body.data_vencimento ? String(body.data_vencimento) : null,
    aeronave_id: body.aeronave_id ? String(body.aeronave_id) : null, rateio_linhas: rateioLinhas,
    anexos: anexos.map((anexo) => ({ id: String(anexo.id ?? ''), tipo: String(anexo.tipo ?? 'outro'), numero: String(anexo.numero ?? ''), url: anexo.url ? String(anexo.url) : null, ...(anexo.cotista_id ? { cotista_id: String(anexo.cotista_id) } : {}) })),
    periodicidade: body.periodicidade ? String(body.periodicidade) : null, tipo_rateio: body.tipo_rateio ? String(body.tipo_rateio) : null,
    categoria_id: String(body.categoria_id), categoria_cliente_id: categoriaClienteId, colaborador_id: body.colaborador_id ? String(body.colaborador_id) : null, fornecedor_id: body.fornecedor_id ? String(body.fornecedor_id) : null,
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
  const titular = cotistaId
    ? await db.prepare(`
        SELECT ca.aeronave_id, ca.cliente_id, ca.socio_id, hs.holding_id
          FROM cotista_aeronave ca
          LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
         WHERE ca.id = ?
         LIMIT 1
      `).bind(cotistaId).first<{ aeronave_id: string; cliente_id: string | null; socio_id: string | null; holding_id: string | null }>()
    : null
  if (input.tipo !== 'share' && !titular) throw new Error('cotista_da_aeronave_nao_encontrado')
  const aeronaveId = input.aeronave_id || titular?.aeronave_id || null
  const ehHolding = Boolean(titular?.socio_id)
  const id = crypto.randomUUID()
  const solicitacaoCompraId = input.tipo === 'share' && userId ? crypto.randomUUID() : null
  const statements = [
    db.prepare(`INSERT INTO envio_despesas (id, tipo, descricao, valor, data_despesa, vencimento, aeronave_id, observacoes, status, criado_por, grupo_categoria, tipo_caixa, pago_diretamente, fornecedor_id, categoria_id, categoria_cliente_id, rateio_linhas_json, anexos_json, periodicidade, tipo_rateio, colaborador_id, abastecimento_json, solicitacao_compra_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .bind(id, input.tipo, input.descricao, input.valor_centavos / 100, input.data_despesa, input.data_vencimento, aeronaveId, input.observacoes, userId, ehHolding ? 'CAIXA HOLDING' : input.tipo === 'cliente' ? 'CAIXA CLIENTE' : input.tipo === 'reembolso' ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA', ehHolding ? 'HOLDING' : input.tipo === 'cliente' ? 'CLIENTE' : 'SHARE', input.tipo === 'cliente' ? 1 : 0, input.fornecedor_id, input.categoria_id, input.categoria_cliente_id, JSON.stringify(input.rateio_linhas), JSON.stringify(input.anexos), input.periodicidade, input.tipo_rateio, input.colaborador_id, input.abastecimento ? JSON.stringify(input.abastecimento) : null, solicitacaoCompraId),
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

export async function convertPaymentRequest(
  db: D1Database,
  request: Row,
  createExpense: (db: D1Database, body: Row, userId: string | null, options?: { internal?: boolean }) => Promise<Row>,
  userId: string | null,
  createReimbursement?: (db: D1Database, body: Row, userId: string | null) => Promise<Row>,
): Promise<Row> {
  const existing = await db.prepare('SELECT lancamento_id, movimentacao_id FROM envio_despesas WHERE id = ?').bind(request.id).first<Row>()
  if (existing?.lancamento_id || existing?.movimentacao_id) return { ...existing, idempotent: true }
  const linhas = JSON.parse(String(request.rateio_linhas_json || '[]'))
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
    await db.prepare(`INSERT OR IGNORE INTO abastecimentos (id, cliente_id, socio_id, aeronave_id, data, tipo_combustivel, trecho, local, numero_comanda, numero_nf, litros, valor_unitario, valor_total, fornecedor_id, status, observacao, forma_pagamento, data_vencimento_boleto, criado_por, data_pagamento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(abastecimentoId, titular?.socio_id ? null : titular?.cliente_id, titular?.socio_id || null, request.aeronave_id || titular?.aeronave_id, request.data_despesa, abastecimento.tipo_combustivel || null, abastecimento.trecho || null, abastecimento.local || null, abastecimento.numero_comanda || null, abastecimento.numero_nf || null, abastecimento.litros ?? null, abastecimento.valor_unitario ?? null, Number(request.valor || 0), request.fornecedor_id || null, 'PAGO', abastecimento.observacao || request.descricao, abastecimento.forma_pagamento || null, request.vencimento || null, userId, request.data_despesa).run()
  }
  const lancamento = await createExpense(db, { idempotency_key: `envio:${request.id}`, tipo: request.tipo, descricao: request.descricao, valor_centavos: Math.round(Number(request.valor || 0) * 100), data: request.data_despesa, data_vencimento: request.vencimento, aeronave_id: request.aeronave_id || titular?.aeronave_id, cotista_aeronave_id: cotistaAeronaveId, socio_id: titular?.socio_id || null, holding_id: titular?.holding_id || null, categoria_id: request.categoria_id, categoria_cliente_id: request.categoria_cliente_id, colaborador_id: request.colaborador_id, fornecedor_id: request.fornecedor_id, observacoes: request.observacoes, abastecimentos_id: abastecimentoId, rateio_linhas: linhas, sem_rateio: request.tipo === 'reembolso' || request.tipo === 'share', anexos_json: anexos, periodicidade: request.periodicidade, tipo_rateio: request.tipo_rateio, pago_diretamente: request.tipo === 'cliente', tipo_caixa: ehHolding ? 'HOLDING' : request.tipo === 'cliente' ? 'CLIENTE' : 'SHARE', reembolsavel: request.tipo === 'reembolso' }, userId, { internal: true })
  const lancamentoId = String(lancamento.lancamento_id ?? lancamento.id)
  let reimbursement: Row | null = null
  if (request.tipo === 'reembolso' && createReimbursement && !ehHolding) {
    reimbursement = await createReimbursement(db, {
      idempotency_key: `reembolso:${request.id}`,
      lancamento_origem_id: lancamentoId,
      lancamento_id: lancamentoId,
      descricao: request.descricao,
      valor_centavos: Math.round(Number(request.valor || 0) * 100),
      data: request.data_despesa,
      data_vencimento: request.vencimento,
      aeronave_id: request.aeronave_id || titular?.aeronave_id,
      cotista_aeronave_id: cotistaAeronaveId,
      categoria_id: request.categoria_id,
      categoria_cliente_id: request.categoria_cliente_id,
      categoria_cliente_nome: request.categoria_cliente_nome,
      colaborador_id: request.colaborador_id,
    }, userId)
  }
  const destinoTipo = ehHolding ? 'MOVIMENTO_HOLDING' : 'LANCAMENTO'
  await db.batch([
    db.prepare('UPDATE envio_despesas SET lancamento_id = ?, movimentacao_id = ?, movimentos_holding_id = ?, status = ? WHERE id = ? AND lancamento_id IS NULL').bind(ehHolding ? null : lancamentoId, lancamentoId, ehHolding ? lancamentoId : null, 'CONVERTIDO', request.id),
    db.prepare(`INSERT OR IGNORE INTO financeiro_vinculos (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo) VALUES (?, 'ENVIO_DESPESA', ?, ?, ?, 'CONVERSAO')`).bind(crypto.randomUUID(), request.id, destinoTipo, lancamentoId),
  ])
  return { id: request.id, lancamento_id: ehHolding ? null : lancamentoId, movimentacao_id: lancamentoId, reimbursement, idempotent: false }
}
