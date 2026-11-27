import { cors } from 'hono/cors'

function isOrigin(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === value
  } catch {
    return false
  }
}

function matchesAllowedOrigin(rule: string, origin: string): boolean {
  const wildcard = rule.match(/^(https?:\/\/)\*\.([a-z0-9.-]+)$/i)
  if (!wildcard) return isOrigin(rule) && rule === origin
  if (!isOrigin(origin)) return false
  try {
    const candidate = new URL(origin)
    const baseHost = wildcard[2]!.toLowerCase()
    const probe = new URL(`${wildcard[1]}cors-probe.${baseHost}`)
    const hostname = candidate.hostname.toLowerCase()
    return candidate.protocol === probe.protocol
      && candidate.port === probe.port
      && hostname.endsWith(`.${baseHost}`)
      && hostname !== baseHost
  } catch {
    return false
  }
}

export function corsOriginFor(allowedOrigins: string | undefined, origin: string): string {
  const origins = allowedOrigins?.split(',').map(value => value.trim()).filter(Boolean) ?? []
  return origins.some(value => matchesAllowedOrigin(value, origin)) ? origin : ''
}

export function createInternalCorsMiddleware(allowedOrigins: string | undefined) {
  return cors({
    origin: origin => corsOriginFor(allowedOrigins, origin),
    allowHeaders: ['Content-Type', 'Authorization', 'apikey', 'X-Requested-With', 'X-Request-Id'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  })
}
