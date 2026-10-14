import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8");

test("movimentações financeiras preservam abastecimentos sem voo", () => {
  const inicio = source.indexOf("financeiroRoutes.get('/dashboard/financeiro/movimentacoes'");
  const fim = source.indexOf("financeiroRoutes.post('/lancamentos/despesa'", inicio);
  const route = source.slice(inicio, fim);

  assert.match(route, /const numeroVooInformado = String\(row\.numero_voo \|\| ''\)/);
  assert.match(route, /const vooKey = numeroVooInformado \? `voo:\$\{numeroVooInformado\}` : `sem-voo:\$\{periodo\}`/);
  assert.doesNotMatch(route, /if \(!numeroVoo\) continue/);
});

test("movimentações de abastecimento expõem descrição e fornecedor", () => {
  const inicio = source.indexOf("financeiroRoutes.get('/dashboard/financeiro/movimentacoes'");
  const fim = source.indexOf("financeiroRoutes.post('/lancamentos/despesa'", inicio);
  const route = source.slice(inicio, fim);
  assert.match(route, /COALESCE\(NULLIF\(TRIM\(a\.observacao\), ''\), 'Abastecimento'\) AS descricao/);
  assert.match(route, /f\.nome_fornecedor AS fornecedor_nome/);
});

test("movimentações expõem abastecimentos pré-voo que ainda precisam de dados fiscais", () => {
  const inicio = source.indexOf("financeiroRoutes.get('/dashboard/financeiro/movimentacoes'");
  const fim = source.indexOf("financeiroRoutes.post('/lancamentos/despesa'", inicio);
  const route = source.slice(inicio, fim);
  assert.match(route, /abastecimentosPendentes/);
  assert.match(route, /lower\(trim\(COALESCE\(a\.status, ''\)\)\) = 'gerado pré voo'/);
  assert.match(route, /a\.numero_nf/);
  assert.match(route, /a\.nota_url/);
  assert.match(route, /abastecimentos_pendentes: abastecimentosPendentes/);
  assert.match(route, /NULLIF\(trim\(COALESCE\(a\.numero_nf, ''\)\), ''\) IS NULL OR NULLIF\(trim\(COALESCE\(a\.nota_url, ''\)\), ''\) IS NULL/);
  assert.match(route, /c\.req\.query\('somente'\) === 'abastecimentos_pendentes'/);
  assert.match(route, /return c\.json\(\{ abastecimentos_pendentes: abastecimentosPendentes \}\)/);
});
