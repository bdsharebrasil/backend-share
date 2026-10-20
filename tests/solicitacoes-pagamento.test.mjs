import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8");
const inicio = source.indexOf("financeiroRoutes.get('/solicitacoes-pagamento'");
const fim = source.indexOf("financeiroRoutes.get('/lancamentos/opcoes'", inicio);
const rota = source.slice(inicio, fim);

test("caixa cliente lista apenas lançamentos de saída reembolsáveis não pagos diretamente", () => {
  assert.match(rota, /SELECT l\.\*/);
  assert.match(rota, /FROM lancamentos l/);
  assert.match(rota, /UPPER\(COALESCE\(l\.tipo_caixa, ''\)\) = 'CLIENTE'/);
  assert.match(rota, /COALESCE\(l\.reembolsavel, 0\) = 1/);
  assert.match(rota, /COALESCE\(l\.pago_diretamente, 0\) = 0/);
  assert.match(rota, /UPPER\(COALESCE\(l\.fluxo, ''\)\) = 'SAIDA'/);
  assert.match(rota, /l\.data_emissao AS data_despesa/);
  assert.match(rota, /l\.id AS lancamento_id/);
  assert.match(rota, /AS lancamento_categoria_nome/);
  assert.match(rota, /AS lancamento_fornecedor_nome/);
  assert.match(rota, /AS cliente_razao_social/);
  assert.doesNotMatch(rota, /FROM envio_despesas e[\s\S]*?WHERE e\.tipo IN \('cliente', 'reembolso'\)/);
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
