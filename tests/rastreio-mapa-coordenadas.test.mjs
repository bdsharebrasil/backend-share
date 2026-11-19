import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { coordenadaAerodromo } from '../src/routes/rastreioRoutes.ts'

test('rastreio aceita latitude/longitude decimal do D1', () => {
  assert.deepEqual(coordenadaAerodromo('-15.6,-56.3'), { lat: -15.6, lon: -56.3 })
  assert.deepEqual(coordenadaAerodromo('-15.6 -56.3'), { lat: -15.6, lon: -56.3 })
  assert.deepEqual(coordenadaAerodromo('{"lat":-15.6,"lng":-56.3}'), { lat: -15.6, lon: -56.3 })
  assert.deepEqual(coordenadaAerodromo({ latitude: -15.6, longitude: -56.3 }), { lat: -15.6, lon: -56.3 })
})

test('rastreio interpreta GMS com hemisférios S e W', () => {
  const valor = coordenadaAerodromo("15° 36' 00\"S, 056° 18' 00\"W")
  assert.ok(valor)
  assert.equal(valor.lat, -15.6)
  assert.equal(valor.lon, -56.3)
})

test('não aceita coordenadas inválidas', () => {
  assert.equal(coordenadaAerodromo('informação inválida'), null)
  assert.equal(coordenadaAerodromo('95,-56'), null)
  assert.equal(coordenadaAerodromo('{"lat":10,"lng":220}'), null)
})

test('coordenadas reais do banco são usadas também quando o ADS-B está indisponível', async () => {
  const source = await readFile(new URL('../src/routes/rastreioRoutes.ts', import.meta.url), 'utf8')
  assert.match(source, /resultado\.set\(row\.icao, coordenadaAerodromo\(row\.coordenadas\)\)/)
  assert.match(source, /origem_coord: origem \? coordenadas\.get\(origem\) \?\? null/)
  assert.match(source, /destino_coord: destino \? coordenadas\.get\(destino\) \?\? null/)
})
