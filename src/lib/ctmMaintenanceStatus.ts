const TERMINAL_SERVICE_ORDER_STATUSES = new Set([
  'concluido',
  'concluida',
  'cancelado',
  'cancelada', 'completed', 'closed', 'cancelled', 'canceled', 'encerrada', 'encerrado', 'finalizada', 'finalizado',
])

export function isActiveCTMServiceOrder(status: unknown): boolean {
  const normalizedStatus = String(status ?? '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  return normalizedStatus.length > 0 && !TERMINAL_SERVICE_ORDER_STATUSES.has(normalizedStatus)
}

export function getAircraftIdsInMaintenance(
  orders: Array<{ aeronave_id?: unknown; status?: unknown; data_saida?: unknown }>,
): Set<string> {
  const aircraftIds = new Set<string>()
  for (const order of orders) {
    const aircraftId = String(order.aeronave_id ?? '').trim()
    if (aircraftId && !order.data_saida && isActiveCTMServiceOrder(order.status)) aircraftIds.add(aircraftId)
  }
  return aircraftIds
}
