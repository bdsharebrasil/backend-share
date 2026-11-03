import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [agents, routes] = await Promise.all([
  readFile(new URL("../src/financeiro/paymentAgents.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/financeiro/enviosPagamentoRoutes.ts", import.meta.url), "utf8"),
]);
const detector = agents.slice(agents.indexOf("export async function findMatchingClientRateios"), agents.indexOf("export type PaymentRequest"));
const createRoute = routes.slice(routes.indexOf("enviosPagamentoRoutes.post('/envios-pagamento',"), routes.indexOf("enviosPagamentoRoutes.get('/envios-pagamento',"));

test("detecção de rateio duplicado compara os campos documentais exigidos nas duas tabelas", () => {
  assert.match(detector, /matchSql\('rateio_despesas'\)/);
  assert.match(detector, /matchSql\('rateio_hold'\)/);
  for (const column of ["data_vencimento", "categoria_nome", "valor_total_centavos", "numero_nf", "numero_recibo", "numero_boleto", "numero_demonstrativo", "numero_voo"]) {
    assert.match(detector, new RegExp(`\\b${column}\\b`));
  }
  assert.match(detector, /url_nf, url_recibo, url_boleto,\s*url_demonstrativo, url_doc/);
});

test("envio de cliente não é persistido sem a confirmação explícita quando existe duplicidade", () => {
  assert.match(createRoute, /input\.tipo === 'cliente' && body\.confirmar_duplicidade !== true/);
  assert.match(createRoute, /return c\.json\(\{ error: 'duplicidade_rateio', rateios \}, 409\)/);
  assert.ok(createRoute.indexOf("error: 'duplicidade_rateio'") < createRoute.indexOf("createPaymentRequest("));
});
