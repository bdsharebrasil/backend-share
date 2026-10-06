import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const workerSource = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')

test('CRUD de aeródromos usa a autorização administrativa de colaboradores', () => {
  const helperStart = workerSource.indexOf('async function autorizarGestaoAerodromo')
  const helperEnd = workerSource.indexOf("app.post('/api/interno/aerodromos'", helperStart)
  assert.notEqual(helperStart, -1, 'helper de autorização de aeródromos deve existir')
  assert.notEqual(helperEnd, -1, 'rotas de aeródromos devem seguir o helper')

  const helperSource = workerSource.slice(helperStart, helperEnd)
  assert.match(helperSource, /isColaboradorManager\(c, user\)/)
  assert.doesNotMatch(helperSource, /isMeetingManager\(c, user\)/)
})
