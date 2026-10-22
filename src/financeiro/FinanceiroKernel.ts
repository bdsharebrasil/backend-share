type Row = Record<string, unknown>
type Database = D1Database

import { dateValue, isIsoDate, nullableText, text, uuid } from '../lib/strings'
import { mensagemFinanceiraStatements } from './financeiroNotifications'
import {
  allocateReceiptNumber,
  createReceiptAllocations,
  createReceiptRecord,
  updateReceiptStatus,
  validateReceiptCommand,
} from './reciboAgents'

export type FinanceOperation = 'DESPESA' | 'RECEITA' | 'REEMBOLSO'
export type FinanceFlow = 'ENTRADA' | 'SAIDA'
export type CotistaKind = 'CLIENTE' | 'HOLDING'

/**
 * Modos de um reembolso, definidos pela comparação entre o valor do recibo e o
 * valor total da despesa:
 * - RESPONSAVEL_UNICO: um cotista com 100% da despesa; os demais não participam.
 * - RESPONSAVEL_COM_BALANCO: recibo = total da despesa com rateio entre vários
 *   cotistas. Um cotista (o pagador) devolve o total à Share e o rateio serve
 *   para o ajuste do balanço entre os cotistas.
 * - PARTE_PROPRIA: recibo < total; cada cotista reembolsa a sua parte, portanto
 *   o rateio já está correto e não há ajuste depois.
 */
export type ReembolsoModo = 'RESPONSAVEL_UNICO' | 'RESPONSAVEL_COM_BALANCO' | 'PARTE_PROPRIA'

export { STATUS_LANCAMENTO } from './statuses'
export const STATUS_CONTA_PAGAR = ['EM_ABERTO', 'EM_ATRASO', 'PAGO', 'CANCELADO'] as const
export const STATUS_CONTA_RECEBER = ['EM_ABERTO', 'EM_ATRASO', 'RECEBIDO', 'PAGO', 'CANCELADO'] as const
export const STATUS_RATEIO = ['EM_ABERTO', 'PAGO', 'CANCELADO'] as const
export const STATUS_REEMBOLSO = ['PENDENTE', 'AGUARDANDO_REEMBOLSO', 'RECEBIDO', 'REEMBOLSADO', 'CANCELADO'] as const
export const STATUS_FILA = ['PENDENTE', 'PROCESSANDO', 'PROCESSADO', 'ERRO'] as const
const FILA_BACKOFF_MINUTOS = [1, 5, 15, 60]

export class FinanceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = 'FinanceError'
  }
}

const asFlag = (value: unknown): boolean =>
  value === true ||
  value === 1 ||
  ['1', 'true', 'sim', 'yes'].includes(text(value).toLowerCase())

const asPositiveCents = (value: unknown): number => {
  const cents = Number(value)
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new FinanceError(
      'valor_centavos deve ser um inteiro maior que zero',
      'valor_centavos_invalido',
    )
  }
  return cents
}

const asNonNegativeCents = (value: unknown): number => {
  const cents = Number(value)
  if (!Number.isInteger(cents) || cents < 0) {
    throw new FinanceError('valor em centavos inválido', 'valor_centavos_invalido')
  }
  return cents
}

const optionalCents = (value: unknown): number | null =>
  value == null || value === '' ? null : asPositiveCents(value)

async function resolveContaBancariaId(db: Database, value: unknown): Promise<string | null> {
  const informada = nullableText(value)
  if (!informada) return null
  const row = await db.prepare(`
    SELECT id FROM contas_bancarias
    WHERE id = ? OR banco = ? OR (banco || CASE WHEN numero_conta IS NULL OR numero_conta = '' THEN '' ELSE ' - ' || numero_conta END) = ?
    LIMIT 1
  `).bind(informada, informada, informada).first<{ id: string }>()
  return row?.id ?? null
}

const id = (): string => uuid()

const upper = (value: unknown): string => text(value).toUpperCase()

export type EscopoFinanceiro = 'FINANCEIRO' | 'CAIXA_SHARE'

// O escopo é uma decisão do servidor: o formulário nunca controla a fronteira.
function escopoFinanceiro(command: Row): EscopoFinanceiro {
  const tipo = upper(command.tipo)
  const caixa = upper(command.tipo_caixa)
  const origem = upper(command.origem_tipo)
  if (caixa === 'CLIENTE' || caixa === 'HOLDING' || tipo === 'CLIENTE' || tipo === 'REEMBOLSO') return 'FINANCEIRO'
  if (['NF_SAIDA', 'RECIBO_SAIDA', 'RECIBO_COLABORADOR', 'PAGAMENTO_FOLHA', 'DESPESA_EMPRESA', 'SOLICITACAO_COMPRA'].includes(origem)) return 'CAIXA_SHARE'
  return caixa === 'SHARE' ? 'CAIXA_SHARE' : 'FINANCEIRO'
}

// Valores aceitos pelo CHECK de tipo_rateio em rateio_despesas e rateio_hold.
const RATEIO_TYPES: readonly string[] = ['FIXO', 'VARIAVEL_POR_VOO', 'VARIAVEL_POR_HORA', 'EXTRA']
// Nomes usados pelo frontend para "dividir igualmente"; no banco viram FIXO.
const RATEIO_EQUAL_ALIASES: readonly string[] = [
  'TODOS', 'TODOS_COTISTAS', 'TODOS_OS_COTISTAS', 'IGUAL', 'IGUALMENTE',
]

const normalizeRateioType = (value: unknown): string => {
  const type = upper(value || 'FIXO').replace(/[\s-]+/g, '_')
  if (RATEIO_EQUAL_ALIASES.includes(type)) return 'FIXO'
  if (!RATEIO_TYPES.includes(type)) {
    throw new FinanceError(`Tipo de rateio inválido: ${type}`, 'tipo_rateio_invalido')
  }
  return type
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000
const PERCENTUAL_TOTAL_BASIS_POINTS = 10_000

function percentualBasisPoints(percentuais: number[]): number[] {
  const brutos = percentuais.map((percentual) => percentual * 100)
  const bases = brutos.map((bruto) => Math.floor(bruto))
  let restante = PERCENTUAL_TOTAL_BASIS_POINTS - bases.reduce((total, base) => total + base, 0)
  const ordemDosRestos = brutos.map((bruto, index) => ({ index, resto: bruto - bases[index] }))
    .sort((a, b) => b.resto - a.resto || a.index - b.index)
  for (let index = 0; index < ordemDosRestos.length && restante > 0; index += 1) {
    bases[ordemDosRestos[index].index] += 1
    restante -= 1
  }
  if (restante !== 0) throw new FinanceError('A soma dos percentuais do rateio deve ser 100%', 'rateio_percentual_invalido')
  return bases
}

/** Distribui centavos pelo maior resto, preservando exatamente o total. */
export function allocateCentsByPercentages(amount: number, percentuais: number[]): number[] {
  if (!Number.isInteger(amount) || amount <= 0 || !percentuais.length || percentuais.some((percentual) => !Number.isFinite(percentual) || percentual < 0)) {
    throw new FinanceError('Percentuais do rateio inválidos', 'rateio_percentual_invalido')
  }
  const basisPoints = percentualBasisPoints(percentuais)
  const exatos = basisPoints.map((basisPoint) => amount * basisPoint / PERCENTUAL_TOTAL_BASIS_POINTS)
  const valores = exatos.map(Math.floor)
  let restante = amount - valores.reduce((total, valor) => total + valor, 0)
  const ordemDosRestos = exatos.map((exato, index) => ({ index, resto: exato - valores[index] }))
    .sort((a, b) => b.resto - a.resto || a.index - b.index)
  for (let index = 0; index < ordemDosRestos.length && restante > 0; index += 1) {
    valores[ordemDosRestos[index].index] += 1
    restante -= 1
  }
  return valores
}

function parseAnexos(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[]
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? (parsed as Row[]) : []
  } catch {
    return []
  }
}

export function buildDocumentFields(value: unknown, cotistaId?: string | null): Row {
  const anexos = parseAnexos(value).filter((anexo) => {
    const anexoCotista = nullableText(anexo.cotista_id)
    return !cotistaId || !anexoCotista || anexoCotista === cotistaId
  })
  const find = (...tipos: string[]) => anexos.find((anexo) => tipos.includes(text(anexo.tipo).toLowerCase()))
  const nf = find('nf', 'nota', 'nota_fiscal')
  const recibo = find('recibo')
  const boleto = find('boleto')
  const documento = find('comanda', 'doc', 'documento', 'comprovante', 'outro')
  const demonstrativo = find('demonstrativo')
  return {
    numero_nf: nullableText(nf?.numero),
    numero_recibo: nullableText(recibo?.numero),
    numero_boleto: nullableText(boleto?.numero),
    numero_doc: nullableText(documento?.numero),
    numero_demonstrativo: nullableText(demonstrativo?.numero),
    url_nf: nullableText(nf?.url),
    url_recibo: nullableText(recibo?.url),
    url_boleto: nullableText(boleto?.url),
    url_doc: nullableText(documento?.url ?? demonstrativo?.url),
    url_demonstrativo: nullableText(demonstrativo?.url),
    anexos_json: JSON.stringify(anexos),
  }
}

async function buscarFornecedor(db: Database, fornecedorId: unknown): Promise<{ id: string; nome_completo: string | null } | null> {
  const idFornecedor = nullableText(fornecedorId)
  return idFornecedor
    ? db.prepare(`SELECT id, nome_completo FROM fornecedores_favoritos WHERE id = ?1
       UNION ALL
       SELECT id, nome_fornecedor AS nome_completo FROM fornecedores_combustivel WHERE id = ?1
       LIMIT 1`).bind(idFornecedor).first<{ id: string; nome_completo: string | null }>()
    : null
}

async function resolverFornecedor(
  db: Database,
  fornecedorId: unknown,
  fornecedorNome: unknown,
): Promise<{ id: string; nome_completo: string | null } | null> {
  const idOuNome = nullableText(fornecedorId)
  const nome = nullableText(fornecedorNome) || idOuNome
  if (!idOuNome && !nome) return null
  const existente = await buscarFornecedor(db, idOuNome)
  if (existente) return existente
  const favoritoExistente = nome
    ? await db.prepare(`SELECT id, nome_completo FROM fornecedores_favoritos
         WHERE lower(trim(COALESCE(nome_completo, ''))) = lower(trim(?1))
            OR lower(trim(COALESCE(apelido, ''))) = lower(trim(?1))
         LIMIT 1`).bind(nome).first<{ id: string; nome_completo: string | null }>()
    : null
  if (favoritoExistente) return favoritoExistente
  const novoId = crypto.randomUUID()
  await db.prepare(`INSERT INTO fornecedores_favoritos (id, nome_completo, apelido)
    VALUES (?, ?, ?)`).bind(novoId, nome, nome).run()
  return { id: novoId, nome_completo: nome }
}

async function resolveLancamentoMetadata(db: Database, command: Row): Promise<Row> {
  const fornecedorId = nullableText(command.fornecedor_id ?? command.fornecedores_favoritos_id)
  const fornecedor = await buscarFornecedor(db, fornecedorId)
  const tipoCaixa = upper(command.tipo_caixa)
  const categoriaId = nullableText(command.categoria_cliente_id ?? command.categoria_id)
  const categoriaTabela = tipoCaixa === 'CLIENTE' || tipoCaixa === 'HOLDING'
    ? 'categoria_movimentacao_cliente'
    : 'categoria_movimentacao_share'
  const categoria = categoriaId
    ? await db.prepare(`SELECT nome FROM ${categoriaTabela} WHERE id = ? LIMIT 1`).bind(categoriaId).first<{ nome: string | null }>()
    : null
  return {
    ...command,
    fornecedor_nome: fornecedor?.nome_completo
      ? nullableText(fornecedor.nome_completo)
      : (fornecedorId ? null : nullableText(command.fornecedor_nome ?? command.fornecedor)),
    categoria_nome: nullableText(categoria?.nome ?? command.categoria_nome ?? command.categoria),
  }
}

/** A categoria Share é a fonte de verdade do nome e do grupo do lançamento. */
export async function resolveShareLancamentoCategory(
  db: Database,
  categoryId: unknown,
): Promise<{ categoria_share_id: string; categoria_nome: string; grupo_categoria: string }> {
  const id = nullableText(categoryId)
  if (!id) throw new FinanceError('Lançamento do caixa Share exige categoria Share', 'categoria_share_obrigatoria')
  const category = await db.prepare(
    'SELECT id, nome, grupo_categoria FROM categoria_movimentacao_share WHERE id = ? LIMIT 1',
  ).bind(id).first<{ id: string; nome: string | null; grupo_categoria: string | null }>()
  if (!category?.id || !nullableText(category.nome)) {
    throw new FinanceError('Categoria Share inválida', 'categoria_share_invalida')
  }
  const group = nullableText(category.grupo_categoria)
  if (!group) throw new FinanceError('Categoria Share sem grupo de classificação', 'grupo_categoria_share_ausente')
  return {
    categoria_share_id: category.id,
    categoria_nome: category.nome!.trim(),
    grupo_categoria: group,
  }
}

/**
 * Decide o modo do reembolso a partir do valor do recibo, do total da despesa
 * e da quantidade de linhas de rateio informadas.
 */
export function resolveReembolsoModo(
  valorCentavos: number,
  totalDespesaCentavos: number | null,
  quantidadeLinhas: number,
): { modo: ReembolsoModo; total: number } {
  const total = totalDespesaCentavos ?? valorCentavos
  if (valorCentavos > total) {
    throw new FinanceError(
      'O valor do recibo não pode ser maior que o valor total da despesa',
      'valor_recibo_maior_que_total',
    )
  }
  if (valorCentavos < total) return { modo: 'PARTE_PROPRIA', total }
  return { modo: quantidadeLinhas > 1 ? 'RESPONSAVEL_COM_BALANCO' : 'RESPONSAVEL_UNICO', total }
}

// Categoria padrão do lançamento de receita e da conta a pagar do recibo.
// A categoria escolhida no formulário de recibo de pagamento pertence ao
// Caixa Cliente e não pode ser usada em contas_apagar, cuja FK aponta para
// categoria_movimentacao_share.
const CATEGORIA_SHARE_RECIBO = '73355581-c479-4a5d-b90b-90b3332f198e'

type SchemaCache = Map<string, Set<string>>
type CachedSchema = { schema: SchemaCache; expiresAt: number }
const SCHEMA_CACHE_TTL_MS = 60_000
const schemaCacheByDatabase = new WeakMap<object, CachedSchema>()

export async function loadSchema(db: Database): Promise<SchemaCache> {
  const cached = schemaCacheByDatabase.get(db as unknown as object)
  if (cached && cached.expiresAt > Date.now()) return cached.schema
  const tables = [
    'lancamentos',
    'abastecimentos',
    'contas_apagar',
    'contas_areceber',
    'rateio_despesas',
    'rateio_pagamentos',
    'rateio_hold',
    'movimentos_holding',
    'reembolsos',
    'auditoria_financeira',
    'financeiro_vinculos',
    'financeiro_fila',
    'envio_despesas',
    'recibos',
    'recibos_saida',
    'notas_fiscais_saida',
    'recibo_rateio',
    'sequencia_numeros_recibos',
    'cotista_aeronave',
    'cliente',
    'hold_socios',
    'holdings',
  ]

  const schema: SchemaCache = new Map()
  for (const table of tables) {
    const result = await db
      .prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all<{ name: string }>()

    schema.set(
      table,
      new Set((result.results || []).map((column) => String(column.name))),
    )
  }
  schemaCacheByDatabase.set(db as unknown as object, { schema, expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS })
  return schema
}

function requireTable(
  schema: SchemaCache,
  table: string,
  columns: string[] = [],
): void {
  const available = schema.get(table)
  if (!available) {
    throw new FinanceError(
      `Tabela financeira ausente: ${table}`,
      'schema_tabela_ausente',
      500,
    )
  }

  const missing = columns.filter((column) => !available.has(column))
  if (missing.length) {
    throw new FinanceError(
      `Colunas ausentes em ${table}: ${missing.join(', ')}`,
      'schema_coluna_ausente',
      500,
    )
  }
}

export async function validateFinanceSchema(db: Database): Promise<void> {
  const schema = await loadSchema(db)

  requireTable(schema, 'lancamentos', ['id', 'descricao', 'fluxo', 'valor_centavos', 'status'])
  requireTable(schema, 'contas_apagar', ['id', 'lancamentos_id', 'valor_centavos', 'status'])
  requireTable(schema, 'contas_areceber', ['id', 'valor_centavos', 'status'])
  requireTable(schema, 'rateio_despesas', ['id', 'lancamento_id', 'status'])
  requireTable(schema, 'rateio_pagamentos', ['id', 'rateio_id', 'conta_receber_id', 'valor_centavos', 'status'])
  requireTable(schema, 'rateio_hold', ['id', 'socio_id'])
  if (!schema.get('rateio_hold')?.has('movimento_id') && !schema.get('rateio_hold')?.has('movimento_holding_id')) {
    throw new FinanceError('Coluna de movimento ausente em rateio_hold', 'schema_coluna_ausente', 500)
  }
  requireTable(schema, 'movimentos_holding', ['id'])
  requireTable(schema, 'reembolsos', ['id', 'lancamento_origem_id', 'lancamento_cliente_id'])
  requireTable(schema, 'auditoria_financeira', ['id'])
  requireTable(schema, 'financeiro_vinculos', ['id', 'origem_tipo', 'origem_id', 'destino_tipo', 'destino_id', 'tipo_vinculo'])
  requireTable(schema, 'financeiro_fila', ['id', 'operacao', 'payload_json', 'status', 'processando_em'])
}

const FRONTEND_CONTRACT_FIELDS = new Set([
  'idempotency_key', 'idempotencyKey', 'reference_id', 'valor_centavos', 'valorCentavos', 'codigo_cliente',
  'tipo_recibo', 'rateado', 'recibo_id',
  'descricao', 'descricao_servico', 'fluxo', 'data', 'data_emissao', 'data_vencimento',
  'vencimento', 'aeronave_id', 'cotista_aeronave_id', 'cotista_id', 'socio_id', 'holding_id',
  'categoria_id', 'categoria_nome', 'categoria', 'categoria_cliente_id', 'categoria_cliente_nome', 'categoria_despesa_id', 'categoria_despesa_subcategoria',
  'grupo_categoria_cliente', 'fornecedor_id', 'fornecedor', 'fornecedor_nome', 'numero_doc',
  'fornecedores_favoritos_id', 'recibos_saida_id', 'origem_tipo', 'origem_id', 'periodicidade', 'tipo_caixa',
  'cliente_id', 'recebedor_id', 'recebedor_nome', 'recebedor_cpf', 'recebedor_endereco', 'recebedor_cidade', 'recebedor_uf',
  'pagador_tipo', 'pagador_id', 'categoria_movimentacao_id', 'categoria_nome_manual', 'natureza_despesa', 'anexo_id', 'numero_documento_anexo',
  'forma_pagamento', 'conta_bancaria_id', 'data_pagamento', 'comprovante_url', 'observacoes', 'numero_recibo', 'url_recibo', 'pago_diretamente', 'pagoDiretamente',
  'pago_por', 'rateio_linhas', 'rateios', 'tipo_rateio', 'reembolsavel', 'colaborador_id',
  'lancamento_id', 'lancamento_origem_id', 'motivo', 'valor', 'operacao', 'payload', 'criar_lancamento_cliente',
  'modo_lancamento', 'tipo_movimento_hold', 'grupo_categoria', 'numero_nf', 'url_nf', 'subcategoria_1',
  'subcategoria_2', 'subcategoria_3', 'subcategoria_4', 'data_competencia_demonstrativo',
  // Regra de reembolso/rateio: total da despesa e cotista que pagou/devolve.
  'valor_total_despesa_centavos', 'cotista_pagador_id', 'origem_tipo_conta',
])

function validateFrontendContract(body: Row): void {
  const unknown = Object.keys(body).filter((field) => !FRONTEND_CONTRACT_FIELDS.has(field))
  if (unknown.length) {
    throw new FinanceError(
      `Campos desconhecidos ou incompatíveis: ${unknown.join(', ')}`,
      'contrato_campo_desconhecido',
    )
  }
}

type NormalizeOptions = {
  internal?: boolean
}

function addKnownColumns(
  schema: SchemaCache,
  table: string,
  values: Row,
  required: string[] = [],
): { columns: string[]; values: unknown[] } {
  const available = schema.get(table)
  if (!available) {
    throw new FinanceError(
      `Tabela financeira ausente: ${table}`,
      'schema_tabela_ausente',
      500,
    )
  }

  for (const requiredColumn of required) {
    if (!available.has(requiredColumn)) {
      throw new FinanceError(
        `Coluna obrigatória ausente em ${table}: ${requiredColumn}`,
        'schema_coluna_ausente',
        500,
      )
    }
  }

  const incompatible = Object.keys(values).filter((column) => !available.has(column))
  if (incompatible.length) {
    throw new FinanceError(
      `Colunas incompatíveis em ${table}: ${incompatible.join(', ')}`,
      'schema_coluna_incompativel',
      500,
    )
  }

  const entries = Object.entries(values).filter(
    ([column, value]) => available.has(column) && value !== undefined,
  )

  for (const requiredColumn of required) {
    const entry = entries.find(([column]) => column === requiredColumn)
    if (!entry || entry[1] === null || entry[1] === '') {
      throw new FinanceError(
        `Valor obrigatório ausente: ${table}.${requiredColumn}`,
        'campo_obrigatorio_ausente',
      )
    }
  }

  if (!entries.length) {
    throw new FinanceError(
      `Nenhuma coluna válida para ${table}`,
      'schema_incompativel',
      500,
    )
  }

  return {
    columns: entries.map(([column]) => column),
    values: entries.map(([, value]) => value),
  }
}

export function holdingMovementColumn(schema: SchemaCache): 'movimento_id' | 'movimento_holding_id' {
  if (schema.get('rateio_hold')?.has('movimento_id')) return 'movimento_id'
  return 'movimento_holding_id'
}

function insertStatement(
  db: Database,
  schema: SchemaCache,
  table: string,
  values: Row,
  required: string[] = [],
): D1PreparedStatement {
  const prepared = addKnownColumns(schema, table, values, required)
  const placeholders = prepared.columns.map(() => '?').join(', ')
  return db
    .prepare(
      `INSERT INTO ${table} (${prepared.columns.join(', ')}) VALUES (${placeholders})`,
    )
    .bind(...prepared.values)
}

function updateStatement(
  db: Database,
  schema: SchemaCache,
  table: string,
  values: Row,
  where: string,
  whereValues: unknown[],
): D1PreparedStatement {
  const available = schema.get(table)
  if (!available) {
    throw new FinanceError(
      `Tabela financeira ausente: ${table}`,
      'schema_tabela_ausente',
      500,
    )
  }

  const incompatible = Object.keys(values).filter((column) => !available.has(column))
  if (incompatible.length) {
    throw new FinanceError(
      `Colunas incompatíveis em ${table}: ${incompatible.join(', ')}`,
      'schema_coluna_incompativel',
      500,
    )
  }

  const entries = Object.entries(values).filter(
    ([column, value]) => available.has(column) && value !== undefined,
  )
  if (!entries.length) {
    throw new FinanceError(
      `Nenhuma coluna válida para atualização em ${table}`,
      'schema_incompativel',
      500,
    )
  }

  const assignments = entries.map(([column]) => `${column} = ?`).join(', ')
  return db
    .prepare(`UPDATE ${table} SET ${assignments} WHERE ${where}`)
    .bind(...entries.map(([, value]) => value), ...whereValues)
}

function idempotencyKey(body: Row): string | null {
  return nullableText(
    body.idempotency_key ?? body.idempotencyKey ?? body.reference_id,
  )
}

