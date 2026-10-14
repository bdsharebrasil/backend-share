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

test("resumo fornece a URL da foto diretamente da coluna D1 da aeronave", () => {
  assert.match(rotaResumo, /a\.url_imagem\s+AS\s+image_url/);
  assert.match(rotaResumo, /FROM aeronave a/);
});

test("opções D1 fornecem coordenadas de aeródromos usadas nos cálculos do formulário", () => {
  assert.match(source, /SELECT id, designativo_icao AS designativo, nome, coordenadas FROM aerodromo/);
});
