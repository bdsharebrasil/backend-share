import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/routes/diarioBordoRoutes.ts", import.meta.url), "utf8");
const inicioResumo = source.indexOf("diarioBordoRoutes.get('/api/interno/diario-bordo/resumo'");
const fimResumo = source.indexOf("diarioBordoRoutes.get('/api/interno/diario-bordo/detalhes'", inicioResumo);
const rotaResumo = source.slice(inicioResumo, fimResumo);

test("resumo do Diário de Bordo lista somente aeronaves ativas", () => {
  assert.match(rotaResumo, /FROM aeronave a/);
  assert.match(rotaResumo, /WHERE\s+lower\(COALESCE\(a\.status,\s*'ativa'\)\)\s+LIKE\s+'ativ%'/i);
});
