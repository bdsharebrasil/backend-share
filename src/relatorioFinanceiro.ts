import { dateValue, nullableText, text, uuid } from './lib/strings'
import { ensureRelatorioContaAReceber, repairRelatorioContaReceberLinkStatements } from './financeiro/relatorioContaReceber'

type ReportRow = Record<string, any>

type Payer = 'tripulante_1' | 'tripulante_2' | 'cliente' | 'sharebrasil'
type OwnerKind = 'CLIENTE' | 'HOLDING'

type CotistaRow = {
  id: string
  socio_id: string | null
  holding_id: string | null
  percentual_sociedade: number | null
  nome: string | null
}

type Allocation = CotistaRow & {
  percentual_uso: number
  valor_rateado_centavos: number
}

const FORNECEDOR_RELATORIO_VIAGEM = 'SHARE BRASIL'

function addCalendarDays(value: unknown, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value))
  if (!match) return ''
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)).toISOString().slice(0, 10)
}

export function calcularVencimentoReembolsoTripulante(report: ReportRow): string {
  const approvalDates = [report.aprovado_tripulante_1_em, report.aprovado_tripulante_2_em, report.aprovado_tripulante_em]
    .map((value) => text(value))
    .filter((value) => /^\d{4}-\d{2}-\d{2}/.test(value))
    .sort()
  const approvalDate = approvalDates[approvalDates.length - 1] || new Date().toISOString().slice(0, 10)
  return addCalendarDays(approvalDate, 3)
}