function normalizeCommand(body: Row, userId: string | null, options: NormalizeOptions = {}): Row {
  if (!options.internal) validateFrontendContract(body)
  const valorCentavos = asPositiveCents(
    body.valor_centavos ?? body.valorCentavos,
  )
  const descricao = text(body.descricao ?? body.descricao_servico)
  if (!descricao) {
    throw new FinanceError('Descrição obrigatória', 'descricao_obrigatoria')
  }

  const fluxo = upper(body.fluxo || 'SAIDA') as FinanceFlow
  if (!['ENTRADA', 'SAIDA'].includes(fluxo)) {
    throw new FinanceError('Fluxo inválido', 'fluxo_invalido')
  }
  const dataEmissaoInformada = nullableText(body.data_emissao ?? body.data)
  if (!dataEmissaoInformada) {
    throw new FinanceError('Data de emissão obrigatória', 'data_emissao_obrigatoria')
  }
  if (!isIsoDate(dataEmissaoInformada)) {
    throw new FinanceError('Data de emissão inválida', 'data_emissao_invalida')
  }

  const firstLine = (
    Array.isArray(body.rateio_linhas) ? body.rateio_linhas[0]
      : Array.isArray(body.rateios) ? body.rateios[0]
        : null
  ) as Row | null

  return {
    ...body,
    idempotency_key: idempotencyKey(body),
    valor_centavos: valorCentavos,
    descricao,
    fluxo,
    data: dateValue(dataEmissaoInformada),
    data_emissao: dateValue(dataEmissaoInformada),
    data_vencimento: nullableText(body.data_vencimento ?? body.vencimento),
    aeronave_id: nullableText(body.aeronave_id),
    cotista_aeronave_id: nullableText(
      body.cotista_aeronave_id ?? body.cotista_id ??
      firstLine?.cotista_id ?? firstLine?.cotista_aeronave_id ?? firstLine?.id,
    ),
    socio_id: nullableText(body.socio_id),
    holding_id: nullableText(body.holding_id),
    fornecedor_id: nullableText(body.fornecedor_id ?? body.fornecedores_favoritos_id),
    fornecedor_nome: nullableText(body.fornecedor_nome ?? body.fornecedor),
    periodicidade: nullableText(body.periodicidade),
    criado_por: userId,
  }
}

async function findExistingByIdempotency(
  db: Database,
  schema: SchemaCache,
  key: string | null,
): Promise<Row | null> {
  if (!key) return null

  for (const table of [
    'lancamentos',
    'movimentos_holding',
    'contas_apagar',
    'contas_areceber',
    'reembolsos',
  ]) {
    if (!schema.get(table)?.has('idempotency_key')) continue
    const row = await db
      .prepare(`SELECT * FROM ${table} WHERE idempotency_key = ? LIMIT 1`)
      .bind(key)
      .first<Row>()
    if (row) return { ...row, idempotent: true }
  }

  // movimentos_holding não tem coluna idempotency_key: a chave fica em
  // financeiro_vinculos (origem IDEMPOTENCY_KEY -> MOVIMENTO_HOLDING).
  const link = await db
    .prepare(
      `SELECT destino_id FROM financeiro_vinculos
        WHERE origem_tipo = 'IDEMPOTENCY_KEY' AND origem_id = ? AND destino_tipo = 'MOVIMENTO_HOLDING'
        LIMIT 1`,
    )
    .bind(key)
    .first<{ destino_id: string }>()
    .catch(() => null)
  if (link?.destino_id) {
    const movimento = await db
      .prepare('SELECT * FROM movimentos_holding WHERE id = ?')
      .bind(link.destino_id)
      .first<Row>()
    if (movimento) return { ...movimento, movimento_holding_id: movimento.id, idempotent: true }
  }

  const envioLink = await db.prepare(`SELECT destino_id FROM financeiro_vinculos
    WHERE origem_tipo='IDEMPOTENCY_KEY' AND origem_id=?
      AND destino_tipo='ENVIO_DESPESA' AND tipo_vinculo='IDEMPOTENCIA' LIMIT 1`)
    .bind(key).first<{ destino_id: string }>()
  if (envioLink) {
    const envio = await db.prepare('SELECT * FROM envio_despesas WHERE id=?')
      .bind(envioLink.destino_id).first<Row>()
    if (envio) {
      const rateios = await db.prepare(`SELECT id FROM rateio_despesas WHERE lancamento_id=?
        UNION ALL SELECT id FROM rateio_hold WHERE origem_tipo='ENVIO_DESPESA' AND origem_id=?`)
        .bind(envioLink.destino_id, envioLink.destino_id).all<Row>()
      return { id: envioLink.destino_id, envio_id: envioLink.destino_id, lancamento_id: null,
        movimento_holding_id: null, rateio_ids: (rateios.results || []).map(r => r.id),
        conta_pagar_id: null, status: 'PAGO', idempotent: true }
    }
  }

  return null
}

type CotistaContext = {
  kind: CotistaKind
  cotistaAeronaveId: string
  aeronaveId: string | null
  clienteId: string | null
  socioId: string | null
  holdingId: string | null
  nome: string | null
  percentualSociedade: number | null
}

async function resolveCotista(
  db: Database,
  command: Row,
): Promise<CotistaContext | null> {
  const cotistaId = nullableText(command.cotista_aeronave_id)
  const socioId = nullableText(command.socio_id)
  if (!cotistaId && !socioId) return null

  const row = await db
    .prepare(
      `SELECT ca.id AS cotista_aeronave_id,
              ca.aeronave_id,
              ca.cliente_id,
              ca.socio_id,
              ca.percentual_sociedade,
              hs.holding_id,
              COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome
         FROM cotista_aeronave ca
         LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
         LEFT JOIN cliente cl ON cl.id = ca.cliente_id
        WHERE COALESCE(ca.status, 'ativo') <> 'inativo'
          AND ((? <> '' AND ca.id = ?) OR (? <> '' AND ca.socio_id = ?))`,
    )
    .bind(cotistaId || '', cotistaId || '', socioId || '', socioId || '')
    .first<Row>()

  if (!row) {
    throw new FinanceError(
      'Cotista da aeronave não encontrado',
      'cotista_nao_encontrado',
      404,
    )
  }

  const isHolding = Boolean(row.socio_id)
  return {
    kind: isHolding ? 'HOLDING' : 'CLIENTE',
    cotistaAeronaveId: String(row.cotista_aeronave_id),
    aeronaveId: nullableText(row.aeronave_id),
    clienteId: nullableText(row.cliente_id),
    socioId: nullableText(row.socio_id),
    holdingId: nullableText(row.holding_id),
    nome: nullableText(row.nome),
    percentualSociedade: row.percentual_sociedade != null ? Number(row.percentual_sociedade) : null,
  }
}

type AllocationLine = {
  cotistaId: string
  socioId: string | null
  holdingId: string | null
  percentual: number
  percentualSociedade: number
  valorCentavos: number
  pagoPor: string | null
  pagoDiretamente: boolean
  // Valor efetivamente pago atribuído a esta linha (base do ajuste de balanço).
  valorPagoRealCentavos: number | null
}

function allocationLines(body: Row): AllocationLine[] {
  if (body.sem_rateio === true) return []

  const supplied = Array.isArray(body.rateio_linhas)
    ? body.rateio_linhas
    : Array.isArray(body.rateios)
      ? body.rateios
      : []

  if (!supplied.length) {
    const cotistaId = nullableText(body.cotista_aeronave_id)
    if (!cotistaId) return []
    return [
      {
        cotistaId,
        socioId: nullableText(body.socio_id),
        holdingId: nullableText(body.holding_id),
        percentual: 100,
        percentualSociedade: 100,
        valorCentavos: asPositiveCents(body.valor_centavos),
        pagoPor: nullableText(body.pago_por),
        pagoDiretamente: asFlag(
          body.pago_diretamente ?? body.pagoDiretamente,
        ),
        valorPagoRealCentavos: null,
      },
    ]
  }

  const amount = asPositiveCents(body.valor_centavos)
  const lines: AllocationLine[] = supplied.map((line: Row) => ({
    // Rateios de holding são identificados pelo sócio, enquanto rateios de
    // cliente usam o cotista_aeronave. O mesmo comando atende os dois fluxos.
    cotistaId: text(line.cotista_id ?? line.cotista_aeronave_id ?? line.socio_id),
    socioId: nullableText(line.socio_id),
    holdingId: nullableText(line.holding_id),
    percentual: Number(line.percentual ?? line.percentual_sociedade ?? 0),
    percentualSociedade: Number(line.percentual_sociedade ?? line.percentual ?? 0),
    valorCentavos: line.valor_centavos != null ? asPositiveCents(line.valor_centavos) : 0,
    pagoPor: nullableText(line.pago_por ?? line.pagoPor),
    pagoDiretamente: asFlag(
      line.pago_diretamente ?? line.pagoDiretamente ?? body.pago_diretamente ?? body.pagoDiretamente,
    ),
    valorPagoRealCentavos:
      line.valor_pago_real_centavos != null ? asNonNegativeCents(line.valor_pago_real_centavos) : null,
  }))

  if (lines.some((line) => !line.cotistaId || !Number.isFinite(line.percentual) || line.percentual < 0)) {
    throw new FinanceError(
      'Todo rateio precisa de cotista',
      'rateio_cotista_obrigatorio',
    )
  }

  const percentualTotal = lines.reduce((sum, line) => sum + line.percentual, 0)
  if (Math.abs(percentualTotal - 100) > 0.01) {
    throw new FinanceError('A soma dos percentuais do rateio deve ser 100%', 'rateio_percentual_invalido')
  }
  const valoresCalculados = allocateCentsByPercentages(amount, lines.map((line) => line.percentual))
  lines.forEach((line, index) => { line.valorCentavos = valoresCalculados[index] })
  const total = lines.reduce((sum, line) => sum + line.valorCentavos, 0)
  if (total !== amount) {
    throw new FinanceError(
      'A soma do rateio deve ser igual ao valor da operação',
      'rateio_total_invalido',
    )
  }

  return lines
}

async function receiptAllocationLines(
  db: Database,
  command: Row,
  input: Row,
): Promise<Row[]> {
  if (Array.isArray(command.rateio_linhas) || Array.isArray(command.rateios)) {
    return (command.rateio_linhas ?? command.rateios) as Row[]
  }

  const tipoRateio = upper(command.tipo_rateio)
  if (!RATEIO_EQUAL_ALIASES.includes(tipoRateio)) {
    return []
  }

  const aeronaveId = text(input.aeronave_id ?? command.aeronave_id)
  if (!aeronaveId) {
    throw new FinanceError('Aeronave obrigatória para rateio', 'rateio_aeronave_obrigatoria')
  }
  const cotistas = await db.prepare(
    "SELECT id, percentual_sociedade FROM cotista_aeronave WHERE aeronave_id = ? AND COALESCE(status, 'ativo') <> 'inativo' ORDER BY id",
  ).bind(aeronaveId).all<{ id: string; percentual_sociedade: number | null }>()
  const ids = cotistas.results ?? []
  if (!ids.length) {
    throw new FinanceError('Nenhum cotista encontrado para a aeronave', 'rateio_cotistas_invalidos')
  }

  const amount = asPositiveCents(input.valor_centavos)
  const percentual = 100 / ids.length
  const valores = allocateCentsByPercentages(amount, ids.map(() => percentual))
  return ids.map(({ id: cotistaId, percentual_sociedade }, index) => ({
    cotista_id: cotistaId,
    percentual: round3(percentual),
    percentual_sociedade: percentual_sociedade == null ? null : Number(percentual_sociedade),
    valor_centavos: valores[index],
  }))
}

function linhasRateioPagasPelaEmpresa(linhas: Row[]): Row[] {
  return linhas.map((linha) => ({
    ...linha,
    pago_por: null,
    pago_diretamente: false,
    valor_pago_real_centavos: 0,
  }))
}

async function validateAllocationLines(
  db: Database,
  command: Row,
  lines: AllocationLine[],
  amount: number,
): Promise<void> {
  if (!lines.length) return
  if (!nullableText(command.aeronave_id)) {
    throw new FinanceError('Aeronave obrigatória para rateio', 'rateio_aeronave_obrigatoria')
  }
  const ids = [...new Set(lines.map((line) => line.cotistaId))]
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await db.prepare(
    `SELECT id FROM cotista_aeronave WHERE id IN (${placeholders}) AND aeronave_id = ? AND COALESCE(status, 'ativo') <> 'inativo'`,
  ).bind(...ids, command.aeronave_id).all<{ id: string }>()
  if ((rows.results || []).length !== ids.length) {
    throw new FinanceError('Todos os cotistas do rateio devem pertencer à aeronave', 'rateio_cotistas_invalidos')
  }
  const percentual = lines.reduce((sum, line) => sum + line.percentual, 0)
  if (Math.abs(percentual - 100) > 0.01) {
    throw new FinanceError('A soma dos percentuais do rateio deve ser 100%', 'rateio_percentual_invalido')
  }
  const total = lines.reduce((sum, line) => sum + line.valorCentavos, 0)
  if (total !== amount) {
    throw new FinanceError('A soma dos valores do rateio deve ser igual ao valor da operação', 'rateio_valor_invalido')
  }
}

function auditStatement(
  db: Database,
  schema: SchemaCache,
  entity: string,
  entityId: string,
  operation: string,
  userId: string | null,
  oldValue: number | null,
  newValue: number | null,
  reason: string | null,
  key: string | null,
): D1PreparedStatement {
  return insertStatement(
    db,
    schema,
    'auditoria_financeira',
    {
      id: id(),
      entidade: entity,
      entidade_id: entityId,
      operacao: operation,
      valor_anterior_centavos: oldValue,
      valor_novo_centavos: newValue,
      usuario_id: userId,
      motivo: reason,
      idempotency_key: key,
    },
    ['id', 'entidade', 'entidade_id', 'operacao'],
  )
}

