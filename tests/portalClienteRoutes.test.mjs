import assert from 'node:assert/strict'
import { test } from 'node:test'
import { portalClienteRoutes } from '../src/financeiro/portalClienteRoutes.ts'
import { portalCreatePasswordHash, portalRoutes } from '../src/routes/portalRoutes.ts'

const COLUNAS_PORTAL = ['id', 'login', 'senha', 'nome_exibicao', 'url_avatar', 'cotista_id', 'criado_em', 'atualizado_em']

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
      nome: 'Cotista Teste', matricula_registro: 'PT-ABC',
    }
  }
  prepare(sql) { return new FakeStatement(this, sql) }
  async all(sql) {
    if (sql.includes('pragma_table_info')) return { results: COLUNAS_PORTAL.map((name) => ({ name })) }
    if (sql.includes('EXISTS (SELECT 1 FROM user_cliente u WHERE u.cotista_id = ca.id)')) {
      return { results: [{ cotista_aeronave_id: this.cotista.id, cliente_id: this.cotista.cliente_id, socio_id: null, codigo_cliente: 'CLI-01', percentual_sociedade: 50, nome: this.cotista.nome, matricula_registro: 'PT-ABC', possui_acesso: this.usuario ? 1 : 0, login: this.usuario?.login || null }] }
    }
    throw new Error(`Consulta all não simulada: ${sql}`)
  }
  async first(sql, values) {
    if (sql.includes('SELECT id FROM aeronave')) return values[0] === 'aircraft-1' ? { id: values[0] } : null
    if (sql.includes('FROM cotista_aeronave ca')) return values[0] === this.cotista.id ? this.cotista : null
    if (sql.includes('SELECT id, login, senha FROM user_cliente')) {
      return this.usuario?.cotista_id === values[0] ? { ...this.usuario } : null
    }
    if (sql.includes('FROM user_cliente u') && sql.includes('LEFT JOIN cotista_aeronave ca')) {
      return this.usuario?.login.toLowerCase() === values[0]
        ? { ...this.usuario, cliente_id: this.cotista.cliente_id, socio_id: this.cotista.socio_id }
        : null
    }
    if (sql.includes('SELECT id FROM user_cliente') && sql.includes('lower(login)')) {
      return this.usuario?.login.toLowerCase() === String(values[0]).toLowerCase() && this.usuario.cotista_id !== values[1]
        ? { id: this.usuario.id }
        : null
    }
    throw new Error(`Consulta first não simulada: ${sql}`)
  }
  async run(sql, values) {
    if (sql.includes('INSERT INTO user_cliente')) {
      const [id, login, senha, nome_exibicao, cotista_id] = values
      this.usuario = { id, login, senha, nome_exibicao, url_avatar: null, cotista_id }
      return { success: true, meta: { changes: 1 } }
    }
    if (sql.includes('SET login = ?1, senha = ?2')) {
      const [login, senha, cotistaId, id] = values
      if (!this.usuario || this.usuario.id !== id || this.usuario.cotista_id !== cotistaId) return { success: true, meta: { changes: 0 } }
      this.usuario.login = login
      this.usuario.senha = senha
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

const portalEnv = (db) => ({
  SHARE_DB: db,
  CACHE_KV: {},
  RATE_LIMITER: {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }) }),
  },
  CLIENT_SESSION_SECRET: 'test-session-secret',
})

test('lista os acessos por aeronave usando cotista_id sem retornar senha nem hash', async () => {
  const db = new FakeD1({ usuario: { id: 'user-1', login: 'cotista.teste', senha: 'pbkdf2_sha256$hash', cotista_id: 'cotista-aeronave-1' } })
  const response = await chamar(db, '/cotista/portal-cliente?aeronave_id=aircraft-1')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.cotistas[0].login, 'cotista.teste')
  assert.equal(body.cotistas[0].possui_acesso, 1)
  assert.equal('senha' in body.cotistas[0], false)
})

test('cria usuário com senha definida pelo operador sem mínimo e armazena hash PBKDF2', async () => {
  const db = new FakeD1()
  const senha = '7'
  const response = await chamar(db, '/cotista/portal-cliente/cotista-aeronave-1/credenciais', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha }) })
  assert.equal(response.status, 201)
  const body = await response.json()
  assert.equal(typeof body.login, 'string')
  assert.equal('senha_temporaria' in body, false)
  assert.match(db.usuario.senha, /^pbkdf2_sha256\$100000\$/)
  assert.notEqual(db.usuario.senha, senha)
  assert.equal(db.usuario.cotista_id, 'cotista-aeronave-1')
  assert.equal('cliente_id' in db.usuario, false)
  assert.equal('socio_id' in db.usuario, false)
})

test('a listagem não expõe o e-mail cadastrado do cotista', async () => {
  const db = new FakeD1()
  const response = await chamar(db, '/cotista/portal-cliente?aeronave_id=aircraft-1')
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal('email' in body.cotistas[0], false)
})

test('login do portal resolve cliente pelo cotista_id da conta criada', async () => {
  const db = new FakeD1()
  const criacao = await chamar(db, '/cotista/portal-cliente/cotista-aeronave-1/credenciais', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: '1' }) })
  const credenciais = await criacao.json()
  const resposta = await portalRoutes.request('/api/portal/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: credenciais.login, senha: '1' }),
  }, portalEnv(db))
  assert.equal(resposta.status, 200)
  const body = await resposta.json()
  assert.equal(body.user.cliente_id, 'cliente-1')
  assert.equal(body.user.socio_id, null)
})

