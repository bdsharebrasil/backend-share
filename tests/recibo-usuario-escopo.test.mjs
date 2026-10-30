import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiro/recibosRoutes.ts", import.meta.url), "utf8");
const authSource = await readFile(new URL("../src/financeiro/financeiroAuth.ts", import.meta.url), "utf8");

test("usuários comuns consultam apenas recibos que criaram", () => {
  assert.match(source, /if \(!podeConsultarTodos\)\s*\{\s*filtros\.push\('criado_por = \?'\)\s*params\.push\(userId \?\? ''\)/);
});

test("upload e leitura de arquivo passam pela verificação do proprietário do recibo", () => {
  assert.match(authSource, /SELECT 1 FROM recibos WHERE id = \? AND criado_por = \? LIMIT 1/);
  assert.ok((source.match(/requisitantePodeAcessarRecibo\(c,/g) ?? []).length >= 6);
  assert.match(source, /if \(!row\.recibo_id \|\| !await requisitantePodeAcessarRecibo\(c, row\.recibo_id\)\) return c\.notFound\(\)/);
});

test("opções de recibos não incluem dados bancários de colaboradores", () => {
  const linhaColaboradores = source.split("\n").find((linha) => linha.includes("FROM user_profiles ORDER BY nome_completo")) ?? "";
  assert.match(linhaColaboradores, /SELECT id, nome_completo, nome_exibicao, cpf/);
  assert.doesNotMatch(linhaColaboradores, /nome_banco|conta_numero|agencia_numero|\bpix\b/);
});
