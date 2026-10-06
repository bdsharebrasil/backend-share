import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const workerSource = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')

test('rotas de decisão do agendamento mantêm os caminhos esperados pelo frontend e exigem autenticação', () => {
  const routes = [
    "/api/interno/solicitacoes/:id/aprovar",
    "/api/interno/solicitacoes/:id/reprovar",
  ]

  for (const path of routes) {
    const routeIndex = workerSource.indexOf(`app.post('${path}'`)
    assert.notEqual(routeIndex, -1, `${path} deve estar registrada no worker`)
    const nextRouteIndex = workerSource.indexOf("\napp.", routeIndex + 1)
    const routeSource = workerSource.slice(routeIndex, nextRouteIndex === -1 ? undefined : nextRouteIndex)
    assert.match(routeSource, /requireShareInternal\(c\)/, `${path} deve exigir autenticação`)
  }
})
