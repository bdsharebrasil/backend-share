import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
const rotasHoteis = worker.slice(worker.indexOf("// ─── Hotéis Share Brasil"), worker.indexOf("app.post('/api/sharebrasil/hoteis/:id/reservar'"));
const rotaCriarHotel = worker.slice(worker.indexOf("app.post('/api/sharebrasil/hoteis',"), worker.indexOf("app.patch('/api/sharebrasil/hoteis/:id',"));
const rotaEditarHotel = worker.slice(worker.indexOf("app.patch('/api/sharebrasil/hoteis/:id',"), worker.indexOf("app.delete('/api/sharebrasil/hoteis/:id',"));
const rotaExcluirHotel = worker.slice(worker.indexOf("app.delete('/api/sharebrasil/hoteis/:id',"), worker.indexOf("app.post('/api/sharebrasil/hoteis/:id/reservar'"));

test("normaliza café da manhã como SIM, NÃO ou preço cobrado positivo", () => {
  assert.match(rotasHoteis, /function normalizarCafeManhaHotel\(value: unknown\)/);
  assert.match(rotasHoteis, /columns:\['id','cafe_manha'\]/);
  assert.match(rotasHoteis, /if \(opcao === 'SIM'\) return 'SIM'/);
  assert.match(rotasHoteis, /if \(opcao === 'NAO'\) return 'NÃO'/);
  assert.match(rotasHoteis, /Number\.isFinite\(valor\) && valor > 0 \? valor\.toFixed\(2\) : false/);
});

test("criação e edição gravam cafe_manha na tabela hoteis", () => {
  assert.match(rotasHoteis, /INSERT INTO hoteis \([^)]*observacoes, cafe_manha\)/);
  assert.match(rotasHoteis, /UPDATE hoteis SET[^']*observacoes=\?, cafe_manha=\?/);
  assert.match(rotasHoteis, /normalizarCafeManhaHotel\(body\.cafe_manha\)/);
  assert.match(rotasHoteis, /normalizarCafeManhaHotel\(value\('cafe_manha'\)\)/);
  assert.match(schema, /CREATE TABLE hoteis \([\s\S]*?observacoes TEXT,\s+cafe_manha TEXT\s*\);/);
});

test("qualquer usuário autenticado pode cadastrar e editar hotéis; exclusão continua de gestor", () => {
  assert.match(rotaCriarHotel, /shareBrasilUser\(c\)/);
  assert.doesNotMatch(rotaCriarHotel, /isColaboradorManager/);
  assert.match(rotaEditarHotel, /shareBrasilUser\(c\)/);
  assert.doesNotMatch(rotaEditarHotel, /isColaboradorManager/);
  assert.match(rotaExcluirHotel, /isColaboradorManager/);
});
