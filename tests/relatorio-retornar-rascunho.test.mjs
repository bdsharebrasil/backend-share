import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { Hono } from 'hono';
import {
  retornarRelatorioRascunho,
  CONCORRENCIA_RELATORIO_SQL,
  valoresConcorrenciaRelatorio,
} from '../src/financeiro/relatorioRascunho.ts';

// Executa os handlers reais isolando apenas autenticação, schema e integrações externas.
const source = await readFile(
  new URL('../src/worker.ts', import.meta.url),
  'utf8',
);
const ast = ts.createSourceFile(
  'worker.ts',
  source,
  ts.ScriptTarget.ES2022,
  true,
);
function codigoRota(metodo, caminho) {
  for (const s of ast.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression))
      continue;
    const c = s.expression;
    if (
      ts.isPropertyAccessExpression(c.expression) &&
      c.expression.expression.getText(ast) === 'app' &&
      c.expression.name.text === metodo &&
      c.arguments[0] &&
      ts.isStringLiteral(c.arguments[0]) &&
      c.arguments[0].text === caminho
    )
      return c.arguments[1].getText(ast);
  }
  throw Error('Rota ausente: ' + caminho);
}
function carregar(codigo, deps) {
  const js = ts.transpileModule('(' + codigo + ')', {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  return Function(...Object.keys(deps), 'return ' + js)(...Object.values(deps));
}
function funcao(nome, deps) {
  const f = ast.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name?.text === nome,
  );
  assert.ok(f, nome);
  return carregar(f.getText(ast), deps);
}
function ambiente(campos = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE aeronave(id TEXT PRIMARY KEY,matricula_registro TEXT);INSERT INTO aeronave VALUES('aviao','PR-LRM');
 CREATE TABLE tripulacao(id TEXT PRIMARY KEY,user_id TEXT);INSERT INTO tripulacao VALUES('t1','piloto1'),('t2','piloto2');
 CREATE TABLE relatorio_despesa_viagem(id TEXT PRIMARY KEY,numero_relatorio TEXT,status TEXT,status_aprovacao_tripulante TEXT,status_aprovacao_tripulante_2 TEXT,token_aprovacao_tripulante_1 TEXT,token_aprovacao_tripulante_2 TEXT,aprovado_tripulante_em TEXT,aprovado_tripulante_1_em TEXT,aprovado_tripulante_2_em TEXT,enviado_para_tripulante_em TEXT,enviado_para_tripulante_2_em TEXT,enviado_para_cliente_em TEXT,motivo_reprovacao_tripulante_1 TEXT,motivo_reprovacao_tripulante_2 TEXT,pdf_url TEXT,pdf_path TEXT,atualizado_em TEXT,despesas TEXT,anexos_rejeicao TEXT,aeronave_id TEXT,tripulacao_id TEXT,tripulante_id_2 TEXT,total_valor REAL);
 CREATE TABLE relatorio_despesa_viagem_historico_ajustes(id TEXT PRIMARY KEY,relatorio_despesa_viagem_id TEXT,tripulante_pos INTEGER,motivo TEXT,anexos TEXT,criado_em TEXT);
 CREATE TABLE auditoria_financeira(id TEXT PRIMARY KEY,entidade TEXT,entidade_id TEXT,operacao TEXT,usuario_id TEXT,motivo TEXT);
 CREATE TABLE lancamentos(id TEXT PRIMARY KEY,origem_tipo TEXT,origem_id TEXT,url_doc TEXT,atualizado_em TEXT,valor_centavos INTEGER,status TEXT);
 INSERT INTO lancamentos VALUES('l1','RELATORIO_DESPESA_VIAGEM','r1','pdf-antigo',NULL,90000,'EM_ABERTO');`);
  const row = {
    id: 'r1',
    numero_relatorio: 'REL-ARM-007/26 PR-LRM',
    status: 'aguardando_aprovacao',
    status_aprovacao_tripulante: 'pendente',
    status_aprovacao_tripulante_2: 'pendente',
    token_aprovacao_tripulante_1: 'token1',
    token_aprovacao_tripulante_2: 'token2',
    aprovado_tripulante_em: null,
    aprovado_tripulante_1_em: null,
    aprovado_tripulante_2_em: null,
    enviado_para_tripulante_em: '2026-11-13',
    enviado_para_tripulante_2_em: '2026-11-13',
    enviado_para_cliente_em: null,
    motivo_reprovacao_tripulante_1: null,
    motivo_reprovacao_tripulante_2: null,
    pdf_url: 'pdf-antigo',
    pdf_path: 'share/relatorios/r1.pdf',
    atualizado_em: '2026-11-13',
    despesas: JSON.stringify([{ valor: 900, pago_por: 'tripulante_1' }]),
    anexos_rejeicao: '[]',
    aeronave_id: 'aviao',
    tripulacao_id: 't1',
    tripulante_id_2: 't2',
    total_valor: 900,
    ...campos,
  };
  const keys = Object.keys(row);
  sql
    .prepare(
      `INSERT INTO relatorio_despesa_viagem (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    )
    .run(...keys.map((k) => row[k]));
  let antesGravar = null;
  const apagados = [];
  let notificacoes = 0,
    sincronizacoes = 0;
  const hook = async () => {
    if (antesGravar) {
      const f = antesGravar;
      antesGravar = null;
      await f();
    }
  };
  const prepare = (query, args = []) => ({
    bind(...v) {
      return prepare(query, v);
    },
    async first() {
      return sql.prepare(query).get(...args) || null;
    },
    async all() {
      return { results: sql.prepare(query).all(...args) };
    },
    async run() {
      await hook();
      const r = sql.prepare(query).run(...args);
      return { meta: { changes: Number(r.changes) }, success: true };
    },
  });
  const db = {
    prepare,
    async batch(statements) {
      await hook();
      sql.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const deps = {
    extractSupabaseUserId: () => null,
    retornarRelatorioRascunho,
    CONCORRENCIA_RELATORIO_SQL,
    valoresConcorrenciaRelatorio,
    uuid: () => crypto.randomUUID(),
    garantirTabelaRelatorioDespesaViagem: async () => {},
    validateWorkerSchema: async () => {},
    authenticatedColaborador: async (c) =>
      c.req.header('authorization') ? { id: 'gestor' } : null,
    getAuthenticatedUserId: async (c) =>
      c.req.header('authorization') ? 'piloto1' : null,
    buscarRelatorioViagemComNomes: async (c, id) =>
      c.env.SHARE_DB.prepare(
        'SELECT * FROM relatorio_despesa_viagem WHERE id=?',
      )
        .bind(id)
        .first(),
    shareBrasilBucket: () => ({ delete: async (p) => apagados.push(p) }),
    statusRelatorioViagem: (v) =>
      String(v || 'rascunho')
        .trim()
        .toLowerCase(),
    requerAprovacaoTripulanteRelatorio: () => false,
    parseRejectionAttachments: (v) => JSON.parse(v || '[]'),
    log: { error: () => {}, warn: () => {} },
    notifyReportRejection: async () => notificacoes++,
    notifyReportDecision: async () => notificacoes++,
    calcularVencimentoReembolsoTripulante: () => '',
    persistirMetadadosFinanceirosRelatorio: async () => {},
    sincronizarRelatorioViagemFinanceiro: async () => sincronizacoes++,
  };
  deps.ajusteAnteriorStatement = funcao('ajusteAnteriorStatement', deps);
  deps.historicoAjusteStatements = funcao('historicoAjusteStatements', deps);
  const app = new Hono();
  for (const [metodo, caminho] of [
    ['post', '/api/financeiro/relatorios-despesa-viagem/:id/voltar-rascunho'],
    ['post', '/api/financeiro/relatorios-despesa-viagem/:id/aprovacao'],
    ['post', '/api/public/relatorios-despesa-viagem/aprovacao/:token'],
    ['get', '/api/public/relatorios-despesa-viagem/aprovacao/:token'],
    ['get', '/api/public/relatorios-despesa-viagem/aprovacao/:token/pdf'],
  ])
    app[metodo](caminho, carregar(codigoRota(metodo, caminho), deps));
  const request = (path, body, autenticado = true) =>
    app.request(
      path,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(autenticado ? { authorization: 'Bearer teste' } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      { SHARE_DB: db },
    );
  return {
    sql,
    db,
    request,
    apagados,
    setAntesGravar: (f) => (antesGravar = f),
    contadores: () => ({ notificacoes, sincronizacoes }),
    atual: () =>
      sql.prepare("SELECT * FROM relatorio_despesa_viagem WHERE id='r1'").get(),
  };
}
const voltar = (a) =>
  a.request('/api/financeiro/relatorios-despesa-viagem/r1/voltar-rascunho', {});
test('aguardando aprovação com links volta a rascunho e invalida links e PDF', async () => {
  const a = ambiente();
  const r = await voltar(a);
  assert.equal(r.status, 200, await r.clone().text());
  const row = (await r.json()).relatorio;
  assert.equal(row.status, 'rascunho');
  assert.equal(row.status_aprovacao_tripulante, 'pendente');
  assert.equal(row.numero_relatorio, 'REL-ARM-007/26 PR-LRM');
  assert.equal(row.total_valor, 900);
  for (const campo of [
    'pdf_path',
    'pdf_url',
    'token_aprovacao_tripulante_1',
    'token_aprovacao_tripulante_2',
    'enviado_para_tripulante_em',
  ])
    assert.equal(row[campo], null, campo);
  assert.deepEqual(a.apagados, ['share/relatorios/r1.pdf']);
  for (const token of ['token1', 'token2']) {
    assert.equal(
      (
        await a.request(
          '/api/public/relatorios-despesa-viagem/aprovacao/' + token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await a.request(
          '/api/public/relatorios-despesa-viagem/aprovacao/' + token + '/pdf',
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await a.request(
          '/api/public/relatorios-despesa-viagem/aprovacao/' + token,
          { aprovado: true },
          false,
        )
      ).status,
      404,
    );
  }
  assert.equal(
    a.sql.prepare('SELECT count(*) n FROM auditoria_financeira').get().n,
    1,
  );
  const l = a.sql.prepare('SELECT * FROM lancamentos').get();
  assert.equal(l.url_doc, null);
  assert.equal(l.valor_centavos, 90000);
  assert.equal(l.status, 'EM_ABERTO');
});
test('pendente independe do status do relatório e da aprovação do segundo tripulante', async () => {
  for (const status of [
    'finalizado',
    'aguardando_aprovacao',
    'ajuste_necessario',
    'ajuste_concluido',
    'aprovado',
    'enviado_cliente',
    'OUTRO_STATUS',
  ]) {
    const a = ambiente({
      status,
      status_aprovacao_tripulante: ' PENDENTE ',
      status_aprovacao_tripulante_2: 'aprovado',
      aprovado_tripulante_2_em: '2026-11-13',
    });
    assert.equal((await voltar(a)).status, 200, status);
    assert.equal(a.atual().status, 'rascunho');
    assert.equal(a.atual().aprovado_tripulante_2_em, null);
  }
});
test('aprovação principal concluída bloqueia o retorno sem apagar PDF ou links', async () => {
  for (const status of ['aprovado', 'reprovado', 'nao_aplicavel']) {
    const a = ambiente({
      status: 'finalizado',
      status_aprovacao_tripulante: status,
    });
    assert.equal((await voltar(a)).status, 409, status);
    assert.equal(a.atual().token_aprovacao_tripulante_1, 'token1');
    assert.equal(a.atual().pdf_path, 'share/relatorios/r1.pdf');
    assert.equal(
      a.sql.prepare('SELECT count(*) n FROM auditoria_financeira').get().n,
      0,
    );
    assert.equal(a.apagados.length, 0);
  }
});
test('finalizado antigo sem aprovação mantém compatibilidade e rascunho é idempotente', async () => {
  const a = ambiente({
    status: 'finalizado',
    status_aprovacao_tripulante: null,
    status_aprovacao_tripulante_2: null,
    token_aprovacao_tripulante_1: null,
    token_aprovacao_tripulante_2: null,
  });
  assert.equal((await voltar(a)).status, 200);
  assert.equal((await voltar(a)).status, 200);
  assert.equal(
    a.sql.prepare('SELECT count(*) n FROM auditoria_financeira').get().n,
    1,
  );
});
test('aprovação gravada depois da leitura impede uma reabertura atrasada', async () => {
  const a = ambiente();
  a.setAntesGravar(() =>
    a.sql
      .prepare(
        "UPDATE relatorio_despesa_viagem SET status_aprovacao_tripulante='aprovado',status='aprovado' WHERE id='r1'",
      )
      .run(),
  );
  assert.equal((await voltar(a)).status, 409);
  assert.equal(a.atual().status, 'aprovado');
  assert.equal(a.apagados.length, 0);
  assert.equal(
    a.sql.prepare('SELECT count(*) n FROM auditoria_financeira').get().n,
    0,
  );
});
test('decisões atrasadas por sessão ou link não restauram aprovação nem histórico após o retorno', async () => {
  for (const publico of [true, false])
    for (const aprovado of [true, false]) {
      const a = ambiente();
      a.setAntesGravar(async () => assert.equal((await voltar(a)).status, 200));
      const path = publico
        ? '/api/public/relatorios-despesa-viagem/aprovacao/token1'
        : '/api/financeiro/relatorios-despesa-viagem/r1/aprovacao';
      const r = await a.request(
        path,
        {
          aprovado,
          motivo: 'Corrigir valores',
          observacoes: 'Corrigir valores',
        },
        !publico,
      );
      assert.equal(r.status, 409, await r.clone().text());
      assert.equal(a.atual().status, 'rascunho');
      assert.equal(a.atual().token_aprovacao_tripulante_1, null);
      assert.equal(
        a.sql
          .prepare(
            'SELECT count(*) n FROM relatorio_despesa_viagem_historico_ajustes',
          )
          .get().n,
        0,
      );
      assert.deepEqual(a.contadores(), { notificacoes: 0, sincronizacoes: 0 });
    }
});
test('decisões válidas continuam registrando aprovação e recusa com histórico', async () => {
  for (const publico of [true, false])
    for (const aprovado of [true, false]) {
      const a = ambiente();
      const path = publico
        ? '/api/public/relatorios-despesa-viagem/aprovacao/token1'
        : '/api/financeiro/relatorios-despesa-viagem/r1/aprovacao';
      const r = await a.request(
        path,
        { aprovado, motivo: 'Corrigir', observacoes: 'Corrigir' },
        !publico,
      );
      assert.equal(r.status, 200, await r.clone().text());
      assert.equal(
        a.atual().status,
        aprovado ? 'aprovado' : 'ajuste_necessario',
      );
      assert.equal(
        a.sql
          .prepare(
            'SELECT count(*) n FROM relatorio_despesa_viagem_historico_ajustes',
          )
          .get().n,
        aprovado ? 0 : 1,
      );
    }
});
test('rota mantém exigência de sessão e retorna 404 para relatório ausente', async () => {
  const a = ambiente();
  assert.equal(
    (
      await a.request(
        '/api/financeiro/relatorios-despesa-viagem/r1/voltar-rascunho',
        {},
        false,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await a.request(
        '/api/financeiro/relatorios-despesa-viagem/inexistente/voltar-rascunho',
        {},
      )
    ).status,
    404,
  );
});
