import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diarioBordoRoutes } from '../src/routes/diarioBordoRoutes.ts'

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

  first() {
    return this.db.first(this.sql, this.values)
  }

  all() {
    return this.db.all(this.sql, this.values)
  }

  run() {
    return this.db.run(this.sql, this.values)
  }
}

class FakeD1 {
  constructor() {
    this.flightLeg = { id: 'leg-1', lancamento_diario_id: null, jornada_id: 'journey-1', origem: 'SBSP', destino: 'SBRJ' }
    this.launches = new Map()
    this.month = {
      id: 'month-1', aeronave_id: 'aircraft-1', ano: 2026, mes: 10, fechado: 0,
      celula_anterior_ttotal: 100, celula_prox_revisao_ttotal: 500,
      celula_anterior_tvoo: 100, celula_prox_revisao_tvoo: 500,
    }
  }

  prepare(sql) {
    return new FakeStatement(this, sql)
  }

  async batch(statements) {
    const results = []
    for (const statement of statements) results.push(await statement.run())
    return results
  }

  async first(sql, values) {
    if (sql.includes('SELECT id, consumo_combustivel FROM aeronave')) return { id: 'aircraft-1', consumo_combustivel: 40 }
    if (sql.includes('SELECT id, aeronave_id, ano, mes, fechado, celula_atual_ttotal, celula_atual_tvoo FROM diario_mes')) {
      return { ...this.month, celula_atual_ttotal: 100, celula_atual_tvoo: 100 }
    }
    if (sql.includes('SELECT COALESCE(MAX(numero_sequencial), 0)')) {
      return { sequencial: Math.max(0, ...[...this.launches.values()].map((launch) => launch.numero_sequencial || 0)) }
    }
    if (sql.includes('SELECT p.id, p.lancamento_diario_id, p.jornada_id')) {
      return { ...this.flightLeg, aeronave_id: 'aircraft-1' }
    }
    if (sql.includes('SELECT l.*, dm.fechado, dm.ano AS diario_ano')) {
      const launch = this.launches.get(values[0])
      return launch ? { ...launch, fechado: 0, diario_ano: 2026, diario_mes: 10, perna_jornada_id: this.flightLeg.lancamento_diario_id === launch.id ? this.flightLeg.id : null } : null
    }
    if (sql.includes('SELECT l.diario_mes_id, dm.fechado')) {
      return this.launches.has(values[0]) ? { diario_mes_id: 'month-1', fechado: 0 } : null
    }
    if (sql.includes('FROM user_profiles')) return null
    if (sql.includes('FROM tripulacao_freelancer')) return null
    if (sql.includes('FROM tripulacao WHERE')) return null
    if (sql.includes('SELECT nome FROM aerodromo')) return { nome: values[0] }
    if (sql.includes('SELECT id, celula_anterior_ttotal')) return this.month
    if (sql.includes('SELECT COALESCE(SUM(tempo_total)')) {
      return {
        tempo_total: [...this.launches.values()].reduce((total, launch) => total + Number(launch.tempo_total || 0), 0),
        tempo_voo: [...this.launches.values()].reduce((total, launch) => total + Number(launch.tempo_voo || 0), 0),
      }
    }
    if (sql.includes('SELECT * FROM lancamentos_diario_bordo WHERE id')) return this.launches.get(values[0]) || null
    throw new Error(`Consulta first não simulada: ${sql}`)
  }

  async all(sql) {
    throw new Error(`Consulta all não simulada: ${sql}`)
  }

