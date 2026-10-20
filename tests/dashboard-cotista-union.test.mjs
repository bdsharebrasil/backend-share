import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildLancamentoSemRateioPredicate } from "../src/financeiro/dashboardCotistaRoutes.ts";
import { calcularCompensacaoBalanco, consolidarRateiosLancamentos } from "../src/financeiro/cotistaDashboard.ts";

const source = await readFile(new URL("../src/financeiro/dashboardCotistaRoutes.ts", import.meta.url), "utf8");
const financeRoutes = await readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8");

test("dashboard expõe tipo_rateio sem substituir a origem técnica", () => {
  assert.match(source, /tipo: row\.origem_rateio \?\? null, tipoRateio: row\.tipo_rateio \?\? null/);
});
function projectionColumnCount(branch) {
  const selectIndex = branch.search(/\bSELECT\b/i);
  const fromIndex = branch.search(/\bFROM\b/i);
  assert.notEqual(selectIndex, -1, "cada ramificação deve iniciar com SELECT");
  assert.notEqual(fromIndex, -1, "cada ramificação deve conter FROM");

  const projection = branch
    .slice(selectIndex + "SELECT".length, fromIndex)
    .replace(/\$\{[^{}]*\}/g, "NULL");
  let columns = 1;
  let parenthesisDepth = 0;
  let inString = false;

  for (let index = 0; index < projection.length; index += 1) {
    const character = projection[index];
    if (inString) {
      if (character === "'" && projection[index + 1] === "'") index += 1;
      else if (character === "'") inString = false;
      continue;
    }
    if (character === "'") inString = true;
    else if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth -= 1;
    else if (character === "," && parenthesisDepth === 0) columns += 1;
  }
  return columns;
}