function linkStatement(
  db: Database,
  schema: SchemaCache,
  origemTipo: string,
  origemId: string,
  destinoTipo: string,
  destinoId: string,
  tipoVinculo: string,
  _userId: string | null,
): D1PreparedStatement {
  requireTable(schema, 'financeiro_vinculos', ['id', 'origem_tipo', 'origem_id', 'destino_tipo', 'destino_id', 'tipo_vinculo'])
  return db.prepare(
    `INSERT OR IGNORE INTO financeiro_vinculos
       (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id(), origemTipo, origemId, destinoTipo, destinoId, tipoVinculo)
}

async function linkedAbastecimentoId(db: Database, receiptId: string): Promise<string | null> {
  const row = await db.prepare(`
    SELECT destino_id FROM financeiro_vinculos
     WHERE origem_tipo = 'RECIBO'
       AND origem_id = ?
       AND destino_tipo = 'ABASTECIMENTO'
       AND tipo_vinculo = 'RECIBO_ABASTECIMENTO'
     LIMIT 1
  `).bind(receiptId).first<{ destino_id: string }>()
  return row?.destino_id ?? null
}

function clientAllocationStatements(
  db: Database,
  schema: SchemaCache,
  command: Row,
  lancamentoId: string | null,
  lines: AllocationLine[],
  userId: string | null,
  rateioIds?: string[],
): D1PreparedStatement[] {
  const amount = asPositiveCents(command.valor_centavos)
  // Total da despesa: pode ser maior que o valor lançado quando o recibo cobre
  // apenas a parte de um cotista.
  const totalDespesa = optionalCents(command.valor_total_despesa_centavos) ?? amount
  const anexos = parseAnexos(command.anexos_json)
  return lines.map((line, index) => {
    const rateioId = rateioIds?.[index] ?? id()
    const anexosDaLinha = anexos.filter((anexo) => !anexo.cotista_id || anexo.cotista_id === line.cotistaId)
    const rateioValues: Row = {
      id: rateioId,
      lancamento_id: lancamentoId,
      cotista_id: line.cotistaId,
      aeronave_id: command.aeronave_id,
      data_emissao: dateValue(command.data_emissao ?? command.data),
      data_vencimento: nullableText(command.data_vencimento ?? command.vencimento),
      periodicidade: nullableText(command.periodicidade),
      categoria_id: nullableText(command.categoria_cliente_id ?? command.categoria_id ?? command.categoria_movimentacao_id),
      categoria_nome: nullableText(command.categoria_nome ?? command.categoria),
      subcategoria_1: nullableText(command.subcategoria_1),
      subcategoria_2: nullableText(command.subcategoria_2),
      subcategoria_3: nullableText(command.subcategoria_3),
      subcategoria_4: nullableText(command.subcategoria_4),
      fornecedor_id: nullableText(command.fornecedor_id),
      tipo_rateio: normalizeRateioType(command.tipo_rateio),
      percentual_sociedade: line.percentualSociedade,
      percentual_uso: line.percentual,
      valor_total_centavos: totalDespesa,
      valor_rateado_centavos: line.valorCentavos,
      valor_pago_real_centavos: line.valorPagoRealCentavos ?? (line.pagoDiretamente ? line.valorCentavos : 0),
      pago_por: line.pagoPor || (line.pagoDiretamente ? line.cotistaId : null),
      pago_diretamente: line.pagoDiretamente ? 1 : 0,
      status: command.deferir_baixa_rateio === true
        ? 'EM_ABERTO'
        : line.pagoDiretamente ? 'PAGO_DIRETAMENTE' : 'EM_ABERTO',
      data_pagamento: line.pagoDiretamente ? dateValue(command.data_pagamento ?? command.data) : null,
      email_enviado_em: nullableText(command.email_enviado_em),
      descricao_despesa: command.descricao,
      observacoes: nullableText(command.observacoes),
      origem_id: nullableText(command.recibo_id),
      origem_tipo: nullableText(command.recibo_id) ? 'RECIBO' : null,
      numero_recibo: nullableText(command.numero_recibo),
      url_recibo: nullableText(command.url_recibo),
      ...buildDocumentFields(anexosDaLinha, line.cotistaId),
      criado_por: userId,
    }
    const available = schema.get('rateio_despesas')
    const compatibleRateioValues = Object.fromEntries(
      Object.entries(rateioValues).filter(([column]) => available?.has(column)),
    )
    return insertStatement(
      db,
      schema,
      'rateio_despesas',
      compatibleRateioValues,
      ['id', 'cotista_id', 'aeronave_id'],
    )
  })
}

/** Persiste apenas parcelas de cliente; o id do envio é a referência do rateio. */
export async function createClientExpenseRateios(
  db: Database,
  body: Row,
  userId: string | null,
  options: NormalizeOptions = {},
): Promise<Row> {
  const sourceId = nullableText(body.lancamento_id)
  if (!sourceId) throw new FinanceError('Envio de despesa obrigatório para o rateio', 'envio_despesa_obrigatorio')
  const schema = await loadSchema(db)
  const command = normalizeCommand({ ...body, tipo_caixa: 'CLIENTE', sem_rateio: false }, userId, options)
  const lines = allocationLines(command)
  if (!lines.length) throw new FinanceError('Despesa de cliente precisa de rateio', 'rateio_obrigatorio')
  const rateioIds = lines.map(() => id())
  await db.batch(clientAllocationStatements(db, schema, command, sourceId, lines, userId, rateioIds))
  return { id: sourceId, lancamento_id: sourceId, rateio_ids: rateioIds, movimentacao_id: null, status: 'EM_ABERTO', idempotent: false }
}

function holdingAllocationStatements(
  db: Database,
  schema: SchemaCache,
  command: Row,
  movimentoId: string | null,
  lines: AllocationLine[],
  userId: string | null,
): D1PreparedStatement[] {
  const amount = asPositiveCents(command.valor_centavos)
  const totalDespesa = optionalCents(command.valor_total_despesa_centavos) ?? amount
  return lines.map((line) => {
    if (!line.socioId) {
      throw new FinanceError(
        'Rateio de holding precisa de socio_id',
        'socio_holding_obrigatorio',
      )
    }

    const values: Row = {
      id: id(),
      [holdingMovementColumn(schema)]: movimentoId,
      aeronave_id: command.aeronave_id,
      socio_id: line.socioId,
      data_emissao: dateValue(command.data_emissao ?? command.data),
      data_vencimento: nullableText(command.data_vencimento ?? command.vencimento),
      periodicidade: nullableText(command.periodicidade),
      // rateio_hold.categoria_id referencia categoria_movimentacao_cliente.
      categoria_id: nullableText(command.categoria_cliente_id),
      categoria_nome: nullableText(
        command.categoria_nome ?? command.categoria,
      ),
      tipo_rateio: normalizeRateioType(command.tipo_rateio),
      percentual_sociedade: line.percentualSociedade,
      percentual_uso: line.percentual,
      valor_total_centavos: totalDespesa,
      valor_rateado_centavos: line.valorCentavos,
      valor_pago_real_centavos:
        line.valorPagoRealCentavos ?? (line.pagoDiretamente ? line.valorCentavos : 0),
      pago_por: line.pagoPor,
      pago_diretamente: line.pagoDiretamente ? 1 : 0,
      status: line.pagoDiretamente ? 'PAGO' : 'EM_ABERTO',
      data_pagamento: line.pagoDiretamente ? dateValue(command.data_pagamento ?? command.data) : null,
      descricao_despesa: command.descricao,
      observacoes: nullableText(command.observacoes),
      origem_id: nullableText(command.origem_id ?? command.recibo_id),
      origem_tipo: nullableText(command.origem_tipo) || (nullableText(command.recibo_id) ? 'RECIBO' : null),
      documento_numero: nullableText(command.numero_nf) ?? nullableText(command.numero_recibo),
      documento_url: nullableText(command.url_nf) ?? nullableText(command.url_recibo),
      numero_nf: nullableText(command.numero_nf),
      url_nf: nullableText(command.url_nf),
      email_enviado_em: null,
      criado_por: userId,
    }
    const available = schema.get('rateio_hold')
    if (available && !available.has('numero_nf') && nullableText(command.numero_nf) && available.has('documento_numero')) {
      values.documento_numero = nullableText(command.numero_nf)
    }
    if (available && !available.has('url_nf') && nullableText(command.url_nf) && available.has('documento_url')) {
      values.documento_url = nullableText(command.url_nf)
    }
    const compatibleValues = Object.fromEntries(
      Object.entries(values).filter(([column]) => available?.has(column)),
    )
    return insertStatement(
      db,
      schema,
      'rateio_hold',
      compatibleValues,
      ['id', holdingMovementColumn(schema), 'aeronave_id', 'socio_id'],
    )
  })
}

export async function createExpense(
  db: Database,
  body: Row,
  userId: string | null,
  options: NormalizeOptions = {},
): Promise<Row> {
  const schema = await loadSchema(db)
  const command = await resolveLancamentoMetadata(db, normalizeCommand(body, userId, options))
  const escopo = escopoFinanceiro(command)
  const existing = await findExistingByIdempotency(
    db,
    schema,
    String(command.idempotency_key || '') || null,
  )
  if (existing) return existing

  const context = await resolveCotista(db, command)
  const shareCategory = upper(command.tipo_caixa) === 'SHARE'
    ? await resolveShareLancamentoCategory(db, command.categoria_id)
    : null
  const rawLines = allocationLines(command)
  const lines = await Promise.all(rawLines.map(async (line) => {
    if (line.socioId) return line
    const row = await db.prepare(`
      SELECT ca.socio_id, hs.holding_id
        FROM cotista_aeronave ca
        LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
       WHERE ca.id = ?
       LIMIT 1
    `).bind(line.cotistaId).first<{ socio_id: string | null; holding_id: string | null }>()
    return row
      ? { ...line, socioId: nullableText(row.socio_id), holdingId: nullableText(row.holding_id) }
      : line
  }))
  const direct = asFlag(
    command.pago_diretamente ?? command.pagoDiretamente,
  )
  const reembolsavel = asFlag(command.reembolsavel)
  const amount = asPositiveCents(command.valor_centavos)
  // A validação por cotista_aeronave é exclusiva do fluxo de cliente. No
  // holding, as linhas são validadas por socio_id em holdingAllocationStatements.
  if (context?.kind !== 'HOLDING') {
    await validateAllocationLines(db, command, lines, amount)
  } else if (lines.length) {
    const socioIds = [...new Set(lines.map((line) => line.socioId).filter(Boolean))] as string[]
    if (!socioIds.length) throw new FinanceError('Rateio de holding precisa de socio_id', 'socio_holding_obrigatorio')
    const placeholders = socioIds.map(() => '?').join(', ')
    const ativos = await db.prepare(`SELECT DISTINCT socio_id FROM cotista_aeronave WHERE socio_id IN (${placeholders}) AND aeronave_id = ? AND COALESCE(status, 'ativo') <> 'inativo'`).bind(...socioIds, command.aeronave_id).all<{ socio_id: string }>()
    if ((ativos.results || []).length !== socioIds.length) throw new FinanceError('Todos os sócios do rateio devem estar ativos na aeronave', 'rateio_cotistas_invalidos')
  }

  if (direct) {
    if (!lines.length) throw new FinanceError('Despesa direta precisa de rateio', 'rateio_obrigatorio')
    const sourceId = nullableText(body.lancamento_id)
    const source = sourceId
      ? await db.prepare('SELECT id, aeronave_id FROM envio_despesas WHERE id=?').bind(sourceId).first<Row>()
      : null
    if (sourceId && (!source || source.aeronave_id !== command.aeronave_id)) {
      throw new FinanceError('Envio de despesa inválido para a aeronave', 'envio_despesa_invalido')
    }
    const envioId = sourceId || id()
    const diretoCommand = { ...command, origem_tipo: 'ENVIO_DESPESA', origem_id: envioId }
    const rateioIds = lines.map(() => id())
    const allocationStatements = context?.kind === 'HOLDING'
      ? holdingAllocationStatements(db, schema, diretoCommand, null, lines, userId)
      : clientAllocationStatements(db, schema, diretoCommand, envioId, lines, userId, rateioIds)
    const key = nullableText(command.idempotency_key)
    const statements: D1PreparedStatement[] = [
      ...(source ? [] : [insertStatement(db, schema, 'envio_despesas', {
        id: envioId, tipo: 'cliente', descricao: command.descricao, valor: amount / 100,
        valor_total_despesa: (optionalCents(command.valor_total_despesa_centavos) ?? amount) / 100,
        aeronave_id: command.aeronave_id, data_despesa: dateValue(command.data_emissao ?? command.data),
        vencimento: nullableText(command.data_vencimento ?? command.vencimento),
        tipo_caixa: context?.kind === 'HOLDING' ? 'HOLDING' : 'CLIENTE',
        pago_diretamente: 1, pago_por: nullableText(command.pago_por ?? command.cotista_pagador_id),
        status: 'CONVERTIDO', criado_por: userId, criado_em: new Date().toISOString(),
        categoria_id: nullableText(command.categoria_id), categoria_nome: nullableText(command.categoria_nome),
        categoria_cliente_id: nullableText(command.categoria_cliente_id),
        tipo_rateio: normalizeRateioType(command.tipo_rateio), periodicidade: nullableText(command.periodicidade),
        escopo_financeiro: escopo,
      }, ['id', 'aeronave_id', 'descricao', 'valor'])]),
      ...allocationStatements,
      ...(key ? [db.prepare(`INSERT INTO financeiro_vinculos
        (id,origem_tipo,origem_id,destino_tipo,destino_id,tipo_vinculo)
        VALUES (?,'IDEMPOTENCY_KEY',?,'ENVIO_DESPESA',?,'IDEMPOTENCIA')`).bind(id(),key,envioId)] : []),
      auditStatement(db,schema,'envio_despesas',envioId,'CRIACAO_DESPESA_DIRETA',userId,
        null,amount,nullableText(command.motivo),key),
    ]
    // O índice de idempotência faz a segunda escrita concorrente abortar o batch inteiro.
    await db.batch(statements)
    const result = context?.kind === 'HOLDING'
      ? await db.prepare("SELECT id FROM rateio_hold WHERE origem_tipo='ENVIO_DESPESA' AND origem_id=?").bind(envioId).all<Row>()
      : await db.prepare('SELECT id FROM rateio_despesas WHERE lancamento_id=?').bind(envioId).all<Row>()
    return { id: envioId, envio_id: envioId, lancamento_id: null, movimento_holding_id: null,
      rateio_ids: (result.results || []).map(r => r.id), conta_pagar_id: null,
      valor_centavos: amount, status: 'PAGO', idempotent: false }
  }

  if (context?.kind === 'HOLDING') {
    if (!lines.length && !text(command.recibo_id)) {
      throw new FinanceError(
        'Despesa de holding precisa de rateio',
        'rateio_holding_obrigatorio',
      )
    }
    const movimentoId = text(command.id) || id()
    const idempotency = nullableText(command.idempotency_key)
    const statements = [
      insertStatement(
        db,
        schema,
        'movimentos_holding',
        {
          id: movimentoId,
          escopo_financeiro: escopo,
          holding_id: context.holdingId,
          socio_id: context.socioId,
          aeronave_id: context.aeronaveId || command.aeronave_id,
          periodicidade: nullableText(command.periodicidade),
          data_emissao: command.data,
          data_vencimento: nullableText(command.data_vencimento),
          data_pagamento: direct ? dateValue(command.data_pagamento ?? command.data) : null,
          descricao: command.descricao,
          abastecimentos_id: nullableText(command.abastecimentos_id),
          fornecedor_nome: nullableText(command.fornecedor_nome ?? command.fornecedor),
          fornecedor_id: nullableText(command.fornecedor_id),
          // movimentos_holding.categoria_id referencia categoria_movimentacao_cliente.
          categoria_id: nullableText(command.categoria_cliente_id),
          categoria_nome: nullableText(
            command.categoria_nome ?? command.categoria,
          ),
          grupo_categoria: nullableText(command.grupo_categoria),
          colaborador_id: nullableText(command.colaborador_id),
          fluxo: 'SAIDA',
          tipo_caixa: 'HOLD',
          valor_centavos: amount,
          pago_diretamente: direct ? 1 : 0,
          status: direct ? 'PAGO' : 'EM_ABERTO',
          numero_recibo: nullableText(command.numero_recibo),
          url_recibo: nullableText(command.url_recibo),
          criado_por: userId,
          observacoes: nullableText(command.observacoes),
        },
        ['id', 'aeronave_id'],
      ),
      ...holdingAllocationStatements(
        db,
        schema,
        { ...command, aeronave_id: context.aeronaveId || command.aeronave_id },
        movimentoId,
        lines,
        userId,
      ),
      ...(idempotency
        ? [linkStatement(db, schema, 'IDEMPOTENCY_KEY', idempotency, 'MOVIMENTO_HOLDING', movimentoId, 'IDEMPOTENCIA', userId)]
        : []),
      auditStatement(
        db,
        schema,
        'movimentos_holding',
        movimentoId,
        'CRIACAO_DESPESA',
        userId,
        null,
        amount,
        nullableText(command.motivo),
        idempotency,
      ),
    ]

    await db.batch(statements)
    return {
      id: movimentoId,
      movimento_holding_id: movimentoId,
      valor_centavos: amount,
      status: direct ? 'PAGO' : 'EM_ABERTO',
      idempotent: false,
    }
  }


  const lancamentoId = text(command.id) || id()
  const ehDespesaCliente = String(command.tipo_caixa || '').toUpperCase() === 'CLIENTE'
  const contaPagarId = ehDespesaCliente ? null : id()
  const status = 'EM_ABERTO'
  const statements = [
    insertStatement(
      db,
      schema,
      'lancamentos',
      {
        id: lancamentoId,
        escopo_financeiro: escopo,
        aeronave_id: command.aeronave_id,
        cotista_aeronave_id: command.cotista_aeronave_id,
        descricao: command.descricao,
        fornecedor_nome: nullableText(command.fornecedor_nome ?? command.fornecedor),
        fornecedores_favoritos_id: nullableText(command.fornecedor_id),
        categoria_share_id: ehDespesaCliente ? null : shareCategory!.categoria_share_id,
        categoria_cliente_id: ehDespesaCliente ? nullableText(command.categoria_cliente_id ?? command.categoria_id) : null,
        categoria_nome: ehDespesaCliente
          ? nullableText(command.categoria_nome ?? command.categoria ?? 'SEM CATEGORIA')
          : shareCategory!.categoria_nome,
        grupo_categoria: ehDespesaCliente ? 'CAIXA CLIENTE' : shareCategory!.grupo_categoria,
        periodicidade: nullableText(command.periodicidade),
        ...buildDocumentFields(command.anexos_json),
        subcategoria_1: nullableText(command.subcategoria_1),
        subcategoria_2: nullableText(command.subcategoria_2),
        subcategoria_3: nullableText(command.subcategoria_3),
        subcategoria_4: nullableText(command.subcategoria_4),
        fluxo: 'SAIDA',
        tipo_caixa: ehDespesaCliente ? 'CLIENTE' : 'SHARE',
        valor_centavos: amount,
        status,
        data_emissao: command.data,
        data_vencimento: command.data_vencimento,
        numero_doc: nullableText(command.numero_doc),
        pago_diretamente: 0,
        reembolsavel: reembolsavel ? 1 : 0,
        reembolso_quitado: 0,
        origem_tipo: 'DESPESA',
        origem_id: lancamentoId,
        idempotency_key: command.idempotency_key,
        criado_por: userId,
        colaborador_id: nullableText(command.colaborador_id),
        observacoes: nullableText(command.observacoes),
      },
      ['id', 'descricao', 'fluxo', 'valor_centavos'],
    ),
    ...(contaPagarId ? [insertStatement(
      db,
      schema,
      'contas_apagar',
      {
        id: contaPagarId,
        data_vencimento: command.data_vencimento || command.data,
        valor_centavos: amount,
        categoria_id: nullableText(command.categoria_id),
        categoria_nome: nullableText(
          command.categoria_nome ?? command.categoria,
        ),
        colaborador_id: nullableText(command.colaborador_id),
        descricao: command.descricao,
        aeronave_id: command.aeronave_id,
        fornecedor_id: nullableText(command.fornecedor_id),
        cotista_id: command.cotista_aeronave_id,
        lancamentos_id: lancamentoId,
        criado_por: userId,
        // SOLICITACAO_PAGAMENTO / SOLICITACAO_COMPRA marcam contas que não
        // pertencem à lista de Contas a pagar da empresa.
        origem_tipo: nullableText(command.origem_tipo_conta) || 'DESPESA',
        idempotency_key: command.idempotency_key,
        status,
      },
      ['id', 'data_vencimento', 'valor_centavos', 'lancamentos_id'],
    )] : []),
    ...clientAllocationStatements(
      db,
      schema,
      command,
      lancamentoId,
      lines,
      userId,
    ),
    auditStatement(
      db,
      schema,
      'lancamentos',
      lancamentoId,
      'CRIACAO_DESPESA',
      userId,
      null,
      amount,
      nullableText(command.motivo),
      nullableText(command.idempotency_key),
    ),
  ]

  await db.batch(statements)
  return {
    id: lancamentoId,
    lancamento_id: lancamentoId,
    contaPagarId,
    valor_centavos: amount,
    status,
    idempotent: false,
  }
}

/**
 * Despesa do caixa do cliente paga diretamente por um cotista, com ajuste de
 * balanço. O cotista pagador fica com valor_pago_real igual ao total pago e os
 * demais ficam com 0 (devendo a parte deles), sem gerar reembolso para a Share.
 * Se houver uma única linha (100% de um cotista), é apenas pagamento direto.
 */
export async function createDirectExternalExpense(
  db: Database,
  body: Row,
  userId: string | null,
  options: NormalizeOptions = {},
): Promise<Row> {
  const lines = allocationLines(normalizeCommand(body, userId, options))
  if (!lines.length) {
    throw new FinanceError('Despesa direta precisa de rateio', 'rateio_obrigatorio')
  }

  if (body.pago_diretamente !== undefined && !asFlag(body.pago_diretamente)) {
    const rateioPendente = lines.map((line) => ({
      cotista_id: line.cotistaId,
      socio_id: line.socioId,
      holding_id: line.holdingId,
      percentual: line.percentual,
      percentual_sociedade: line.percentualSociedade,
      valor_centavos: line.valorCentavos,
      pago_por: null,
      pago_diretamente: false,
      valor_pago_real_centavos: 0,
    }))
    return createExpense(db, {
      ...body,
      rateio_linhas: rateioPendente,
      cotista_pagador_id: null,
      pago_por: null,
      pago_diretamente: false,
      tipo_caixa: body.tipo_caixa || 'CLIENTE',
      reembolsavel: false,
    }, userId, options)
  }

  const total = asPositiveCents(body.valor_centavos ?? body.valorCentavos)
  const pagador = nullableText(body.cotista_pagador_id) || lines[0].cotistaId
  if (!lines.some((line) => line.cotistaId === pagador)) {
    throw new FinanceError(
      'O cotista que pagou precisa participar do rateio',
      'pagador_fora_do_rateio',
    )
  }

  const rateioLinhas = lines.map((line) => {
    const ehPagador = line.cotistaId === pagador
    return {
      cotista_id: line.cotistaId,
      socio_id: line.socioId,
      holding_id: line.holdingId,
      percentual: line.percentual,
      percentual_sociedade: line.percentualSociedade,
      valor_centavos: line.valorCentavos,
      pago_por: pagador,
      pago_diretamente: ehPagador,
      valor_pago_real_centavos: ehPagador ? total : 0,
    }
  })

  return createExpense(
    db,
    {
      ...body,
      rateio_linhas: rateioLinhas,
      cotista_pagador_id: pagador,
      pago_diretamente: true,
      reembolsavel: false,
    },
    userId,
    options,
  )
}

export async function issueRevenue(
  db: Database,
  body: Row,
  userId: string | null,
  options: NormalizeOptions = {},
  buildAdditionalStatements?: (context: {
    lancamentoId: string
    contaReceberId: string
    lancamentoClienteId: string | null
    movimentoHoldingId: string | null
  }) => D1PreparedStatement[],
): Promise<Row> {
  const schema = await loadSchema(db)
  const command = normalizeCommand({ ...body, fluxo: 'ENTRADA' }, userId, options)
  const escopo = escopoFinanceiro(command)
  const existing = await findExistingByIdempotency(
    db,
    schema,
    String(command.idempotency_key || '') || null,
  )
  if (existing) return existing

  const context = await resolveCotista(db, command)
  const documentoSaida = ['RECIBO_SAIDA', 'NF_SAIDA'].includes(upper(command.origem_tipo))
  const shareCategory = await resolveShareLancamentoCategory(
    db,
    command.categoria_id,
  )
  // O cliente_id de cotista_aeronave referencia a tabela D1 `cliente`.
  // Valide contra essa tabela antes de gravar o vínculo direto em lancamentos;
  // cotista_aeronave_id continua preservando o vínculo de negócio.
  const clienteLancamento = context?.clienteId
    ? await db.prepare('SELECT id FROM cliente WHERE id = ? LIMIT 1')
      .bind(context.clienteId).first<{ id: string }>()
    : null
  const amount = asPositiveCents(command.valor_centavos)
  const lancamentoId = id()
  const contaReceberId = id()
  const clientLancamentoId =
    context?.kind === 'CLIENTE' && body.criar_lancamento_cliente !== false
      ? id()
      : null

  const notaFiscalSaida = upper(command.origem_tipo) === 'NF_SAIDA'
  if (notaFiscalSaida && context?.kind === 'HOLDING' && (!context.holdingId || !context.socioId)) {
    throw new FinanceError('Cotista Holding sem sócio ou holding vinculado', 'holding_cotista_incompleto')
  }
  const movimentoHoldingId = notaFiscalSaida && context?.kind === 'HOLDING' ? id() : null
  if (upper(command.origem_tipo) === 'RECIBO_SAIDA' && !clientLancamentoId) {
    throw new FinanceError('Recibo ADM exige vínculo de cotista cliente. Para holding, utilize o fluxo de documento da holding.', 'recibo_sem_destino_economico', 409)
  }

  const statements: D1PreparedStatement[] = [
    insertStatement(
      db,
      schema,
      'lancamentos',
      {
        id: lancamentoId,
        escopo_financeiro: escopo,
        aeronave_id: context?.aeronaveId || command.aeronave_id,
        cotista_aeronave_id:
          context?.cotistaAeronaveId || command.cotista_aeronave_id,
        descricao: command.descricao,
        fornecedor_nome: documentoSaida ? 'SHARE BRASIL' : nullableText(command.fornecedor_nome ?? context?.nome),
        fornecedores_favoritos_id: nullableText(command.fornecedor_id),
        fluxo: notaFiscalSaida ? 'RECEITA' : 'ENTRADA',
        tipo_caixa: 'SHARE',
        valor_centavos: amount,
        categoria_share_id: shareCategory.categoria_share_id,
        categoria_nome: shareCategory.categoria_nome,
        grupo_categoria: shareCategory.grupo_categoria,
        numero_nf: nullableText(command.numero_nf),
        url_nf: nullableText(command.url_nf),
        periodicidade: nullableText(command.periodicidade ?? (upper(command.origem_tipo) === 'RECIBO_SAIDA' ? 'MENSAL' : null)),
        data_emissao: command.data,
        data_vencimento: command.data_vencimento || command.data,
        origem_tipo: nullableText(command.origem_tipo) || 'RECEITA',
        origem_id: nullableText(command.origem_id),
        status: 'EM_ABERTO',
        colaborador_id: nullableText(command.colaborador_id),
        criado_por: userId,
      },
      ['id', 'descricao', 'fluxo', 'valor_centavos'],
    ),
    insertStatement(
      db,
      schema,
      'contas_areceber',
      {
        id: contaReceberId,
        data_vencimento: command.data_vencimento || command.data,
        valor_centavos: amount,
        categoria_id: nullableText(command.categoria_id),
        categoria_nome: nullableText(
          command.categoria_nome ?? 'RECEITAS OPERACIONAIS',
        ),
        descricao: command.descricao,
        aeronave_id: context?.aeronaveId || command.aeronave_id,
        cotista_id: context?.cotistaAeronaveId || command.cotista_aeronave_id,
        lancamentos_id: lancamentoId,
        ...(movimentoHoldingId ? { movimentos_id: movimentoHoldingId } : {}),
        origem_tipo: nullableText(command.origem_tipo) || 'RECEITA',
        idempotency_key: command.idempotency_key,
        criado_por: userId,
        status: 'EM_ABERTO',
      },
      ['id', 'valor_centavos'],
    ),
  ]

  if (clientLancamentoId) {
    const clientRateioId = id()
    const reciboSaida = documentoSaida
    statements.push(
      insertStatement(
        db,
        schema,
        'lancamentos',
        {
          id: clientLancamentoId,
          escopo_financeiro: 'FINANCEIRO',
          aeronave_id: context?.aeronaveId || command.aeronave_id,
          cotista_aeronave_id: context?.cotistaAeronaveId,
          cliente_id: clienteLancamento?.id ?? null,
          descricao: command.descricao,
          fluxo: 'SAIDA',
          tipo_caixa: 'CLIENTE',
          valor_centavos: amount,
          categoria_share_id: null,
          categoria_cliente_id: nullableText(
            command.categoria_cliente_id,
          ),
          categoria_nome: nullableText(
            command.categoria_cliente_nome ?? command.categoria_nome,
          ),
          fornecedor_nome: documentoSaida ? 'SHARE BRASIL' : nullableText(command.fornecedor_nome ?? context?.nome),
          fornecedores_favoritos_id: nullableText(command.fornecedor_id),
          grupo_categoria: 'CAIXA CLIENTE',
          data_emissao: command.data,
          data_vencimento: command.data_vencimento || command.data,
          periodicidade: nullableText(command.periodicidade ?? 'MENSAL'),
          numero_recibo: nullableText(command.numero_recibo),
          url_recibo: nullableText(command.url_recibo),
          numero_nf: nullableText(command.numero_nf),
          url_nf: nullableText(command.url_nf),
          origem_tipo: documentoSaida ? upper(command.origem_tipo) : 'RECEITA',
          origem_id: lancamentoId,
          status: 'EM_ABERTO',
          criado_por: userId,
        },
        ['id', 'descricao', 'fluxo', 'valor_centavos'],
      ),
      insertStatement(
        db,
        schema,
        'rateio_despesas',
        {
          id: clientRateioId,
          lancamento_id: clientLancamentoId,
          categoria_id: nullableText(command.categoria_cliente_id),
          categoria_nome: nullableText(command.categoria_cliente_nome ?? command.categoria_nome),
          subcategoria_1: nullableText(command.categoria_despesa_subcategoria),
          cotista_id: context?.cotistaAeronaveId || command.cotista_aeronave_id,
          aeronave_id: context?.aeronaveId || command.aeronave_id,
          tipo_rateio: 'FIXO',
          periodicidade: nullableText(command.periodicidade ?? 'MENSAL'),
          data_emissao: command.data,
          data_vencimento: command.data_vencimento || command.data,
          fornecedor_id: nullableText(command.fornecedor_id),
          descricao_despesa: command.descricao,
          pago_por: reciboSaida ? null : (context?.cotistaAeronaveId || command.cotista_aeronave_id),
          pago_diretamente: reciboSaida ? 0 : 1,
          percentual_sociedade: context?.percentualSociedade ?? 100,
          percentual_uso: 100,
          valor_total_centavos: amount,
          valor_rateado_centavos: amount,
          valor_pago_real_centavos: reciboSaida ? 0 : amount,
          status: reciboSaida ? 'EM_ABERTO' : 'PAGO_DIRETAMENTE',
          numero_recibo: nullableText(command.numero_recibo),
          url_recibo: nullableText(command.url_recibo),
          numero_nf: nullableText(command.numero_nf),
          url_nf: nullableText(command.url_nf),
          email_enviado_em: null,
          origem_tipo: documentoSaida ? upper(command.origem_tipo) : 'RECEITA',
        },
        ['id', 'lancamento_id'],
      ),
    )

    if (!reciboSaida) {
      statements.push(
        insertStatement(
          db,
          schema,
          'rateio_pagamentos',
          {
            id: id(),
            rateio_id: clientRateioId,
            recibo_id: nullableText(command.recibo_id),
            conta_receber_id: null,
            tipo_pagador: 'COTISTA',
            pagador_cotista_id: context?.cotistaAeronaveId || command.cotista_aeronave_id,
            pagador_holding_id: null,
            valor_centavos: amount,
            data_pagamento: dateValue(command.data_pagamento ?? command.data),
            conta_bancaria_id: nullableText(command.conta_bancaria_id),
            comprovante_url: nullableText(command.comprovante_url),
            forma_pagamento: nullableText(command.forma_pagamento),
            status: 'CONFIRMADO',
            observacoes: nullableText(command.observacoes),
            idempotency_key: `DIRETO:${command.idempotency_key || clientLancamentoId}:${clientRateioId}`,
            criado_por: userId,
          },
          ['id', 'rateio_id', 'valor_centavos'],
        ),
      )
    }
  }

  if (movimentoHoldingId && context?.holdingId && context.socioId) {
    if (!schema.get('contas_areceber')?.has('movimentos_id')) {
      throw new FinanceError('Coluna contas_areceber.movimentos_id ausente para nota de saída de holding', 'schema_coluna_ausente', 500)
    }
    const movementValues: Row = {
      id: movimentoHoldingId,
      escopo_financeiro: 'FINANCEIRO',
      holding_id: context.holdingId,
      socio_id: context.socioId,
      aeronave_id: context.aeronaveId || command.aeronave_id,
      data_emissao: command.data,
      data_vencimento: command.data_vencimento || command.data,
      descricao: command.descricao,
      categoria_id: nullableText(command.categoria_cliente_id),
      categoria_nome: nullableText(command.categoria_cliente_nome ?? command.categoria_nome),
      grupo_categoria: nullableText(command.grupo_categoria_cliente) || 'ADM SHARE BRASIL',
      fornecedor_nome: 'SHARE BRASIL',
      fluxo: 'SAIDA',
      tipo_caixa: 'HOLD',
      valor_centavos: amount,
      status: 'EM_ABERTO',
      numero_nf: nullableText(command.numero_nf),
      url_nf: nullableText(command.url_nf),
      email_enviado_em: null,
      criado_por: userId,
    }
    const movementColumns = schema.get('movimentos_holding')
    const compatibleMovementValues = Object.fromEntries(
      Object.entries(movementValues).filter(([column]) => movementColumns?.has(column)),
    )
    statements.push(insertStatement(db, schema, 'movimentos_holding', compatibleMovementValues, ['id', 'holding_id', 'socio_id', 'aeronave_id']))
    const holdingRateio: AllocationLine[] = [{
      cotistaId: context.cotistaAeronaveId,
      socioId: context.socioId,
      holdingId: context.holdingId,
      percentual: 100,
      percentualSociedade: context.percentualSociedade ?? 100,
      valorCentavos: amount,
      pagoPor: null,
      pagoDiretamente: false,
      valorPagoRealCentavos: 0,
    }]
    statements.push(...holdingAllocationStatements(db, schema, {
      ...command,
      aeronave_id: context.aeronaveId || command.aeronave_id,
      categoria_nome: command.categoria_cliente_nome ?? command.categoria_nome,
      numero_nf: command.numero_nf,
      url_nf: command.url_nf,
      origem_tipo: 'NF_SAIDA',
    }, movimentoHoldingId, holdingRateio, userId))
    statements.push(linkStatement(db, schema, 'NF_SAIDA', text(command.origem_id), 'MOVIMENTO_HOLDING', movimentoHoldingId, 'NF_SAIDA_MOVIMENTO', userId))
  }

  statements.push(
    auditStatement(
      db,
      schema,
      'lancamentos',
      lancamentoId,
      'CRIACAO_RECEITA',
      userId,
      null,
      amount,
      nullableText(command.motivo),
      nullableText(command.idempotency_key),
    ),
  )

  if (buildAdditionalStatements) {
    statements.push(...buildAdditionalStatements({
      lancamentoId,
      contaReceberId,
      lancamentoClienteId: clientLancamentoId,
      movimentoHoldingId,
    }))
  }

  await db.batch(statements)
  return {
    id: lancamentoId,
    lancamento_id: lancamentoId,
    contaReceberId,
    lancamentoClienteId: clientLancamentoId,
    movimentoHoldingId,
    lancamento_cliente_id: clientLancamentoId,
    valor_centavos: amount,
    status: 'EM_ABERTO',
    idempotent: false,
  }
}

/**
 * Reembolso comum: cria o registro em reembolsos, a entrada Share, o lançamento
 * do cliente, o rateio do cliente e a conta a receber. O comportamento depende
 * do modo (ver ReembolsoModo), definido por valor_centavos versus
 * valor_total_despesa_centavos e pelas linhas de rateio.
 */
export async function createReimbursement(
  db: Database,
  body: Row,
  userId: string | null,
  options: NormalizeOptions = {},
): Promise<Row> {
  const schema = await loadSchema(db)
  const command = await resolveLancamentoMetadata(db, normalizeCommand(body, userId, options))
  const origemEscopo = await db.prepare('SELECT escopo_financeiro FROM lancamentos WHERE id = ?').bind(String(command.lancamento_origem_id ?? command.lancamento_id ?? '')).first<{ escopo_financeiro: EscopoFinanceiro }>()
  const escopo = origemEscopo?.escopo_financeiro || 'FINANCEIRO'
  const originalId = text(
    command.lancamento_origem_id ?? command.lancamento_id,
  )
  if (!originalId) {
    throw new FinanceError(
      'Lançamento de origem obrigatório',
      'lancamento_origem_obrigatorio',
    )
  }

  const existing = await db
    .prepare(
      'SELECT id, conta_receber_id, lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ? ORDER BY criado_em DESC LIMIT 1',
    )
    .bind(originalId)
    .first<Row>()
  if (existing) return { ...existing, idempotent: true }

  const amount = asPositiveCents(command.valor_centavos)
  const rawLines = allocationLines(command)
  const totalDespesa = optionalCents(command.valor_total_despesa_centavos)
  const { modo, total } = resolveReembolsoModo(amount, totalDespesa, rawLines.length)

  if (modo === 'PARTE_PROPRIA' && rawLines.length > 1) {
    throw new FinanceError(
      'Quando o recibo é menor que o total da despesa, cada cotista reembolsa a sua parte: informe uma única linha de rateio',
      'reembolso_parte_propria_uma_linha',
    )
  }

  const pagadorId =
    nullableText(command.cotista_pagador_id) ||
    rawLines[0]?.cotistaId ||
    nullableText(command.cotista_aeronave_id)
  if (!pagadorId) {
    throw new FinanceError('Cotista do reembolso obrigatório', 'reembolso_cotista_invalido')
  }
  if (modo === 'RESPONSAVEL_COM_BALANCO' && !rawLines.some((line) => line.cotistaId === pagadorId)) {
    throw new FinanceError(
      'O cotista responsável pelo reembolso precisa participar do rateio',
      'pagador_fora_do_rateio',
    )
  }

  const context = await resolveCotista(db, {
    cotista_aeronave_id: pagadorId,
    socio_id: null,
  })
  if (!context || context.kind !== 'CLIENTE') {
    throw new FinanceError(
      'Reembolso comum precisa de cotista cliente',
      'reembolso_cotista_invalido',
    )
  }

  if (modo === 'RESPONSAVEL_COM_BALANCO') {
    await validateAllocationLines(
      db,
      { ...command, aeronave_id: context.aeronaveId },
      rawLines,
      amount,
    )
  }

  const rateioBase: AllocationLine[] = modo === 'RESPONSAVEL_COM_BALANCO'
    ? rawLines
    : [{
      cotistaId: context.cotistaAeronaveId,
      socioId: null,
      holdingId: null,
      percentual: modo === 'PARTE_PROPRIA' ? round3((amount / total) * 100) : 100,
      percentualSociedade: context.percentualSociedade ?? 100,
      valorCentavos: amount,
      pagoPor: null,
      pagoDiretamente: false,
      valorPagoRealCentavos: 0,
    }]

  const reimbursementId = id()
  const shareLancamentoId = id()
  const clientLancamentoId = id()
  const contaReceberId = id()
  const rateioIds = rateioBase.map(() => id())
  const shareCategory = await resolveShareLancamentoCategory(db, command.categoria_id)

  await db.batch([
    insertStatement(
      db,
      schema,
      'reembolsos',
      {
        id: reimbursementId,
        lancamento_origem_id: originalId,
        conta_receber_id: contaReceberId,
        lancamento_cliente_id: clientLancamentoId,
        cotista_id: context.cotistaAeronaveId,
        colaborador_id: nullableText(command.colaborador_id),
        valor_centavos: amount,
        status: 'PENDENTE',
        idempotency_key: command.idempotency_key,
        criado_por: userId,
      },
      ['id', 'lancamento_origem_id', 'valor_centavos'],
    ),
    insertStatement(
      db,
      schema,
      'lancamentos',
      {
        id: shareLancamentoId,
        escopo_financeiro: escopo,
        aeronave_id: context.aeronaveId,
        cotista_aeronave_id: context.cotistaAeronaveId,
        descricao: command.descricao || 'Reembolso de despesa',
        categoria_share_id: shareCategory.categoria_share_id,
        categoria_cliente_id: nullableText(command.categoria_cliente_id ?? command.categoria_id),
        categoria_nome: shareCategory.categoria_nome,
        grupo_categoria: shareCategory.grupo_categoria,
        periodicidade: nullableText(command.periodicidade),
        fornecedores_favoritos_id: nullableText(command.fornecedor_id),
        fornecedor_nome: nullableText(command.fornecedor_nome ?? command.fornecedor),
        ...buildDocumentFields(command.anexos_json),
        subcategoria_1: nullableText(command.subcategoria_1),
        subcategoria_2: nullableText(command.subcategoria_2),
        subcategoria_3: nullableText(command.subcategoria_3),
        subcategoria_4: nullableText(command.subcategoria_4),
        fluxo: 'ENTRADA',
        tipo_caixa: 'SHARE',
        valor_centavos: amount,
        status: 'EM_ABERTO',
        data_emissao: command.data,
        data_vencimento: command.data_vencimento || command.data,
        origem_tipo: 'REEMBOLSO',
        origem_id: reimbursementId,
        colaborador_id: nullableText(command.colaborador_id),
        criado_por: userId,
      },
      ['id', 'descricao', 'fluxo', 'valor_centavos'],
    ),
    insertStatement(
      db,
      schema,
      'lancamentos',
      {
        id: clientLancamentoId,
        aeronave_id: context.aeronaveId,
        cotista_aeronave_id: context.cotistaAeronaveId,
        descricao: command.descricao || 'Reembolso de despesa',
        // lancamentos.categoria_share_id referencia a categoria Share; a categoria
        // do cliente fica em categoria_cliente_id.
        categoria_share_id: null,
        categoria_cliente_id: nullableText(command.categoria_cliente_id),
        categoria_nome: nullableText(
          command.categoria_cliente_nome ?? command.categoria_nome ?? 'REEMBOLSO',
        ),
        grupo_categoria: 'CAIXA CLIENTE',
        periodicidade: nullableText(command.periodicidade),
        fornecedores_favoritos_id: nullableText(command.fornecedor_id),
        fornecedor_nome: nullableText(command.fornecedor_nome ?? command.fornecedor),
        ...buildDocumentFields(command.anexos_json),
        subcategoria_1: nullableText(command.subcategoria_1),
        subcategoria_2: nullableText(command.subcategoria_2),
        subcategoria_3: nullableText(command.subcategoria_3),
        subcategoria_4: nullableText(command.subcategoria_4),
        fluxo: 'SAIDA',
        tipo_caixa: 'CLIENTE',
        valor_centavos: amount,
        status: 'EM_ABERTO',
        data_emissao: command.data,
        data_vencimento: command.data_vencimento || command.data,
        origem_tipo: 'REEMBOLSO',
        origem_id: reimbursementId,
        criado_por: userId,
      },
      ['id', 'descricao', 'fluxo', 'valor_centavos'],
    ),
    insertStatement(
      db,
      schema,
      'contas_areceber',
      {
        id: contaReceberId,
        data_vencimento: command.data_vencimento || command.data,
        valor_centavos: amount,
        descricao: command.descricao || 'Reembolso de despesa',
        categoria_nome: 'REEMBOLSOS ENTRADAS',
        aeronave_id: context.aeronaveId,
        cotista_id: context.cotistaAeronaveId,
        lancamentos_id: shareLancamentoId,
        origem_tipo: 'REEMBOLSO',
        idempotency_key: command.idempotency_key,
        criado_por: userId,
        status: 'EM_ABERTO',
      },
      ['id', 'valor_centavos'],
    ),
    ...rateioBase.map((line, index) => insertStatement(
      db,
      schema,
      'rateio_despesas',
      {
        id: rateioIds[index],
        lancamento_id: clientLancamentoId,
        cotista_id: line.cotistaId,
        aeronave_id: context.aeronaveId,
        data_emissao: command.data,
        data_vencimento: command.data_vencimento || command.data,
        periodicidade: nullableText(command.periodicidade),
        categoria_id: nullableText(command.categoria_cliente_id),
        categoria_nome: nullableText(command.categoria_cliente_nome ?? command.categoria_nome),
        subcategoria_1: nullableText(command.subcategoria_1),
        subcategoria_2: nullableText(command.subcategoria_2),
        subcategoria_3: nullableText(command.subcategoria_3),
        subcategoria_4: nullableText(command.subcategoria_4),
        ...buildDocumentFields(command.anexos_json, line.cotistaId),
        tipo_rateio: normalizeRateioType(command.tipo_rateio),
        percentual_sociedade: line.percentualSociedade,
        percentual_uso: line.percentual,
        valor_total_centavos: total,
        valor_rateado_centavos: line.valorCentavos,
        valor_pago_real_centavos: 0,
        pago_diretamente: 0,
        status: 'AGUARDANDO_REEMBOLSO',
        descricao_despesa: command.descricao || 'Reembolso de despesa',
        origem_id: reimbursementId,
        origem_tipo: 'REEMBOLSO',
        criado_por: userId,
      },
      ['id', 'cotista_id', 'aeronave_id'],
    )),
    auditStatement(
      db,
      schema,
      'reembolsos',
      reimbursementId,
      'CRIACAO_REEMBOLSO',
      userId,
      null,
      amount,
      nullableText(command.motivo),
      nullableText(command.idempotency_key),
    ),
  ])

  return {
    id: reimbursementId,
    contaReceberId,
    lancamentoId: shareLancamentoId,
    lancamentoClienteId: clientLancamentoId,
    lancamento_cliente_id: clientLancamentoId,
    rateio_ids: rateioIds,
    modo,
    valor_centavos: amount,
    valor_total_despesa_centavos: total,
    status: 'PENDENTE',
    idempotent: false,
  }
}

export async function settlePayable(db: Database, payableId: string, body: Row, userId: string | null): Promise<Row> {
  const schema = await loadSchema(db)
  const row = await db.prepare('SELECT * FROM contas_apagar WHERE id = ?').bind(payableId).first<Row>()
  if (!row) throw new FinanceError('Conta a pagar não encontrada', 'nao_encontrado', 404)
  const requestKey = idempotencyKey(body)
  if (requestKey) {
    const prior = await db.prepare("SELECT id FROM auditoria_financeira WHERE entidade = 'contas_apagar' AND entidade_id = ? AND operacao = 'BAIXA' AND idempotency_key = ? LIMIT 1").bind(payableId, requestKey).first<Row>()
    if (prior) return { ...row, idempotent: true }
  }
  if (upper(row.status) === 'PAGO') return { ...row, idempotent: true }
  if (upper(row.status) === 'CANCELADO') throw new FinanceError('Conta cancelada não pode ser paga', 'conta_cancelada')

  const lancamentoId = nullableText(row.lancamentos_id ?? row.lancamento_id)
  const movimentoHoldingId = nullableText(row.movimentos_id)
  if (!lancamentoId && !movimentoHoldingId) throw new FinanceError('Conta a pagar sem lançamento ou movimento vinculado', 'origem_obrigatoria')
  const lancamento = lancamentoId
    ? await db.prepare('SELECT id, tipo_caixa, fluxo, status FROM lancamentos WHERE id = ?').bind(lancamentoId).first<Row>()
    : null
  const movimentoHolding = movimentoHoldingId
    ? await db.prepare('SELECT id, holding_id, fluxo, status FROM movimentos_holding WHERE id = ?').bind(movimentoHoldingId).first<Row>()
    : null
  if (lancamentoId && !lancamento) throw new FinanceError('Lançamento da conta a pagar não encontrado', 'lancamento_nao_encontrado')
  if (movimentoHoldingId && !movimentoHolding) throw new FinanceError('Movimento Holding da conta a pagar não encontrado', 'movimento_holding_nao_encontrado')
  const caixa = movimentoHolding ? 'HOLDING' : upper(lancamento?.tipo_caixa)
  const fluxo = upper(movimentoHolding?.fluxo ?? lancamento?.fluxo)
  if (!['SHARE', 'HOLDING'].includes(caixa) || !['SAIDA', 'DESPESA'].includes(fluxo)) {
    throw new FinanceError('A conta a pagar deve estar vinculada a uma despesa Share ou Holding', 'conta_pagar_origem_invalida')
  }

  const paymentDate = dateValue(body.data_pagamento ?? body.dataPagamento)
  const amount = asPositiveCents(row.valor_centavos)
  const bank = await resolveContaBancariaId(db, body.conta_bancaria_id ?? body.banco_pagamento ?? body.bancoPagamento)
  if (!bank) throw new FinanceError('Conta bancária do pagamento não encontrada', 'conta_bancaria_obrigatoria')
  if (movimentoHolding) {
    const bankRow = await db.prepare("SELECT id FROM contas_bancarias WHERE id = ? AND tipo_caixa = 'HOLDING' AND holding_id = ? AND ativo = 1").bind(bank, movimentoHolding.holding_id).first<Row>()
    if (!bankRow) throw new FinanceError('A conta bancária não pertence à holding do movimento', 'conta_bancaria_holding_invalida')
  }
  const now = new Date().toISOString()
  // A solicitação de compra fica APROVADO até a conversão e CONVERTIDO depois;
  // nos dois casos a baixa deve concluí-la e avisar o solicitante.
  const purchase = lancamentoId
    ? await db.prepare("SELECT id, descricao, criado_por, solicitacao_compra_id FROM envio_despesas WHERE lancamento_id = ? AND tipo = 'share' AND status IN ('APROVADO', 'CONVERTIDO') LIMIT 1").bind(lancamentoId).first<Row>()
    : null
  const statements: D1PreparedStatement[] = [
    updateStatement(db, schema, 'contas_apagar', { status: 'PAGO', data_pagamento: paymentDate, banco_pagamento: bank, comprovante_pagamento_url: nullableText(body.comprovante_url ?? body.comprovante_pagamento_url ?? body.comprovantePagamentoUrl), atualizado_em: now }, 'id = ?', [payableId]),
    ...(lancamentoId ? [updateStatement(db, schema, 'lancamentos', { status: 'PAGO', data_pagamento: paymentDate, conta_bancaria_id: bank, comprovante_url: nullableText(body.comprovante_url ?? body.comprovantePagamentoUrl), forma_pagamento: nullableText(body.forma_pagamento ?? body.formaPagamento), atualizado_em: now }, 'id = ?', [lancamentoId])] : []),
    ...(movimentoHoldingId ? [updateStatement(db, schema, 'movimentos_holding', { status: 'PAGO', data_pagamento: paymentDate, conta_bancaria_id: bank, comprovante_url: nullableText(body.comprovante_url ?? body.comprovantePagamentoUrl), forma_pagamento: nullableText(body.forma_pagamento ?? body.formaPagamento), atualizado_em: now }, 'id = ?', [movimentoHoldingId]), db.prepare("UPDATE rateio_hold SET status = 'PAGO', data_pagamento = ?, valor_pago_real_centavos = valor_rateado_centavos, atualizado_em = CURRENT_TIMESTAMP WHERE movimento_id = ? AND status <> 'CANCELADO'").bind(paymentDate, movimentoHoldingId)] : []),
    auditStatement(db, schema, 'contas_apagar', payableId, 'BAIXA', userId, amount, amount, nullableText(body.motivo), requestKey),
    ...(purchase ? [
      db.prepare("UPDATE envio_despesas SET status = 'CONCLUIDO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('APROVADO', 'CONVERTIDO')").bind(purchase.id),
      ...(purchase.solicitacao_compra_id ? [db.prepare("UPDATE solicitacoes_compra SET status = 'CONCLUIDA', data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?").bind(purchase.solicitacao_compra_id)] : []),
      ...mensagemFinanceiraStatements(db, nullableText(purchase.criado_por), userId, 'Solicitação de compra concluída', `O pagamento da solicitação “${text(purchase.descricao)}” foi concluído em ${paymentDate}.`),
    ] : []),
  ]
  await db.batch(statements)
  return { ...(await db.prepare('SELECT * FROM contas_apagar WHERE id = ?').bind(payableId).first<Row>()), idempotent: false }
}

type RealPayment = { idempotency_key?: string | null; data_pagamento?: string | null; conta_bancaria_id?: string | null; comprovante_url?: string | null; forma_pagamento?: string | null; observacoes?: string | null; tipo_pagador: 'COTISTA' | 'SHARE' | 'HOLDING'; pagador_cotista_id?: string | null; pagador_holding_id?: string | null; valor_centavos: number; rateios: Array<{ rateio_id: string; valor_centavos: number }> }

export async function settleReceivable(db: Database, receivableId: string, body: Row, userId: string | null): Promise<Row> {
  const schema = await loadSchema(db)
  const revision = await readSettlementRevision(db, `receber:${receivableId}`)
  const row = await db.prepare('SELECT * FROM contas_areceber WHERE id = ?').bind(receivableId).first<Row>()
  if (!row) throw new FinanceError('Conta a receber não encontrada', 'nao_encontrado', 404)
  if (['RECEBIDO', 'PAGO'].includes(upper(row.status))) {
    const requested = Array.isArray(body.pagamentos) ? body.pagamentos as RealPayment[] : []
    const saved = (await db.prepare("SELECT * FROM rateio_pagamentos WHERE conta_receber_id = ? AND status = 'CONFIRMADO'").bind(receivableId).all<Row>()).results || []
    if (!requested.length || !requested.every(p => receiptReplayMatches(p, saved))) throw new FinanceError('Conta já recebida. Recarregue os dados antes de registrar outro pagamento.', 'conta_ja_recebida', 409)
    return { ...row, idempotent: true }
  }
  if (upper(row.status) === 'CANCELADO') throw new FinanceError('Conta a receber cancelada não pode ser baixada', 'conta_cancelada')

  const payments = Array.isArray(body.pagamentos) ? body.pagamentos as RealPayment[] : []
  if (!payments.length) throw new FinanceError('Informe pelo menos um pagador real', 'pagadores_obrigatorios')
  const total = asPositiveCents(row.valor_centavos)
  const movimentoHoldingId = nullableText(row.movimentos_id)
  const documentoSaida = ['NF_SAIDA', 'RECIBO_SAIDA'].includes(upper(row.origem_tipo))
  const reimbursement = await db.prepare('SELECT * FROM reembolsos WHERE conta_receber_id = ? LIMIT 1').bind(receivableId).first<Row>()
  const resolved = await resolveReceivableAllocation(db, row)
  const rateioLancamentoId = reimbursement
    ? nullableText(reimbursement.lancamento_cliente_id) ?? nullableText((await db.prepare("SELECT id FROM lancamentos WHERE origem_id = ? AND tipo_caixa = 'CLIENTE' LIMIT 1").bind(reimbursement.id).first<Row>())?.id) ?? resolved.lancamentoId
    : resolved.lancamentoId
  const shareId = resolved.shareLancamentoId ?? nullableText(row.lancamentos_id ?? row.lancamento_id)
  const shareLancamento = shareId
    ? await db.prepare('SELECT tipo_caixa, fluxo FROM lancamentos WHERE id = ?').bind(shareId).first<Row>()
    : null
  const isShareRevenue = upper(shareLancamento?.tipo_caixa) === 'SHARE'
    && ['ENTRADA', 'RECEITA'].includes(upper(shareLancamento?.fluxo))
  let rateios = { results: resolved.rateios }
  const statements: D1PreparedStatement[] = [settlementRevisionStatement(db, `receber:${receivableId}`, revision)]
  const rateiosLegadosShare = reimbursement && rateioLancamentoId && !(rateios.results || []).length && nullableText(reimbursement.lancamento_origem_id)
    ? await db.prepare("SELECT id, valor_rateado_centavos, valor_pago_real_centavos FROM rateio_despesas WHERE lancamento_id = ? AND status NOT IN ('CANCELADO')").bind(reimbursement.lancamento_origem_id).all<Row>()
    : { results: [] as Row[] }
  if (rateiosLegadosShare.results?.length) rateios = rateiosLegadosShare
  for (const rateio of rateiosLegadosShare.results || []) {
    statements.push(db.prepare('UPDATE rateio_despesas SET lancamento_id = ? WHERE id = ? AND lancamento_id = ?').bind(rateioLancamentoId, rateio.id, reimbursement!.lancamento_origem_id))
  }
  if (reimbursement && rateioLancamentoId) {
    for (const rateio of rateios.results || []) {
      if (nullableText(rateio.lancamento_id) && nullableText(rateio.lancamento_id) !== rateioLancamentoId) {
        statements.push(db.prepare('UPDATE rateio_despesas SET lancamento_id = ? WHERE id = ? AND lancamento_id = ?').bind(rateioLancamentoId, rateio.id, rateio.lancamento_id))
      }
    }
  }
  if (!rateios.results.length) throw new FinanceError('Obrigação sem rateio vinculado. Regularize a emissão antes de registrar o pagamento.', 'rateio_nao_vinculado', 409)
  if (documentoSaida && rateios.results.reduce((sum, r) => sum + Number(r.valor_rateado_centavos), 0) !== total) throw new FinanceError('Total dos rateios diferente do valor da conta. Regularize antes de receber.', 'rateio_total_divergente', 409)
  const allowed = new Map((rateios.results || []).map(r => [String(r.id), Number(r.valor_rateado_centavos)]))
  const rateioPadraoId = (rateios.results || []).length === 1 ? String(rateios.results![0].id) : null
  const existingByRateio = new Map<string, number>()
  const paidByPayments = new Map<string, number>()
  const existingKeys = new Set<string>()
  const existing = await db.prepare("SELECT * FROM rateio_pagamentos WHERE conta_receber_id = ? AND status = 'CONFIRMADO'").bind(receivableId).all<Row>()
  for (const rateio of rateios.results || []) {
    const paid = Number(rateio.valor_pago_real_centavos || 0)
    if (paid > 0) existingByRateio.set(String(rateio.id), paid)
  }
  for (const payment of existing.results || []) {
    const rid = String(payment.rateio_id)
    const paidFromPayments = Number(payment.valor_centavos || 0)
    paidByPayments.set(rid, (paidByPayments.get(rid) || 0) + paidFromPayments)
    if (payment.idempotency_key) existingKeys.add(String(payment.idempotency_key).replace(/:[^:]+$/, ''))
  }
  for (const [rid, paid] of paidByPayments) {
    existingByRateio.set(rid, Math.max(existingByRateio.get(rid) || 0, paid))
  }
  const confirmadoAnterior = [...paidByPayments.values()].reduce((sum, value) => sum + value, 0)
  for (const [rid, paid] of existingByRateio) {
    if (paid !== (paidByPayments.get(rid) || 0)) throw new FinanceError('Rateio com baixa sem histórico conciliado nesta conta. Regularize o histórico antes de receber.', 'historico_pagamento_divergente', 409)
  }
  const requestKeys = new Set<string>()
  const acceptedPayments: RealPayment[] = []
  const distributed = new Map<string, number>()
  let newTotal = 0
  for (const payment of payments) {
    const paymentKey = nullableText(payment.idempotency_key)
    if (!paymentKey) throw new FinanceError('Identificador do pagamento é obrigatório', 'idempotency_key_obrigatoria')
    if (requestKeys.has(paymentKey)) throw new FinanceError('Pagamento repetido na mesma requisição', 'pagamento_repetido')
    requestKeys.add(paymentKey)
    if (existingKeys.has(paymentKey)) {
      if (!receiptReplayMatches(payment, existing.results || [])) throw new FinanceError('Chave do pagamento reutilizada com outros dados', 'idempotencia_conflitante', 409)
      continue
    }
    if (!['COTISTA', 'SHARE', 'HOLDING'].includes(payment.tipo_pagador)) throw new FinanceError('Tipo de pagador inválido', 'pagador_invalido')
    if (payment.tipo_pagador === 'COTISTA' && !payment.pagador_cotista_id) throw new FinanceError('Cotista pagador não informado', 'cotista_pagador_obrigatorio')
    if (payment.tipo_pagador === 'HOLDING' && !payment.pagador_holding_id) throw new FinanceError('Holding pagadora não informada', 'holding_pagadora_obrigatoria')
    if (payment.tipo_pagador === 'SHARE') throw new FinanceError('A Share não pode registrar recebimento de si própria. Use o fluxo de adiantamento ou pagamento ao fornecedor.', 'recebimento_da_propria_share')
    const payerTable = payment.tipo_pagador === 'COTISTA' ? 'cotista_aeronave' : 'holdings'
    const payerId = payment.tipo_pagador === 'COTISTA' ? payment.pagador_cotista_id : payment.pagador_holding_id
    if (!(await db.prepare(`SELECT id FROM ${payerTable} WHERE id = ?`).bind(payerId).first())) throw new FinanceError('Pagador não encontrado', 'pagador_invalido')
    const value = asPositiveCents(payment.valor_centavos)
    const allocations = Array.isArray(payment.rateios) && payment.rateios.length
      ? payment.rateios
      : rateioPadraoId ? [{ rateio_id: rateioPadraoId, valor_centavos: value }] : []
    if (!allocations.length) throw new FinanceError('Cada pagamento precisa de rateios', 'rateios_obrigatorios')
    if (!payment.data_pagamento || !validSettlementDate(String(payment.data_pagamento))) throw new FinanceError('Data do pagamento é obrigatória', 'data_pagamento_obrigatoria')
    if (new Set(allocations.map(a => a.rateio_id)).size !== allocations.length) throw new FinanceError('Rateio repetido no pagamento', 'rateio_repetido')
    const sum = allocations.reduce((n, x) => n + asPositiveCents(x.valor_centavos), 0)
    if (sum !== value) throw new FinanceError('A distribuição dos rateios não confere com o pagamento', 'distribuicao_pagamento_invalida')
    const date = dateValue(payment.data_pagamento ?? body.data_recebimento ?? body.dataRecebimento)
    const bank = await resolveContaBancariaId(db, payment.conta_bancaria_id ?? body.conta_bancaria_id ?? body.banco_recebimento ?? body.bancoRecebimento ?? body.conta_bancaria ?? body.contaBancaria)
    if (!bank) throw new FinanceError('Conta bancária do pagamento não encontrada', 'conta_bancaria_obrigatoria')
    for (const allocation of allocations) {
      const rid = text(allocation.rateio_id)
      const cents = asPositiveCents(allocation.valor_centavos)
      if (!allowed.has(rid)) throw new FinanceError('Rateio não pertence à conta a receber', 'rateio_fora_da_conta')
      const next = (existingByRateio.get(rid) || 0) + (distributed.get(rid) || 0) + cents
      if (next > (allowed.get(rid) || 0)) throw new FinanceError('Pagamento excede o valor esperado do rateio', 'rateio_excedido')
      distributed.set(rid, (distributed.get(rid) || 0) + cents)
      statements.push(insertStatement(db, schema, 'rateio_pagamentos', { id: id(), rateio_id: rid, conta_receber_id: receivableId, tipo_pagador: payment.tipo_pagador, pagador_cotista_id: payment.pagador_cotista_id || null, pagador_holding_id: payment.pagador_holding_id || null, valor_centavos: cents, data_pagamento: date, conta_bancaria_id: bank, comprovante_url: nullableText(payment.comprovante_url), forma_pagamento: nullableText(payment.forma_pagamento), observacoes: nullableText(payment.observacoes), status: 'CONFIRMADO', idempotency_key: `${paymentKey}:${rid}`, criado_por: userId }, ['id', 'rateio_id', 'conta_receber_id', 'valor_centavos', 'idempotency_key']))
    }
    newTotal += value
    acceptedPayments.push(payment)
  }
  if (confirmadoAnterior + newTotal > total) throw new FinanceError('O pagamento excede o saldo da conta a receber', 'conta_receber_excedida')
  if (!acceptedPayments.length) return { ...row, idempotent: true }

  const finalTotal = confirmadoAnterior + newTotal
  const novoStatusConta = finalTotal >= total ? 'RECEBIDO' : 'EM_ABERTO'
  const lastPayment = acceptedPayments[acceptedPayments.length - 1]
  const lastDate = dateValue(lastPayment.data_pagamento ?? body.data_recebimento ?? body.dataRecebimento)
  const lastBank = await resolveContaBancariaId(db, lastPayment.conta_bancaria_id ?? body.conta_bancaria_id ?? body.banco_recebimento ?? body.bancoRecebimento ?? body.conta_bancaria ?? body.contaBancaria)
  statements.push(updateStatement(db, schema, 'contas_areceber', { status: novoStatusConta, data_recebimento: lastDate, data_pagamento: lastDate, banco_recebimento: lastBank, comprovante_recebimento_url: nullableText(lastPayment.comprovante_url ?? body.comprovante_url ?? body.comprovanteRecebimentoUrl), atualizado_em: new Date().toISOString() }, 'id = ?', [receivableId]))
  for (const r of rateios.results || []) {
    const rid = String(r.id)
    if (!distributed.has(rid)) continue
    const paymentForRateio = [...acceptedPayments].reverse().find(p => (p.rateios?.length ? p.rateios : [{ rateio_id: rateioPadraoId }]).some(a => a.rateio_id === rid))!
    const paid = (existingByRateio.get(rid) || 0) + (distributed.get(rid) || 0)
    const expected = Number(r.valor_rateado_centavos)
    const status = documentoSaida
      ? paid >= expected ? 'PAGO' : 'EM_ABERTO'
      : movimentoHoldingId
      ? paid >= expected ? 'PAGO' : 'EM_ABERTO'
      : paid >= expected ? 'REEMBOLSADO' : paid > 0 ? 'EM_ABERTO' : 'AGUARDANDO_REEMBOLSO'
    const rateioTable = movimentoHoldingId ? 'rateio_hold' : 'rateio_despesas'
    const rateioColumns = schema.get(rateioTable)
    statements.push(updateStatement(db, schema, rateioTable, {
      valor_pago_real_centavos: paid,
      status,
      data_pagamento: paid >= expected ? paymentForRateio.data_pagamento : null,
      ...(isShareRevenue && rateioColumns?.has('pago_diretamente') ? { pago_diretamente: 1 } : {}),
      ...(documentoSaida ? {
        ...(rateioColumns?.has('pago_por') ? { pago_por: paymentForRateio.pagador_cotista_id ?? paymentForRateio.pagador_holding_id ?? null } : {}),
        ...(rateioColumns?.has('url_doc') ? { url_doc: nullableText(paymentForRateio.comprovante_url) } : {}),
      } : {}),
      atualizado_em: new Date().toISOString(),
    }, 'id = ?', [rid]))
  }
  if (shareId) {
    const allPaid = (rateios.results || []).every(r => (existingByRateio.get(String(r.id)) || 0) + (distributed.get(String(r.id)) || 0) >= Number(r.valor_rateado_centavos))
    if (novoStatusConta === 'RECEBIDO' || isShareRevenue) statements.push(updateStatement(db, schema, 'lancamentos', {
      ...(novoStatusConta === 'RECEBIDO' ? {
        status: reimbursement ? 'REEMBOLSADO' : 'RECEBIDO',
        data_pagamento: lastDate,
        conta_bancaria_id: lastBank,
        comprovante_url: nullableText(lastPayment.comprovante_url ?? body.comprovante_url ?? body.comprovanteRecebimentoUrl),
        forma_pagamento: nullableText(lastPayment.forma_pagamento ?? body.forma_pagamento ?? body.formaPagamento),
      } : {}),
      ...(isShareRevenue ? { pago_diretamente: 1 } : {}),
      atualizado_em: new Date().toISOString(),
    }, 'id = ?', [shareId]))
    const client = rateioLancamentoId && rateioLancamentoId !== shareId ? { id: rateioLancamentoId } : null
    if (client && allPaid) {
      const clientColumns = schema.get('lancamentos')
      statements.push(updateStatement(db, schema, 'lancamentos', {
        status: 'PAGO',
        data_pagamento: lastDate,
        ...(clientColumns?.has('conta_bancaria_id') ? { conta_bancaria_id: lastBank } : {}),
        ...(clientColumns?.has('comprovante_url') ? { comprovante_url: nullableText(lastPayment.comprovante_url ?? body.comprovante_url ?? body.comprovanteRecebimentoUrl) } : {}),
        ...(clientColumns?.has('forma_pagamento') ? { forma_pagamento: nullableText(lastPayment.forma_pagamento ?? body.forma_pagamento ?? body.formaPagamento) } : {}),
        ...(clientColumns?.has('pago_por') ? { pago_por: lastPayment.pagador_cotista_id ?? lastPayment.pagador_holding_id ?? null } : {}),
        ...(clientColumns?.has('pago_diretamente') ? { pago_diretamente: 0 } : {}),
        atualizado_em: new Date().toISOString(),
      }, 'id = ?', [client.id]))
    }
  }
  if (movimentoHoldingId) {
    const allPaid = (rateios.results || []).every(r => (existingByRateio.get(String(r.id)) || 0) + (distributed.get(String(r.id)) || 0) >= Number(r.valor_rateado_centavos))
    const movementColumns = schema.get('movimentos_holding')
    statements.push(updateStatement(db, schema, 'movimentos_holding', {
      status: allPaid ? 'PAGO' : 'EM_ABERTO',
      data_pagamento: allPaid ? lastDate : null,
      ...(movementColumns?.has('conta_bancaria_id') ? { conta_bancaria_id: allPaid ? lastBank : null } : {}),
      comprovante_url: allPaid ? nullableText(lastPayment.comprovante_url ?? body.comprovante_url ?? body.comprovanteRecebimentoUrl) : null,
      forma_pagamento: allPaid ? nullableText(lastPayment.forma_pagamento ?? body.forma_pagamento ?? body.formaPagamento) : null,
      ...(movementColumns?.has('pago_por') ? { pago_por: allPaid ? lastPayment.pagador_cotista_id ?? lastPayment.pagador_holding_id ?? null : null } : {}),
      ...(movementColumns?.has('pago_diretamente') ? { pago_diretamente: allPaid ? 1 : 0 } : {}),
      atualizado_em: new Date().toISOString(),
    }, 'id = ?', [movimentoHoldingId]))
  }
  statements.push(auditStatement(db, schema, 'contas_areceber', receivableId, 'BAIXA', userId, newTotal, finalTotal, nullableText(body.motivo), nullableText(body.idempotency_key)))
  if (reimbursement && novoStatusConta === 'RECEBIDO') {
    statements.push(db.prepare("UPDATE reembolsos SET status = 'REEMBOLSADO', recebido_em = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'REEMBOLSADO'").bind(lastDate, reimbursement.id))
  }
  if (row.recibos_saida_id) statements.push(updateStatement(db, schema, 'recibos_saida', { status: novoStatusConta, atualizado_em: new Date().toISOString() }, 'id = ?', [row.recibos_saida_id]))
  if (row.nf_saida_id && schema.get('notas_fiscais_saida')?.has('status')) statements.push(updateStatement(db, schema, 'notas_fiscais_saida', { status: novoStatusConta }, 'id = ?', [row.nf_saida_id]))
  await commitSettlement(db, statements)
  const updated = await db.prepare('SELECT * FROM contas_areceber WHERE id = ?').bind(receivableId).first<Row>()
  const updatedRateios = movimentoHoldingId
    ? await db.prepare(`SELECT id, socio_id AS cotista_id, valor_rateado_centavos, valor_pago_real_centavos, status FROM rateio_hold WHERE ${holdingMovementColumn(schema)} = ? ORDER BY rowid`).bind(movimentoHoldingId).all<Row>()
    : rateios.results.length
    ? await db.prepare(`SELECT id, cotista_id, valor_rateado_centavos, valor_pago_real_centavos, status FROM rateio_despesas WHERE id IN (${rateios.results.map(() => '?').join(',')}) ORDER BY id`).bind(...rateios.results.map(rateio => rateio.id)).all<Row>()
    : { results: [] as Row[] }
  return { ...updated, idempotent: false, pagamentos: acceptedPayments, rateios: updatedRateios.results || [] }
}

export async function enqueueFinance(
  db: Database,
  operation: FinanceOperation,
  payload: Row,
): Promise<Row> {
  const schema = await loadSchema(db)
  requireTable(schema, 'financeiro_fila', [
    'id',
    'operacao',
    'payload_json',
    'status',
    'tentativas',
    'erro',
    'processado_em',
    'proxima_tentativa_em',
  ])
  if (!['DESPESA', 'RECEITA', 'REEMBOLSO'].includes(operation)) {
    throw new FinanceError('Operação de fila inválida', 'operacao_fila_invalida')
  }
  const queueId = id()
  await db.batch([
    insertStatement(
      db,
      schema,
      'financeiro_fila',
      {
        id: queueId,
        operacao: operation,
        payload_json: JSON.stringify(payload),
        status: 'PENDENTE',
        tentativas: 0,
      },
      ['id', 'operacao', 'payload_json'],
    ),
  ])
  return { id: queueId, status: 'PENDENTE' }
}

export async function processFinanceQueue(
  db: Database,
  userId: string | null,
  limit = 20,
): Promise<Row[]> {
  const schema = await loadSchema(db)
  requireTable(schema, 'financeiro_fila', [
    'id',
    'operacao',
    'payload_json',
    'status',
    'tentativas',
    'erro',
    'processado_em',
    'proxima_tentativa_em',
  ])
  await db.prepare(`UPDATE financeiro_fila
      SET status = CASE WHEN tentativas >= 5 THEN 'ERRO' ELSE 'PENDENTE' END,
          erro = CASE WHEN tentativas >= 5 THEN 'limite_de_tentativas_excedido' ELSE 'claim_expirado' END,
          processando_em = NULL,
          proxima_tentativa_em = CASE WHEN tentativas >= 5 THEN NULL ELSE datetime('now', '+1 minute') END
    WHERE status = 'PROCESSANDO'
      AND datetime(COALESCE(processando_em, criado_em)) < datetime('now', '-15 minutes')`).run()
  const rows = await db
    .prepare(
      `SELECT * FROM financeiro_fila
        WHERE status = 'PENDENTE' AND tentativas < 5
          AND (proxima_tentativa_em IS NULL OR datetime(proxima_tentativa_em) <= datetime('now'))
        ORDER BY criado_em
        LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 100))
    .all<Row>()

  const result: Row[] = []
  for (const row of rows.results || []) {
    try {
      const claimed = await db
        .prepare(
          `UPDATE financeiro_fila
              SET status = 'PROCESSANDO',
                  processando_em = CURRENT_TIMESTAMP,
                  tentativas = tentativas + 1
            WHERE id = ?
              AND status = 'PENDENTE'`,
        )
        .bind(row.id)
        .run()

      if (!claimed.meta.changes) {
        result.push({ id: row.id, status: 'IGNORADO', motivo: 'item_ja_reservado' })
        continue
      }

      const payload = JSON.parse(String(row.payload_json)) as Row
      const operation = upper(row.operacao) as FinanceOperation

      if (operation === 'DESPESA') {
        await createExpense(db, payload, userId)
      } else if (operation === 'RECEITA') {
        await issueRevenue(db, payload, userId)
      } else if (operation === 'REEMBOLSO') {
        await createReimbursement(db, payload, userId)
      } else {
        throw new FinanceError(
          `Operação de fila inválida: ${operation}`,
          'operacao_fila_invalida',
        )
      }

      await db
        .prepare(
          `UPDATE financeiro_fila
              SET status = 'PROCESSADO',
                  processado_em = CURRENT_TIMESTAMP,
                  processando_em = NULL,
                  erro = NULL,
                  proxima_tentativa_em = NULL
            WHERE id = ?
              AND status = 'PROCESSANDO'`,
        )
        .bind(row.id)
        .run()

      result.push({ id: row.id, status: 'PROCESSADO' })
    } catch (error) {
      const permanent = error instanceof FinanceError
      const mensagem = error instanceof Error ? error.message : String(error)
      const backoff = FILA_BACKOFF_MINUTOS[Math.min(Number(row.tentativas ?? 0), FILA_BACKOFF_MINUTOS.length - 1)]
      await db
        .prepare(
          `UPDATE financeiro_fila
              SET status = CASE WHEN ? = 1 OR tentativas >= 5 THEN 'ERRO' ELSE 'PENDENTE' END,
                  processando_em = NULL,
                  erro = ?,
                  proxima_tentativa_em = CASE WHEN ? = 1 OR tentativas >= 5 THEN NULL ELSE datetime('now', '+' || ? || ' minutes') END
            WHERE id = ?
              AND status = 'PROCESSANDO'`,
        )
        .bind(permanent ? 1 : 0, mensagem, permanent ? 1 : 0, backoff, row.id)
        .run()

      result.push({
        id: row.id,
        status: permanent || Number(row.tentativas ?? 0) >= 5 ? 'ERRO' : 'PENDENTE',
        erro: mensagem,
        ...(permanent || Number(row.tentativas ?? 0) >= 5 ? {} : { proxima_tentativa_em: `+${backoff}m` }),
      })
    }
  }
  return result
}

