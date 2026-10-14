import test from "node:test";
import assert from "node:assert/strict";
import { sincronizarRelatorioViagemFinanceiro } from "../src/relatorioFinanceiro.ts";

const columns = [
  "id", "aeronave_id", "holding_id", "socio_id", "colaborador_id", "data_emissao", "data_vencimento", "data_pagamento",
  "descricao", "descricao_despesa", "fornecedor_nome", "numero_doc", "numero_voo", "url_doc", "cotista_aeronave_id",
  "cliente_id", "categoria_nome", "grupo_categoria", "status", "fluxo", "tipo_caixa", "valor_centavos", "pago_por",
  "pago_diretamente", "reembolsavel", "reembolso_quitado", "forma_pagamento", "observacoes", "criado_por", "origem_tipo",
  "origem_id", "idempotency_key", "lancamento_id", "lancamentos_id", "cotista_id", "movimentos_id", "movimento_id",
  "movimento_holding_id", "tripulante_id", "categoria_id", "percentual_sociedade", "percentual_uso", "valor_total_centavos",
  "valor_rateado_centavos", "valor_pago_real_centavos", "tipo_rateio", "periodicidade",
];

function fakeDb(kind = "CLIENTE") {
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
          if (sql.includes("SELECT holding_id FROM hold_socios")) return { holding_id: "holding-1" };
          if (sql.includes("SELECT id FROM cliente WHERE")) return { id: "cliente-1" };
          if (sql.includes("SELECT user_id FROM tripulacao")) return { user_id: "colaborador-1" };
          return null;
        },
        async all() {
          if (sql.includes("pragma_table_info")) return { results: columns.map((name) => ({ name })) };
          if (sql.includes("FROM cotista_aeronave ca") && sql.includes("INNER JOIN hold_socios")) {
            return kind === "HOLDING" ? { results: [
              { id: "cotista-aeronave-1", socio_id: "socio-1", holding_id: "holding-1", percentual_sociedade: 60, nome: "Sócio 1" },
              { id: "cotista-aeronave-2", socio_id: "socio-2", holding_id: "holding-1", percentual_sociedade: 40, nome: "Sócio 2" },
            ] } : { results: [] };
          }
          if (sql.includes("FROM cotista_aeronave ca")) {
            return { results: [{ id: "cotista-aeronave-1", socio_id: null, holding_id: null, percentual_sociedade: 40, nome: "Cotista" }] };
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

function insertedRows(db, table) {
  return db.batched
    .filter((statement) => statement.sql.startsWith(`INSERT INTO ${table} `))
    .map((statement) => {
      const match = statement.sql.match(/INSERT INTO \w+ \((.*?)\) VALUES/);
      assert.ok(match, `esperava um INSERT, recebeu: ${statement.sql}`);
      const names = match[1].split(", ");
      return Object.fromEntries(names.map((name, index) => [name, statement.values[index]]));
    });
}

function report(overrides = {}) {
  return {
    id: "relatorio-1",
    status: "aprovado",
    numero_relatorio: "REL-001/26",
    data_inicio: "2026-10-10",
    data_fim: "2026-10-10",
    aeronave_id: "aeronave-1",
    cliente_id: "cliente-1",
    tripulacao_id: "tripulante-1",
    nome_tripulante: "Tripulante 1",
    despesas: [
      { valor: 50, pago_por: "sharebrasil" },
      { valor: 25, pago_por: "tripulante_1" },
      { valor: 10, pago_por: "cliente" },
    ],
    ...overrides,
  };
}

test("relatório de cotista direto cria um rateio único pelo total sem perder os reembolsos por pagador", async () => {
  const db = fakeDb();
  await sincronizarRelatorioViagemFinanceiro(db, report(), "usuario-1");

  const lancamentos = insertedRows(db, "lancamentos");
  assert.equal(lancamentos.length, 1);
  assert.equal(lancamentos[0].categoria_nome, "DESPESAS REEMBOLSÁVEIS");
  assert.equal(lancamentos[0].valor_centavos, 2500);
  assert.equal(lancamentos[0].idempotency_key, "RELATORIO_DESPESA_VIAGEM:relatorio-1:tripulante_1");

  const recebiveis = insertedRows(db, "contas_areceber");
  assert.equal(recebiveis.length, 1);
  assert.equal(recebiveis[0].valor_centavos, 7500);
  assert.equal(recebiveis[0].lancamentos_id, lancamentos[0].id);

  const rateios = insertedRows(db, "rateio_despesas");
  assert.equal(rateios.length, 1);
  assert.equal(rateios[0].valor_total_centavos, 8500);
  assert.equal(rateios[0].valor_rateado_centavos, 8500);
  assert.equal(rateios[0].percentual_uso, 100);
  assert.equal(rateios[0].lancamento_id, null);
  assert.equal(rateios[0].categoria_nome, "DESPESAS DE VIAGEM");
});

test("relatório de sócio de holding cria um movimento total e um rateio_hold por sócio, conforme o uso igualitário", async () => {
  const db = fakeDb("HOLDING");
  await sincronizarRelatorioViagemFinanceiro(db, report({ socio_id: "socio-1", cliente_id: "holding-1" }), "usuario-1");

  const movimentos = insertedRows(db, "movimentos_holding");
  assert.equal(movimentos.length, 1);
  assert.equal(movimentos[0].valor_centavos, 8500);
  assert.equal(movimentos[0].categoria_nome, "DESPESAS DE VIAGEM");

  assert.equal(insertedRows(db, "rateio_despesas").length, 0);
  const rateios = insertedRows(db, "rateio_hold");
  assert.equal(rateios.length, 2);
  assert.deepEqual(rateios.map((rateio) => rateio.socio_id), ["socio-1", "socio-2"]);
  assert.deepEqual(rateios.map((rateio) => rateio.valor_total_centavos), [8500, 8500]);
  assert.deepEqual(rateios.map((rateio) => rateio.percentual_uso), [50, 50]);
  assert.deepEqual(rateios.map((rateio) => rateio.valor_rateado_centavos), [4250, 4250]);
  assert.deepEqual(rateios.map((rateio) => rateio.percentual_sociedade), [60, 40]);
  assert.ok(rateios.every((rateio) => rateio.movimento_holding_id === movimentos[0].id));
});
