type Row = Record<string, unknown>
import type { StatusRecibo } from '../../shared/financeiro-contracts'

type ReceiptInput = {
  tipo_recibo: string
  pagador_tipo: 'empresa' | 'cotista_aeronave' | 'cliente'
  pagador_id: string
  valor_centavos: number
  categoria_movimentacao_id: string
  categoria_nome?: string | null
  numero_voo?: string | null
  subcategoria_1?: string | null
  subcategoria_2?: string | null
  subcategoria_3?: string | null
  subcategoria_4?: string | null
  descricao: string
  data_emissao: string
  data_vencimento?: string | null
  forma_pagamento?: string | null
  aeronave_id?: string | null
  abastecimentos_id?: string | null
  cliente_id?: string | null
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

const RECEIPT_STATUSES: readonly StatusRecibo[] = ['CRIADO', 'ANEXO_PENDENTE', 'PDF_PENDENTE', 'EMITIDO', 'EMAIL_ENVIADO', 'ERRO_ANEXO', 'ERRO_PDF', 'CANCELADO']

export function validateReceiptCommand(body: Row): ReceiptInput {
  const tipo = String(body.tipo_recibo ?? '').trim()
  if (!['recibo_reembolso', 'recibo_colaborador', 'recibo_pagamento', 'recibo_saida'].includes(tipo)) throw new Error('tipo_recibo inválido')
  const pagadorTipo = String(body.pagador_tipo ?? '').trim()
  const pagadorId = String(body.pagador_id ?? '').trim()
  const categoria = String(body.categoria_movimentacao_id ?? '').trim()
  const valor = Number(body.valor_centavos)
  const dataVencimento = body.data_vencimento || body.vencimento
  if (!['empresa', 'cotista_aeronave', 'cliente'].includes(pagadorTipo) || !pagadorId) throw new Error('Pagador inválido')
  if (!categoria) throw new Error('categoria_movimentacao_id é obrigatória')
  if (!Number.isInteger(valor) || valor <= 0) throw new Error('valor_centavos deve ser um inteiro maior que zero')
  return {
    tipo_recibo: tipo,
    pagador_tipo: pagadorTipo as ReceiptInput['pagador_tipo'],
    pagador_id: pagadorId,
    valor_centavos: valor,
    categoria_movimentacao_id: categoria,
    categoria_nome: body.categoria_nome ? String(body.categoria_nome) : null,
    numero_voo: body.numero_voo ? String(body.numero_voo) : null,
    subcategoria_1: body.subcategoria_1 ? String(body.subcategoria_1) : null,
    subcategoria_2: body.subcategoria_2 ? String(body.subcategoria_2) : null,
    subcategoria_3: body.subcategoria_3 ? String(body.subcategoria_3) : null,
    subcategoria_4: body.subcategoria_4 ? String(body.subcategoria_4) : null,
    descricao: String(body.descricao ?? body.descricao_servico ?? '').trim(),
    data_emissao: String(body.data_emissao ?? '').trim(),
    data_vencimento: dataVencimento ? String(dataVencimento).trim() || null : null,
    forma_pagamento: body.forma_pagamento ? String(body.forma_pagamento) : null,
    aeronave_id: body.aeronave_id ? String(body.aeronave_id) : null,
    abastecimentos_id: body.abastecimentos_id ? String(body.abastecimentos_id) : null,
    cliente_id: body.cliente_id ? String(body.cliente_id) : null,
    colaborador_id: body.colaborador_id ? String(body.colaborador_id) : null,
    recebedor_nome: body.recebedor_nome ? String(body.recebedor_nome) : null,
    recebedor_cpf: body.recebedor_cpf ? String(body.recebedor_cpf) : null,
    recebedor_endereco: body.recebedor_endereco ? String(body.recebedor_endereco) : null,
    recebedor_cidade: body.recebedor_cidade ? String(body.recebedor_cidade) : null,
    recebedor_uf: body.recebedor_uf ? String(body.recebedor_uf) : null,
    observacoes: body.observacoes ? String(body.observacoes) : null,
    grupo_categoria: body.grupo_categoria ? String(body.grupo_categoria) : null,
  }
}

export function receiptStatusIsValid(status: string): boolean {
  return (RECEIPT_STATUSES as readonly string[]).includes(status)
}

export async function allocateReceiptNumber(db: D1Database, cotistaId: string | null, codigo: string, ano: string): Promise<string> {
  const codigoCliente = String(codigo || 'SHARE').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SHARE'
  const anoCompleto = String(ano)
  const row = await db.prepare(`
    INSERT INTO sequencia_numeros_recibos (id, cotista_aeronave_id, codigo_cliente, ano, proximo_numero)
    VALUES (?1, ?2, ?3, ?4, 2)
    ON CONFLICT(codigo_cliente, ano) DO UPDATE SET
      proximo_numero = sequencia_numeros_recibos.proximo_numero + 1,
      cotista_aeronave_id = COALESCE(excluded.cotista_aeronave_id, sequencia_numeros_recibos.cotista_aeronave_id)
    RETURNING proximo_numero - 1 AS numero
  `).bind(crypto.randomUUID(), cotistaId, codigoCliente, anoCompleto).first<{ numero: number }>()
  if (!row) throw new Error('falha_ao_gerar_sequencia_numeros_recibos')
  return `REC-${codigoCliente}${String(row.numero).padStart(3, '0')}/${anoCompleto.slice(-2)}`
}

export async function createReceiptRecord(db: D1Database, input: ReceiptInput, id: string, number: string, userId: string | null): Promise<void> {
  const recebedorNome = input.tipo_recibo === 'recibo_reembolso'
    ? 'SHARE BRASIL SERVICOS AEROPORTUARIOS'
    : input.recebedor_nome
  await db.prepare(`
    INSERT INTO recibos (
      id, numero_recibo, tipo_recibo, colaborador_id, aeronave_id, rateado,
      pagador_tipo, pagador_id, nome_pagador, documento_pagador, endereco_pagador, cidade_pagador, uf_pagador,
      valor, descricao, data_emissao, data_vencimento, forma_pagamento, tipo_caixa,
      categoria_movimentacao_id, grupo_categoria, status, recebedor_nome, observacoes, criado_por, categoria_nome, numero_voo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CRIADO', ?, ?, ?, ?, ?)
  `).bind(
    id, number, input.tipo_recibo, input.colaborador_id, input.aeronave_id,
    input.rateado ? 1 : 0, input.pagador_tipo, input.pagador_id,
    input.nome_pagador, input.documento_pagador, input.endereco_pagador,
    input.cidade_pagador, input.uf_pagador, input.valor_centavos, input.descricao,
    input.data_emissao, input.data_vencimento, input.forma_pagamento,
    ['cotista_aeronave', 'cliente'].includes(input.pagador_tipo) ? 'cliente' : 'share',
    input.categoria_movimentacao_id, input.grupo_categoria, recebedorNome,
    input.observacoes, userId, input.categoria_nome, input.numero_voo,
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
  await db.prepare('UPDATE recibos SET status = ? WHERE id = ?').bind(status, receiptId).run()
}
