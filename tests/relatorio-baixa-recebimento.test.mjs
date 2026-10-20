import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [kernel, worker] = await Promise.all([
  readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/worker.ts", import.meta.url), "utf8"),
]);

const resolver = kernel.slice(
  kernel.indexOf("export async function resolveReceivableAllocations("),
  kernel.indexOf("export async function resolveReceivableAllocation(", kernel.indexOf("export async function resolveReceivableAllocations(")),
);
const settlement = kernel.slice(
  kernel.indexOf("export async function settleReceivable("),
  kernel.indexOf("export async function enqueueFinance(", kernel.indexOf("export async function settleReceivable(")),
);

test("recebível de relatório resolve os rateios vinculados e separa lançamentos Share e Cliente", () => {
  assert.match(resolver, /financeiro_vinculos/);
  assert.match(resolver, /:CUSTO_INTEGRAL/);
  assert.match(resolver, /:REEMBOLSO_CLIENTE:LANCAMENTO_CLIENTE/);
  assert.match(resolver, /:REEMBOLSO_CLIENTE:LANCAMENTO_SHARE/);
  assert.match(resolver, /shareLancamentoId/);
});

test("baixa usa o lançamento Share resolvido, liquida o Cliente e retorna os rateios conciliados", () => {
  assert.match(settlement, /const shareId = resolved\.shareLancamentoId/);
  assert.match(settlement, /const client = rateioLancamentoId && rateioLancamentoId !== shareId/);
  assert.match(settlement, /WHERE id IN \(\$\{rateios\.results\.map\(\(\) => '\?'\)\.join\(','\)\}\)/);
});

test("novo recebível do relatório referencia o lançamento do Caixa Share", () => {
  assert.match(worker, /lancamentos_id: shareLancamentoFinalId/);
});
