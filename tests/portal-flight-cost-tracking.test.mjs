import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/routes/portalRoutes.ts', import.meta.url), 'utf8');

test('simulador de voo possui POST autenticado e calcula custo com dados reais de rota/aeronave', () => {
  assert.match(source, /portalRoutes\.post\('\/api\/portal\/simulador\/voo'/);
  assert.match(source, /ca\.id = \(SELECT cotista_id FROM user_cliente WHERE id = \?4 LIMIT 1\)/);
  assert.match(source, /haversineKm\(origemCoord\.lat, origemCoord\.lon, destinoCoord\.lat, destinoCoord\.lon\) \/ 1\.852/);
  assert.match(source, /const consumoLitros = consumo \* tempoHoras/);
  assert.match(source, /const totalCentavos = Math\.round\(consumoLitros \* precoMedio \* 100\)/);
  assert.match(source, /preco_combustivel_indisponivel/);
});

test('rastreio limita acesso à aeronave vinculada e não retorna posição para outro cotista', () => {
  assert.match(source, /portalRoutes\.get\('\/api\/portal\/aeronave\/:aeronaveId\/rastreio'/);
  assert.match(source, /Cache-Control', 'private, no-store, no-cache, must-revalidate'/);
  assert.match(source, /if \(!isOwnFlight\) return c\.json\(\{ status: 'em_voo' \}\)/);
  assert.match(source, /return c\.json\(\{ status: 'em_voo', posicao: \{/);
  assert.match(source, /status: 'sem_voo'/);
  assert.doesNotMatch(source, /return c\.json\(\{[^\n]*rastreio: position/);
});
