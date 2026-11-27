import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalog, xyzBbox } from '../src/routes/geoaiswebRoutes.ts'

const capabilities = `<?xml version="1.0"?><WMS_Capabilities version="1.1.1"><Capability><Request><GetMap><Format>image/png</Format></GetMap></Request><Layer><Title>GeoAISWEB</Title><SRS>EPSG:3857</SRS><Layer><Name>ais:ENRC_H9</Name><Title>ENRC HIGH H9</Title></Layer><Layer><Name>ais:ENRC_L4</Name><Title>ENRC LOW L4</Title></Layer><Layer><Name>ais:WAC_2946</Name><Title>WAC Belém</Title></Layer></Layer></Capability></WMS_Capabilities>`

test('descobre nomes ENRC-H e ENRC-L no catálogo sem fixar identificadores', () => {
  const catalog = parseCatalog(capabilities)
  assert.equal(catalog.supports3857, true)
  assert.deepEqual(catalog.layers.map(layer => [layer.name, layer.family]), [
    ['ais:ENRC_H9', 'alta'],
    ['ais:ENRC_L4', 'baixa'],
  ])
})

test('falha de forma segura quando o documento não é GetCapabilities WMS', () => {
  assert.throws(() => parseCatalog('<html>blocked</html>'), /documento WMS GetCapabilities válido/)
})

test('calcula a extensão mundial e o quadrante central em Web Mercator para XYZ', () => {
  const extent = 20037508.342789244
  assert.equal(xyzBbox(0, 0, 0), `${-extent},${-extent},${extent},${extent}`)
  const half = extent / 2
  assert.equal(xyzBbox(1, 1, 1), `0,${-extent},${extent},0`)
  assert.equal(half > 0, true)
})
