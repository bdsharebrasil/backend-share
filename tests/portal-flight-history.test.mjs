import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/routes/portalRoutes.ts', import.meta.url), 'utf8')
const start = source.indexOf("portalRoutes.get('/api/portal/solicitacoes'")
const end = source.indexOf("portalRoutes.post('/api/portal/solicitacoes'", start)
const route = source.slice(start, end)

test('histórico usa tempo_voo dos lançamentos do dia agendado, sem somar tempo_total de outros dias', () => {
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  assert.match(route, /SUM\(voo\.tempo_voo\)\s*\*\s*60/)
  assert.match(route, /SELECT DISTINCT l\.id, l\.tempo_voo/)
  assert.match(route, /date\(l\.data_registro\)\s*=\s*date\(s\.data_agendada\)/)
  assert.doesNotMatch(route, /SUM\(l\.tempo_total\)/)
})
