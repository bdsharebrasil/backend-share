import assert from 'node:assert/strict'
import { test } from 'node:test'
import { portalClienteRoutes } from '../src/financeiro/portalClienteRoutes.ts'

const COLUNAS_PORTAL = ['id', 'login', 'senha', 'nome_exibicao', 'url_avatar', 'cliente_id', 'socio_id', 'criado_em', 'atualizado_em']

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = [] }
  bind(...values) { this.values = values; return this }
  first() { return this.db.first(this.sql, this.values) }
  all() { return this.db.all(this.sql, this.values) }
  run() { return this.db.run(this.sql, this.values) }
}

class FakeD1 {
  constructor({ usuario = null } = {}) {
    this.usuario = usuario
    this.cotista = {
      id: 'cotista-aeronave-1', cliente_id: 'cliente-1', socio_id: null,
      codigo_cliente: 'CLI-01', percentual_sociedade: 50,
      nome: 'Cotista Teste', email: 'cotista@example.com', matricula_registro: 'PT-ABC',
    }
  }
  prepare(sql) { return new FakeStatement(this, sql) }
  async all(sql) {
    if (sql.includes('pragma_table_info')) return { results: COLUNAS_PORTAL.map((name) => ({ name })) }
    if (sql.includes('EXISTS (') && sql.includes('FROM cotista_aeronave ca')) {
      return { results: [{ cotista_aeronave_id: this.cotista.id, cliente_id: this.cotista.cliente_id, socio_id: null, codigo_cliente: 'CLI-01', percentual_sociedade: 50, nome: this.cotista.nome, email: this.cotista.email, matricula_registro: 'PT-ABC', possui_acesso: this.usuario ? 1 : 0, login: this.usuario?.login || null }] }
    }
    throw new Error(`Consulta all não simulada: ${sql}`)
  }
  async first(sql, values) {
    if (sql.includes('SELECT id FROM aeronave')) return values[0] === 'aircraft-1' ? { id: values[0] } : null
    if (sql.includes('FROM cotista_aeronave ca')) return values[0] === this.cotista.id ? this.cotista : null
    if (sql.includes('SELECT id, login, senha FROM user_cliente')) {
      const [clienteId, socioId] = values
      return this.usuario && ((clienteId && this.usuario.cliente_id === clienteId) || (socioId && this.usuario.socio_id === socioId)) ? { ...this.usuario } : null
    }
    if (sql.includes('SELECT id FROM user_cliente WHERE lower(login)')) return null
    throw new Error(`Consulta first não simulada: ${sql}`)
  }
  async run(sql, values) {
    if (sql.includes('INSERT INTO user_cliente')) {
      const [id, login, senha, nome_exibicao, cliente_id, socio_id] = values
      this.usuario = { id, login, senha, nome_exibicao, cliente_id, socio_id }
      return { success: true, meta: { changes: 1 } }
    }
    if (sql.includes('UPDATE user_cliente SET senha')) {
      const [novaSenha, id, senhaAnterior] = values
      if (!this.usuario || this.usuario.id !== id || this.usuario.senha !== senhaAnterior) return { success: true, meta: { changes: 0 } }
      this.usuario.senha = novaSenha
      return { success: true, meta: { changes: 1 } }
    }
    throw new Error(`Consulta run não simulada: ${sql}`)
  }
}

const chamar = (db, path, init = {}, extraEnv = {}) => portalClienteRoutes.request(path, init, {
  SHARE_DB: db,
  RESEND_API_KEY: 'test-api-key',
  EMAIL_FROM: 'Share Brasil <portal@example.com>',
  ...extraEnv,
})

test('lista os acessos por aeronave sem retornar senha nem hash', async () => {
  const db = new FakeD1({ usuario: { id: 'user-1', login: 'cotista.teste', senha: 'pbkdf2_sha256$hash', cliente_id: 'cliente-1', socio_id: null } })
  const response = await chamar(db, '/cotista/portal-cliente?aeronave_id=aircraft-1')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.cotistas[0].login, 'cotista.teste')
  assert.equal(body.cotistas[0].possui_acesso, 1)
  assert.equal('senha' in body.cotistas[0], false)
})

test('cria usuário vinculado ao cliente e armazena somente hash PBKDF2', async () => {
  const db = new FakeD1()
  const response = await chamar(db, '/cotista/portal-cliente/cotista-aeronave-1/credenciais', { method: 'POST' })
  assert.equal(response.status, 201)
  const body = await response.json()
  assert.equal(typeof body.login, 'string')
  assert.equal(typeof body.senha_temporaria, 'string')
  assert.match(db.usuario.senha, /^pbkdf2_sha256\$100000\$/)
  assert.notEqual(db.usuario.senha, body.senha_temporaria)
  assert.equal(db.usuario.cliente_id, 'cliente-1')
  assert.equal(db.usuario.socio_id, null)
})

test('restaura a senha anterior quando o provedor de e-mail rejeita a mensagem', async () => {
  const senhaAnterior = 'pbkdf2_sha256$100000$salt$hash'
  const db = new FakeD1({ usuario: { id: 'user-1', login: 'cotista.teste', senha: senhaAnterior, cliente_id: 'cliente-1', socio_id: null } })
  const fetchOriginal = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'rejeitado' }), { status: 500 })
  try {
    const response = await chamar(db, '/cotista/portal-cliente/cotista-aeronave-1/enviar-acesso', { method: 'POST' })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error, 'falha_envio_email')
    assert.equal(db.usuario.senha, senhaAnterior)
  } finally {
    globalThis.fetch = fetchOriginal
  }
})
