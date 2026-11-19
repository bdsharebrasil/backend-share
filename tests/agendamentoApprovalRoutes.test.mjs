import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

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
  assert.match(painel, /CASE WHEN p\.horario_corte IS NULL/);
  assert.match(painel, /j\.numero_jornada DESC, p\.numero DESC/);
  assert.match(painel, /COALESCE\(perna_agendada\.horario_corte/);
});

test('painel escolhe a primeira perna aberta; após todos os cortes preserva a última', () => {
  const route = workerSource.slice(workerSource.indexOf("app.get('/api/interno/agendamento',"));
  const match = route.match(/LEFT JOIN pernas_jornada_voo perna_agendada ON perna_agendada\.id = \(\s*([\s\S]*?)\n      \)\s*WHERE/);
  assert.ok(match, 'subconsulta real da última perna deve ser extraível');
  const consulta = match[1].replace(/s\.id/g, '?');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE jornadas_voo (id TEXT, solicitacao_id TEXT, jornada_principal_id TEXT, numero_jornada INTEGER);
      CREATE TABLE pernas_jornada_voo (id TEXT, jornada_id TEXT, numero INTEGER, horario_corte TEXT, status TEXT);
      INSERT INTO jornadas_voo VALUES ('j1', 'voo1', NULL, 1), ('j2', 'outro', NULL, 1);
      INSERT INTO pernas_jornada_voo VALUES
        ('p1','j1',1,'2026-11-19T10:00:00Z','cortado'),
        ('p2','j1',2,NULL,'em_voo'),
        ('p3','j1',3,NULL,'programada'),
        ('p-outro','j2',1,NULL,'em_voo');
    `);
    const atual = () => db.prepare(consulta).get('voo1')?.id;
    assert.equal(atual(), 'p2', 'não salta para a perna futura');
    db.exec("UPDATE pernas_jornada_voo SET horario_corte='2026-11-19T11:00:00Z', status='cortado' WHERE id='p2'");
    assert.equal(atual(), 'p3', 'avança para a próxima perna ainda aberta');
    db.exec("UPDATE pernas_jornada_voo SET horario_corte='2026-11-19T12:00:00Z', status='cortado' WHERE id='p3'");
    assert.equal(atual(), 'p3', 'mantém última perna registrada após o corte final');
  } finally {
    db.close();
  }
});
