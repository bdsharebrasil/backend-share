import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { test } from 'node:test'
import { criarV1Routes } from '../src/routes/v1Routes.ts'

function criarD1Fake(linhas) {
  const chamadas = []
  return {
    chamadas,
    prepare(sql) {
      const registro = { sql, binds: [] }
      chamadas.push(registro)
      return {
        bind(...args) {
          registro.binds = args
          return this
        },
        async all() {
          return { results: linhas }
        },
        async first() {
          return linhas[0] ?? null
        },
        async run() {
          return { success: true }
        },
      }
    },
  }
}

function aerodromo(icao, nome = `Aeroporto ${icao}`) {
  return { id: `id-${icao}`, nome, designativo_icao: icao, coordenadas: '-23.4,-46.5' }
}

function montarV1({ linhas = [], legado } = {}) {
  const db = criarD1Fake(linhas)
  const app = new Hono()
  app.route('/api/v1', criarV1Routes(legado ?? new Hono()))
  return { app, db, env: { SHARE_DB: db } }
}

function decodificarCursor(cursor) {
  const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/')
  return atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
}

test('v1/aerodromos devolve apenas os campos do contrato e limita a 20 por página', async () => {
  const linhas = Array.from({ length: 21 }, (_, indice) => aerodromo(`SB${String(indice).padStart(2, '0')}`))
  const { app, db, env } = montarV1({ linhas })

  const resposta = await app.fetch(new Request('https://api.share-brasil.com/api/v1/aerodromos?q=sb'), env)
  assert.equal(resposta.status, 200)

  const corpo = await resposta.json()
  assert.equal(corpo.data.length, 20)
  assert.deepEqual(Object.keys(corpo.data[0]).sort(), ['coordenadas', 'designativo_icao', 'id', 'nome'])
  assert.equal(decodificarCursor(corpo.next_cursor), 'SB19')

  const [{ sql, binds }] = db.chamadas
  assert.match(sql, /upper\(designativo_icao\) LIKE \?2 ESCAPE/i)
  assert.match(sql, /upper\(nome\) LIKE \?2 ESCAPE/i)
  assert.deepEqual(binds, ['sb', '%SB%', '', 21])
})

test('v1/aerodromos pagina por cursor sem repetir registros', async () => {
  const { app, db, env } = montarV1({ linhas: [aerodromo('SBGR'), aerodromo('SBSP')] })
  const cursor = Buffer.from('SBGR').toString('base64url')

  const resposta = await app.fetch(
    new Request(`https://api.share-brasil.com/api/v1/aerodromos?cursor=${cursor}`, {}),
    env,
  )
  assert.equal(resposta.status, 200)
  const corpo = await resposta.json()
  assert.equal(corpo.next_cursor, null)

  const [{ binds }] = db.chamadas
  assert.deepEqual(binds, ['', '%%', 'SBGR', 21])
})

test('v1/aerodromos rejeita cursor inválido com 400', async () => {
  const { app, env } = montarV1()
  const resposta = await app.fetch(new Request('https://api.share-brasil.com/api/v1/aerodromos?cursor=%%%'), env)
  assert.equal(resposta.status, 400)
  assert.deepEqual(await resposta.json(), { error: 'cursor_invalido' })
})

test('v1/aerodromos respeita o teto de 50 itens e o padrão de 20', async () => {
  const { app, db, env } = montarV1()

  await app.fetch(new Request('https://api.share-brasil.com/api/v1/aerodromos?limit=999'), env)
  assert.equal(db.chamadas.at(-1).binds.at(-1), 51)

  await app.fetch(new Request('https://api.share-brasil.com/api/v1/aerodromos?limit=abc'), env)
  assert.equal(db.chamadas.at(-1).binds.at(-1), 21)
})

test('v1/aerodromos escapa curingas do LIKE', async () => {
  const { app, db, env } = montarV1()
  await app.fetch(new Request('https://api.share-brasil.com/api/v1/aerodromos?q=100%25'), env)
  assert.equal(db.chamadas.at(-1).binds[1], '%100\\%%')
})

test('v1/weather e v1/flightplan reencaminham para as rotas legadas', async () => {
  const legado = new Hono()
  legado.get('/api/weather/:icao', c => c.json({ loc: c.req.param('icao').toUpperCase(), metar: 'SBGR 201800Z' }))
  legado.get('/api/flightplan', c => c.json({ adep: c.req.query('adep'), ades: c.req.query('ades') }))

  const { app, env } = montarV1({ legado })

  const clima = await app.fetch(new Request('https://api.share-brasil.com/api/v1/weather/sbgr'), env)
  assert.equal(clima.status, 200)
  assert.deepEqual(await clima.json(), { loc: 'SBGR', metar: 'SBGR 201800Z' })

  const plano = await app.fetch(
    new Request('https://api.share-brasil.com/api/v1/flightplan?adep=SBGR&ades=SBSP&reserve=30'),
    env,
  )
  assert.equal(plano.status, 200)
  assert.deepEqual(await plano.json(), { adep: 'SBGR', ades: 'SBSP' })
})
