import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [kernel, notas, emails] = await Promise.all([
  readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/financeiro/notasSaidaRoutes.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/routes/emailsRoutes.ts", import.meta.url), "utf8"),
]);
const issueRevenue = kernel.slice(
  kernel.indexOf("export async function issueRevenue("),
  kernel.indexOf("export async function", kernel.indexOf("export async function issueRevenue(") + 1),
);
const settleReceivable = kernel.slice(
  kernel.indexOf("export async function settleReceivable("),
  kernel.indexOf("export async function", kernel.indexOf("export async function settleReceivable(") + 1),
);

test("NF de saída persiste número, URL e fornecedor no lançamento Share e usa fluxo RECEITA", () => {
  assert.match(notas, /numero_nf: numero/);
  assert.match(notas, /url_nf: dadosNota\.arquivoPdfUrl/);
  assert.match(issueRevenue, /fornecedor_nome: notaFiscalSaida \? 'SHARE BRASIL'/);
  assert.match(issueRevenue, /fluxo: notaFiscalSaida \? 'RECEITA' : 'ENTRADA'/);
  assert.match(issueRevenue, /escopo_financeiro: notaFiscalSaida \? 'FINANCEIRO' : escopo/);
  assert.match(issueRevenue, /numero_nf: nullableText\(command\.numero_nf\)/);
  assert.match(issueRevenue, /url_nf: nullableText\(command\.url_nf\)/);
});

test("espelho e rateio de despesa da NF ficam EM_ABERTO com percentual societário do cotista", () => {
  assert.match(issueRevenue, /percentual_sociedade: notaFiscalSaida \? \(context\?\.percentualSociedade \?\? 100\) : 100/);
  assert.match(issueRevenue, /status: notaFiscalSaida \? 'EM_ABERTO'/);
  assert.match(issueRevenue, /email_enviado_em: null/);
});

test("nota de cotista Holding cria movimento e rateio vinculados à NF e à conta a receber", () => {
  assert.match(issueRevenue, /movimentos_id: movimentoHoldingId/);
  assert.match(issueRevenue, /insertStatement\(db, schema, 'movimentos_holding'/);
  assert.match(issueRevenue, /holdingAllocationStatements\(db, schema/);
  assert.match(issueRevenue, /origem_tipo: 'NF_SAIDA'/);
  assert.match(issueRevenue, /linkStatement\(db, schema, 'NF_SAIDA'/);
});

test("baixa da conta a receber atualiza rateio_hold e movimento Holding", () => {
  assert.match(settleReceivable, /FROM rateio_hold WHERE \$\{holdingMovementColumn\(schema\)\}/);
  assert.match(settleReceivable, /const rateioTable = movimentoHoldingId \? 'rateio_hold' : 'rateio_despesas'/);
  assert.match(settleReceivable, /updateStatement\(db, schema, rateioTable/);
  assert.match(settleReceivable, /updateStatement\(db, schema, 'movimentos_holding'/);
  assert.match(settleReceivable, /status: allPaid \? 'PAGO' : 'EM_ABERTO'/);
  assert.match(settleReceivable, /origem_id = \?\) AND tipo_caixa = 'CLIENTE'/);
});

test("baixa de NF/recibo encontra rateio CLIENTE e grava pagamento direto", () => {
  assert.match(settleReceivable, /const documentoSaida = \['NF_SAIDA', 'RECIBO_SAIDA'\]/);
  assert.match(settleReceivable, /SELECT id FROM lancamentos WHERE origem_id = \? AND tipo_caixa = 'CLIENTE'/);
  assert.match(settleReceivable, /nullableText\(lancamentoClienteSaida\?\.id\) \?\? shareId/);
  assert.match(settleReceivable, /pago_diretamente: 1/);
  assert.match(settleReceivable, /url_doc: nullableText\(lastPayment\.comprovante_url/);
  assert.match(settleReceivable, /status: 'PAGO'/);
  assert.match(settleReceivable, /status: 'PAGO',\s*data_pagamento: lastDate/);
});

test("e-mail da NF atualiza os espelhos, rateio Holding e exclusão remove seus vínculos", () => {
  assert.match(emails, /SELECT id FROM lancamentos WHERE origem_id = \?1 AND tipo_caixa = 'CLIENTE'/);
  assert.match(emails, /UPDATE rateio_hold SET email_enviado_em/);
  assert.match(notas, /hs\.holding_id, COALESCE\(cl\.razao_social/);
  assert.match(notas, /COALESCE\(cl\.email_principal, hs\.email_principal\) AS cliente_email/);
  assert.match(notas, /DELETE FROM rateio_hold WHERE \$\{holdingColumn\}/);
  assert.match(notas, /DELETE FROM movimentos_holding WHERE id = \?/);
  assert.match(notas, /DELETE FROM rateio_pagamentos WHERE rateio_id IN/);
});

test("listagem da NF expõe valor_total e recupera e-mail enviado do lançamento ou histórico", () => {
  assert.match(notas, /n\.valor_total, COALESCE\(NULLIF\(l\.email_enviado_em, ''\)/);
  assert.match(notas, /MAX\(ee\.email_enviado_em\).*ee\.referencia_id = n\.id.*lower\(ee\.status\) = 'enviado'/);
  assert.match(notas, /LEFT JOIN lancamentos l ON l\.id = n\.lancamentos_id/);
});

test("listagem de NF e recibo usa o status atual da conta a receber", () => {
  assert.match(notas, /COALESCE\(cr\.status, n\.status\) AS status/);
  assert.match(notas, /COALESCE\(cr\.status, r\.status\) AS status/);
  assert.match(notas, /LEFT JOIN contas_areceber cr ON cr\.id = r\.contas_areceber_id/);
});
