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
  async all() {
    if (this.sql.includes('FROM cotista_aeronave ca')) {
      return {
        results: this.values.map((id) => ({
          id,
          aeronave_id: this.db.cotistas[id]?.aeronave_id ?? 'aeronave-1',
          cliente_id: this.db.cotistas[id]?.cliente_id ?? 'cliente-1',
          socio_id: null,
          holding_id: null,
        })),
      }
    }
    return { results: [] }
  }
  async run() {
    return { success: true, meta: { changes: 1 } }
  }
}

function fakeDb({ cotistas = {} } = {}) {
  return {
    statements: [],
    insertValues: null,
    cotistas,
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

test('persiste a solicitação direta em aberto, com valor integral, rateio e anexo', async () => {
  const input = validatePaymentRequest(clientPayload())
  const db = fakeDb()
  const result = await createPaymentRequest(db, input, 'usuario-1')
  const insert = db.statements.find((statement) => statement.sql.includes('INSERT INTO envio_despesas'))

  assert.ok(insert)
  assert.match(insert.sql, /valor_total_despesa/)
  assert.match(insert.sql, /'PENDENTE'/)
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

test('rejeita rateio direto com cotista de outra aeronave', async () => {
  const input = validatePaymentRequest(clientPayload({
    rateio_linhas: [
      { cotista_id: 'cotista-1', percentual: 50, percentual_sociedade: 50, valor_centavos: 6173 },
      { cotista_id: 'cotista-2', percentual: 50, percentual_sociedade: 50, valor_centavos: 6172 },
    ],
  }))
  const db = fakeDb({ cotistas: { 'cotista-2': { aeronave_id: 'aeronave-2' } } })

  await assert.rejects(
    createPaymentRequest(db, input, 'usuario-1'),
    /cotista_nao_vinculado_a_aeronave_informada/,
  )
  assert.equal(db.statements.some((statement) => statement.sql.includes('INSERT INTO envio_despesas')), false)
})

test('converte envio direto com rateio em aberto até a baixa do pagamento', async () => {
  const db = fakeDb()
  let comandoCapturado
  let criouLancamento = false
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

  const result = await convertPaymentRequest(db, request, {
    createExpense: async () => ({ id: 'lancamento-1' }),
    createDirectExternalExpense: async (_db, command) => {
      criouLancamento = true
      comandoCapturado = command
      return { id: 'lancamento-1' }
    },
    createClientExpenseRateios: async (_db, command) => {
      comandoCapturado = command
      return { lancamento_id: request.id, rateio_ids: ['rateio-1', 'rateio-2'] }
    },
  }, 'usuario-1')

  assert.equal(criouLancamento, false)
  assert.equal(result.lancamento_id, request.id)
  assert.equal(result.movimentacao_id, null)
  assert.equal(db.batches.some((statement) => statement.sql.includes('INSERT INTO lancamentos')), false)
  assert.equal(comandoCapturado.lancamento_id, request.id)
  assert.equal(comandoCapturado.tipo_caixa, 'CLIENTE')
  assert.equal(comandoCapturado.pago_diretamente, false)
  assert.equal(comandoCapturado.cotista_pagador_id, null)
  assert.equal(comandoCapturado.rateio_linhas[0].pago_diretamente, false)
  assert.equal(comandoCapturado.rateio_linhas[0].pago_por, null)
  assert.equal(comandoCapturado.rateio_linhas[0].valor_pago_real_centavos, 0)
  assert.equal(comandoCapturado.rateio_linhas[1].pago_diretamente, false)
  assert.equal(comandoCapturado.rateio_linhas[1].pago_por, null)
  assert.equal(comandoCapturado.rateio_linhas[1].valor_pago_real_centavos, 0)
})
