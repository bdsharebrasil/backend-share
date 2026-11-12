import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { gestorContratosRoutes } from '../src/routes/gestorContratosRoutes.ts';

const proposta = () => ({
  versao: 1,
  emissao: '2026-11-12',
  validade_dias: 15,
  cidade: 'Cuiabá',
  aeronave_descricao: 'PT-TEST · Modelo',
  apresentacao: 'Apresentação',
  descricao_servicos: 'Gestão',
  areas: ['CTM'],
  servicos: [
    {
      id: 'ctm',
      titulo: 'CTM',
      incluido: true,
      valor_centavos: 170000,
      itens: ['Controle de vencimentos'],
    },
    {
      id: 'fin',
      titulo: 'Financeiro',
      incluido: true,
      valor_centavos: 150000,
      itens: ['Balanço mensal'],
    },
  ],
  modo_cobranca: 'PACOTE',
  unidade: 'POR_COTISTA',
  quantidade_cotistas: 2,
  valor_pacote_centavos: 175000,
  condicoes: 'Mensal',
  encerramento: 'Share Brasil',
});
const payload = () => ({
  tipo: 'PRESTACAO_SERVICO',
  titulo: 'Proposta de gerenciamento',
  status: 'RASCUNHO',
  moeda: 'BRL',
  valor_centavos: 350000,
  aeronave_id: 'aviao',
  dados_adicionais: {
    modelo: 'PROPOSTA_GERENCIAMENTO',
    proposta_gerenciamento: proposta(),
  },
  partes: [
    { papel: 'CONTRATANTE', nome: 'Cliente', tipo_pessoa: 'JURIDICA' },
    { papel: 'CONTRATADA', nome: 'Share Brasil', tipo_pessoa: 'JURIDICA' },
  ],
});
function ambiente() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE user_profiles(id TEXT PRIMARY KEY,tipo_user TEXT,status TEXT,departamento TEXT);INSERT INTO user_profiles VALUES('gestor','gestor_master','ativo','Gestão'),('colaborador','colaborador','ativo','Operações');
 CREATE TABLE usuarios_funcoes(user_id TEXT,funcao TEXT);CREATE TABLE aeronave(id TEXT PRIMARY KEY);INSERT INTO aeronave VALUES('aviao');
 CREATE TABLE contratos(id TEXT PRIMARY KEY,numero TEXT UNIQUE,tipo TEXT NOT NULL,titulo TEXT NOT NULL,descricao TEXT,status TEXT NOT NULL DEFAULT 'RASCUNHO',valor_centavos INTEGER,moeda TEXT DEFAULT 'BRL',forma_pagamento TEXT,data_assinatura TEXT,data_inicio TEXT,data_fim TEXT,aeronave_id TEXT,dados_adicionais TEXT,documento_url TEXT,foro TEXT,observacoes TEXT,criado_por TEXT,criado_em TEXT DEFAULT CURRENT_TIMESTAMP,atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE contrato_partes(id TEXT PRIMARY KEY,contrato_id TEXT REFERENCES contratos(id) ON DELETE CASCADE,papel TEXT NOT NULL,tipo_pessoa TEXT,nome TEXT NOT NULL,documento TEXT,email TEXT,telefone TEXT,endereco TEXT,representante_nome TEXT,representante_documento TEXT,representante_cargo TEXT,dados_adicionais TEXT,assinou_em TEXT,ordem INTEGER);
 CREATE TABLE contrato_anexos(id TEXT PRIMARY KEY,contrato_id TEXT REFERENCES contratos(id),nome TEXT,tipo TEXT,url TEXT,criado_em TEXT DEFAULT CURRENT_TIMESTAMP);`);
  const prepare = (query, args = []) => ({
    bind(...a) {
      return prepare(query, a);
    },
    async first() {
      return sql.prepare(query).get(...args) || null;
    },
    async all() {
      return { results: sql.prepare(query).all(...args) };
    },
    async run() {
      const r = sql.prepare(query).run(...args);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  const arquivos = new Map();
  let antesBatch = null,
    antesUpload = null;
  const db = {
    prepare,
    async batch(statements) {
      if (antesBatch) {
        const f = antesBatch;
        antesBatch = null;
        f();
      }
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sql.exec('COMMIT');
        return results;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const bucket = {
    async put(k, v, o) {
      arquivos.set(k, { body: v, httpMetadata: o.httpMetadata });
      if (antesUpload) {
        const f = antesUpload;
        antesUpload = null;
        f();
      }
    },
    async delete(k) {
      arquivos.delete(k);
    },
    async get(k) {
      return arquivos.get(k) || null;
    },
  };
  const env = {
    SHARE_DB: db,
    FILES: bucket,
    SUPABASE_URL: 'https://auth.invalid',
    SUPABASE_ANON_KEY: 'teste',
  };
  const app = new Hono();
  app.route('/api/gestor/contratos', gestorContratosRoutes);
  const request = (path = '', method = 'GET', body, token = 'gestor') =>
    app.request(
      '/api/gestor/contratos' + path,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body && !(body instanceof FormData)
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body:
          body instanceof FormData
            ? body
            : body
              ? JSON.stringify(body)
              : undefined,
      },
      env,
    );
  return {
    sql,
    request,
    arquivos,
    setAntesBatch: (f) => (antesBatch = f),
    setAntesUpload: (f) => (antesUpload = f),
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://auth.invalid/auth/v1/user');
  return Response.json({
    id: new Headers(init.headers).get('Authorization').slice(7),
  });
};
test.after(() => {
  globalThis.fetch = originalFetch;
});
async function criar(a, p = payload()) {
  const r = await a.request('', 'POST', p);
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
}
const form = (revisao) => {
  const f = new FormData();
  f.set(
    'arquivo',
    new File(['%PDF-1.7 teste'], 'proposta.pdf', { type: 'application/pdf' }),
  );
  f.set('tipo', 'PROPOSTA_GERADA');
  if (revisao !== undefined) f.set('revisao', String(revisao));
  return f;
};

test('rascunho incompleto é retomado, recebe número e preserva contrato, partes e histórico', async () => {
  const a = ambiente(),
    p = payload();
  p.partes[0].nome = '';
  const r = await criar(a, p);
  assert.match(r.numero, /^PROP-2026-/);
  assert.equal(r.revisao, 1);
  const c = await (await a.request('/' + r.id)).json();
  assert.equal(c.partes[0].nome, '');
  assert.equal(c.aeronave_id, 'aviao');
  assert.equal(
    c.dados_adicionais.proposta_gerenciamento.quantidade_cotistas,
    2,
  );
  assert.equal(c.valor_centavos, 350000);
  assert.equal(c.dados_adicionais.historico_andamento[0].usuario_id, 'gestor');
  p.partes[0].nome = 'Cliente final';
  p.status = 'EM_REVISAO';
  p.revisao_esperada = 1;
  p.dados_adicionais.historico_andamento = [{ acao: 'ASSINADO_FALSO' }];
  const u = await a.request('/' + r.id, 'PUT', p);
  assert.equal(u.status, 200, await u.clone().text());
  const salvo = await u.json();
  assert.equal(salvo.dados_adicionais.historico_andamento.length, 2);
  assert.equal(
    salvo.dados_adicionais.historico_andamento[1].para,
    'EM_REVISAO',
  );
});
test('valores usam pacote OU soma dos grupos e rejeitam inconsistências, datas e avanço incompleto', async () => {
  const a = ambiente();
  let p = payload();
  p.valor_centavos = 990000;
  assert.equal((await a.request('', 'POST', p)).status, 400);
  p = payload();
  p.dados_adicionais.proposta_gerenciamento.modo_cobranca = 'SERVICOS';
  p.valor_centavos = 640000;
  assert.equal((await a.request('', 'POST', p)).status, 201);
  p = payload();
  p.dados_adicionais.proposta_gerenciamento.emissao = '2026-02-31';
  assert.equal((await a.request('', 'POST', p)).status, 400);
  p = payload();
  p.status = 'ENVIADO';
  p.partes[0].nome = '';
  assert.equal((await a.request('', 'POST', p)).status, 400);
});
test('revisão atrasada e corrida de gravação não sobrescrevem as partes nem o histórico', async () => {
  const a = ambiente(),
    r = await criar(a);
  let p = payload();
  p.revisao_esperada = 0;
  assert.equal((await a.request('/' + r.id, 'PUT', p)).status, 409);
  p.revisao_esperada = 1;
  p.partes[0].nome = 'Nome perdido';
  a.setAntesBatch(() => {
    a.sql
      .prepare(
        "UPDATE contratos SET titulo='Edição de outra sessão',dados_adicionais=json_set(dados_adicionais,'$._revisao',2) WHERE id=?",
      )
      .run(r.id);
  });
  assert.equal((await a.request('/' + r.id, 'PUT', p)).status, 409);
  const c = await (await a.request('/' + r.id)).json();
  assert.equal(c.titulo, 'Edição de outra sessão');
  assert.equal(c.partes[0].nome, 'Cliente');
  assert.equal(c.revisao, 2);
});
test('PDF fica protegido, mantém versões e registra geração sem mudar status para enviado ou assinado', async () => {
  const a = ambiente(),
    r = await criar(a);
  assert.equal(
    (await a.request('/' + r.id + '/anexos', 'POST', form())).status,
    409,
  );
  let u = await a.request('/' + r.id + '/anexos', 'POST', form(1));
  assert.equal(u.status, 201, await u.clone().text());
  let c = await (await a.request('/' + r.id)).json();
  assert.equal(c.status, 'RASCUNHO');
  assert.equal(c.revisao, 2);
  assert.match(c.documento_url, /^\/api\/gestor\/contratos\//);
  assert.equal(c.anexos.length, 1);
  assert.equal(
    c.dados_adicionais.historico_andamento.at(-1).acao,
    'DOCUMENTO_GERADO',
  );
  const download = await a.request(
    c.documento_url.replace('/api/gestor/contratos', ''),
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(
    (await a.request('/' + r.id + '/anexos', 'POST', form(2))).status,
    201,
  );
  c = await (await a.request('/' + r.id)).json();
  assert.equal(c.anexos.length, 2);
  assert.equal(a.arquivos.size, 2);
});
test('PDF gerado durante edição concorrente é rejeitado e o arquivo órfão é removido', async () => {
  const a = ambiente(),
    r = await criar(a);
  a.setAntesUpload(() =>
    a.sql
      .prepare(
        "UPDATE contratos SET dados_adicionais=json_set(dados_adicionais,'$._revisao',2) WHERE id=?",
      )
      .run(r.id),
  );
  assert.equal(
    (await a.request('/' + r.id + '/anexos', 'POST', form(1))).status,
    409,
  );
  assert.equal(a.arquivos.size, 0);
  assert.equal(
    a.sql.prepare('SELECT count(*) n FROM contrato_anexos').get().n,
    0,
  );
  assert.equal(
    a.sql.prepare('SELECT documento_url FROM contratos').get().documento_url,
    null,
  );
});
test('colaborador comum não acessa contratos nem anexos', async () => {
  const a = ambiente(),
    r = await criar(a);
  assert.equal(
    (await a.request('', 'GET', undefined, 'colaborador')).status,
    403,
  );
  assert.equal(
    (await a.request('/' + r.id, 'PUT', payload(), 'colaborador')).status,
    403,
  );
  assert.equal(
    (await a.request('/' + r.id + '/anexos', 'POST', form(1), 'colaborador'))
      .status,
    403,
  );
});
test('contratos antigos continuam editáveis sem exigir modelo novo ou tabela contrato_cotista', async () => {
  const a = ambiente(),
    p = payload();
  p.dados_adicionais = {
    texto_contrato: 'Contrato anterior',
    tipo_vinculo: 'COTISTA',
    cotista_id: 'legado',
  };
  p.aeronave_id = null;
  const r = await criar(a, p);
  p.titulo = 'Contrato anterior atualizado';
  assert.equal((await a.request('/' + r.id, 'PUT', p)).status, 200);
  const c = await (await a.request('/' + r.id)).json();
  assert.equal(c.dados_adicionais.texto_contrato, 'Contrato anterior');
  assert.equal(c.titulo, 'Contrato anterior atualizado');
});
