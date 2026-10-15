import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");

test("listagem de planos de voo não limita o arquivo a 50 registros", () => {
  const trecho = source.slice(source.indexOf("app.get('/api/interno/planos-voo'"), source.indexOf("app.post('/api/interno/planos-voo'"));
  assert.match(trecho, /ORDER BY p\.criado_em DESC/);
  assert.doesNotMatch(trecho, /LIMIT 50/);
});
