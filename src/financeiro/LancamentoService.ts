export class FinanceValidationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'FinanceValidationError'
  }
}

type Database = D1Database

type Row = Record<string, any>

export interface RateioFinanceiro {
  id: string
  cotista: string
  valorCentavos: number
}

export interface LancamentoFinanceiro {
  id: string
  descricao: string
  fluxo: 'ENTRADA' | 'SAIDA'
  categoria: string
  grupoCategoria: string
  valorCentavos: number
  data: string
  prazo: string | null
  status: string
  caixa: string
  tipo: string | null
  fornecedor: string | null
  documento: string | null
  observacoes: string | null
  rateios: RateioFinanceiro[]
}

export interface BalancoFinanceiro {
  lancamentos: LancamentoFinanceiro[]
  saldos: Array<Record<string, any>>
  matrizCompensacao: Record<string, any>
  holdings: Array<Record<string, any> & { socios: Array<Record<string, any>> }>
}

function texto(value: unknown): string {
  return value == null ? '' : String(value)
}

function centavos(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(number * 100)
}

function fluxo(value: unknown): 'ENTRADA' | 'SAIDA' {
  return texto(value).toUpperCase() === 'ENTRADA' ? 'ENTRADA' : 'SAIDA'
}

function normalizarRateio(row: Row): RateioFinanceiro {
  return {
    id: texto(row.id),
    cotista: texto(row.cotista_nome ?? row.nome ?? row.cotista_id ?? 'Cotista não identificado'),
    valorCentavos: centavos(row.valor_rateado ?? row.valor ?? 0),
  }
}

function normalizarLancamento(row: Row, rateios: RateioFinanceiro[] = []): LancamentoFinanceiro {
  return {
    id: texto(row.id),
    descricao: texto(row.descricao),
    fluxo: fluxo(row.fluxo),
    categoria: texto(row.categoria_nome ?? row.categoria ?? 'SEM CATEGORIA'),
    grupoCategoria: texto(row.grupo_categoria ?? row.grupo ?? ''),
    valorCentavos: centavos(row.valor_total ?? row.valor_centavos / 100),
    data: texto(row.data_emissao ?? row.data_emissao_nf ?? row.data ?? row.criado_em ?? '').slice(0, 10),
    prazo: row.data_vencimento ?? row.vencimento ?? null,
    status: texto(row.status || 'PENDENTE').toUpperCase(),
    caixa: texto(row.tipo_caixa ?? row.caixa ?? 'SHARE').toUpperCase(),
    tipo: row.tipo ?? row.tipo_despesa ?? null,
    fornecedor: row.fornecedor_nome ?? row.fornecedor ?? null,
    documento: row.numero_doc ?? row.documento ?? null,
    observacoes: row.observacoes ?? null,
    rateios,
  }
}

export function normalizarLancamentoInput(body: Row, criadoPor?: string): Row {
  const descricao = texto(body.descricao).trim()
  if (!descricao) throw new FinanceValidationError('Descrição é obrigatória', 'descricao_obrigatoria')

  const valor = Number(body.valor_total ?? body.valor ?? 0)
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new FinanceValidationError('Valor deve ser maior que zero', 'valor_invalido')
  }

  const lancamento = {
    id: crypto.randomUUID(),
    descricao,
    fluxo: fluxo(body.fluxo).toLowerCase(),
    categoria_nome: texto(body.categoria_nome ?? body.categoria ?? 'SEM CATEGORIA'),
    grupo_categoria: texto(body.grupo_categoria),
    valor_total: valor,
    valor_rateado: Number(body.valor_rateado ?? valor),
    data_emissao: texto(body.data_emissao ?? body.data ?? new Date().toISOString().slice(0, 10)),
    data_vencimento: body.data_vencimento ?? body.vencimento ?? null,
    aeronave_id: body.aeronave_id ?? null,
    cotista_id: body.cotista_id ?? null,
    colaborador_id: body.colaborador_id ?? null,
    reembolsavel: body.reembolsavel ? 1 : 0,
    reembolso_quitado: body.reembolso_quitado ? 1 : 0,
    status: texto(body.status || 'pendente').toLowerCase(),
    fornecedor_nome: body.fornecedor_nome ?? body.fornecedor ?? null,
    numero_doc: body.numero_doc ?? body.documento ?? null,
    observacoes: body.observacoes ?? null,
    criado_por: criadoPor ?? body.criado_por ?? null,
    pago_diretamente: body.pago_diretamente ? 1 : 0,
    tipo_caixa: texto(body.tipo_caixa ?? body.caixa ?? 'share').toLowerCase(),
    pago_por: body.pago_por ?? null,
    reference_type: body.reference_type ?? null,
    reference_id: body.reference_id ?? null,
  }
  return lancamento
}

