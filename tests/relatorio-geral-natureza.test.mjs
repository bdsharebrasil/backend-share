import test from 'node:test'
import assert from 'node:assert/strict'
import { classificarCusto, montarRelatorioGeral } from '../src/financeiro/relatorioGeralCotista.ts'

test('relatório geral não confunde rateio fixo com custo fixo nem sugere alteração para EXTRA', () => {
  const despesa = { data: '2026-08-26', categoria: 'MANUTENÇÃO', descricao: 'M.O TROCA PNEU', tipo_rateio: 'FIXO', valor_centavos: 141525 }
  assert.equal(classificarCusto(despesa), 'nao_classificados')
  assert.equal(classificarCusto({ ...despesa, natureza_custo: 'EXTRA' }), 'extras')
  const r = montarRelatorioGeral([despesa], [{ mes: '2026-08', h_voo: 14 / 60, h_ttl: 25 / 60, pousos: 1, distancia_nm: 0, litros: 0, dias_voo: 1 }], 2026, 1)
  assert.equal(r.total.total, 141525)
  assert.equal(r.total.fixos, 0)
  assert.equal(r.total.extras, 0)
  assert.equal(r.total.nao_classificados, 141525)
  assert.equal(r.projecao[0].metodo, 'media_historica')
  assert.equal(r.projecao[0].custo_fixo, null)
  assert.equal(despesa.tipo_rateio, 'FIXO')
})
