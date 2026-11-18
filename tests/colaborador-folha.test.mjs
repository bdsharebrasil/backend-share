import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
const listStart = worker.indexOf("app.get('/api/colaborador/folha-pagamento'");
const fileStart = worker.indexOf("app.get('/api/colaborador/folha-pagamento/anexos'");
const profileStart = worker.indexOf("app.get('/api/colaborador/perfil'");
const listRoute = worker.slice(listStart, fileStart);
const fileRoute = worker.slice(fileStart, profileStart);

test('folha do colaborador usa sessão autenticada e retorna somente linhas do próprio user_id', () => {
  assert.notEqual(listStart, -1);
  assert.match(listRoute, /authenticatedColaborador\(c\)/);
  assert.match(listRoute, /FROM pagamentos_folha WHERE user_id = \?1/);
  assert.match(listRoute, /holerite_url: arquivo\(row\.holerite_url\)/);
});

test('anexos de folha exigem que o arquivo pertença ao colaborador autenticado', () => {
  assert.notEqual(fileStart, -1);
  assert.match(fileRoute, /match\[4\] !== colaborador\.id/);
  assert.match(fileRoute, /WHERE user_id = \?1/);
  assert.match(fileRoute, /pertenceAoPagamento/);
});
