import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [kernel, routes, migration] = await Promise.all([
  readFile(new URL("../src/financeiro/FinanceiroKernel.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/financeiro/recibosRoutes.ts", import.meta.url), "utf8"),
  readFile(new URL("../migrations/20261015_recibo_reembolso_idempotencia.sql", import.meta.url), "utf8"),
]);
const settleReceivable = kernel.slice(
  kernel.indexOf("export async function settleReceivable("),
  kernel.indexOf("export async function enqueueFinance(", kernel.indexOf("export async function settleReceivable(")),
);

test("recibo pago pela empresa materializa as linhas escolhidas no histórico", () => {
  assert.match(kernel, /function linhasRateioPagasPelaEmpresa\(linhas: Row\[\]\)/);
  assert.match(kernel, /const rateioLinhas = linhasRateioPagasPelaEmpresa\(linhasInformadas\)/);
  assert.match(kernel, /tipo_caixa: rateioLinhas\.length \? 'CLIENTE' : 'SHARE'/);
  assert.match(kernel, /rateio_linhas: rateioLinhas,[\s\S]{0,100}sem_rateio: !rateioLinhas\.length/);
  assert.match(kernel, /idempotency_key: `recibo-pagamento:\$\{receiptId\}`/);
});

test("criação do rateio consulta o lançamento retornado pela finalização", () => {
  assert.match(kernel, /result\?\.lancamento_cliente_id \?\? result\?\.lancamento_id \?\? receipt\.lancamento_id/);
  assert.match(kernel, /FROM rateio_despesas WHERE lancamento_id = \?1/);
  assert.doesNotMatch(kernel, /FROM rateio_despesas WHERE origem_tipo = 'RECIBO' AND origem_id/);
  assert.match(kernel, /SET escopo_financeiro = 'FINANCEIRO'[\s\S]{0,100}WHERE id = \?1 AND tipo_caixa = 'SHARE'/);
});

