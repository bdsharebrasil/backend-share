import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateReceiptCommand } from "../src/financeiro/reciboAgents.ts";

const [kernel, routes] = await Promise.all([
  readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/financeiro/recibosRoutes.ts", import.meta.url), "utf8"),
]);

test("recibo de reembolso preserva o identificador do abastecimento selecionado", () => {
  const input = validateReceiptCommand({
    tipo_recibo: "recibo_reembolso",
    pagador_tipo: "cotista_aeronave",
    pagador_id: "cotista-1",
    valor_centavos: 350300,
    categoria_movimentacao_id: "categoria-1",
    descricao: "Reembolso de abastecimento",
    data_emissao: "2026-09-14",
    abastecimentos_id: "abastecimento-1",
  });

  assert.equal(input.abastecimentos_id, "abastecimento-1");
});

test("reembolso cria vínculos financeiros e grava o FK no lançamento do cotista", () => {
  assert.match(kernel, /tipo_vinculo = 'RECIBO_ABASTECIMENTO'/);
  assert.match(kernel, /abastecimentos_id:\s*abastecimentosId/);
  assert.match(kernel, /'LANCAMENTO_ABASTECIMENTO'/);
  assert.match(kernel, /abastecimento_ja_vinculado/);
});

test("opções omitem abastecimentos já usados por recibo ou caixa cotista", () => {
  assert.match(routes, /fv\.tipo_vinculo = 'RECIBO_ABASTECIMENTO'/);
  assert.match(routes, /l\.abastecimentos_id = a\.id/);
  assert.match(routes, /l\.tipo_caixa = 'CLIENTE'/);
});
