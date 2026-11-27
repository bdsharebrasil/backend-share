import assert from 'node:assert/strict'
import { test } from 'node:test'
import { financeiroRoutes } from '../src/financeiroRoutes.ts'

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = [] }
  bind(...values) { this.values = values; return this }
  first() { return this.db.first(this.sql, this.values) }
  all() { return this.db.all(this.sql, this.values) }
  run() { return this.db.run(this.sql, this.values) }
}

class FakeD1 {
  constructor({ parentId, sourceLaunch = null, envio = null, directLaunch = false }) {
    this.parentId = parentId
    this.sourceLaunch = sourceLaunch
    this.envio = envio
    this.directLaunch = directLaunch
    this.updates = []
  }
  prepare(sql) { return new FakeStatement(this, sql) }
  async first(sql, values) {
    if (sql.includes('SELECT id, "rateio_despesas" AS origem FROM rateio_despesas WHERE id = ?')) return null
    if (sql.includes('SELECT lancamento_id AS id, "rateio_despesas_pai" AS origem FROM rateio_despesas')) {
      return !this.directLaunch && values[0] === this.parentId ? { id: this.parentId, origem: 'rateio_despesas_pai' } : null
    }
    if (sql.includes('SELECT id, "rateio_hold" AS origem FROM rateio_hold')) return null
    if (sql.includes('SELECT id, "lancamentos" AS origem FROM lancamentos WHERE id = ?')) {
      return this.directLaunch && values[0] === this.parentId ? { id: this.parentId, origem: 'lancamentos' } : null
    }
    if (sql.includes('SELECT * FROM lancamentos WHERE id = ?')) return { id: values[0] }
    if (sql.includes('SELECT id, "movimentos_holding" AS origem FROM movimentos_holding')) return null
    if (sql.includes('SELECT lancamento_id FROM rateio_despesas WHERE id = ?')) return null
    if (sql.includes('SELECT id, tipo_caixa, origem_tipo, origem_id FROM lancamentos WHERE id = ?')) {
      return values[0] === this.parentId ? this.sourceLaunch : null
    }
    if (sql.includes('SELECT id FROM envio_despesas WHERE id = ?')) {
      return values[0] === this.parentId ? this.envio : null
    }
    throw new Error(`Consulta first não simulada: ${sql}`)
  }
  async all(sql) {
    if (sql.includes('SELECT * FROM rateio_despesas WHERE lancamento_id = ?')) return { results: [] }
    throw new Error(`Consulta all não simulada: ${sql}`)
  }
  async run(sql, values) {
    this.updates.push({ sql, values })
    return { success: true, meta: { changes: 1 } }
  }
  async batch(statements) {
    this.updates.push(...statements.map(({ sql, values }) => ({ sql, values })))
    return statements.map(() => ({ success: true, meta: { changes: 1 } }))
  }
}