async function createReimbursementFinance(db: Database, schema: SchemaCache, command: Row, input: Row, receiptId: string, userId: string | null): Promise<{ shareLancamentoId: string; clienteLancamentoId: string | null; contaReceberId: string | null }> {
  const receiptMeta = await db.prepare('SELECT numero_recibo, url_recibo FROM recibos WHERE id = ? LIMIT 1').bind(receiptId).first<{ numero_recibo: string | null; url_recibo: string | null }>()
  const fornecedorId = nullableText(command.fornecedor_id ?? command.fornecedores_favoritos_id)
  const fornecedor = await buscarFornecedor(db, fornecedorId) ?? await resolverFornecedor(db, fornecedorId, command.fornecedor_nome ?? command.fornecedor)
  const abastecimentosId = await linkedAbastecimentoId(db, receiptId)
  const categoriaShare = await db.prepare(`
    SELECT id FROM categoria_movimentacao_share
     WHERE id = ? OR upper(COALESCE(nome, '')) LIKE '%REEMBOLS%' OR upper(COALESCE(grupo_categoria, '')) LIKE '%REEMBOLS%'
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, nome LIMIT 1
  `).bind(CATEGORIA_SHARE_RECIBO, CATEGORIA_SHARE_RECIBO).first<{ id: string }>()
  const shareCategory = await resolveShareLancamentoCategory(db, categoriaShare?.id)
  const cotista = await db.prepare(`
    SELECT id FROM cotista_aeronave
     WHERE id = ? OR (cliente_id = ? AND aeronave_id = ?)
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1
  `).bind(command.cotista_aeronave_id || '', input.cliente_id || '', input.aeronave_id || '', command.cotista_aeronave_id || '').first<{ id: string }>()
  const cotistaId = cotista?.id ?? null
  const clienteId = text(input.cliente_id || (input.pagador_tipo === 'cliente' ? input.pagador_id : '')) || null
  if (!cotistaId && !clienteId) throw new FinanceError('Cliente ou cotista é obrigatório para o reembolso', 'pagador_reembolso_obrigatorio')

  const shareLancamentoId = id()
  const amount = asPositiveCents(input.valor_centavos)
  await db.batch([
    insertStatement(db, schema, 'lancamentos', {
      id: shareLancamentoId,
      aeronave_id: input.aeronave_id,
      abastecimentos_id: abastecimentosId,
      cotista_aeronave_id: cotistaId,
      cliente_id: clienteId,
      descricao: input.descricao,
      categoria_share_id: shareCategory.categoria_share_id,
      categoria_nome: shareCategory.categoria_nome,
      grupo_categoria: shareCategory.grupo_categoria,
      fluxo: 'SAIDA',
      tipo_caixa: 'SHARE',
      valor_centavos: amount,
      status: 'EM_ABERTO',
      escopo_financeiro: 'CAIXA_SHARE',
      data_emissao: input.data_emissao,
      data_vencimento: input.data_vencimento || input.data_emissao,
      fornecedores_favoritos_id: fornecedor?.id ?? null,
      fornecedor_nome: nullableText(fornecedor?.nome_completo),
      pago_diretamente: 0,
      reembolsavel: 1,
      reembolso_quitado: 0,
      numero_recibo: nullableText(receiptMeta?.numero_recibo),
      url_recibo: nullableText(receiptMeta?.url_recibo),
      origem_tipo: 'RECIBO_REEMBOLSO',
      origem_id: receiptId,
      idempotency_key: `recibo-reembolso:${receiptId}`,
      criado_por: userId,
      observacoes: nullableText(input.observacoes),
    }, ['id', 'descricao', 'fluxo', 'valor_centavos']),
    linkStatement(db, schema, 'RECIBO', receiptId, 'LANCAMENTO', shareLancamentoId, 'RECIBO_LANCAMENTO', userId),
    auditStatement(db, schema, 'lancamentos', shareLancamentoId, 'CRIACAO_DESPESA_REEMBOLSO', userId, null, amount, null, `recibo-reembolso:${receiptId}`),
  ])
  return { shareLancamentoId, clienteLancamentoId: null, contaReceberId: null }
}

