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

const uuid = () => crypto.randomUUID()

function text(value: unknown): string {
  return value == null ? '' : String(value).trim()
}

function nullableText(value: unknown): string | null {
  const valueText = text(value)
  return valueText || null
}

function dateValue(value: unknown, fallback: string): string {
  const candidate = text(value) || fallback
  return /^\d{4}-\d{2}-\d{2}/.test(candidate) ? candidate.slice(0, 10) : fallback
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
  const label = payer === 'tripulante_1'
    ? 'Tripulante 1'
    : payer === 'tripulante_2'
      ? 'Tripulante 2'
      : payer === 'cliente'
        ? 'Cliente'
        : 'ShareBrasil'
  return `Relatório de despesa de viagem ${text(report.numero_relatorio) || text(report.id)} · ${label}`
}

function categoryDescription(expenses: Array<Record<string, any>>): string | null {
  const categories = [...new Set(expenses.map((expense) => text(expense.categoria ?? expense.category)).filter(Boolean))]
  return categories.length ? categories.join(' / ').slice(0, 180) : null
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
  if (!rows.length) throw new Error(kind === 'HOLDING' ? 'cotistas_holding_nao_encontrados' : 'cotistas_cliente_nao_encontrados')
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

async function addRateiosCliente(
  db: D1Database,
  statements: D1PreparedStatement[],
  report: ReportRow,
  allocations: Allocation[],
  amountCentavos: number,
  lancamentoId: string | null,
  payer: Payer,
  description: string,
  userId: string | null,
) {
  const direct = false
  const status = 'EM_ABERTO'
  for (const allocation of allocations) {
    const rateioId = uuid()
    statements.push(await prepareInsert(db, 'rateio_despesas', {
      id: rateioId,
      lancamento_id: lancamentoId,
      aeronave_id: text(report.aeronave_id),
      cotista_id: allocation.id,
      data_emissao: dateValue(report.data_inicio, new Date().toISOString().slice(0, 10)),
      data_vencimento: dateValue(report.data_fim, dateValue(report.data_inicio, new Date().toISOString().slice(0, 10))),
      data_pagamento: null,
      categoria_nome: payer === 'cliente' ? 'DESPESAS PAGAS DIRETAMENTE PELO CLIENTE' : payer === 'sharebrasil' ? 'DESPESAS EMPRESA' : 'DESPESAS REEMBOLSÁVEIS',
      tipo_rateio: 'VARIAVEL_POR_VOO',
      periodicidade: 'EVENTUAL',
      percentual_sociedade: numberValue(allocation.percentual_sociedade) || allocation.percentual_uso,
      percentual_uso: allocation.percentual_uso,
      valor_total_centavos: amountCentavos,
      valor_rateado_centavos: allocation.valor_rateado_centavos,
      pago_por_cotista_id: null,
      pago_diretamente: 0,
      status,
      descricao_despesa: description,
      observacoes: `Origem: relatório ${text(report.numero_relatorio) || text(report.id)}`,
    }))
    await addLinkStatements(db, statements, text(report.id), 'RATEIO_DESPESAS', rateioId, 'RELATORIO_RATEIO_DESPESA')
  }
}

async function addRateiosHolding(
  db: D1Database,
  statements: D1PreparedStatement[],
  report: ReportRow,
  allocations: Allocation[],
  amountCentavos: number,
  payer: Payer,
  description: string,
  userId: string | null,
) {
  const direct = false
  const movimentoStatus = 'EM_ABERTO'
  const rateioStatus = 'EM_ABERTO'
  for (const allocation of allocations) {
    if (!allocation.socio_id) continue
    const movimentoId = uuid()
    const rateioId = uuid()
    statements.push(await prepareInsert(db, 'movimentos_holding', {
      id: movimentoId,
      holding_id: allocation.holding_id,
      socio_id: allocation.socio_id,
      aeronave_id: text(report.aeronave_id),
      tipo_caixa: 'HOLD',
      data_emissao: dateValue(report.data_inicio, new Date().toISOString().slice(0, 10)),
      data_vencimento: dateValue(report.data_fim, dateValue(report.data_inicio, new Date().toISOString().slice(0, 10))),
      data_pagamento: null,
      descricao: description,
      categoria_nome: direct && payer === 'cliente' ? 'DESPESAS PAGAS DIRETAMENTE PELO CLIENTE' : payer === 'sharebrasil' ? 'DESPESAS EMPRESA' : 'DESPESAS REEMBOLSÁVEIS',
      grupo_categoria: payer === 'sharebrasil' ? 'DESPESAS EMPRESA' : 'DESPESAS REEMBOLSÁVEIS',
      fluxo: 'SAIDA',
      valor_centavos: allocation.valor_rateado_centavos,
      status: movimentoStatus,
      pago_diretamente: direct ? 1 : 0,
      colaborador_id: payer === 'tripulante_1' || payer === 'tripulante_2' ? await findTripulanteUserId(db, payer === 'tripulante_1' ? report.tripulacao_id : report.tripulante_id_2) : null,
      criado_por: userId,
      observacoes: `Origem: relatório ${text(report.numero_relatorio) || text(report.id)}`,
    }))
    statements.push(await prepareInsert(db, 'rateio_hold', {
      id: rateioId,
      movimento_holding_id: movimentoId,
      aeronave_id: text(report.aeronave_id),
      socio_id: allocation.socio_id,
      data_emissao: dateValue(report.data_inicio, new Date().toISOString().slice(0, 10)),
      data_vencimento: dateValue(report.data_fim, dateValue(report.data_inicio, new Date().toISOString().slice(0, 10))),
      data_pagamento: direct ? dateValue(report.data_fim, dateValue(report.data_inicio, new Date().toISOString().slice(0, 10))) : null,
      categoria_nome: payer === 'sharebrasil' ? 'DESPESAS EMPRESA' : payer === 'cliente' ? 'DESPESAS PAGAS DIRETAMENTE PELO CLIENTE' : 'DESPESAS REEMBOLSÁVEIS',
      tipo_rateio: 'VARIAVEL_POR_VOO',
      periodicidade: 'EVENTUAL',
      percentual_sociedade: numberValue(allocation.percentual_sociedade) || allocation.percentual_uso,
      percentual_uso: allocation.percentual_uso,
      valor_total_centavos: amountCentavos,
      valor_rateado_centavos: allocation.valor_rateado_centavos,
      pago_por_socio_id: null,
      pago_diretamente: direct ? 1 : 0,
      status: rateioStatus,
      descricao_despesa: description,
      observacoes: `Origem: relatório ${text(report.numero_relatorio) || text(report.id)}`,
    }))
    await addLinkStatements(db, statements, text(report.id), 'MOVIMENTO_HOLDING', movimentoId, 'RELATORIO_MOVIMENTO_HOLDING')
    await addLinkStatements(db, statements, text(report.id), 'RATEIO_HOLD', rateioId, 'RELATORIO_RATEIO_HOLD')
  }
}

export async function sincronizarRelatorioViagemFinanceiro(
  db: D1Database,
  report: ReportRow,
  userId: string | null,
  payerOnly: Payer | null = null,
): Promise<{ idempotent: boolean; destinos: Array<{ tipo: string; id: string }> }> {
  const reportId = text(report.id)
  if (!reportId) throw new Error('relatorio_id_obrigatorio')
  const existing = payerOnly
    ? await db.prepare(`SELECT id AS destino_id, 'LANCAMENTO' AS destino_tipo
        FROM lancamentos WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM'
        AND origem_id = ?1 AND idempotency_key = ?2`).bind(reportId, `RELATORIO_DESPESA_VIAGEM:${reportId}:${payerOnly}`).all<{ destino_tipo: string; destino_id: string }>()
    : await db.prepare(`SELECT destino_tipo, destino_id
        FROM financeiro_vinculos
        WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1
        ORDER BY criado_em`).bind(reportId).all<{ destino_tipo: string; destino_id: string }>()
  if ((existing.results || []).length) return { idempotent: true, destinos: (existing.results || []).map((item) => ({ tipo: item.destino_tipo, id: item.destino_id })) }

  const expenses = expensesFromReport(report)
  if (!expenses.length) throw new Error('relatorio_sem_despesas')
  const { kind, rows } = await selectCotistas(db, report)
  const grouped = new Map<Payer, Array<Record<string, any>>>()
  for (const expense of expenses) {
    const payer = normalizePayer(expense.pago_por ?? expense.paid_by)
    const current = grouped.get(payer) || []
    current.push(expense)
    grouped.set(payer, current)
  }
  const statements: D1PreparedStatement[] = []
  const destinos: Array<{ tipo: string; id: string }> = []
  const fallbackDate = dateValue(report.data_fim, dateValue(report.data_inicio, new Date().toISOString().slice(0, 10)))
  const valorAReceberCentavos = [...grouped.entries()]
    .filter(([payer]) => payer !== 'cliente')
    .reduce((total, [, payerExpenses]) => total + Math.round(payerExpenses.reduce((sum, expense) => sum + numberValue(expense.valor), 0) * 100), 0)

  for (const [payer, payerExpenses] of grouped.entries()) {
    if (payerOnly && payer !== payerOnly) continue
    if (payer === 'tripulante_2' && !text(report.tripulante_id_2)) throw new Error('tripulante_2_obrigatorio_para_despesa')
    const amountCentavos = Math.round(payerExpenses.reduce((sum, expense) => sum + numberValue(expense.valor), 0) * 100)
    if (amountCentavos <= 0) continue
    const description = `${payerDescription(report, payer)}${categoryDescription(payerExpenses) ? ` · ${categoryDescription(payerExpenses)}` : ''}`.slice(0, 240)
    const allocations = allocate(amountCentavos, rows, kind === 'HOLDING')
    if (!allocations.length) continue

    let lancamentoId: string | null = null
    let contaPagarId: string | null = null
    const tripulanteUserId = payer === 'tripulante_1'
      ? await findTripulanteUserId(db, report.tripulacao_id)
      : payer === 'tripulante_2'
        ? await findTripulanteUserId(db, report.tripulante_id_2)
        : null

    if (payer !== 'cliente') {
      lancamentoId = uuid()
      const reembolsavel = payer === 'tripulante_1' || payer === 'tripulante_2'
      statements.push(await prepareInsert(db, 'lancamentos', {
        id: lancamentoId,
        aeronave_id: text(report.aeronave_id),
        colaborador_id: tripulanteUserId,
        data_emissao: dateValue(report.data_inicio, fallbackDate),
        data_vencimento: fallbackDate,
        data_pagamento: null,
        descricao: description,
        categoria_nome: reembolsavel ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA',
        grupo_categoria: reembolsavel ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA',
        status: 'EM_ABERTO',
        fluxo: 'SAIDA',
        tipo_caixa: 'SHARE',
        valor_centavos: amountCentavos,
        pago_por: tripulanteUserId,
        pago_diretamente: 0,
        reembolsavel: reembolsavel ? 1 : 0,
        reembolso_quitado: 0,
        forma_pagamento: null,
        observacoes: `Origem: relatório ${text(report.numero_relatorio) || reportId}`,
        criado_por: userId,
        origem_tipo: 'RELATORIO_DESPESA_VIAGEM',
        origem_id: reportId,
        idempotency_key: `RELATORIO_DESPESA_VIAGEM:${reportId}:${payer}`,
      }))
      await addLinkStatements(db, statements, reportId, 'LANCAMENTO', lancamentoId, 'RELATORIO_LANCAMENTO')
      destinos.push({ tipo: 'LANCAMENTO', id: lancamentoId })

      if (reembolsavel) {
        contaPagarId = uuid()
        statements.push(await prepareInsert(db, 'contas_apagar', {
          id: contaPagarId,
          data_vencimento: fallbackDate,
          valor_centavos: amountCentavos,
          categoria_nome: 'DESPESAS REEMBOLSÁVEIS',
          descricao: description,
          aeronave_id: text(report.aeronave_id),
          lancamentos_id: lancamentoId,
          colaborador_id: tripulanteUserId,
          tripulante_id: payer === 'tripulante_1' ? text(report.tripulacao_id) : text(report.tripulante_id_2),
          status: 'EM_ABERTO',
          criado_por: userId,
          origem_tipo: 'RELATORIO_DESPESA_VIAGEM',
          idempotency_key: `RELATORIO_DESPESA_VIAGEM:${reportId}:${payer}:CONTA_PAGAR`,
        }))
        await addLinkStatements(db, statements, reportId, 'CONTA_PAGAR', contaPagarId, 'RELATORIO_CONTA_PAGAR')
        destinos.push({ tipo: 'CONTA_PAGAR', id: contaPagarId })
      }
    }

    if (kind === 'CLIENTE' && !payerOnly) {
      await addRateiosCliente(db, statements, report, allocations, amountCentavos, lancamentoId, payer, description, userId)
    } else if (!payerOnly) {
      await addRateiosHolding(db, statements, report, allocations, amountCentavos, payer, description, userId)
    }
  }

  if (!payerOnly && valorAReceberCentavos > 0 && rows[0]) {
    const contaReceberId = uuid()
    const lancamentoOrigemId = destinos.find((destino) => destino.tipo === 'LANCAMENTO')?.id || null
    statements.push(await prepareInsert(db, 'contas_areceber', {
      id: contaReceberId,
      data_vencimento: fallbackDate,
      valor_centavos: valorAReceberCentavos,
      categoria_nome: 'DESPESAS DE VIAGEM',
      descricao: `Relatório de despesa de viagem ${text(report.numero_relatorio) || reportId}`,
      aeronave_id: text(report.aeronave_id),
      cotista_id: rows[0].id,
      lancamentos_id: lancamentoOrigemId,
      status: 'EM_ABERTO',
      criado_por: userId,
      origem_tipo: 'RELATORIO_DESPESA_VIAGEM',
      origem_id: reportId,
      idempotency_key: `RELATORIO_DESPESA_VIAGEM:${reportId}:CONTA_RECEBER`,
    }))
    await addLinkStatements(db, statements, reportId, 'CONTA_RECEBER', contaReceberId, 'RELATORIO_CONTA_RECEBER')
    destinos.push({ tipo: 'CONTA_RECEBER', id: contaReceberId })
  }

  if (!statements.length) throw new Error('relatorio_sem_movimentacao_financeira')
  await db.batch(statements)
  const links = await db.prepare(`SELECT destino_tipo, destino_id
    FROM financeiro_vinculos
    WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?1
    ORDER BY criado_em`).bind(reportId).all<{ destino_tipo: string; destino_id: string }>()
  return { idempotent: false, destinos: (links.results || []).map((item) => ({ tipo: item.destino_tipo, id: item.destino_id })) }
}
