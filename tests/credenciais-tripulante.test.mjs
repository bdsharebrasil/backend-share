import test from 'node:test'
import assert from 'node:assert/strict'
import { resumirCredenciais, carregarCredenciaisTripulante } from '../src/lib/credenciaisTripulante.ts'

const registro = (id, tipo_habilitacao, validade_cma, data_validade = null) => ({
  id, tipo_habilitacao, validade_cma, data_validade, classe_cma: '1', fs_rh: null,
})
test('CMA renovado prevalece sobre registro vencido e sobre campo legado de habilitação', () => {
  const rows = [registro('old', 'CMA', '2025-06-30'), registro('new', 'CMA', '2027-06-30'),
    registro('ifr', 'IFRA', '2028-01-01', '2027-01-01'), registro('rh', 'FS/RH', null), registro('mlte', 'MLTE', null, '2026-12-01')]
  const result = resumirCredenciais(rows)
  assert.equal(result.cma.validade, '2027-06-30')
  assert.deepEqual(result.habilitacoes.map(r => r.tipo_habilitacao), ['IFRA', 'MLTE'])
  assert.equal(rows[0].id, 'old')
})
test('aceita CMA legado e ausência de cadastro sem inventar validade', () => {
  assert.equal(resumirCredenciais([registro('legado', 'MLTE', '2026-12-01')]).cma.validade, '2026-12-01')
  assert.equal(resumirCredenciais([]).cma, null)
  assert.equal(resumirCredenciais([registro('cma', 'CMA', null, '2027-01-01')]).cma.validade, '2027-01-01')
})
test('consulta somente habilitações do tripulante resolvido no servidor', async () => {
  const rows = [registro('a', 'IFRA', null, '2027-01-01')]
  const db = { prepare(sql) {
    assert.match(sql, /WHERE tripulacao_id = \?1/)
    return { bind(id) { assert.equal(id, 'trip-atual'); return { all: async () => ({ results: rows }) } } }
  } }
  assert.equal((await carregarCredenciaisTripulante(db, 'trip-atual')).habilitacoes.length, 1)
  assert.deepEqual(await carregarCredenciaisTripulante(db), { habilitacoes: [], cma: null })
})
