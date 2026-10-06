import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const workerSource = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')

test('criação de aeródromo exige sessão autenticada, sem exigir papel administrativo', () => {
  const postStart = workerSource.indexOf("app.post('/api/interno/aerodromos'")
  const postEnd = workerSource.indexOf('const atualizarAerodromo', postStart)
  assert.notEqual(postStart, -1, 'rota de criação deve existir')
  assert.notEqual(postEnd, -1, 'rotas administrativas devem seguir o POST')

  const postSource = workerSource.slice(postStart, postEnd)
  assert.match(postSource, /requireAuthenticatedUser\(c\)/)
  assert.doesNotMatch(postSource, /autorizarGestaoAerodromo\(c\)/)
})

test('edição e exclusão continuam protegidas pela autorização administrativa', () => {
  const helperStart = workerSource.indexOf('async function autorizarGestaoAerodromo')
  const helperEnd = workerSource.indexOf("app.post('/api/interno/aerodromos'", helperStart)
  assert.notEqual(helperStart, -1, 'helper de autorização de aeródromos deve existir')
  assert.notEqual(helperEnd, -1, 'criação deve seguir o helper')

  const helperSource = workerSource.slice(helperStart, helperEnd)
  assert.match(helperSource, /isColaboradorManager\(c, user\)/)
  assert.doesNotMatch(helperSource, /isMeetingManager\(c, user\)/)

  const updateStart = workerSource.indexOf('const atualizarAerodromo', helperEnd)
  const updateEnd = workerSource.indexOf('function funcoesColaborador', updateStart)
  const updateSource = workerSource.slice(updateStart, updateEnd)
  assert.match(updateSource, /autorizarGestaoAerodromo\(c\)/)
})
