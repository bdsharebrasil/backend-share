import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/routes/portalRoutes.ts', import.meta.url), 'utf8');

test('dashboard da aeronave usa vínculo autenticado e as fontes D1 corretas', () => {
  assert.match(source, /portalRoutes\.get\('\/api\/portal\/aeronave\/:aeronaveId\/dashboard'/);
  assert.match(source, /FROM lancamentos_diario_bordo WHERE aeronave_id = \?1/);
  assert.match(source, /FROM rateio_despesas r JOIN cotista_aeronave ca ON ca\.id = r\.cotista_id/);
  assert.match(source, /a\.id = \?1 AND \(ca\.cliente_id = \?2 OR ca\.socio_id = \?3\)/);
});

test('dashboard calcula horas, pousos, custo-hora, meses e categorias no ano solicitado', () => {
  assert.match(source, /SUM\(COALESCE\(tempo_total, tempo_voo, 0\)\)/);
  assert.match(source, /SUM\(COALESCE\(pousos_total, 0\)\)/);
  assert.match(source, /custoHoraCentavos: horas > 0/);
  assert.match(source, /GROUP BY mes ORDER BY mes/);
  assert.match(source, /GROUP BY categoria ORDER BY valor_centavos DESC/);
});

test('dashboard rejeita aeronave não vinculada', () => {
  assert.match(source, /if \(!vinculo\) return c\.json\(\{ error: 'aeronave_nao_vinculada' \}, 404\)/);
});
