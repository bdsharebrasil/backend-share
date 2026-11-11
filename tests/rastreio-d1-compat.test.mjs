import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { statusOperacaoRastreio } from '../src/routes/rastreioRoutes.ts'

const source = await readFile(new URL('../src/routes/rastreioRoutes.ts', import.meta.url), 'utf8')

test('rastreio D1 tolera aeronave sem coluna icao_hex e mantém fallback por matrícula', () => {
  assert.match(source, /pragma_table_info\('aeronave'\)/)
  assert.match(source, /\?\s*'a\.icao_hex'\s*:\s*'NULL AS icao_hex'/)
  assert.match(source, /matriculas: emVoo\.map\(\(item\) => item\.matricula_registro\)\.filter\(Boolean\)/)
})

test('ADS-B recente identifica voo sem AC/DEP e também após status de solo desatualizado', () => {
  const noAr = { no_solo: false, visto_ha_s: 8 }
  const solo = { no_solo: true, visto_ha_s: 5 }
  const desatualizado = { no_solo: false, visto_ha_s: 45 }
  assert.equal(statusOperacaoRastreio('aprovada', noAr), 'em_voo')
  assert.equal(statusOperacaoRastreio('acionado', noAr), 'em_voo')
  assert.equal(statusOperacaoRastreio('em_solo', noAr), 'em_voo')
  assert.equal(statusOperacaoRastreio('acionado', solo), 'em_solo')
  assert.equal(statusOperacaoRastreio('acionado', desatualizado), 'acionado')
  assert.equal(statusOperacaoRastreio('aprovada', null), 'aguardando')
  assert.equal(statusOperacaoRastreio('encerrada', noAr), 'encerrada')
})

test('consulta individual ADS-B aceita matrícula ou hex e preserva o formato ac do endpoint v2', () => {
  assert.match(source, /get\('\/api\/rastreio\/aeronave\/matricula\/:matricula'/)
  assert.match(source, /requireShareInternal\(c\)/)
  assert.match(source, /replace\(\/-\/g, ''\)\.trim\(\)\.toUpperCase\(\)/)
  assert.match(source, /hex: porHex \? \[identificador\] : \[\]/)
  assert.match(source, /matriculas: porHex \? \[\] : \[identificador\]/)
  assert.match(source, /return c\.json\(\{ ac: correspondentes\.map/)
})

