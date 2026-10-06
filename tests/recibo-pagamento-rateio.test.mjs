import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [kernel, routes] = await Promise.all([
  readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/financeiro/recibosRoutes.ts", import.meta.url), "utf8"),
]);

test("recibo pago pela empresa materializa as linhas escolhidas no histórico", () => {
  assert.match(kernel, /function linhasRateioPagasPelaEmpresa\(linhas: Row\[\]\)/);
  assert.match(kernel, /const rateioLinhas = linhasRateioPagasPelaEmpresa\(linhasInformadas\)/);
  assert.match(kernel, /tipo_caixa: rateioLinhas\.length \? 'CLIENTE' : 'SHARE'/);
  assert.match(kernel, /rateio_linhas: rateioLinhas,[\s\S]{0,100}sem_rateio: !rateioLinhas\.length/);
  assert.match(kernel, /idempotency_key: `recibo-pagamento:\$\{receiptId\}`/);
});

test("criação do rateio consulta o lançamento retornado pela finalização", () => {
  assert.match(kernel, /result\?\.lancamento_cliente_id \?\? result\?\.lancamento_id \?\? receipt\.lancamento_id/);
  assert.match(kernel, /FROM rateio_despesas WHERE lancamento_id = \?1/);
  assert.match(kernel, /FROM rateio_despesas WHERE origem_tipo = 'RECIBO' AND origem_id = \?1/);
  assert.match(kernel, /SET escopo_financeiro = 'FINANCEIRO'[\s\S]{0,100}WHERE id = \?1 AND tipo_caixa = 'SHARE'/);
});

test("repetir a ação completa vínculos faltantes sem duplicar linhas já vinculadas", () => {
  assert.match(kernel, /SELECT rateio_id FROM recibo_rateio WHERE recibo_id = \?1/);
  assert.match(kernel, /vinculosPendentes = rateios\.filter\(\(rateio\) => !rateioIdsVinculados\.has/);
  assert.match(kernel, /createClientExpenseRateios\(db, rateioCommand, userId, \{ internal: true \}\)/);
});

test("recibo pago por cliente persiste envio como origem do rateio", () => {
  assert.match(kernel, /receipt\.pagador_tipo === 'cliente'/);
  assert.match(kernel, /INSERT INTO envio_despesas/);
  assert.match(kernel, /'RECIBO', \?\, 'ENVIO_DESPESA'/);
  assert.match(kernel, /lancamento_id: envioId/);
  assert.match(kernel, /UPDATE recibos SET lancamento_id = \? WHERE id = \? AND lancamento_id IS NULL/);
  assert.match(kernel, /'ENVIO_DESPESA', \?\, 'RATEIO_DESPESAS'/);
});

test("histórico reconhece rateio de recibo sem depender de um lançamento espelho", () => {
  assert.match(routes, /FROM rateio_despesas WHERE origem_tipo = 'RECIBO' AND origem_id IN/);
  assert.match(routes, /FROM recibo_rateio/);
});
