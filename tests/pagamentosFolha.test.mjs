import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Hono } from 'hono'
import { idDeterministicoPagamentoFolha, parcelaDecimoTerceiro, validarRegistroPagamentoFolha } from '../src/financeiro/pagamentosFolha.ts'
import { pagamentosFolhaRoutes } from '../src/financeiro/pagamentosFolhaRoutes.ts'

const payloadValido = (itens = [{ rotulo: 'SALARIO', tipo_pagamento: 'SALARIO', valor_centavos: 123456 }]) => ({
  user_id: 'employee', ano: 2026, mes: 10, data_pagamento: '2026-10-30', conta_pagamento_id: null,
  observacoes: null, comprovante_url: null, holerite_url: null, itens,
  idempotency_key: 'folha:employee:2026-10:salario-123456',
})

test('valida rótulos, tipos e valores inteiros positivos em centavos', () => {
  const itens = [
    ['SALARIO', 'SALARIO'], ['FERIAS', 'FERIAS'], ['13_P1', 'DECIMO_TERCEIRO'],
    ['13_P2', 'DECIMO_TERCEIRO'], ['BENEFICIO', 'OUTRO'], ['HORAS_VOO', 'OUTRO'], ['EXTRA', 'OUTRO'],
  ].map(([rotulo, tipo_pagamento], index) => ({ rotulo, tipo_pagamento, valor_centavos: (index + 1) * 100 }))
  const resultado = validarRegistroPagamentoFolha(payloadValido(itens))
  assert.ok('valor' in resultado)
  assert.deepEqual(resultado.valor.itens, itens)
  assert.equal(validarRegistroPagamentoFolha(payloadValido([{ rotulo: 'SALARIO', tipo_pagamento: 'OUTRO', valor_centavos: 100 }])).erro, 'tipo_pagamento_incompativel_com_rotulo')
  assert.equal(validarRegistroPagamentoFolha(payloadValido([{ rotulo: 'BENEFICIO', tipo_pagamento: 'OUTRO', valor_centavos: 100.5 }])).erro, 'valor_centavos_invalido')
  assert.equal(validarRegistroPagamentoFolha(payloadValido([{ rotulo: 'BENEFICIO', tipo_pagamento: 'OUTRO', valor_centavos: 0 }])).erro, 'valor_centavos_invalido')
  assert.equal(validarRegistroPagamentoFolha(payloadValido([{ rotulo: 'EXTRA', tipo_pagamento: 'OUTRO', valor_centavos: 100 }, { rotulo: 'EXTRA', tipo_pagamento: 'OUTRO', valor_centavos: 200 }])).erro, 'rotulo_pagamento_duplicado')
  assert.equal(validarRegistroPagamentoFolha({ ...payloadValido(), mes: 13 }).erro, 'mes_invalido')
  assert.equal(validarRegistroPagamentoFolha({ ...payloadValido(), data_pagamento: '2026-02-30' }).erro, 'data_pagamento_invalida')
})

