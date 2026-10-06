type HoldingMember = {
  holdingId: string
  holdingName: string
  bankAccount: string | null
  socioId: string
  socioName: string
  percentage: number
}

type HoldingMovement = {
  id: string
  holding_id: string | null
  socio_id: string | null
  fluxo: string | null
  status: string | null
  valor_centavos: number | string | null
  pago_diretamente?: number | boolean | null
}

type HoldingAllocation = {
  movimento_id: string | null
  socio_id: string
  status: string | null
  pago_diretamente: number | boolean | null
  valor_rateado_centavos: number | string | null
  valor_pago_real_centavos: number | string | null
}

const CASH_POSTED_STATUSES = new Set([
  'PAGO',
  'RECEBIDO',
  'REEMBOLSADO',
  'ENTRADA',
  'APORTE_MENSAL',
  'RENDIMENTO_BANCARIO',
])

function amountInCents(value: number | string | null | undefined): number {
  const amount = Number(value ?? 0)
  return Number.isFinite(amount) ? Math.round(amount) : 0
}

function isTrue(value: number | boolean | null | undefined): boolean {
  return value === true || Number(value ?? 0) === 1
}

function cashDirection(flow: string | null | undefined): -1 | 0 | 1 {
  switch (String(flow ?? '').trim().toUpperCase()) {
    case 'ENTRADA':
    case 'APORTE':
    case 'ESTORNO':
      return 1
    case 'SAIDA':
    case 'REEMBOLSO':
      return -1
    default:
      return 0
  }
}

/**
 * Produz a posição de caixa da holding para a aeronave selecionada.
 * Movimentos bancários definem o saldo real da conta; rateios definem quanto
 * cada sócio consumiu. Despesas pagas diretamente ficam fora do caixa conjunto.
 */
