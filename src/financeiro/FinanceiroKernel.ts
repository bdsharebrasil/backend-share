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

type SchemaCache = Map<string, Set<string>>

async function loadSchema(db: Database): Promise<SchemaCache> {
  const tables = [
    'lancamentos',
    'contas_apagar',
    'contas_areceber',
    'rateio_despesas',
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
  requireTable(schema, 'rateio_hold', ['id', 'movimento_holding_id', 'socio_id'])
  requireTable(schema, 'movimentos_holding', ['id'])
  requireTable(schema, 'reembolsos', ['id', 'lancamento_origem_id'])
  requireTable(schema, 'auditoria_financeira', ['id'])
  requireTable(schema, 'financeiro_vinculos', ['id', 'origem_tipo', 'origem_id', 'destino_tipo', 'destino_id', 'tipo_vinculo'])
  requireTable(schema, 'financeiro_fila', ['id', 'operacao', 'payload_json', 'status'])
}

const FRONTEND_CONTRACT_FIELDS = new Set([
  'idempotency_key', 'idempotencyKey', 'reference_id', 'valor_centavos', 'valorCentavos',
  'descricao', 'descricao_servico', 'fluxo', 'data', 'data_emissao', 'data_vencimento',
  'vencimento', 'aeronave_id', 'cotista_aeronave_id', 'cotista_id', 'socio_id', 'holding_id',
  'categoria_id', 'categoria_nome', 'categoria', 'categoria_cliente_id', 'categoria_cliente_nome',
  'grupo_categoria_cliente', 'fornecedor_id', 'fornecedor', 'fornecedor_nome',
  'fornecedores_favoritos_id', 'recibos_saida_id', 'origem_tipo', 'origem_id', 'periodicidade', 'tipo_caixa',
  'forma_pagamento', 'conta_bancaria_id', 'observacoes', 'pago_diretamente', 'pagoDiretamente',
  'pago_por', 'rateio_linhas', 'rateios', 'tipo_rateio', 'reembolsavel', 'colaborador_id',
  'motivo', 'valor', 'operacao', 'payload', 'criar_lancamento_cliente',
])

const OPTIONAL_SCHEMA_COLUMNS = new Set([
  'idempotency_key', 'aeronave_id', 'cotista_aeronave_id', 'holding_id', 'socio_id',
  'cliente_id', 'fornecedor_id', 'fornecedores_favoritos_id', 'fornecedor_nome', 'categoria_id', 'categoria_nome',
  'grupo_categoria', 'data', 'data_lancamento', 'data_emissao', 'data_vencimento',
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

function normalizeCommand(body: Row, userId: string | null): Row {
  validateFrontendContract(body)
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
      body.cotista_aeronave_id ?? body.cotista_id,
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
  if (!cotistaId) return null

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
        WHERE ca.id = ?`,
    )
    .bind(cotistaId)
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
      line.pago_diretamente ?? line.pagoDiretamente,
    ),
  }))

  if (lines.some((line) => !line.cotistaId)) {
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
  return lines.map((line, index) =>
    insertStatement(
      db,
      schema,
      'rateio_despesas',
      {
        id: rateioIds?.[index] ?? id(),
        lancamento_id: lancamentoId,
        cotista_id: line.cotistaId,
        aeronave_id: command.aeronave_id,
        fornecedor_id: nullableText(command.fornecedor_id),
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
        status: line.pagoDiretamente ? 'PAGO' : 'EM_ABERTO',
        data_pagamento: line.pagoDiretamente ? command.data : null,
        descricao_despesa: command.descricao,
        observacoes: nullableText(command.observacoes),
        criado_por: userId,
      },
      ['id', 'cotista_id', 'aeronave_id'],
    ),
  )
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
): Promise<Row> {
  const schema = await loadSchema(db)
  const command = normalizeCommand(body, userId)
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
    if (!lines.length) {
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
    if (!statements.length) {
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
          categoria_id: nullableText(command.categoria_id),
          categoria_nome: nullableText(command.categoria_nome ?? command.categoria),
          grupo_categoria: nullableText(command.grupo_categoria || 'DESPESAS EMPRESA'),
          fluxo: 'SAIDA',
          natureza: 'DESPESA',
          tipo_caixa: command.tipo_caixa || 'SHARE',
          valor_centavos: amount,
          valor_total: amount / 100,
          valor: amount / 100,
          status: 'PAGO_DIRETAMENTE',
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
      status: 'PAGO_DIRETAMENTE',
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
): Promise<Row> {
  const schema = await loadSchema(db)
  const command = normalizeCommand({ ...body, fluxo: 'ENTRADA' }, userId)
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
          categoria_id: nullableText(
            command.categoria_cliente_id ?? command.categoria_id,
          ),
          categoria_nome: nullableText(
            command.categoria_cliente_nome ?? command.categoria_nome,
          ),
          grupo_categoria:
            nullableText(command.grupo_categoria_cliente) ||
            'ADM SHARE BRASIL',
          data_emissao: command.data,
          data_vencimento: command.data_vencimento || command.data,
          origem_tipo: 'RECEITA',
          origem_id: lancamentoId,
          status: 'EM_ABERTO',
          criado_por: userId,
        },
        ['id', 'descricao', 'fluxo', 'valor_centavos'],
      ),
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

export async function settlePayable(
  db: Database,
  payableId: string,
  body: Row,
  userId: string | null,
): Promise<Row> {
  const schema = await loadSchema(db)
  const row = await db
    .prepare('SELECT * FROM contas_apagar WHERE id = ?')
    .bind(payableId)
    .first<Row>()

  if (!row) {
    throw new FinanceError('Conta a pagar não encontrada', 'nao_encontrado', 404)
  }
  if (upper(row.status) === 'PAGO') return { ...row, idempotent: true }
  if (upper(row.status) === 'CANCELADO') {
    throw new FinanceError(
      'Conta cancelada não pode ser paga',
      'conta_cancelada',
    )
  }

  const paymentDate = dateValue(body.data_pagamento ?? body.dataPagamento)
  const amount = asPositiveCents(row.valor_centavos)
  const lancamentoId = nullableText(row.lancamentos_id ?? row.lancamento_id)
  const statements: D1PreparedStatement[] = [
    updateStatement(
      db,
      schema,
      'contas_apagar',
      {
        status: 'PAGO',
        data_pagamento: paymentDate,
        banco_pagamento: await resolveContaBancariaId(
          db,
          body.banco_pagamento ?? body.bancoPagamento,
        ),
        comprovante_pagamento_url: nullableText(
          body.comprovante_pagamento_url ?? body.comprovantePagamentoUrl,
        ),
        atualizado_em: new Date().toISOString(),
      },
      'id = ?',
      [payableId],
    ),
  ]

  if (lancamentoId) {
    statements.push(
      updateStatement(
        db,
        schema,
        'lancamentos',
        {
          status: 'PAGO',
          data_pagamento: paymentDate,
          atualizado_em: new Date().toISOString(),
        },
        'id = ?',
        [lancamentoId],
      ),
    )

    const source = await db
      .prepare('SELECT * FROM lancamentos WHERE id = ?')
      .bind(lancamentoId)
      .first<Row>()

    if (source && asFlag(source.reembolsavel) && !asFlag(source.reembolso_quitado)) {
      const existing = await db
        .prepare(
          'SELECT id, conta_receber_id FROM reembolsos WHERE lancamento_origem_id = ? LIMIT 1',
        )
        .bind(lancamentoId)
        .first<Row>()

      if (!existing) {
        const context = await resolveCotista(db, {
          cotista_aeronave_id: source.cotista_aeronave_id,
        })
        if (!context || context.kind !== 'CLIENTE') {
          throw new FinanceError('Reembolso comum precisa de cotista cliente', 'reembolso_cotista_invalido')
        }
        const reimbursementId = id()
        const shareLancamentoId = id()
        const clientLancamentoId = id()
        const contaReceberId = id()
        statements.push(
          insertStatement(db, schema, 'reembolsos', {
            id: reimbursementId, lancamento_origem_id: lancamentoId,
            conta_receber_id: contaReceberId, cotista_id: context.cotistaAeronaveId,
            valor_centavos: amount, status: 'PENDENTE', criado_por: userId,
          }, ['id', 'lancamento_origem_id', 'valor_centavos']),
          insertStatement(db, schema, 'lancamentos', {
            id: shareLancamentoId, aeronave_id: context.aeronaveId,
            cotista_aeronave_id: context.cotistaAeronaveId, descricao: source.descricao || 'Reembolso de despesa',
            categoria_nome: 'REEMBOLSOS ENTRADAS', grupo_categoria: 'REEMBOLSOS ENTRADAS',
            fluxo: 'ENTRADA', natureza: 'REEMBOLSO', tipo_caixa: 'SHARE', valor_centavos: amount,
            valor_total: amount / 100, valor: amount / 100, status: 'AGUARDANDO_REEMBOLSO',
            data_emissao: paymentDate, data_vencimento: paymentDate, origem_tipo: 'REEMBOLSO',
            origem_id: reimbursementId, criado_por: userId,
          }, ['id', 'descricao', 'fluxo', 'valor_centavos']),
          insertStatement(db, schema, 'lancamentos', {
            id: clientLancamentoId, aeronave_id: context.aeronaveId,
            cotista_aeronave_id: context.cotistaAeronaveId, descricao: source.descricao || 'Reembolso de despesa',
            categoria_nome: 'REEMBOLSO', grupo_categoria: 'REEMBOLSO', fluxo: 'SAIDA', natureza: 'DESPESA',
            tipo_caixa: 'CLIENTE', valor_centavos: amount, valor_total: amount / 100, valor: amount / 100,
            status: 'EM_ABERTO', data_emissao: paymentDate, data_vencimento: paymentDate,
            origem_tipo: 'REEMBOLSO', origem_id: reimbursementId, criado_por: userId,
          }, ['id', 'descricao', 'fluxo', 'valor_centavos']),
          insertStatement(db, schema, 'contas_areceber', {
            id: contaReceberId, data_vencimento: paymentDate, valor_centavos: amount,
            descricao: source.descricao || 'Reembolso de despesa', categoria_nome: 'REEMBOLSOS ENTRADAS',
            aeronave_id: context.aeronaveId, cotista_id: context.cotistaAeronaveId,
            lancamentos_id: shareLancamentoId,
            origem_tipo: 'REEMBOLSO', criado_por: userId, status: 'EM_ABERTO',
          }, ['id', 'valor_centavos']),
          linkStatement(db, schema, 'DESPESA', lancamentoId, 'CONTA_A_PAGAR', payableId, 'DESPESA_CONTA_A_PAGAR', userId),
          linkStatement(db, schema, 'DESPESA', lancamentoId, 'REEMBOLSO', reimbursementId, 'DESPESA_REEMBOLSO', userId),
          linkStatement(db, schema, 'REEMBOLSO', reimbursementId, 'CONTA_A_RECEBER', contaReceberId, 'REEMBOLSO_CONTA_A_RECEBER', userId),
          auditStatement(db, schema, 'reembolsos', reimbursementId, 'CRIACAO_REEMBOLSO', userId, null, amount, null, idempotencyKey(body)),
        )
        statements.push(
          auditStatement(db, schema, 'contas_apagar', payableId, 'BAIXA', userId, amount, amount, nullableText(body.motivo), idempotencyKey(body)),
        )
        await db.batch(statements)
        return {
          ...(await db.prepare('SELECT * FROM contas_apagar WHERE id = ?').bind(payableId).first<Row>()),
          reimbursement: { id: reimbursementId, contaReceberId, lancamentoId: shareLancamentoId, lancamentoClienteId: clientLancamentoId, valor_centavos: amount, status: 'PENDENTE', idempotent: false },
          idempotent: false,
        }
      }
    }
  }

  statements.push(
    auditStatement(
      db,
      schema,
      'contas_apagar',
      payableId,
      'BAIXA',
      userId,
      amount,
      amount,
      nullableText(body.motivo),
      idempotencyKey(body),
    ),
  )

  await db.batch(statements)
  return {
    ...(await db
      .prepare('SELECT * FROM contas_apagar WHERE id = ?')
      .bind(payableId)
      .first<Row>()),
    idempotent: false,
  }
}

export async function settleReceivable(
  db: Database,
  receivableId: string,
  body: Row,
  userId: string | null,
): Promise<Row> {
  const schema = await loadSchema(db)
  const row = await db
    .prepare('SELECT * FROM contas_areceber WHERE id = ?')
    .bind(receivableId)
    .first<Row>()

  if (!row) {
    throw new FinanceError(
      'Conta a receber não encontrada',
      'nao_encontrado',
      404,
    )
  }
  if (upper(row.status) === 'RECEBIDO') return { ...row, idempotent: true }

  const receiptDate = dateValue(body.data_recebimento ?? body.dataRecebimento)
  const amount = asPositiveCents(row.valor_centavos)
  const shareId = nullableText(row.lancamentos_id ?? row.lancamento_id)
  const clientId = null
  const bancoRecebimento = await resolveContaBancariaId(
    db,
    body.banco_recebimento ?? body.bancoRecebimento ?? body.conta_bancaria ?? body.contaBancaria,
  )

  const statements: D1PreparedStatement[] = [
    updateStatement(
      db,
      schema,
      'contas_areceber',
      {
        status: 'RECEBIDO',
        data_recebimento: receiptDate,
        data_pagamento: receiptDate,
        banco_recebimento: nullableText(
          bancoRecebimento,
        ),
        comprovante_recebimento_url: nullableText(
          body.comprovante_recebimento_url ??
            body.comprovanteRecebimentoUrl,
        ),
        atualizado_em: new Date().toISOString(),
      },
      'id = ?',
      [receivableId],
    ),
  ]

  if (shareId) {
    statements.push(
      updateStatement(
        db,
        schema,
        'lancamentos',
        {
          status: 'RECEBIDO',
          data_pagamento: receiptDate,
          forma_pagamento: nullableText(body.forma_pagamento ?? body.formaPagamento),
          conta_bancaria_id: nullableText(body.conta_bancaria_id ?? body.contaBancariaId),
          comprovante_url: nullableText(body.comprovante_url ?? body.comprovanteUrl ?? body.comprovante_recebimento_url ?? body.comprovanteRecebimentoUrl),
          atualizado_em: new Date().toISOString(),
        },
        'id = ?',
        [shareId],
      ),
    )
  }

  if (clientId) {
    statements.push(
      updateStatement(
        db,
        schema,
        'lancamentos',
        {
          status: 'PAGO',
          data_pagamento: receiptDate,
          atualizado_em: new Date().toISOString(),
        },
        'id = ?',
        [clientId],
      ),
    )
  }

  const reciboSaidaId = nullableText(row.recibos_saida_id)
  if (reciboSaidaId) {
    statements.push(
      updateStatement(
        db,
        schema,
        'recibos_saida',
        { status: 'RECEBIDO', atualizado_em: new Date().toISOString() },
        'id = ?',
        [reciboSaidaId],
      ),
    )
  }
  if (row.nf_saida_id) {
    statements.push(
      updateStatement(
        db,
        schema,
        'notas_fiscais_saida',
        { status: 'RECEBIDO', atualizado_em: new Date().toISOString() },
        'id = ?',
        [row.nf_saida_id],
      ),
    )
  }

  const reimbursement = await db
    .prepare('SELECT * FROM reembolsos WHERE conta_receber_id = ? LIMIT 1')
    .bind(receivableId)
    .first<Row>()

  if (reimbursement) {
    statements.push(
      updateStatement(
        db,
        schema,
        'reembolsos',
        {
          status: 'RECEBIDO',
          recebido_em: receiptDate,
          atualizado_em: new Date().toISOString(),
        },
        'id = ?',
        [reimbursement.id],
      ),
    )

    if (reimbursement.lancamento_origem_id) {
      statements.push(
        updateStatement(
          db,
          schema,
          'lancamentos',
          {
            reembolso_quitado: 1,
            atualizado_em: new Date().toISOString(),
          },
          'id = ?',
          [reimbursement.lancamento_origem_id],
        ),
        updateStatement(
          db,
          schema,
          'rateio_despesas',
          {
            status: 'REEMBOLSADO',
            data_pagamento: receiptDate,
          },
          'lancamento_id = ?',
          [reimbursement.lancamento_origem_id],
        ),
      )
    }
  }

  statements.push(
    auditStatement(
      db,
      schema,
      'contas_areceber',
      receivableId,
      'BAIXA',
      userId,
      amount,
      amount,
      nullableText(body.motivo),
      idempotencyKey(body),
    ),
  )

  await db.batch(statements)
  return {
    ...(await db
      .prepare('SELECT * FROM contas_areceber WHERE id = ?')
      .bind(receivableId)
      .first<Row>()),
    idempotent: false,
  }
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


export async function issueReceipt(
  db: Database,
  body: Row,
  userId: string | null,
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

  const comando: Row = {
    ...body,
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
  const reciboId = id()
  const cotistaId = text(body.cotista_aeronave_id || (input.pagador_tipo === 'cotista_aeronave' ? input.pagador_id : ''))
  if (!cotistaId) throw new FinanceError('cotista_aeronave_id é obrigatório para gerar a sequência do recibo', 'cotista_sequencia_obrigatorio')
  const codigo = text(body.codigo_cliente) || 'SHARE'
  const ano = input.data_emissao.slice(0, 4)
  const numero = await allocateReceiptNumber(db, cotistaId, codigo, ano)
  await createReceiptRecord(db, input, reciboId, numero, userId)
  const financeiro = await createExpense(db, comando, userId)
  const lancamentoId = text(financeiro.lancamento_id ?? financeiro.id)
  await db.prepare('UPDATE recibos SET lancamento_id = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(lancamentoId, reciboId).run()
  const rateios = await createReceiptAllocations(db, reciboId, lancamentoId)
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
  return { recibo, recibo_id: reciboId, numero_recibo: numero, lancamento_id: lancamentoId, rateio_ids: rateios.map((rateio) => rateio.id), rateio_linhas: rateios, status: 'PDF_PENDENTE', valor_centavos: input.valor_centavos }
}
