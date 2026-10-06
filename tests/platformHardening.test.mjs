import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')
const kernel = await readFile(new URL('../src/financeiro/FinanceiroKernel.ts', import.meta.url), 'utf8')
const messages = await readFile(new URL('../src/routes/mensagensRoutes.ts', import.meta.url), 'utf8')
const logger = await readFile(new URL('../src/lib/logger.ts', import.meta.url), 'utf8')

 test('CORS não usa wildcard e há handler global para erros internos', () => {
  assert.doesNotMatch(worker, /origin:\s*['"]\*['"]/
  )
  assert.match(worker, /app\.onError\(/)
  assert.match(worker, /code: 'erro_interno'/)
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
