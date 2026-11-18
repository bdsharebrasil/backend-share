import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { test } from 'node:test'
import { createInternalCorsMiddleware } from '../src/lib/cors.ts'

const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
const allowedOrigins = wrangler.match(/^ALLOWED_ORIGINS\s*=\s*"([^"]+)"/m)?.[1]

assert.ok(allowedOrigins, 'wrangler.toml deve definir ALLOWED_ORIGINS')

const app = new Hono()
app.use('*', async (c, next) => createInternalCorsMiddleware(allowedOrigins)(c, next))
app.get('/api/interno/agendamento', c => c.json({ ok: true }))

async function preflight(origin) {
  return app.fetch(new Request('https://api.share-brasil.com/api/interno/agendamento', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  }))
}

test('DeskBoard recebe CORS para as APIs internas autenticadas', async () => {
  const origin = 'https://deskboard.share-brasil.com'
  const response = await preflight(origin)

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin)
  assert.match(response.headers.get('Access-Control-Allow-Methods') ?? '', /GET/)
  assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /Authorization/i)
})

test('CORS interno continua rejeitando origens que não estão na allowlist', async () => {
  const response = await preflight('https://deskboard.share-brasil.com.evil.example')

  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
})
