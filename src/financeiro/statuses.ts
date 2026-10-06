export const STATUS_LANCAMENTO = ['EM_ABERTO', 'PAGO', 'RECEBIDO', 'CANCELADO'] as const

export type StatusLancamentoPersistido = (typeof STATUS_LANCAMENTO)[number]
export type StatusLancamento = StatusLancamentoPersistido | 'EM_ATRASO'

function dataHojeEmSaoPaulo(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function statusLancamentoFinanceiro(
  status: unknown,
  dataVencimento: unknown,
  now: Date = new Date(),
): string {
  const statusNormalizado = String(status ?? '').toUpperCase()
  const vencimento = String(dataVencimento ?? '').slice(0, 10)
  if (statusNormalizado === 'EM_ABERTO' && /^\d{4}-\d{2}-\d{2}$/.test(vencimento) && vencimento < dataHojeEmSaoPaulo(now)) {
    return 'EM_ATRASO' as StatusLancamento
  }
  if (STATUS_LANCAMENTO.includes(statusNormalizado as StatusLancamentoPersistido)) {
    return statusNormalizado as StatusLancamentoPersistido
  }
  return 'EM_ABERTO'
}
