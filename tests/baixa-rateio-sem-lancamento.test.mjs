import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const kernel = await readFile(new URL('../src/financeiro/FinanceiroKernel.ts', import.meta.url), 'utf8');
const contexto = kernel.slice(
  kernel.indexOf('export async function contextoBaixaCotista('),
  kernel.indexOf('export async function settleCotista(', kernel.indexOf('export async function contextoBaixaCotista(')),
);
const baixaDireta = kernel.slice(
  kernel.indexOf('export async function settleCotista('),
  kernel.indexOf('function receiptReplayMatches(', kernel.indexOf('export async function settleCotista(')),
);

test('rateio sem lançamento pai fornece contexto de pagamento direto usando seus próprios dados', () => {
  assert.match(contexto, /if \(!lancamento && allocation && !nullableText\(allocation\.lancamento_id\)\)/);
  assert.match(contexto, /natureza: 'PAGAMENTO_DIRETO'/);
  assert.match(contexto, /descricao: allocation\.descricao_despesa, aeronave_id: allocation\.aeronave_id/);
  assert.match(contexto, /rateios: \[allocation\]/);
});

test('baixa de rateio sem lançamento pai atualiza somente o rateio, sem tentar alterar o caixa Share', () => {
  assert.match(baixaDireta, /const lancamentoId = nullableText\(lancamento\.id\)/);
  assert.match(baixaDireta, /UPDATE rateio_despesas SET|updateStatement\(db, schema, 'rateio_despesas'/);
  assert.match(baixaDireta, /if \(lancamentoId\) statements\.push\(db\.prepare\(`UPDATE lancamentos SET/);
  assert.match(baixaDireta, /if \(p\.conta_bancaria_id\) throw new FinanceError\('Pagamento direto do cotista não utiliza uma conta bancária da Share'/);
});
