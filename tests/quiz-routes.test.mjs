import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { VERSAO_QUIZ, recomendar } from '../src/quiz/modelo.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quizRoutes } from '../src/quizRoutes.ts'

const origin = 'https://conheca.share-brasil.com'
const options = {
  uso: 'familia', pax: '1-2', distancia: 'regional', horas: 'ate-3',
  pista: 'asfalto', prioridade: 'custo', conforto: 'indiferente', seguranca: 'caps',
}
function makeEnv() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  sqlite.exec(readFileSync(new URL('../migrations/20261114_quiz_participacoes.sql', import.meta.url), 'utf8'))
  const db = {
    prepare(sql) {
      const make = (params = []) => ({
        bind: (...values) => make(values),
        first: async () => sqlite.prepare(sql).get(...params) ?? null,
        run: async () => sqlite.prepare(sql).run(...params),
      })
      return make()
    },
    async batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  const env = {
    SHARE_DB: db,
    QUIZ_HASH_SECRET: 'local-only-test-secret',
    QUIZ_ALLOWED_ORIGINS: origin,
    RATE_LIMITER: {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  }
  return { env, sqlite }
}
const result = { principal: 'cirrus', segunda: 'seneca', motivos: ['regional'], avisos: ['Verificar pista'] }
function request(body, path = '/api/quiz/leads') {
  return new Request(`https://api.share-brasil.com${path}`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
    body: JSON.stringify(body),
  })
}
function payload() {
  return {
    chave_reenvio: crypto.randomUUID(), versao: VERSAO_QUIZ, respostas: options, resultado: result,
    contato: { nome: 'Cliente Teste', telefone: '(65) 99999-1234', cidade: 'Cuiabá', momento: 'EXPLORANDO', consentimento: true },
    origem: {}, duracao_segundos: 30,
  }
}

test('salva lead consentido e registra evento no D1, sem duplicar reenvio', async () => {
  const { env, sqlite } = makeEnv()
  const body = payload()
  const first = await quizRoutes.fetch(request(body), env)
  assert.equal(first.status, 201)
  const saved = await first.json()
  assert.equal(saved.resultado.principal, 'cirrus')
  assert.equal(sqlite.prepare('SELECT telefone FROM quiz_participacoes').get().telefone, '5565999991234')
  assert.equal(sqlite.prepare('SELECT tipo FROM quiz_eventos').get().tipo, 'PERFIL_SALVO')
  const second = await quizRoutes.fetch(request(body), env)
  assert.equal(second.status, 201)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM quiz_participacoes').get().n, 1)
  const event = await quizRoutes.fetch(request({ tipo: 'WHATSAPP_CLICADO', token: saved.token_evento }, `/api/quiz/leads/${saved.id}/eventos`), env)
  assert.equal(event.status, 200)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM quiz_eventos').get().n, 2)
  sqlite.close()
})

test('aceita resultado para análise personalizada sem perfil principal', async () => {
  const { env, sqlite } = makeEnv()
  const body = payload()
  body.respostas = { ...options, pax: '8+' }
  body.resultado = { principal: 'cirrus' }
  const response = await quizRoutes.fetch(request(body), env)
  assert.equal(response.status, 201)
  assert.equal((await response.json()).resultado.principal, null)
  assert.equal(sqlite.prepare('SELECT aeronave_sugerida FROM quiz_participacoes').get().aeronave_sugerida, null)
  sqlite.close()
})

test('descarta contato sem consentimento e rejeita origem não permitida', async () => {
  const { env, sqlite } = makeEnv()
  const body = payload()
  body.contato.consentimento = false
  const invalid = await quizRoutes.fetch(request(body), env)
  assert.equal(invalid.status, 201)
  assert.deepEqual({...sqlite.prepare('SELECT nome,telefone,consentimento FROM quiz_participacoes').get()}, {nome:null,telefone:null,consentimento:0})
  const forbidden = await quizRoutes.fetch(new Request('https://api.share-brasil.com/api/quiz/leads', {
    method: 'POST', headers: { Origin: 'https://fora.example', 'Content-Type': 'application/json' }, body: JSON.stringify(payload()),
  }), env)
  assert.equal(forbidden.status, 403)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM quiz_participacoes').get().n, 1)
  sqlite.close()
})


test('recalcula no servidor para sete modelos sem confiar no cliente', async () => {
  const {env,sqlite}=makeEnv()
  const body=payload()
  body.respostas={...options,pax:'7',distancia:'media',prioridade:'tempo',conforto:'sim'}
  body.resultado={principal:'cirrus',segunda:'matrix',motivos:['adulterado'],avisos:[]}
  const res=await quizRoutes.fetch(request(body),env)
  assert.equal(res.status,201)
  assert.deepEqual((await res.json()).resultado,recomendar(body.respostas))
  assert.equal(sqlite.prepare('SELECT aeronave_sugerida FROM quiz_participacoes').get().aeronave_sugerida,'hawker400a')
  sqlite.close()
})
test('aceita contato autorizado parcial e recusa versão antiga', async () => {
  const {env,sqlite}=makeEnv()
  for(const contato of [{nome:'Pessoa',consentimento:true},{telefone:'(65) 99999-1234',consentimento:true},{}]) {
    assert.equal((await quizRoutes.fetch(request({...payload(),contato}),env)).status,201)
  }
  assert.equal((await quizRoutes.fetch(request({...payload(),versao:'2026-11-v2'}),env)).status,400)
  sqlite.close()
})
test('preflight é público com origem restrita e nenhum GET expõe contatos', async () => {
  const {env,sqlite}=makeEnv()
  const res=await quizRoutes.fetch(new Request('https://api.share-brasil.com/api/quiz/leads',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST'}}),env)
  assert.equal(res.status,204)
  assert.equal(res.headers.get('Access-Control-Allow-Origin'),origin)
  assert.equal((await quizRoutes.fetch(new Request('https://api.share-brasil.com/api/quiz/leads',{headers:{Origin:origin}}),env)).status,405)
  sqlite.close()
})
test('a rota pública é montada antes do CORS interno e não altera suas origens', () => {
  const source=readFileSync(new URL('../src/worker.ts',import.meta.url),'utf8')
  assert.ok(source.indexOf("app.route('/', quizRoutes)") < source.indexOf("app.use('*'"))
})
