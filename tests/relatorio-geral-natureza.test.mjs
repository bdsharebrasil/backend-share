import test from 'node:test'
import assert from 'node:assert/strict'
import { classificarCusto, montarRelatorioGeral } from '../src/financeiro/relatorioGeralCotista.ts'

test('relatório geral classifica troca de pneu como variável preservando rateio FIXO', () => {
  const despesa = { data: '2026-08-26', categoria: 'MANUTENÇÃO', descricao: 'M.O TROCA PNEU', tipo_rateio: 'FIXO', valor_centavos: 141525 }
  assert.equal(classificarCusto(despesa), 'manut_hora')
  assert.equal(classificarCusto({ ...despesa, natureza_custo: 'EXTRA' }), 'extras')
  const r = montarRelatorioGeral([despesa], [{ mes: '2026-08', h_voo: 14 / 60, h_ttl: 25 / 60, pousos: 1, distancia_nm: 0, litros: 0, dias_voo: 1 }], 2026, 1)
  assert.equal(r.total.total, 141525)
  assert.equal(r.total.fixos, 0)
  assert.equal(r.total.extras, 0)
  assert.equal(r.total.nao_classificados, 0)
  assert.equal(r.total.variaveis, 141525)
  assert.equal(r.projecao[0].metodo, 'natureza_custo')
  assert.equal(r.projecao[0].custo_fixo, 0)
  assert.equal(despesa.tipo_rateio, 'FIXO')
})

test('relatório geral de agosto reconcilia os cinco custos confirmados sem misturar natureza e rateio', () => {
  const custos = [
    { data: '2026-08-03', categoria: 'ADM E TRIP SHARE', descricao: 'ADM E PILOT REF JULHO', tipo_rateio: 'FIXO', valor_centavos: 500000 },
    { data: '2026-08-01', categoria: 'TAXAS AEROPORTUÁRIAS', descricao: 'TARIFA DECEA MAIO', tipo_rateio: 'VARIAVEL POR VOO', valor_centavos: 7133 },
    { data: '2026-08-07', categoria: 'HANGARAREM', descricao: 'HANGARAGEM REF. JULHO', tipo_rateio: 'FIXO', valor_centavos: 350000 },
    { data: '2026-08-21', categoria: 'MANUTENÇÃO', descricao: 'PEÇAS MANUT. CORRETIVA', tipo_rateio: 'VARIAVEL POR HORA', valor_centavos: 561000 },
    { data: '2026-08-26', categoria: 'MANUTENÇÃO', descricao: 'M.O TROCA DOS PNEUS', tipo_rateio: 'FIXO', valor_centavos: 141525 },
  ];
  const r = montarRelatorioGeral(custos, [{ mes: '2026-08', h_voo: 14 / 60, h_ttl: 25 / 60, pousos: 1, distancia_nm: 0, litros: 0, dias_voo: 1 }], 2026, 1);
  assert.equal(r.total.fixos, 850000);
  assert.equal(r.total.variaveis, 709658);
  assert.equal(r.total.extras, 0);
  assert.equal(r.total.nao_classificados, 0);
  assert.equal(r.total.total, 1559658);
  assert.equal(r.projecao[0].metodo, 'natureza_custo');
  assert.equal(custos[4].tipo_rateio, 'FIXO');
});
