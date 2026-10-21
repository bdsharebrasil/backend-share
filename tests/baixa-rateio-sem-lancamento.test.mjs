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

test('rateio referenciado por envio_despesas fornece contexto de pagamento direto sem lançamento Share', () => {
  assert.match(contexto, /SELECT id, tipo, status, descricao, aeronave_id FROM envio_despesas WHERE id = \?/);
  assert.match(contexto, /envio && upper\(envio\.tipo\) === 'CLIENTE'/);
  assert.match(contexto, /natureza: 'PAGAMENTO_DIRETO'/);
  assert.match(contexto, /envio_id: envio\.id/);
  assert.match(contexto, /rateio_despesas WHERE lancamento_id = \? AND COALESCE\(status, ''\) <> 'CANCELADO'/);
});

test('baixa direta de envio atualiza rateios e conclui envio somente quando todos estiverem pagos', () => {
  assert.match(baixaDireta, /updateStatement\(db, schema, 'rateio_despesas'/);
  assert.match(baixaDireta, /if \(lancamentoId\) statements\.push\(db\.prepare\(`UPDATE lancamentos SET/);
  assert.match(baixaDireta, /if \(envioId\) statements\.push\(db\.prepare\(`UPDATE envio_despesas SET status = 'CONCLUIDO'/);
  assert.match(baixaDireta, /AND NOT EXISTS \(SELECT 1 FROM rateio_despesas WHERE lancamento_id = \? AND COALESCE\(status, ''\) <> 'CANCELADO'/);
  assert.match(baixaDireta, /if \(p\.conta_bancaria_id\) throw new FinanceError\('Pagamento direto do cotista não utiliza uma conta bancária da Share'/);
});
