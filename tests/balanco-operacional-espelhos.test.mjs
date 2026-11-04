import test from 'node:test'
import assert from 'node:assert/strict'
import { carregarBalancoOperacional } from '../src/financeiro/balancoOperacional.ts'

const colunas = {
  lancamentos: ['id', 'aeronave_id', 'abastecimentos_id', 'valor_centavos', 'descricao', 'fluxo', 'status', 'data_emissao', 'categoria_nome', 'cotista_aeronave_id', 'numero_doc', 'numero_nf', 'numero_recibo'],
  abastecimentos: ['id', 'aeronave_id', 'data', 'litros', 'lancamento_diario_id', 'cliente_id', 'socio_id'],
  lancamentos_diario_bordo: ['id', 'aeronave_id', 'data_registro', 'tempo_total', 'cliente_id', 'socio_id', 'numero_voo'],
  cotista_aeronave: ['id', 'aeronave_id', 'cliente_id', 'socio_id', 'percentual_sociedade'],
  relatorio_despesa_viagem: ['id', 'aeronave_id', 'data_inicio', 'total_valor'],
}

test('balanço operacional retorna espelhos associados ao diário e respeita aeronave/período', async () => {
  const queries = []
  const db = {
    prepare(sql) {
      const query = { sql, params: [] }
      queries.push(query)
      return {
        bind(...params) { query.params = params; return this },
        async all() {
          return { results: sql.includes('FROM lancamentos l') ? [{
            id: 'launch-1', voo_id: 'flight-1', numero_voo: 'SB123', data: '2026-10-18',
            numero_doc: 'DOC-9', numero_nf: null, numero_recibo: null, descricao: 'Combustível',
            categoria: 'Combustível', valor_centavos: 125000, fluxo: 'SAIDA', status: 'PAGO',
            cotista_aeronave_id: 'owner-1', cotista_nome: 'Cotista A',
          }] : [] }
        },
      }
    },
  }
  const result = await carregarBalancoOperacional(db, new Map(Object.entries(colunas).map(([t, cols]) => [t, new Set(cols)])), 'aircraft-1', '2026-10-01', '2026-10-31')
  assert.equal(result.fontes.espelhos, true)
  assert.deepEqual(result.espelhos, [{
    id: 'launch-1', vooId: 'flight-1', numeroVoo: 'SB123', data: '2026-10-18', documento: 'DOC-9',
    descricao: 'Combustível', categoria: 'Combustível', valorCentavos: 125000, fluxo: 'SAIDA',
    status: 'PAGO', cotistaId: 'owner-1', cotistaNome: 'Cotista A',
  }])
  const query = queries.find(({ sql }) => sql.includes('FROM lancamentos l'))
  assert.match(query.sql, /JOIN abastecimentos a ON a\.id = l\.abastecimentos_id/)
  assert.match(query.sql, /JOIN lancamentos_diario_bordo d ON d\.id = a\.lancamento_diario_id/)
  assert.deepEqual(query.params, ['aircraft-1', '2026-10-01', '2026-10-31', 500, 0])
})