async function editarDescricao(db, id, descricao = 'Descrição corrigida') {
  return financeiroRoutes.request(`/lancamentos/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ descricao }),
  }, { SHARE_DB: db })
}

test('edita descrição do rateio e propaga ao lançamento cliente, receita Share e conta a receber', async () => {
  const db = new FakeD1({
    parentId: 'lancamento-cliente-1',
    sourceLaunch: { id: 'lancamento-cliente-1', tipo_caixa: 'CLIENTE', origem_tipo: 'NF_SAIDA', origem_id: 'lancamento-share-1' },
  })

  const response = await editarDescricao(db, 'lancamento-cliente-1')
  assert.equal(response.status, 200)

  const updates = db.updates.filter(({ sql }) => sql.startsWith('UPDATE '))
  assert.ok(updates.some(({ sql, values }) => sql.includes('UPDATE rateio_despesas') && sql.includes('WHERE lancamento_id = ?') && values.at(-1) === 'lancamento-cliente-1'))
  assert.ok(updates.some(({ sql, values }) => sql.includes('UPDATE lancamentos') && values.at(-1) === 'lancamento-cliente-1'))
  assert.ok(updates.some(({ sql, values }) => sql.includes('UPDATE lancamentos') && values.at(-1) === 'lancamento-share-1'))
  assert.ok(updates.some(({ sql, values }) => sql.includes('UPDATE contas_areceber') && values.includes('lancamento-cliente-1') && values.includes('lancamento-share-1')))
  assert.ok(updates.every(({ values }) => values[0] === 'Descrição corrigida'))
})

test('edita descrição da despesa originada em envio_despesas sem criar lançamento Share', async () => {
  const db = new FakeD1({ parentId: 'envio-1', envio: { id: 'envio-1' } })

  const response = await editarDescricao(db, 'envio-1')
  assert.equal(response.status, 200)

  const updates = db.updates.filter(({ sql }) => sql.startsWith('UPDATE '))
  assert.ok(updates.some(({ sql, values }) => sql.includes('UPDATE rateio_despesas') && values.at(-1) === 'envio-1'))
  assert.ok(updates.some(({ sql, values }) => sql.includes('UPDATE envio_despesas') && values.at(-1) === 'envio-1'))
  assert.ok(!updates.some(({ sql }) => sql.includes('UPDATE lancamentos')))
})

test('edita data e demais dados da baixa de um lançamento Share já pago', async () => {
  const db = new FakeD1({ parentId: 'share-pago-1', directLaunch: true })
  const dados = {
    data_pagamento: '2026-11-21',
    conta_bancaria_id: 'conta-2',
    forma_pagamento: 'PIX',
    comprovante_url: 'https://docs.test/comprovante.pdf',
    pago_por: 'Share Brasil',
  }
  const response = await financeiroRoutes.request('/lancamentos/share-pago-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dados),
  }, { SHARE_DB: db })

  assert.equal(response.status, 200, await response.clone().text())
  const update = db.updates.find(({ sql }) => sql.includes('UPDATE lancamentos SET'))
  assert.ok(update)
  for (const campo of Object.keys(dados)) assert.match(update.sql, new RegExp(`${campo} = \\?`))
  assert.ok(Object.values(dados).every((valor) => update.values.includes(valor)))
  assert.equal(update.values.at(-1), 'share-pago-1')
  assert.ok(db.updates.some(({ sql, values }) => sql.includes('UPDATE contas_apagar SET') && sql.includes('data_pagamento = ?') && values.includes('2026-11-21')))
  assert.ok(db.updates.some(({ sql, values }) => sql.includes('UPDATE contas_areceber SET') && sql.includes('data_recebimento = ?') && values.includes('2026-11-21')))
  assert.ok(db.updates.some(({ sql, values }) => sql.includes('UPDATE contas_apagar SET') && sql.includes('comprovante_pagamento_url = ?') && values.includes('https://docs.test/comprovante.pdf')))
  assert.ok(db.updates.some(({ sql, values }) => sql.includes('UPDATE contas_areceber SET') && sql.includes('comprovante_recebimento_url = ?') && values.includes('https://docs.test/comprovante.pdf')))
})

test('edição de saída persiste fornecedor_id na coluna fornecedores_favoritos_id do D1', async () => {
  const db = new FakeD1({ parentId: 'share-saida-1', directLaunch: true })
  const response = await financeiroRoutes.request('/lancamentos/share-saida-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fornecedor_id: 'fornecedor-1' }),
  }, { SHARE_DB: db })

  assert.equal(response.status, 200, await response.clone().text())
  const update = db.updates.find(({ sql }) => sql.includes('UPDATE lancamentos SET'))
  assert.ok(update)
  assert.match(update.sql, /fornecedores_favoritos_id = \?/)
  assert.doesNotMatch(update.sql, /(?:^|[, ])fornecedor_id = \?/)
  assert.equal(update.values[0], 'fornecedor-1')
  assert.equal(update.values.at(-1), 'share-saida-1')
})
