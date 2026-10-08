import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const routes = await readFile(new URL('../src/routes/gestorContratosRoutes.ts', import.meta.url), 'utf8')
const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')

test('rotas de contratos aceitam somente admin e gestor master, sem financeiro master', () => {
  assert.match(routes, /const papeisPermitidos = \['admin', 'administrador', 'gestor_master', 'gestormaster'\]/)
  assert.match(routes, /usuarioTemPapel\(c\.env\.SHARE_DB, user\.id, papeisPermitidos\)/)
  assert.doesNotMatch(routes, /financeiro_master|financeiromaster/)
  assert.match(worker, /app\.route\('\/api\/gestor\/contratos', gestorContratosRoutes\)/)
})

test('contrato e partes são salvos juntos usando as tabelas D1 existentes', () => {
  assert.match(routes, /INSERT INTO contratos \(/)
  assert.match(routes, /INSERT INTO contrato_partes \(/)
  assert.match(routes, /DELETE FROM contrato_partes WHERE contrato_id = \?/)
  assert.match(routes, /await db\.batch\(\[comandoContrato, \.\.\.comandosPartes\]\)/)
  assert.match(routes, /UPDATE contratos SET numero =/)
})

test('anexos privados usam R2 e também a tabela de anexos de cotista quando aplicável', () => {
  assert.match(routes, /salvarArquivoShareBrasil\(c, auth\.user\.id, arquivo, 'contratos'\)/)
  assert.match(routes, /INSERT INTO contrato_anexos/)
  assert.match(routes, /INSERT INTO contrato_cotista/)
  assert.match(routes, /gestorContratosRoutes\.get\('\/:id\/anexos\/:anexoId'/)
  assert.match(routes, /chaveStorageDeUrl\(anexo\.url\)/)
})

test('vínculo de colaborador referencia contrato de trabalho existente sem criar novo vínculo', () => {
  assert.match(routes, /contratos_trabalho ct/)
  assert.match(routes, /ct\.id AS contratos_trabalho_id/)
  assert.doesNotMatch(routes, /INSERT INTO contratos_trabalho|UPDATE contratos_trabalho/)
})
