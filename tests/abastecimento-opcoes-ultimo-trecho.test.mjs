import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const routes = await readFile(new URL('../src/routes/abastecimentosRoutes.ts', import.meta.url), 'utf8');

test('opções de abastecimento retornam um lançamento real do diário da aeronave', () => {
  assert.match(routes, /const ultimoTrecho = aeronaveId[\s\S]*FROM lancamentos_diario_bordo l[\s\S]*WHERE l\.aeronave_id = \?1[\s\S]*ORDER BY date\(l\.data_registro\) DESC, l\.id DESC[\s\S]*LIMIT 1/);
  assert.match(routes, /ultimo_trecho: ultimoTrecho/);
});

test('a consulta de trechos não substitui os diários mensais usados pelo financeiro', () => {
  assert.match(routes, /FROM diario_mes WHERE \(\?1 IS NULL OR aeronave_id = \?1\)/);
  assert.match(routes, /diarios: diarios\.results/);
});

test('opções do Controle de Abastecimento incluem lançamentos de voo individuais para filtrar por mês', () => {
  assert.match(routes, /SELECT l\.id, l\.aeronave_id, l\.data_registro, l\.numero_voo, l\.trecho/);
  assert.match(routes, /FROM lancamentos_diario_bordo l[\s\S]*WHERE l\.aeronave_id = \?1[\s\S]*ORDER BY date\(l\.data_registro\) DESC/);
  assert.match(routes, /trechos_diario: trechosDiario\.results/);
});
