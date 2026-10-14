import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [kernel, recibosSaidaRoutes] = await Promise.all([
  readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/financeiro/recibosSaidaRoutes.ts", import.meta.url), "utf8"),
]);
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

test("lancamento de receita valida cliente_id na tabela singular do D1", () => {
  assert.match(issueRevenue, /SELECT id FROM cliente WHERE id = \? LIMIT 1/);
  assert.doesNotMatch(issueRevenue, /FROM clientes\b/);
  assert.match(issueRevenue, /cliente_id: clienteLancamento\?\.id \?\? null/);
  assert.doesNotMatch(issueRevenue, /cliente_id: context\?\.clienteId/);
});

test("recibo de saída valida cotista, aeronave e categoria do rateio antes de alocar número", () => {
  const rota = recibosSaidaRoutes.slice(
    recibosSaidaRoutes.indexOf("recibosSaidaRoutes.post('/recibos-saida'"),
    recibosSaidaRoutes.indexOf("recibosSaidaRoutes.patch('/recibos-saida/:id'"),
  );
  assert.match(rota, /FROM cotista_aeronave WHERE id = \? AND COALESCE\(status, 'ativo'\) <> 'inativo'/);
  assert.match(rota, /FROM aeronave WHERE id = \?/);
  assert.match(rota, /FROM categoria_movimentacao_cliente WHERE id = \?/);
  assert.ok(rota.indexOf('categoria_despesa_invalida') < rota.indexOf('alocarNumeroReciboSaida'));
});

test("salvar o PDF atualiza rateio_despesas.url_recibo conforme o schema D1", () => {
  assert.match(recibosSaidaRoutes, /UPDATE rateio_despesas SET numero_recibo = \?, url_recibo = \? WHERE lancamento_id = \?/);
  assert.doesNotMatch(recibosSaidaRoutes, /\brecibo_url\b/);
  assert.doesNotMatch(recibosSaidaRoutes, /UPDATE rateio_despesas[^\n]*\.catch\(\(\) => undefined\)/);
});
