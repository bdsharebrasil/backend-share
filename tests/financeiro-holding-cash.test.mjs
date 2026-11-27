import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routes = await readFile(new URL('../src/financeiro/movimentosHoldingRoutes.ts', import.meta.url), 'utf8');
const financeiro = await readFile(new URL('../src/financeiroRoutes.ts', import.meta.url), 'utf8');
const kernel = await readFile(new URL('../src/financeiro/FinanceiroKernel.ts', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../src/financeiro/dashboardCotistaRoutes.ts', import.meta.url), 'utf8');

test('criação de movimento Holding grava no caixa HOLD e aceita os fluxos financeiros próprios', () => {
  assert.match(routes, /post\('\/movimentos-holding'/);
  assert.match(routes, /\['ENTRADA', 'SAIDA', 'APORTE', 'ESTORNO', 'REEMBOLSO'\]\.includes\(fluxo\)/);
  assert.match(routes, /INSERT INTO movimentos_holding[\s\S]*VALUES \(\?, \?, \?, \?, 'HOLD'/);
  assert.match(routes, /data_emissao, data_vencimento, periodicidade, descricao, numero_doc/);
  assert.match(routes, /nullable\(body\.numero_doc\)/);
  assert.match(routes, /const periodicidade = text\(body\.periodicidade \?\? 'ÚNICO'\)/);
  assert.match(routes, /periodicidadesValidas\.includes\(periodicidade\)/);
  assert.match(routes, /fornecedor_id, fornecedor_nome, categoria_id, categoria_nome/);
  assert.match(routes, /INSERT INTO rateio_hold[\s\S]*\(id, movimento_id,/);
  assert.match(routes, /rateio_nao_confere_com_movimento/);
});

test('fornecedor é validado contra fornecedores_favoritos e nome é resolvido pelo cadastro', () => {
  assert.match(routes, /FROM fornecedores_favoritos WHERE id = \? LIMIT 1/);
  assert.match(routes, /COALESCE\(NULLIF\(TRIM\(mh\.fornecedor_nome\), ''\), NULLIF\(TRIM\(ff\.apelido\), ''\), ff\.nome_completo\) AS fornecedor_nome/);
  assert.match(routes, /fornecedor_holding_invalido/);
});

test('baixa converte entradas em RECEBIDO e saídas em PAGO e aceita somente conta da mesma Holding', () => {
  assert.match(routes, /const statusFinal = entrada \? 'RECEBIDO' : 'PAGO'/);
  assert.match(routes, /UPPER\(tipo_caixa\) = 'HOLDING' AND ativo = 1/);
  assert.match(routes, /conta\.holding_id !== movimento\.holding_id/);
  assert.match(routes, /SET status = \?, data_pagamento = \?, conta_bancaria_id = \?/);
  assert.ok(routes.includes('UPDATE rateio_hold SET status = ?, data_pagamento = ?, valor_pago_real_centavos = valor_rateado_centavos, atualizado_em = CURRENT_TIMESTAMP WHERE movimento_id = ?'));
});

test('documento e comprovante Holding são atualizáveis separadamente e o comprovante anterior não é apagado na baixa', () => {
  assert.match(financeiro, /if \(origem === 'movimentos_holding'\)[\s\S]*\['numero_doc', 'url_doc', 'comprovante_url'\]/);
  assert.match(routes, /comprovante_url = COALESCE\(\?, comprovante_url\)/);
  assert.match(routes, /mh\.numero_doc, mh\.url_doc, mh\.comprovante_url/);
  assert.match(kernel, /export async function settlePayable[\s\S]*?nullableText\(row\.comprovante_pagamento_url\)[\s\S]*?nullableText\(movimentoHolding\?\.comprovante_url\)[\s\S]*?nullableText\(lancamento\?\.comprovante_url\)/);
});

test('baixas posteriores Share preservam comprovantes já anexados separadamente do documento', () => {
  assert.match(kernel, /export async function settleShareExpense[\s\S]*?nullableText\(row\.comprovante_url\)/);
  assert.match(kernel, /export async function settleShareRevenue[\s\S]*?nullableText\(row\.comprovante_url\)/);
});

test('fila de pendências inclui entradas e saídas em aberto sem depender do rateio', () => {
  assert.match(routes, /UPPER\(mh\.fluxo\) IN \('SAIDA', 'ENTRADA', 'APORTE', 'ESTORNO', 'REEMBOLSO'\)/);
  assert.match(routes, /UPPER\(mh\.status\) IN \('EM_ABERTO', 'EM_ATRASO', 'AGUARDANDO_REEMBOLSO', 'ENTRADA', 'APORTE_MENSAL', 'RENDIMENTO_BANCARIO'\)/);
  assert.match(routes, /COALESCE\(mh\.pago_diretamente, 0\) = 0/);
});

test('extrato do dashboard retorna fornecedor, conta e valores do movimento Holding', () => {
  assert.match(dashboard, /mh\.fornecedor_id, COALESCE\(NULLIF\(TRIM\(mh\.fornecedor_nome\), ''\), NULLIF\(TRIM\(ff\.apelido\), ''\), ff\.nome_completo\) AS fornecedor_nome/);
  assert.match(dashboard, /LEFT JOIN fornecedores_favoritos ff ON ff\.id = mh\.fornecedor_id/);
  assert.match(dashboard, /contaBancaria: row\.conta_bancaria/);
  assert.match(dashboard, /fornecedor: row\.fornecedor_nome/);
});