  async run(sql, values) {
    if (sql.startsWith('INSERT INTO lancamentos_diario_bordo')) {
      const match = sql.match(/INSERT INTO lancamentos_diario_bordo \((.*?)\) VALUES/)
      assert.ok(match, 'a inserção do lançamento deve usar lista explícita de colunas')
      const columns = match[1].split(',').map((column) => column.trim())
      const launch = Object.fromEntries(columns.map((column, index) => [column, values[index]]))
      this.launches.set(launch.id, launch)
      return { success: true, meta: { changes: 1 } }
    }
    if (sql.startsWith('UPDATE pernas_jornada_voo SET lancamento_diario_id = ?1')) {
      const [launchId, legId] = values
      if (this.flightLeg.id !== legId || this.flightLeg.lancamento_diario_id) return { success: true, meta: { changes: 0 } }
      this.flightLeg.lancamento_diario_id = launchId
      return { success: true, meta: { changes: 1 } }
    }
    if (sql.startsWith('UPDATE pernas_jornada_voo SET lancamento_diario_id = NULL')) {
      const [launchId] = values
      if (this.flightLeg.lancamento_diario_id !== launchId) return { success: true, meta: { changes: 0 } }
      this.flightLeg.lancamento_diario_id = null
      return { success: true, meta: { changes: 1 } }
    }
    if (sql.startsWith('UPDATE lancamentos_diario_bordo SET')) {
      const match = sql.match(/UPDATE lancamentos_diario_bordo SET (.*?) WHERE id = \?$/)
      assert.ok(match, 'a atualização do lançamento deve usar atribuições explícitas')
      const launchId = values[values.length - 1]
      const launch = this.launches.get(launchId)
      if (!launch) return { success: true, meta: { changes: 0 } }
      const fields = match[1].split(', ').map((assignment) => assignment.split(' = ')[0])
      fields.forEach((field, index) => { launch[field] = values[index] })
      return { success: true, meta: { changes: 1 } }
    }
    if (sql.startsWith('UPDATE diario_mes SET')) return { success: true, meta: { changes: 1 } }
    if (sql.startsWith('DELETE FROM abastecimentos')) return { success: true, meta: { changes: 0 } }
    if (sql.startsWith('DELETE FROM lancamentos_diario_bordo')) {
      const changes = this.launches.delete(values[0]) ? 1 : 0
      return { success: true, meta: { changes } }
    }
    throw new Error(`Consulta run não simulada: ${sql}`)
  }
}

async function enviarLancamento(db, body) {
  return diarioBordoRoutes.fetch(new Request('https://worker.test/api/interno/diario-bordo/lancamentos', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer diario-bordo-regression-token',
      apikey: 'sb_publishable_diario-test-key',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }), {
    SHARE_DB: db,
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_ANON_KEY: 'sb_publishable_diario-test-key',
  })
}

async function alterarLancamento(db, id, body) {
  return diarioBordoRoutes.fetch(new Request(`https://worker.test/api/interno/diario-bordo/lancamentos/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer diario-bordo-regression-token',
      apikey: 'sb_publishable_diario-test-key',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }), {
    SHARE_DB: db,
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_ANON_KEY: 'sb_publishable_diario-test-key',
  })
}

async function excluirLancamento(db, id) {
  return diarioBordoRoutes.fetch(new Request(`https://worker.test/api/interno/diario-bordo/lancamentos/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: 'Bearer diario-bordo-regression-token',
      apikey: 'sb_publishable_diario-test-key',
    },
  }), {
    SHARE_DB: db,
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_ANON_KEY: 'sb_publishable_diario-test-key',
  })
}

test('criação vincula a perna ao lançamento e impede incluí-la novamente', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ id: 'user-diario-test' })

  const db = new FakeD1()
  const payload = {
    aeronave_id: 'aircraft-1',
    diario_mes_id: 'month-1',
    data_registro: '2026-10-05',
    numero_voo: 'SB123',
    jornada_id: 'journey-1',
    perna_jornada_id: 'leg-1',
    natureza_voo: 'PV - Privado',
    aerodromo_partida: 'SBSP',
    aerodromo_chegada: 'SBRJ',
    pic_canac: '123456',
  }

  const created = await enviarLancamento(db, payload)
  assert.equal(created.status, 201)
  const inserted = await created.json()
  assert.ok(inserted.id)
  assert.equal(db.flightLeg.lancamento_diario_id, inserted.id)
  assert.equal(db.launches.size, 1)

  const duplicate = await enviarLancamento(db, payload)
  assert.equal(duplicate.status, 409)
  assert.deepEqual(await duplicate.json(), { error: 'perna_ja_lancada_no_diario' })
  assert.equal(db.launches.size, 1)
  assert.equal(db.flightLeg.lancamento_diario_id, inserted.id)

  const updated = await alterarLancamento(db, inserted.id, { ocorrencias: 'Correção validada', perna_jornada_id: 'leg-1', jornada_id: 'journey-1' })
  assert.equal(updated.status, 200)
  assert.equal((await updated.json()).ocorrencias, 'Correção validada')
  assert.equal(db.flightLeg.lancamento_diario_id, inserted.id)

  const deleted = await excluirLancamento(db, inserted.id)
  assert.equal(deleted.status, 200)
  assert.deepEqual(await deleted.json(), { success: true })
  assert.equal(db.launches.size, 0)
  assert.equal(db.flightLeg.lancamento_diario_id, null)

  const recreated = await enviarLancamento(db, payload)
  assert.equal(recreated.status, 201)
  assert.equal(db.launches.size, 1)
  assert.equal(db.flightLeg.lancamento_diario_id, (await recreated.json()).id)
})
