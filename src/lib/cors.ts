import { cors } from 'hono/cors'

export function createInternalCorsMiddleware() {
  return cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'Authorization', 'apikey', 'X-Requested-With', 'X-Request-Id'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  })
}
