import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/routes/portalRoutes.ts', import.meta.url), 'utf8');

test('dashboard da aeronave usa vínculo autenticado e as fontes D1 corretas', () => {
  assert.match(source, /portalRoutes\.get\('\/api\/portal\/aeronave\/:aeronaveId\/dashboard'/);
  assert.match(source, /FROM lancamentos_diario_bordo WHERE aeronave_id = \?1/);
  assert.match(source, /const rateioTable = user\.cliente_id \? 'rateio_despesas' : 'rateio_hold'/);
  assert.match(source, /const rateioJoin = user\.cliente_id \? 'JOIN cotista_aeronave ca ON ca\.id = r\.cotista_id' : ''/);
  assert.match(source, /a\.id = \?1 AND \(ca\.cliente_id = \?2 OR ca\.socio_id = \?3\)/);
});

test('dashboard calcula horas, pousos, custo-hora, meses e categorias no ano solicitado', () => {
  assert.match(source, /SUM\(COALESCE\(tempo_total, tempo_voo, 0\)\)/);
  assert.match(source, /SUM\(COALESCE\((?:l\.)?tempo_voo, 0\)\), 0\) AS tempo_voo_horas/);
  assert.match(source, /SUM\(COALESCE\(pousos_total, 0\)\)/);
  assert.match(source, /custoHoraCentavos: aeronaveResumo\.custo_hora_centavos/);
  assert.match(source, /custoHoraCotistaCentavos: cotaResumo\.custo_hora_centavos/);
  assert.match(source, /custoTotalAeronaveCentavos: custoCentavos/);
  assert.match(source, /custoCotistaCentavos: cotaResumo\.total_centavos/);
  assert.match(source, /minutos_operacionais \/ 60/);
  assert.match(source, /GROUP BY mes ORDER BY mes/);
  assert.match(source, /GROUP BY categoria ORDER BY valor_centavos DESC/);
});

test('destinos excluem o aeródromo base e o dashboard calcula uso da participação', () => {
  assert.match(source, /UPPER\(TRIM\(COALESCE\(NULLIF\(l\.aerodromo_chegada/);
  assert.match(source, /TRIM\(COALESCE\(a\.base, ''\)\) = '' OR/);
  assert.match(source, /percentualUso = horas > 0/);
  assert.match(source, /diferencaPontos/);
});

test('projeção usa categorias fixas, variáveis, extras e combustível dos rateios da cota autenticada', () => {
  assert.match(source, /const rateioOwner = user\.cliente_id \? 'ca\.id = \?2' : 'r\.socio_id = \?2'/);
  assert.match(source, /AND \$\{rateioOwner\} AND UPPER\(COALESCE\(r\.status, ''\)\) NOT IN/);
  assert.match(source, /cotaResumo\.grupos\.fixos\.valor_centavos/);
  assert.match(source, /cotaResumo\.grupos\.variaveis\.valor_centavos/);
  assert.match(source, /cotaResumo\.grupos\.extras\.valor_centavos/);
  assert.match(source, /cotaResumo\.grupos\.nao_classificados\.valor_centavos/);
  assert.doesNotMatch(source, /UPPER\(r\.tipo_rateio\) = 'FIXO'/);
  assert.match(source, /combustivelCentavos: espelho\.combustivel_cotista_centavos/);
});

test('dashboard rejeita aeronave não vinculada', () => {
  assert.match(source, /if \(!vinculo\) return c\.json\(\{ error: 'aeronave_nao_vinculada' \}, 404\)/);
});
