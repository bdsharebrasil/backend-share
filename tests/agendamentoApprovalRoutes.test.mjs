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
  assert.match(painel, /COALESCE\(perna_vinculada\.horario_pouso, perna_agendada\.horario_pouso,[\s\S]*?AS perna_atual_horario_pouso/);
  assert.match(painel, /j\.id = COALESCE\(perna_vinculada\.jornada_id, perna_agendada\.jornada_id\)/);
  assert.match(painel, /j\.solicitacao_id = s\.id ORDER BY j\.numero_jornada DESC, j\.criado_em DESC/);
  assert.match(painel, /perna_agendada\.origem AS perna_atual_origem/);
  assert.match(painel, /perna_agendada\.destino AS perna_atual_destino/);
  assert.match(painel, /LEFT JOIN pernas_jornada_voo perna_agendada ON perna_agendada\.id =/);
  assert.match(painel, /CASE WHEN p\.horario_corte IS NULL/);
  assert.match(painel, /j\.numero_jornada DESC, p\.numero DESC/);
  assert.match(painel, /COALESCE\(perna_vinculada\.horario_corte, perna_agendada\.horario_corte/);
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

test('painel recupera pouso registrado na jornada quando falta na perna selecionada', () => {
  const inicio = workerSource.indexOf("app.get('/api/interno/agendamento',");
  const fim = workerSource.indexOf("\napp.", inicio + 1);
  const painel = workerSource.slice(inicio, fim > inicio ? fim : undefined);
  const inicioExpressao = painel.indexOf('COALESCE(perna_vinculada.horario_pouso, perna_agendada.horario_pouso');
  const fimExpressao = painel.indexOf(' AS perna_atual_horario_pouso', inicioExpressao);
  assert.ok(inicioExpressao >= 0 && fimExpressao > inicioExpressao, 'expressão de pouso deve existir');
  const expressao = painel.slice(inicioExpressao, fimExpressao);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE solicitacoes (id TEXT);
      CREATE TABLE jornadas_voo (id TEXT, solicitacao_id TEXT, jornada_principal_id TEXT, numero_jornada INTEGER, criado_em TEXT, horario_pouso TEXT);
      CREATE TABLE pernas_jornada_voo (id TEXT, jornada_id TEXT, horario_pouso TEXT);
      INSERT INTO solicitacoes VALUES ('voo1');
      INSERT INTO jornadas_voo VALUES
        ('j1','voo1',NULL,1,'2026-11-26T11:00:00Z','2026-11-26T12:40:00Z'),
        ('j2','voo1',NULL,2,'2026-11-26T13:00:00Z',NULL);
      INSERT INTO pernas_jornada_voo VALUES ('p1','j1',NULL);
    `);
    const query = db.prepare(`SELECT ${expressao} AS pouso
      FROM solicitacoes s
      LEFT JOIN pernas_jornada_voo perna_vinculada ON perna_vinculada.id = s.id
      LEFT JOIN pernas_jornada_voo perna_agendada ON perna_agendada.id = ?1
      WHERE s.id = ?2`);
    assert.equal(query.get('p1', 'voo1').pouso, '2026-11-26T12:40:00Z', 'usa o pouso da jornada pai da perna atual');
    db.exec("UPDATE pernas_jornada_voo SET horario_pouso='2026-11-26T12:45:00Z' WHERE id='p1'");
    assert.equal(query.get('p1', 'voo1').pouso, '2026-11-26T12:45:00Z', 'prioriza o pouso registrado diretamente na perna');
    assert.equal(query.get(null, 'voo1').pouso, null, 'não reutiliza pouso antigo quando a jornada mais recente ainda não pousou');
    db.exec("UPDATE jornadas_voo SET horario_pouso='2026-11-26T13:50:00Z' WHERE id='j2'");
    assert.equal(query.get(null, 'voo1').pouso, '2026-11-26T13:50:00Z', 'usa o horário da jornada mais recente sem perna selecionada');
  } finally {
    db.close();
  }
});
