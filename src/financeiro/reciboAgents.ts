type Row = Record<string, unknown>

type ReceiptInput = {
  tipo_recibo: string
  pagador_tipo: 'empresa' | 'cotista_aeronave'
  pagador_id: string
  valor_centavos: number
  categoria_movimentacao_id: string
  descricao: string
  data_emissao: string
  data_vencimento?: string | null
  forma_pagamento?: string | null
  aeronave_id?: string | null
  colaborador_id?: string | null
  recebedor_nome?: string | null
  observacoes?: string | null
  grupo_categoria?: string | null
}

const RECEIPT_STATUSES = ['CRIADO', 'ANEXO_PENDENTE', 'PDF_PENDENTE', 'EMITIDO', 'ERRO_ANEXO', 'ERRO_PDF', 'CANCELADO'] as const

export function validateReceiptCommand(body: Row): ReceiptInput {
  const tipo = String(body.tipo_recibo ?? '').trim()
  if (!['recibo_reembolso', 'recibo_colaborador', 'recibo_pagamento'].includes(tipo)) throw new Error('tipo_recibo inválido')
  const pagadorTipo = String(body.pagador_tipo ?? '').trim()
  const pagadorId = String(body.pagador_id ?? '').trim()
  const categoria = String(body.categoria_movimentacao_id ?? '').trim()
  const valor = Number(body.valor_centavos)
  if (!['empresa', 'cotista_aeronave'].includes(pagadorTipo) || !pagadorId) throw new Error('Pagador inválido')
  if (!categoria) throw new Error('categoria_movimentacao_id é obrigatória')
  if (!Number.isInteger(valor) || valor <= 0) throw new Error('valor_centavos deve ser um inteiro maior que zero')
  return {
    tipo_recibo: tipo,
    pagador_tipo: pagadorTipo as ReceiptInput['pagador_tipo'],
    pagador_id: pagadorId,
    valor_centavos: valor,
    categoria_movimentacao_id: categoria,
    descricao: String(body.descricao ?? body.descricao_servico ?? '').trim(),
    data_emissao: String(body.data_emissao ?? '').trim(),
    data_vencimento: body.data_vencimento ? String(body.data_vencimento) : null,
    forma_pagamento: body.forma_pagamento ? String(body.forma_pagamento) : null,
    aeronave_id: body.aeronave_id ? String(body.aeronave_id) : null,
    colaborador_id: body.colaborador_id ? String(body.colaborador_id) : null,
    recebedor_nome: body.recebedor_nome ? String(body.recebedor_nome) : null,
    observacoes: body.observacoes ? String(body.observacoes) : null,
    grupo_categoria: body.grupo_categoria ? String(body.grupo_categoria) : null,
  }
}

export function receiptStatusIsValid(status: string): boolean {
  return (RECEIPT_STATUSES as readonly string[]).includes(status)
}

export async function allocateReceiptNumber(db: D1Database, cotistaId: string, codigo: string, ano: string): Promise<string> {
  const id = crypto.randomUUID()
  const row = await db.prepare(`
    INSERT INTO sequencia_numeros_recibos (id, cotista_aeronave_id, codigo_cliente, ano, proximo_numero)
    VALUES (?, ?, ?, ?, 2)
    ON CONFLICT(codigo_cliente, ano) DO UPDATE SET proximo_numero = sequencia_numeros_recibos.proximo_numero + 1
    RETURNING proximo_numero - 1 AS numero
  `).bind(id, cotistaId, codigo, ano).first<{ numero: number }>()
  if (!row) throw new Error('falha_ao_gerar_sequencia_numeros_recibos')
  return `REC-${codigo}${row.numero}/${ano}`
}

export async function createReceiptRecord(db: D1Database, input: ReceiptInput, id: string, number: string, userId: string | null): Promise<void> {
  await db.prepare(`
    INSERT INTO recibos (
      id, numero_recibo, tipo_recibo, colaborador_id, aeronave_id, rateado,
      pagador_tipo, pagador_id, valor, descricao, data_emissao, data_vencimento,
      forma_pagamento, tipo_caixa, categoria_movimentacao_id, grupo_categoria,
      status, recebedor_nome, observacoes, criado_por
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CRIADO', ?, ?, ?)
  `).bind(
    id, number, input.tipo_recibo, input.colaborador_id, input.aeronave_id,
    input.pagador_tipo, input.pagador_id, input.valor_centavos, input.descricao,
    input.data_emissao, input.data_vencimento, input.forma_pagamento,
    input.pagador_tipo === 'cotista_aeronave' ? 'cliente' : 'share',
    input.categoria_movimentacao_id, input.grupo_categoria, input.recebedor_nome,
    input.observacoes, userId,
  ).run()
}

export async function createReceiptAllocations(db: D1Database, receiptId: string, lancamentoId: string): Promise<Row[]> {
  const rateios = await db.prepare(`
    SELECT id, cotista_id, COALESCE(percentual_uso, percentual_sociedade, 0) AS percentual,
           valor_rateado_centavos AS valor
    FROM rateio_despesas WHERE lancamento_id = ? ORDER BY rowid
  `).bind(lancamentoId).all<Row>()
  for (const rateio of rateios.results ?? []) {
    await db.prepare(`INSERT INTO recibo_rateio (id, recibo_id, rateio_id, percentual, valor, cotista_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), receiptId, rateio.id, Number(rateio.percentual || 0), Number(rateio.valor || 0), rateio.cotista_id).run()
  }
  return rateios.results ?? []
}

export async function updateReceiptStatus(db: D1Database, receiptId: string, status: typeof RECEIPT_STATUSES[number]): Promise<void> {
  if (!receiptStatusIsValid(status)) throw new Error(`Status de recibo inválido: ${status}`)
  await db.prepare('UPDATE recibos SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(status, receiptId).run()
}