import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../src/financeiro/enviosPagamentoRoutes.ts", import.meta.url), "utf8");

test("despesas de origem exigem aeronave e origem, mas não número de voo", () => {
  assert.match(route, /if \(!aeronaveId \|\| !\['ABASTECIMENTO', 'RECIBOS', 'RELATORIOS DE VIAGEM'\]/);
  assert.match(route, /numeroVoo \? ' AND TRIM\(a\.numero_voo\) = \?' : ''/);
  assert.match(route, /numeroVoo \? ' AND TRIM\(r\.numero_voo\) = \?' : ''/);
});
