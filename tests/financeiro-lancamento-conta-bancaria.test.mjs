import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routes = await readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8");

test("listagem de lançamentos financeiros retorna o banco da conta vinculada", () => {
  assert.match(routes, /SELECT l\.\*, cb\.banco AS banco_pagamento_nome FROM lancamentos l LEFT JOIN contas_bancarias cb ON cb\.id = l\.conta_bancaria_id/);
  assert.match(routes, /l\.tipo_caixa = \?/);
  assert.match(routes, /COALESCE\(l\.data_emissao, l\.criado_em\)/);
});
