import test from "node:test";
import assert from "node:assert/strict";
import { createReceiptRecord } from "../src/financeiro/reciboAgents.ts";
import { readFile } from "node:fs/promises";

test("criação do recibo não grava fornecedor nem subcategorias fora do schema", async () => {
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
    subcategoria_1: "Combustível",
  }, "recibo-1", "REC-001/26", "user-1");

  const columns = captured.sql.match(/INSERT INTO recibos \(([\s\S]*?)\) VALUES/)[1]
    .split(",").map((column) => column.trim());
  assert.equal(captured.sql.match(/\?/g).length, captured.values.length);
  assert.equal(columns.includes("fornecedor_id"), false);
  assert.equal(columns.includes("fornecedor_nome"), false);
  for (const column of ["subcategoria_1", "subcategoria_2", "subcategoria_3", "subcategoria_4"]) {
    assert.equal(columns.includes(column), false);
  }
});

test("a emissão do financeiro de reembolso grava o fornecedor no lançamento", async () => {
  const kernel = await readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8");
  const start = kernel.indexOf("async function createReimbursementFinance(");
  const end = kernel.indexOf("type ReceiptFinanceBuilder", start);
  const createReimbursement = kernel.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(createReimbursement, /insertStatement\(db, schema, 'lancamentos', \{[\s\S]*?fornecedores_favoritos_id: fornecedor\?\.id \?\? null/);
  assert.match(createReimbursement, /fornecedor_nome: nullableText\(fornecedor\?\.nome_completo\)/);
});
