import test from 'node:test'
import assert from 'node:assert/strict'
import { carregarBalancoOperacional } from '../src/financeiro/balancoOperacional.ts'
import { loadSchema } from '../src/financeiro/FinanceiroKernel.ts'

const colunas = {
  lancamentos_diario_bordo: ['id', 'aeronave_id', 'data_registro', 'tempo_total', 'cliente_id', 'socio_id', 'numero_sequencial', 'trecho', 'tempo_dep', 'tempo_pou', 'tempo_voo', 'pousos_total', 'aerodromo_partida', 'aerodromo_chegada', 'voo_emprestado', 'natureza_voo'],
  abastecimentos: ['id', 'aeronave_id', 'data', 'litros'],
  relatorio_despesa_viagem: ['id', 'aeronave_id', 'data_inicio', 'total_valor'],
  cotista_aeronave: ['id', 'aeronave_id', 'cliente_id', 'socio_id', 'percentual_sociedade'],
}

test('balanço operacional carrega o resumo de voos com campos equivalentes ao modo Resumo do diário', async () => {
  const queries = []
  const db = {
    prepare(sql) {
      const query = { sql, params: [] }
      queries.push(query)
      return {
        bind(...params) { query.params = params; return this },
        async all() {
          return { results: sql.includes('FROM lancamentos_diario_bordo v') ? [{
            id: 'flight-1', data: '2026-10-09', numero_sequencial: 1, trecho: 'BOM FUTURO CUIABÁ X AERO JERUSALÉM',
            tempo_dep: '14:29:00', tempo_pou: '15:43:00', tempo_voo: 1.23, tempo_total: 1.23, pousos: 1,
            cliente_id: 'client-1', socio_id: null, natureza: 'VOO PARTICULAR', emprestado: 0,
          }] : [] }
        },
      }
    },
  }
  const result = await carregarBalancoOperacional(db, new Map(Object.entries(colunas).map(([table, cols]) => [table, new Set(cols)])), 'aircraft-1', '2026-10-01', '2026-10-31')
  assert.equal(result.fontes.voos, true)
  assert.deepEqual(result.voos, [{
    id: 'flight-1', data: '2026-10-09', numero: null, numeroSequencial: 1,
    trecho: 'BOM FUTURO CUIABÁ X AERO JERUSALÉM', tempoDep: '14:29:00', tempoPou: '15:43:00',
    clienteId: 'client-1', socioId: null, horas: 1.23, horasVoo: 1.23, pousos: 1,
    holdingId: null, tempoAc: null, tempoCor: null, distanciaNm: null, comandante: null, copiloto: null,
    minutosTotal: null, minutosVoo: 74,
    origem: null, destino: null, consumoEstimadoLitros: null, emprestado: false,
    clienteTomadorId: null, socioTomadorId: null, natureza: 'VOO PARTICULAR',
  }])
  const query = queries.find(({ sql }) => sql.includes('FROM lancamentos_diario_bordo v'))
  assert.match(query.sql, /v\.numero_sequencial/)
  assert.match(query.sql, /v\.trecho/)
  assert.match(query.sql, /v\.tempo_dep/)
  assert.match(query.sql, /v\.tempo_pou/)
  assert.deepEqual(query.params, ['aircraft-1', '2026-10-01', '2026-10-31', 500, 0])
  assert.ok(!query.sql.includes('FROM lancamentos l'), 'o resumo de voo não deve consultar lançamentos financeiros')
})

test('schema carregado pelo dashboard inclui os registros do diário de bordo', async () => {
  const voo = {
    id: 'flight-schema-1', data: '2026-09-10', numero_sequencial: 7,
    trecho: 'CUIABÁ X SINOP', tempo_dep: '09:15:00', tempo_pou: '10:05:00',
    tempo_voo: 0.83, tempo_total: 0.83, pousos: 1, cliente_id: 'client-1', socio_id: null,
  }
  const db = {
    prepare(sql) {
      const query = { sql, params: [] }
      return {
        bind(...params) { query.params = params; return this },
        async all() {
          const table = sql.match(/pragma_table_info\('([^']+)'\)/)?.[1]
          if (table) {
            const names = table === 'lancamentos_diario_bordo'
              ? colunas.lancamentos_diario_bordo
              : []
            return { results: names.map((name) => ({ name })) }
          }
          return { results: sql.includes('FROM lancamentos_diario_bordo v') ? [voo] : [] }
        },
      }
    },
  }

  const schema = await loadSchema(db)
  assert.equal(schema.get('lancamentos_diario_bordo')?.has('tempo_total'), true)

  const result = await carregarBalancoOperacional(db, schema, 'aircraft-1', '2026-09-01', '2026-09-30')
  assert.equal(result.fontes.voos, true)
  assert.equal(result.voos.length, 1)
  assert.equal(result.voos[0].trecho, 'CUIABÁ X SINOP')
})

