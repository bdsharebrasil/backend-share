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
