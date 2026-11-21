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
app.post('/api/trip/auth/login', c => c.json({ access_token: 'access' }))
app.post('/api/trip/auth/error', () => { throw new Error('falha de teste') })

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

test('Trip app recebe CORS no preflight e na resposta POST', async () => {
  const origin = 'https://psychic-space-halibut-97wrvv7775xvh79j9-8082.app.github.dev'
  const preflight = await app.fetch(new Request('https://api.share-brasil.com/api/trip/auth/login', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization',
    },
  }))

  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin)
  assert.match(preflight.headers.get('Access-Control-Allow-Methods') ?? '', /POST/)
  assert.match(preflight.headers.get('Access-Control-Allow-Methods') ?? '', /OPTIONS/)
  assert.match(preflight.headers.get('Access-Control-Allow-Headers') ?? '', /Content-Type/i)
  assert.match(preflight.headers.get('Access-Control-Allow-Headers') ?? '', /Authorization/i)

  const response = await app.fetch(new Request('https://api.share-brasil.com/api/trip/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
  }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin)
})

test('CORS também é aplicado a respostas de erro', async () => {
  const origin = 'https://tripulacao.share-brasil.com'
  const response = await app.fetch(new Request('https://api.share-brasil.com/api/trip/auth/error', {
    method: 'POST', headers: { Origin: origin },
  }))

  assert.equal(response.status, 500)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin)
})

test('allowlist não aceita origem com caminho ou barra final', async () => {
  const response = await preflight('https://psychic-space-halibut-97wrvv7775xvh79j9-8082.app.github.dev/path')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
})
