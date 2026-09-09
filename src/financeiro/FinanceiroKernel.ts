type Row = Record<string, unknown>
type Database = D1Database

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

export const STATUS_LANCAMENTO = ['EM_ABERTO', 'PAGO', 'RECEBIDO', 'ATRASADO', 'EM_ATRASO', 'CANCELADO'] as const
export const STATUS_CONTA_PAGAR = ['EM_ABERTO', 'EM_ATRASO', 'PAGO', 'CANCELADO'] as const
export const STATUS_CONTA_RECEBER = ['EM_ABERTO', 'EM_ATRASO', 'RECEBIDO', 'PAGO', 'CANCELADO'] as const
export const STATUS_RATEIO = ['EM_ABERTO', 'PAGO', 'CANCELADO'] as const
export const STATUS_REEMBOLSO = ['PENDENTE', 'AGUARDANDO_REEMBOLSO', 'RECEBIDO', 'REEMBOLSADO', 'CANCELADO'] as const
export const STATUS_FILA = ['PENDENTE', 'PROCESSANDO', 'PROCESSADO', 'ERRO'] as const

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

const text = (value: unknown): string =>
  value == null ? '' : String(value).trim()

const nullableText = (value: unknown): string | null => {
  const valueText = text(value)
  return valueText || null
}

const asFlag = (value: unknown): boolean =>
  value === true ||
  value === 1 ||
  ['1', 'true', 'sim', 'yes'].includes(text(value).toLowerCase())

const asPositiveCents = (value: unknown): number => {
  const cents = Number(value)
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new FinanceError(
      'valor_centavos deve ser um inteiro maior que zero',
      'valor_centavos_invalido',
    )
  }
  return cents
}

const dateValue = (value: unknown): string => {
  const date = text(value) || new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
    throw new FinanceError('Data inválida', 'data_invalida')
  }
  return date
}

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

const id = (): string => crypto.randomUUID()

const upper = (value: unknown): string => text(value).toUpperCase()

// Categoria padrão do lançamento de receita e da conta a pagar do recibo.
// A categoria escolhida no formulário de recibo de pagamento pertence ao
// Caixa Cliente e não pode ser usada em contas_apagar, cuja FK aponta para
// categoria_movimentacao_share.
const CATEGORIA_SHARE_RECIBO = '73355581-c479-4a5d-b90b-90b3332f198e'

type SchemaCache = Map<string, Set<string>>

async function loadSchema(db: Database): Promise<SchemaCache> {
  const tables = [
    'lancamentos',
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
      .catch(() => ({ results: [] as Array<{ name: string }> }))

    schema.set(
      table,
      new Set((result.results || []).map((column) => String(column.name))),
    )
  }
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
  requireTable(schema, 'rateio_hold', ['id', 'movimento_holding_id', 'socio_id'])
  requireTable(schema, 'movimentos_holding', ['id'])
  requireTable(schema, 'reembolsos', ['id', 'lancamento_origem_id'])
  requireTable(schema, 'auditoria_financeira', ['id'])
  requireTable(schema, 'financeiro_vinculos', ['id', 'origem_tipo', 'origem_id', 'destino_tipo', 'destino_id', 'tipo_vinculo'])
  requireTable(schema, 'financeiro_fila', ['id', 'operacao', 'payload_json', 'status'])
}

const FRONTEND_CONTRACT_FIELDS = new Set([
  'idempotency_key', 'idempotencyKey', 'reference_id', 'valor_centavos', 'valorCentavos',
  'tipo_recibo', 'rateado', 'recibo_id',
  'descricao', 'descricao_servico', 'fluxo', 'data', 'data_emissao', 'data_vencimento',
  'vencimento', 'aeronave_id', 'cotista_aeronave_id', 'cotista_id', 'socio_id', 'holding_id',
  'categoria_id', 'categoria_nome', 'categoria', 'categoria_cliente_id', 'categoria_cliente_nome', 'categoria_despesa_id', 'categoria_despesa_subcategoria',
  'grupo_categoria_cliente', 'fornecedor_id', 'fornecedor', 'fornecedor_nome',
  'fornecedores_favoritos_id', 'recibos_saida_id', 'origem_tipo', 'origem_id', 'periodicidade', 'tipo_caixa',
  'cliente_id', 'recebedor_id', 'recebedor_nome', 'recebedor_cpf', 'recebedor_endereco', 'recebedor_cidade', 'recebedor_uf',
  'pagador_tipo', 'pagador_id', 'categoria_movimentacao_id', 'categoria_nome_manual', 'natureza_despesa', 'anexo_id', 'numero_documento_anexo',
  'forma_pagamento', 'conta_bancaria_id', 'data_pagamento', 'comprovante_url', 'observacoes', 'numero_recibo', 'url_recibo', 'pago_diretamente', 'pagoDiretamente',
  'pago_por', 'rateio_linhas', 'rateios', 'tipo_rateio', 'reembolsavel', 'colaborador_id',
  'lancamento_id', 'lancamento_origem_id', 'motivo', 'valor', 'operacao', 'payload', 'criar_lancamento_cliente',
  'modo_lancamento', 'tipo_movimento_hold', 'grupo_categoria', 'subcategoria_1',
  'subcategoria_2', 'subcategoria_3', 'subcategoria_4', 'data_competencia_demonstrativo',
])

