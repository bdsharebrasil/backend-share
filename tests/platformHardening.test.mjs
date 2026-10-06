import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')
const kernel = await readFile(new URL('../src/financeiro/FinanceiroKernel.ts', import.meta.url), 'utf8')
const messages = await readFile(new URL('../src/routes/mensagensRoutes.ts', import.meta.url), 'utf8')
const logger = await readFile(new URL('../src/lib/logger.ts', import.meta.url), 'utf8')
const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8')

test('CORS usa allowlist restrita e há handler global para erros internos', () => {
  assert.equal(worker.includes("origin: '*'"), false)
  assert.equal(worker.includes('origin: "*"'), false)
  assert.match(worker, /app\.onError\(/)
  assert.match(worker, /code: 'erro_interno'/)
})

test('origem de gestão está configurada no Worker publicado e protegida por allowlist', () => {
  const match = wrangler.match(/^ALLOWED_ORIGINS\s*=\s*"([^"]+)"\s*$/m)
  assert.ok(match, 'ALLOWED_ORIGINS precisa estar versionado em wrangler.toml')

  const origins = match[1].split(',').map(origin => origin.trim()).filter(Boolean)
  assert.ok(origins.includes('https://gestao.share-brasil.com'))
  assert.ok(!origins.includes('*'), 'CORS não pode liberar qualquer origem')
  assert.match(worker, /origin:\s*origin\s*=>\s*originFor\(c\.env,\s*origin\)/)
  assert.match(worker, /allowHeaders:\s*\[[^\]]*'Authorization'[^\]]*'apikey'/)
  assert.match(worker, /allowMethods:\s*\[[^\]]*'GET'[^\]]*'PATCH'[^\]]*'OPTIONS'/)
})

test('schema financeiro não aceita colunas ausentes nem mantém fallback opcional', () => {
  assert.doesNotMatch(kernel, /OPTIONAL_SCHEMA_COLUMNS/)
  assert.match(kernel, /Object\.keys\(values\)\.filter\(\(column\) => !available\.has\(column\)\)/)
})

test('mensageria não consulta pragma_table_info em cada requisição', () => {
  assert.doesNotMatch(messages, /garantirTabelasAuxiliares|pragma_table_info/)
})

test('requisições têm correlação segura e logs estruturados', () => {
  assert.match(worker, /X-Request-Id/)
  assert.match(worker, /crypto\.randomUUID\(\)/)
  assert.match(logger, /request_id/)
  assert.match(logger, /console\.debug\(line\)/)
})
