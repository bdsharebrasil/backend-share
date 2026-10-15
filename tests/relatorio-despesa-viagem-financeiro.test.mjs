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
  "valor_rateado_centavos", "valor_pago_real_centavos", "tipo_rateio", "periodicidade", "escopo_financeiro",
];

function fakeDb(kind = "CLIENTE", existingData = null) {
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
          if (existingData && sql.includes("idempotency_key = ?2")) return { id: existingData.costId };
          if (existingData && sql.includes("SELECT data_emissao FROM lancamentos")) return { data_emissao: "2026-10-10" };
          return null;
        },
        async all() {
          if (sql.includes("pragma_table_info")) return { results: columns.map((name) => ({ name })) };
          if (existingData && sql.includes("FROM financeiro_vinculos")) return { results: existingData.links };
          if (existingData && sql.includes("FROM rateio_despesas r")) return { results: existingData.rateios };
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
  const lancamentoReembolso = lancamentos.find((row) => row.idempotency_key === "RELATORIO_DESPESA_VIAGEM:relatorio-1:tripulante_1");
  const lancamentoCusto = lancamentos.find((row) => row.idempotency_key === "RELATORIO_DESPESA_VIAGEM:relatorio-1:CUSTO_INTEGRAL");
  assert.equal(lancamentos.length, 2);
  assert.equal(lancamentoReembolso?.categoria_nome, "DESPESAS REEMBOLSÁVEIS");
  assert.equal(lancamentoReembolso?.valor_centavos, 2500);
  assert.equal(lancamentoReembolso?.escopo_financeiro, "CAIXA_SHARE");
  assert.equal(lancamentoCusto?.categoria_nome, "DESPESAS DE VIAGEM");
  assert.equal(lancamentoCusto?.valor_centavos, 8500);
  assert.equal(lancamentoCusto?.origem_tipo, "RELATORIO_DESPESA_VIAGEM");
  assert.equal(lancamentoCusto?.origem_id, "relatorio-1");
  assert.notEqual(lancamentoCusto?.idempotency_key, lancamentoReembolso?.idempotency_key);

  const recebiveis = insertedRows(db, "contas_areceber");
  assert.equal(recebiveis.length, 1);
  assert.equal(recebiveis[0].valor_centavos, 7500);
  assert.equal(recebiveis[0].lancamentos_id, null);
  assert.equal(recebiveis[0].origem_id, "relatorio-1");
  assert.equal(recebiveis[0].idempotency_key, "RELATORIO_DESPESA_VIAGEM:relatorio-1:CONTA_RECEBER");

  const rateios = insertedRows(db, "rateio_despesas");
  assert.equal(rateios.length, 1);
  assert.equal(rateios[0].valor_total_centavos, 8500);
  assert.equal(rateios[0].valor_rateado_centavos, 8500);
  assert.equal(rateios[0].percentual_uso, 100);
  assert.equal(rateios[0].lancamento_id, lancamentoCusto?.id);
  assert.equal(rateios[0].categoria_nome, "DESPESAS DE VIAGEM");
  assert.equal(rateios[0].valor_pago_real_centavos, 1000);
  assert.equal(rateios[0].pago_por, "cotista-aeronave-1");
  assert.equal(rateios[0].pago_diretamente, 0, "pagamento parcial não marca o rateio todo como pago diretamente");
});

test("relatório de R$ 147,50 registra R$ 100,00 pagos diretamente e mantém R$ 47,50 a receber", async () => {
  const db = fakeDb();
  await sincronizarRelatorioViagemFinanceiro(db, report({
    despesas: [
      { valor: 100, pago_por: "cliente" },
      { valor: 47.5, pago_por: "tripulante_1" },
    ],
  }), "usuario-1");

  const lancamentos = insertedRows(db, "lancamentos");
  const custo = lancamentos.find((row) => row.idempotency_key === "RELATORIO_DESPESA_VIAGEM:relatorio-1:CUSTO_INTEGRAL");
  const reembolso = lancamentos.find((row) => row.idempotency_key === "RELATORIO_DESPESA_VIAGEM:relatorio-1:tripulante_1");
  const rateio = insertedRows(db, "rateio_despesas")[0];
  const recebivel = insertedRows(db, "contas_areceber")[0];

  assert.equal(custo?.valor_centavos, 14750);
  assert.equal(rateio.lancamento_id, custo?.id);
  assert.equal(rateio.valor_rateado_centavos, 14750);
  assert.equal(rateio.valor_pago_real_centavos, 10000);
  assert.equal(rateio.pago_diretamente, 0);
  assert.equal(rateio.status, "EM_ABERTO");
  assert.equal(reembolso?.valor_centavos, 4750);
  assert.equal(reembolso?.escopo_financeiro, "CAIXA_SHARE");
  assert.equal(recebivel.valor_centavos, 4750);
});

test("repetir a sincronização atualiza custo e rateios sem trocar suas identidades", async () => {
  const db = fakeDb("CLIENTE", {
    costId: "custo-pai-existente",
    links: [
      { destino_tipo: "LANCAMENTO", destino_id: "custo-pai-existente" },
      { destino_tipo: "RATEIO_DESPESAS", destino_id: "rateio-existente" },
    ],
    rateios: [{
      id: "rateio-existente", cotista_id: "cotista-aeronave-1", status: "EM_ABERTO",
      pago_diretamente: 0, valor_pago_real_centavos: 0, pago_por: null,
    }],
  });
  await sincronizarRelatorioViagemFinanceiro(db, report({
    despesas: [{ valor: 147.5, pago_por: "cliente" }],
  }), "usuario-1");

  const updates = db.batched.filter((statement) => statement.sql.startsWith("UPDATE rateio_despesas SET"));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].values.at(-1), "rateio-existente");
  assert.equal(updates[0].values[0], "custo-pai-existente");
  assert.ok(db.batched.some((statement) => statement.sql.startsWith("UPDATE lancamentos SET") && statement.values.at(-1) === "custo-pai-existente"));
  assert.equal(insertedRows(db, "rateio_despesas").length, 0);
  assert.equal(insertedRows(db, "lancamentos").length, 0);
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
