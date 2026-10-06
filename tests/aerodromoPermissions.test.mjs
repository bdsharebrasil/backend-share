import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const workerSource = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')
const authSource = await readFile(new URL('../src/lib/auth.ts', import.meta.url), 'utf8')

test('CRUD de aeródromos usa a autorização administrativa de colaboradores', () => {
  const helperStart = workerSource.indexOf('async function autorizarGestaoAerodromo')
  const helperEnd = workerSource.indexOf("app.post('/api/interno/aerodromos'", helperStart)
  assert.notEqual(helperStart, -1, 'helper de autorização de aeródromos deve existir')
  assert.notEqual(helperEnd, -1, 'rotas de aeródromos devem seguir o helper')

  const helperSource = workerSource.slice(helperStart, helperEnd)
  assert.match(helperSource, /isColaboradorManager\(c, user\)/)
  assert.doesNotMatch(helperSource, /isMeetingManager\(c, user\)/)
})

test('RH Master reconhecido pelo frontend também é autorizado pelo helper do backend', () => {
  const helperStart = authSource.indexOf('export async function isColaboradorManager')
  const helperEnd = authSource.indexOf('\n}', helperStart)
  assert.notEqual(helperStart, -1, 'helper de gestão de colaboradores deve existir')
  assert.notEqual(helperEnd, -1, 'helper deve estar completo')

  const helperSource = authSource.slice(helperStart, helperEnd)
  assert.equal((helperSource.match(/'rh_master'/g) || []).length, 2, 'RH Master deve ser aceito tanto em user_profiles quanto em usuarios_funcoes')
})