test('login consulta user_cliente no D1 e rejeita senha incorreta sem emitir sessão', async () => {
  const db = new FakeD1({ usuario: {
    id: 'user-1', login: 'cotista.teste', senha: await portalCreatePasswordHash('Senha-correta-2026!'), cotista_id: 'cotista-aeronave-1',
  } })
  const resposta = await portalRoutes.request('/api/portal/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: '  COTISTA.TESTE ', senha: 'Senha-incorreta-2026!' }),
  }, portalEnv(db))
  assert.equal(resposta.status, 401)
  assert.deepEqual(await resposta.json(), { error: 'credenciais_invalidas' })
})

test('login rejeita credenciais com tipos inválidos ou além dos limites aceitos', async () => {
  const db = new FakeD1()
  const enviar = (body) => portalRoutes.request('/api/portal/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, portalEnv(db))

  assert.equal((await enviar({ login: 123, senha: 'senha' })).status, 400)
  assert.equal((await enviar({ login: 'a'.repeat(81), senha: 'senha' })).status, 401)
  assert.equal((await enviar({ login: 'cotista', senha: 's'.repeat(129) })).status, 401)
})

test('atualiza login e senha e permite autenticação apenas com as novas credenciais', async () => {
  const db = new FakeD1()
  const criacao = await chamar(db, '/cotista/portal-cliente/cotista-aeronave-1/credenciais', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: '2' }) })
  const antigas = await criacao.json()
  const senhaNova = 'Senha-portal-2026!'
  const atualizacao = await chamar(db, '/cotista/portal-cliente/cotista-aeronave-1/credenciais', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'Novo.Login', senha: senhaNova }),
  })
  assert.equal(atualizacao.status, 200)
  assert.deepEqual(await atualizacao.json(), { success: true, login: 'novo.login' })
  assert.equal(db.usuario.login, 'novo.login')
  assert.match(db.usuario.senha, /^pbkdf2_sha256\$100000\$/)
  assert.notEqual(db.usuario.senha, senhaNova)

  const autenticar = (login, senha) => portalRoutes.request('/api/portal/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, senha }),
  }, portalEnv(db))
  assert.equal((await autenticar('novo.login', senhaNova)).status, 200)
  assert.equal((await autenticar(antigas.login, '2')).status, 401)
})

test('envia senha escolhida para destinatário manual e restaura senha anterior se e-mail falhar', async () => {
  const senhaAnterior = 'pbkdf2_sha256$100000$salt$hash'
  const db = new FakeD1({ usuario: { id: 'user-1', login: 'cotista.teste', senha: senhaAnterior, cotista_id: 'cotista-aeronave-1' } })
  const fetchOriginal = globalThis.fetch
  let emailEnviado
  globalThis.fetch = async (_url, init) => { emailEnviado = JSON.parse(init.body); return new Response(JSON.stringify({ message: 'rejeitado' }), { status: 500 }) }
  try {
    const response = await chamar(db, '/cotista/portal-cliente/cotista-aeronave-1/enviar-acesso', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: '9', destinatario: 'destino@example.com' }) })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error, 'falha_envio_email')
    assert.deepEqual(emailEnviado.to, ['destino@example.com'])
    assert.match(emailEnviado.html, /<code>9<\/code>/)
    assert.equal(db.usuario.senha, senhaAnterior)
  } finally {
    globalThis.fetch = fetchOriginal
  }
})

test('confirma envio ao destinatário indicado e mantém a senha escolhida', async () => {
  const db = new FakeD1({ usuario: { id: 'user-1', login: 'cotista.teste', senha: 'hash-anterior', cotista_id: 'cotista-aeronave-1' } })
  const fetchOriginal = globalThis.fetch
  let emailEnviado
  globalThis.fetch = async (_url, init) => { emailEnviado = JSON.parse(init.body); return new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }) }
  try {
    const response = await chamar(db, '/cotista/portal-cliente/cotista-aeronave-1/enviar-acesso', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: '1234', destinatario: 'destino@example.com' }) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { success: true, destinatario: 'destino@example.com' })
    assert.deepEqual(emailEnviado.to, ['destino@example.com'])
    assert.match(emailEnviado.html, /<code>1234<\/code>/)
    assert.notEqual(db.usuario.senha, 'hash-anterior')
  } finally {
    globalThis.fetch = fetchOriginal
  }
})

test('rejeita senha vazia e destinatário de e-mail inválido', async () => {
  const criar = await chamar(new FakeD1(), '/cotista/portal-cliente/cotista-aeronave-1/credenciais', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: '' }) })
  assert.equal(criar.status, 400)
  const dbComUsuario = new FakeD1({ usuario: { id: 'user-1', login: 'cotista.teste', senha: 'hash', cotista_id: 'cotista-aeronave-1' } })
  const enviar = await chamar(dbComUsuario, '/cotista/portal-cliente/cotista-aeronave-1/enviar-acesso', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: 'x', destinatario: 'email-invalido' }) })
  assert.equal(enviar.status, 400)
})
