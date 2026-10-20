import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [kernel, routes] = await Promise.all([
  readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8"),
]);

const settleReceivable = kernel.slice(
  kernel.indexOf("export async function settleReceivable("),
  kernel.indexOf("export async function enqueueFinance(", kernel.indexOf("export async function settleReceivable(")),
);
const baixaLancamento = routes.slice(
  routes.indexOf("financeiroRoutes.post('/lancamentos/:id/baixa'"),
  routes.indexOf("financeiroRoutes.post('/lancamentos/:id/duplicar'", routes.indexOf("financeiroRoutes.post('/lancamentos/:id/baixa'")),
);

test("baixa conciliada identifica receita do caixa Share e marca os rateios como pagos diretamente", () => {
  assert.match(settleReceivable, /const isShareRevenue = upper\(shareLancamento\?\.tipo_caixa\) === 'SHARE'\s*&& \['ENTRADA', 'RECEITA'\]\.includes\(upper\(shareLancamento\?\.fluxo\)\)/);
  assert.match(settleReceivable, /isShareRevenue && rateioColumns\?\.has\('pago_diretamente'\) \? \{ pago_diretamente: 1 \} : \{\}/);
  assert.match(settleReceivable, /isShareRevenue \? \{ pago_diretamente: 1 \} : \{\}/);
});

test("baixa simples marca pago_diretamente apenas para lançamento de receita no caixa Share", () => {
  assert.match(baixaLancamento, /SELECT tipo_caixa, origem_tipo, reembolsavel, fluxo FROM lancamentos WHERE id = \?/);
  assert.match(baixaLancamento, /String\(principal\?\.tipo_caixa\)\.toUpperCase\(\) === 'SHARE'[\s\S]*?\['ENTRADA', 'RECEITA'\]\.includes\(String\(principal\?\.fluxo\)\.toUpperCase\(\)\)[\s\S]*?sets\.push\('pago_diretamente = 1'\)/);
});
