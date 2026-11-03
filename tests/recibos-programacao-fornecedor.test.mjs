import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [routes, kernel, contas] = await Promise.all([
  readFile(new URL("../src/financeiro/recibosRoutes.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/financeiro/repositories/contas.ts", import.meta.url), "utf8"),
]);
const opcoes = routes.slice(routes.indexOf("recibosRoutes.get('/recibos/opcoes'"), routes.indexOf("recibosRoutes.patch('/recibos/:id/status'"));
const programar = routes.slice(routes.indexOf("recibosRoutes.post('/recibos/:id/programar-contas-apagar'"), routes.indexOf("recibosRoutes.post('/recibos/:id/cancelar'"));

test("opções incluem as três tabelas existentes e devolvem abastecimentos do seu SELECT correto", () => {
  assert.match(opcoes, /fornecedoresFavoritos, fornecedoresCombustivel, contatosFornecedores, abastecimentos\] = await Promise\.all/);
  assert.match(opcoes, /FROM fornecedores_favoritos/);
  assert.match(opcoes, /FROM fornecedores_combustivel/);
  assert.match(opcoes, /FROM agenda_contatos_fornecedores/);
  assert.match(opcoes, /const fornecedores = \[\.\.\.fornecedoresFavoritos, \.\.\.fornecedoresCombustivel, \.\.\.contatosFornecedores\]/);
  assert.match(opcoes, /fornecedoresVistos\.has\(chave\)/);
  assert.match(opcoes, /abastecimentos, fornecedores, recebedores/);
});

test("programação valida fornecedores cadastrados e grava em contas_apagar somente FK de favorito válida", () => {
  assert.match(programar, /FROM agenda_contatos_fornecedores WHERE id = \?1/);
  assert.match(programar, /if \(fornecedorIdSolicitado && !fornecedorSolicitado\) return c\.json\(\{ error: 'fornecedor_nao_encontrado' \}, 400\)/);
  assert.match(programar, /SELECT id FROM fornecedores_favoritos WHERE id = \? LIMIT 1/);
  assert.match(programar, /const fornecedorIdConta = fornecedorFavoritoPorNome\?\.id \?\? null/);
  assert.match(programar, /INSERT INTO contas_apagar[\s\S]*?fornecedorIdConta/);
  assert.match(programar, /\.bind\([^\n]*fornecedorIdConta, cotistaIdConta\)/);
  assert.match(programar, /fornecedorIdRateio, receipt\.numero_recibo/);
});

test("categoria de conta usa somente categoria Share associada já existente ou null", () => {
  assert.match(programar, /SELECT id, nome FROM categoria_movimentacao_share WHERE categoria_cliente_id = \? LIMIT 1/);
  assert.match(programar, /const categoriaIdConta = lancamento\.categoria_share_id \?\? categoriaShareAssociada\?\.id \?\? null/);
  assert.doesNotMatch(programar, /categoriaIdConta = lancamento\.categoria_share_id \?\? receipt\.categoria_movimentacao_id/);
});

test("lançamento reconhece fornecedor da agenda e a listagem mantém seu nome sem ampliar schema", () => {
  assert.match(kernel, /FROM agenda_contatos_fornecedores WHERE id = \?1/);
  assert.match(contas, /SELECT id, fornecedor_nome FROM lancamentos/);
  assert.match(contas, /fornecedorPorLancamento\.get\(lancamentoId\)/);
  assert.doesNotMatch(routes, /CREATE TABLE/i);
});
