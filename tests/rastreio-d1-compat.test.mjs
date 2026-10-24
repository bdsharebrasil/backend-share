import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/routes/rastreioRoutes.ts', import.meta.url), 'utf8')

test('rastreio D1 tolera aeronave sem coluna icao_hex e mantém fallback por matrícula', () => {
  assert.match(source, /pragma_table_info\('aeronave'\)/)
  assert.match(source, /\?\s*'a\.icao_hex'\s*:\s*'NULL AS icao_hex'/)
  assert.match(source, /matriculas: emVoo\.map\(\(item\) => item\.matricula_registro\)/)
})

test('agendamento aprovado perto do horário só vira voo operacional com ADS-B recente e fora do solo', () => {
  assert.match(source, /= 'aprovada'[\s\S]*datetime\('now', '-6 hours'\)[\s\S]*datetime\('now', '\+2 hours'\)/)
  assert.match(source, /!rastreio\.no_solo && rastreio\.visto_ha_s !== null && rastreio\.visto_ha_s <= 30/)
  assert.match(source, /if \(item\.status_bruto === 'aprovada' && !confirmadoNoAr\) return null/)
})

test('consulta individual ADS-B aceita matrícula ou hex e preserva o formato ac do endpoint v2', () => {
  assert.match(source, /get\('\/api\/rastreio\/aeronave\/matricula\/:matricula'/)
  assert.match(source, /requireShareInternal\(c\)/)
  assert.match(source, /replace\(\/-\/g, ''\)\.trim\(\)\.toUpperCase\(\)/)
  assert.match(source, /hex: porHex \? \[identificador\] : \[\]/)
  assert.match(source, /matriculas: porHex \? \[\] : \[identificador\]/)
  assert.match(source, /return c\.json\(\{ ac: correspondentes\.map/)
})
