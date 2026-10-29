import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [worker, schema] = await Promise.all([
  readFile(new URL("../src/worker.ts", import.meta.url), "utf8"),
  readFile(new URL("../schema.sql", import.meta.url), "utf8"),
]);
const agendaRoutes = worker.slice(
  worker.indexOf("app.get('/api/sharebrasil/contatos'"),
  worker.indexOf("async function garantirForeignKeyCotistas"),
);

test("fluxo da agenda acessa exclusivamente agenda_contatos_fornecedores", () => {
  assert.ok(agendaRoutes.length > 0, "rotas da agenda encontradas");
  assert.doesNotMatch(agendaRoutes, /\b(?:FROM|INTO|UPDATE|JOIN)\s+agenda_contatos\b|\bDELETE\s+FROM\s+agenda_contatos\b/i);
  assert.match(agendaRoutes, /FROM agenda_contatos_fornecedores/);
  assert.match(agendaRoutes, /INSERT INTO agenda_contatos_fornecedores/);
  assert.match(agendaRoutes, /DELETE FROM agenda_contatos_fornecedores/);
  assert.doesNotMatch(schema, /CREATE TABLE agenda_contatos\s*\(/);
  assert.match(schema, /CREATE TABLE agenda_contatos_fornecedores\s*\(/);
});
