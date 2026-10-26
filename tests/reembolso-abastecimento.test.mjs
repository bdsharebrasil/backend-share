import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createReceiptRecord, validateReceiptCommand } from "../src/financeiro/reciboAgents.ts";

const [kernel, routes, migration, schema] = await Promise.all([
  readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/financeiro/recibosRoutes.ts", import.meta.url), "utf8"),
  readFile(new URL("../migrations/20261026_recibo_numero_voo.sql", import.meta.url), "utf8"),
  readFile(new URL("../schema.sql", import.meta.url), "utf8"),
]);

test("emissão de recibo de reembolso aceita, grava e retorna numero_voo", async () => {
  const input = validateReceiptCommand({
    tipo_recibo: "recibo_reembolso",
    pagador_tipo: "cotista_aeronave",
    pagador_id: "cotista-1",
    valor_centavos: 350300,
    categoria_movimentacao_id: "categoria-1",
    descricao: "Reembolso de voo",
    data_emissao: "2026-09-14",
    data_vencimento: null,
    vencimento: "2026-09-30",
    numero_voo: "VOO-2026-001",
  });
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          writes.push({ sql, values });
          return { run: async () => ({ success: true }) };
        },
      };
    },
  };

  assert.equal(input.numero_voo, "VOO-2026-001");
  assert.equal(input.data_vencimento, "2026-09-30");
  await createReceiptRecord(db, input, "recibo-1", "REC-COTISTA001/26", null);
  assert.match(writes[0].sql, /categoria_nome, numero_voo/);
  assert.equal(writes[0].values.at(-1), "VOO-2026-001");
  assert.equal(writes[0].values[16], "2026-09-30");
  assert.match(kernel, /createReceiptRecord\(db, \{ \.\.\.input, \.\.\.body, data_vencimento: input\.data_vencimento \}/);
  assert.match(kernel, /numero_voo: input\.numero_voo \|\| null/);
  assert.match(migration, /ALTER TABLE recibos RENAME COLUMN numero_voo TO numero_voo_id/);
  assert.match(migration, /SET numero_voo = \([\s\S]*s\.numero_voo[\s\S]*s\.id = recibos\.numero_voo_id/);
  assert.match(migration, /ALTER TABLE recibos DROP COLUMN numero_voo_id/);
  assert.match(schema, /categoria_nome TEXT,[\s\S]*numero_voo TEXT\n/);
});

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
