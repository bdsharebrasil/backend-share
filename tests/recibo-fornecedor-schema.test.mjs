import test from "node:test";
import assert from "node:assert/strict";
import { createReceiptRecord } from "../src/financeiro/reciboAgents.ts";
import { readFile } from "node:fs/promises";

test("criação do recibo grava número do documento e subcategorias válidas sem fornecedor", async () => {
  let captured;
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          captured = { sql, values };
          return { run: async () => ({ success: true }) };
        },
      };
    },
  };

  await createReceiptRecord(db, {
    tipo_recibo: "recibo_reembolso",
    pagador_tipo: "cotista_aeronave",
    pagador_id: "cotista-1",
    valor_centavos: 12500,
    categoria_movimentacao_id: "categoria-1",
    descricao: "Despesa de teste",
    data_emissao: "2026-11-05",
    fornecedor_id: "fornecedor-1",
    fornecedor_nome: "Fornecedor",
    numero_documento_anexo: "NF-12345",
    subcategoria_3: "Taxa de navegação",
  }, "recibo-1", "REC-001/26", "user-1");

  const columns = captured.sql.match(/INSERT INTO recibos \(([\s\S]*?)\) VALUES/)[1]
    .split(",").map((column) => column.trim());
  const valueForColumn = (column) => {
    const index = columns.indexOf(column);
    return captured.values[index - (index > columns.indexOf("status") ? 1 : 0)];
  };
  assert.equal(captured.sql.match(/\?/g).length, captured.values.length);
  assert.equal(columns.includes("fornecedor_id"), false);
  assert.equal(columns.includes("fornecedor_nome"), false);
  assert.equal(valueForColumn("numero_documento_anexo"), "NF-12345");
  for (const column of ["subcategoria_1", "subcategoria_2", "subcategoria_3", "subcategoria_4"]) {
    assert.equal(columns.includes(column), true);
  }
  assert.equal(valueForColumn("subcategoria_3"), "Taxa de navegação");
});

test("a emissão do reembolso grava fornecedor e número documental no lançamento", async () => {
  const kernel = await readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8");
  const start = kernel.indexOf("async function createReimbursementFinance(");
  const end = kernel.indexOf("type ReceiptFinanceBuilder", start);
  const createReimbursement = kernel.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(createReimbursement, /insertStatement\(db, schema, 'lancamentos', \{[\s\S]*?fornecedores_favoritos_id: fornecedor\?\.id \?\? null/);
  assert.match(createReimbursement, /fornecedor_nome: nullableText\(fornecedor\?\.nome_completo\)/);
  assert.match(createReimbursement, /receiptDocumentNumberFields\(input\.categoria_movimentacao_id, input\.numero_documento_anexo\)/);
  assert.match(createReimbursement, /subcategoria_1: nullableText\(input\.subcategoria_1\)/);
  assert.match(kernel, /CATEGORIA_TAXAS_AEROPORTUARIAS_ID = '75865fb8-fda6-4072-adc1-7b8c075e02d8'/);
  assert.match(kernel, /\?\s+\{ numero_demonstrativo: number \}\s+:\s+\{ numero_doc: number \}/);
});