test("dashboard Cotista mantém a mesma projeção nas quatro fontes do UNION ALL", () => {
  const query = source.match(/const rows = await listar\(db, `([\s\S]*?)`, \.\.\.paramsCliente/);
  assert.ok(query, "consulta consolidada do dashboard deve existir");

  const branches = query[1].split(/\bUNION ALL\b/i);
  assert.equal(branches.length, 4, "esperadas as fontes cliente, holding, lançamentos e movimentos");

  const columnCounts = branches.map(projectionColumnCount);
  assert.equal(
    new Set(columnCounts).size,
    1,
    `todas as projeções precisam ter a mesma quantidade de colunas; obtido: ${columnCounts.join(", ")}`,
  );

  const descriptionSlots = [
    /r\.data_emissao AS data,\s*r\.descricao_despesa AS descricao,/,
    /r\.data_emissao AS data,\s*r\.descricao_despesa AS descricao,/,
    /l\.data_emissao AS data,\s*l\.descricao AS descricao,/,
    /mh\.data_emissao AS data,\s*mh\.descricao AS descricao,/,
  ];
  branches.forEach((branch, index) => {
    assert.match(branch, descriptionSlots[index], `a fonte ${index + 1} deve preencher a coluna descricao na mesma posição`);
  });
});


test("dashboard Cotista prioriza a data de envio de e-mail registrada no rateio", () => {
  assert.match(source, /COALESCE\(r\.email_enviado_em, l\.email_enviado_em\) AS email_enviado_em/);
  assert.match(source, /COALESCE\(r\.email_enviado_em, mh\.email_enviado_em\) AS email_enviado_em/);
});

test("dashboard Cotista propaga reembolsavel do lançamento-pai para o rateio", () => {
  assert.match(source, /COALESCE\(l\.reembolsavel, 0\) AS reembolsavel/);
  assert.match(source, /COALESCE\(l\.reembolso_quitado, 0\) AS reembolso_quitado/);
});

test("dashboard Cotista converte IDs de fornecedor em nomes antes de responder", () => {
  assert.match(source, /SELECT id, nome_completo FROM fornecedores_favoritos WHERE id IN/);
  assert.match(source, /fornecedoresPorId\.get\(String\(row\.fornecedor_id/);
});

test("dashboard Cotista recupera fornecedor, número e PDF do lançamento vinculado ao rateio", () => {
  const queryStart = source.indexOf("const rows = await listar(db, `");
  const queryEnd = source.indexOf("`, ...paramsCliente", queryStart);
  assert.notEqual(queryStart, -1, "consulta consolidada do dashboard deve existir");
  assert.notEqual(queryEnd, -1, "consulta consolidada do dashboard deve terminar corretamente");
  const clienteBranch = source.slice(queryStart, queryEnd).split(/\bUNION ALL\b/i)[0];
  assert.match(clienteBranch, /COALESCE\(r\.fornecedor_id, l\.fornecedores_favoritos_id\) AS fornecedor_id/);
  assert.match(clienteBranch, /NULLIF\(TRIM\(l\.fornecedor_nome\), ''\) AS fornecedor_nome/);
  assert.match(clienteBranch, /NULLIF\(TRIM\(r\.numero_nf\), ''\)[\s\S]*NULLIF\(TRIM\(l\.numero_doc\), ''\)\s*\) AS numero_doc/);
  assert.match(clienteBranch, /COALESCE\(NULLIF\(r\.url_doc, ''\), NULLIF\(r\.documento_url, ''\), NULLIF\(l\.url_doc, ''\)\) AS url_doc/);
  assert.equal((clienteBranch.match(/LEFT JOIN lancamentos l ON l\.id = r\.lancamento_id/g) || []).length, 1);
});


test("balanço usa o pagamento real e mantém IDs na matriz de compensação", () => {
  const resultado = calcularCompensacaoBalanco([
    { participante_id: "cotista-a", participante_nome: "Cotista A", valor_rateado_centavos: 10000, valor_pago_real_centavos: 20000, pago_por: "cotista-a", fluxo: "SAIDA" },
    { participante_id: "cotista-b", participante_nome: "Cotista B", valor_rateado_centavos: 10000, valor_pago_real_centavos: 0, pago_por: null, fluxo: "SAIDA" },
  ]);
  const saldoA = resultado.saldos.find((saldo) => saldo.cotistaId === "cotista-a");
  const saldoB = resultado.saldos.find((saldo) => saldo.cotistaId === "cotista-b");
  assert.equal(saldoA?.saldoCentavos, 10000);
  assert.equal(saldoB?.saldoCentavos, -10000);
  assert.deepEqual(Object.keys(resultado.matrizCompensacao), ["cotista-a", "cotista-b"]);
  assert.equal(resultado.matrizCompensacao["cotista-a"]["cotista-b"], 10000);
  assert.doesNotMatch(JSON.stringify(resultado.matrizCompensacao), /Cotista A|Cotista B/);
});

test("consulta do balanço não limita o histórico e separa período exibido do acumulado", () => {
  assert.doesNotMatch(source, /ORDER BY 4 DESC, 1 DESC LIMIT 1000/);
  assert.match(source, /consolidarRateiosLancamentos\(rowsComDocumentos\.filter\(dentroDoPeriodo\)\)/);
  assert.match(source, /const compensacao = calcularCompensacaoBalanco\(rows, participantesPermitidos\)/);
  assert.doesNotMatch(source, /filtrosCliente\.push\('date\(r\.data_emissao\) >= date\(\?\)'\)/);
  assert.doesNotMatch(source, /filtrosMovimento\.push\('date\(mh\.data_emissao\) >= date\(\?\)'\)/);
});

test("dashboard Cotista lê fornecedor e fornecedor_id do rateio_hold", () => {
  const queryStart = source.indexOf("const rows = await listar(db, `");
  const queryEnd = source.indexOf("`, ...paramsCliente", queryStart);
  assert.notEqual(queryStart, -1, "consulta consolidada do dashboard deve existir");
  assert.notEqual(queryEnd, -1, "consulta consolidada do dashboard deve terminar corretamente");
  const holdBranch = source.slice(queryStart, queryEnd).split(/\bUNION ALL\b/i)[1];
  assert.ok(holdBranch);
  assert.match(holdBranch, /r\.fornecedor_id,\s*r\.fornecedor AS fornecedor_nome/);
  assert.match(source, /row\.fornecedor_nome \?\? fornecedoresPorId\.get/);
});

test("dashboard Cotista filtra rateio_despesas por cotista_aeronave_id", () => {
  assert.match(
    source,
    /if \(cotistaAeronaveId && !cotistaSocioId\) \{ filtrosCliente\.push\('r\.cotista_id = \?'\); paramsCliente\.push\(cotistaAeronaveId\) \}/,
    "rateios do cliente devem usar o ID da relação cotista-aeronave",
  );
  assert.doesNotMatch(
    source,
    /filtrosCliente\.push\('r\.cotista_id = \?'\); paramsCliente\.push\(cotistaClienteId\)/,
    "rateios não podem ser filtrados pelo cliente_id",
  );
});

test("dashboard Cotista consolida as linhas pelo lançamento pai e preserva os detalhes", () => {
  const rows = consolidarRateiosLancamentos([
    { id: "rateio-1", lancamento_id: "pai-1", origem_rateio: "rateio_despesas", participante_id: "cotista-1", participante_nome: "Cotista 1", percentual_uso: 50, valor_rateado_centavos: 300000, valor_pago_real_centavos: 0, status: "EM_ABERTO" },
    { id: "rateio-2", lancamento_id: "pai-1", origem_rateio: "rateio_despesas", participante_id: "cotista-2", participante_nome: "Cotista 2", percentual_uso: 50, valor_rateado_centavos: 300000, valor_pago_real_centavos: 300000, status: "PAGO" },
    { id: "rateio-3", lancamento_id: "pai-2", origem_rateio: "rateio_despesas", participante_id: "cotista-1", participante_nome: "Cotista 1", percentual_uso: 100, valor_rateado_centavos: 125000, status: "EM_ABERTO" },
    { id: "solto", origem_rateio: "lancamentos", valor_centavos: 70000 },
  ]);

  assert.equal(rows.length, 3, "duas despesas rateadas e um lançamento sem rateio devem resultar em três itens");
  assert.equal(rows[0].id, "pai-1", "o identificador do pai permite operar sobre todas as linhas do rateio");
  assert.equal(rows[0].lancamento_id, "pai-1");
  assert.equal(rows[0].valor_centavos, 600000);
  assert.equal(rows[0].valor_rateado_centavos, 600000);
  assert.equal(rows[0].valor_pago_real_centavos, 300000);
  assert.equal(rows[0].participante_nome, "Rateio entre cotistas");
  assert.equal(rows[0].rateio_linhas.length, 2);
  assert.deepEqual(rows[0].rateio_linhas.map((item) => item.cotista_nome), ["Cotista 1", "Cotista 2"]);
  assert.equal(rows[0].status, "EM_ABERTO", "um rateio pendente mantém o item pai pendente");
  assert.equal(rows[2].id, "solto", "lançamentos sem rateio permanecem inalterados");
});

test("ações do lançamento consolidado reconhecem o ID-pai e atualizam o grupo de rateios", () => {
  assert.match(financeRoutes, /SELECT lancamento_id AS id, "rateio_despesas_pai" AS origem FROM rateio_despesas WHERE lancamento_id = \? LIMIT 1/);
  assert.match(financeRoutes, /const colunaId = ehRateioPai \? 'lancamento_id' : 'id'/);
  assert.match(financeRoutes, /valor_pago_real_centavos = valor_rateado_centavos/);
  assert.match(financeRoutes, /WHERE lancamento_id = \? AND UPPER\(COALESCE\(status, ''\)\) <> 'CANCELADO'/);
});

test("baixa genérica rejeita lançamento marcado como reembolsável", () => {
  assert.match(financeRoutes, /SELECT tipo_caixa, origem_tipo, reembolsavel FROM lancamentos WHERE id = \?/);
  assert.match(financeRoutes, /lancamento_reembolsavel_nao_pode_ser_baixado/);
});

test("predicado de deduplicação não consulta colunas de origem ausentes no schema", () => {
  const schema = new Map([
    ["lancamentos", new Set(["fluxo"])],
    ["rateio_despesas", new Set(["lancamento_id", "status"])],
    ["reembolsos", new Set(["id"])],
  ]);

  const predicate = buildLancamentoSemRateioPredicate(schema);

  assert.match(predicate, /rd\.lancamento_id = l\.id/);
  assert.doesNotMatch(predicate, /rd\.origem_(tipo|id)/);
  assert.doesNotMatch(predicate, /rb\.lancamento_(cliente|origem)_id/);
  assert.doesNotMatch(predicate, /l\.origem_tipo/);
});

test("predicado de deduplicação usa vínculos de reembolso somente quando as colunas existem", () => {
  const schema = new Map([
    ["lancamentos", new Set(["fluxo", "origem_tipo", "origem_id"])],
    ["rateio_despesas", new Set(["lancamento_id", "status", "origem_tipo", "origem_id"])],
    ["reembolsos", new Set(["lancamento_cliente_id", "lancamento_origem_id"])],
  ]);

  const predicate = buildLancamentoSemRateioPredicate(schema);

  assert.match(predicate, /rb\.lancamento_origem_id/);
  assert.match(predicate, /rb\.lancamento_cliente_id/);
  assert.match(predicate, /rd\.origem_tipo = l\.origem_tipo/);
  assert.match(predicate, /rd\.origem_id = l\.origem_id/);
  assert.match(predicate, /AND NOT \(UPPER\(COALESCE\(l\.origem_tipo/);
});

test("pagamento direto parcial reduz o saldo sem transformar o custo integral em pago", () => {
  const resultado = calcularCompensacaoBalanco([
    { participante_id: "cotista-1", participante_nome: "Cotista", valor_rateado_centavos: 14750, valor_pago_real_centavos: 10000, pago_por: "cotista-1", pago_diretamente: 0, status: "EM_ABERTO", fluxo: "SAIDA" },
  ]);
  assert.equal(resultado.saldos[0]?.totalDevidoCentavos, 14750);
  assert.equal(resultado.saldos[0]?.totalPagoCentavos, 10000);
  assert.equal(resultado.saldos[0]?.saldoCentavos, -4750);
});

test("dashboard exclui escopo CAIXA_SHARE da composição de custo", () => {
  assert.match(source, /COALESCE\(l\.escopo_financeiro, 'FINANCEIRO'\) = 'FINANCEIRO'/);
  assert.match(source, /COALESCE\(mh\.escopo_financeiro, 'FINANCEIRO'\) = 'FINANCEIRO'/);
  assert.match(source, /String\(rateio\.pago_por\) === String\(rateio\.cotista_id\)/);
  const schema = new Map([
    ["lancamentos", new Set(["fluxo", "escopo_financeiro"])],
    ["rateio_despesas", new Set(["lancamento_id", "status"])],
  ]);
  assert.match(buildLancamentoSemRateioPredicate(schema), /l\.escopo_financeiro/);
});

test("cópia de cobrança do relatório não reaparece como despesa além do custo integral", () => {
  const schema = new Map([
    ["lancamentos", new Set(["fluxo", "origem_tipo", "idempotency_key", "escopo_financeiro"])],
    ["rateio_despesas", new Set(["lancamento_id", "status"])],
  ]);
  const predicate = buildLancamentoSemRateioPredicate(schema);
  assert.match(predicate, /RELATORIO_DESPESA_VIAGEM/);
  assert.match(predicate, /:LANCAMENTO_CLIENTE/);
});
