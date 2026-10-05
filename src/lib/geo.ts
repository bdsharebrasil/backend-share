export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusKm = 6371
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180
  const deltaLatitude = toRadians(lat2 - lat1)
  const deltaLongitude = toRadians(lon2 - lon1)
  const distance = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLongitude / 2) ** 2
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(distance), Math.sqrt(1 - distance))
}

export function numericValue(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.'))
  return Number.isFinite(value) && value > 0 ? value : null
}

export function parseCoord(raw: unknown): number | null {
  if (raw == null) return null
  if (typeof raw === 'number') return raw
  const value = String(raw).trim()
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number.parseFloat(value)
  const degreesMinutesSeconds = value.match(/^(\d{2,3})(\d{2})(\d{2})([NSEW])$/i)
  if (degreesMinutesSeconds) {
    const decimal = Number.parseInt(degreesMinutesSeconds[1])
      + Number.parseInt(degreesMinutesSeconds[2]) / 60
      + Number.parseInt(degreesMinutesSeconds[3]) / 3600
    return ['S', 'W'].includes(degreesMinutesSeconds[4].toUpperCase()) ? -decimal : decimal
  }
  const parsed = Number.parseFloat(value)
  return Number.isNaN(parsed) ? null : parsed
}
