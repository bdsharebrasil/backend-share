import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/routes/portalRoutes.ts', import.meta.url), 'utf8');

test('visão geral exige sessão e consulta próximo voo e diário de bordo', () => {
  assert.match(source, /portalRoutes\.get\('\/api\/portal\/overview'/);
  assert.match(source, /const user = await portalSession\(c\)/);
  assert.match(source, /FROM solicitacoes_reserva_voo s/);
  assert.match(source, /FROM lancamentos_diario_bordo l/);
});

test('visão geral restringe voos e rateios ao cliente ou sócio autenticado', () => {
  assert.match(source, /ca\.cliente_id = \?1 OR ca\.socio_id = \?2/);
  assert.match(source, /const rateioTable = user\.cliente_id \? 'rateio_despesas' : 'rateio_hold'/);
  assert.match(source, /const rateioOwner = user\.cliente_id/);
});

test('visão geral calcula saldo aberto e custo do mês sem dados fictícios', () => {
  assert.match(source, /acc\.mesCentavos \+= esperado/);
  assert.match(source, /abertoCentavos: resumo\.totalCentavos - resumo\.pagoCentavos/);
  assert.match(source, /voosRecentes: voosRecentes\.results \|\| \[\]/);
});
