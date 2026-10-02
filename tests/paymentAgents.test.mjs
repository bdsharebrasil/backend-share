import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validatePaymentRequest, createPaymentRequest, convertPaymentRequest } from '../src/financeiro/paymentAgents.ts'

const migrationPath = new URL('../migrations/20261002_envios_despesas_total_despesa.sql', import.meta.url)
const schemaPath = new URL('../schema.sql', import.meta.url)

class FakeStatement {
  constructor(db, sql) {
    this.db = db
    this.sql = sql
    this.values = []
  }
  bind(...values) {
    this.values = values
    return this
  }
  async first() {
    if (this.sql.includes("destino_tipo = 'ENVIO_DESPESA'")) return null
    if (this.sql.includes('FROM cotista_aeronave ca')) {
      return { aeronave_id: 'aeronave-1', cliente_id: 'cliente-1', socio_id: null, holding_id: null }
    }
    if (this.sql === 'SELECT * FROM envio_despesas WHERE id = ?') {
      return { id: this.values[0], valor_total_despesa: this.db.insertValues?.[4] }
    }
    return null
  }
  async run() {
    return { success: true, meta: { changes: 1 } }
  }
}

function fakeDb() {
  return {
    statements: [],
    insertValues: null,
    prepare(sql) {
      const statement = new FakeStatement(this, sql)
      this.statements.push(statement)
      const originalBind = statement.bind.bind(statement)
      statement.bind = (...values) => {
        originalBind(...values)
        if (sql.includes('INSERT INTO envio_despesas')) this.insertValues = values
        return statement
      }
      return statement
    },
    async batch(statements) {
      this.batches = statements
      return statements.map(() => ({ success: true }))
    },
  }
}

function clientPayload(overrides = {}) {
  return {
    tipo: 'cliente',
    descricao: 'Manutenção da aeronave',
    valor_centavos: 12345,
    valor_total_despesa_centavos: 12345,
    data_despesa: '2026-10-02',
    data_vencimento: '2026-10-15',
    aeronave_id: 'aeronave-1',
    categoria_id: 'categoria-cliente-1',
    categoria_cliente_id: 'categoria-cliente-1',
    cotista_pagador_id: 'cotista-1',
    rateio_linhas: [{ cotista_id: 'cotista-1', percentual: 100, percentual_sociedade: 100, valor_centavos: 12345 }],
    anexos: [{ id: 'nf-1', tipo: 'nf', numero: 'NF-42', url: 'https://share-brasil.com/share/nf-42.pdf', cotista_id: 'cotista-1' }],
    tipo_rateio: 'FIXO',
    idempotency_key: 'envio-test-1',
    ...overrides,
  }
}

test('migração adiciona a coluna gravada pelo endpoint de envio de despesas', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  assert.match(sql, /ALTER TABLE\s+envio_despesas\s+ADD COLUMN\s+valor_total_despesa\s+REAL/i)
})

test('schema-base mantém a coluna para restaurações e testes', async () => {
  const schema = await readFile(schemaPath, 'utf8')
  const start = schema.indexOf('CREATE TABLE "envio_despesas"')
  const end = schema.indexOf('CREATE TABLE escala_tripulacao', start)
  assert.ok(start >= 0 && end > start)
  assert.match(schema.slice(start, end), /valor_total_despesa REAL/)
})

test('persiste o valor integral, vencimento, rateio e anexo atribuído ao cotista', async () => {
  const input = validatePaymentRequest(clientPayload())
  const db = fakeDb()
  const result = await createPaymentRequest(db, input, 'usuario-1')
  const insert = db.statements.find((statement) => statement.sql.includes('INSERT INTO envio_despesas'))

  assert.ok(insert)
  assert.match(insert.sql, /valor_total_despesa/)
  assert.equal(db.insertValues[4], 123.45)
  assert.equal(result.valor_total_despesa, 123.45)
  assert.equal(db.insertValues[12], 0)
  assert.equal(db.insertValues[13], null)
  assert.equal(db.insertValues[6], '2026-10-15')
  assert.deepEqual(JSON.parse(String(db.insertValues[17])), input.rateio_linhas)
  assert.deepEqual(JSON.parse(String(db.insertValues[18])), input.anexos)
})

test('rejeita despesas de cliente cujo rateio não fecha o valor informado', () => {
  assert.throws(
    () => validatePaymentRequest(clientPayload({
      rateio_linhas: [{ cotista_id: 'cotista-1', percentual: 100, valor_centavos: 12344 }],
    })),
    /rateio_linhas inválido/,
  )
})

test('converte despesas de cliente mantendo todos os cotistas em aberto e sem pagador', async () => {
  const db = fakeDb()
  let comandoCapturado
  const request = {
    id: 'envio-cliente-1',
    status: 'PENDENTE',
    tipo: 'cliente',
    descricao: 'Manutenção da aeronave',
    valor: 123.45,
    valor_total_despesa: 123.45,
    data_despesa: '2026-10-02',
    vencimento: '2026-10-15',
    aeronave_id: 'aeronave-1',
    categoria_id: 'categoria-cliente-1',
    categoria_cliente_id: 'categoria-cliente-1',
    pago_por: 'cotista-1',
    rateio_linhas_json: JSON.stringify([
      { cotista_id: 'cotista-1', percentual: 50, valor_centavos: 6173, pago_por: 'cotista-1', pago_diretamente: true, valor_pago_real_centavos: 6173 },
      { cotista_id: 'cotista-2', percentual: 50, valor_centavos: 6172, pago_por: 'cotista-1', pago_diretamente: false, valor_pago_real_centavos: 0 },
    ]),
    anexos_json: '[]',
  }

  await convertPaymentRequest(db, request, {
    createExpense: async () => ({ id: 'lancamento-1' }),
    createDirectExternalExpense: async (_db, command) => {
      comandoCapturado = command
      return { id: 'lancamento-1' }
    },
  }, 'usuario-1')

  assert.equal(comandoCapturado.tipo_caixa, 'CLIENTE')
  assert.equal(comandoCapturado.pago_diretamente, false)
  assert.equal(comandoCapturado.cotista_pagador_id, null)
  assert.equal(comandoCapturado.pago_por, null)
  assert.ok(comandoCapturado.rateio_linhas.every((linha) => linha.pago_diretamente === false))
  assert.ok(comandoCapturado.rateio_linhas.every((linha) => linha.pago_por === null))
  assert.ok(comandoCapturado.rateio_linhas.every((linha) => linha.valor_pago_real_centavos === 0))
})
