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

test('confirmação valida e grava os dados alterados do agendamento antes de aprovar', () => {
  const routeIndex = workerSource.indexOf("app.post('/api/interno/solicitacoes/:id/aprovar'")
  const nextRouteIndex = workerSource.indexOf("\napp.", routeIndex + 1)
  const routeSource = workerSource.slice(routeIndex, nextRouteIndex === -1 ? undefined : nextRouteIndex)
  for (const field of ['aeronave_id', 'data_agendada', 'horario_previsto_agendamento', 'dias_duracao', 'numero_passageiros', 'cliente_emprestimo_id', 'socio_emprestimo_id']) {
    assert.match(routeSource, new RegExp(field), `${field} deve fazer parte da confirmação`)
  }
  assert.match(routeSource, /calcularDiasPeriodoAgendamento\(dataAgendada, dataFim\)/)
  assert.match(routeSource, /validarElegibilidadeTripulante\(c, assigned, aeronaveId\)/)
  assert.match(routeSource, /cedente_nao_vinculado_a_aeronave/)
  assert.match(routeSource, /SET status = 'aprovada'.*aeronave_id = \?, cliente_emprestimo_id = \?, socio_emprestimo_id = \?, voo_emprestado = \?, data_agendada = \?, horario_previsto_agendamento = \?, dias_duracao = \?, numero_passageiros = \?/)
})
