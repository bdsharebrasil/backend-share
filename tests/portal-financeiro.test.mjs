import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/routes/portalRoutes.ts', import.meta.url), 'utf8');

test('financeiro do portal separa cliente e holding por sessão', () => {
  assert.match(source, /portalRoutes\.get\('\/api\/portal\/financeiro'/);
  assert.match(source, /FROM rateio_despesas r/);
  assert.match(source, /FROM rateio_hold r/);
  assert.match(source, /ca\.cliente_id = \?1/);
  assert.match(source, /ca\.socio_id = \?1/);
});

test('financeiro do portal calcula pago apenas com pagamentos confirmados e não aceita IDs do navegador', () => {
  assert.match(source, /const paymentTable = parcelasDoRateio\(user\.cliente_id \? 'rateio_despesas' : 'rateio_hold'\)/);
  assert.match(source, /FROM \$\{paymentTable\}/);
  assert.match(source, /UPPER\(COALESCE\(status, ''\)\) = 'CONFIRMADO'/);
  assert.match(source, /portalSession\(c\)/);
  assert.doesNotMatch(source, /c\.req\.query\('cotista_id'\)/);
});

test('financeiro do portal expõe somente status aberto ou pago', () => {
  assert.match(source, /THEN 'PAGO' ELSE 'EM_ABERTO'/);
  assert.match(source, /abertoCentavos/);
});