test("repetir a ação completa vínculos faltantes sem duplicar linhas já vinculadas", () => {
  assert.match(kernel, /SELECT rateio_id FROM recibo_rateio WHERE recibo_id = \?1/);
  assert.match(kernel, /vinculosPendentes = rateios\.filter\(\(rateio\) => !rateioIdsVinculados\.has/);
  assert.match(kernel, /createClientExpenseRateios\(db, rateioCommand, userId, \{ internal: true \}\)/);
});

test("recibo pago por cliente persiste envio como origem do rateio", () => {
  assert.match(kernel, /receipt\.pagador_tipo === 'cliente'/);
  assert.match(kernel, /insertStatement\(db, schema, 'envio_despesas'/);
  assert.match(kernel, /'RECIBO', \?\, 'ENVIO_DESPESA'/);
  assert.match(kernel, /lancamento_id: envioId/);
  assert.match(kernel, /UPDATE recibos SET lancamento_id = \? WHERE id = \? AND lancamento_id IS NULL/);
  assert.match(kernel, /'ENVIO_DESPESA', \?\, 'RATEIO_DESPESAS'/);
});

test("rateio usa apenas colunas presentes e leva os documentos do recibo", () => {
  assert.match(kernel, /compatibleRateioValues = Object\.fromEntries/);
  assert.match(kernel, /fornecedor_id: nullableText\(command\.fornecedor_id\)/);
  assert.match(kernel, /numero_recibo: nullableText\(command\.numero_recibo\)/);
  assert.match(kernel, /url_recibo: nullableText\(command\.url_recibo\)/);
  assert.match(kernel, /numero_recibo: receipt\.numero_recibo/);
  assert.match(kernel, /url_recibo: receipt\.url_recibo/);
});

test("reembolso de recibo grava as datas nas colunas do schema D1", () => {
  const inicio = kernel.indexOf("async function createReimbursementFinance(");
  const fim = kernel.indexOf("type ReceiptFinanceBuilder", inicio);
  const caminho = kernel.slice(inicio, fim);
  assert.match(caminho, /data_emissao: input\.data_emissao/);
  assert.match(caminho, /data_vencimento: input\.data_vencimento \|\| input\.data_emissao/);
  assert.doesNotMatch(caminho, /data_lancamento/);
});

test("lançamento Share do reembolso grava fornecedor e escopo do caixa Share", () => {
  const inicio = kernel.indexOf("async function createReimbursementFinance(");
  const fim = kernel.indexOf("type ReceiptFinanceBuilder", inicio);
  const caminho = kernel.slice(inicio, fim);
  assert.match(kernel, /async function buscarFornecedor\(db: Database, fornecedorId: unknown\)[\s\S]*SELECT id, nome_completo FROM fornecedores_favoritos/);
  assert.match(caminho, /const fornecedor = await buscarFornecedor\(db, fornecedorId\)/);
  assert.match(caminho, /fornecedores_favoritos_id: fornecedor\?\.id/);
  assert.match(caminho, /fornecedor_nome: nullableText\(fornecedor\?\.nome_completo\)/);
  assert.match(caminho, /escopo_financeiro: 'CAIXA_SHARE'/);
});

test("programar reembolso grava data, status, fornecedor, subcategoria e chaves únicas estáveis", () => {
  const inicio = kernel.indexOf("export async function programarReciboReembolso(");
  const fim = kernel.indexOf("export async function emitirReciboColaborador(", inicio);
  const caminho = kernel.slice(inicio, fim);
  assert.match(caminho, /data_emissao: data, data_vencimento: vencimento, status: 'EM_ABERTO'/);
  assert.match(caminho, /escopo_financeiro: 'FINANCEIRO'/);
  assert.match(caminho, /const fornecedor = await buscarFornecedor\(db, fornecedorId\)/);
  assert.match(caminho, /fornecedores_favoritos_id: fornecedor\?\.id/);
  assert.match(caminho, /subcategoria_1: nullableText\(body\.subcategoria_1\)/);
  assert.match(caminho, /idempotency_key: `recibo-reembolso-cliente:\$\{receiptId\}`/);
  assert.match(caminho, /idempotency_key: `recibo-reembolso-cliente:\$\{receiptId\}:CONTA_RECEBER`/);
  assert.match(caminho, /catch \(error\)[\s\S]*SELECT id, conta_receber_id, lancamento_origem_id, lancamento_cliente_id[\s\S]*idempotent: true/);
  assert.match(migration, /CREATE UNIQUE INDEX idx_lancamentos_recibo_reembolso_cliente_idempotencia/);
  assert.match(migration, /CREATE UNIQUE INDEX idx_contas_areceber_recibo_reembolso_idempotencia/);
});

test("programação de reembolso vincula rateio ao lançamento cliente e transfere rateio Share antigo", () => {
  const inicio = routes.indexOf("recibosRoutes.post('/recibos/:id/programar-contas-apagar'");
  const fim = routes.indexOf("recibosRoutes.post('/recibos/:id/cancelar'", inicio);
  const caminho = routes.slice(inicio, fim);
  assert.match(caminho, /const reembolso = await programarReciboReembolso/);
  assert.match(caminho, /SELECT id, tipo_recibo, status, categoria_movimentacao_id, categoria_nome FROM recibos WHERE id = \?/);
  assert.doesNotMatch(caminho, /receiptInicial\[campo\]/);
  assert.match(caminho, /reembolso\.lancamento_share_id \?\? reembolso\.lancamento_origem_id/);
  assert.match(caminho, /const lancamentoClienteId = String\(reembolso\.lancamento_cliente_id \?\? ''\)/);
  assert.match(caminho, /if \(!lancamentoClienteId\) return c\.json\(\{ error: 'lancamento_cliente_do_reembolso_nao_encontrado' \}, 409\)/);
  assert.doesNotMatch(caminho, /const lancamentoClienteRateioId = lancamentoClienteId \|\| lancamentoId/);
  assert.match(caminho, /SELECT id, lancamento_id, numero_recibo,[\s\S]*FROM recibos/);
  assert.match(caminho, /SET lancamento_id = \?, fornecedor_id = \?, numero_recibo = \?, url_recibo = \?/);
  assert.match(caminho, /lancamentoClienteRateioId, aeronaveId/);
  assert.match(caminho, /fornecedor_id, numero_recibo, url_recibo/);
  assert.match(caminho, /INSERT INTO contas_apagar \(id, data_vencimento, valor_centavos, categoria_id, categoria_nome, descricao, aeronave_id, lancamentos_id, boleto_url, nf_url, criado_por, origem_tipo, idempotency_key, status, fornecedor_id, escopo_financeiro\)/);
  assert.doesNotMatch(caminho, /INSERT INTO contas_apagar \([^)]*subcategoria_/);
  assert.match(caminho, /escopo_financeiro\) VALUES[\s\S]*'CAIXA_SHARE'/);
});

test("baixa de reembolso transfere rateios legados Share para o lançamento cliente sem duplicá-los", () => {
  assert.match(settleReceivable, /nullableText\(reimbursement\.lancamento_cliente_id\) \?\? nullableText\(/);
  assert.match(settleReceivable, /const rateiosLegadosShare = reimbursement && rateioLancamentoId && !\(rateios\.results \|\| \[\]\)\.length && nullableText\(reimbursement\.lancamento_origem_id\)/);
  assert.match(settleReceivable, /FROM rateio_despesas WHERE lancamento_id = \? AND status NOT IN \('CANCELADO'\)[\s\S]*bind\(reimbursement\.lancamento_origem_id\)/);
  assert.match(settleReceivable, /if \(rateiosLegadosShare\.results\?\.length\) rateios = rateiosLegadosShare/);
  assert.match(settleReceivable, /UPDATE rateio_despesas SET lancamento_id = \? WHERE id = \? AND lancamento_id = \?/);
  const rateiosLegadosSelecionados = settleReceivable.indexOf('if (rateiosLegadosShare.results?.length) rateios = rateiosLegadosShare');
  const transferenciaEnfileirada = settleReceivable.indexOf('for (const rateio of rateiosLegadosShare.results || [])');
  const validacaoRateio = settleReceivable.indexOf("if (!rateios.results.length) throw new FinanceError('Obrigação sem rateio vinculado.");
  assert.ok(rateiosLegadosSelecionados >= 0 && transferenciaEnfileirada > rateiosLegadosSelecionados);
  assert.ok(validacaoRateio > transferenciaEnfileirada);
  assert.match(settleReceivable, /SELECT id, valor_rateado_centavos, valor_pago_real_centavos FROM rateio_despesas WHERE lancamento_id = \?/);
  assert.match(settleReceivable, /existingByRateio\.set\(String\(rateio\.id\), paid\)/);
});

test("histórico reconhece rateio de recibo sem depender de um lançamento espelho", () => {
  assert.match(routes, /INNER JOIN lancamentos l ON l\.id = rd\.lancamento_id/);
  assert.doesNotMatch(routes, /FROM rateio_despesas WHERE origem_tipo = 'RECIBO' AND origem_id/);
  assert.match(routes, /FROM recibo_rateio/);
});

test("respostas de recibo normalizam tipo_caixa para o contrato público", () => {
  assert.match(routes, /function normalizarTipoCaixaRecibo\(value: unknown, pagadorTipo\?: unknown\): 'SHARE' \| 'CLIENTE' \| 'HOLDING'/);
  assert.match(routes, /tipo_caixa: normalizarTipoCaixaRecibo\(recibo\.tipo_caixa, recibo\.pagador_tipo\)/);
  assert.match(kernel, /tipo_caixa: \['cotista_aeronave', 'cliente'\]\.includes\(input\.pagador_tipo\) \? 'CLIENTE' : 'SHARE'/);
});
