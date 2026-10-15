import test from "node:test";
import assert from "node:assert/strict";
import { ensureRelatorioContaAReceber } from "../src/financeiro/relatorioContaReceber.ts";

const columns = [
  "id", "cotista_id", "origem_tipo", "origem_id", "idempotency_key", "valor_centavos",
  "data_vencimento", "status", "data_recebimento", "data_pagamento", "comprovante_recebimento_url",
  "lancamentos_id", "movimentos_id", "categoria_id", "categoria_nome", "descricao", "aeronave_id", "criado_por",
];

function fakeDb(matches = [], hasConfirmedPayment = false) {
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; if (sql.includes("SELECT * FROM contas_areceber")) queries.push({ sql, values }); return this; },
        async all() {
          if (sql.includes("pragma_table_info('contas_areceber')")) return { results: columns.map((name) => ({ name })) };
          if (sql.includes("SELECT * FROM contas_areceber")) return { results: matches };
          return { results: [] };
        },
        async first() {
          if (sql.includes("sqlite_master")) return hasConfirmedPayment ? { name: "rateio_pagamentos" } : null;
          if (sql.includes("FROM rateio_pagamentos")) return hasConfirmedPayment ? { encontrado: 1 } : null;
          return null;
        },
      };
      return statement;
    },
  };
  return db;
}

const baseInput = {
  reportId: "relatorio-1",
  cotistaId: "cotista-1",
  values: {
    id: "recebivel-novo",
    valor_centavos: 7500,
    data_vencimento: "2026-10-17",
    status: "EM_ABERTO",
    lancamentos_id: "lancamento-cliente",
  },
  legacyIdempotencyKeys: [
    "RELATORIO_DESPESA_VIAGEM:relatorio-1:REEMBOLSO_CLIENTE:CONTA_RECEBER",
  ],
};

test("cria recebível somente quando não encontra conta para a origem e devedor", async () => {
  const result = await ensureRelatorioContaAReceber(fakeDb(), baseInput);
  assert.equal(result.status, "created");
  assert.match(result.statement.sql, /^INSERT INTO contas_areceber/);
  assert.equal(result.statement.values[0], "recebivel-novo");
  assert.ok(result.statement.values.includes("cotista-1"));
  assert.equal(result.statement.values.at(-1), "RELATORIO_DESPESA_VIAGEM:relatorio-1:CONTA_RECEBER");
});

test("retorna conciliação quando duas contas ativas compartilham origem/devedor", async () => {
  const result = await ensureRelatorioContaAReceber(fakeDb([
    { id: "conta-a", status: "EM_ABERTO" },
    { id: "conta-b", status: "RECEBIDO" },
  ]), baseInput);
  assert.deepEqual(result, { status: "reconciliation_required", ids: ["conta-a", "conta-b"] });
});

test("não reabre nem cria outra conta quando a única correspondência está cancelada", async () => {
  const result = await ensureRelatorioContaAReceber(fakeDb([
    { id: "conta-cancelada", status: "CANCELADO" },
  ]), baseInput);
  assert.deepEqual(result, { status: "cancelled", ids: ["conta-cancelada"] });
});

test("ao comunicar, atualiza vencimento e vínculo sem sobrescrever recebimentos", async () => {
  const result = await ensureRelatorioContaAReceber(fakeDb([
    {
      id: "conta-paga",
      status: "RECEBIDO",
      valor_centavos: 7500,
      data_recebimento: "2026-10-16",
      data_pagamento: "2026-10-16",
      comprovante_recebimento_url: "https://example.test/comprovante.pdf",
    },
  ]), { ...baseInput, communicated: true });
  assert.equal(result.status, "existing");
  assert.equal(result.id, "conta-paga");
  assert.match(result.statement.sql, /data_vencimento = \?/);
  assert.match(result.statement.sql, /lancamentos_id = \?/);
  assert.doesNotMatch(result.statement.sql, /valor_centavos = \?/);
  assert.doesNotMatch(result.statement.sql, /status = \?/);
  assert.equal(result.statement.values.at(-1), "conta-paga");
});

test("reconhece registros legados pelo relatório, devedor e chave antiga", async () => {
  const db = fakeDb([{ id: "conta-legada", status: "EM_ABERTO", valor_centavos: 7500 }]);
  const result = await ensureRelatorioContaAReceber(db, baseInput);
  assert.equal(result.status, "existing");
  assert.match(db.queries[0].sql, /idempotency_key IN \(\?1, \?2\)/);
  assert.deepEqual(db.queries[0].values, [
    "RELATORIO_DESPESA_VIAGEM:relatorio-1:CONTA_RECEBER",
    "RELATORIO_DESPESA_VIAGEM:relatorio-1:REEMBOLSO_CLIENTE:CONTA_RECEBER",
    "cotista-1",
    "relatorio-1",
  ]);
  assert.equal(result.statement.values.at(-1), "conta-legada");
});


test("preserva pagamentos parciais confirmados mesmo com conta ainda em aberto", async () => {
  const db = fakeDb([
    { id: "conta-parcial", status: "EM_ABERTO", valor_centavos: 7500 },
  ], true);
  const result = await ensureRelatorioContaAReceber(db, { ...baseInput, communicated: true });
  assert.equal(result.status, "existing");
  assert.doesNotMatch(result.statement.sql, /valor_centavos = \?/);
  assert.match(result.statement.sql, /data_vencimento = \?/);
  assert.match(result.statement.sql, /lancamentos_id = \?/);
});
