import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const dashboard = await readFile(new URL("../src/financeiro/dashboardShareRoutes.ts", import.meta.url), "utf8");
const dashboardCotista = await readFile(new URL("../src/financeiro/dashboardCotistaRoutes.ts", import.meta.url), "utf8");
const abastecimentosRoutes = await readFile(new URL("../src/routes/abastecimentosRoutes.ts", import.meta.url), "utf8");
const financeRoutes = await readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8");

test("dashboard financeiro projeta abastecimento pendente como movimentação", () => {
  assert.match(dashboard, /origem_tipo: 'abastecimentos'/);
  assert.match(dashboard, /NOT EXISTS \(SELECT 1 FROM lancamentos l WHERE l\.abastecimentos_id = a\.id/);
});

test("rateio do abastecimento materializa o lançamento financeiro oficial", () => {
  assert.match(financeRoutes, /origem\.origemTipo === 'abastecimentos'/);
  assert.match(financeRoutes, /abastecimentos_id: c\.req\.param\('origemId'\)/);
  assert.match(financeRoutes, /createExpense\(db/);
});

test("abastecimento rateado preserva o titular e não duplica o valor integral no extrato", () => {
  assert.match(abastecimentosRoutes, /rateio_entre_cotistas/);
  assert.match(dashboardCotista, /r\.percentual_uso = 100 AND r\.valor_rateado_centavos = r\.valor_total_centavos/);
  assert.match(dashboardCotista, /ab\.rateio_entre_cotistas = 1 AND titular\.id = r\.cotista_id/);
  assert.match(dashboardCotista, /lancamentoSemRateio/);
});
