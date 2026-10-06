import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { shareBrasilPontoRoutes } from '../src/routes/shareBrasilPontoRoutes.ts'

const schemaSql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8')
const migrationSql = await readFile(new URL('../migrations/20261006_ponto_timestamp_utc.sql', import.meta.url), 'utf8')
const userId = 'ponto-test-user'
const supabaseUrl = 'https://ponto-auth.test'
const keyId = 'ponto-test-key'
const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: keyId, alg: 'ES256', use: 'sig' }

function tableDefinition(name) {
  const start = schemaSql.indexOf(`CREATE TABLE ${name} (`)
  assert.notEqual(start, -1, `tabela ${name} encontrada em schema.sql`)
  let end = start
  while (end < schemaSql.length) {
    if (schemaSql[end] !== "'") {
      end += 1
      continue
    }
    if (schemaSql[end + 1] === "'") {
      end += 2
      continue
    }
    break
  }
  assert.ok(end < schemaSql.length, `fim da definição de ${name} encontrado em schema.sql`)
  return schemaSql.slice(start, end).replaceAll("''", "'")
}

function createD1(database) {
  return {
    prepare(sql) {
      let params = []
      const statement = {
        bind(...values) {
          params = values
          return statement
        },
        first() {
          return database.prepare(sql).get(...params) ?? null
        },
        all() {
          return { results: database.prepare(sql).all(...params) }
        },
        run() {
          const result = database.prepare(sql).run(...params)
          return { meta: { changes: Number(result.changes) } }
        },
      }
      return statement
    },
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

async function accessToken() {
  const header = base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: keyId }))
  const claims = base64url(JSON.stringify({
    sub: userId,
    iss: `${supabaseUrl}/auth/v1`,
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 300,
  }))
  const input = `${header}.${claims}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${Buffer.from(signature).toString('base64url')}`
}

test('migration mantém a primeira linha de cada dia e preserva todos os dias únicos', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(`CREATE TABLE lancamento_ponto (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      data_entrada TEXT NOT NULL,
      criado_em TEXT
    )`)
    const insert = database.prepare('INSERT INTO lancamento_ponto (id, user_id, data_entrada, criado_em) VALUES (?, ?, ?, ?)')
    insert.run('f-uuid-first', 'user-1', '2026-10-01', '2026-10-01 08:00:00')
    insert.run('1-uuid-second', 'user-1', '2026-10-01', '2026-10-01 08:01:00')
    insert.run('unique-a', 'user-1', '2026-10-02', '2026-10-02 08:00:00')
    insert.run('unique-b', 'user-1', '2026-10-03', '2026-10-03 08:00:00')
    insert.run('unique-c', 'user-2', '2026-10-01', '2026-10-01 08:00:00')

    database.exec(migrationSql)

    const remaining = database.prepare('SELECT id FROM lancamento_ponto ORDER BY id').all().map(row => row.id)
    assert.deepEqual(remaining, ['f-uuid-first', 'unique-a', 'unique-b', 'unique-c'])
    assert.throws(
      () => insert.run('duplicate-after-migration', 'user-1', '2026-10-02', '2026-10-02 09:00:00'),
      /UNIQUE constraint failed/,
    )
  } finally {
    database.close()
  }
})

test('POST /ponto/marcar insere e atualiza usando o schema real de lancamento_ponto', async () => {
  const database = new DatabaseSync(':memory:')
  const originalFetch = globalThis.fetch
  try {
    database.exec(tableDefinition('user_profiles'))
    database.exec(tableDefinition('lancamento_ponto'))
    database.prepare('INSERT INTO user_profiles (id, email, nome_completo) VALUES (?, ?, ?)')
      .run(userId, 'ponto@example.test', 'Pessoa de teste')

    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/auth/v1/.well-known/jwks.json')) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return originalFetch(input, init)
    }

    const token = await accessToken()
    const env = { SHARE_DB: createD1(database), SUPABASE_URL: supabaseUrl }
    const marcar = acao => shareBrasilPontoRoutes.request('/marcar', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ acao }),
    }, env)

    const entradaResponse = await marcar('entrada')
    assert.equal(entradaResponse.status, 200, await entradaResponse.clone().text())
    const entrada = await entradaResponse.json()
    assert.equal(entrada.success, true)
    assert.equal(entrada.campo, 'entrada_hora')

    const saidaResponse = await marcar('saida')
    assert.equal(saidaResponse.status, 200, await saidaResponse.clone().text())
    const saida = await saidaResponse.json()
    assert.equal(saida.success, true)
    assert.equal(saida.campo, 'saida_hora')

    const persisted = database.prepare('SELECT entrada_hora, saida_hora, horas_totais, status FROM lancamento_ponto WHERE user_id = ?')
      .get(userId)
    assert.match(persisted.entrada_hora, /^\d{2}:\d{2}$/)
    assert.match(persisted.saida_hora, /^\d{2}:\d{2}$/)
    assert.equal(typeof persisted.horas_totais, 'number')
    assert.equal(persisted.status, 'finished')
    assert.equal(saida.horas_totais, persisted.horas_totais)
  } finally {
    globalThis.fetch = originalFetch
    database.close()
  }
})
