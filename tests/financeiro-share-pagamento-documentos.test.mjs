import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { settleShareExpense } from '../src/financeiro/FinanceiroKernel.ts';
import { documentosRelatorio, colunaAnexosLancamento } from '../src/financeiro/documentosRelatorio.ts';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`
    CREATE TABLE lancamentos (id TEXT PRIMARY KEY, tipo_caixa TEXT, fluxo TEXT, status TEXT, valor_centavos INTEGER,
      reembolsavel INTEGER DEFAULT 1, reembolso_quitado INTEGER DEFAULT 0, pago_diretamente INTEGER DEFAULT 0,
      data_pagamento TEXT, conta_bancaria_id TEXT, comprovante_url TEXT, forma_pagamento TEXT, atualizado_em TEXT);
    CREATE TABLE contas_apagar (id TEXT PRIMARY KEY, lancamentos_id TEXT, movimentos_id TEXT, status TEXT, valor_centavos INTEGER,
      data_pagamento TEXT, banco_pagamento TEXT, comprovante_pagamento_url TEXT, atualizado_em TEXT);
    CREATE TABLE contas_areceber (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE rateio_despesas (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE contas_bancarias (id TEXT PRIMARY KEY, banco TEXT, numero_conta TEXT, tipo_caixa TEXT, ativo INTEGER);
    CREATE TABLE envio_despesas (id TEXT, descricao TEXT, criado_por TEXT, solicitacao_compra_id TEXT, lancamento_id TEXT, tipo TEXT, status TEXT);
    CREATE TABLE auditoria_financeira (id TEXT PRIMARY KEY, entidade TEXT, entidade_id TEXT, operacao TEXT,
      valor_anterior_centavos INTEGER, valor_novo_centavos INTEGER, usuario_id TEXT, motivo TEXT, idempotency_key TEXT);
    CREATE TABLE relatorio_despesa_viagem (id TEXT PRIMARY KEY, pdf_path TEXT);
    INSERT INTO contas_bancarias VALUES ('share', 'SICRED', '', 'SHARE', 1), ('hold', 'BRADESCO', '', 'HOLDING', 1);
    INSERT INTO lancamentos (id, tipo_caixa, fluxo, status, valor_centavos) VALUES ('despesa', 'SHARE', 'SAIDA', 'EM_ABERTO', 50000);
    INSERT INTO contas_areceber VALUES ('recebimento-cliente', 'EM_ABERTO');
    INSERT INTO rateio_despesas VALUES ('rateio-cliente', 'EM_ABERTO');
    INSERT INTO relatorio_despesa_viagem VALUES ('rel-1', 'share/relatorio_despesa_viagem/antigo.pdf');
  `);
  const wrap = (query, params = []) => ({
    bind(...args) { return wrap(query, args); },
    first: async () => sql.prepare(query).get(...params) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...params) }),
    run: async () => ({ meta: { changes: sql.prepare(query).run(...params).changes } }),
  });
  const db = { prepare: wrap, batch: async statements => {
    sql.exec('BEGIN');
    try { const out = []; for (const st of statements) out.push(await st.run()); sql.exec('COMMIT'); return out; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  }};
  return { sql, db };
}
const body = { data_pagamento: '2026-11-24', conta_bancaria_id: 'share', comprovante_pagamento_url: '/api/comprovante.pdf', forma_pagamento: 'PIX' };

