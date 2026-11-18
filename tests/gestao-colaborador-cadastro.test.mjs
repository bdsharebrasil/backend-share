import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import ts from "typescript";
const source = await readFile(
  new URL("../src/worker.ts", import.meta.url),
  "utf8",
);
function handler(method, path, allowed = true, sincronizar = async () => {}) {
  const start = source.indexOf(`app.${method}('${path}',`);
  assert.notEqual(start, -1);
  const end = source.indexOf("\napp.", start + 1);
  let fn;
  let uid = 0;
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    app: { [method]: (_path, run) => (fn = run) },
    shareBrasilUser: async () => ({ id: "gestor" }),
    isColaboradorManager: async () => allowed,
    gerarEmailEnvioColaborador: async () => "teste@share-brasil.com",
    sincronizarTripulacaoColaborador: sincronizar,
    uuid: () => `id-${++uid}`,
    fetch: async () => ({
      ok: true,
      json: async () => ({ id: "colaborador-1" }),
    }),
    log: { error: () => {} },
  });
  return fn;
}
function banco() {
  const db = new DatabaseSync(":memory:");
  const campos = [
    "id",
    "email",
    "email_envio",
    "nome_completo",
    "nome_exibicao",
    "url_avatar",
    "endereco",
    "cidade",
    "uf",
    "telefone",
    "data_criacao",
    "data_atualizacao",
    "data_nascimento",
    "data_admissao",
    "cpf",
    "rg",
    "canac",
    "status",
    "nome_banco",
    "tipo_conta",
    "conta_numero",
    "agencia_numero",
    "tipo_chave_pix",
    "pix",
    "tipo_user",
    "departamento",
    "cliente_id",
    "departamentos_email",
    "exame_admissional_data",
    "exame_admissional_local",
    "exame_admissional_empresa",
    "exame_admissional_prazo",
    "exame_admissional_documento_id",
  ];
  db.exec(
    `CREATE TABLE user_profiles (${campos.map((c) => `${c} TEXT`).join(",")},exame_admissional_realizado INTEGER NOT NULL DEFAULT 0);CREATE TABLE usuarios_funcoes(id TEXT,user_id TEXT,funcao TEXT);CREATE TABLE assinaturas_email(id TEXT,usuario_id TEXT,nome TEXT,cargo TEXT,telefone TEXT,endereco TEXT,email TEXT);`,
  );
  return db;
}
function contexto(db, body = {}) {
  const adapter = {
    prepare(sql) {
      let params = [];
      const cmd = {
        bind(...values) {
          params = values;
          return cmd;
        },
        async first() {
          return db.prepare(sql).get(...params);
        },
        async all() {
          return { results: db.prepare(sql).all(...params) };
        },
        async run() {
          const result = db.prepare(sql).run(...params);
          return { meta: { changes: result.changes } };
        },
      };
      return cmd;
    },
    async batch(cmds) {
      db.exec("BEGIN");
      try {
        for (const cmd of cmds) await cmd.run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    env: {
      SHARE_DB: adapter,
      SUPABASE_URL: "https://auth.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "test-only",
    },
    req: { json: async () => body, param: () => "colaborador-1" },
    json: (body, status = 200) => ({ body, status }),
    notFound: () => ({ status: 404 }),
  };
}
const dados = {
  nome_completo: "Colaborador Teste",
  email: "teste@example.test",
  senha: "teste123",
  departamento: "Administrativo",
  cpf: "123.456.789-10",
  telefone: "(65)3322-1100",
  endereco: "Rua das Flores, 123, Centro",
  cidade: "Cuiabá",
  uf: "MT",
  nome_banco: "Banco de Teste",
  tipo_conta: "poupanca",
  conta_numero: "000123-4",
  agencia_numero: "0001",
  tipo_chave_pix: "cpf",
  pix: "123.456.789-10",
  exame_admissional_realizado: false,
  exame_admissional_prazo: "2026-11-30",
};
test("criação grava e retorna endereço e todos os dados bancários com zeros à esquerda", async () => {
  const db = banco();
  try {
    const result = await handler(
      "post",
      "/api/gestor/gestao-colaborador",
    )(contexto(db, dados));
    assert.equal(result.status, 201);
    for (const campo of [
      "endereco",
      "nome_banco",
      "tipo_conta",
      "conta_numero",
      "agencia_numero",
      "tipo_chave_pix",
      "pix",
    ])
      assert.equal(result.body[campo], dados[campo], campo);
    assert.equal(result.body.exame_admissional_realizado, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS total FROM user_profiles").get().total,
      1,
    );
  } finally {
    db.close();
  }
});
test("ficha retorna os dados e edição parcial mantém campos omitidos e exame pendente", async () => {
  const db = banco();
  try {
    await handler(
      "post",
      "/api/gestor/gestao-colaborador",
    )(contexto(db, dados));
    const ficha = await handler(
      "get",
      "/api/gestor/gestao-colaborador/:id/ficha",
    )(contexto(db));
    assert.equal(ficha.body.perfil.nome_banco, dados.nome_banco);
    assert.equal(ficha.body.perfil.pix, dados.pix);
    const patch = await handler(
      "patch",
      "/api/gestor/gestao-colaborador/:id",
    )(
      contexto(db, {
        endereco: "Novo endereço",
        conta_numero: "000009-2",
        exame_admissional_realizado: false,
        exame_admissional_prazo: "2026-12-01",
      }),
    );
    assert.equal(patch.status, 200);
    assert.equal(patch.body.endereco, "Novo endereço");
    assert.equal(patch.body.conta_numero, "000009-2");
    assert.equal(patch.body.agencia_numero, "0001");
    assert.equal(patch.body.nome_banco, dados.nome_banco);
    assert.equal(patch.body.exame_admissional_realizado, 0);
  } finally {
    db.close();
  }
});
test("chave Pix pode ser removida sem apagar a conta e criação usa corrente por padrão", async () => {
  const db = banco();
  try {
    const semConta = { ...dados };
    delete semConta.tipo_conta;
    const criado = await handler(
      "post",
      "/api/gestor/gestao-colaborador",
    )(contexto(db, semConta));
    assert.equal(criado.body.tipo_conta, "corrente");
    const patch = await handler(
      "patch",
      "/api/gestor/gestao-colaborador/:id",
    )(contexto(db, { tipo_chave_pix: "", pix: "" }));
    assert.equal(patch.body.pix, null);
    assert.equal(patch.body.tipo_chave_pix, null);
    assert.equal(patch.body.conta_numero, dados.conta_numero);
  } finally {
    db.close();
  }
});
test("criação, edição e ficha exigem permissão antes de acessar dados", async () => {
  for (const [method, path] of [
    ["post", "/api/gestor/gestao-colaborador"],
    ["patch", "/api/gestor/gestao-colaborador/:id"],
    ["get", "/api/gestor/gestao-colaborador/:id/ficha"],
  ]) {
    const result = await handler(
      method,
      path,
      false,
    )({ json: (body, status) => ({ body, status }) });
    assert.equal(result.status, 403);
  }
});

test("alterar apenas cidade ou comprovante não depende de pendências de exame ou CANAC", async () => {
  const db = banco();
  try {
    // Cadastro legado incompleto, com exame realizado sem metadados e sem CANAC.
    db.prepare("INSERT INTO user_profiles (id, nome_completo, tipo_user, departamento, cidade, exame_admissional_realizado) VALUES (?, ?, ?, ?, ?, ?)")
      .run("colaborador-1", "Colaborador Teste", "colaborador", "Tripulante", "Cuiabá", 1);
    const syncNaoEsperado = async () => { throw new Error("canac_obrigatorio_para_tripulante"); };
    const patch = handler("patch", "/api/gestor/gestao-colaborador/:id", true, syncNaoEsperado);
    const cidade = await patch(contexto(db, { cidade: "Sinop" }));
    assert.equal(cidade.status, 200);
    assert.equal(cidade.body.cidade, "Sinop");
    assert.equal(cidade.body.exame_admissional_realizado, 1);
    assert.equal(cidade.body.exame_admissional_documento_id, null);
    const documento = await patch(contexto(db, { exame_admissional_documento_id: "doc-imagem" }));
    assert.equal(documento.status, 200);
    assert.equal(documento.body.exame_admissional_documento_id, "doc-imagem");
    assert.equal(documento.body.cidade, "Sinop");
  } finally { db.close(); }
});

test("edição dos dados de tripulação continua sincronizando o cadastro", async () => {
  const db = banco();
  try {
    await handler("post", "/api/gestor/gestao-colaborador")(contexto(db, dados));
    let chamadas = 0;
    const result = await handler("patch", "/api/gestor/gestao-colaborador/:id", true, async (_c, id, body) => {
      chamadas++;
      assert.equal(id, "colaborador-1");
      assert.equal(body.nome_completo, "Novo nome");
    })(contexto(db, { nome_completo: "Novo nome" }));
    assert.equal(result.status, 200);
    assert.equal(chamadas, 1);
  } finally { db.close(); }
});
