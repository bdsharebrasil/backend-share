import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allocateCentsByPercentages } from '../src/financeiro/FinanceiroKernel.ts';

const kernel = await readFile(new URL('../src/financeiro/FinanceiroKernel.ts', import.meta.url), 'utf8');
const directExpense = kernel.slice(
  kernel.indexOf('export async function createDirectExternalExpense('),
  kernel.indexOf('export async function ', kernel.indexOf('export async function createDirectExternalExpense(') + 1),
);

test('despesa de R$ 59,00 em três cotistas divide os centavos e conserva o total', () => {
  const valores = allocateCentsByPercentages(5900, [33.3333, 33.3333, 33.3334]);
  assert.deepEqual(valores, [1967, 1966, 1967]);
  assert.equal(valores.reduce((sum, value) => sum + value, 0), 5900);
});

test('pagamento direto mantém a responsabilidade por percentual e registra o total pago somente na linha do pagador', () => {
  assert.match(directExpense, /percentual:\s*line\.percentual/);
  assert.match(directExpense, /valor_centavos:\s*line\.valorCentavos/);
  assert.match(directExpense, /pago_por:\s*pagador/);
  assert.match(directExpense, /valor_pago_real_centavos:\s*ehPagador\s*\?\s*total\s*:\s*0/);
  assert.match(directExpense, /pago_diretamente:\s*ehPagador/);
});
