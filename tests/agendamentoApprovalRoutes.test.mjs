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

test('painel de agendamento apresenta última perna e corte mesmo sem encerrar a jornada', () => {
  const inicio = workerSource.indexOf("app.get('/api/interno/agendamento',");
  const fim = workerSource.indexOf("\napp.", inicio + 1);
  assert.ok(inicio >= 0, 'rota do painel existe');
  const painel = workerSource.slice(inicio, fim > inicio ? fim : undefined);
  assert.match(painel, /perna_agendada\.horario_corte AS perna_atual_horario_corte/);
  assert.match(painel, /perna_agendada\.horario_pouso AS perna_atual_horario_pouso/);
  assert.match(painel, /perna_agendada\.origem AS perna_atual_origem/);
  assert.match(painel, /perna_agendada\.destino AS perna_atual_destino/);
  assert.match(painel, /LEFT JOIN pernas_jornada_voo perna_agendada ON perna_agendada\.id =/);
  assert.match(painel, /ORDER BY j\.numero_jornada DESC, p\.numero DESC/);
  assert.match(painel, /COALESCE\(perna_agendada\.horario_corte/);
});
