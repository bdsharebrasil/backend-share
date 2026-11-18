import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";

const source = await readFile(
  new URL("../src/worker.ts", import.meta.url),
  "utf8",
);
function handler(path, allowed = true, extras = {}) {
  const start = source.indexOf(`app.get('${path}',`);
  assert.notEqual(start, -1);
  const end = source.indexOf("\napp.", start + 1);
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let run;
  vm.runInNewContext(code, {
    app: {
      get: (_path, fn) => {
        run = fn;
      },
    },
    shareBrasilUser: async () => ({ id: "gestor" }),
    isColaboradorManager: async () => allowed,
    Response,
    ...extras,
  });
  return run;
}
function contexto(db) {
  return {
    env: {
      SHARE_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              return {
                async first() {
                  return db.prepare(sql).get(...params);
                },
                async all() {
                  return { results: db.prepare(sql).all(...params) };
                },
              };
            },
          };
        },
      },
    },
    req: { param: () => "colaborador-1" },
    json: (body, status = 200) => ({ body, status }),
    notFound: () => ({ status: 404 }),
  };
}

test("ficha retorna dados de exame e lotação para editar sem perder o comprovante", async () => {
  const db = new DatabaseSync(":memory:");
  const fields = [
    "id",
    "email",
    "nome_completo",
    "nome_exibicao",
    "url_avatar",
    "telefone",
    "endereco",
    "cidade",
    "uf",
    "data_nascimento",
    "data_admissao",
    "cpf",
    "rg",
    "canac",
    "status",
    "tipo_user",
    "departamento",
    "departamentos_email",
    "nome_banco",
    "tipo_conta",
    "conta_numero",
    "agencia_numero",
    "tipo_chave_pix",
    "pix",
    "exame_admissional_realizado",
    "exame_admissional_data",
    "exame_admissional_local",
    "exame_admissional_empresa",
    "exame_admissional_prazo",
    "exame_admissional_documento_id",
    "data_criacao",
    "data_atualizacao",
  ];
  db.exec(
    `CREATE TABLE user_profiles (${fields.map((f) => `${f} TEXT`).join(", ")})`,
  );
  db.prepare(
    "INSERT INTO user_profiles (id,tipo_user,departamentos_email,exame_admissional_realizado,exame_admissional_data,exame_admissional_local,exame_admissional_empresa,exame_admissional_documento_id) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    "colaborador-1",
    "colaborador",
    "CTM",
    "1",
    "2026-11-10",
    "Clínica",
    "Saúde",
    "doc-123",
  );
  const result = await handler("/api/gestor/gestao-colaborador/:id/ficha")(
    contexto(db),
  );
  assert.equal(result.body.perfil.exame_admissional_documento_id, "doc-123");
  assert.equal(result.body.perfil.exame_admissional_data, "2026-11-10");
  assert.equal(result.body.perfil.exame_admissional_local, "Clínica");
  assert.equal(result.body.perfil.exame_admissional_empresa, "Saúde");
  assert.equal(result.body.perfil.departamentos_email, "CTM");
  db.close();
});
test("ficha e foto exigem autorização de gestão antes de consultar dados", async () => {
  for (const path of [
    "/api/gestor/gestao-colaborador/:id/ficha",
    "/api/gestor/gestao-colaborador/:id/foto",
  ]) {
    const result = await handler(
      path,
      false,
    )({ json: (body, status) => ({ body, status }) });
    assert.equal(result.status, 403);
  }
});
test("foto é entregue pelo armazenamento com cache privado e sem URL pública", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE user_profiles (id TEXT, tipo_user TEXT, url_avatar TEXT); INSERT INTO user_profiles VALUES ('colaborador-1','colaborador','avatars/privado.jpg')",
  );
  let key;
  const result = await handler(
    "/api/gestor/gestao-colaborador/:id/foto",
    true,
    {
      bucketParaChaveColaborador: () => ({
        get: async (value) => {
          key = value;
          return {
            body: "foto-ficticia",
            httpMetadata: { contentType: "image/png" },
          };
        },
      }),
    },
  )(contexto(db));
  assert.equal(key, "avatars/privado.jpg");
  assert.equal(result.headers.get("Content-Type"), "image/png");
  assert.equal(result.headers.get("Cache-Control"), "private, max-age=300");
  assert.equal(await result.text(), "foto-ficticia");
  db.close();
});