test('mapeia parcela 13º e usa id determinístico estável para retry', async () => {
  assert.equal(parcelaDecimoTerceiro('13_P1'), 'PRIMEIRA')
  assert.equal(parcelaDecimoTerceiro('13_P2'), 'SEGUNDA')
  assert.equal(parcelaDecimoTerceiro('SALARIO'), null)
  const id1 = await idDeterministicoPagamentoFolha('company|employee|2026|10|SALARIO')
  const id2 = await idDeterministicoPagamentoFolha('company|employee|2026|10|SALARIO')
  const id3 = await idDeterministicoPagamentoFolha('company|employee|2026|10|FERIAS')
  assert.match(id1, /^[a-f0-9]{32}$/)
  assert.equal(id1, id2)
  assert.notEqual(id1, id3)
})

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = [] }
  bind(...params) { this.params = params; return this }
  async first() { this.db.reads.push(this.sql); return this.db.resolve(this.sql, 'first') }
  async all() { this.db.reads.push(this.sql); return { results: this.db.resolve(this.sql, 'all') || [] } }
  async run() { this.db.reads.push(this.sql); return { success: true, meta: { changes: 1 } } }
}
class FakeDatabase {
  constructor() { this.paid = false; this.current = []; this.saved = []; this.reads = []; this.batches = [] }
  prepare(sql) { return new FakeStatement(this, sql) }
  resolve(sql) {
    if (sql.includes('FROM user_profiles p') && sql.includes('usuarios_funcoes')) return { allowed: 1 }
    if (sql.includes('SELECT id, nome_completo, nome_exibicao, status FROM user_profiles')) return { id: 'employee', nome_completo: 'Pessoa Teste', nome_exibicao: 'Pessoa Teste', status: 'ativo' }
    if (sql.includes('FROM contratos_trabalho WHERE user_id = ?')) return []
    if (sql.includes('SELECT id FROM empresa ORDER BY id LIMIT 2')) return [{ id: 'company' }]
    if (sql.includes('SELECT p.id, p.rotulo, p.status, l.status AS lancamento_status')) return this.paid ? [{ id: 'paid-payment', rotulo: 'SALARIO', status: 'PAGO', lancamento_status: 'PAGO' }] : this.current
    if (sql.includes('SELECT p.*, l.id AS lancamento_rh_id')) return this.saved
    return []
  }
  async batch(statements) { this.batches.push([...statements]); return statements.map(() => ({ success: true })) }
}

async function withApiAuth(t, run) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => String(url).includes('/auth/v1/user') ? Response.json({ id: 'actor' }) : originalFetch(url)
  t.after(() => { globalThis.fetch = originalFetch })
  const app = new Hono()
  app.use('*', async (c, next) => { c.set('userId', 'actor'); await next() })
  app.route('/api/financeiro', pagamentosFolhaRoutes)
  const db = new FakeDatabase()
  const env = { SHARE_DB: db, SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'public-key' }
  return run(app, db, env)
}

test('POST grava itens, RH e 13º em uma única batch e retorna as linhas lidas após gravação', async (t) => {
  await withApiAuth(t, async (app, db, env) => {
    db.saved = [{ id: 'payment-1', rotulo: 'SALARIO', valor_centavos: 300000 }]
    const itens = [
      { rotulo: 'SALARIO', tipo_pagamento: 'SALARIO', valor_centavos: 300000 },
      { rotulo: 'FERIAS', tipo_pagamento: 'FERIAS', valor_centavos: 50000 },
      { rotulo: '13_P1', tipo_pagamento: 'DECIMO_TERCEIRO', valor_centavos: 150000 },
      { rotulo: '13_P2', tipo_pagamento: 'DECIMO_TERCEIRO', valor_centavos: 150000 },
      { rotulo: 'BENEFICIO', tipo_pagamento: 'OUTRO', valor_centavos: 25000 },
      { rotulo: 'HORAS_VOO', tipo_pagamento: 'OUTRO', valor_centavos: 7000 },
      { rotulo: 'EXTRA', tipo_pagamento: 'OUTRO', valor_centavos: 10000 },
    ]
    const response = await app.request('/api/financeiro/pagamentos-folha', {
      method: 'POST', headers: { Authorization: 'Bearer valid-session', apikey: 'public-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadValido(itens)),
    }, env)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, pagamentos: db.saved })
    assert.equal(db.batches.length, 1)
    const statements = db.batches[0]
    assert.equal(statements.filter((s) => s.sql.includes('INSERT INTO pagamentos_folha')).length, 7)
    assert.equal(statements.filter((s) => s.sql.includes('INSERT INTO lancamentos_financeiros_rh')).length, 7)
    assert.equal(statements.filter((s) => s.sql.includes('INSERT INTO decimo_terceiro')).length, 2)
    assert.ok(statements.every((s) => /ON CONFLICT/.test(s.sql)))
    assert.ok(statements.some((s) => s.params.includes('folha:employee:2026-10:salario-123456:company:13_P1')))
  })
})

test('POST bloqueia alteração se já existir linha paga', async (t) => {
  await withApiAuth(t, async (app, db, env) => {
    db.paid = true
    const response = await app.request('/api/financeiro/pagamentos-folha', {
      method: 'POST', headers: { Authorization: 'Bearer valid-session', apikey: 'public-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadValido()),
    }, env)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error, 'pagamento_ja_pago_nao_pode_ser_alterado')
    assert.equal(db.batches.length, 0)
  })
})

