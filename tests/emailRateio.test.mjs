import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const emailRoutes = await readFile(new URL('../src/routes/emailsRoutes.ts', import.meta.url), 'utf8')
const routes = await readFile(new URL('../src/financeiro/dashboardShareRoutes.ts', import.meta.url), 'utf8')
const migration = await readFile(new URL('../migrations/20261005_rateios_email_enviado.sql', import.meta.url), 'utf8')

const marcador = emailRoutes.slice(emailRoutes.indexOf('async function marcarEmailEnviadoParaOrigens'), emailRoutes.indexOf('async function garantirTabelaEmails'))
const painel = routes.slice(routes.indexOf("dashboardShareRoutes.get('/dashboard/financeiro'"), routes.indexOf("dashboardShareRoutes.get('/share'"))

test('migrationa o timestamp de envio nas duas tabelas de rateio', () => {
  assert.match(migration, /ALTER TABLE rateio_despesas ADD COLUMN email_enviado_em TEXT;/i)
  assert.match(migration, /ALTER TABLE rateio_hold ADD COLUMN email_enviado_em TEXT;/i)
})

test('envio bem-sucedido propaga o timestamp para rateio_despesas e rateio_hold', () => {
  assert.match(marcador, /UPDATE rateio_despesas SET email_enviado_em = COALESCE\(email_enviado_em, \?\) WHERE lancamento_id = \?/)
  assert.match(marcador, /UPDATE rateio_hold SET email_enviado_em = COALESCE\(email_enviado_em, \?\) WHERE movimento_id = \?/)
})

test('dashboard retorna o timestamp da parcela rateada', () => {
  assert.match(painel, /rd\.email_enviado_em AS rateio_email_enviado_em/)
  assert.match(painel, /rh\.email_enviado_em AS rateio_email_enviado_em/)
  assert.match(painel, /email_enviado_em: row\.rateio_email_enviado_em \?\? row\.email_enviado_em \?\? null/)
})
