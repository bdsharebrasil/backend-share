import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const kernel = await readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8");
const issueRevenue = kernel.slice(
  kernel.indexOf("export async function issueRevenue("),
  kernel.indexOf("export async function", kernel.indexOf("export async function issueRevenue(") + 1),
);

test("emissão de recibo e lançamentos usam somente o valor em centavos do D1", () => {
  assert.notEqual(issueRevenue, "", "o caminho issueRevenue deve existir");
  assert.match(issueRevenue, /valor_centavos: amount/);
  assert.doesNotMatch(issueRevenue, /natureza:\s*'(?:(?:DESPESA)|(?:RECEITA)|(?:REEMBOLSO))'/);
  assert.doesNotMatch(issueRevenue, /valor_total:\s*amount\s*\/\s*100/);
  assert.doesNotMatch(issueRevenue, /valor:\s*amount\s*\/\s*100/);
});

test("rateio de recibo de saída usa colunas D1 e vínculo por lancamento_id", () => {
  const inicioRateio = issueRevenue.indexOf("'rateio_despesas'");
  const fimRateio = issueRevenue.indexOf("if (!reciboSaida)", inicioRateio);
  const insertRateio = issueRevenue.slice(inicioRateio, fimRateio);

  assert.notEqual(inicioRateio, -1, "o caminho de inserção do rateio deve existir");
  assert.match(insertRateio, /lancamento_id:\s*clientLancamentoId/);
  assert.match(insertRateio, /valor_total_centavos:\s*amount/);
  assert.match(insertRateio, /valor_rateado_centavos:\s*amount/);
  assert.doesNotMatch(insertRateio, /\bvalor_rateado\s*:/);
  assert.doesNotMatch(insertRateio, /\borigem_id\s*:/);
});
