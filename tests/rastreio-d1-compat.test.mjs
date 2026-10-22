import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/routes/rastreioRoutes.ts', import.meta.url), 'utf8')

test('rastreio D1 tolera aeronave sem coluna icao_hex e mantém fallback por matrícula', () => {
  assert.match(source, /pragma_table_info\('aeronave'\)/)
  assert.match(source, /\?\s*'a\.icao_hex'\s*:\s*'NULL AS icao_hex'/)
  assert.match(source, /matriculas: emVoo\.map\(\(item\) => item\.matricula_registro\)/)
})
