import { cors } from 'hono/cors'

function isOrigin(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === value
  } catch {
    return false
  }
}

export function corsOriginFor(allowedOrigins: string | undefined, origin: string): string {
  const origins = allowedOrigins?.split(',').map(value => value.trim()).filter(Boolean) ?? []
  return origins.some(value => isOrigin(value) && value === origin) ? origin : ''
}

export function createInternalCorsMiddleware(allowedOrigins: string | undefined) {
  return cors({
    origin: origin => corsOriginFor(allowedOrigins, origin),
    allowHeaders: ['Content-Type', 'Authorization', 'apikey', 'X-Requested-With', 'X-Request-Id'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  })
}
