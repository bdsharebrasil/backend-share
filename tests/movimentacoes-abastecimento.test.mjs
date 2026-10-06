import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8");

test("movimentações financeiras preservam abastecimentos sem voo", () => {
  const inicio = source.indexOf("financeiroRoutes.get('/dashboard/financeiro/movimentacoes'");
  const fim = source.indexOf("financeiroRoutes.post('/lancamentos/despesa'", inicio);
  const route = source.slice(inicio, fim);

  assert.match(route, /String\(row\.numero_voo \|\| 'Sem número de voo'\)/);
  assert.doesNotMatch(route, /if \(!numeroVoo\) continue/);
});
