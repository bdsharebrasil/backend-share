import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8");
const inicio = source.indexOf("financeiroRoutes.get('/solicitacoes-pagamento'");
const fim = source.indexOf("financeiroRoutes.get('/lancamentos/opcoes'", inicio);
const rota = source.slice(inicio, fim);
const inicioCaixaCliente = rota.indexOf('listar(db, `SELECT l.*');
const fimCaixaCliente = rota.indexOf('listar(db, `SELECT cp.*', inicioCaixaCliente);
const consultaCaixaCliente = rota.slice(inicioCaixaCliente, fimCaixaCliente);

test("aba Caixa cliente lista despesas SHARE reembolsáveis não pagas diretamente", () => {
  assert.match(consultaCaixaCliente, /SELECT l\.\*/);
  assert.match(consultaCaixaCliente, /FROM lancamentos l/);
  assert.match(consultaCaixaCliente, /COALESCE\(l\.reembolsavel, 0\) = 1/);
  assert.match(consultaCaixaCliente, /COALESCE\(l\.pago_diretamente, 0\) = 0/);
  assert.match(consultaCaixaCliente, /UPPER\(COALESCE\(l\.fluxo, ''\)\) = 'SAIDA'/);
  assert.match(consultaCaixaCliente, /UPPER\(COALESCE\(l\.tipo_caixa, ''\)\) = 'SHARE'/);
  assert.match(consultaCaixaCliente, /NULLIF\(TRIM\(l\.colaborador_id\), ''\) IS NULL/);
  assert.match(consultaCaixaCliente, /NOT EXISTS \([\s\S]*FROM contas_apagar cp_colaborador[\s\S]*NULLIF\(TRIM\(cp_colaborador\.colaborador_id\), ''\) IS NOT NULL/);
  assert.match(consultaCaixaCliente, /l\.data_emissao AS data_despesa/);
  assert.match(consultaCaixaCliente, /l\.id AS lancamento_id/);
  assert.match(consultaCaixaCliente, /AS lancamento_categoria_nome/);
  assert.match(consultaCaixaCliente, /AS lancamento_fornecedor_nome/);
  assert.match(consultaCaixaCliente, /AS cliente_razao_social/);
  assert.doesNotMatch(consultaCaixaCliente, /FROM envio_despesas e/);
});

test("fila de reembolso colaborador exige colaborador_id e não expõe seu UUID como nome", () => {
  assert.match(rota, /AND NULLIF\(TRIM\(cp\.colaborador_id\), ''\) IS NOT NULL/);
  assert.match(rota, /COALESCE\(NULLIF\(TRIM\(u\.nome_exibicao\), ''\), NULLIF\(TRIM\(u\.nome_completo\), ''\), NULLIF\(TRIM\(u\.email\), ''\)\) AS solicitante_nome/);
  assert.doesNotMatch(rota, /COALESCE\([^\n]*cp\.colaborador_id\) AS solicitante_nome/);
});

test("reembolsos incluem campos do lançamento e resolvem categoria, cotista e número do voo", () => {
  assert.match(rota, /l\.data_emissao AS lancamento_data_emissao/);
  assert.match(rota, /l\.url_doc/);
  assert.match(rota, /l\.numero_demonstrativo/);
  assert.match(rota, /categoria_movimentacao_share cat ON cat\.id = l\.categoria_share_id/);
  assert.match(rota, /AS lancamento_categoria_nome/);
  assert.match(rota, /cotista_aeronave ca ON ca\.id = l\.cotista_aeronave_id/);
  assert.match(rota, /AS cotista_nome/);
  assert.match(rota, /solicitacoes_reserva_voo voo ON voo\.id = l\.numero_voo/);
});
