import { DatabaseSync } from 'node:sqlite'
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
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE leads_quiz (
      id TEXT PRIMARY KEY NOT NULL, protocolo TEXT NOT NULL UNIQUE, chave_reenvio TEXT NOT NULL UNIQUE,
      resumo_envio TEXT NOT NULL, nome TEXT NOT NULL, telefone TEXT NOT NULL, cidade TEXT NOT NULL,
      rotas TEXT, momento TEXT NOT NULL, respostas_json TEXT NOT NULL, resultado_json TEXT NOT NULL,
      aeronave_sugerida TEXT, aeronave_alternativa TEXT, versao_quiz TEXT NOT NULL, origem_json TEXT NOT NULL,
      duracao_segundos INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'NOVO', consentimento INTEGER NOT NULL,
      versao_consentimento TEXT NOT NULL, consentimento_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      token_evento_hash TEXT NOT NULL, whatsapp_clicado_em TEXT,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE eventos_quiz (
      id TEXT PRIMARY KEY NOT NULL, lead_id TEXT NOT NULL REFERENCES leads_quiz(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(lead_id,tipo)
    );
  `)
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
    INTERNAL_TOKEN: 'local-only-test-secret',
    ALLOWED_ORIGINS: origin,
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
    chave_reenvio: crypto.randomUUID(), versao: '2026-11-v1', respostas: options, resultado: result,
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
  assert.equal(sqlite.prepare('SELECT telefone FROM leads_quiz').get().telefone, '5565999991234')
  assert.equal(sqlite.prepare('SELECT tipo FROM eventos_quiz').get().tipo, 'PERFIL_SALVO')
  const second = await quizRoutes.fetch(request(body), env)
  assert.equal(second.status, 201)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM leads_quiz').get().n, 1)
  const event = await quizRoutes.fetch(request({ tipo: 'WHATSAPP_CLICADO', token: saved.token_evento }, `/api/quiz/leads/${saved.id}/eventos`), env)
  assert.equal(event.status, 200)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM eventos_quiz').get().n, 2)
  sqlite.close()
})

test('não salva sem consentimento e rejeita origem não permitida', async () => {
  const { env, sqlite } = makeEnv()
  const body = payload()
  body.contato.consentimento = false
  const invalid = await quizRoutes.fetch(request(body), env)
  assert.equal(invalid.status, 400)
  const forbidden = await quizRoutes.fetch(new Request('https://api.share-brasil.com/api/quiz/leads', {
    method: 'POST', headers: { Origin: 'https://fora.example', 'Content-Type': 'application/json' }, body: JSON.stringify(payload()),
  }), env)
  assert.equal(forbidden.status, 403)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM leads_quiz').get().n, 0)
  sqlite.close()
})