test('DELETE cancela RH e remove a linha dentro de uma batch', async (t) => {
  await withApiAuth(t, async (app, db, env) => {
    db.current = [{ id: 'payment-1', rotulo: 'SALARIO', status: 'PENDENTE', lancamento_status: 'AGUARDANDO_APROVACAO' }]
    const response = await app.request('/api/financeiro/pagamentos-folha?user_id=employee&ano=2026&mes=10', {
      method: 'DELETE', headers: { Authorization: 'Bearer valid-session', apikey: 'public-key' },
    }, env)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(db.batches.length, 1)
    assert.ok(db.batches[0].some((s) => s.sql.includes("SET status = 'CANCELADO'") && s.params.includes('payment-1')))
    assert.ok(db.batches[0].some((s) => s.sql.startsWith('DELETE FROM pagamentos_folha') && s.params.includes('payment-1')))
  })
})

test('DELETE recusa pagamento pago sem executar batch', async (t) => {
  await withApiAuth(t, async (app, db, env) => {
    db.paid = true
    const response = await app.request('/api/financeiro/pagamentos-folha?user_id=employee&ano=2026&mes=10', {
      method: 'DELETE', headers: { Authorization: 'Bearer valid-session', apikey: 'public-key' },
    }, env)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error, 'pagamento_ja_pago_nao_pode_ser_excluido')
    assert.equal(db.batches.length, 0)
  })
})

test('rejeita requisição sem bearer token', async (t) => {
  await withApiAuth(t, async (app, db, env) => {
    const response = await app.request('/api/financeiro/pagamentos-folha?ano=2026&mes=10', {}, env)
    assert.equal(response.status, 401)
    assert.equal(db.batches.length, 0)
  })
})

test('migração e schema-base mantêm os rótulos e índices únicos', async () => {
  const migration = await readFile(new URL('../migrations/20261005_pagamentos_folha.sql', import.meta.url), 'utf8')
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8')
  for (const rotulo of ['SALARIO', 'FERIAS', '13_P1', '13_P2', 'BENEFICIO', 'HORAS_VOO', 'EXTRA']) {
    assert.ok(migration.includes(rotulo))
    assert.ok(schema.includes(rotulo))
  }
  assert.match(migration, /uq_pagamentos_folha_competencia_rotulo/)
  assert.match(migration, /uq_pagamentos_folha_idempotency/)
  assert.match(migration, /uq_lancamentos_financeiros_rh_idempotency/)
  assert.match(schema, /idempotency_key/)
})

test('anexo R2 retorna caminho privado da API e só é servido após autenticação', async (t) => {
  await withApiAuth(t, async (app, db, env) => {
    const arquivos = new Map()
    env.SHARE_FILES = {
      async put(key, value, options) { arquivos.set(key, { value, options }) },
      async get(key) {
        const salvo = arquivos.get(key)
        if (!salvo) return null
        return { body: new Response(salvo.value).body, httpMetadata: salvo.options.httpMetadata }
      },
    }
    const form = new FormData()
    form.append('arquivo', new Blob(['%PDF-1.7\nfolha'], { type: 'application/pdf' }), 'holerite.pdf')
    form.append('tipo', 'holerite')
    form.append('user_id', 'employee')
    form.append('ano', '2026')
    form.append('mes', '10')
    const upload = await app.request('/api/financeiro/pagamentos-folha/anexos', {
      method: 'POST', headers: { Authorization: 'Bearer valid-session', apikey: 'public-key' }, body: form,
    }, env)
    assert.equal(upload.status, 201)
    const { url } = await upload.json()
    assert.match(url, /^\/api\/financeiro\/pagamentos-folha\/anexos\?key=/)
    assert.equal(arquivos.size, 1)
    const download = await app.request(url, { headers: { Authorization: 'Bearer valid-session', apikey: 'public-key' } }, env)
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('Cache-Control'), 'private, no-store')
    assert.equal(download.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(await download.text(), '%PDF-1.7\nfolha')
    assert.equal(db.batches.length, 0)
  })
})