type ReceiptFinanceBuilder = (
  db: Database,
  schema: SchemaCache,
  command: Row,
  input: Row,
  receiptId: string,
  userId: string | null,
) => Promise<Row>

async function buildReceiptColaborador(
  db: Database,
  _schema: SchemaCache,
  command: Row,
  input: Row,
  _receiptId: string,
  userId: string | null,
): Promise<Row> {
  if (!text(input.colaborador_id)) {
    throw new FinanceError(
      'Colaborador é obrigatório para este recibo',
      'colaborador_obrigatorio',
    )
  }

  return createExpense(db, {
    ...command,
    tipo_caixa: 'SHARE',
    fluxo: 'SAIDA',
    sem_rateio: true,
    colaborador_id: input.colaborador_id,
    pago_diretamente: false,
    reembolsavel: false,
  }, userId, { internal: true })
}

/**
 * Recibo de pagamento: o cotista pagou direto do caixa dele. O lançamento serve
 * de extrato e o rateio registra quem deve ao pagador:
 * - a linha do pagador recebe valor_pago_real = total pago;
 * - as demais linhas ficam com valor_pago_real = 0 e status EM_ABERTO, o que
 *   gera o ajuste no balanço.
 * O tipo de rateio TODOS/IGUAL divide igualmente entre os cotistas da aeronave.
 */
