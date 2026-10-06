export function getPontoServerTimestamp(now = new Date()): { data: string; hora: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    data: `${values.year}-${values.month}-${values.day}`,
    hora: `${values.hour}:${values.minute}`,
  }
}
