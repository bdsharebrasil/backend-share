export const MAX_ATTACHMENT_TOTAL_SIZE = 25 * 1024 * 1024

export function uuid(): string {
  return crypto.randomUUID()
}

export function text(value: unknown): string {
  return value == null ? '' : String(value).trim()
}

export function nullableText(value: unknown): string | null {
  const valueText = text(value)
  return valueText || null
}

export function isIsoDate(value: unknown): boolean {
  const candidate = text(value).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false
  const parsed = new Date(`${candidate}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
}

export function dateValue(value: unknown, fallback = new Date().toISOString().slice(0, 10)): string {
  const candidate = text(value) || fallback
  return isIsoDate(candidate) ? candidate.slice(0, 10) : fallback
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)))
  }
  return btoa(binary)
}