const OPTIONAL_SCHEMA_COLUMNS = new Set([
  'idempotency_key', 'aeronave_id', 'cotista_aeronave_id', 'holding_id', 'socio_id',
  'cliente_id', 'fornecedor_id', 'fornecedores_favoritos_id', 'fornecedor_nome', 'categoria_id', 'categoria_nome',
  'grupo_categoria', 'categoria_cliente_id', 'data', 'data_lancamento', 'data_emissao', 'data_vencimento',
  'data_pagamento', 'prazo', 'valor', 'valor_total', 'tipo', 'natureza', 'tipo_caixa',
  'caixa', 'pago_por', 'pago_por_cotista_id', 'pago_por_socio_id', 'pago_diretamente',
  'reembolsavel', 'reembolso_quitado', 'forma_pagamento', 'conta_bancaria_id',
  'comprovante_url', 'observacoes', 'anexos_json', 'criado_por', 'origem_tipo',
  'origem_id', 'colaborador_ref_id', 'nf_saida_id', 'lancamentos_id', 'lancamento_id',
  'lancamento_cliente_id', 'movimentos_holding_id', 'movimento_holding_id',
  'periodicidade', 'tipo_rateio', 'percentual_sociedade', 'percentual_uso',
  'valor_total_centavos', 'valor_rateado_centavos', 'valor_pago_real_centavos',
  'valor_total', 'valor_rateado', 'descricao_despesa', 'categoria_custo_id',
  'cotista_nome', 'aeronave_registro', 'recibo_url', 'numero_recibo', 'motivo',
  'usuario_id', 'valor_anterior_centavos', 'valor_novo_centavos',
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

  const incompatible = Object.keys(values).filter(
    (column) => !available.has(column) && !OPTIONAL_SCHEMA_COLUMNS.has(column),
  )
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

  const incompatible = Object.keys(values).filter(
    (column) => !available.has(column) && !OPTIONAL_SCHEMA_COLUMNS.has(column),
  )
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

  return {
    ...body,
    idempotency_key: idempotencyKey(body),
    valor_centavos: valorCentavos,
    descricao,
    fluxo,
    data: dateValue(body.data ?? body.data_emissao),
    data_vencimento: nullableText(body.data_vencimento ?? body.vencimento),
    aeronave_id: nullableText(body.aeronave_id),
    cotista_aeronave_id: nullableText(
      body.cotista_aeronave_id ?? body.cotista_id ??
      (Array.isArray(body.rateios) ? (body.rateios[0] as Row)?.id : null) ??
      (Array.isArray(body.rateio_linhas) ? (body.rateio_linhas[0] as Row)?.cotista_id : null),
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
              hs.holding_id,
              COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome
         FROM cotista_aeronave ca
         LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
         LEFT JOIN cliente cl ON cl.id = ca.cliente_id
        WHERE (? <> '' AND ca.id = ?) OR (? <> '' AND ca.socio_id = ?)`,
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
  }
}

type AllocationLine = {
  cotistaId: string
  socioId: string | null
  holdingId: string | null
  percentual: number
  valorCentavos: number
  pagoPor: string | null
  pagoDiretamente: boolean
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
        valorCentavos: asPositiveCents(body.valor_centavos),
        pagoPor: nullableText(body.pago_por),
        pagoDiretamente: asFlag(
          body.pago_diretamente ?? body.pagoDiretamente,
        ),
      },
    ]
  }

  const amount = asPositiveCents(body.valor_centavos)
  const lines = supplied.map((line: Row) => ({
    cotistaId: text(line.cotista_id ?? line.cotista_aeronave_id),
    socioId: nullableText(line.socio_id),
    holdingId: nullableText(line.holding_id),
    percentual: Number(line.percentual ?? line.percentual_sociedade ?? 0),
    valorCentavos:
      line.valor_centavos != null
        ? asPositiveCents(line.valor_centavos)
        : Math.round(amount * Number(line.percentual ?? 0) / 100),
    pagoPor: nullableText(line.pago_por ?? line.pagoPor),
    pagoDiretamente: asFlag(
      line.pago_diretamente ?? line.pagoDiretamente ?? body.pago_diretamente ?? body.pagoDiretamente,
    ),
  }))

  if (lines.some((line) => !line.cotistaId || !Number.isFinite(line.percentual) || line.percentual < 0)) {
    throw new FinanceError(
      'Todo rateio precisa de cotista',
      'rateio_cotista_obrigatorio',
    )
  }

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
  if (!['TODOS', 'TODOS_COTISTAS', 'TODOS_OS_COTISTAS', 'IGUAL', 'IGUALMENTE'].includes(tipoRateio)) {
    return []
  }

  const aeronaveId = text(input.aeronave_id ?? command.aeronave_id)
  if (!aeronaveId) {
    throw new FinanceError('Aeronave obrigatória para rateio', 'rateio_aeronave_obrigatoria')
  }
  const cotistas = await db.prepare(
    'SELECT id FROM cotista_aeronave WHERE aeronave_id = ? ORDER BY id',
  ).bind(aeronaveId).all<{ id: string }>()
  const ids = cotistas.results ?? []
  if (!ids.length) {
    throw new FinanceError('Nenhum cotista encontrado para a aeronave', 'rateio_cotistas_invalidos')
  }

  const amount = asPositiveCents(input.valor_centavos)
  const percentual = 100 / ids.length
  const valorBase = Math.floor(amount / ids.length)
  let restante = amount - valorBase * ids.length
  return ids.map(({ id: cotistaId }) => ({
    cotista_id: cotistaId,
    percentual: Number(percentual.toFixed(3)),
    valor_centavos: valorBase + (restante-- > 0 ? 1 : 0),
    pago_diretamente: true,
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
    `SELECT id FROM cotista_aeronave WHERE id IN (${placeholders}) AND aeronave_id = ?`,
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
  userId: string | null,
): D1PreparedStatement {
  requireTable(schema, 'financeiro_vinculos', ['id', 'origem_tipo', 'origem_id', 'destino_tipo', 'destino_id', 'tipo_vinculo'])
    return db.prepare(
      `INSERT OR IGNORE INTO financeiro_vinculos
       (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id(), origemTipo, origemId, destinoTipo, destinoId, tipoVinculo)
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
  return lines.flatMap((line, index) => {
    const rateioId = rateioIds?.[index] ?? id()
    const statements: D1PreparedStatement[] = [
      insertStatement(
        db,
        schema,
        'rateio_despesas',
        {
          id: rateioId,
          lancamento_id: lancamentoId,
          cotista_id: line.cotistaId,
          aeronave_id: command.aeronave_id,
          data_emissao: dateValue(command.data_emissao ?? command.data),
          data_vencimento: nullableText(command.data_vencimento ?? command.vencimento),
          periodicidade: nullableText(command.periodicidade),
          categoria_id: nullableText(command.categoria_id),
          categoria_nome: nullableText(
            command.categoria_nome ?? command.categoria,
          ),
          tipo_rateio: upper(command.tipo_rateio || 'FIXO'),
          percentual_sociedade: line.percentual,
          percentual_uso: line.percentual,
          valor_total_centavos: amount,
          valor_rateado_centavos: line.valorCentavos,
          valor_total: amount / 100,
          valor_rateado: line.valorCentavos / 100,
          pago_por_cotista_id: line.pagoPor,
          pago_por: line.pagoPor,
          pago_diretamente: line.pagoDiretamente ? 1 : 0,
          status: line.pagoDiretamente ? 'PAGO_DIRETAMENTE' : 'EM_ABERTO',
          data_pagamento: line.pagoDiretamente ? command.data : null,
          descricao_despesa: command.descricao,
          observacoes: nullableText(command.observacoes),
          criado_por: userId,
        },
        ['id', 'cotista_id', 'aeronave_id'],
      ),
    ]

    if (line.pagoDiretamente) {
      const pagadorCotistaId = line.pagoPor || line.cotistaId
      statements.push(
        insertStatement(
          db,
          schema,
          'rateio_pagamentos',
          {
            id: id(),
            rateio_id: rateioId,
            recibo_id: nullableText(command.recibo_id),
            conta_receber_id: null,
            tipo_pagador: 'COTISTA',
            pagador_cotista_id: pagadorCotistaId,
            pagador_holding_id: null,
            valor_centavos: line.valorCentavos,
            data_pagamento: dateValue(command.data_pagamento ?? command.data),
            conta_bancaria_id: nullableText(command.conta_bancaria_id),
            comprovante_url: nullableText(command.comprovante_url),
            forma_pagamento: nullableText(command.forma_pagamento),
            status: 'CONFIRMADO',
            observacoes: nullableText(command.observacoes),
            idempotency_key: `DIRETO:${command.idempotency_key || lancamentoId}:${rateioId}`,
            criado_por: userId,
          },
          ['id', 'rateio_id', 'valor_centavos'],
        ),
      )
    }

    return statements
  })
}

function holdingAllocationStatements(
  db: Database,
  schema: SchemaCache,
  command: Row,
  movimentoId: string,
  lines: AllocationLine[],
  userId: string | null,
): D1PreparedStatement[] {
  const amount = asPositiveCents(command.valor_centavos)
  return lines.map((line) => {
    if (!line.socioId) {
      throw new FinanceError(
        'Rateio de holding precisa de socio_id',
        'socio_holding_obrigatorio',
      )
    }

    return insertStatement(
      db,
      schema,
      'rateio_hold',
      {
        id: id(),
        movimento_holding_id: movimentoId,
        aeronave_id: command.aeronave_id,
        socio_id: line.socioId,
        data_emissao: dateValue(command.data_emissao ?? command.data),
        data_vencimento: nullableText(command.data_vencimento ?? command.vencimento),
        periodicidade: nullableText(command.periodicidade),
        categoria_id: nullableText(command.categoria_id),
        categoria_nome: nullableText(
          command.categoria_nome ?? command.categoria,
        ),
        tipo_rateio: upper(command.tipo_rateio || 'FIXO'),
        percentual_sociedade: line.percentual,
        percentual_uso: line.percentual,
        valor_total_centavos: amount,
        valor_rateado_centavos: line.valorCentavos,
        valor_total: amount / 100,
        valor_rateado: line.valorCentavos / 100,
        pago_por_socio_id: line.pagoPor,
        pago_diretamente: line.pagoDiretamente ? 1 : 0,
        status: line.pagoDiretamente ? 'PAGO' : 'EM_ABERTO',
        data_pagamento: line.pagoDiretamente ? command.data : null,
        descricao_despesa: command.descricao,
        observacoes: nullableText(command.observacoes),
        criado_por: userId,
      },
      ['id', 'movimento_holding_id', 'aeronave_id', 'socio_id'],
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
  const command = normalizeCommand(body, userId, options)
  const existing = await findExistingByIdempotency(
    db,
    schema,
    String(command.idempotency_key || '') || null,
  )
  if (existing) return existing

  const context = await resolveCotista(db, command)
  const lines = allocationLines(command)
  const direct = asFlag(
    command.pago_diretamente ?? command.pagoDiretamente,
  )
  const reembolsavel = asFlag(command.reembolsavel)
  const amount = asPositiveCents(command.valor_centavos)
  await validateAllocationLines(db, command, lines, amount)

  if (context?.kind === 'HOLDING') {
    if (!lines.length && !text(command.recibo_id)) {
      throw new FinanceError(
        'Despesa de holding precisa de rateio',
        'rateio_holding_obrigatorio',
      )
    }
    const movimentoId = text(command.id) || id()
    const statements = [
      insertStatement(
        db,
        schema,
        'movimentos_holding',
        {
          id: movimentoId,
          holding_id: context.holdingId,
          socio_id: context.socioId,
          aeronave_id: context.aeronaveId || command.aeronave_id,
          data: command.data,
          data_movimento: command.data,
          descricao: command.descricao,
          fornecedor_nome: nullableText(command.fornecedor_nome ?? context?.nome),
          fornecedores_favoritos_id: nullableText(command.fornecedor_id),
          categoria_id: nullableText(command.categoria_id),
          categoria_nome: nullableText(
            command.categoria_nome ?? command.categoria,
          ),
          grupo_categoria: nullableText(command.grupo_categoria),
          fluxo: 'SAIDA',
          natureza: reembolsavel ? 'REEMBOLSO' : 'DESPESA',
          valor_centavos: amount,
          valor: amount / 100,
          pago_diretamente: direct ? 1 : 0,
          status: direct ? 'PAGO' : 'EM_ABERTO',
          criado_por: userId,
          observacoes: nullableText(command.observacoes),
          idempotency_key: command.idempotency_key,
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
        nullableText(command.idempotency_key),
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

  if (direct) {
    const lancamentoId = text(command.id) || id()
    const rateioIds = lines.map(() => id())
    const statements = clientAllocationStatements(
      db,
      schema,
      command,
      lancamentoId,
      lines,
      userId,
      rateioIds,
    )
    if (!statements.length && !text(command.recibo_id)) {
      throw new FinanceError(
        'Despesa direta precisa de rateio',
        'rateio_obrigatorio',
      )
    }
    await db.batch([
      insertStatement(
        db,
        schema,
        'lancamentos',
        {
          id: lancamentoId,
          aeronave_id: command.aeronave_id,
          cotista_aeronave_id: command.cotista_aeronave_id,
          descricao: command.descricao,
          categoria_id: command.tipo_caixa === 'CLIENTE' ? null : nullableText(command.categoria_id),
          categoria_cliente_id: command.tipo_caixa === 'CLIENTE'
            ? nullableText(command.categoria_cliente_id ?? command.categoria_id)
            : null,
          categoria_nome: nullableText(command.categoria_nome ?? command.categoria),
          grupo_categoria: nullableText(command.grupo_categoria || 'DESPESAS EMPRESA'),
          fluxo: 'SAIDA',
          natureza: 'DESPESA',
          tipo_caixa: command.tipo_caixa || 'SHARE',
          valor_centavos: amount,
          valor_total: amount / 100,
          valor: amount / 100,
          status: 'PAGO',
          data_lancamento: command.data,
          data_emissao: command.data,
          data_pagamento: command.data,
          pago_diretamente: 1,
          reembolsavel: 0,
          reembolso_quitado: 1,
          origem_tipo: 'DESPESA',
          origem_id: lancamentoId,
          idempotency_key: command.idempotency_key,
          criado_por: userId,
        },
        ['id', 'descricao', 'fluxo', 'valor_centavos'],
      ),
      ...statements,
      ...rateioIds.map((rateioId) => linkStatement(db, schema, 'DESPESA', lancamentoId, 'RATEIO', rateioId, 'DESPESA_RATEIO', userId)),
      auditStatement(
        db,
        schema,
        'lancamentos',
        lancamentoId,
        'CRIACAO_DESPESA_DIRETA',
        userId,
        null,
        amount,
        nullableText(command.motivo),
        nullableText(command.idempotency_key),
      ),
    ])
    return {
      lancamento_id: lancamentoId,
      rateio_ids: rateioIds,
      conta_pagar_id: null,
      valor_centavos: amount,
      status: 'PAGO',
      idempotent: false,
    }
  }

  const lancamentoId = text(command.id) || id()
  const contaPagarId = id()
  const status = 'EM_ABERTO'
  const statements = [
    insertStatement(
      db,
      schema,
      'lancamentos',
      {
        id: lancamentoId,
        aeronave_id: command.aeronave_id,
        cotista_aeronave_id: command.cotista_aeronave_id,
        descricao: command.descricao,
        fornecedor_nome: nullableText(command.fornecedor_nome ?? context?.nome),
        fornecedores_favoritos_id: nullableText(command.fornecedor_id),
        categoria_id: nullableText(command.categoria_id),
        categoria_nome: nullableText(
          command.categoria_nome ?? command.categoria ?? 'SEM CATEGORIA',
        ),
        grupo_categoria: nullableText(
          command.grupo_categoria ||
            (reembolsavel ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA'),
        ),
        fluxo: 'SAIDA',
        natureza: 'DESPESA',
        tipo_caixa: 'SHARE',
        valor_centavos: amount,
        valor_total: amount / 100,
        valor: amount / 100,
        status,
        data_lancamento: command.data,
        data_emissao: command.data,
        data_vencimento: command.data_vencimento,
        pago_diretamente: 0,
        reembolsavel: reembolsavel ? 1 : 0,
        reembolso_quitado: 0,
        origem_tipo: 'DESPESA',
        origem_id: lancamentoId,
        idempotency_key: command.idempotency_key,
        criado_por: userId,
        observacoes: nullableText(command.observacoes),
      },
      ['id', 'descricao', 'fluxo', 'valor_centavos'],
    ),
    insertStatement(
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
        descricao: command.descricao,
        aeronave_id: command.aeronave_id,
        fornecedor_id: nullableText(command.fornecedor_id),
        cotista_id: command.cotista_aeronave_id,
        lancamentos_id: lancamentoId,
        criado_por: userId,
        origem_tipo: 'DESPESA',
        idempotency_key: command.idempotency_key,
        status,
      },
      ['id', 'data_vencimento', 'valor_centavos', 'lancamentos_id'],
    ),
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
    contaPagarId,
    valor_centavos: amount,
    status,
    idempotent: false,
  }
}

export async function issueRevenue(
  db: Database,
  body: Row,
  userId: string | null,
  options: NormalizeOptions = {},
): Promise<Row> {
  const schema = await loadSchema(db)
  const command = normalizeCommand({ ...body, fluxo: 'ENTRADA' }, userId, options)
  const existing = await findExistingByIdempotency(
    db,
    schema,
    String(command.idempotency_key || '') || null,
  )
  if (existing) return existing

  const context = await resolveCotista(db, command)
  const amount = asPositiveCents(command.valor_centavos)
  const lancamentoId = id()
  const contaReceberId = id()
  const clientLancamentoId =
    context?.kind === 'CLIENTE' && body.criar_lancamento_cliente !== false
      ? id()
      : null

  const statements: D1PreparedStatement[] = [
    insertStatement(
      db,
      schema,
      'lancamentos',
      {
        id: lancamentoId,
        aeronave_id: context?.aeronaveId || command.aeronave_id,
        cotista_aeronave_id:
          context?.cotistaAeronaveId || command.cotista_aeronave_id,
        descricao: command.descricao,
        fornecedor_nome: nullableText(command.fornecedor_nome ?? context?.nome),
        fornecedores_favoritos_id: nullableText(command.fornecedor_id),
        fluxo: upper(command.origem_tipo) === 'RECIBO_SAIDA' ? 'RECEITA' : 'ENTRADA',
        natureza: 'RECEITA',
        tipo_caixa: 'SHARE',
        valor_centavos: amount,
        valor_total: amount / 100,
        valor: amount / 100,
        categoria_id: nullableText(command.categoria_id),
        categoria_nome: nullableText(
          command.categoria_nome ?? 'RECEITAS OPERACIONAIS',
        ),
        grupo_categoria: 'RECEITAS OPERACIONAIS',
        periodicidade: nullableText(command.periodicidade ?? (upper(command.origem_tipo) === 'RECIBO_SAIDA' ? 'MENSAL' : null)),
        data_emissao: command.data,
        data_vencimento: command.data_vencimento || command.data,
        origem_tipo: nullableText(command.origem_tipo) || 'RECEITA',
        origem_id: nullableText(command.origem_id),
        status: 'EM_ABERTO',
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
        origem_tipo: nullableText(command.origem_tipo) || 'RECEITA',
        idempotency_key: command.idempotency_key,
        criado_por: userId,
        status: 'EM_ABERTO',
      },
      ['id', 'valor_centavos'],
    ),
  ]

  if (clientLancamentoId) {
    statements.push(
      insertStatement(
        db,
        schema,
        'lancamentos',
        {
          id: clientLancamentoId,
          aeronave_id: context?.aeronaveId || command.aeronave_id,
          cotista_aeronave_id: context?.cotistaAeronaveId,
          descricao: command.descricao,
          fluxo: 'SAIDA',
          natureza: 'DESPESA',
          tipo_caixa: 'CLIENTE',
          valor_centavos: amount,
          valor_total: amount / 100,
          valor: amount / 100,
          categoria_id: null,
          categoria_cliente_id: nullableText(
            command.categoria_cliente_id ?? command.categoria_id,
          ),
          categoria_nome: nullableText(
            command.categoria_cliente_nome ?? command.categoria_nome,
          ),
          fornecedor_nome: nullableText(command.fornecedor_nome ?? context?.nome),
          fornecedores_favoritos_id: nullableText(command.fornecedor_id),
          grupo_categoria:
            nullableText(command.grupo_categoria_cliente) ||
            'ADM SHARE BRASIL',
          data_emissao: command.data,
          data_vencimento: command.data_vencimento || command.data,
          periodicidade: nullableText(command.periodicidade ?? 'MENSAL'),
          numero_recibo: nullableText(command.numero_recibo),
          url_recibo: nullableText(command.url_recibo),
          origem_tipo: upper(command.origem_tipo) === 'RECIBO_SAIDA' ? 'RECIBO_SAIDA' : 'RECEITA',
          origem_id: lancamentoId,
          status: 'EM_ABERTO',
          criado_por: userId,
        },
        ['id', 'descricao', 'fluxo', 'valor_centavos'],
      ),
    )
  }

  if (clientLancamentoId) {
    const clientRateioId = id()
    const reciboSaida = upper(command.origem_tipo) === 'RECIBO_SAIDA'
    statements.push(
      insertStatement(
        db,
        schema,
        'rateio_despesas',
        {
          id: clientRateioId,
          lancamento_id: clientLancamentoId,
          categoria_id: nullableText(command.categoria_cliente_id ?? command.categoria_id),
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
          pago_por_cotista_id: reciboSaida ? null : (context?.cotistaAeronaveId || command.cotista_aeronave_id),
          pago_diretamente: reciboSaida ? 0 : 1,
          percentual_sociedade: 100,
          percentual_uso: 100,
          valor_total_centavos: amount,
          valor_rateado_centavos: amount,
          valor_total: amount / 100,
          valor_rateado: amount / 100,
          status: reciboSaida ? 'AGUARDANDO_REEMBOLSO' : 'PAGO_DIRETAMENTE',
          numero_recibo: nullableText(command.numero_recibo),
          recibo_url: nullableText(command.url_recibo),
        },
        ['id', 'lancamento_id'],
      ),
      ...(reciboSaida ? [] : [insertStatement(
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
      )]),
    )
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

  await db.batch(statements)
  return {
    id: lancamentoId,
    contaReceberId,
    lancamentoClienteId: clientLancamentoId,
    valor_centavos: amount,
    status: 'EM_ABERTO',
    idempotent: false,
  }
}

export async function createReimbursement(
  db: Database,
  body: Row,
  userId: string | null,
): Promise<Row> {
  const schema = await loadSchema(db)
  const command = normalizeCommand(body, userId)
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
      'SELECT id, conta_receber_id FROM reembolsos WHERE lancamento_origem_id = ? ORDER BY criado_em DESC LIMIT 1',
    )
    .bind(originalId)
    .first<Row>()
  if (existing) return { ...existing, idempotent: true }

  const context = await resolveCotista(db, command)
  if (!context || context.kind !== 'CLIENTE') {
    throw new FinanceError(
      'Reembolso comum precisa de cotista cliente',
      'reembolso_cotista_invalido',
    )
  }

  const amount = asPositiveCents(command.valor_centavos)
  const reimbursementId = id()
  const shareLancamentoId = id()
  const clientLancamentoId = id()
  const contaReceberId = id()

  await db.batch([
    insertStatement(
      db,
      schema,
      'reembolsos',
      {
        id: reimbursementId,
        lancamento_origem_id: originalId,
        conta_receber_id: contaReceberId,
        cotista_id: context.cotistaAeronaveId,
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
        aeronave_id: context.aeronaveId,
        cotista_aeronave_id: context.cotistaAeronaveId,
        descricao: command.descricao || 'Reembolso de despesa',
        categoria_nome: 'REEMBOLSOS ENTRADAS',
        grupo_categoria: 'REEMBOLSOS ENTRADAS',
        fluxo: 'ENTRADA',
        natureza: 'REEMBOLSO',
        tipo_caixa: 'SHARE',
        valor_centavos: amount,
        valor_total: amount / 100,
        valor: amount / 100,
        status: 'AGUARDANDO_REEMBOLSO',
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
      'lancamentos',
      {
        id: clientLancamentoId,
        aeronave_id: context.aeronaveId,
        cotista_aeronave_id: context.cotistaAeronaveId,
        descricao: command.descricao || 'Reembolso de despesa',
        categoria_nome: nullableText(
          command.categoria_cliente_nome ?? 'REEMBOLSO',
        ),
        grupo_categoria: 'REEMBOLSO',
        fluxo: 'SAIDA',
        natureza: 'DESPESA',
        tipo_caixa: 'CLIENTE',
        valor_centavos: amount,
        valor_total: amount / 100,
        valor: amount / 100,
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
    valor_centavos: amount,
    status: 'PENDENTE',
    idempotent: false,
  }
}

export async function settlePayable(db: Database, payableId: string, body: Row, userId: string | null): Promise<Row> {
  const schema = await loadSchema(db)
  const row = await db.prepare('SELECT * FROM contas_apagar WHERE id = ?').bind(payableId).first<Row>()
  if (!row) throw new FinanceError('Conta a pagar não encontrada', 'nao_encontrado', 404)
  if (upper(row.status) === 'PAGO') return { ...row, idempotent: true }
  if (upper(row.status) === 'CANCELADO') throw new FinanceError('Conta cancelada não pode ser paga', 'conta_cancelada')

  const lancamentoId = nullableText(row.lancamentos_id ?? row.lancamento_id)
  if (!lancamentoId) throw new FinanceError('Conta a pagar sem lançamento vinculado', 'lancamento_obrigatorio')
  const lancamento = await db.prepare('SELECT id, tipo_caixa, fluxo, natureza, status FROM lancamentos WHERE id = ?').bind(lancamentoId).first<Row>()
  if (!lancamento) throw new FinanceError('Lançamento da conta a pagar não encontrado', 'lancamento_nao_encontrado')
  const caixa = upper(lancamento.tipo_caixa)
  const fluxo = upper(lancamento.fluxo)
  if (!['SHARE', 'HOLDING'].includes(caixa) || (fluxo !== 'SAIDA' && upper(lancamento.natureza) !== 'DESPESA')) {
    throw new FinanceError('A conta a pagar deve estar vinculada a uma despesa Share ou Holding', 'conta_pagar_origem_invalida')
  }

  const paymentDate = dateValue(body.data_pagamento ?? body.dataPagamento)
  const amount = asPositiveCents(row.valor_centavos)
  const bank = await resolveContaBancariaId(db, body.conta_bancaria_id ?? body.banco_pagamento ?? body.bancoPagamento)
  if (!bank) throw new FinanceError('Conta bancária do pagamento não encontrada', 'conta_bancaria_obrigatoria')
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = [
    updateStatement(db, schema, 'contas_apagar', { status: 'PAGO', data_pagamento: paymentDate, banco_pagamento: bank, comprovante_pagamento_url: nullableText(body.comprovante_url ?? body.comprovante_pagamento_url ?? body.comprovantePagamentoUrl), atualizado_em: now }, 'id = ?', [payableId]),
    updateStatement(db, schema, 'lancamentos', { status: 'PAGO', data_pagamento: paymentDate, conta_bancaria_id: bank, comprovante_url: nullableText(body.comprovante_url ?? body.comprovantePagamentoUrl), forma_pagamento: nullableText(body.forma_pagamento ?? body.formaPagamento), atualizado_em: now }, 'id = ?', [lancamentoId]),
    auditStatement(db, schema, 'contas_apagar', payableId, 'BAIXA', userId, amount, amount, nullableText(body.motivo), idempotencyKey(body)),
  ]
  await db.batch(statements)
  return { ...(await db.prepare('SELECT * FROM contas_apagar WHERE id = ?').bind(payableId).first<Row>()), idempotent: false }
}

type RealPayment = { idempotency_key?: string | null; data_pagamento?: string | null; conta_bancaria_id?: string | null; comprovante_url?: string | null; forma_pagamento?: string | null; observacoes?: string | null; tipo_pagador: 'COTISTA' | 'SHARE' | 'HOLDING'; pagador_cotista_id?: string | null; pagador_holding_id?: string | null; valor_centavos: number; rateios: Array<{ rateio_id: string; valor_centavos: number }> }

export async function settleReceivable(db: Database, receivableId: string, body: Row, userId: string | null): Promise<Row> {
  const schema = await loadSchema(db)
  const row = await db.prepare('SELECT * FROM contas_areceber WHERE id = ?').bind(receivableId).first<Row>()
  if (!row) throw new FinanceError('Conta a receber não encontrada', 'nao_encontrado', 404)
  if (upper(row.status) === 'RECEBIDO') return { ...row, idempotent: true }
  if (upper(row.status) === 'CANCELADO') throw new FinanceError('Conta a receber cancelada não pode ser baixada', 'conta_cancelada')

  const payments = Array.isArray(body.pagamentos) ? body.pagamentos as RealPayment[] : []
  if (!payments.length) throw new FinanceError('Informe pelo menos um pagador real', 'pagadores_obrigatorios')
  const total = asPositiveCents(row.valor_centavos)
  const shareId = nullableText(row.lancamentos_id ?? row.lancamento_id)
  const rateios = shareId ? await db.prepare("SELECT id, valor_rateado_centavos FROM rateio_despesas WHERE lancamento_id = ? AND status NOT IN ('CANCELADO')").bind(shareId).all<Row>() : { results: [] as Row[] }
  const allowed = new Map((rateios.results || []).map(r => [String(r.id), Number(r.valor_rateado_centavos)]))
  const existingByRateio = new Map<string, number>()
  const existingKeys = new Set<string>()
  const existing = await db.prepare("SELECT rateio_id, valor_centavos, idempotency_key FROM rateio_pagamentos WHERE conta_receber_id = ? AND status = 'CONFIRMADO'").bind(receivableId).all<Row>()
  for (const payment of existing.results || []) {
    const rid = String(payment.rateio_id)
    existingByRateio.set(rid, (existingByRateio.get(rid) || 0) + Number(payment.valor_centavos || 0))
    if (payment.idempotency_key) existingKeys.add(String(payment.idempotency_key).replace(/:[^:]+$/, ''))
  }
  const confirmadoAnterior = [...existingByRateio.values()].reduce((sum, value) => sum + value, 0)
  const acceptedPayments: RealPayment[] = []
  const distributed = new Map<string, number>()
  const statements: D1PreparedStatement[] = []
  let newTotal = 0
  for (const payment of payments) {
    const paymentKey = nullableText(payment.idempotency_key) || `${receivableId}:${payment.tipo_pagador}:${payment.valor_centavos}:${payment.data_pagamento || body.data_recebimento || body.dataRecebimento || ''}`
    if (existingKeys.has(paymentKey)) continue
    if (!['COTISTA', 'SHARE', 'HOLDING'].includes(payment.tipo_pagador)) throw new FinanceError('Tipo de pagador inválido', 'pagador_invalido')
    if (payment.tipo_pagador === 'COTISTA' && !payment.pagador_cotista_id) throw new FinanceError('Cotista pagador não informado', 'cotista_pagador_obrigatorio')
    if (payment.tipo_pagador === 'HOLDING' && !payment.pagador_holding_id) throw new FinanceError('Holding pagadora não informada', 'holding_pagadora_obrigatoria')
    const value = asPositiveCents(payment.valor_centavos)
    if (!Array.isArray(payment.rateios) || !payment.rateios.length) throw new FinanceError('Cada pagamento precisa de rateios', 'rateios_obrigatorios')
    if (!payment.data_pagamento || !/^\d{4}-\d{2}-\d{2}$/.test(String(payment.data_pagamento))) throw new FinanceError('Data do pagamento é obrigatória', 'data_pagamento_obrigatoria')
    const sum = payment.rateios.reduce((n, x) => n + asPositiveCents(x.valor_centavos), 0)
    if (sum !== value) throw new FinanceError('A distribuição dos rateios não confere com o pagamento', 'distribuicao_pagamento_invalida')
    const date = dateValue(payment.data_pagamento ?? body.data_recebimento ?? body.dataRecebimento)
    const bank = await resolveContaBancariaId(db, payment.conta_bancaria_id ?? body.conta_bancaria_id ?? body.banco_recebimento ?? body.bancoRecebimento ?? body.conta_bancaria ?? body.contaBancaria)
    if (!bank) throw new FinanceError('Conta bancária do pagamento não encontrada', 'conta_bancaria_obrigatoria')
    for (const allocation of payment.rateios) {
      const rid = text(allocation.rateio_id)
      const cents = asPositiveCents(allocation.valor_centavos)
      if (!allowed.has(rid)) throw new FinanceError('Rateio não pertence à conta a receber', 'rateio_fora_da_conta')
      const next = (existingByRateio.get(rid) || 0) + (distributed.get(rid) || 0) + cents
      if (next > (allowed.get(rid) || 0)) throw new FinanceError('Pagamento excede o valor esperado do rateio', 'rateio_excedido')
      distributed.set(rid, (distributed.get(rid) || 0) + cents)
      statements.push(insertStatement(db, schema, 'rateio_pagamentos', { id: id(), rateio_id: rid, conta_receber_id: receivableId, tipo_pagador: payment.tipo_pagador, pagador_cotista_id: payment.pagador_cotista_id || null, pagador_holding_id: payment.pagador_holding_id || null, valor_centavos: cents, data_pagamento: date, conta_bancaria_id: bank, comprovante_url: nullableText(payment.comprovante_url), forma_pagamento: nullableText(payment.forma_pagamento), status: 'CONFIRMADO', idempotency_key: `${paymentKey}:${rid}`, criado_por: userId }, ['id', 'rateio_id', 'conta_receber_id', 'valor_centavos', 'idempotency_key']))
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
    const paid = (existingByRateio.get(rid) || 0) + (distributed.get(rid) || 0)
    const expected = Number(r.valor_rateado_centavos)
    const status = paid >= expected ? 'REEMBOLSADO' : paid > 0 ? 'EM_ABERTO' : 'AGUARDANDO_REEMBOLSO'
    statements.push(updateStatement(db, schema, 'rateio_despesas', {
      valor_pago_real_centavos: paid,
      status,
      data_pagamento: paid ? lastDate : null,
      atualizado_em: new Date().toISOString(),
    }, 'id = ?', [rid]))
  }
  if (shareId) {
    const allPaid = (rateios.results || []).every(r => (existingByRateio.get(String(r.id)) || 0) + (distributed.get(String(r.id)) || 0) >= Number(r.valor_rateado_centavos))
    if (novoStatusConta === 'RECEBIDO') statements.push(updateStatement(db, schema, 'lancamentos', { status: 'RECEBIDO', data_pagamento: lastDate, conta_bancaria_id: lastBank, comprovante_url: nullableText(lastPayment.comprovante_url ?? body.comprovante_url ?? body.comprovanteRecebimentoUrl), forma_pagamento: nullableText(lastPayment.forma_pagamento ?? body.forma_pagamento ?? body.formaPagamento), atualizado_em: new Date().toISOString() }, 'id = ?', [shareId]))
    const origem = await db.prepare('SELECT origem_id FROM lancamentos WHERE id = ?').bind(shareId).first<Row>()
    const client = await db.prepare("SELECT id FROM lancamentos WHERE origem_id = ? AND tipo_caixa = 'CLIENTE' LIMIT 1").bind(origem?.origem_id ?? null).first<Row>()
    if (client && allPaid) statements.push(updateStatement(db, schema, 'lancamentos', { status: 'PAGO', data_pagamento: lastDate, atualizado_em: new Date().toISOString() }, 'id = ?', [client.id]))
  }
  statements.push(auditStatement(db, schema, 'contas_areceber', receivableId, 'BAIXA', userId, newTotal, finalTotal, nullableText(body.motivo), nullableText(body.idempotency_key)))
  await db.batch(statements)
  const updated = await db.prepare('SELECT * FROM contas_areceber WHERE id = ?').bind(receivableId).first<Row>()
  const updatedRateios = shareId
    ? await db.prepare('SELECT id, cotista_id, valor_rateado_centavos, valor_pago_real_centavos, status FROM rateio_despesas WHERE lancamento_id = ? ORDER BY rowid').bind(shareId).all<Row>()
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
  ])
  const rows = await db
    .prepare(
      `SELECT * FROM financeiro_fila
        WHERE status = 'PENDENTE'
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
                  erro = NULL
            WHERE id = ?
              AND status = 'PROCESSANDO'`,
        )
        .bind(row.id)
        .run()

      result.push({ id: row.id, status: 'PROCESSADO' })
    } catch (error) {
      await db
        .prepare(
          `UPDATE financeiro_fila
              SET status = 'ERRO',
                  erro = ?
            WHERE id = ?
              AND status = 'PROCESSANDO'`,
        )
        .bind(error instanceof Error ? error.message : String(error), row.id)
        .run()

      result.push({
        id: row.id,
        status: 'ERRO',
        erro: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

async function createReimbursementFinance(db: Database, schema: SchemaCache, command: Row, input: Row, receiptId: string, userId: string | null): Promise<{ shareLancamentoId: string; clienteLancamentoId: string | null; contaReceberId: string | null }> {
  const categoriaShare = await db.prepare(`
    SELECT id FROM categoria_movimentacao_share
     WHERE id = ? OR upper(COALESCE(nome, '')) LIKE '%REEMBOLS%' OR upper(COALESCE(grupo_categoria, '')) LIKE '%REEMBOLS%'
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, nome LIMIT 1
  `).bind(CATEGORIA_SHARE_RECIBO, CATEGORIA_SHARE_RECIBO).first<{ id: string }>()
  const cotista = await db.prepare(`
    SELECT id FROM cotista_aeronave
     WHERE id = ? OR (cliente_id = ? AND aeronave_id = ?)
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1
  `).bind(command.cotista_aeronave_id || '', input.cliente_id || '', input.aeronave_id || '', command.cotista_aeronave_id || '').first<{ id: string }>()
  if (!cotista?.id) throw new FinanceError('Cotista cliente não encontrado para o reembolso', 'cotista_reembolso_obrigatorio')

  const shareLancamentoId = id()
  const amount = asPositiveCents(input.valor_centavos)
  await db.batch([
    insertStatement(db, schema, 'lancamentos', {
      id: shareLancamentoId,
      aeronave_id: input.aeronave_id,
      cotista_aeronave_id: cotista.id,
      descricao: input.descricao,
      categoria_id: categoriaShare?.id ?? null,
      categoria_nome: 'REEMBOLSOS SHARE',
      grupo_categoria: 'DESPESAS REEMBOLSÁVEIS',
      fluxo: 'SAIDA',
      natureza: 'DESPESA',
      tipo_caixa: 'SHARE',
      valor_centavos: amount,
      valor_total: amount / 100,
      valor: amount / 100,
      status: 'EM_ABERTO',
      data_lancamento: input.data_emissao,
      data_emissao: input.data_emissao,
      data_vencimento: input.data_vencimento || input.data_emissao,
      pago_diretamente: 0,
      reembolsavel: 1,
      reembolso_quitado: 0,
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

async function buildReceiptPagamento(
  db: Database,
  _schema: SchemaCache,
  command: Row,
  input: Row,
  receiptId: string,
  userId: string | null,
): Promise<Row> {
  if (input.pagador_tipo === 'cotista_aeronave' && !text(input.pagador_id)) {
    throw new FinanceError(
      'Cotista pagador é obrigatório para recibo de pagamento',
      'cotista_pagador_obrigatorio',
    )
  }

  if (input.pagador_tipo === 'cotista_aeronave') {
    return createExpense(db, {
      ...command,
      recibo_id: receiptId,
      tipo_caixa: 'CLIENTE',
      fluxo: 'SAIDA',
      categoria_id: null,
      categoria_cliente_id: input.categoria_movimentacao_id,
      sem_rateio: true,
      pago_diretamente: true,
      reembolsavel: false,
    }, userId, { internal: true })
  }

  return createExpense(db, {
    ...command,
    tipo_caixa: 'SHARE',
    fluxo: 'SAIDA',
    sem_rateio: true,
    pago_diretamente: false,
    reembolsavel: false,
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
    clienteLancamentoId: result.lancamento_cliente_id ?? null,
  }
}

export async function finalizarRecibo(
  db: Database,
  receiptId: string,
  userId: string | null,
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

export async function emitirReciboReembolso(db: Database, body: Row, userId: string | null): Promise<Row> {
  if (text(body.tipo_recibo) !== 'recibo_reembolso') throw new FinanceError('Tipo de recibo inválido para reembolso', 'tipo_recibo_invalido')
  return issueReceiptInternal(db, body, userId, async (database, schema, command, input, receiptId, createdBy) =>
    createReimbursementFinance(database, schema, command, input, receiptId, createdBy),
  )
}

export async function programarReciboReembolso(db: Database, receiptId: string, body: Row, userId: string | null): Promise<Row> {
  const schema = await loadSchema(db)
  const receipt = await db.prepare(`SELECT r.*, l.id AS share_lancamento_id, l.aeronave_id, l.cotista_aeronave_id
    FROM recibos r LEFT JOIN lancamentos l ON l.id = r.lancamento_id
    WHERE r.id = ? AND r.tipo_recibo = 'recibo_reembolso' LIMIT 1`).bind(receiptId).first<Row>()
  if (!receipt || !text(receipt.share_lancamento_id)) throw new FinanceError('Recibo de reembolso não encontrado', 'recibo_reembolso_nao_encontrado', 404)
  const existing = await db.prepare('SELECT id, conta_receber_id FROM reembolsos WHERE lancamento_origem_id = ? LIMIT 1').bind(receipt.share_lancamento_id).first<Row>()
  if (existing) return { ...existing, idempotent: true }

  const amount = asPositiveCents(receipt.valor)
  const reimbursementId = id()
  const clientLancamentoId = id()
  const contaReceberId = id()
  const data = dateValue(body.data ?? receipt.data_emissao)
  const vencimento = nullableText(body.data_vencimento ?? receipt.data_vencimento) || data
  const cotistaId = text(receipt.cotista_aeronave_id)
  const statements: D1PreparedStatement[] = [
    insertStatement(db, schema, 'reembolsos', {
      id: reimbursementId, lancamento_origem_id: receipt.share_lancamento_id, conta_receber_id: contaReceberId,
      lancamento_cliente_id: clientLancamentoId, cotista_id: cotistaId, valor_centavos: amount,
      status: 'AGUARDANDO_REEMBOLSO', idempotency_key: `programar-recibo-reembolso:${receiptId}`, criado_por: userId,
    }, ['id', 'lancamento_origem_id', 'valor_centavos']),
    insertStatement(db, schema, 'lancamentos', {
      id: clientLancamentoId, aeronave_id: receipt.aeronave_id, cotista_aeronave_id: cotistaId,
      descricao: receipt.descricao || 'Reembolso de despesa', categoria_nome: 'REEMBOLSO', grupo_categoria: 'REEMBOLSO',
      fluxo: 'SAIDA', natureza: 'DESPESA', tipo_caixa: 'CLIENTE', valor_centavos: amount, valor_total: amount / 100,
      valor: amount / 100, status: 'AGUARDANDO_REEMBOLSO', data_lancamento: data, data_emissao: data,
      data_vencimento: vencimento, pago_diretamente: 0, reembolsavel: 0, reembolso_quitado: 0,
      origem_tipo: 'RECIBO_REEMBOLSO', origem_id: reimbursementId, criado_por: userId,
    }, ['id', 'descricao', 'fluxo', 'valor_centavos']),
    insertStatement(db, schema, 'contas_areceber', {
      id: contaReceberId, data_vencimento: vencimento, valor_centavos: amount, descricao: receipt.descricao || 'Reembolso de despesa',
      categoria_nome: 'REEMBOLSO', aeronave_id: receipt.aeronave_id, cotista_id: cotistaId,
      lancamentos_id: receipt.share_lancamento_id, origem_tipo: 'RECIBO_REEMBOLSO', origem_id: receiptId,
      status: 'EM_ABERTO', criado_por: userId,
    }, ['id', 'valor_centavos']),
    insertStatement(db, schema, 'rateio_despesas', {
      id: id(), lancamento_id: clientLancamentoId, aeronave_id: receipt.aeronave_id, cotista_id: cotistaId,
      data_emissao: data, data_vencimento: vencimento, percentual_sociedade: 100, percentual_uso: 100,
      valor_total_centavos: amount, valor_rateado_centavos: amount, valor_total: amount / 100, valor_rateado: amount / 100,
      tipo_rateio: 'FIXO', periodicidade: 'ÚNICO', status: 'AGUARDANDO_REEMBOLSO', descricao_despesa: receipt.descricao,
      pago_diretamente: 0, valor_pago_real_centavos: 0, criado_por: userId,
    }, ['id', 'lancamento_id', 'cotista_id', 'aeronave_id']),
    linkStatement(db, schema, 'RECIBO', receiptId, 'LANCAMENTO', clientLancamentoId, 'RECIBO_LANCAMENTO_CLIENTE', userId),
    linkStatement(db, schema, 'LANCAMENTO', text(receipt.share_lancamento_id), 'CONTA_A_RECEBER', contaReceberId, 'REEMBOLSO_CONTA_RECEBER', userId),
    auditStatement(db, schema, 'reembolsos', reimbursementId, 'PROGRAMACAO_REEMBOLSO', userId, null, amount, nullableText(body.observacoes), `programar-recibo-reembolso:${receiptId}`),
  ]
  await db.batch(statements)
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
    aeronave_id: input.aeronave_id,
    cotista_aeronave_id: input.pagador_tipo === 'cotista_aeronave' ? input.pagador_id : body.cotista_aeronave_id,
    tipo_caixa: input.pagador_tipo === 'cotista_aeronave' ? 'CLIENTE' : 'SHARE',
    grupo_categoria: input.grupo_categoria || (input.tipo_recibo === 'recibo_reembolso' ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA'),
    fluxo: 'SAIDA',
    pago_diretamente: input.tipo_recibo === 'recibo_pagamento' && input.pagador_tipo === 'cotista_aeronave',
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
  try {
  if (!existingReceiptId) {
    await createReceiptRecord(db, { ...input, ...body } as typeof input, reciboId, numero, userId)
    return {
      recibo: {
        id: reciboId,
        numero_recibo: numero,
        tipo_recibo: input.tipo_recibo,
        pagador_tipo: input.pagador_tipo,
        pagador_id: input.pagador_id,
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
  let financeiroCriado: Row | null = null
  const financeiro = financeiroCriado = await buildFinance(db, schema, {
    ...comando,
    categoria_nome: categoriaNome,
  }, input, reciboId, userId)
  const lancamentoId = text('shareLancamentoId' in financeiro ? financeiro.shareLancamentoId : financeiro.lancamento_id ?? financeiro.id)
  const rateioLancamentoId = text('clienteLancamentoId' in financeiro ? financeiro.clienteLancamentoId : lancamentoId)
  await db.prepare('UPDATE recibos SET lancamento_id = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(lancamentoId, reciboId).run()
  const rateios = input.tipo_recibo === 'recibo_saida'
    ? await createReceiptAllocations(db, reciboId, rateioLancamentoId)
    : []
  await db.batch([
    linkStatement(db, schema, 'RECIBO', reciboId, 'LANCAMENTO', lancamentoId, 'RECIBO_LANCAMENTO', userId),
    ...rateios.map((rateio) => linkStatement(db, schema, 'RECIBO', reciboId, 'RATEIO', String(rateio.id), 'RECIBO_RATEIO', userId)),
    auditStatement(db, schema, 'recibos', reciboId, 'CRIACAO_RECIBO', userId, null, input.valor_centavos, null, null),
  ])
  await updateReceiptStatus(db, reciboId, 'PDF_PENDENTE')
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
    status: 'PDF_PENDENTE',
    lancamento_id: lancamentoId,
  }
  return { recibo, recibo_id: reciboId, numero_recibo: numero, lancamento_id: lancamentoId, lancamento_cliente_id: rateioLancamentoId, rateio_ids: rateios.map((rateio) => rateio.id), rateio_linhas: rateios, status: 'PDF_PENDENTE', valor_centavos: input.valor_centavos }
  } catch (error) {
    const created = await db.prepare('SELECT lancamento_id FROM recibos WHERE id = ?').bind(reciboId).first<{ lancamento_id: string | null }>()
    const lancamentoIds = [...new Set([
      created?.lancamento_id,
      financeiroCriado?.shareLancamentoId,
      financeiroCriado?.clienteLancamentoId,
      financeiroCriado?.lancamento_id,
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
