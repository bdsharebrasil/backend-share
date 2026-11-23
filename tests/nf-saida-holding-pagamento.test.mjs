import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { contextoBaixaCotista, pagamentosContextoBaixa } from '../src/financeiro/FinanceiroKernel.ts';
import { carregarDadosBalancoMensal } from '../src/financeiro/balancoMensalRoutes.ts';
import { Hono } from 'hono';
import { notasSaidaRoutes } from '../src/financeiro/notasSaidaRoutes.ts';

const migration = readFileSync(new URL('../migrations/20261123_rateio_hold_pagamentos.sql', import.meta.url), 'utf8');

// Inclui a FK histórica real de rateio_pagamentos.rateio_id para rateio_despesas.
function banco(comMigracao = true) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE aeronave (id TEXT PRIMARY KEY);
    CREATE TABLE cliente (id TEXT PRIMARY KEY, razao_social TEXT);
    CREATE TABLE holdings (id TEXT PRIMARY KEY);
    CREATE TABLE hold_socios (id TEXT PRIMARY KEY, holding_id TEXT REFERENCES holdings(id), nome TEXT);
    CREATE TABLE cotista_aeronave (id TEXT PRIMARY KEY, aeronave_id TEXT REFERENCES aeronave(id), cliente_id TEXT REFERENCES cliente(id), socio_id TEXT REFERENCES hold_socios(id), percentual_sociedade REAL, codigo_cliente TEXT, status TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, tipo_user TEXT);
    CREATE TABLE usuarios_funcoes (user_id TEXT, funcao TEXT);
    CREATE TABLE categoria_movimentacao_share (id TEXT PRIMARY KEY, nome TEXT, grupo_categoria TEXT);
    CREATE TABLE categoria_movimentacao_cliente (id TEXT PRIMARY KEY, nome TEXT, subcategoria_1 TEXT, subcategoria_2 TEXT, subcategoria_3 TEXT, subcategoria_4 TEXT);
    CREATE TABLE fornecedores_favoritos (id TEXT PRIMARY KEY);
    CREATE TABLE contas_bancarias (id TEXT PRIMARY KEY, banco TEXT, numero_conta TEXT, ativo INTEGER, tipo_caixa TEXT, holding_id TEXT);
    CREATE TABLE lancamentos (
      id TEXT PRIMARY KEY, aeronave_id TEXT REFERENCES aeronave(id), cotista_aeronave_id TEXT,
      colaborador_id TEXT, periodicidade TEXT, data_emissao TEXT, data_vencimento TEXT, data_pagamento TEXT, descricao TEXT,
      fornecedores_favoritos_id TEXT, fornecedor_nome TEXT, categoria_share_id TEXT REFERENCES categoria_movimentacao_share(id),
      categoria_cliente_id TEXT REFERENCES categoria_movimentacao_cliente(id), categoria_nome TEXT, grupo_categoria TEXT,
      fluxo TEXT NOT NULL CHECK(fluxo IN ('RECEITA','ESTORNO','DESPESA','REEMBOLSO','ENTRADA','SAIDA')),
      tipo_caixa TEXT NOT NULL CHECK(tipo_caixa IN ('SHARE','CLIENTE','HOLDING')), valor_centavos INTEGER NOT NULL CHECK(valor_centavos > 0),
      status TEXT CHECK(status IN ('EM_ABERTO','PAGO','RECEBIDO')), numero_nf TEXT, url_nf TEXT, numero_recibo TEXT, url_recibo TEXT,
      conta_bancaria_id TEXT, comprovante_url TEXT, forma_pagamento TEXT, pago_por TEXT, pago_diretamente INTEGER DEFAULT 0 CHECK(pago_diretamente IN (0,1)),
      origem_tipo TEXT, origem_id TEXT, idempotency_key TEXT, email_enviado_em TEXT, email_enviado_id TEXT, criado_por TEXT,
      escopo_financeiro TEXT, cliente_id TEXT, subcategoria_1 TEXT, subcategoria_2 TEXT, subcategoria_3 TEXT, subcategoria_4 TEXT, atualizado_em TEXT
    );
    CREATE TABLE movimentos_holding (
      id TEXT PRIMARY KEY, holding_id TEXT REFERENCES holdings(id), socio_id TEXT REFERENCES hold_socios(id), aeronave_id TEXT,
      escopo_financeiro TEXT, data_emissao TEXT, data_vencimento TEXT, data_pagamento TEXT, descricao TEXT,
      categoria_id TEXT REFERENCES categoria_movimentacao_cliente(id), categoria_nome TEXT, grupo_categoria TEXT, fornecedor_nome TEXT,
      subcategoria_1 TEXT, subcategoria_2 TEXT, subcategoria_3 TEXT, subcategoria_4 TEXT,
      fluxo TEXT, tipo_caixa TEXT, valor_centavos INTEGER, status TEXT, numero_nf TEXT, url_nf TEXT, email_enviado_em TEXT,
      conta_bancaria_id TEXT, comprovante_url TEXT, forma_pagamento TEXT, pago_por TEXT, pago_diretamente INTEGER, criado_por TEXT, atualizado_em TEXT
    );
    CREATE TABLE notas_fiscais_saida (
      id TEXT PRIMARY KEY, numero TEXT NOT NULL, lancamentos_id TEXT, cotista_id TEXT REFERENCES cotista_aeronave(id), aeronave_id TEXT REFERENCES aeronave(id),
      valor_total REAL, percentual REAL, descricao_servico TEXT NOT NULL, nome_categoria TEXT, categoria_id TEXT, subcategoria_1 TEXT,
      data_emissao TEXT NOT NULL, data_vencimento TEXT, status TEXT DEFAULT 'EM_ABERTO', arquivo_pdf_url TEXT, atualizado_em TEXT
    );
    CREATE TABLE contas_areceber (
      id TEXT PRIMARY KEY, data_vencimento TEXT, data_recebimento TEXT, data_pagamento TEXT, valor_centavos INTEGER NOT NULL CHECK(valor_centavos > 0),
      categoria_id TEXT REFERENCES categoria_movimentacao_share(id), categoria_nome TEXT, descricao TEXT, aeronave_id TEXT REFERENCES aeronave(id),
      cotista_id TEXT REFERENCES cotista_aeronave(id), lancamentos_id TEXT REFERENCES lancamentos(id), movimentos_id TEXT REFERENCES movimentos_holding(id),
      nf_saida_id TEXT REFERENCES notas_fiscais_saida(id), recibos_saida_id TEXT,
      status TEXT NOT NULL DEFAULT 'EM_ABERTO' CHECK(status IN ('EM_ABERTO','RECEBIDO','EM_ATRASO','PAGO','CANCELADO')),
      banco_recebimento TEXT REFERENCES contas_bancarias(id), comprovante_recebimento_url TEXT, criado_por TEXT,
      atualizado_em TEXT, origem_tipo TEXT, origem_id TEXT, idempotency_key TEXT UNIQUE, escopo_financeiro TEXT DEFAULT 'FINANCEIRO'
    );
    CREATE TABLE rateio_hold (
      id TEXT PRIMARY KEY, movimento_id TEXT, aeronave_id TEXT NOT NULL REFERENCES aeronave(id), socio_id TEXT NOT NULL REFERENCES hold_socios(id),
      data_emissao TEXT, data_vencimento TEXT, data_pagamento TEXT, categoria_id TEXT REFERENCES categoria_movimentacao_cliente(id), categoria_nome TEXT,
      subcategoria_1 TEXT, subcategoria_2 TEXT, subcategoria_3 TEXT, subcategoria_4 TEXT,
      periodicidade TEXT CHECK(periodicidade IN ('ÚNICO','EVENTUAL','MENSAL','BIMESTRAL','TRIMESTRAL','SEMESTRAL','ANUAL','A CADA 50 H','A CADA 100 H')),
      tipo_rateio TEXT NOT NULL CHECK(tipo_rateio IN ('FIXO','VARIAVEL_POR_VOO','VARIAVEL_POR_HORA','EXTRA')),
      percentual_sociedade REAL, percentual_uso REAL, valor_total_centavos INTEGER NOT NULL CHECK(valor_total_centavos > 0),
      valor_rateado_centavos INTEGER NOT NULL CHECK(valor_rateado_centavos > 0), valor_pago_real_centavos INTEGER NOT NULL DEFAULT 0 CHECK(valor_pago_real_centavos >= 0),
      pago_por TEXT, pago_diretamente INTEGER DEFAULT 0 CHECK(pago_diretamente IN (0,1)),
      status TEXT NOT NULL CHECK(status IN ('EM_ABERTO','PAGO','PAGO_DIRETAMENTE','RECEBIDO','SAIDA','ESTORNO','EM_ATRASO','ENTRADA','AGUARDANDO_REEMBOLSO','REEMBOLSADO','CANCELADO')),
      descricao_despesa TEXT, observacoes TEXT, atualizado_em TEXT, origem_tipo TEXT, origem_id TEXT, documento_numero TEXT, documento_url TEXT,
      numero_voo TEXT, numero_nf TEXT, url_nf TEXT, url_doc TEXT, email_enviado_em TEXT
    );
    CREATE TABLE rateio_despesas (
      id TEXT PRIMARY KEY, lancamento_id TEXT REFERENCES lancamentos(id), categoria_id TEXT, categoria_nome TEXT,
      subcategoria_1 TEXT, subcategoria_2 TEXT, subcategoria_3 TEXT, subcategoria_4 TEXT, cotista_id TEXT, aeronave_id TEXT,
      tipo_rateio TEXT, periodicidade TEXT, data_emissao TEXT, data_vencimento TEXT, data_pagamento TEXT, fornecedor_id TEXT,
      descricao_despesa TEXT, pago_por TEXT, pago_diretamente INTEGER, percentual_sociedade REAL, percentual_uso REAL,
      valor_total_centavos INTEGER, valor_rateado_centavos INTEGER, valor_pago_real_centavos INTEGER, status TEXT,
      numero_recibo TEXT, url_recibo TEXT, numero_nf TEXT, url_nf TEXT, email_enviado_em TEXT, origem_tipo TEXT, url_doc TEXT, atualizado_em TEXT
    );
    CREATE TABLE rateio_pagamentos (
      id TEXT PRIMARY KEY, rateio_id TEXT NOT NULL REFERENCES rateio_despesas(id), conta_receber_id TEXT REFERENCES contas_areceber(id), tipo_pagador TEXT,
      pagador_cotista_id TEXT REFERENCES cotista_aeronave(id), pagador_holding_id TEXT REFERENCES holdings(id),
      valor_centavos INTEGER, data_pagamento TEXT, conta_bancaria_id TEXT REFERENCES contas_bancarias(id), comprovante_url TEXT,
      forma_pagamento TEXT, status TEXT, observacoes TEXT, idempotency_key TEXT UNIQUE, criado_por TEXT
    );
    CREATE TABLE auditoria_financeira (id TEXT PRIMARY KEY, entidade TEXT, entidade_id TEXT, operacao TEXT, valor_anterior_centavos INTEGER, valor_novo_centavos INTEGER, usuario_id TEXT, motivo TEXT, idempotency_key TEXT);
    CREATE TABLE financeiro_vinculos (id TEXT PRIMARY KEY, origem_tipo TEXT, origem_id TEXT, destino_tipo TEXT, destino_id TEXT, tipo_vinculo TEXT);
    CREATE TABLE financeiro_baixa_revisoes (chave TEXT PRIMARY KEY, revisao INTEGER NOT NULL);
    CREATE TABLE reembolsos (id TEXT, conta_receber_id TEXT, lancamento_cliente_id TEXT);
    INSERT INTO aeronave VALUES ('av');
    INSERT INTO holdings VALUES ('dga');
    INSERT INTO hold_socios VALUES ('socio', 'dga', 'Sócio DGA');
    INSERT INTO cliente VALUES ('cliente', 'Cliente comum');
    INSERT INTO cotista_aeronave VALUES ('ca-hold', 'av', NULL, 'socio', 50, 'DGA', 'ativo'), ('ca-cliente', 'av', 'cliente', NULL, 33.33, 'CLI', 'ativo');
    INSERT INTO user_profiles VALUES ('admin','admin');
    INSERT INTO categoria_movimentacao_share VALUES ('receita','Receita Share','RECEITAS');
    INSERT INTO categoria_movimentacao_cliente VALUES ('despesa','Administração','Gestão',NULL,NULL,NULL);
    INSERT INTO contas_bancarias VALUES ('banco-share','SICRED','123',1,'SHARE',NULL);
  `);
  if (comMigracao) sqlite.exec(migration);
  const prepare = (sql, values = []) => ({
    bind(...v) { return prepare(sql, v); },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { return sqlite.prepare(sql).run(...values); },
  });
  // D1 serializa batches atômicos; a fila evita transações SQLite sobrepostas no teste concorrente.
  let queue = Promise.resolve();
  const db = { prepare, batch(statements) {
    const operation = queue.then(async () => {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    });
    queue = operation.catch(() => {});
    return operation;
  } };
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('userId', 'admin'); await next(); });
  app.route('/', notasSaidaRoutes);
  const request = async (body, path = '/notas-saida', method = 'POST') => {
    const response = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { SHARE_DB: db });
    return { status: response.status, body: await response.json() };
  };
  return { sqlite, request, db };
}
const payload = (overrides = {}) => ({
  numero: '123', cotista_id: 'ca-hold', aeronave_id: 'av', valor_total: 1500,
  descricao_servico: 'Gestão mensal', categoria_receita_id: 'receita', categoria_id: 'despesa',
  data_emissao: '2026-11-20', data_vencimento: '2026-11-25', status: 'EM_ABERTO', idempotency_key: 'nova-nota', ...overrides,
});
const pago = (source, overrides = {}) => payload({ status: 'PAGO', data_pagamento: '2026-11-23', conta_bancaria_id: 'banco-share', forma_pagamento: 'PIX', comprovante_url: 'https://documentos.test/pagamento.pdf', saida_pagamento: source, ...overrides });

test('cria NF de hold_socios em aberto com FKs imediatas e categorias dos dois financeiros', async () => {
  const { sqlite, request } = banco();
  const result = await request(payload());
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const conta = sqlite.prepare('SELECT * FROM contas_areceber').get();
  const rateio = sqlite.prepare('SELECT * FROM rateio_hold').get();
  assert.equal(conta.cotista_id, 'ca-hold');
  assert.equal(conta.nf_saida_id, result.body.nota.id);
  assert.equal(rateio.socio_id, 'socio');
  assert.equal(rateio.movimento_id, conta.movimentos_id);
  assert.equal(rateio.categoria_id, 'despesa');
  assert.equal(conta.categoria_id, 'receita');
  assert.equal(rateio.valor_pago_real_centavos, 0);
  assert.equal(rateio.status, 'EM_ABERTO');
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
});

for (const source of ['DGA_BRADESCO', 'CONTA_COTISTA']) {
  test(`criação paga ${source}: quita nota, recebível e rateio, com comprovante e repetição sem duplicar`, async () => {
    const { sqlite, request } = banco();
    const result = await request(pago(source));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const rateio = sqlite.prepare('SELECT * FROM rateio_hold').get();
    const payment = sqlite.prepare('SELECT * FROM rateio_hold_pagamentos').get();
    assert.equal(rateio.pago_diretamente, source === 'CONTA_COTISTA' ? 1 : 0);
    assert.equal(rateio.valor_pago_real_centavos, 150000);
    assert.equal(rateio.data_pagamento, '2026-11-23');
    assert.equal(rateio.status, 'PAGO');
    assert.equal(payment.tipo_pagador, source === 'CONTA_COTISTA' ? 'COTISTA' : 'HOLDING');
    assert.equal(payment.pagador_cotista_id, source === 'CONTA_COTISTA' ? 'ca-hold' : null);
    assert.equal(payment.pagador_holding_id, source === 'DGA_BRADESCO' ? 'dga' : null);
    assert.equal(payment.comprovante_url, 'https://documentos.test/pagamento.pdf');
    assert.equal(payment.conta_bancaria_id, 'banco-share');
    assert.equal(sqlite.prepare('SELECT status FROM contas_areceber').get().status, 'RECEBIDO');
    assert.equal(sqlite.prepare('SELECT status FROM movimentos_holding').get().status, 'PAGO');
    assert.equal(result.body.nota.status, 'RECEBIDO');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rateio_pagamentos').get().n, 0);
    const replay = await request(pago(source));
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.nota.id, result.body.nota.id);
    for (const table of ['notas_fiscais_saida','contas_areceber','rateio_hold','movimentos_holding','rateio_hold_pagamentos']) {
      assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, table);
    }
  });
}

test('nota paga de cliente comum também recebe e quita o espelho, sem holding', async () => {
  const { sqlite, request } = banco();
  const result = await request(pago(undefined, { cotista_id: 'ca-cliente' }));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(sqlite.prepare('SELECT status FROM rateio_despesas').get().status, 'PAGO');
  assert.equal(sqlite.prepare("SELECT status FROM lancamentos WHERE tipo_caixa = 'CLIENTE'").get().status, 'PAGO');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM movimentos_holding').get().n, 0);
});

for (const overrides of [{ data_pagamento: '' }, { data_pagamento: '2026-02-30' }, { conta_bancaria_id: 'inexistente' }, { saida_pagamento: undefined }]) {
  test(`dados de pagamento inválidos não persistem emissão: ${JSON.stringify(overrides)}`, async () => {
    const { sqlite, request } = banco();
    const result = await request(pago('CONTA_COTISTA', overrides));
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM notas_fiscais_saida').get().n, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lancamentos').get().n, 0);
  });
}

test('falha no histórico desfaz a nota, movimento, rateio e recebível juntos', async () => {
  const { sqlite, request } = banco();
  sqlite.exec("CREATE TRIGGER simular_falha BEFORE INSERT ON rateio_hold_pagamentos BEGIN SELECT RAISE(ABORT, 'falha simulada'); END");
  const result = await request(pago('DGA_BRADESCO'));
  assert.equal(result.status, 500);
  for (const table of ['notas_fiscais_saida','contas_areceber','rateio_hold','movimentos_holding','lancamentos']) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

for (const source of ['DGA_BRADESCO', 'CONTA_COTISTA']) {
  test(`baixa posterior de NF da holding: ${source}`, async () => {
    const { sqlite, request } = banco();
    const created = await request(payload());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const payment = { idempotency_key: 'baixa-posterior', tipo_pagador: source === 'CONTA_COTISTA' ? 'COTISTA' : 'HOLDING', pagador_cotista_id: source === 'CONTA_COTISTA' ? 'ca-hold' : null, pagador_holding_id: source === 'DGA_BRADESCO' ? 'dga' : null, saida_pagamento: source, valor_centavos: 150000, data_pagamento: '2026-11-23', conta_bancaria_id: 'banco-share', comprovante_url: 'https://documentos.test/baixa.pdf' };
    const result = await request({ saida_pagamento: source, pagamentos: [payment] }, `/notas-saida/${created.body.nota.id}/dar-baixa`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(sqlite.prepare('SELECT pago_diretamente FROM rateio_hold').get().pago_diretamente, source === 'CONTA_COTISTA' ? 1 : 0);
    const replay = await request({ saida_pagamento: source, pagamentos: [payment] }, `/notas-saida/${created.body.nota.id}/dar-baixa`);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rateio_hold_pagamentos').get().n, 1);
    assert.equal(sqlite.prepare('SELECT comprovante_url FROM rateio_hold_pagamentos').get().comprovante_url, payment.comprovante_url);
  });
}

test('cotista_id da nota referencia cotista_aeronave; socio_id não substitui essa FK', async () => {
  const { sqlite, request } = banco();
  const result = await request(payload({ cotista_id: 'socio' }));
  assert.equal(result.status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM notas_fiscais_saida').get().n, 0);
});

test('PATCH não pode marcar nota paga sem histórico financeiro', async () => {
  const { sqlite, request } = banco();
  const result = await request(payload());
  const update = await request({ status: 'PAGO' }, `/notas-saida/${result.body.nota.id}`, 'PATCH');
  assert.equal(update.status, 409);
  assert.equal(update.body.code, 'status_exige_baixa');
  assert.equal(sqlite.prepare('SELECT status FROM contas_areceber').get().status, 'EM_ABERTO');
});

test('baixa simples com chave na raiz também resolve o cotista e o banco pelo ID', async () => {
  const { sqlite, request } = banco();
  sqlite.exec("INSERT INTO contas_bancarias VALUES ('outro-sicred','SICRED','456',1,'SHARE',NULL)");
  const created = await request(payload({ cotista_id: 'ca-cliente' }));
  const baixa = await request({ idempotency_key: 'baixa-simples', data_pagamento: '2026-11-23', conta_bancaria_id: 'outro-sicred', forma_pagamento: 'PIX' }, `/notas-saida/${created.body.nota.id}/dar-baixa`);
  assert.equal(baixa.status, 200, JSON.stringify(baixa.body));
  const payment = sqlite.prepare('SELECT * FROM rateio_pagamentos').get();
  assert.equal(payment.pagador_cotista_id, 'ca-cliente');
  assert.equal(payment.conta_bancaria_id, 'outro-sicred');
});

for (const source of ['DGA_BRADESCO', 'CONTA_COTISTA']) {
  test(`histórico e balanço da holding usam os eventos corretos: ${source}`, async () => {
    const { sqlite, request, db } = banco();
    const result = await request(pago(source));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const share = sqlite.prepare("SELECT id FROM lancamentos WHERE tipo_caixa = 'SHARE'").get();
    const context = await contextoBaixaCotista(db, share.id);
    const history = await pagamentosContextoBaixa(db, context);
    assert.equal(history.length, 1);
    assert.equal(history[0].comprovante_url, 'https://documentos.test/pagamento.pdf');
    assert.equal(history[0].tipo_pagador, source === 'CONTA_COTISTA' ? 'COTISTA' : 'HOLDING');
    sqlite.exec(`
      CREATE TABLE balanco_ajustes (id TEXT, origem_rateio_id TEXT, destino_rateio_id TEXT, valor_centavos INTEGER, motivo TEXT, aeronave_id TEXT);
      CREATE VIEW vw_balanco_rateios AS SELECT 'HOLD:' || r.id AS id, ca.id AS participante_id,
        'HOLD:' || hs.holding_id AS dominio, 'MOVIMENTO:' || r.movimento_id AS origem_chave,
        r.aeronave_id, r.categoria_nome, r.descricao_despesa, r.tipo_rateio, r.valor_rateado_centavos,
        r.valor_pago_real_centavos, r.pago_por, r.pago_diretamente, r.data_pagamento, r.status
        FROM rateio_hold r JOIN hold_socios hs ON hs.id = r.socio_id
        JOIN cotista_aeronave ca ON ca.socio_id = r.socio_id AND ca.aeronave_id = r.aeronave_id;
    `);
    const balance = await carregarDadosBalancoMensal(db, 'av', '2026-11-30');
    assert.equal(balance.pagamentos.length, 1);
    assert.equal(balance.pagamentos[0].rateioId, `HOLD:${sqlite.prepare('SELECT id FROM rateio_hold').get().id}`);
    const socio = balance.holdings[0].socios.find(s => s.id === 'ca-hold');
    assert.equal(socio.pagoCentavos, source === 'CONTA_COTISTA' ? 150000 : 0);
    assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
}

test('migração é idempotente, mantém pagamentos de cliente e preserva as duas FKs de rateio', async () => {
  const { sqlite, request } = banco();
  const client = await request(pago(undefined, { cotista_id: 'ca-cliente', idempotency_key: 'cliente' }));
  assert.equal(client.status, 201, JSON.stringify(client.body));
  const originalSchema = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='rateio_pagamentos'").get().sql;
  const originalHistory = sqlite.prepare('SELECT * FROM rateio_pagamentos').all();
  sqlite.exec(migration);
  sqlite.exec(migration);
  assert.equal(sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='rateio_pagamentos'").get().sql, originalSchema);
  assert.deepEqual(sqlite.prepare('SELECT * FROM rateio_pagamentos').all(), originalHistory);
  assert.equal(sqlite.prepare("PRAGMA foreign_key_list('rateio_pagamentos')").all().find(f => f.from === 'rateio_id').table, 'rateio_despesas');
  assert.equal(sqlite.prepare("PRAGMA foreign_key_list('rateio_hold_pagamentos')").all().find(f => f.from === 'rateio_id').table, 'rateio_hold');
  const hold = await request(pago('DGA_BRADESCO', { idempotency_key: 'holding' }));
  assert.equal(hold.status, 201, JSON.stringify(hold.body));
  const holdId = sqlite.prepare('SELECT id FROM rateio_hold').get().id;
  assert.throws(() => sqlite.prepare('UPDATE rateio_pagamentos SET rateio_id = ?').run(holdId), /FOREIGN KEY constraint failed/);
  const clientRateioId = sqlite.prepare('SELECT id FROM rateio_despesas').get().id;
  assert.throws(() => sqlite.prepare('UPDATE rateio_hold_pagamentos SET rateio_id = ?').run(clientRateioId), /FOREIGN KEY constraint failed/);
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('sem migração, responde 503 claro na criação paga e na baixa, sem gravações parciais', async () => {
  const { sqlite, request } = banco(false);
  const initial = await request(pago('CONTA_COTISTA'));
  assert.equal(initial.status, 503, JSON.stringify(initial.body));
  assert.equal(initial.body.code, 'migracao_pagamentos_holding_pendente');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM notas_fiscais_saida').get().n, 0);
  const created = await request(payload());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const baixa = await request({ idempotency_key: 'baixa', data_pagamento: '2026-11-23', conta_bancaria_id: 'banco-share', saida_pagamento: 'DGA_BRADESCO' }, `/notas-saida/${created.body.nota.id}/dar-baixa`);
  assert.equal(baixa.status, 503, JSON.stringify(baixa.body));
  assert.equal(baixa.body.code, 'migracao_pagamentos_holding_pendente');
  assert.equal(sqlite.prepare('SELECT status FROM contas_areceber').get().status, 'EM_ABERTO');
  assert.equal(sqlite.prepare('SELECT valor_pago_real_centavos FROM rateio_hold').get().valor_pago_real_centavos, 0);
});

test('exclusão da NF paga remove primeiro o histórico da holding e respeita todas as FKs', async () => {
  const { sqlite, request } = banco();
  const created = await request(pago('DGA_BRADESCO'));
  const response = await request(undefined, `/notas-saida/${created.body.nota.id}`, 'DELETE');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  for (const table of ['notas_fiscais_saida', 'contas_areceber', 'lancamentos', 'rateio_hold', 'rateio_hold_pagamentos', 'movimentos_holding']) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('pagamentos parciais da holding mantêm saldo e aceitam repetição sem duplicar eventos', async () => {
  const { sqlite, request } = banco();
  const created = await request(payload());
  const url = `/notas-saida/${created.body.nota.id}/dar-baixa`;
  const payment = cents => ({ idempotency_key: `parcela-${cents}`, tipo_pagador: 'COTISTA', pagador_cotista_id: 'ca-hold', saida_pagamento: 'CONTA_COTISTA', valor_centavos: cents, data_pagamento: '2026-11-23', conta_bancaria_id: 'banco-share', comprovante_url: 'https://documentos.test/parcial.pdf' });
  const first = { saida_pagamento: 'CONTA_COTISTA', pagamentos: [payment(50000)] };
  assert.equal((await request(first, url)).status, 200);
  assert.equal((await request(first, url)).status, 200);
  assert.equal(sqlite.prepare('SELECT status FROM contas_areceber').get().status, 'EM_ABERTO');
  assert.equal(sqlite.prepare('SELECT valor_pago_real_centavos FROM rateio_hold').get().valor_pago_real_centavos, 50000);
  const final = await request({ saida_pagamento: 'CONTA_COTISTA', pagamentos: [payment(100000)] }, url);
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.equal(sqlite.prepare('SELECT status FROM contas_areceber').get().status, 'RECEBIDO');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rateio_hold_pagamentos').get().n, 2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rateio_pagamentos').get().n, 0);
});

test('falha no histórico durante baixa posterior mantém nota e rateio em aberto', async () => {
  const { sqlite, request } = banco();
  const created = await request(payload());
  sqlite.exec("CREATE TRIGGER falha_baixa BEFORE INSERT ON rateio_hold_pagamentos BEGIN SELECT RAISE(ABORT, 'falha simulada'); END");
  const response = await request({ idempotency_key: 'falha-baixa', data_pagamento: '2026-11-23', conta_bancaria_id: 'banco-share', saida_pagamento: 'DGA_BRADESCO' }, `/notas-saida/${created.body.nota.id}/dar-baixa`);
  assert.equal(response.status, 500);
  assert.equal(sqlite.prepare('SELECT status FROM contas_areceber').get().status, 'EM_ABERTO');
  assert.equal(sqlite.prepare('SELECT status FROM notas_fiscais_saida').get().status, 'EM_ABERTO');
  assert.equal(sqlite.prepare('SELECT valor_pago_real_centavos FROM rateio_hold').get().valor_pago_real_centavos, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rateio_hold_pagamentos').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM financeiro_baixa_revisoes').get().n, 0);
});

test('duas baixas concorrentes da holding não geram pagamento duplicado', async () => {
  const { sqlite, request } = banco();
  const created = await request(payload());
  const url = `/notas-saida/${created.body.nota.id}/dar-baixa`;
  const baixa = key => ({ idempotency_key: key, data_pagamento: '2026-11-23', conta_bancaria_id: 'banco-share', saida_pagamento: 'DGA_BRADESCO' });
  const results = await Promise.all([request(baixa('primeira-baixa'), url), request(baixa('segunda-baixa'), url)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rateio_hold_pagamentos').get().n, 1);
  assert.equal(sqlite.prepare('SELECT SUM(valor_centavos) AS valor FROM rateio_hold_pagamentos').get().valor, 150000);
});
