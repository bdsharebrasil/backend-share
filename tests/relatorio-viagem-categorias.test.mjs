import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { CATEGORIA_SHARE_DESPESA_RELATORIO, CATEGORIA_CLIENTE_RELATORIO_ID, CATEGORIA_SHARE_ENTRADA_RELATORIO_ID } from '../src/relatorioFinanceiro.ts'

const migration = await readFile(new URL('../migrations/20261126_relatorio_viagem_categorias.sql', import.meta.url), 'utf8')
const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')

function banco() {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE categoria_movimentacao_share(id TEXT PRIMARY KEY);
    CREATE TABLE categoria_movimentacao_cliente(id TEXT PRIMARY KEY);
    CREATE TABLE lancamentos(id TEXT PRIMARY KEY, origem_tipo TEXT, tipo_caixa TEXT, fluxo TEXT,
      categoria_share_id TEXT REFERENCES categoria_movimentacao_share(id),
      categoria_cliente_id TEXT REFERENCES categoria_movimentacao_cliente(id), categoria_nome TEXT, grupo_categoria TEXT,
      status TEXT, valor_centavos INTEGER, data_pagamento TEXT, comprovante_url TEXT, origem_id TEXT);
    CREATE TABLE contas_apagar(id TEXT PRIMARY KEY, origem_tipo TEXT, categoria_nome TEXT, status TEXT, valor_centavos INTEGER, comprovante_url TEXT);
    CREATE TABLE contas_areceber(id TEXT PRIMARY KEY, origem_tipo TEXT, categoria_id TEXT REFERENCES categoria_movimentacao_share(id),
      categoria_nome TEXT, status TEXT, valor_centavos INTEGER, comprovante_url TEXT);
    CREATE TABLE rateio_despesas(id TEXT PRIMARY KEY, origem_tipo TEXT, lancamento_id TEXT REFERENCES lancamentos(id),
      categoria_id TEXT REFERENCES categoria_movimentacao_cliente(id), categoria_nome TEXT, status TEXT, valor_pago_real_centavos INTEGER, baixas_json TEXT);`)
  for (const id of [CATEGORIA_SHARE_DESPESA_RELATORIO.categoria_share_id, CATEGORIA_SHARE_ENTRADA_RELATORIO_ID, 'assinaturas']) {
    db.prepare('INSERT INTO categoria_movimentacao_share VALUES (?)').run(id)
  }
  db.prepare('INSERT INTO categoria_movimentacao_cliente VALUES (?)').run(CATEGORIA_CLIENTE_RELATORIO_ID)
  const insert = db.prepare('INSERT INTO lancamentos VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (let i = 0; i < 6; i++) {
    insert.run(`saida-${i}`, 'RELATORIO_DESPESA_VIAGEM', 'SHARE', 'SAIDA', i ? 'assinaturas' : CATEGORIA_SHARE_DESPESA_RELATORIO.categoria_share_id,
      null, 'ASSINATURAS', 'DESPESAS REEMBOLSÁVEIS', i === 5 ? 'EM_ABERTO' : 'PAGO', 1000 + i,
      i === 5 ? null : '2026-11-20', i === 5 ? null : 'pagamento.pdf', 'relatorio-1')
  }
  insert.run('cliente', 'RELATORIO_DESPESA_VIAGEM', 'CLIENTE', 'SAIDA', null, CATEGORIA_CLIENTE_RELATORIO_ID,
    'ERRADA', 'CAIXA CLIENTE', 'PAGO', 999, '2026-11-20', 'cliente.pdf', 'relatorio-1')
  insert.run('entrada', 'RELATORIO_DESPESA_VIAGEM', 'SHARE', 'ENTRADA', 'assinaturas', null,
    'ASSINATURAS', 'REEMBOLSOS ENTRADAS', 'RECEBIDO', 999, '2026-11-20', 'recebido.pdf', 'relatorio-1')
  insert.run('outra-despesa', 'RECIBO', 'SHARE', 'SAIDA', 'assinaturas', null,
    'ASSINATURAS', 'OUTRO GRUPO', 'PAGO', 999, '2026-11-20', 'outra.pdf', 'recibo-1')
  for (const table of ['contas_apagar', 'contas_areceber']) {
    const fields = table === 'contas_areceber' ? "NULL, 'ASSINATURAS'" : "'ASSINATURAS'"
    db.exec(`INSERT INTO ${table} VALUES ('relatorio', 'RELATORIO_DESPESA_VIAGEM', ${fields}, 'PAGO', 999, 'conta.pdf');
      INSERT INTO ${table} VALUES ('outra', 'RECIBO', ${fields}, 'PAGO', 999, 'outra.pdf');`)
  }
  db.exec(`INSERT INTO rateio_despesas VALUES ('rateio', NULL, 'cliente', NULL, 'ASSINATURAS', 'PAGO', 999, '[{"comprovante":"rateio.pdf"}]');`)
  return db
}

function financeiro(db) {
  return {
    lancamentos: db.prepare('SELECT id, origem_tipo, tipo_caixa, fluxo, status, valor_centavos, data_pagamento, comprovante_url, origem_id FROM lancamentos ORDER BY id').all(),
    pagar: db.prepare('SELECT id, status, valor_centavos, comprovante_url FROM contas_apagar ORDER BY id').all(),
    receber: db.prepare('SELECT id, status, valor_centavos, comprovante_url FROM contas_areceber ORDER BY id').all(),
    rateios: db.prepare('SELECT id, lancamento_id, status, valor_pago_real_centavos, baixas_json FROM rateio_despesas ORDER BY id').all(),
  }
}

test('corrige as seis saídas, a entrada e o cliente sem modificar pagamentos ou outras origens', () => {
  const db = banco()
  try {
    const before = financeiro(db)
    const other = db.prepare("SELECT * FROM lancamentos WHERE id = 'outra-despesa'").get()
    db.exec(migration)
    assert.deepEqual(financeiro(db), before)
    assert.deepEqual(db.prepare("SELECT * FROM lancamentos WHERE id = 'outra-despesa'").get(), other)
    for (const row of db.prepare("SELECT * FROM lancamentos WHERE id LIKE 'saida-%'").all()) {
      assert.equal(row.categoria_share_id, CATEGORIA_SHARE_DESPESA_RELATORIO.categoria_share_id)
      assert.equal(row.categoria_nome, 'RELATORIO DE VIAGEM')
      assert.equal(row.grupo_categoria, 'DESPESAS REEMBOLSÁVEIS')
    }
    const client = db.prepare("SELECT * FROM lancamentos WHERE id = 'cliente'").get()
    assert.equal(client.categoria_cliente_id, CATEGORIA_CLIENTE_RELATORIO_ID)
    assert.equal(client.categoria_nome, 'DESPESAS DE VIAGEM')
    assert.equal(client.grupo_categoria, 'DESPESAS DE VIAGEM')
    const entrada = db.prepare("SELECT * FROM lancamentos WHERE id = 'entrada'").get()
    assert.equal(entrada.categoria_share_id, CATEGORIA_SHARE_ENTRADA_RELATORIO_ID)
    assert.equal(entrada.categoria_nome, 'REEMBOLSO RELATORIO DE DESPESA DE VIAGENS recebido')
    assert.equal(entrada.grupo_categoria, 'REEMBOLSOS ENTRADAS')
    assert.equal(db.prepare("SELECT categoria_nome FROM contas_apagar WHERE id = 'relatorio'").get().categoria_nome, 'RELATORIO DE VIAGEM')
    assert.equal(db.prepare("SELECT categoria_id FROM contas_areceber WHERE id = 'relatorio'").get().categoria_id, CATEGORIA_SHARE_ENTRADA_RELATORIO_ID)
    assert.equal(db.prepare("SELECT categoria_nome FROM contas_apagar WHERE id = 'outra'").get().categoria_nome, 'ASSINATURAS')
    assert.equal(db.prepare("SELECT categoria_nome FROM contas_areceber WHERE id = 'outra'").get().categoria_nome, 'ASSINATURAS')
    assert.equal(db.prepare('SELECT categoria_id FROM rateio_despesas').get().categoria_id, CATEGORIA_CLIENTE_RELATORIO_ID)
    assert.equal(db.prepare('SELECT categoria_nome FROM rateio_despesas').get().categoria_nome, 'DESPESAS DE VIAGEM')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    const changes = db.prepare('SELECT total_changes() AS n').get().n
    db.exec(migration)
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
  } finally { db.close() }
})

test('envio usa os IDs específicos de saída, cliente e entrada e mantém a categoria no reenvio', () => {
  const envio = worker.slice(worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/:id/enviar-cliente'"), worker.indexOf("app.post('/api/public/relatorios-despesa-viagem/aprovacao/:token'"))
  assert.match(envio, /bind\(CATEGORIA_SHARE_DESPESA_RELATORIO\.categoria_share_id\)/)
  assert.match(envio, /const categoriaClienteId = CATEGORIA_CLIENTE_RELATORIO_ID/)
  assert.match(envio, /bind\(CATEGORIA_SHARE_ENTRADA_RELATORIO_ID\)/)
  assert.match(envio, /UPDATE lancamentos SET categoria_share_id = \?, categoria_nome = \?, grupo_categoria = 'REEMBOLSOS ENTRADAS'/)
})
