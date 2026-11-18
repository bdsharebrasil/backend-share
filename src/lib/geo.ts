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
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return Number.isFinite(raw) && Math.abs(raw) <= 180 ? raw : null
  const value = String(raw).trim().toUpperCase().replace(/,/g, '.').replace(/[º]/g, '°').replace(/[′’]/g, "'").replace(/[″”]/g, '"')
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
    const numero = Number(value)
    return Math.abs(numero) <= 180 ? numero : null
  }
  const hemisferio = value.match(/[NSEW]/g)
  if (!hemisferio || hemisferio.length !== 1) return null
  const hemi = hemisferio[0]
  const parte = value.replace(hemi, '').trim()
  let numeros: number[]
  const compacto = /^(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)$/.exec(parte)
  if (compacto) numeros = compacto.slice(1).map(Number)
  else {
    if (!/^\d[\d.°'"\s:]*$/.test(parte)) return null
    numeros = (parte.match(/\d+(?:\.\d+)?/g) || []).map(Number)
  }
  if (!numeros.length || numeros.length > 3 || numeros.some(n => !Number.isFinite(n))) return null
  const [graus, minutos = 0, segundos = 0] = numeros
  if (minutos >= 60 || segundos >= 60) return null
  const decimal = graus + minutos / 60 + segundos / 3600
  if (decimal > (/[NS]/.test(hemi) ? 90 : 180)) return null
  return /[SW]/.test(hemi) ? -decimal : decimal
}
