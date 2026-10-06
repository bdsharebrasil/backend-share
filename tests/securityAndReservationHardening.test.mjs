import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const worker = fs.readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
const portal = fs.readFileSync(new URL('../src/routes/portalRoutes.ts', import.meta.url), 'utf8')
const storage = fs.readFileSync(new URL('../src/lib/storage.ts', import.meta.url), 'utf8')

test('short links usam código hexadecimal de 16 bytes e cabeçalhos defensivos', () => {
  assert.match(worker, /new Uint8Array\(16\)/)
  assert.match(worker, /Content-Disposition/)
  assert.match(worker, /X-Content-Type-Options.*nosniff/)
  assert.match(worker, /\^\[a-f0-9\]\{32\}\$/i)
})

test('short links forçam download e não renderizam HTML ou SVG no domínio da API', () => {
  const start = worker.indexOf("app.get('/r/:code'")
  const end = worker.indexOf('\nfunction normalizarEmailLocal', start)
  const route = worker.slice(start, end)

  assert.notEqual(start, -1)
  assert.match(route, /Content-Disposition.*attachment/)
  assert.doesNotMatch(route, /Content-Disposition.*inline/)
})

test('upload valida pasta e impede segmentos arbitrários', () => {
  assert.match(storage, /normalizarPastaUpload/)
  assert.match(storage, /segment => !\/\^\[a-zA-Z0-9_-\]\+\$\/.test\(segment\)/)
  assert.match(worker, /Pasta inválida/)
})

test('reserva de hotel exige usuário autenticado e não aceita userId do corpo', () => {
  assert.match(worker, /app\.post\('\/api\/hotel-reservation'/)
  assert.match(worker, /requireAuthenticatedUser\(c\)/)
  assert.match(worker, /user_id: authenticatedUserId/)
  assert.doesNotMatch(worker, /user_id: body\.userId/)
})

test('portal restringe aeronave ao vínculo, aplica limites e verifica sobreposição', () => {
  assert.match(portal, /JOIN cotista_aeronave ca ON ca\.aeronave_id = a\.id/)
  assert.match(portal, /MAX_RESERVATION_DAYS = 30/)
  assert.match(portal, /MAX_RESERVATION_PASSENGERS = 20/)
  assert.match(portal, /dataAgendada < hoje/)
  assert.match(portal, /aeronave_indisponivel_no_periodo/)
  assert.match(portal, /status IN \('pendente', 'aprovada'\)/)
})

test('todas as entradas ROTAER passam pelo rate limit AISWEB', () => {
  assert.match(fs.readFileSync(new URL('../src/routes/aiswebRoutes.ts', import.meta.url), 'utf8'), /async function getRotaer[\s\S]*requireAiswebRateLimit\(c\)/)
})