export function resumirHoldings(
  members: HoldingMember[],
  movements: HoldingMovement[],
  allocations: HoldingAllocation[],
) {
  const holdings = new Map<string, {
    id: string
    nome: string
    contaBancaria: string | null
    saldoContaCentavos: number
    socios: Map<string, {
      cotistaId: string
      nome: string
      percentual: number
      totalDepositadoCentavos: number
      totalConsumidoCentavos: number
      despesasPagasDiretamenteCentavos: number
      saldoCentavos: number
    }>
  }>()

  for (const member of members) {
    let holding = holdings.get(member.holdingId)
    if (!holding) {
      holding = {
        id: member.holdingId,
        nome: member.holdingName,
        contaBancaria: member.bankAccount,
        saldoContaCentavos: 0,
        socios: new Map(),
      }
      holdings.set(member.holdingId, holding)
    }
    if (!holding.contaBancaria && member.bankAccount) holding.contaBancaria = member.bankAccount
    if (!holding.socios.has(member.socioId)) {
      holding.socios.set(member.socioId, {
        cotistaId: member.socioId,
        nome: member.socioName,
        percentual: Number(member.percentage) || 0,
        totalDepositadoCentavos: 0,
        totalConsumidoCentavos: 0,
        despesasPagasDiretamenteCentavos: 0,
        saldoCentavos: 0,
      })
    }
  }

  const movementById = new Map(movements.map((movement) => [movement.id, movement]))
  const allocationsByMovement = new Map<string, HoldingAllocation[]>()
  for (const allocation of allocations) {
    if (!allocation.movimento_id) continue
    const linked = allocationsByMovement.get(allocation.movimento_id) ?? []
    linked.push(allocation)
    allocationsByMovement.set(allocation.movimento_id, linked)
  }

  for (const movement of movements) {
    const holding = movement.holding_id ? holdings.get(movement.holding_id) : undefined
    if (!holding || String(movement.status ?? '').toUpperCase() === 'CANCELADO') continue

    const direction = cashDirection(movement.fluxo)
    const status = String(movement.status ?? '').toUpperCase()
    const posted = CASH_POSTED_STATUSES.has(status)
    const directlyPaid = isTrue(movement.pago_diretamente)
    const amount = amountInCents(movement.valor_centavos)
    if (posted && !directlyPaid) holding.saldoContaCentavos += direction * amount

    const participant = movement.socio_id ? holding.socios.get(movement.socio_id) : undefined
    if (!participant || !posted || directlyPaid) continue
    if (direction > 0) participant.totalDepositadoCentavos += amount

    if (direction < 0 && (allocationsByMovement.get(movement.id) ?? []).length === 0) {
      participant.totalConsumidoCentavos += amount
    }
  }

  for (const allocation of allocations) {
    if (String(allocation.status ?? '').toUpperCase() === 'CANCELADO') continue
    const member = members.find((item) => item.socioId === allocation.socio_id)
    if (!member) continue
    const participant = holdings.get(member.holdingId)?.socios.get(allocation.socio_id)
    if (!participant) continue

    const directlyPaid = isTrue(allocation.pago_diretamente)
    if (directlyPaid) {
      participant.despesasPagasDiretamenteCentavos += amountInCents(
        allocation.valor_pago_real_centavos || allocation.valor_rateado_centavos,
      )
      continue
    }

    const movement = allocation.movimento_id ? movementById.get(allocation.movimento_id) : undefined
    if (!movement || String(movement.status ?? '').toUpperCase() !== 'PAGO') continue
    participant.totalConsumidoCentavos += amountInCents(
      allocation.valor_pago_real_centavos || allocation.valor_rateado_centavos,
    )
  }

  return [...holdings.values()]
    .map((holding) => ({
      ...holding,
      socios: [...holding.socios.values()]
        .map((socio) => ({
          ...socio,
          saldoCentavos: socio.totalDepositadoCentavos - socio.totalConsumidoCentavos,
        }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
}

export function calcularCompensacaoBalanco(rows: Record<string, unknown>[], participantesPermitidos?: Set<string>) {
  const devido = new Map<string, number>()
  const pago = new Map<string, number>()
  const nomes = new Map<string, string>()
  for (const row of rows) {
    if (String(row.fluxo ?? 'SAIDA').toUpperCase() === 'ENTRADA') continue
    const participante = String(row.participante_id ?? '').trim()
    if (participantesPermitidos && (!participante || !participantesPermitidos.has(participante))) continue
    const nome = String(row.participante_nome ?? '').trim()
    if (participante && nome) nomes.set(participante, nome)
    const valorDevido = Math.max(0, Number(row.valor_rateado_centavos ?? row.valor_centavos ?? 0))
    if (participante) devido.set(participante, (devido.get(participante) || 0) + valorDevido)
    const pagador = String(row.pago_por ?? '').trim() || (Number(row.pago_diretamente || 0) ? participante : '')
    const valorPago = Math.max(0, Number(row.valor_pago_centavos ?? 0))
    if (pagador && valorPago) pago.set(pagador, (pago.get(pagador) || 0) + valorPago)
  }
  const ids = [...new Set([...devido.keys(), ...pago.keys()])]
  const saldos = ids.map((cotista) => {
    const totalPagoCentavos = pago.get(cotista) || 0
    const totalDevidoCentavos = devido.get(cotista) || 0
    return { cotista: nomes.get(cotista) || cotista, cotistaId: cotista, totalPagoCentavos, totalDevidoCentavos, saldoCentavos: totalPagoCentavos - totalDevidoCentavos }
  }).sort((a, b) => Math.abs(b.saldoCentavos) - Math.abs(a.saldoCentavos))
  const matriz: Record<string, Record<string, number>> = {}
  for (const credor of ids) matriz[credor] = Object.fromEntries(ids.map((devedor) => [devedor, 0]))
  const credores = saldos.filter((item) => item.saldoCentavos > 0).map((item) => ({ id: item.cotista, valor: item.saldoCentavos }))
  const devedores = saldos.filter((item) => item.saldoCentavos < 0).map((item) => ({ id: item.cotista, valor: -item.saldoCentavos }))
  let credorIndex = 0
  let devedorIndex = 0
  while (credorIndex < credores.length && devedorIndex < devedores.length) {
    const valor = Math.min(credores[credorIndex].valor, devedores[devedorIndex].valor)
    matriz[credores[credorIndex].id][devedores[devedorIndex].id] = valor
    credores[credorIndex].valor -= valor
    devedores[devedorIndex].valor -= valor
    if (credores[credorIndex].valor === 0) credorIndex += 1
    if (devedores[devedorIndex].valor === 0) devedorIndex += 1
  }
  return { saldos, matrizCompensacao: matriz }
}

/**
 * Apresenta um único lançamento-pai no extrato, mantendo cada rateio como detalhe.
 * A lista original continua disponível para os cálculos de compensação por cotista.
 */
export function consolidarRateiosLancamentos(rows: Record<string, unknown>[]) {
  const resultado: Record<string, unknown>[] = []
  const agrupados = new Map<string, Record<string, unknown>>()

  for (const row of rows) {
    if (row.origem_rateio !== 'rateio_despesas' || !row.lancamento_id) {
      resultado.push(row)
      continue
    }

    const lancamentoId = String(row.lancamento_id)
    let grupo = agrupados.get(lancamentoId)
    if (!grupo) {
      grupo = {
        ...row,
        id: lancamentoId,
        rateio_linhas: [],
        valor_centavos: 0,
        valor_rateado_centavos: 0,
        valor_pago_real_centavos: 0,
        participante_id: null,
        participante_nome: 'Rateio entre cotistas',
        percentual_sociedade: null,
        percentual_uso: null,
        pago_diretamente: 0,
        pago_por: null,
      }
      agrupados.set(lancamentoId, grupo)
      resultado.push(grupo)
    }

    const valorRateado = Number(row.valor_rateado_centavos ?? row.valor_centavos ?? 0)
    const valorPago = Number(row.valor_pago_real_centavos ?? 0)
    const rateioLinhas = grupo.rateio_linhas as Record<string, unknown>[]
    rateioLinhas.push({
      id: row.id,
      cotista_id: row.participante_id,
      cotista_nome: row.participante_nome,
      percentual_sociedade: row.percentual_sociedade,
      percentual_uso: row.percentual_uso,
      valor_rateado_centavos: valorRateado,
      valor_pago_real_centavos: valorPago,
      data_vencimento: row.data_vencimento,
      data_pagamento: row.data_pagamento,
      subcategoria_1: row.subcategoria_1,
      subcategoria_2: row.subcategoria_2,
      subcategoria_3: row.subcategoria_3,
      subcategoria_4: row.subcategoria_4,
      tipo_rateio: row.tipo_rateio ?? row.grupo_categoria,
      periodicidade: row.periodicidade,
      pago_por: row.pago_por,
      pago_diretamente: row.pago_diretamente,
      status: row.status,
      documentos_vinculados: row.documentos_vinculados ?? [],
    })
    grupo.valor_centavos = Number(grupo.valor_centavos ?? 0) + valorRateado
    grupo.valor_rateado_centavos = Number(grupo.valor_rateado_centavos ?? 0) + valorRateado
    grupo.valor_pago_real_centavos = Number(grupo.valor_pago_real_centavos ?? 0) + valorPago

    const rateiosAtuais = grupo.rateio_linhas as Record<string, unknown>[]
    const statusRateios = rateiosAtuais.map((rateio) => String(rateio.status ?? '').toUpperCase())
    const todosPagos = rateiosAtuais.every((rateio) =>
      ['PAGO', 'RECEBIDO', 'CONFIRMADO', 'LIQUIDADO'].includes(String(rateio.status ?? '').toUpperCase()),
    )
    grupo.status = statusRateios.includes('EM_ATRASO')
      ? 'EM_ATRASO'
      : todosPagos ? 'PAGO' : statusRateios.find((status) => !['PAGO', 'RECEBIDO', 'CONFIRMADO', 'LIQUIDADO'].includes(status)) || 'EM_ABERTO'

    grupo.pago_por = null
    grupo.pago_diretamente = rateiosAtuais.length > 0 && rateiosAtuais.every((rateio) =>
      rateio.pago_diretamente === true || Number(rateio.pago_diretamente ?? 0) === 1,
    ) ? 1 : 0
  }

  return resultado
}


/**
 * Predicado único para impedir que um lançamento-pai e seus rateios sejam
 * contabilizados juntos. O schema é consultado antes para manter compatibilidade
 * com instalações antigas que ainda não possuem as colunas de origem/reembolso.
 */
export function buildLancamentoSemRateioPredicate(schema: Map<string, Set<string>>) {
  const lancamentoColumns = schema.get('lancamentos')
  const rateioColumns = schema.get('rateio_despesas')
  const reembolsoColumns = schema.get('reembolsos')
  const relacionamentosRateio = ['rd.lancamento_id = l.id']

  if (reembolsoColumns?.has('lancamento_cliente_id') && reembolsoColumns.has('lancamento_origem_id')) {
    relacionamentosRateio.push(
      'rd.lancamento_id IN (SELECT rb.lancamento_origem_id FROM reembolsos rb WHERE rb.lancamento_cliente_id = l.id)',
      'rd.lancamento_id IN (SELECT rb.lancamento_cliente_id FROM reembolsos rb WHERE rb.lancamento_origem_id = l.id)',
    )
  }

  if (lancamentoColumns?.has('origem_tipo') && lancamentoColumns.has('origem_id')
    && rateioColumns?.has('origem_tipo') && rateioColumns.has('origem_id')) {
    relacionamentosRateio.push('(l.origem_tipo IS NOT NULL AND l.origem_id IS NOT NULL AND rd.origem_tipo = l.origem_tipo AND rd.origem_id = l.origem_id)')
  }

  const excluirEntradaReembolso = lancamentoColumns?.has('origem_tipo') && lancamentoColumns.has('fluxo')
    ? ` AND NOT (UPPER(COALESCE(l.origem_tipo, '')) = 'REEMBOLSO' AND UPPER(COALESCE(l.fluxo, '')) = 'ENTRADA')`
    : ''

  return `NOT EXISTS (
        SELECT 1 FROM rateio_despesas rd
         WHERE UPPER(COALESCE(rd.status, '')) <> 'CANCELADO'
           AND (${relacionamentosRateio.join('\n             OR ')})
      )${excluirEntradaReembolso}`
}
