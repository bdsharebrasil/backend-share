import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const dashboard = await readFile(new URL("../src/financeiro/dashboardShareRoutes.ts", import.meta.url), "utf8");
const dashboardCotista = await readFile(new URL("../src/financeiro/dashboardCotistaRoutes.ts", import.meta.url), "utf8");
const abastecimentosRoutes = await readFile(new URL("../src/routes/abastecimentosRoutes.ts", import.meta.url), "utf8");
const financeRoutes = await readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8");
const financeiroKernel = await readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8");

test("dashboard financeiro projeta abastecimento pendente como movimentação", () => {
  assert.match(dashboard, /origem_tipo: 'abastecimentos'/);
  assert.match(dashboard, /NOT EXISTS \(SELECT 1 FROM lancamentos l WHERE l\.abastecimentos_id = a\.id/);
});

test("rateio do abastecimento materializa o lançamento financeiro oficial", () => {
  assert.match(financeRoutes, /origem\.origemTipo === 'abastecimentos'/);
  assert.match(financeRoutes, /abastecimentos_id: c\.req\.param\('origemId'\)/);
  assert.match(financeRoutes, /createExpense\(db/);
});

test("abastecimento rateado preserva o titular e não duplica o valor integral no extrato", () => {
  assert.match(abastecimentosRoutes, /rateio_entre_cotistas/);
  assert.match(dashboardCotista, /r\.percentual_uso = 100 AND r\.valor_rateado_centavos = r\.valor_total_centavos/);
  assert.match(dashboardCotista, /ab\.rateio_entre_cotistas = 1 AND titular\.id = r\.cotista_id/);
  assert.match(dashboardCotista, /lancamentoSemRateio/);
});

test("voo emprestado não entra no balanço do cotista e aparece como informação por aeronave", () => {
  assert.match(dashboardCotista, /la\.id = r\.lancamento_id AND ab\.voo_emprestado = 1/);
  assert.match(dashboardCotista, /ab\.id = l\.abastecimentos_id AND ab\.voo_emprestado = 1/);
  assert.match(dashboardCotista, /emprestimos_aeronave: emprestimosAeronave/);
  assert.match(dashboardCotista, /re\.status AS status_reembolso/);
});

test("programação mantém o reembolso sem participante no lançamento de voo emprestado", () => {
  assert.match(financeiroKernel, /const cotistaLancamentoId = vooEmprestado \? null : cotistaId/);
  assert.match(financeiroKernel, /cotista_aeronave_id: cotistaLancamentoId/);
  assert.match(financeiroKernel, /status: 'AGUARDANDO_REEMBOLSO'/);
});

test("schema financeiro carrega abastecimentos e consulta empréstimos sem duplicar lançamentos Share", () => {
  assert.match(financeiroKernel, /const tables = \[\s*'lancamentos',\s*'abastecimentos'/);
  assert.match(dashboardCotista, /LEFT JOIN lancamentos l ON l\.abastecimentos_id = a\.id\s+AND l\.tipo_caixa = 'CLIENTE'\s+AND UPPER\(COALESCE\(l\.status, ''\)\) <> 'CANCELADO'/);
});

test("resumo do dashboard mantém media_lancamento para consumidores existentes", () => {
  assert.match(dashboardCotista, /media_lancamento: lancamentos\.length \? saidas \/ lancamentos\.length : 0/);
});

test("empréstimos da aeronave não são incluídos no dashboard individual do cotista", () => {
  assert.match(dashboardCotista, /const emprestimosAeronave = aeronaveId && !cotistaId && schema\.get\('abastecimentos'\)\?\.has\('voo_emprestado'\)/);
});

test("empréstimos da aeronave retornam IDs e nomes de emprestador e tomador", () => {
  assert.match(dashboardCotista, /d\.cliente_id AS emprestador_cliente_id, d\.socio_id AS emprestador_socio_id/);
  assert.match(dashboardCotista, /LEFT JOIN lancamentos_diario_bordo d ON d\.id = a\.lancamento_diario_id/);
  assert.match(dashboardCotista, /AS tomador_nome/);
  assert.match(dashboardCotista, /AS emprestador_nome/);
  assert.match(dashboardCotista, /AND l\.tipo_caixa = 'CLIENTE'/);
});