export async function prepararFinanceiro(_db: Database): Promise<FinanceiroService> {
  return new FinanceiroService(_db)
}

export class FinanceiroService {
  constructor(private readonly db: Database) {}

  async registrarLancamento(input: Row): Promise<{ lancamento: LancamentoFinanceiro }> {
    const schema = await this.db.prepare("SELECT name FROM pragma_table_info('lancamentos')").all<{ name: string }>()
    const existentes = new Set((schema.results || []).map((column) => String(column.name)))
    const dados = { ...input }
    if (!existentes.has('data_emissao') && existentes.has('data_emissao_nf') && dados.data_emissao !== undefined) {
      dados.data_emissao_nf = dados.data_emissao
      delete dados.data_emissao
    }
    if (!existentes.has('tipo_caixa') && existentes.has('caixa') && dados.tipo_caixa !== undefined) {
      dados.caixa = dados.tipo_caixa
      delete dados.tipo_caixa
    }
    const columns = Object.keys(dados).filter((column) => column !== 'id' && existentes.has(column))
    if (!existentes.has('id') || columns.length === 0) throw new Error('schema_lancamentos_incompativel')
    await this.db.prepare(
      `INSERT INTO lancamentos (id, ${columns.join(', ')}) VALUES (?1, ${columns.map((_, index) => `?${index + 2}`).join(', ')})`,
    ).bind(dados.id, ...columns.map((column) => dados[column])).run()
    const row = await this.db.prepare('SELECT * FROM lancamentos WHERE id = ?1').bind(input.id).first<Row>()
    if (!row) throw new Error('lancamento_nao_criado')
    return { lancamento: normalizarLancamento(row) }
  }

  async listarLancamentos(inicio?: string, fim?: string, caixa?: string): Promise<LancamentoFinanceiro[]> {
    const schema = await this.db.prepare("SELECT name FROM pragma_table_info('lancamentos')").all<{ name: string }>()
    const existentes = new Set((schema.results || []).map((column) => String(column.name)))
    const dataLancamento = existentes.has('data_emissao')
      ? 'data_emissao'
      : existentes.has('data_emissao_nf')
        ? 'data_emissao_nf'
        : 'criado_em'
    const caixaLancamento = existentes.has('tipo_caixa')
      ? 'tipo_caixa'
      : existentes.has('caixa')
        ? 'caixa'
        : null
    const conditions: string[] = []
    const values: unknown[] = []
    if (inicio) { conditions.push(`date(${dataLancamento}) >= ?`); values.push(inicio) }
    if (fim) { conditions.push(`date(${dataLancamento}) <= ?`); values.push(fim) }
    if (caixa && caixaLancamento) { conditions.push(`upper(COALESCE(${caixaLancamento}, 'SHARE')) = upper(?)`); values.push(caixa) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await this.db.prepare(`SELECT * FROM lancamentos ${where} ORDER BY date(${dataLancamento}) DESC, criado_em DESC`).bind(...values).all<Row>()
    const result: LancamentoFinanceiro[] = []
    for (const row of rows.results) {
      const rateios = await this.db.prepare('SELECT * FROM rateio_despesas WHERE lancamentos_id = ?1').bind(row.id).all<Row>().catch(() => ({ results: [] as Row[] }))
      result.push(normalizarLancamento(row, rateios.results.map(normalizarRateio)))
    }
    return result
  }

  async obterConsolidadoBalanco(inicio?: string, fim?: string): Promise<BalancoFinanceiro> {
    const lancamentos = await this.listarLancamentos(inicio, fim)
    const saldos = [{ caixa: 'SHARE', saldoCentavos: lancamentos.filter((item) => item.caixa === 'SHARE').reduce((total, item) => total + (item.fluxo === 'ENTRADA' ? item.valorCentavos : -item.valorCentavos), 0) }]
    return { lancamentos, saldos, matrizCompensacao: {}, holdings: [] }
  }
}
