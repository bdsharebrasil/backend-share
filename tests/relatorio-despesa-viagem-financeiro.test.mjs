import test from "node:test";
import assert from "node:assert/strict";
import { sincronizarRelatorioViagemFinanceiro } from "../src/relatorioFinanceiro.ts";

const columns = [
  "id", "aeronave_id", "colaborador_id", "data_emissao", "data_vencimento", "data_pagamento",
  "descricao", "fornecedor_nome", "numero_doc", "numero_voo", "url_doc", "cotista_aeronave_id",
  "cliente_id", "categoria_nome", "grupo_categoria", "status", "fluxo", "tipo_caixa",
  "valor_centavos", "pago_por", "pago_diretamente", "reembolsavel", "reembolso_quitado",
  "forma_pagamento", "observacoes", "criado_por", "origem_tipo", "origem_id", "idempotency_key",
  "lancamento_id", "lancamentos_id", "cotista_id", "movimentos_id", "tripulante_id", "categoria_id", "percentual_sociedade",
  "percentual_uso", "valor_total_centavos", "valor_rateado_centavos", "tipo_rateio", "periodicidade",
];

function fakeDb() {
  const db = {
    batched: [],
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("SELECT id FROM cliente WHERE")) return { id: "cliente-1" };
          if (sql.includes("SELECT user_id FROM tripulacao")) return { user_id: "colaborador-1" };
          return null;
        },
        async all() {
          if (sql.includes("pragma_table_info")) {
            return { results: columns.map((name) => ({ name })) };
          }
          if (sql.includes("FROM cotista_aeronave ca")) {
            return { results: [{ id: "cotista-1", socio_id: null, holding_id: null, percentual_sociedade: 100, nome: "Cotista" }] };
          }
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 0 } };
        },
      };
      return statement;
    },
    async batch(statements) {
      this.batched.push(...statements);
      return [];
    },
  };
  return db;
}

function insertedRow(statement) {
  const match = statement.sql.match(/INSERT INTO \w+ \((.*?)\) VALUES/);
  assert.ok(match, `esperava um INSERT, recebeu: ${statement.sql}`);
  const names = match[1].split(", ");
  return Object.fromEntries(names.map((name, index) => [name, statement.values[index]]));
}

test("despesa paga pela Share não cria lançamento duplicado e preserva reembolso e recebível", async () => {
  const db = fakeDb();
  const report = {
    id: "relatorio-1",
    status: "aprovado",
    numero_relatorio: "REL-001/26",
    data_inicio: "2026-10-10",
    data_fim: "2026-10-10",
    aeronave_id: "aeronave-1",
    cliente_id: "cliente-1",
    tripulacao_id: "tripulante-1",
    despesas: [
      { valor: 50, pago_por: "sharebrasil" },
      { valor: 25, pago_por: "tripulante_1" },
    ],
  };

  await sincronizarRelatorioViagemFinanceiro(db, report, "usuario-1");

  const inserts = db.batched.filter((statement) => statement.sql.startsWith("INSERT INTO "));
  const lancamentos = inserts
    .filter((statement) => statement.sql.startsWith("INSERT INTO lancamentos"))
    .map(insertedRow);
  assert.equal(lancamentos.length, 1);
  assert.equal(lancamentos[0].categoria_nome, "DESPESAS REEMBOLSÁVEIS");
  assert.equal(lancamentos[0].valor_centavos, 2500);
  assert.equal(lancamentos[0].idempotency_key, "RELATORIO_DESPESA_VIAGEM:relatorio-1:tripulante_1");

  const recebivel = inserts
    .filter((statement) => statement.sql.startsWith("INSERT INTO contas_areceber"))
    .map(insertedRow)[0];
  assert.ok(recebivel);
  assert.equal(recebivel.valor_centavos, 7500);
  assert.equal(recebivel.lancamentos_id, lancamentos[0].id);

  const rateios = inserts.filter((statement) => statement.sql.startsWith("INSERT INTO rateio_despesas"));
  assert.equal(rateios.length, 2);
});
