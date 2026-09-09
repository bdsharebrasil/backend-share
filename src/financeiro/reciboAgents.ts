type Row = Record<string, unknown>
import type { StatusRecibo } from '../../shared/financeiro-contracts'

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
  rateado?: boolean | number | null
  nome_pagador?: string | null
  documento_pagador?: string | null
  endereco_pagador?: string | null
  cidade_pagador?: string | null
  uf_pagador?: string | null
  recebedor_cpf?: string | null
  recebedor_endereco?: string | null
  recebedor_cidade?: string | null
  recebedor_uf?: string | null
}

const RECEIPT_STATUSES: readonly StatusRecibo[] = ['CRIADO', 'ANEXO_PENDENTE', 'PDF_PENDENTE', 'EMITIDO', 'ERRO_ANEXO', 'ERRO_PDF', 'CANCELADO']

export function validateReceiptCommand(body: Row): ReceiptInput {
  const tipo = String(body.tipo_recibo ?? '').trim()
  if (!['recibo_reembolso', 'recibo_colaborador', 'recibo_pagamento', 'recibo_saida'].includes(tipo)) throw new Error('tipo_recibo inválido')
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

export async function allocateReceiptNumber(db: D1Database, cotistaId: string | null, codigo: string, ano: string): Promise<string> {
  const anoCurto = ano.slice(-2)
  const existentes = await db.prepare('SELECT numero_recibo FROM recibos WHERE numero_recibo LIKE ?').bind(`REC-${codigo}%`).all<{ numero_recibo: string }>()
  const padrao = new RegExp(`^REC-${codigo}(\\d+)/(?:${ano}|${anoCurto})$`)
  const maiorExistente = (existentes.results ?? []).reduce((maior, item) => {
    const match = String(item.numero_recibo ?? '').match(padrao)
    return Math.max(maior, match ? Number(match[1]) : 0)
  }, 0)
  const existente = cotistaId ? await db.prepare(
    'SELECT id, proximo_numero FROM sequencia_numeros_recibos WHERE codigo_cliente = ? AND ano = ?',
  ).bind(codigo, ano).first<{ id: string; proximo_numero: number }>() : null
  const numero = Math.max(Number(existente?.proximo_numero || 1), maiorExistente + 1)

  if (existente) {
    await db.prepare(
      'UPDATE sequencia_numeros_recibos SET proximo_numero = ?, cotista_aeronave_id = ? WHERE id = ?',
    ).bind(numero + 1, cotistaId, existente.id).run()
  } else if (cotistaId) {
    await db.prepare(`
      INSERT INTO sequencia_numeros_recibos (id, cotista_aeronave_id, codigo_cliente, ano, proximo_numero)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), cotistaId, codigo, ano, numero + 1).run()
  }

  return `REC-${codigo}${String(numero).padStart(3, '0')}/${anoCurto}`
}

export async function createReceiptRecord(db: D1Database, input: ReceiptInput, id: string, number: string, userId: string | null): Promise<void> {
  await db.prepare(`
    INSERT INTO recibos (
      id, numero_recibo, tipo_recibo, colaborador_id, aeronave_id, rateado,
      pagador_tipo, pagador_id, valor, descricao, data_emissao, data_vencimento,
      forma_pagamento, tipo_caixa, categoria_movimentacao_id, grupo_categoria,
      status, recebedor_nome, observacoes, criado_por
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CRIADO', ?, ?, ?)
  `).bind(
    id, number, input.tipo_recibo, input.colaborador_id, input.aeronave_id,
    input.rateado ? 1 : 0, input.pagador_tipo, input.pagador_id,
    input.valor_centavos, input.descricao,
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

export async function updateReceiptStatus(db: D1Database, receiptId: string, status: StatusRecibo): Promise<void> {
  if (!receiptStatusIsValid(status)) throw new Error(`Status de recibo inválido: ${status}`)
  await db.prepare('UPDATE recibos SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(status, receiptId).run()
}