function numberValue(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function normalizePayer(value: unknown): Payer {
  const normalized = text(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_')

  if (['tripulante_2', 'tripulante2', 'crew_2', 'crew2'].includes(normalized)) return 'tripulante_2'
  if (['cliente', 'client'].includes(normalized)) return 'cliente'
  if (['sharebrasil', 'share_brasil', 'share', 'empresa', 'share_brasil_empresa'].includes(normalized)) return 'sharebrasil'
  return 'tripulante_1'
}

function expensesFromReport(report: ReportRow): Array<Record<string, any>> {
  const raw = Array.isArray(report.despesas) ? report.despesas : (() => {
    try {
      const parsed = JSON.parse(String(report.despesas || '[]'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })()
  return raw
    .map((expense) => ({ ...expense, valor: numberValue(expense?.valor ?? expense?.amount) }))
    .filter((expense) => expense.valor > 0)
}

function payerDescription(report: ReportRow, payer: Payer): string {
  const matricula = text(report.matricula_aeronave) || text(report.aeronave_matricula)
  const nomeTripulante = payer === 'tripulante_2'
    ? text(report.nome_tripulante_2)
    : payer === 'tripulante_1'
      ? text(report.nome_tripulante)
      : ''
  return ['Relatório Despesa de Viagem', matricula, nomeTripulante].filter(Boolean).join(' - ')
}

async function prepareInsert(db: D1Database, table: string, row: Record<string, unknown>): Promise<D1PreparedStatement> {
  const info = await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()
  const columns = new Set((info.results || []).map((item) => String(item.name)))
  if (!columns.size) throw new Error(`tabela_financeira_ausente:${table}`)
  const entries = Object.entries(row).filter(([column, value]) => columns.has(column) && value !== undefined)
  if (!entries.length) throw new Error(`tabela_financeira_sem_colunas:${table}`)
  const names = entries.map(([column]) => column)
  return db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...entries.map(([, value]) => value ?? null))
}

async function selectCotistas(db: D1Database, report: ReportRow): Promise<{ kind: OwnerKind; rows: CotistaRow[] }> {
  const kind: OwnerKind = text(report.socio_id) ? 'HOLDING' : 'CLIENTE'
  let result: D1Result<CotistaRow>
  if (kind === 'HOLDING') {
    const selected = await db.prepare('SELECT holding_id FROM hold_socios WHERE id = ?1 LIMIT 1').bind(text(report.socio_id)).first<{ holding_id: string | null }>()
    const holdingId = text(selected?.holding_id)
    if (!holdingId) throw new Error('holding_do_socio_nao_encontrada')
    result = await db.prepare(`SELECT ca.id, ca.socio_id, hs.holding_id, ca.percentual_sociedade,
          COALESCE(hs.nome, ca.codigo_cliente) AS nome
       FROM cotista_aeronave ca
       INNER JOIN hold_socios hs ON hs.id = ca.socio_id
       WHERE ca.aeronave_id = ?1 AND hs.holding_id = ?2
       ORDER BY ca.id`).bind(text(report.aeronave_id), holdingId).all<CotistaRow>()
  } else {
    result = await db.prepare(`SELECT ca.id, ca.socio_id, NULL AS holding_id, ca.percentual_sociedade,
          COALESCE(cl.razao_social, ca.codigo_cliente) AS nome
       FROM cotista_aeronave ca
       LEFT JOIN cliente cl ON cl.id = ca.cliente_id
       WHERE ca.aeronave_id = ?1 AND ca.socio_id IS NULL
         AND (ca.id = ?2 OR ca.cliente_id = ?2)
       ORDER BY CASE WHEN ca.id = ?2 THEN 0 ELSE 1 END, ca.id
       LIMIT 1`).bind(text(report.aeronave_id), text(report.cliente_id)).all<CotistaRow>()
  }
  const rows = (result.results || []).filter((row) => text(row.id))
  if (!rows.length && kind === 'HOLDING') throw new Error('cotistas_holding_nao_encontrados')
  return { kind, rows }
}

function allocate(amountCentavos: number, rows: CotistaRow[], equally = false): Allocation[] {
  const positiveRows = rows.filter((row) => numberValue(row.percentual_sociedade) > 0)
  const sourceRows = equally ? rows : positiveRows.length ? positiveRows : rows
  const base = sourceRows.map((row) => equally ? 1 : numberValue(row.percentual_sociedade) || 1)
  const baseTotal = base.reduce((sum, value) => sum + value, 0)
  const rawAmounts = base.map((value) => amountCentavos * value / baseTotal)
  const amounts = rawAmounts.map(Math.floor)
  let remainder = amountCentavos - amounts.reduce((sum, value) => sum + value, 0)
  const order = rawAmounts.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction)
  for (const item of order) {
    if (remainder <= 0) break
    amounts[item.index] += 1
    remainder -= 1
  }
  return sourceRows
    .map((row, index) => ({
      ...row,
      percentual_uso: Number((base[index] / baseTotal * 100).toFixed(6)),
      valor_rateado_centavos: amounts[index],
    }))
    .filter((row) => row.valor_rateado_centavos > 0)
}

async function findTripulanteUserId(db: D1Database, tripulacaoId: unknown): Promise<string | null> {
  const id = text(tripulacaoId)
  if (!id) return null
  const row = await db.prepare('SELECT user_id FROM tripulacao WHERE id = ?1 LIMIT 1').bind(id).first<{ user_id: string | null }>()
  return nullableText(row?.user_id)
}

export async function findLancamentoClientId(db: D1Database, clientId: unknown): Promise<string | null> {
  const id = text(clientId)
  if (!id) return null
  // O cadastro usado pelo SHARE_DB se chama `cliente` (singular). Só associamos
  // o lançamento quando o ID recebido existe nessa tabela.
  const row = await db.prepare('SELECT id FROM cliente WHERE id = ?1 LIMIT 1').bind(id).first<{ id: string }>()
  return text(row?.id) || null
}

async function dataEmissaoRelatorio(db: D1Database, report: ReportRow, lancamentoId: string | null): Promise<string> {
  const sibling = await db.prepare(`SELECT data_emissao FROM lancamentos
    WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1
      AND (?2 IS NULL OR id <> ?2) AND COALESCE(trim(data_emissao), '') <> ''
    ORDER BY CASE WHEN categoria_nome = 'DESPESAS REEMBOLSÁVEIS' THEN 1 ELSE 0 END, criado_em
    LIMIT 1`).bind(text(report.id), lancamentoId).first<{ data_emissao: string | null }>()
  const approvalDates = [report.aprovado_tripulante_1_em, report.aprovado_tripulante_2_em, report.aprovado_tripulante_em]
    .map((value) => text(value))
    .filter((value) => /^\d{4}-\d{2}-\d{2}/.test(value))
    .sort()
  const approvalDate = approvalDates[approvalDates.length - 1]
  return dateValue(sibling?.data_emissao, dateValue(approvalDate, new Date().toISOString().slice(0, 10)))
}

async function addLinkStatements(
  db: D1Database,
  statements: D1PreparedStatement[],
  reportId: string,
  destinationType: string,
  destinationId: string,
  linkType: string,
) {
  statements.push(db.prepare(`INSERT OR IGNORE INTO financeiro_vinculos
    (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(uuid(), 'RELATORIO_DESPESA_VIAGEM', reportId, destinationType, destinationId, linkType))
}

async function addTripulantePayableStatements(
  db: D1Database,
  statements: D1PreparedStatement[],
  report: ReportRow,
  payer: Payer,
  amountCentavos: number,
  description: string,
  dueDate: string,
  lancamentoId: string | null,
  movimentoHoldingId: string | null,
  userId: string | null,
): Promise<string | null> {
  if (!['tripulante_1', 'tripulante_2'].includes(payer)) return null
  if (!['aprovado', 'enviado_cliente'].includes(text(report.status).toLowerCase())) return null

  const reportId = text(report.id)
  const idempotencyKey = `RELATORIO_DESPESA_VIAGEM:${reportId}:${payer}:CONTA_PAGAR`
  const existing = await db.prepare(`SELECT id, status FROM contas_apagar
    WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND idempotency_key = ?1
    ORDER BY criado_em LIMIT 1`).bind(idempotencyKey).first<{ id: string; status: string | null }>()
  const payableId = text(existing?.id) || uuid()
  const tripulanteId = payer === 'tripulante_1' ? text(report.tripulacao_id) : text(report.tripulante_id_2)
  const colaboradorId = await findTripulanteUserId(db, tripulanteId)

  if (existing?.id) {
    if (!['PAGO', 'CANCELADO'].includes(text(existing.status).toUpperCase())) {
      statements.push(db.prepare(`UPDATE contas_apagar SET
        data_vencimento = ?, valor_centavos = ?, categoria_nome = 'DESPESAS REEMBOLSÁVEIS',
        descricao = ?, aeronave_id = ?, lancamentos_id = COALESCE(?, lancamentos_id), movimentos_id = COALESCE(?, movimentos_id),
        colaborador_id = ?, tripulante_id = ?, atualizado_em = CURRENT_TIMESTAMP
        WHERE id = ?`).bind(
        dueDate, amountCentavos, description, text(report.aeronave_id), lancamentoId,
        movimentoHoldingId, colaboradorId, tripulanteId, payableId,
      ))
    }
  } else {
    statements.push(await prepareInsert(db, 'contas_apagar', {
      id: payableId,
      data_vencimento: dueDate,
      valor_centavos: amountCentavos,
      categoria_nome: 'DESPESAS REEMBOLSÁVEIS',
      descricao: description,
      aeronave_id: text(report.aeronave_id),
      lancamentos_id: lancamentoId,
      movimentos_id: movimentoHoldingId,
      colaborador_id: colaboradorId,
      tripulante_id: tripulanteId,
      status: 'EM_ABERTO',
      criado_por: userId,
      origem_tipo: 'RELATORIO_DESPESA_VIAGEM',
      idempotency_key: idempotencyKey,
    }))
  }
  await addLinkStatements(db, statements, reportId, 'CONTA_PAGAR', payableId, 'RELATORIO_CONTA_PAGAR')
  return payableId
}

async function addRateiosCliente(
  db: D1Database,
  statements: D1PreparedStatement[],
  report: ReportRow,
  allocations: Allocation[],
  amountCentavos: number,
  description: string,
  lancamentoCustoId: string,
  pagamentoDiretoCentavos: number,
) {
  const reportId = text(report.id)
  const existingResult = await db.prepare(`SELECT r.id, r.cotista_id, r.status, r.pago_diretamente,
      r.valor_pago_real_centavos, r.pago_por
    FROM rateio_despesas r
    LEFT JOIN financeiro_vinculos fv ON fv.destino_tipo = 'RATEIO_DESPESAS' AND fv.destino_id = r.id
    WHERE r.lancamento_id = ?1 OR (fv.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND fv.origem_id = ?2)
    ORDER BY r.criado_em, r.id`).bind(lancamentoCustoId, reportId).all<{
      id: string; cotista_id: string; status: string | null; pago_diretamente: number | boolean | null;
      valor_pago_real_centavos: number | null; pago_por: string | null;
    }>()
  const existingByCotista = new Map<string, NonNullable<typeof existingResult.results>[number]>()
  for (const row of existingResult.results || []) {
    if (!existingByCotista.has(text(row.cotista_id))) existingByCotista.set(text(row.cotista_id), row)
  }
  let directRemaining = Math.max(0, Math.round(pagamentoDiretoCentavos))
  for (const allocation of allocations) {
    const existing = existingByCotista.get(allocation.id)
    const reportedDirect = Math.min(directRemaining, allocation.valor_rateado_centavos)
    directRemaining -= reportedDirect
    const amountPaid = Math.max(Math.max(0, numberValue(existing?.valor_pago_real_centavos)), reportedDirect)
    const previouslyDirect = Number(existing?.pago_diretamente ?? 0) === 1 || existing?.pago_diretamente === true
    const fullyPaidDirectly = allocation.valor_rateado_centavos > 0
      && (reportedDirect >= allocation.valor_rateado_centavos || (previouslyDirect && reportedDirect === 0))
    const currentStatus = text(existing?.status).toUpperCase()
    const status = ['PAGO', 'RECEBIDO', 'REEMBOLSADO', 'CANCELADO', 'PAGO_DIRETAMENTE'].includes(currentStatus)
      ? currentStatus
      : fullyPaidDirectly ? 'PAGO_DIRETAMENTE' : currentStatus || 'EM_ABERTO'
    const paidBy = text(existing?.pago_por) || (reportedDirect > 0 ? allocation.id : null)
    const common = {
      aeronave_id: text(report.aeronave_id),
      cotista_id: allocation.id,
      data_emissao: dateValue(report.data_inicio, new Date().toISOString().slice(0, 10)),
      data_vencimento: dateValue(report.data_fim, dateValue(report.data_inicio, new Date().toISOString().slice(0, 10))),
      data_pagamento: null,
      categoria_nome: 'DESPESAS DE VIAGEM',
      tipo_rateio: 'VARIAVEL_POR_VOO',
      periodicidade: 'EVENTUAL',
      percentual_sociedade: numberValue(allocation.percentual_sociedade) || allocation.percentual_uso,
      percentual_uso: allocation.percentual_uso,
      valor_total_centavos: amountCentavos,
      valor_rateado_centavos: allocation.valor_rateado_centavos,
      pago_por: paidBy,
      pago_diretamente: fullyPaidDirectly ? 1 : 0,
      valor_pago_real_centavos: amountPaid,
      status,
      descricao_despesa: description,
      observacoes: `Origem: relatório ${text(report.numero_relatorio) || text(report.id)}`,
    }
    if (existing?.id) {
      statements.push(db.prepare(`UPDATE rateio_despesas SET
        lancamento_id = ?, aeronave_id = ?, cotista_id = ?, data_emissao = ?, data_vencimento = ?,
        categoria_nome = ?, tipo_rateio = ?, periodicidade = ?, percentual_sociedade = ?, percentual_uso = ?,
        valor_total_centavos = ?, valor_rateado_centavos = ?, pago_por = ?, pago_diretamente = ?,
        valor_pago_real_centavos = ?, status = ?, descricao_despesa = ?, observacoes = ?
        WHERE id = ?`).bind(
        lancamentoCustoId, common.aeronave_id, common.cotista_id, common.data_emissao, common.data_vencimento,
        common.categoria_nome, common.tipo_rateio, common.periodicidade, common.percentual_sociedade,
        common.percentual_uso, common.valor_total_centavos, common.valor_rateado_centavos, common.pago_por,
        common.pago_diretamente, common.valor_pago_real_centavos, common.status, common.descricao_despesa,
        common.observacoes, existing.id,
      ))
      await addLinkStatements(db, statements, reportId, 'RATEIO_DESPESAS', existing.id, 'RELATORIO_RATEIO_DESPESA')
    } else {
      const rateioId = uuid()
      statements.push(await prepareInsert(db, 'rateio_despesas', { id: rateioId, lancamento_id: lancamentoCustoId, ...common }))
      await addLinkStatements(db, statements, reportId, 'RATEIO_DESPESAS', rateioId, 'RELATORIO_RATEIO_DESPESA')
    }
  }
}

async function ensureLancamentoCustoIntegral(
  db: D1Database,
  statements: D1PreparedStatement[],
  report: ReportRow,
  allocations: Allocation[],
  amountCentavos: number,
  description: string,
  dueDate: string,
  numeroVooId: string | null,
  clienteId: string | null,
  userId: string | null,
): Promise<string> {
  const reportId = text(report.id)
  const idempotencyKey = `RELATORIO_DESPESA_VIAGEM:${reportId}:CUSTO_INTEGRAL`
  const existing = await db.prepare(`SELECT id FROM lancamentos
    WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1 AND idempotency_key = ?2 LIMIT 1`)
    .bind(reportId, idempotencyKey).first<{ id: string }>()
  const id = text(existing?.id) || uuid()
  const dataEmissao = dateValue(report.data_inicio)
  const values = {
    id,
    aeronave_id: text(report.aeronave_id),
    cotista_aeronave_id: allocations[0]?.id || null,
    cliente_id: clienteId,
    data_emissao: dataEmissao,
    data_vencimento: dueDate,
    descricao: description,
    categoria_nome: 'DESPESAS DE VIAGEM',
    grupo_categoria: 'DESPESAS DE VIAGEM',
    periodicidade: 'EVENTUAL',
    status: 'EM_ABERTO',
    fluxo: 'SAIDA',
    tipo_caixa: 'CLIENTE',
    valor_centavos: amountCentavos,
    pago_por: null,
    pago_diretamente: 0,
    reembolsavel: 0,
    reembolso_quitado: 0,
    observacoes: `Origem: relatório ${text(report.numero_relatorio) || reportId}`,
    criado_por: userId,
    origem_tipo: 'RELATORIO_DESPESA_VIAGEM',
    origem_id: reportId,
    idempotency_key: idempotencyKey,
    numero_doc: text(report.numero_relatorio),
    numero_voo: numeroVooId,
    fornecedor_nome: FORNECEDOR_RELATORIO_VIAGEM,
    url_doc: text(report.pdf_path) || null,
    escopo_financeiro: 'FINANCEIRO',
  }
  if (existing?.id) {
    statements.push(db.prepare(`UPDATE lancamentos SET aeronave_id = ?, cotista_aeronave_id = ?, cliente_id = ?,
      data_emissao = ?, data_vencimento = ?, descricao = ?, categoria_nome = ?, grupo_categoria = ?,
      periodicidade = ?, fluxo = ?, tipo_caixa = ?, valor_centavos = ?, numero_doc = ?, numero_voo = ?,
      fornecedor_nome = ?, url_doc = ?, escopo_financeiro = 'FINANCEIRO' WHERE id = ?`)
      .bind(values.aeronave_id, values.cotista_aeronave_id, values.cliente_id, values.data_emissao,
        values.data_vencimento, values.descricao, values.categoria_nome, values.grupo_categoria,
        values.periodicidade, values.fluxo, values.tipo_caixa, values.valor_centavos, values.numero_doc,
        values.numero_voo, values.fornecedor_nome, values.url_doc, id))
  } else {
    statements.push(await prepareInsert(db, 'lancamentos', values))
  }
  await addLinkStatements(db, statements, reportId, 'LANCAMENTO', id, 'RELATORIO_CUSTO_INTEGRAL')
  return id
}

async function addRateiosHolding(
  db: D1Database,
  statements: D1PreparedStatement[],
  report: ReportRow,
  allocations: Allocation[],
  amountCentavos: number,
  description: string,
  userId: string | null,
) {
  const movimentoStatus = 'EM_ABERTO'
  const rateioStatus = 'EM_ABERTO'
  const movimentoId = uuid()
  statements.push(await prepareInsert(db, 'movimentos_holding', {
    id: movimentoId,
    holding_id: allocations[0]?.holding_id,
    socio_id: allocations[0]?.socio_id,
    aeronave_id: text(report.aeronave_id),
    tipo_caixa: 'HOLD',
    data_emissao: dateValue(report.data_inicio, new Date().toISOString().slice(0, 10)),
    data_vencimento: dateValue(report.data_vencimento_reembolso, dateValue(report.data_fim, dateValue(report.data_inicio, new Date().toISOString().slice(0, 10)))),
    data_pagamento: null,
    descricao: description,
    categoria_nome: 'DESPESAS DE VIAGEM',
    grupo_categoria: 'DESPESAS DE VIAGEM',
    fluxo: 'SAIDA',
    valor_centavos: amountCentavos,
    status: movimentoStatus,
    pago_diretamente: 0,
    colaborador_id: null,
    criado_por: userId,
    observacoes: `Origem: relatório ${text(report.numero_relatorio) || text(report.id)}`,
  }))
  await addLinkStatements(db, statements, text(report.id), 'MOVIMENTO_HOLDING', movimentoId, 'RELATORIO_MOVIMENTO_HOLDING')
  for (const allocation of allocations) {
    if (!allocation.socio_id) continue
    const rateioId = uuid()
    statements.push(await prepareInsert(db, 'rateio_hold', {
      id: rateioId,
      movimento_holding_id: movimentoId,
      aeronave_id: text(report.aeronave_id),
      socio_id: allocation.socio_id,
      data_emissao: dateValue(report.data_inicio, new Date().toISOString().slice(0, 10)),
      data_vencimento: dateValue(report.data_fim, dateValue(report.data_inicio, new Date().toISOString().slice(0, 10))),
      data_pagamento: null,
      categoria_nome: 'DESPESAS DE VIAGEM',
      tipo_rateio: 'VARIAVEL_POR_VOO',
      periodicidade: 'EVENTUAL',
      percentual_sociedade: numberValue(allocation.percentual_sociedade) || allocation.percentual_uso,
      percentual_uso: allocation.percentual_uso,
      valor_total_centavos: amountCentavos,
      valor_rateado_centavos: allocation.valor_rateado_centavos,
      pago_por: null,
      pago_diretamente: 0,
      status: rateioStatus,
      descricao_despesa: description,
      observacoes: `Origem: relatório ${text(report.numero_relatorio) || text(report.id)}`,
    }))
    await addLinkStatements(db, statements, text(report.id), 'RATEIO_HOLD', rateioId, 'RELATORIO_RATEIO_HOLD')
  }
  return movimentoId
}

export async function sincronizarRelatorioViagemFinanceiro(
  db: D1Database,
  report: ReportRow,
  userId: string | null,
): Promise<{ idempotent: boolean; destinos: Array<{ tipo: string; id: string }> }> {
  const numeroVooId = text(report.numero_voo)
    ? (await db.prepare('SELECT id FROM solicitacoes_reserva_voo WHERE numero_voo = ?1 LIMIT 1').bind(text(report.numero_voo)).first<{ id: string }>())?.id || null
    : null
  const reportId = text(report.id)
  if (!reportId) throw new Error('relatorio_id_obrigatorio')
  const expenses = expensesFromReport(report)
  if (!expenses.length) throw new Error('relatorio_sem_despesas')
  const reportTotalCentavos = Math.round(expenses.reduce((sum, expense) => sum + numberValue(expense.valor), 0) * 100)
  const reportDescription = payerDescription(report, 'cliente')
  const clienteLancamentoId = await findLancamentoClientId(db, report.cliente_id)
  const grouped = new Map<Payer, Array<Record<string, any>>>()
  for (const expense of expenses) {
    const payer = normalizePayer(expense.pago_por ?? expense.paid_by)
    grouped.set(payer, [...(grouped.get(payer) || []), expense])
  }
  const { kind, rows } = await selectCotistas(db, report)
  const rateioAllocations = allocate(reportTotalCentavos, rows, kind === 'HOLDING')
  const pagamentoDiretoCentavos = Math.round((grouped.get('cliente') || [])
    .reduce((sum, expense) => sum + numberValue(expense.valor), 0) * 100)
  const existing = await db.prepare(`SELECT destino_tipo, destino_id
    FROM financeiro_vinculos
    WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1
    ORDER BY criado_em`).bind(reportId).all<{ destino_tipo: string; destino_id: string }>()
  if ((existing.results || []).length) {
    const existingDueDate = dateValue(report.data_vencimento_reembolso, dateValue(report.data_fim, dateValue(report.data_inicio, new Date().toISOString().slice(0, 10))))
    const statements: D1PreparedStatement[] = []
    if (kind === 'CLIENTE' && reportTotalCentavos > 0 && rateioAllocations.length) {
      const lancamentoCustoId = await ensureLancamentoCustoIntegral(
        db, statements, report, rateioAllocations, reportTotalCentavos, reportDescription,
        existingDueDate, numeroVooId, clienteLancamentoId, userId,
      )
      await addRateiosCliente(db, statements, report, rateioAllocations, reportTotalCentavos,
        reportDescription, lancamentoCustoId, pagamentoDiretoCentavos)
    }
    const consolidatedMovement = kind === 'HOLDING'
      ? await db.prepare(`SELECT fv.destino_id AS id FROM financeiro_vinculos fv
          INNER JOIN movimentos_holding mh ON mh.id = fv.destino_id
          WHERE fv.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND fv.origem_id = ?1
            AND fv.destino_tipo = 'MOVIMENTO_HOLDING' AND mh.descricao = ?2 LIMIT 1`)
        .bind(reportId, reportDescription).first<{ id: string }>()
      : null
    const consolidatedMovementId = text(consolidatedMovement?.id) || null
    if (consolidatedMovementId) {
      await db.prepare(`UPDATE movimentos_holding SET fornecedor_nome = ?, numero_doc = ?, url_doc = ?, data_vencimento = ?
        WHERE id = ?`).bind(
        FORNECEDOR_RELATORIO_VIAGEM, text(report.numero_relatorio), text(report.pdf_path) || null,
        existingDueDate, consolidatedMovementId,
      ).run()
    }
    const existingReceivableAmount = [...grouped.entries()]
      .filter(([payer]) => payer !== 'cliente')
      .reduce((total, [, payerExpenses]) => total + Math.round(payerExpenses.reduce((sum, expense) => sum + numberValue(expense.valor), 0) * 100), 0)
    if (existingReceivableAmount > 0 && rows[0]) {
      const contaCotista = rows.find((row) => row.socio_id === text(report.socio_id)) || rows[0]
      const receivable = await ensureRelatorioContaAReceber(db, {
        reportId,
        cotistaId: contaCotista.id,
        values: {
          id: uuid(),
          data_vencimento: existingDueDate,
          valor_centavos: existingReceivableAmount,
          categoria_nome: 'DESPESAS DE VIAGEM',
          descricao: `Relatório de despesa de viagem ${text(report.numero_relatorio) || reportId}`,
          aeronave_id: text(report.aeronave_id),
          lancamentos_id: null,
          status: 'EM_ABERTO',
          criado_por: userId,
        },
      })
      if (receivable.status === 'reconciliation_required') throw new Error(`conciliacao_conta_receber_necessaria:${receivable.ids.join(',')}`)
      if (receivable.status === 'cancelled') throw new Error(`conta_receber_cancelada:${receivable.ids.join(',')}`)
      statements.push(receivable.statement)
      statements.push(...repairRelatorioContaReceberLinkStatements(db, reportId, contaCotista.id))
    }
    for (const [payer, payerExpenses] of grouped.entries()) {
      const amountCentavos = Math.round(payerExpenses.reduce((sum, expense) => sum + numberValue(expense.valor), 0) * 100)
      if (amountCentavos <= 0) continue
      if (payer === 'tripulante_2' && !text(report.tripulante_id_2)) throw new Error('tripulante_2_obrigatorio_para_despesa')
      const description = payerDescription(report, payer)
      let lancamentoId: string | null = null
      let movimentoHoldingId: string | null = consolidatedMovementId
      if (kind === 'HOLDING') {
        if (!consolidatedMovementId) {
          const movimento = await db.prepare(`SELECT destino_id AS id FROM financeiro_vinculos fv
            INNER JOIN movimentos_holding mh ON mh.id = fv.destino_id
            WHERE fv.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND fv.origem_id = ?1
              AND fv.destino_tipo = 'MOVIMENTO_HOLDING' AND mh.descricao = ?2 LIMIT 1`).bind(reportId, description).first<{ id: string }>()
          movimentoHoldingId = text(movimento?.id) || null
          await db.prepare(`UPDATE movimentos_holding SET valor_centavos = ?, descricao = ?, fornecedor_nome = ?, numero_doc = ?, url_doc = ?, data_vencimento = ?
            WHERE id IN (SELECT destino_id FROM financeiro_vinculos WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ? AND destino_tipo = 'MOVIMENTO_HOLDING')
              AND descricao = ?`).bind(amountCentavos, description, FORNECEDOR_RELATORIO_VIAGEM, text(report.numero_relatorio), text(report.pdf_path) || null, existingDueDate, reportId, description).run()
        }
      } else {
        const lancamentoExistente = await db.prepare(`SELECT id FROM lancamentos
          WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1 AND idempotency_key = ?2
          LIMIT 1`).bind(reportId, `RELATORIO_DESPESA_VIAGEM:${reportId}:${payer}`).first<{ id: string }>()
        lancamentoId = text(lancamentoExistente?.id) || null
        const dataEmissao = await dataEmissaoRelatorio(db, report, lancamentoId)
        if (lancamentoId) {
          await db.prepare(`UPDATE lancamentos SET valor_centavos = ?, descricao = ?, fornecedor_nome = ?, numero_doc = ?, numero_voo = ?, periodicidade = 'EVENTUAL', url_doc = ?, cotista_aeronave_id = ?, cliente_id = ?, data_emissao = ?, data_vencimento = ?, escopo_financeiro = 'CAIXA_SHARE'
            WHERE id = ?`).bind(amountCentavos, description, FORNECEDOR_RELATORIO_VIAGEM, text(report.numero_relatorio), numeroVooId, text(report.pdf_path) || null, rows[0]?.id || null, clienteLancamentoId, dataEmissao, existingDueDate, lancamentoId).run()
        } else if (payer === 'tripulante_1' || payer === 'tripulante_2') {
          const tripulanteId = payer === 'tripulante_1' ? report.tripulacao_id : report.tripulante_id_2
          const tripulanteUserId = await findTripulanteUserId(db, tripulanteId)
          lancamentoId = uuid()
          statements.push(await prepareInsert(db, 'lancamentos', {
            id: lancamentoId,
            aeronave_id: text(report.aeronave_id),
            colaborador_id: tripulanteUserId,
            data_emissao: dataEmissao,
            data_vencimento: existingDueDate,
            data_pagamento: null,
            descricao: description,
            fornecedor_nome: FORNECEDOR_RELATORIO_VIAGEM,
            numero_doc: text(report.numero_relatorio),
            numero_voo: numeroVooId,
            url_doc: text(report.pdf_path) || null,
            cotista_aeronave_id: rows[0]?.id || null,
            cliente_id: text(report.cliente_id) || null,
            categoria_nome: 'DESPESAS REEMBOLSÁVEIS',
            grupo_categoria: 'DESPESAS REEMBOLSÁVEIS',
            status: 'EM_ABERTO',
            fluxo: 'SAIDA',
            tipo_caixa: 'SHARE',
            valor_centavos: amountCentavos,
            pago_por: null,
            pago_diretamente: 0,
            reembolsavel: 1,
            reembolso_quitado: 0,
            escopo_financeiro: 'CAIXA_SHARE',
            forma_pagamento: null,
            observacoes: `Origem: relatório ${text(report.numero_relatorio) || reportId}`,
            criado_por: userId,
            origem_tipo: 'RELATORIO_DESPESA_VIAGEM',
            origem_id: reportId,
            idempotency_key: `RELATORIO_DESPESA_VIAGEM:${reportId}:${payer}`,
          }))
          await addLinkStatements(db, statements, reportId, 'LANCAMENTO', lancamentoId, 'RELATORIO_LANCAMENTO')
        }
      }
      if ((kind === 'CLIENTE' || kind === 'HOLDING') && (payer === 'tripulante_1' || payer === 'tripulante_2')) {
        await addTripulantePayableStatements(
          db, statements, report, payer, amountCentavos, description,
          calcularVencimentoReembolsoTripulante(report), lancamentoId, movimentoHoldingId, userId,
        )
      }
    }
    if (statements.length) await db.batch(statements)
    const links = await db.prepare(`SELECT destino_tipo, destino_id FROM financeiro_vinculos
      WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1 ORDER BY criado_em`).bind(reportId).all<{ destino_tipo: string; destino_id: string }>()
    return { idempotent: true, destinos: (links.results || []).map((item) => ({ tipo: item.destino_tipo, id: item.destino_id })) }
  }

  const statements: D1PreparedStatement[] = []
  const destinos: Array<{ tipo: string; id: string }> = []
  const fallbackDate = dateValue(report.data_fim, dateValue(report.data_inicio, new Date().toISOString().slice(0, 10)))
  const dueDate = dateValue(report.data_vencimento_reembolso, fallbackDate)
  const valorAReceberCentavos = [...grouped.entries()]
    .filter(([payer]) => payer !== 'cliente')
    .reduce((total, [, payerExpenses]) => total + Math.round(payerExpenses.reduce((sum, expense) => sum + numberValue(expense.valor), 0) * 100), 0)
  let reportMovementHoldingId: string | null = null

  if (reportTotalCentavos > 0 && rateioAllocations.length) {
    if (kind === 'CLIENTE') {
      const lancamentoCustoId = await ensureLancamentoCustoIntegral(
        db, statements, report, rateioAllocations, reportTotalCentavos, reportDescription,
        dueDate, numeroVooId, clienteLancamentoId, userId,
      )
      destinos.push({ tipo: 'LANCAMENTO', id: lancamentoCustoId })
      await addRateiosCliente(db, statements, report, rateioAllocations, reportTotalCentavos,
        reportDescription, lancamentoCustoId, pagamentoDiretoCentavos)
    } else {
      reportMovementHoldingId = await addRateiosHolding(
        db, statements, report, rateioAllocations, reportTotalCentavos, reportDescription, userId,
      )
      destinos.push({ tipo: 'MOVIMENTO_HOLDING', id: reportMovementHoldingId })
    }
  }

  for (const [payer, payerExpenses] of grouped.entries()) {
    if (payer === 'tripulante_2' && !text(report.tripulante_id_2)) throw new Error('tripulante_2_obrigatorio_para_despesa')
    const amountCentavos = Math.round(payerExpenses.reduce((sum, expense) => sum + numberValue(expense.valor), 0) * 100)
    if (amountCentavos <= 0) continue
    const description = payerDescription(report, payer)
    const allocations = allocate(amountCentavos, rows, kind === 'HOLDING')
    if (!allocations.length && kind === 'HOLDING') continue

    let lancamentoId: string | null = null
    const movimentoHoldingId = reportMovementHoldingId
    const tripulanteUserId = payer === 'tripulante_1'
      ? await findTripulanteUserId(db, report.tripulacao_id)
      : payer === 'tripulante_2'
        ? await findTripulanteUserId(db, report.tripulante_id_2)
        : null

    // Despesas pagas pela Share já foram registradas no caixa quando pagas;
    // o relatório só gera nova saída no caixa Share para reembolsar tripulantes.
    if ((payer === 'tripulante_1' || payer === 'tripulante_2') && kind === 'CLIENTE') {
      lancamentoId = uuid()
      const dataEmissao = await dataEmissaoRelatorio(db, report, null)
      statements.push(await prepareInsert(db, 'lancamentos', {
        id: lancamentoId,
        aeronave_id: text(report.aeronave_id),
        colaborador_id: tripulanteUserId,
        data_emissao: dataEmissao,
        data_vencimento: dueDate,
        periodicidade: 'EVENTUAL',
        data_pagamento: null,
        descricao: description,
        fornecedor_nome: FORNECEDOR_RELATORIO_VIAGEM,
        numero_doc: text(report.numero_relatorio),
        numero_voo: numeroVooId,
        url_doc: text(report.pdf_path) || null,
        cotista_aeronave_id: allocations[0]?.id || null,
        cliente_id: kind === 'CLIENTE' ? clienteLancamentoId : null,
        categoria_nome: 'DESPESAS REEMBOLSÁVEIS',
        grupo_categoria: 'DESPESAS REEMBOLSÁVEIS',
        status: 'EM_ABERTO',
        fluxo: 'SAIDA',
        tipo_caixa: 'SHARE',
        valor_centavos: amountCentavos,
        pago_por: null,
        pago_diretamente: 0,
        reembolsavel: 1,
        reembolso_quitado: 0,
        escopo_financeiro: 'CAIXA_SHARE',
        forma_pagamento: null,
        observacoes: `Origem: relatório ${text(report.numero_relatorio) || reportId}`,
        criado_por: userId,
        origem_tipo: 'RELATORIO_DESPESA_VIAGEM',
        origem_id: reportId,
        idempotency_key: `RELATORIO_DESPESA_VIAGEM:${reportId}:${payer}`,
      }))
      await addLinkStatements(db, statements, reportId, 'LANCAMENTO', lancamentoId, 'RELATORIO_LANCAMENTO')
      destinos.push({ tipo: 'LANCAMENTO', id: lancamentoId })

    }

    if ((kind === 'CLIENTE' || kind === 'HOLDING') && (payer === 'tripulante_1' || payer === 'tripulante_2')) {
      const payableId = await addTripulantePayableStatements(
        db, statements, report, payer, amountCentavos, description,
        calcularVencimentoReembolsoTripulante(report), lancamentoId, movimentoHoldingId, userId,
      )
      if (payableId) destinos.push({ tipo: 'CONTA_PAGAR', id: payableId })
    }
  }

  if (valorAReceberCentavos > 0 && rows[0]) {
    const contaCotista = rows.find((row) => row.socio_id === text(report.socio_id)) || rows[0]
    const receivable = await ensureRelatorioContaAReceber(db, {
      reportId,
      cotistaId: contaCotista.id,
      values: {
        id: uuid(),
        data_vencimento: fallbackDate,
        valor_centavos: valorAReceberCentavos,
        categoria_nome: 'DESPESAS DE VIAGEM',
        descricao: `Relatório de despesa de viagem ${text(report.numero_relatorio) || reportId}`,
        aeronave_id: text(report.aeronave_id),
        // O lançamento do tripulante é o reembolso a pagar, não a cobrança do cliente.
        lancamentos_id: null,
        status: 'EM_ABERTO',
        criado_por: userId,
      },
    })
    if (receivable.status === 'reconciliation_required') throw new Error(`conciliacao_conta_receber_necessaria:${receivable.ids.join(',')}`)
    if (receivable.status === 'cancelled') throw new Error(`conta_receber_cancelada:${receivable.ids.join(',')}`)
    statements.push(receivable.statement)
    statements.push(...repairRelatorioContaReceberLinkStatements(db, reportId, contaCotista.id))
    destinos.push({ tipo: 'CONTA_RECEBER', id: receivable.id })
  }

  if (!statements.length) return { idempotent: false, destinos: [] }
  await db.batch(statements)
  const links = await db.prepare(`SELECT destino_tipo, destino_id
    FROM financeiro_vinculos
    WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1
    ORDER BY criado_em`).bind(reportId).all<{ destino_tipo: string; destino_id: string }>()
  return { idempotent: false, destinos: (links.results || []).map((item) => ({ tipo: item.destino_tipo, id: item.destino_id })) }
}
