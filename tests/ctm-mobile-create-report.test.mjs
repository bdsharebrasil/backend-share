import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const routes = await readFile(new URL('../src/routes/ctmRoutes.ts', import.meta.url), 'utf8')
const migration = await readFile(new URL('../migrations/20261119_ctm_reports_mobile.sql', import.meta.url), 'utf8')
const list = routes.slice(routes.indexOf("ctmRoutes.get('/api/ctm/relatorios-manutencao'"), routes.indexOf("ctmRoutes.post('/api/ctm/relatorios-manutencao'"))
const create = routes.slice(routes.indexOf("ctmRoutes.post('/api/ctm/relatorios-manutencao'"), routes.indexOf('for (const [slug', routes.indexOf("ctmRoutes.post('/api/ctm/relatorios-manutencao'")))

test('listagem mantém legados e novos reports e utiliza alias SQL válido', () => {
  assert.match(list, /ctmRead\(c, 'relatorios_manutencao r'/)
  assert.match(list, /ctmRead\(c, 'ctm_reports_mobile r'/)
  assert.match(list, /mobileReports\.results/)
  assert.match(list, /report\.descricao/)
})

test('criação exige colaborador autenticado, valida aeronave e grava no D1', () => {
  assert.match(create, /shareBrasilUser\(c\)/)
  assert.match(create, /SELECT id FROM aeronave WHERE id = \?/)
  assert.match(create, /INSERT INTO ctm_reports_mobile/)
  assert.match(create, /user\.id, nome/)
  assert.match(create, /}, 201\)/)
})

test('migração adiciona tabela própria sem alterar relatórios existentes', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ctm_reports_mobile/)
  assert.match(migration, /REFERENCES aeronave\(id\)/)
  assert.match(migration, /REFERENCES user_profiles\(id\)/)
  assert.doesNotMatch(migration, /DROP TABLE|ALTER TABLE/i)
})
