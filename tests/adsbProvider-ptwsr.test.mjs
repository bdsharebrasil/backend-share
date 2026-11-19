import assert from 'node:assert/strict'
import test from 'node:test'
import { buscarPosicoes, configurarProvedor, normalizarMatricula, variantesMatricula, provedorIndisponivel } from '../src/lib/adsbProvider.ts'

test('matrícula brasileira permite formato com e sem hífen', () => {
  assert.equal(normalizarMatricula(' PT-WSR '), 'PTWSR')
  assert.deepEqual(variantesMatricula('ptwsr'), ['PT-WSR', 'PTWSR'])
  assert.deepEqual(variantesMatricula('PR-LRM'), ['PR-LRM', 'PRLRM'])
})

test('PT-WSR é localizada pelo callsign quando cadastro da matrícula não tem resultado', async () => {
  configurarProvedor('airplanes_live')
  const anterior = globalThis.fetch
  const consultas = []
  globalThis.fetch = async (url) => {
    consultas.push(String(url))
    if (String(url).includes('/v2/callsign/PTWSR')) return Response.json({
      ac: [{ hex: 'E0AB11', flight: 'PTWSR ', lat: -15.7, lon: -56.1, alt_baro: 12000, seen_pos: 3 }],
    })
    return Response.json({ ac: [] })
  }
  try {
    const posicoes = await buscarPosicoes({ hex: [], matriculas: ['PT-WSR'] })
    assert.equal(posicoes.length, 1)
    assert.equal(posicoes[0].hex, 'E0AB11')
    assert.equal(posicoes[0].callsign, 'PTWSR')
    assert.equal(posicoes[0].fonte, 'airplanes_live')
    assert.equal(provedorIndisponivel(), false)
    assert.ok(consultas.some((url) => url.includes('/v2/reg/PT-WSR%2CPTWSR')), 'consulta duas variantes na mesma chamada')
    assert.ok(consultas.some((url) => url.includes('/v2/callsign/PTWSR')), 'consulta callsign quando falta registro')
    assert.ok(!consultas.some((url) => url.includes('adsb.lol')), 'não gasta cota do segundo provedor se a posição já existe')
  } finally { globalThis.fetch = anterior }
})

test('resposta válida mas vazia no primeiro provedor tenta o segundo', async () => {
  configurarProvedor('airplanes_live')
  const anterior = globalThis.fetch
  const consultas = []
  globalThis.fetch = async (url) => {
    const endereco = String(url)
    consultas.push(endereco)
    if (endereco.includes('adsb.lol/v2/reg/')) return Response.json({
      ac: [{ hex: 'E0AB12', r: 'PT-WSX', flight: 'PTWSX ', lat: -15.6, lon: -56.2, alt_baro: 17000, seen_pos: 2 }],
    })
    return Response.json({ ac: [] })
  }
  try {
    const posicoes = await buscarPosicoes({ hex: [], matriculas: ['PT-WSX'] })
    assert.equal(posicoes.length, 1)
    assert.equal(posicoes[0].fonte, 'adsb_lol')
    assert.equal(provedorIndisponivel(), false)
    assert.ok(consultas.some((url) => url.includes('airplanes.live/v2/reg/')))
    assert.ok(consultas.some((url) => url.includes('adsb.lol/v2/reg/')))
  } finally { globalThis.fetch = anterior }
})

test('HTTP 429 na fonte primária não impede a outra fonte, nem confunde posição de outra aeronave', async () => {
  configurarProvedor('airplanes_live')
  const anterior = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('airplanes.live')) return new Response('rate limit', { status: 429 })
    return Response.json({
      ac: [
        { hex: 'E0AB13', flight: 'PTWSY', lat: -15.5, lon: -56.3, alt_baro: 16000, seen_pos: 1 },
        { hex: 'E0AB14', flight: 'OUTRO', r: 'PT-ABC', lat: -15.5, lon: -56.3, seen_pos: 1 },
      ],
    })
  }
  try {
    const posicoes = await buscarPosicoes({ hex: [], matriculas: ['PT-WSY'] })
    assert.deepEqual(posicoes.map((item) => item.hex), ['E0AB13'])
    assert.equal(provedorIndisponivel(), false)
  } finally { globalThis.fetch = anterior }
})

test('resposta só com avião desatualizado não suprime tentativa na outra fonte', async () => {
  configurarProvedor('airplanes_live')
  const anterior = globalThis.fetch
  globalThis.fetch = async (url) => Response.json({
    ac: [{
      hex: 'E0AB15', r: 'PT-WST', lat: -15.8, lon: -56.3,
      alt_baro: 10000, seen_pos: String(url).includes('airplanes.live') ? 200 : 2,
    }],
  })
  try {
    const posicoes = await buscarPosicoes({ hex: [], matriculas: ['PT-WST'] })
    assert.equal(posicoes.length, 1)
    assert.equal(posicoes[0].fonte, 'adsb_lol')
    assert.ok(posicoes[0].visto_ha_s < 120)
  } finally { globalThis.fetch = anterior }
})