for (const vinculada of [false, true]) test(`baixa Share ${vinculada ? 'com conta vinculada' : 'sem conta legada'} salva pagamento e preserva reembolso`, async () => {
  const { sql, db } = fixture();
  if (vinculada) sql.exec("INSERT INTO contas_apagar (id, lancamentos_id, status, valor_centavos) VALUES ('cp-1', 'despesa', 'EM_ABERTO', 50000)");
  await settleShareExpense(db, 'despesa', body, 'gestor');
  const pago = sql.prepare('SELECT * FROM lancamentos').get();
  assert.equal(pago.status, 'PAGO');
  assert.equal(pago.conta_bancaria_id, 'share');
  assert.equal(pago.comprovante_url, '/api/comprovante.pdf');
  assert.equal(pago.forma_pagamento, 'PIX');
  assert.equal(pago.reembolso_quitado, 0);
  assert.equal(sql.prepare('SELECT status FROM contas_areceber').get().status, 'EM_ABERTO');
  assert.equal(sql.prepare('SELECT status FROM rateio_despesas').get().status, 'EM_ABERTO');
  assert.equal(sql.prepare('SELECT count(*) n FROM contas_apagar').get().n, vinculada ? 1 : 0);
  const replay = await settleShareExpense(db, 'despesa', body, 'gestor');
  assert.equal(replay.idempotent, true);
  assert.equal(sql.prepare('SELECT count(*) n FROM auditoria_financeira').get().n, 1);
});

test('recusa banco de holding, data inválida, cancelamento e origem fora do caixa Share', async () => {
  const { sql, db } = fixture();
  await assert.rejects(settleShareExpense(db, 'despesa', { ...body, conta_bancaria_id: 'hold' }, null), { code: 'conta_bancaria_share_invalida' });
  await assert.rejects(settleShareExpense(db, 'despesa', { ...body, data_pagamento: '2026-02-31' }, null), { code: 'data_pagamento_invalida' });
  sql.exec("UPDATE lancamentos SET status = 'CANCELADO'");
  await assert.rejects(settleShareExpense(db, 'despesa', body, null), { code: 'lancamento_cancelado' });
  sql.exec("UPDATE lancamentos SET status = 'EM_ABERTO', tipo_caixa = 'CLIENTE'");
  await assert.rejects(settleShareExpense(db, 'despesa', body, null), { code: 'pagamento_share_origem_invalida' });
  assert.equal(sql.prepare('SELECT count(*) n FROM auditoria_financeira').get().n, 0);
});

test('não escolhe arbitrariamente entre contas duplicadas ou canceladas', async () => {
  const { sql, db } = fixture();
  sql.exec("INSERT INTO contas_apagar (id, lancamentos_id, status) VALUES ('a', 'despesa', 'EM_ABERTO'), ('b', 'despesa', 'EM_ABERTO')");
  await assert.rejects(settleShareExpense(db, 'despesa', body, null), { code: 'vinculo_ambiguo' });
  sql.exec("UPDATE contas_apagar SET status = 'CANCELADO'");
  await assert.rejects(settleShareExpense(db, 'despesa', body, null), { code: 'conta_cancelada' });
});

test('relatórios legados por origem e chave R2 recebem URL autenticada; demais anexos são preservados', async () => {
  const { db } = fixture();
  const [origem, legado, reembolso, externo] = await documentosRelatorio(db, [
    { origem_tipo: 'RELATORIO_DESPESA_VIAGEM', origem_id: 'rel-1' },
    { url_doc: 'share/relatorio_despesa_viagem/antigo.pdf' },
    { lancamento_origem_tipo: 'RELATORIO_DESPESA_VIAGEM', lancamento_origem_id: 'rel-1', url_nf: 'https://anexos.test/nota.pdf' },
    { url_doc: 'https://anexos.test/recibo.pdf' },
  ]);
  assert.equal(origem.documentoUrl, '/api/financeiro/relatorios-despesa-viagem/rel-1/pdf');
  assert.equal(legado.url_doc, origem.documentoUrl);
  assert.equal(reembolso.url_nf, 'https://anexos.test/nota.pdf');
  assert.equal(reembolso.documentoUrl, origem.documentoUrl);
  assert.equal(externo.url_doc, 'https://anexos.test/recibo.pdf');
});

test('consulta de anexos funciona com e sem a coluna opcional no D1', async () => {
  const { sql, db } = fixture();
  assert.equal(await colunaAnexosLancamento(db), 'NULL AS anexos_json');
  sql.exec('ALTER TABLE lancamentos ADD COLUMN anexos_json TEXT');
  assert.equal(await colunaAnexosLancamento(db), 'l.anexos_json');
});