async function buildReceiptPagamento(
  db: Database,
  _schema: SchemaCache,
  command: Row,
  input: Row,
  receiptId: string,
  userId: string | null,
): Promise<Row> {
  const pagadorCotista = ['cotista_aeronave', 'cliente'].includes(String(input.pagador_tipo))

  if (pagadorCotista && !text(input.pagador_id)) {
    throw new FinanceError(
      'Cliente ou cotista pagador é obrigatório para recibo de pagamento',
      'pagador_obrigatorio',
    )
  }

  const linhasInformadas = await receiptAllocationLines(db, command, input)
  if (!pagadorCotista) {
    const rateioLinhas = linhasRateioPagasPelaEmpresa(linhasInformadas)
    return createExpense(db, {
      ...command,
      recibo_id: receiptId,
      tipo_caixa: rateioLinhas.length ? 'CLIENTE' : 'SHARE',
      fluxo: 'SAIDA',
      categoria_id: input.categoria_movimentacao_id,
      categoria_cliente_id: rateioLinhas.length ? input.categoria_movimentacao_id : null,
      aeronave_id: input.aeronave_id || command.aeronave_id,
      rateio_linhas: rateioLinhas,
      sem_rateio: !rateioLinhas.length,
      pago_diretamente: false,
      reembolsavel: false,
      idempotency_key: `recibo-pagamento:${receiptId}`,
    }, userId, { internal: true })
  }

  const pagadorId = text(input.pagador_id)
  const aeronaveInformada = text(input.aeronave_id || command.aeronave_id)
  const cotista = await db.prepare(`
    SELECT id, aeronave_id, socio_id, percentual_sociedade
      FROM cotista_aeronave
     WHERE ((id = ?1 AND ?2 = 'cotista_aeronave')
        OR (cliente_id = ?1 AND ?2 = 'cliente'))
       AND (?3 = '' OR aeronave_id = ?3)
     ORDER BY CASE WHEN aeronave_id = ?3 AND ?3 <> '' THEN 0 ELSE 1 END, id
     LIMIT 1
  `).bind(pagadorId, String(input.pagador_tipo), aeronaveInformada).first<{ id: string; aeronave_id: string; socio_id: string | null; percentual_sociedade: number | null }>()

  // Pagador que não é cotista da aeronave, mas informou o rateio entre os cotistas.
  if (!cotista?.id) {
    if (input.pagador_tipo === 'cliente' && linhasInformadas.length) {
      return createExpense(db, {
        ...command,
        recibo_id: receiptId,
        tipo_caixa: 'CLIENTE',
        fluxo: 'SAIDA',
        categoria_id: input.categoria_movimentacao_id,
        categoria_cliente_id: input.categoria_movimentacao_id,
        aeronave_id: input.aeronave_id || command.aeronave_id,
        numero_voo: input.numero_voo,
        rateio_linhas: linhasInformadas,
        pago_diretamente: true,
        reembolsavel: false,
        deferir_baixa_rateio: true,
        idempotency_key: `recibo-pagamento:${receiptId}`,
      }, userId, { internal: true })
    }
    throw new FinanceError(
      'O pagador precisa estar vinculado a um cotista e a uma aeronave para gerar o rateio',
      'cotista_rateio_obrigatorio',
    )
  }

  const total = asPositiveCents(input.valor_centavos)
  const base: Row[] = linhasInformadas.length
    ? linhasInformadas
    : [{
      cotista_id: cotista.id,
      socio_id: cotista.socio_id,
      percentual: 100,
      percentual_sociedade: Number(cotista.percentual_sociedade ?? 100),
      valor_centavos: total,
    }]

  const rateioLinhas = base.map((linha) => {
    const cotistaLinha = text(linha.cotista_id ?? linha.cotista_aeronave_id)
    const ehPagador = cotistaLinha === cotista.id
    return {
      ...linha,
      pago_por: cotista.id,
      pago_diretamente: ehPagador,
      valor_pago_real_centavos: ehPagador ? total : 0,
    }
  })

  return createExpense(db, {
    ...command,
    recibo_id: receiptId,
    numero_voo: input.numero_voo,
    tipo_caixa: 'CLIENTE',
    fluxo: 'SAIDA',
    categoria_id: input.categoria_movimentacao_id,
    categoria_cliente_id: input.categoria_movimentacao_id,
    aeronave_id: cotista.aeronave_id || aeronaveInformada,
    cotista_aeronave_id: cotista.id,
    cotista_pagador_id: cotista.id,
    socio_id: cotista.socio_id,
    rateio_linhas: rateioLinhas,
    pago_diretamente: true,
    reembolsavel: false,
    deferir_baixa_rateio: true,
    idempotency_key: `recibo-pagamento:${receiptId}`,
  }, userId, { internal: true })
}

async function buildReceiptSaida(
  db: Database,
  _schema: SchemaCache,
  command: Row,
  _input: Row,
  receiptId: string,
  userId: string | null,
): Promise<Row> {
  if (!text(command.cotista_aeronave_id) || !text(command.aeronave_id)) {
    throw new FinanceError(
      'Cotista e aeronave são obrigatórios para recibo de saída',
      'origem_recibo_saida_obrigatoria',
    )
  }

  const result = await issueRevenue(db, {
    ...command,
    fluxo: 'ENTRADA',
    origem_tipo: 'RECIBO_SAIDA',
    origem_id: receiptId,
    criar_lancamento_cliente: true,
  }, userId, { internal: true })

  return {
    ...result,
    shareLancamentoId: result.lancamento_id ?? result.id,
    clienteLancamentoId: result.lancamentoClienteId ?? result.lancamento_cliente_id ?? null,
  }
}

export async function finalizarRecibo(
  db: Database,
  receiptId: string,
  userId: string | null,
  overrides: Row = {},
): Promise<Row> {
  const receipt = await db.prepare('SELECT * FROM recibos WHERE id = ? LIMIT 1').bind(receiptId).first<Row>()
  if (!receipt) throw new FinanceError('Recibo não encontrado', 'recibo_nao_encontrado', 404)
  if (text(receipt.lancamento_id)) {
    return { recibo_id: receiptId, lancamento_id: receipt.lancamento_id, idempotent: true }
  }

  const builders: Record<string, ReceiptFinanceBuilder> = {
    recibo_reembolso: async (database, schema, command, input, id, createdBy) =>
      createReimbursementFinance(database, schema, command, input, id, createdBy),
    recibo_colaborador: buildReceiptColaborador,
    recibo_pagamento: buildReceiptPagamento,
    recibo_saida: buildReceiptSaida,
  }
  const buildFinance = builders[text(receipt.tipo_recibo)]
  if (!buildFinance) throw new FinanceError('Tipo de recibo inválido', 'tipo_recibo_invalido')

  return issueReceiptInternal(
    db,
    {
      ...receipt,
      ...overrides,
      valor_centavos: receipt.valor,
      categoria_movimentacao_id: receipt.categoria_movimentacao_id,
      data: receipt.data_emissao,
      cotista_aeronave_id: receipt.pagador_tipo === 'cotista_aeronave' ? receipt.pagador_id : null,
    },
    userId,
    buildFinance,
    receiptId,
  )
}

