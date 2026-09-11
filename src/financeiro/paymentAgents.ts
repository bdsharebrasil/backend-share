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
  fornecedor_id: string | null
  observacoes: string | null
  idempotency_key: string
}

export function validatePaymentRequest(body: Row): PaymentRequest {
  const tipo = String(body.tipo ?? '').trim()
  const valor = Number(body.valor_centavos)
  const linhas = Array.isArray(body.rateio_linhas) ? body.rateio_linhas : []
  const anexos = Array.isArray(body.anexos) ? body.anexos : []
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
    categoria_id: String(body.categoria_id), fornecedor_id: body.fornecedor_id ? String(body.fornecedor_id) : null,
    observacoes: body.observacoes ? String(body.observacoes) : null,
    idempotency_key: String(body.idempotency_key ?? '').trim() || crypto.randomUUID(),
  }
}

export async function findPaymentRequestByKey(db: D1Database, key: string): Promise<Row | null> {
  return db.prepare(`SELECT v.destino_id AS id FROM financeiro_vinculos v WHERE v.origem_tipo = 'IDEMPOTENCY_KEY' AND v.origem_id = ? AND v.destino_tipo = 'ENVIO_DESPESA' LIMIT 1`).bind(key).first<Row>()
}

export async function createPaymentRequest(db: D1Database, input: PaymentRequest, userId: string | null): Promise<Row> {
  const existing = await findPaymentRequestByKey(db, input.idempotency_key)
  if (existing?.id) return { id: existing.id, idempotent: true }
  const id = crypto.randomUUID()
  await db.batch([
    db.prepare(`INSERT INTO envio_despesas (id, tipo, descricao, valor, data_despesa, vencimento, aeronave_id, observacoes, status, criado_por, grupo_categoria, tipo_caixa, pago_diretamente, fornecedor_id, categoria_id, rateio_linhas_json, anexos_json, periodicidade, tipo_rateio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.tipo, input.descricao, input.valor_centavos / 100, input.data_despesa, input.data_vencimento, input.aeronave_id, input.observacoes, userId, input.tipo === 'cliente' ? 'CAIXA CLIENTE' : input.tipo === 'reembolso' ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA', input.tipo === 'cliente' ? 'CLIENTE' : 'SHARE', input.tipo === 'cliente' ? 1 : 0, input.fornecedor_id, input.categoria_id, JSON.stringify(input.rateio_linhas), JSON.stringify(input.anexos), input.periodicidade, input.tipo_rateio),
    db.prepare(`INSERT INTO financeiro_vinculos (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo) VALUES (?, 'IDEMPOTENCY_KEY', ?, 'ENVIO_DESPESA', ?, 'SOLICITACAO')`).bind(crypto.randomUUID(), input.idempotency_key, id),
  ])
  return { id, status: 'PENDENTE', idempotent: false }
}

export async function convertPaymentRequest(db: D1Database, request: Row, createExpense: (db: D1Database, body: Row, userId: string | null) => Promise<Row>, userId: string | null): Promise<Row> {
  const existing = await db.prepare('SELECT lancamento_id, movimentacao_id FROM envio_despesas WHERE id = ?').bind(request.id).first<Row>()
  if (existing?.lancamento_id) return { ...existing, idempotent: true }
  const linhas = JSON.parse(String(request.rateio_linhas_json || '[]'))
  const anexos = JSON.parse(String(request.anexos_json || '[]'))
  const lancamento = await createExpense(db, { idempotency_key: `envio:${request.id}`, tipo: request.tipo, descricao: request.descricao, valor_centavos: Math.round(Number(request.valor || 0) * 100), data: request.data_despesa, data_vencimento: request.vencimento, aeronave_id: request.aeronave_id, categoria_id: request.categoria_id, fornecedor_id: request.fornecedor_id, observacoes: request.observacoes, rateio_linhas: linhas, anexos_json: JSON.stringify(anexos), periodicidade: request.periodicidade, tipo_rateio: request.tipo_rateio, pago_diretamente: request.tipo === 'cliente', tipo_caixa: request.tipo === 'cliente' ? 'CLIENTE' : 'SHARE', reembolsavel: request.tipo === 'reembolso' }, userId)
  const lancamentoId = String(lancamento.lancamento_id ?? lancamento.id)
  await db.batch([
    db.prepare('UPDATE envio_despesas SET lancamento_id = ?, movimentacao_id = ?, status = ? WHERE id = ? AND lancamento_id IS NULL').bind(lancamentoId, lancamentoId, 'CONVERTIDO', request.id),
    db.prepare(`INSERT OR IGNORE INTO financeiro_vinculos (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo) VALUES (?, 'ENVIO_DESPESA', ?, 'LANCAMENTO', ?, 'CONVERSAO')`).bind(crypto.randomUUID(), request.id, lancamentoId),
  ])
  return { id: request.id, lancamento_id: lancamentoId, movimentacao_id: lancamentoId, idempotent: false }
}