export async function enviarReciboPagamentoParaRateio(
  db: Database,
  receiptId: string,
  userId: string | null,
  body: Row = {},
): Promise<Row> {
  const receipt = await db.prepare(
    `SELECT * FROM recibos WHERE id = ?1 AND tipo_recibo = 'recibo_pagamento' LIMIT 1`,
  ).bind(receiptId).first<Row>()
  if (!receipt) throw new FinanceError('Recibo de pagamento não encontrado', 'recibo_pagamento_nao_encontrado', 404)

  const existingClient = await db.prepare(
    `SELECT id FROM rateio_despesas WHERE lancamento_id = ?1 LIMIT 1`,
  ).bind(receipt.lancamento_id ?? null).first<{ id: string }>().catch(() => null)
  const existingHolding = await db.prepare(
    `SELECT id FROM rateio_hold WHERE origem_tipo = 'RECIBO' AND origem_id = ?1 LIMIT 1`,
  ).bind(receiptId).first<{ id: string }>().catch(() => null)
  const rateioExistente = Boolean(existingClient?.id || existingHolding?.id)
  const fornecedorResolvido = await resolverFornecedor(
    db,
    body.fornecedor_id ?? receipt.fornecedor_id,
    body.fornecedor_nome ?? body.fornecedor ?? receipt.fornecedor_nome ?? receipt.fornecedor,
  )
  const emailInfo = await db.prepare(
    `SELECT e.id, e.email_enviado_em FROM emails_enviados e
       LEFT JOIN recibo_anexos a
         ON a.id = e.referencia_id
        AND e.referencia_tipo = 'recibo'
       WHERE e.status = 'enviado'
         AND e.referencia_tipo = 'recibo'
         AND (e.referencia_id = ?1 OR a.recibo_id = ?1)
       ORDER BY COALESCE(e.email_enviado_em, e.criado_em) DESC LIMIT 1`,
  ).bind(receiptId).first<{ id: string; email_enviado_em: string | null }>().catch(() => null)
  const envioVinculado = await db.prepare(
    `SELECT destino_id AS id FROM financeiro_vinculos WHERE origem_tipo = 'RECIBO' AND origem_id = ?1 AND destino_tipo = 'ENVIO_DESPESA' LIMIT 1`,
  ).bind(receiptId).first<{ id: string }>().catch(() => null)
  let result: Row | null = null

  // Recibo pago por cliente representa uma despesa do caixa cliente. O envio
  // é a origem operacional desse fluxo; suas parcelas devem usar o próprio ID
  // do envio como lancamento_id, sem criar um lançamento espelho.
  if (!rateioExistente && receipt.pagador_tipo === 'cliente') {
    const rateioLinhas = Array.isArray(body.rateio_linhas) ? body.rateio_linhas as Row[] : []
    const aeronaveId = text(body.aeronave_id) || text(receipt.aeronave_id)
    const dataVencimento = text(body.data_vencimento) || text(receipt.data_vencimento) || text(receipt.data_emissao)
    const envioId = text(envioVinculado?.id) || id()
    const comando: Row = {
      ...receipt,
      ...body,
      lancamento_id: envioId,
      recibo_id: receiptId,
      tipo: 'cliente',
      tipo_caixa: 'CLIENTE',
      descricao: receipt.descricao,
      valor_centavos: receipt.valor,
      valor_total_despesa_centavos: receipt.valor,
      data: receipt.data_emissao,
      data_despesa: receipt.data_emissao,
      data_vencimento: dataVencimento,
      vencimento: dataVencimento,
      aeronave_id: aeronaveId,
      categoria_id: receipt.categoria_movimentacao_id,
      categoria_cliente_id: receipt.categoria_movimentacao_id,
      categoria_nome: receipt.categoria_nome,
      fornecedor_id: fornecedorResolvido?.id ?? null,
      fornecedor_nome: fornecedorResolvido?.nome_completo ?? body.fornecedor_nome ?? body.fornecedor ?? receipt.fornecedor_nome ?? receipt.fornecedor,
      subcategoria_1: body.subcategoria_1 ?? receipt.subcategoria_1,
      subcategoria_2: body.subcategoria_2 ?? receipt.subcategoria_2,
      subcategoria_3: body.subcategoria_3 ?? receipt.subcategoria_3,
      subcategoria_4: body.subcategoria_4 ?? receipt.subcategoria_4,
      periodicidade: body.periodicidade ?? receipt.periodicidade ?? 'ÚNICO',
      tipo_rateio: body.tipo_rateio ?? receipt.tipo_rateio ?? 'FIXO',
      numero_recibo: receipt.numero_recibo,
      url_recibo: receipt.url_recibo,
      email_enviado_em: emailInfo?.email_enviado_em ?? null,
      rateio_linhas: rateioLinhas,
      anexos_json: [],
      idempotency_key: `recibo-pagamento-envio:${receiptId}`,
    }
    const command = normalizeCommand(comando, userId, { internal: true })
    const linhas = allocationLines(command)
    if (!linhas.length) throw new FinanceError('Despesa precisa de rateio', 'rateio_obrigatorio')
    await validateAllocationLines(db, command, linhas, asPositiveCents(receipt.valor))
    const envioExistente = envioVinculado?.id
      ? await db.prepare('SELECT id FROM envio_despesas WHERE id = ?').bind(envioId).first<{ id: string }>()
      : null
    if (!envioExistente) {
      const schema = await loadSchema(db)
      const envioValues: Row = {
        id: envioId,
        tipo: 'cliente',
        descricao: receipt.descricao,
        valor: asPositiveCents(receipt.valor) / 100,
        valor_total_despesa: asPositiveCents(receipt.valor) / 100,
        data_despesa: receipt.data_emissao,
        vencimento: dataVencimento,
        aeronave_id: aeronaveId,
        observacoes: body.observacoes ?? receipt.observacoes ?? null,
        status: 'CONVERTIDO',
        criado_por: userId,
        criado_em: new Date().toISOString(),
        grupo_categoria: receipt.grupo_categoria ?? null,
        tipo_caixa: 'CLIENTE',
        pago_diretamente: 0,
        pago_por: null,
        categoria_id: receipt.categoria_movimentacao_id,
        categoria_cliente_id: receipt.categoria_movimentacao_id,
        categoria_nome: receipt.categoria_nome ?? null,
        fornecedor_id: comando.fornecedor_id,
        fornecedor_nome: comando.fornecedor_nome,
        subcategoria_1: comando.subcategoria_1,
        subcategoria_2: comando.subcategoria_2,
        subcategoria_3: comando.subcategoria_3,
        subcategoria_4: comando.subcategoria_4,
        rateio_linhas_json: JSON.stringify(rateioLinhas),
        anexos_json: '[]',
        periodicidade: comando.periodicidade,
        tipo_rateio: comando.tipo_rateio,
        email_enviado: emailInfo ? 1 : 0,
        email_enviado_em: emailInfo?.email_enviado_em ?? null,
        email_id: emailInfo?.id ?? null,
        lancamento_id: envioId,
        numero_recibo: comando.numero_recibo,
        url_recibo: comando.url_recibo,
      }
      const compatibleEnvioValues = Object.fromEntries(
        Object.entries(envioValues).filter(([column]) => schema.get('envio_despesas')?.has(column)),
      )
      await db.batch([
        insertStatement(db, schema, 'envio_despesas', compatibleEnvioValues, ['id', 'aeronave_id', 'descricao', 'valor']),
        db.prepare(`INSERT INTO financeiro_vinculos (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo) VALUES (?, 'RECIBO', ?, 'ENVIO_DESPESA', ?, 'CONVERSAO')`).bind(id(), receiptId, envioId),
      ])
    }
    const rateiosDoEnvio = await db.prepare('SELECT id FROM rateio_despesas WHERE lancamento_id = ?').bind(envioId).all<{ id: string }>()
    result = rateiosDoEnvio.results?.length
      ? { id: envioId, lancamento_id: envioId, rateio_ids: rateiosDoEnvio.results.map((row) => row.id), idempotent: true }
      : await createClientExpenseRateios(db, comando, userId, { internal: true })
    await db.batch([
      db.prepare('UPDATE recibos SET lancamento_id = ? WHERE id = ? AND lancamento_id IS NULL').bind(envioId, receiptId),
      ...((result.rateio_ids ?? []) as string[]).map((rateioId) => db.prepare(`INSERT OR IGNORE INTO financeiro_vinculos (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo) VALUES (?, 'ENVIO_DESPESA', ?, 'RATEIO_DESPESAS', ?, 'CONVERSAO')`).bind(id(), envioId, rateioId)),
    ])
  }

  // Recupera recibos da empresa que já tenham lançamento, mas cuja primeira
  // tentativa de rateio tenha falhado antes de gravar as linhas.
  if (!rateioExistente && receipt.pagador_tipo === 'empresa' && text(receipt.lancamento_id)) {
    const lancamentoShare = await db.prepare(
      `SELECT id FROM lancamentos WHERE id = ?1 AND tipo_caixa = 'SHARE' LIMIT 1`,
    ).bind(receipt.lancamento_id).first<{ id: string }>()
    if (lancamentoShare?.id) {
      const rateioLinhas = linhasRateioPagasPelaEmpresa(
        Array.isArray(body.rateio_linhas) ? body.rateio_linhas as Row[] : [],
      )
      const rateioCommand: Row = {
        ...receipt,
        ...body,
        recibo_id: receiptId,
        lancamento_id: lancamentoShare.id,
        aeronave_id: text(body.aeronave_id) || receipt.aeronave_id,
        data: receipt.data_emissao,
        data_emissao: receipt.data_emissao,
        data_vencimento: text(body.data_vencimento) || receipt.data_vencimento,
        descricao: receipt.descricao,
        valor_centavos: receipt.valor,
        tipo_caixa: 'CLIENTE',
        pago_diretamente: false,
        rateio_linhas: rateioLinhas,
      }
      const command = normalizeCommand(rateioCommand, userId, { internal: true })
      const linhas = allocationLines(command)
      if (!linhas.length) throw new FinanceError('Despesa precisa de rateio', 'rateio_obrigatorio')
      await validateAllocationLines(db, command, linhas, asPositiveCents(receipt.valor))
      result = await createClientExpenseRateios(db, rateioCommand, userId, { internal: true })
    }
  }

  if (!rateioExistente && !result) {
    result = await finalizarRecibo(db, receiptId, userId, {
      aeronave_id: text(body.aeronave_id) || receipt.aeronave_id || null,
      numero_voo: text(body.numero_voo) || receipt.numero_voo || null,
      rateio_linhas: Array.isArray(body.rateio_linhas) ? body.rateio_linhas : undefined,
      tipo_rateio: text(body.tipo_rateio) || receipt.tipo_rateio || undefined,
      data_vencimento: text(body.data_vencimento) || receipt.data_vencimento || null,
      observacoes: text(body.observacoes) || receipt.observacoes || null,
      fornecedor_id: fornecedorResolvido?.id ?? null,
      fornecedor_nome: fornecedorResolvido?.nome_completo ?? body.fornecedor_nome ?? body.fornecedor ?? null,
      periodicidade: text(body.periodicidade) || text(receipt.periodicidade) || 'ÚNICO',
      numero_recibo: receipt.numero_recibo,
      url_recibo: receipt.url_recibo,
      email_enviado_em: emailInfo?.email_enviado_em ?? null,
      subcategoria_1: body.subcategoria_1,
      subcategoria_2: body.subcategoria_2,
      subcategoria_3: body.subcategoria_3,
      subcategoria_4: body.subcategoria_4,
    })
  }
  if (rateioExistente && ['cotista_aeronave', 'cliente'].includes(String(receipt.pagador_tipo))) {
    const periodicidade = text(body.periodicidade) || 'ÚNICO'
    const subcategorias = ['subcategoria_1', 'subcategoria_2', 'subcategoria_3', 'subcategoria_4'] as const
    const updates: D1PreparedStatement[] = []
    const rateios = await db.prepare(
      'SELECT id, lancamento_id FROM rateio_despesas WHERE lancamento_id = ?1',
    ).bind(receipt.lancamento_id).all<{ id: string; lancamento_id: string | null }>()
    for (const rateio of rateios.results ?? []) {
      const assignments = [
        'fornecedor_id = COALESCE(?, fornecedor_id)',
        'periodicidade = COALESCE(periodicidade, ?)',
        'numero_recibo = COALESCE(?, numero_recibo)',
        'url_recibo = COALESCE(?, url_recibo)',
        'email_enviado_em = COALESCE(?, email_enviado_em)',
        "status = CASE WHEN status = 'PAGO_DIRETAMENTE' THEN 'EM_ABERTO' ELSE status END",
      ]
      const values: unknown[] = [
        fornecedorResolvido?.id ?? null,
        periodicidade,
        receipt.numero_recibo ?? null,
        receipt.url_recibo ?? null,
        emailInfo?.email_enviado_em ?? null,
      ]
      for (const campo of subcategorias) {
        assignments.splice(assignments.length - 1, 0, `${campo} = COALESCE(?, ${campo})`)
        values.push(nullableText(body[campo]))
      }
      updates.push(db.prepare(`UPDATE rateio_despesas SET ${assignments.join(', ')} WHERE id = ?`)
        .bind(...values, rateio.id))
    }
    if (updates.length) await db.batch(updates)
  }
  if (receipt.pagador_tipo === 'empresa' && (rateioExistente || result)) {
    await db.prepare(`
      UPDATE lancamentos
         SET escopo_financeiro = 'FINANCEIRO'
       WHERE id = ?1 AND tipo_caixa = 'SHARE'
    `).bind(receipt.lancamento_id || result?.lancamento_id || null).run()
  }
  const rateioLancamentoId = text(
    result?.lancamento_cliente_id ?? result?.lancamento_id ?? receipt.lancamento_id,
  )
  type ReceiptRateio = { id: string; cotista_id: string | null; percentual: number | null; valor: number }
  const [rateiosPorLancamento, rateiosHold] = await Promise.all([
    db.prepare(
      'SELECT id, cotista_id, percentual_uso AS percentual, valor_rateado_centavos AS valor FROM rateio_despesas WHERE lancamento_id = ?1',
    ).bind(rateioLancamentoId || null).all<ReceiptRateio>().catch(() => ({ results: [] as ReceiptRateio[] })),
    db.prepare(
      `SELECT rh.id, ca.id AS cotista_id, rh.percentual_uso AS percentual, rh.valor_rateado_centavos AS valor FROM rateio_hold rh LEFT JOIN cotista_aeronave ca ON ca.socio_id = rh.socio_id AND ca.aeronave_id = rh.aeronave_id WHERE rh.origem_tipo = 'RECIBO' AND rh.origem_id = ?1`,
    ).bind(receiptId).all<ReceiptRateio>().catch(() => ({ results: [] as ReceiptRateio[] })),
  ])
  const rateios = [...new Map(
    [...(rateiosPorLancamento.results ?? []), ...(rateiosHold.results ?? [])]
      .map((rateio) => [String(rateio.id), rateio] as const),
  ).values()]
  if (!rateios.length) throw new FinanceError('Não foi possível criar o rateio do recibo', 'rateio_nao_criado', 500)
  const rateiosVinculados = await db.prepare(
    'SELECT rateio_id FROM recibo_rateio WHERE recibo_id = ?1',
  ).bind(receiptId).all<{ rateio_id: string }>()
  const rateioIdsVinculados = new Set((rateiosVinculados.results ?? []).map((row) => String(row.rateio_id)))
  const vinculosPendentes = rateios.filter((rateio) => !rateioIdsVinculados.has(String(rateio.id)))
  if (vinculosPendentes.length) {
    await db.batch(vinculosPendentes.map((rateio) => db.prepare(
      'INSERT INTO recibo_rateio (id, recibo_id, rateio_id, percentual, valor, cotista_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id(), receiptId, rateio.id, Number(rateio.percentual || 0), Number(rateio.valor || 0), rateio.cotista_id)))
  }
  return {
    ok: true,
    recibo_id: receiptId,
    lancamento_id: result?.lancamento_id || receipt.lancamento_id || null,
    rateio_ids: rateios.map((row) => row.id),
    idempotent: rateioExistente || Boolean(result?.idempotent),
  }
}

export async function emitirReciboReembolso(db: Database, body: Row, userId: string | null): Promise<Row> {
  if (text(body.tipo_recibo) !== 'recibo_reembolso') throw new FinanceError('Tipo de recibo inválido para reembolso', 'tipo_recibo_invalido')
  return issueReceiptInternal(db, body, userId, async (database, schema, command, input, receiptId, createdBy) =>
    createReimbursementFinance(database, schema, command, input, receiptId, createdBy),
  )
}

export async function programarReciboReembolso(db: Database, receiptId: string, body: Row, userId: string | null): Promise<Row> {
  const schema = await loadSchema(db)
  const receiptInicial = await db.prepare('SELECT * FROM recibos WHERE id = ? AND tipo_recibo = \'recibo_reembolso\' LIMIT 1').bind(receiptId).first<Row>()
  if (!receiptInicial) throw new FinanceError('Recibo de reembolso não encontrado', 'recibo_reembolso_nao_encontrado', 404)
  // A emissão inicial grava somente em recibos. A partir daqui, na ação de
  // programação após o envio, materializamos o lançamento Share e o restante
  // do fluxo financeiro.
  if (!text(receiptInicial.lancamento_id)) {
    await finalizarRecibo(db, receiptId, userId, {
      subcategoria_1: body.subcategoria_1,
      subcategoria_2: body.subcategoria_2,
      subcategoria_3: body.subcategoria_3,
      subcategoria_4: body.subcategoria_4,
    })
  }
  // O e-mail pode ter sido enviado antes ou depois da criação dos lançamentos.
  // O histórico é opcional e não pode interromper a programação financeira.
  const emailInfo = await db.prepare(
    `SELECT e.id FROM emails_enviados e
       LEFT JOIN recibo_anexos a
         ON a.id = e.referencia_id
        AND e.referencia_tipo = 'recibo'
       WHERE e.status = 'enviado'
         AND e.referencia_tipo = 'recibo'
         AND (e.referencia_id = ?1 OR a.recibo_id = ?1)
       ORDER BY e.criado_em DESC LIMIT 1`,
  ).bind(receiptId).first<{ id: string }>().catch(() => null)
  const receipt = await db.prepare(`SELECT r.*, l.id AS share_lancamento_id, l.aeronave_id, l.cotista_aeronave_id,
      l.categoria_share_id AS share_categoria_id, l.categoria_nome AS share_categoria_nome,
      l.fornecedores_favoritos_id AS share_fornecedor_id
    FROM recibos r LEFT JOIN lancamentos l ON l.id = r.lancamento_id
    WHERE r.id = ? AND r.tipo_recibo = 'recibo_reembolso' LIMIT 1`).bind(receiptId).first<Row>()
  if (!receipt || !text(receipt.share_lancamento_id)) throw new FinanceError('Recibo de reembolso não encontrado', 'recibo_reembolso_nao_encontrado', 404)
  const existing = await db.prepare('SELECT id, conta_receber_id, lancamento_origem_id, lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ? LIMIT 1').bind(receipt.share_lancamento_id).first<Row>()
  if (existing) {
    if (emailInfo?.id) {
      await db.prepare(`UPDATE lancamentos
        SET email_enviado_em = COALESCE(email_enviado_em, CURRENT_TIMESTAMP),
            email_enviado_id = COALESCE(email_enviado_id, ?1)
        WHERE id IN (?2, ?3)`).bind(
        emailInfo.id,
        existing.lancamento_origem_id,
        existing.lancamento_cliente_id,
      ).run()
    }
    return { ...existing, idempotent: true }
  }

  const amount = asPositiveCents(receipt.valor)
  const reimbursementId = id()
  const clientLancamentoId = id()
  const contaReceberId = id()
  const data = dateValue(body.data ?? receipt.data_emissao)
  const vencimento = nullableText(body.data_vencimento ?? receipt.data_vencimento) || data
  const cotistaId = text(receipt.cotista_aeronave_id)
  const fornecedorId = nullableText(body.fornecedor_id ?? body.fornecedores_favoritos_id ?? receipt.share_fornecedor_id)
  const fornecedor = await buscarFornecedor(db, fornecedorId) ?? await resolverFornecedor(db, fornecedorId, body.fornecedor_nome ?? body.fornecedor)
  const abastecimentosId = await linkedAbastecimentoId(db, receiptId)
  const vooEmprestado = abastecimentosId && schema.get('abastecimentos')?.has('voo_emprestado')
    ? Number((await db.prepare('SELECT voo_emprestado FROM abastecimentos WHERE id = ? LIMIT 1').bind(abastecimentosId).first<{ voo_emprestado: number | null }>())?.voo_emprestado) === 1
    : false
  const cotistaLancamentoId = vooEmprestado ? null : cotistaId
  if (abastecimentosId) {
    const lancamentoCotistaExistente = await db.prepare(`
      SELECT id FROM lancamentos
       WHERE abastecimentos_id = ?
         AND tipo_caixa = 'CLIENTE'
         AND UPPER(COALESCE(status, '')) <> 'CANCELADO'
       LIMIT 1
    `).bind(abastecimentosId).first<{ id: string }>()
    if (lancamentoCotistaExistente) {
      throw new FinanceError(
        'Este abastecimento já está associado a um lançamento ativo do caixa cotista',
        'abastecimento_ja_vinculado_a_lancamento_cotista',
        409,
      )
    }
  }
  const statements: D1PreparedStatement[] = [
    insertStatement(db, schema, 'reembolsos', {
      id: reimbursementId, lancamento_origem_id: receipt.share_lancamento_id, conta_receber_id: contaReceberId,
      lancamento_cliente_id: clientLancamentoId, cotista_id: cotistaId, valor_centavos: amount,
      status: 'AGUARDANDO_REEMBOLSO', idempotency_key: `programar-recibo-reembolso:${receiptId}`, criado_por: userId,
    }, ['id', 'lancamento_origem_id', 'valor_centavos']),
    insertStatement(db, schema, 'lancamentos', {
      id: clientLancamentoId, aeronave_id: receipt.aeronave_id, cotista_aeronave_id: cotistaLancamentoId,
      abastecimentos_id: abastecimentosId,
      descricao: receipt.descricao || 'Reembolso de despesa', grupo_categoria: 'CAIXA CLIENTE',
      fluxo: 'SAIDA', tipo_caixa: 'CLIENTE', valor_centavos: amount,
      data_emissao: data, data_vencimento: vencimento, status: 'EM_ABERTO',
      escopo_financeiro: 'FINANCEIRO', pago_diretamente: 0, reembolsavel: 0, reembolso_quitado: 0,
      fornecedores_favoritos_id: fornecedor?.id ?? null,
      fornecedor_nome: nullableText(fornecedor?.nome_completo),
      subcategoria_1: nullableText(body.subcategoria_1),
      subcategoria_2: nullableText(body.subcategoria_2),
      subcategoria_3: nullableText(body.subcategoria_3),
      subcategoria_4: nullableText(body.subcategoria_4),
      categoria_cliente_id: nullableText(body.categoria_id),
      categoria_nome: nullableText(body.categoria_nome ?? 'REEMBOLSO'),
      periodicidade: nullableText(body.periodicidade),
      numero_recibo: nullableText(receipt.numero_recibo),
      url_recibo: nullableText(receipt.url_recibo),
      origem_tipo: 'RECIBO_REEMBOLSO', origem_id: reimbursementId,
      idempotency_key: `recibo-reembolso-cliente:${receiptId}`, criado_por: userId,
    }, ['id', 'descricao', 'fluxo', 'valor_centavos']),
    insertStatement(db, schema, 'contas_areceber', {
      id: contaReceberId, data_vencimento: vencimento, valor_centavos: amount, descricao: receipt.descricao || 'Reembolso de despesa',
      categoria_nome: 'REEMBOLSO', aeronave_id: receipt.aeronave_id, cotista_id: cotistaId,
      lancamentos_id: clientLancamentoId, origem_tipo: 'RECIBO_REEMBOLSO', origem_id: receiptId,
      status: 'EM_ABERTO', idempotency_key: `recibo-reembolso-cliente:${receiptId}:CONTA_RECEBER`, criado_por: userId,
    }, ['id', 'valor_centavos']),
    linkStatement(db, schema, 'RECIBO', receiptId, 'LANCAMENTO', clientLancamentoId, 'RECIBO_LANCAMENTO_CLIENTE', userId),
    ...(abastecimentosId ? [linkStatement(db, schema, 'LANCAMENTO', clientLancamentoId, 'ABASTECIMENTO', abastecimentosId, 'LANCAMENTO_ABASTECIMENTO', userId)] : []),
    linkStatement(db, schema, 'LANCAMENTO', text(receipt.share_lancamento_id), 'CONTA_A_RECEBER', contaReceberId, 'REEMBOLSO_CONTA_RECEBER', userId),
    db.prepare('UPDATE lancamentos SET periodicidade = ?, numero_recibo = COALESCE(numero_recibo, ?), url_recibo = COALESCE(url_recibo, ?) WHERE id = ?')
      .bind(nullableText(body.periodicidade), nullableText(receipt.numero_recibo), nullableText(receipt.url_recibo), receipt.share_lancamento_id),
    ...(emailInfo?.id ? [
      db.prepare(`UPDATE lancamentos
        SET email_enviado_em = COALESCE(email_enviado_em, CURRENT_TIMESTAMP),
            email_enviado_id = COALESCE(email_enviado_id, ?1)
        WHERE id IN (?2, ?3)`)
        .bind(emailInfo.id, receipt.share_lancamento_id, clientLancamentoId),
    ] : []),
    auditStatement(db, schema, 'reembolsos', reimbursementId, 'PROGRAMACAO_REEMBOLSO', userId, null, amount, nullableText(body.observacoes), `programar-recibo-reembolso:${receiptId}`),
  ]
  try {
    await db.batch(statements)
  } catch (error) {
    // Índices únicos das chaves estáveis elegem uma única execução vencedora.
    // Se outra requisição concluiu a mesma programação, devolvemos seus IDs.
    const concurrent = await db.prepare(`SELECT id, conta_receber_id, lancamento_origem_id, lancamento_cliente_id
      FROM reembolsos WHERE lancamento_origem_id = ? LIMIT 1`).bind(receipt.share_lancamento_id).first<Row>().catch(() => null)
    if (!concurrent) throw error
    return {
      ...concurrent,
      lancamento_share_id: concurrent.lancamento_origem_id,
      idempotent: true,
    }
  }
  return { id: reimbursementId, lancamento_share_id: receipt.share_lancamento_id, lancamento_cliente_id: clientLancamentoId, conta_receber_id: contaReceberId, status: 'AGUARDANDO_REEMBOLSO', idempotent: false }
}

export async function emitirReciboColaborador(db: Database, body: Row, userId: string | null): Promise<Row> {
  if (text(body.tipo_recibo) !== 'recibo_colaborador') throw new FinanceError('Tipo de recibo inválido para colaborador', 'tipo_recibo_invalido')
  return issueReceiptInternal(db, body, userId, buildReceiptColaborador)
}

export async function emitirReciboPagamento(db: Database, body: Row, userId: string | null): Promise<Row> {
  if (text(body.tipo_recibo) !== 'recibo_pagamento') throw new FinanceError('Tipo de recibo inválido para pagamento', 'tipo_recibo_invalido')
  return issueReceiptInternal(db, body, userId, buildReceiptPagamento)
}

export async function emitirReciboSaida(db: Database, body: Row, userId: string | null): Promise<Row> {
  if (text(body.tipo_recibo) !== 'recibo_saida') throw new FinanceError('Tipo de recibo inválido para saída', 'tipo_recibo_invalido')
  return issueReceiptInternal(db, body, userId, buildReceiptSaida)
}

async function issueReceiptInternal(
  db: Database,
  body: Row,
  userId: string | null,
  buildFinance: ReceiptFinanceBuilder,
  existingReceiptId?: string,
): Promise<Row> {
  let input
  try {
    input = validateReceiptCommand(body)
  } catch (error) {
    throw new FinanceError(error instanceof Error ? error.message : 'Recibo inválido', 'recibo_invalido')
  }
  if (!input.descricao || !/^\d{4}-\d{2}-\d{2}/.test(input.data_emissao)) {
    throw new FinanceError('Descrição e data de emissão são obrigatórias', 'recibo_incompleto')
  }
  const abastecimentosId = nullableText(body.abastecimentos_id)
  if (abastecimentosId) {
    if (input.tipo_recibo !== 'recibo_reembolso') {
      throw new FinanceError('Abastecimento só pode ser vinculado a recibo de reembolso', 'abastecimento_tipo_recibo_invalido')
    }
    const abastecimento = await db.prepare('SELECT id, aeronave_id FROM abastecimentos WHERE id = ? LIMIT 1')
      .bind(abastecimentosId).first<{ id: string; aeronave_id: string | null }>()
    if (!abastecimento) throw new FinanceError('Abastecimento não encontrado', 'abastecimento_nao_encontrado', 404)
    if (input.aeronave_id && input.aeronave_id !== abastecimento.aeronave_id) {
      throw new FinanceError('O abastecimento selecionado pertence a outra aeronave', 'abastecimento_aeronave_incompativel')
    }
    input.aeronave_id = input.aeronave_id || abastecimento.aeronave_id
    const reciboVinculado = await db.prepare(`
      SELECT id FROM financeiro_vinculos
       WHERE origem_tipo = 'RECIBO'
         AND destino_tipo = 'ABASTECIMENTO'
         AND tipo_vinculo = 'RECIBO_ABASTECIMENTO'
         AND destino_id = ?
       LIMIT 1
    `).bind(abastecimentosId).first<{ id: string }>()
    const lancamentoCotista = await db.prepare(`
      SELECT id FROM lancamentos
       WHERE abastecimentos_id = ?
         AND tipo_caixa = 'CLIENTE'
         AND UPPER(COALESCE(status, '')) <> 'CANCELADO'
       LIMIT 1
    `).bind(abastecimentosId).first<{ id: string }>()
    if (reciboVinculado || lancamentoCotista) {
      throw new FinanceError('Este abastecimento já está associado a um recibo ou lançamento ativo do caixa cotista', 'abastecimento_ja_vinculado', 409)
    }
  }
  const schema = await loadSchema(db)
  requireTable(schema, 'recibos', ['id', 'tipo_recibo', 'pagador_tipo', 'pagador_id', 'valor', 'categoria_movimentacao_id', 'lancamento_id', 'status'])
  requireTable(schema, 'recibo_rateio', ['id', 'recibo_id', 'rateio_id', 'percentual', 'valor', 'cotista_id'])
  requireTable(schema, 'sequencia_numeros_recibos', ['id', 'cotista_aeronave_id', 'codigo_cliente', 'ano', 'proximo_numero'])

  const reciboId = existingReceiptId || id()
  const comando: Row = {
    ...body,
    recibo_id: reciboId,
    descricao: input.descricao,
    valor_centavos: input.valor_centavos,
    data: input.data_emissao,
    categoria_id: input.categoria_movimentacao_id,
    subcategoria_1: input.subcategoria_1,
    subcategoria_2: input.subcategoria_2,
    subcategoria_3: input.subcategoria_3,
    subcategoria_4: input.subcategoria_4,
    categoria_despesa_subcategoria: input.subcategoria_1,
    aeronave_id: input.aeronave_id,
    cotista_aeronave_id: input.pagador_tipo === 'cotista_aeronave' ? input.pagador_id : body.cotista_aeronave_id,
    cliente_id: input.pagador_tipo === 'cliente' ? input.pagador_id : body.cliente_id,
    tipo_caixa: ['cotista_aeronave', 'cliente'].includes(input.pagador_tipo) ? 'CLIENTE' : 'SHARE',
    grupo_categoria: input.grupo_categoria || (input.tipo_recibo === 'recibo_reembolso' ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA'),
    fluxo: 'SAIDA',
    pago_diretamente: input.tipo_recibo === 'recibo_pagamento' && ['cotista_aeronave', 'cliente'].includes(input.pagador_tipo),
    reembolsavel: input.tipo_recibo === 'recibo_reembolso',
  }
  const cotistaId = text(body.cotista_aeronave_id || (input.pagador_tipo === 'cotista_aeronave' ? input.pagador_id : '')) || null
  const codigoCotista = !existingReceiptId && !text(body.codigo_cliente) && cotistaId
    ? text((await db.prepare('SELECT codigo_cliente FROM cotista_aeronave WHERE id = ?').bind(cotistaId).first<{ codigo_cliente: string | null }>())?.codigo_cliente)
    : ''
  const codigo = text(body.codigo_cliente) || codigoCotista || 'SHARE'
  const ano = input.data_emissao.slice(0, 4)
  const numero = existingReceiptId ? text(body.numero_recibo) : await allocateReceiptNumber(db, cotistaId, codigo, ano)
  if (!numero) throw new FinanceError('Número do recibo não encontrado', 'numero_recibo_ausente', 500)
  let financeiroCriado: Row | null = null
  try {
    if (!existingReceiptId) {
      await createReceiptRecord(db, { ...input, ...body } as typeof input, reciboId, numero, userId)
      if (abastecimentosId) {
        await db.batch([
          linkStatement(db, schema, 'RECIBO', reciboId, 'ABASTECIMENTO', abastecimentosId, 'RECIBO_ABASTECIMENTO', userId),
        ])
      }
      return {
        recibo: {
          id: reciboId,
          numero_recibo: numero,
          tipo_recibo: input.tipo_recibo,
          pagador_tipo: input.pagador_tipo,
          pagador_id: input.pagador_id,
          nome_pagador: body.nome_pagador || null,
          documento_pagador: body.documento_pagador || null,
          endereco_pagador: body.endereco_pagador || null,
          cidade_pagador: body.cidade_pagador || null,
          uf_pagador: body.uf_pagador || null,
          recebedor_nome: input.recebedor_nome || null,
          recebedor_cpf: input.recebedor_cpf || null,
          recebedor_endereco: input.recebedor_endereco || null,
          recebedor_cidade: input.recebedor_cidade || null,
          recebedor_uf: input.recebedor_uf || null,
          aeronave_id: input.aeronave_id || null,
          rateado: 0,
          valor: input.valor_centavos,
          valor_centavos: input.valor_centavos,
          descricao: input.descricao,
          data_emissao: input.data_emissao,
          data_vencimento: input.data_vencimento || null,
          categoria_id: input.categoria_movimentacao_id,
          categoria_movimentacao_id: input.categoria_movimentacao_id,
          status: 'CRIADO',
          url_recibo: null,
          lancamento_id: null,
        },
        recibo_id: reciboId,
        numero_recibo: numero,
        lancamento_id: null,
        lancamento_cliente_id: null,
        rateio_ids: [],
        rateio_linhas: [],
        status: 'CRIADO',
        valor_centavos: input.valor_centavos,
      }
    }
    const categoriaNome = nullableText(body.categoria_nome) || nullableText(
      (await db.prepare(`
      SELECT nome FROM categoria_movimentacao_cliente WHERE id = ?
      UNION ALL
      SELECT nome FROM categoria_movimentacao_share WHERE id = ?
      LIMIT 1
    `).bind(input.categoria_movimentacao_id, input.categoria_movimentacao_id).first<{ nome: string | null }>())?.nome,
    )
    const financeiro = financeiroCriado = await buildFinance(db, schema, {
      ...comando,
      categoria_nome: categoriaNome,
    }, input, reciboId, userId)
    const lancamentoId = text('shareLancamentoId' in financeiro ? financeiro.shareLancamentoId : financeiro.lancamento_id ?? financeiro.id)
    const rateioLancamentoId = text('clienteLancamentoId' in financeiro ? financeiro.clienteLancamentoId : lancamentoId) || lancamentoId
    await db.prepare('UPDATE recibos SET lancamento_id = ? WHERE id = ?').bind(lancamentoId, reciboId).run()
    const rateios = input.tipo_recibo === 'recibo_saida'
      ? await createReceiptAllocations(db, reciboId, rateioLancamentoId)
      : []
    await db.batch([
      linkStatement(db, schema, 'RECIBO', reciboId, 'LANCAMENTO', lancamentoId, 'RECIBO_LANCAMENTO', userId),
      ...rateios.map((rateio) => linkStatement(db, schema, 'RECIBO', reciboId, 'RATEIO', String(rateio.id), 'RECIBO_RATEIO', userId)),
      auditStatement(db, schema, 'recibos', reciboId, 'CRIACAO_RECIBO', userId, null, input.valor_centavos, null, null),
    ])
    const statusAtual = await db.prepare('SELECT status FROM recibos WHERE id = ?').bind(reciboId).first<{ status: string }>()
    const statusFinal = String(statusAtual?.status ?? '').toUpperCase() === 'CRIADO'
      ? 'PDF_PENDENTE'
      : String(statusAtual?.status ?? 'PDF_PENDENTE')
    if (statusFinal === 'PDF_PENDENTE' && String(statusAtual?.status ?? '').toUpperCase() === 'CRIADO') {
      await updateReceiptStatus(db, reciboId, 'PDF_PENDENTE')
    }
    const recibo = {
      id: reciboId,
      numero_recibo: numero,
      tipo_recibo: input.tipo_recibo,
      pagador_tipo: input.pagador_tipo,
      pagador_id: input.pagador_id,
      aeronave_id: input.aeronave_id || null,
      rateado: rateios.length ? 1 : 0,
      valor: input.valor_centavos,
      valor_centavos: input.valor_centavos,
      descricao: input.descricao,
      data_emissao: input.data_emissao,
      categoria_id: input.categoria_movimentacao_id,
      categoria_movimentacao_id: input.categoria_movimentacao_id,
      status: statusFinal,
      lancamento_id: lancamentoId,
    }
    return { recibo, recibo_id: reciboId, numero_recibo: numero, lancamento_id: lancamentoId, lancamento_cliente_id: rateioLancamentoId, rateio_ids: rateios.map((rateio) => rateio.id), rateio_linhas: rateios, status: statusFinal, valor_centavos: input.valor_centavos }
  } catch (error) {
    const created = await db.prepare('SELECT lancamento_id FROM recibos WHERE id = ?').bind(reciboId).first<{ lancamento_id: string | null }>()
    const lancamentoIds = [...new Set([
      created?.lancamento_id,
      financeiroCriado?.shareLancamentoId,
      financeiroCriado?.clienteLancamentoId,
      financeiroCriado?.lancamento_id,
      financeiroCriado?.id,
      financeiroCriado?.lancamento_cliente_id,
    ].map((value) => text(value)).filter(Boolean))]
    await db.batch([
      db.prepare('DELETE FROM recibo_rateio WHERE recibo_id = ?').bind(reciboId),
      db.prepare('DELETE FROM financeiro_vinculos WHERE origem_id = ?').bind(reciboId),
      ...(lancamentoIds.length ? [
        db.prepare('DELETE FROM financeiro_vinculos WHERE destino_id IN (' + lancamentoIds.map(() => '?').join(', ') + ')').bind(...lancamentoIds),
      ] : []),
      ...lancamentoIds.flatMap((lancamentoId) => [
        db.prepare('DELETE FROM reembolsos WHERE lancamento_origem_id = ?').bind(lancamentoId),
        db.prepare('DELETE FROM contas_areceber WHERE lancamentos_id = ?').bind(lancamentoId),
        db.prepare('DELETE FROM contas_apagar WHERE lancamentos_id = ?').bind(lancamentoId),
        db.prepare('DELETE FROM rateio_despesas WHERE lancamento_id = ?').bind(lancamentoId),
        db.prepare('DELETE FROM lancamentos WHERE id = ?').bind(lancamentoId),
      ]),
      ...(!existingReceiptId ? [db.prepare('DELETE FROM recibos WHERE id = ?').bind(reciboId)] : []),
    ])
    throw error
  }
}

// Shared obligation resolution: reads never create expenses or allocations.
export async function resolveReceivableAllocations(db: Database, contas: Row[]): Promise<Map<string, { lancamentoId: string | null; shareLancamentoId?: string | null; rateios: Row[]; erro?: string }>> {
  const schema = await loadSchema(db)
  const result = new Map<string, { lancamentoId: string | null; shareLancamentoId?: string | null; rateios: Row[]; erro?: string }>()
  const targets = new Map<string, { target: string; holding: boolean }>()
  for (let i = 0; i < contas.length; i += 40) {
    const page = contas.slice(i, i + 40)
    const ids = page.map(c => c.id)
    const candidates = (await db.prepare(`SELECT cr.id AS conta_id, re.id AS reembolso_id, cl.id AS cliente_id,
        COALESCE(
          CASE WHEN UPPER(COALESCE(principal.tipo_caixa, '')) = 'SHARE' THEN principal.id END,
          share.id
        ) AS share_id
      FROM contas_areceber cr
      LEFT JOIN lancamentos principal ON principal.id = cr.lancamentos_id
      LEFT JOIN reembolsos re ON re.conta_receber_id = cr.id
      LEFT JOIN lancamentos cl ON cl.tipo_caixa = 'CLIENTE' AND COALESCE(cl.status, '') <> 'CANCELADO'
        AND (cl.id = re.lancamento_cliente_id OR (principal.tipo_caixa = 'CLIENTE' AND cl.id = principal.id)
          OR cl.origem_id = cr.lancamentos_id OR cl.origem_id = re.id
          OR cl.origem_id = COALESCE(cr.recibos_saida_id, cr.nf_saida_id, principal.origem_id))
        AND (cr.aeronave_id IS NULL OR cl.aeronave_id = cr.aeronave_id)
        AND (cr.cotista_id IS NULL OR cl.cotista_aeronave_id = cr.cotista_id)
      LEFT JOIN lancamentos share ON UPPER(COALESCE(share.tipo_caixa, '')) = 'SHARE'
        AND COALESCE(share.status, '') <> 'CANCELADO'
        AND (share.id = cr.lancamentos_id OR share.id = principal.origem_id OR share.origem_id = principal.id
          OR share.origem_id = cr.lancamentos_id OR share.origem_id = re.id)
        AND (cr.aeronave_id IS NULL OR share.aeronave_id = cr.aeronave_id)
      WHERE cr.id IN (${ids.map(() => '?').join(',')})
        AND UPPER(COALESCE(cr.origem_tipo, '')) <> 'RELATORIO_DESPESA_VIAGEM'`).bind(...ids).all<Row>()).results || []
    const relatorios = (await db.prepare(`SELECT cr.id AS conta_id,
        COALESCE(cliente.id, CASE WHEN UPPER(COALESCE(principal.tipo_caixa, '')) = 'CLIENTE' THEN principal.id END) AS lancamento_cliente_id,
        share.id AS lancamento_share_id,
        rd.*
      FROM contas_areceber cr
      LEFT JOIN lancamentos principal ON principal.id = cr.lancamentos_id
      LEFT JOIN lancamentos cliente ON cliente.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || cr.origem_id || ':REEMBOLSO_CLIENTE:LANCAMENTO_CLIENTE'
      LEFT JOIN lancamentos share ON share.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || cr.origem_id || ':REEMBOLSO_CLIENTE:LANCAMENTO_SHARE'
      LEFT JOIN rateio_despesas rd ON rd.cotista_id = cr.cotista_id
        AND COALESCE(rd.status, '') <> 'CANCELADO'
        AND (rd.lancamento_id = (SELECT id FROM lancamentos
              WHERE idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' || cr.origem_id || ':CUSTO_INTEGRAL' LIMIT 1)
          OR rd.id IN (SELECT destino_id FROM financeiro_vinculos
              WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = cr.origem_id
                AND destino_tipo = 'RATEIO_DESPESAS'))
      WHERE cr.id IN (${ids.map(() => '?').join(',')})
        AND UPPER(COALESCE(cr.origem_tipo, '')) = 'RELATORIO_DESPESA_VIAGEM'`).bind(...ids).all<Row>()).results || []
    for (const c of page) {
      const key = String(c.id)
      result.set(key, { lancamentoId: null, shareLancamentoId: null, rateios: [] })
      if (c.movimentos_id) { targets.set(key, { target: String(c.movimentos_id), holding: true }); continue }
      if (upper(c.origem_tipo) === 'RELATORIO_DESPESA_VIAGEM') {
        const matches = relatorios.filter(r => String(r.conta_id) === key)
        const link = matches[0]
        const rateios = matches.filter(r => r.id !== null && r.id !== undefined)
          .map(({ conta_id: _contaId, lancamento_cliente_id: _clienteId, lancamento_share_id: _shareId, ...rateio }) => rateio)
        result.set(key, {
          lancamentoId: nullableText(link?.lancamento_cliente_id),
          shareLancamentoId: nullableText(link?.lancamento_share_id),
          rateios,
          ...(!nullableText(link?.lancamento_cliente_id) || !nullableText(link?.lancamento_share_id)
            ? { erro: 'Lançamentos Cliente e Share do relatório não encontrados.' }
            : {}),
        })
        continue
      }
      const matches = candidates.filter(r => r.conta_id === c.id)
      const clients = [...new Set(matches.map(r => nullableText(r.cliente_id)).filter(Boolean))]
      const reimbursements = [...new Set(matches.map(r => nullableText(r.reembolso_id)).filter(Boolean))]
      if (clients.length > 1 || reimbursements.length > 1) {
        result.set(key, { lancamentoId: null, rateios: [], erro: 'Mais de um vínculo econômico para esta conta. Regularize os vínculos.' }); continue
      }
      const shareIds = [...new Set(matches.map(r => nullableText(r.share_id)).filter(Boolean))]
      if (shareIds.length > 1) {
        result.set(key, { lancamentoId: null, shareLancamentoId: null, rateios: [], erro: 'Mais de um lançamento Share para esta conta. Regularize os vínculos.' }); continue
      }
      const documento = ['RECIBO_SAIDA', 'NF_SAIDA'].includes(upper(c.origem_tipo)) || c.recibos_saida_id || c.nf_saida_id
      const target = clients[0] ?? (documento || reimbursements.length ? null : nullableText(c.lancamentos_id))
      if (target) {
        targets.set(key, { target, holding: false })
        result.get(key)!.lancamentoId = target
        result.get(key)!.shareLancamentoId = shareIds[0] ?? nullableText(c.lancamentos_id)
      }
    }
  }
  for (const holding of [false, true]) {
    const ids = [...new Set([...targets.values()].filter(t => t.holding === holding).map(t => t.target))]
    const table = holding ? 'rateio_hold' : 'rateio_despesas'
    const column = holding ? holdingMovementColumn(schema) : 'lancamento_id'
    for (let i = 0; i < ids.length; i += 40) {
      const page = ids.slice(i, i + 40)
      const rows = (await db.prepare(`SELECT * FROM ${table} WHERE ${column} IN (${page.map(() => '?').join(',')}) AND COALESCE(status, '') <> 'CANCELADO' ORDER BY id`).bind(...page).all<Row>()).results || []
      for (const [key, target] of targets) if (target.holding === holding && page.includes(target.target)) result.get(key)!.rateios = rows.filter(r => r[column] === target.target)
    }
  }
  for (const c of contas) {
    const key = String(c.id)
    const resolved = result.get(key)
    const shareId = nullableText(resolved?.shareLancamentoId)
    if (!resolved || resolved.rateios.length || !shareId || upper(c.origem_tipo) === 'RELATORIO_DESPESA_VIAGEM') continue
    const legacy = (await db.prepare(`SELECT rd.* FROM rateio_despesas rd
      WHERE rd.lancamento_id = ? AND COALESCE(rd.status, '') <> 'CANCELADO' ORDER BY rd.id`).bind(shareId).all<Row>()).results || []
    if (legacy.length) {
      resolved.rateios = legacy
      continue
    }
    const receiptRateios = (await db.prepare(`SELECT rd.* FROM recibo_rateio rr
      INNER JOIN rateio_despesas rd ON rd.id = rr.rateio_id
      WHERE rr.recibo_id = ? AND COALESCE(rd.status, '') <> 'CANCELADO' ORDER BY rd.id`).bind(c.origem_id).all<Row>().catch(() => ({ results: [] as Row[] }))).results || []
    if (receiptRateios.length) resolved.rateios = receiptRateios
  }
  return result
}
export async function resolveReceivableAllocation(db: Database, conta: Row): Promise<{ lancamentoId: string | null; shareLancamentoId?: string | null; rateios: Row[] }> {
  const resolved = (await resolveReceivableAllocations(db, [conta])).get(String(conta.id))!
  if (resolved.erro) throw new FinanceError(resolved.erro, 'vinculo_ambiguo', 409)
  return resolved
}

export function validSettlementDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

// Optimistic revision check runs inside the SAME atomic batch as payment writes.
async function readSettlementRevision(db: Database, key: string): Promise<number> {
  const row = await db.prepare('SELECT revisao FROM financeiro_baixa_revisoes WHERE chave = ?').bind(key).first<{ revisao: number }>()
  return Number(row?.revisao ?? 0)
}
function settlementRevisionStatement(db: Database, key: string, revision: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO financeiro_baixa_revisoes (chave, revisao) VALUES (?, 1)
    ON CONFLICT(chave) DO UPDATE SET revisao = CASE WHEN revisao = ? THEN revisao + 1 ELSE NULL END`).bind(key, revision)
}
async function commitSettlement(db: Database, statements: D1PreparedStatement[]) {
  try { await db.batch(statements) }
  catch (error) {
    if (String(error).includes('financeiro_baixa_revisoes')) throw new FinanceError('Pagamento alterado por outra operação. Recarregue os dados e confira o saldo.', 'baixa_concorrente', 409)
    throw error
  }
}

export async function contextoBaixaCotista(db: Database, entityId: string): Promise<Row> {
  const allocation = await db.prepare('SELECT * FROM rateio_despesas WHERE id = ?').bind(entityId).first<Row>()
  const referenciaId = nullableText(allocation?.lancamento_id) ?? entityId
  const lancamento = await db.prepare('SELECT * FROM lancamentos WHERE id = ?').bind(referenciaId).first<Row>()
  if (!lancamento) {
    const envio = await db.prepare(`SELECT id, tipo, tipo_caixa, status, descricao, aeronave_id, lancamento_id
      FROM envio_despesas WHERE id = ? OR lancamento_id = ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`).bind(referenciaId, referenciaId, referenciaId).first<Row>()
    if (envio && (upper(envio.tipo) === 'CLIENTE' || upper(envio.tipo_caixa) === 'CLIENTE')) {
      if (upper(allocation?.status) === 'CANCELADO') throw new FinanceError('Lançamento cancelado ou estornado', 'lancamento_cancelado', 409)
      const envioLancamentoId = nullableText(envio.lancamento_id) ?? String(envio.id)
      const rows = allocation
        ? [allocation]
        : (await db.prepare("SELECT * FROM rateio_despesas WHERE lancamento_id = ? AND COALESCE(status, '') <> 'CANCELADO' ORDER BY id").bind(envioLancamentoId).all<Row>()).results || []
      if (!rows.length) throw new FinanceError('Despesa sem rateio. Defina a responsabilidade antes da baixa.', 'rateio_nao_vinculado', 409)
      return {
        natureza: 'PAGAMENTO_DIRETO',
        conta_id: null,
        envio_id: envio.id,
        envio_lancamento_id: envioLancamentoId,
        lancamento: { id: null, descricao: envio.descricao ?? rows[0].descricao_despesa, aeronave_id: envio.aeronave_id ?? rows[0].aeronave_id },
        rateios: rows,
        cotista_id: allocation?.cotista_id ?? rows[0].cotista_id,
      }
    }
    throw new FinanceError('Lançamento vinculado não encontrado', 'lancamento_nao_encontrado', 404)
  }
  if (['CANCELADO', 'ESTORNO'].includes(upper(lancamento.status)) || upper(allocation?.status) === 'CANCELADO') throw new FinanceError('Lançamento cancelado ou estornado', 'lancamento_cancelado', 409)
  const contas = await db.prepare(`SELECT DISTINCT cr.* FROM contas_areceber cr
    LEFT JOIN reembolsos re ON re.conta_receber_id = cr.id
    WHERE (cr.lancamentos_id = ? OR cr.lancamentos_id = ? OR re.lancamento_cliente_id = ?
      OR cr.recibos_saida_id = ? OR cr.nf_saida_id = ?)
      AND COALESCE(cr.status, '') <> 'CANCELADO'`).bind(lancamento.id, nullableText(lancamento.origem_id), lancamento.id, nullableText(lancamento.origem_id), nullableText(lancamento.origem_id)).all<Row>()
  if ((contas.results || []).length > 1) throw new FinanceError('Mais de uma conta vinculada ao lançamento', 'vinculo_ambiguo', 409)
  const conta = contas.results?.[0]
  if (conta) {
    const resolved = await resolveReceivableAllocation(db, conta)
    if (allocation && !resolved.rateios.some(r => r.id === allocation.id)) throw new FinanceError('Rateio não pertence à conta identificada', 'rateio_fora_da_conta', 409)
    const rateios = allocation ? resolved.rateios.filter(r => r.id === allocation.id) : resolved.rateios
    if (!rateios.length) throw new FinanceError('Obrigação sem rateio vinculado. Regularize antes da baixa.', 'rateio_nao_vinculado', 409)
    return { natureza: 'RECEBIMENTO_SHARE', conta_id: conta.id, conta_status: conta.status, lancamento, rateios, cotista_id: conta.cotista_id }
  }
  if (upper(lancamento.tipo_caixa) !== 'CLIENTE' || !['SAIDA', 'DESPESA'].includes(upper(lancamento.fluxo))) throw new FinanceError('Utilize a baixa específica desta operação financeira', 'baixa_nao_suportada', 409)
  if (['RECIBO_SAIDA', 'NF_SAIDA', 'RECIBO_REEMBOLSO', 'REEMBOLSO'].includes(upper(lancamento.origem_tipo)) || asFlag(lancamento.reembolsavel)) throw new FinanceError('Cobrança da Share sem conta a receber válida. Regularize os vínculos.', 'conta_nao_vinculada', 409)
  const rows = allocation ? [allocation] : (await db.prepare("SELECT * FROM rateio_despesas WHERE lancamento_id = ? AND COALESCE(status, '') <> 'CANCELADO' ORDER BY id").bind(lancamento.id).all<Row>()).results || []
  if (!rows.length) throw new FinanceError('Despesa sem rateio. Defina a responsabilidade antes da baixa.', 'rateio_nao_vinculado', 409)
  return { natureza: 'PAGAMENTO_DIRETO', conta_id: null, lancamento, rateios: rows, cotista_id: allocation?.cotista_id ?? lancamento.cotista_aeronave_id }
}

export async function settleCotista(db: Database, entityId: string, body: Row, userId: string | null): Promise<Row> {
  const initial = await contextoBaixaCotista(db, entityId)
  if (initial.natureza === 'RECEBIMENTO_SHARE') {
    const payments = Array.isArray(body.pagamentos) ? body.pagamentos as RealPayment[] : []
    const allowed = new Set((initial.rateios as Row[]).map(r => String(r.id)))
    for (const p of payments) for (const r of p.rateios || []) {
      if (!allowed.has(r.rateio_id)) throw new FinanceError('Rateio fora da seleção', 'rateio_fora_da_conta')
    }
    // A selection containing one allocation must not silently settle another allocation.
    if (allowed.size === 1) for (const p of payments) if (!p.rateios?.length) p.rateios = [{ rateio_id: [...allowed][0], valor_centavos: p.valor_centavos }]
    return settleReceivable(db, String(initial.conta_id), { ...body, pagamentos: payments }, userId)
  }
  const lancamento = initial.lancamento as Row
  const lancamentoId = nullableText(lancamento.id)
  const envioId = nullableText(initial.envio_id)
  const envioLancamentoId = nullableText(initial.envio_lancamento_id) ?? envioId
  const aeronaveId = nullableText(lancamento.aeronave_id)
  const key = `direto:${lancamentoId ?? envioLancamentoId ?? entityId}`
  const revision = await readSettlementRevision(db, key)
  const context = await contextoBaixaCotista(db, entityId)
  const rows = context.rateios as Row[]
  const schema = await loadSchema(db)
  const payments = Array.isArray(body.pagamentos) ? body.pagamentos as RealPayment[] : []
  if (payments.length !== 1) throw new FinanceError('Informe um pagamento direto por confirmação', 'pagamento_direto_unico')
  const p = payments[0]
  const requestKey = nullableText(p.idempotency_key)
  if (!requestKey) throw new FinanceError('Identificador do pagamento obrigatório', 'idempotency_key_obrigatoria')
  if (requestKey.length > 128) throw new FinanceError('Identificador do pagamento inválido', 'idempotency_key_invalida')
  if (p.tipo_pagador !== 'COTISTA' || !p.pagador_cotista_id) throw new FinanceError('Pagamento direto exige identificar o cotista pagador', 'cotista_pagador_obrigatorio')
  const payer = await db.prepare('SELECT id FROM cotista_aeronave WHERE id = ? AND aeronave_id = ?').bind(p.pagador_cotista_id, aeronaveId).first<Row>()
  if (!payer) throw new FinanceError('Pagador não pertence à aeronave', 'pagador_invalido')
  if (!validSettlementDate(String(p.data_pagamento || ''))) throw new FinanceError('Data de pagamento inválida', 'data_pagamento_invalida')
  if (p.conta_bancaria_id) throw new FinanceError('Pagamento direto do cotista não utiliza uma conta bancária da Share', 'conta_share_em_pagamento_direto')
  const amount = asPositiveCents(p.valor_centavos)
  const allocations = p.rateios || []
  if (!allocations.length || new Set(allocations.map(r => r.rateio_id)).size !== allocations.length) throw new FinanceError('Distribuição de pagamento inválida', 'rateios_invalidos')
  if (allocations.reduce((s, r) => s + asPositiveCents(r.valor_centavos), 0) !== amount) throw new FinanceError('Valor diferente da soma dos rateios', 'distribuicao_pagamento_invalida')
  const idempotencyPrefix = `DIRETO-COTISTA:${requestKey}:`
  const existing = await db.prepare("SELECT * FROM rateio_pagamentos WHERE status = 'CONFIRMADO' AND substr(idempotency_key, 1, ?) = ?").bind(idempotencyPrefix.length, idempotencyPrefix).all<Row>()
  if ((existing.results || []).length) {
    const old = existing.results || []
    if (old.some(o => o.pagador_cotista_id !== p.pagador_cotista_id || o.data_pagamento !== p.data_pagamento || o.tipo_pagador !== 'COTISTA') || old.length !== allocations.length || !allocations.every(a => old.some(o => o.idempotency_key === `DIRETO-COTISTA:${requestKey}:${a.rateio_id}` && o.valor_centavos === a.valor_centavos))) throw new FinanceError('Chave de pagamento reutilizada com outros dados', 'idempotencia_conflitante', 409)
    return { ok: true, idempotent: true }
  }
  const statements: D1PreparedStatement[] = [settlementRevisionStatement(db, key, revision)]
  for (const a of allocations) {
    const r = rows.find(r => r.id === a.rateio_id)
    if (!r) throw new FinanceError('Rateio fora do lançamento', 'rateio_fora_da_conta')
    if (['PAGO', 'PAGO_DIRETAMENTE', 'REEMBOLSADO', 'CANCELADO'].includes(upper(r.status))) throw new FinanceError('Rateio já liquidado ou cancelado', 'rateio_ja_liquidado', 409)
    const next = Number(r.valor_pago_real_centavos || 0) + a.valor_centavos
    if (next > Number(r.valor_rateado_centavos)) throw new FinanceError('Pagamento excede o saldo do rateio', 'rateio_excedido')
    statements.push(insertStatement(db, schema, 'rateio_pagamentos', {
      id: id(), rateio_id: r.id, conta_receber_id: null, tipo_pagador: 'COTISTA', pagador_cotista_id: p.pagador_cotista_id,
      valor_centavos: a.valor_centavos, data_pagamento: p.data_pagamento, conta_bancaria_id: null,
      comprovante_url: nullableText(p.comprovante_url), forma_pagamento: nullableText(p.forma_pagamento), observacoes: nullableText(p.observacoes),
      status: 'CONFIRMADO', idempotency_key: `DIRETO-COTISTA:${requestKey}:${r.id}`, criado_por: userId,
    }, ['id', 'rateio_id', 'valor_centavos', 'idempotency_key']))
    statements.push(updateStatement(db, schema, 'rateio_despesas', {
      valor_pago_real_centavos: next, status: next === Number(r.valor_rateado_centavos) ? 'PAGO_DIRETAMENTE' : 'EM_ABERTO',
      data_pagamento: next === Number(r.valor_rateado_centavos) ? p.data_pagamento : null,
      pago_por: p.pagador_cotista_id, pago_diretamente: 1, atualizado_em: new Date().toISOString(),
    }, 'id = ?', [r.id]))
  }
  // Parent is paid only when EVERY active allocation is settled (including allocations outside the selection).
  if (lancamentoId) statements.push(db.prepare(`UPDATE lancamentos SET status = CASE WHEN NOT EXISTS (
      SELECT 1 FROM rateio_despesas WHERE lancamento_id = ? AND COALESCE(status, '') <> 'CANCELADO'
        AND valor_pago_real_centavos < valor_rateado_centavos) THEN 'PAGO' ELSE 'EM_ABERTO' END,
    data_pagamento = CASE WHEN NOT EXISTS (SELECT 1 FROM rateio_despesas WHERE lancamento_id = ? AND COALESCE(status, '') <> 'CANCELADO' AND valor_pago_real_centavos < valor_rateado_centavos) THEN ? ELSE NULL END,
    pago_diretamente = 1, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(lancamentoId, lancamentoId, p.data_pagamento, lancamentoId))
  if (envioId && envioLancamentoId) statements.push(db.prepare(`UPDATE envio_despesas SET status = 'CONCLUIDO', atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('CONVERTIDO', 'APROVADO', 'EMAIL_ENVIADO')
      AND EXISTS (SELECT 1 FROM rateio_despesas WHERE lancamento_id = ? AND COALESCE(status, '') <> 'CANCELADO')
      AND NOT EXISTS (SELECT 1 FROM rateio_despesas WHERE lancamento_id = ? AND COALESCE(status, '') <> 'CANCELADO'
        AND valor_pago_real_centavos < valor_rateado_centavos)`).bind(envioId, envioLancamentoId, envioLancamentoId))
  await commitSettlement(db, statements)
  return { ok: true, idempotent: false, natureza: 'PAGAMENTO_DIRETO', lancamento_id: lancamentoId, envio_id: envioId }
}

function receiptReplayMatches(p: RealPayment, saved: Row[]): boolean {
  if (!p.idempotency_key) return false
  const matches = saved.filter(r => String(r.idempotency_key || '').startsWith(`${p.idempotency_key}:`))
  if (!matches.length || matches.reduce((sum, r) => sum + Number(r.valor_centavos), 0) !== Number(p.valor_centavos)) return false
  if (matches.some(r => r.tipo_pagador !== p.tipo_pagador || nullableText(r.pagador_cotista_id) !== nullableText(p.pagador_cotista_id) || nullableText(r.pagador_holding_id) !== nullableText(p.pagador_holding_id) || r.data_pagamento !== p.data_pagamento || nullableText(r.conta_bancaria_id) !== nullableText(p.conta_bancaria_id))) return false
  return !p.rateios?.length || (matches.length === p.rateios.length && p.rateios.every(a => matches.some(r => r.rateio_id === a.rateio_id && Number(r.valor_centavos) === Number(a.valor_centavos))))
}
