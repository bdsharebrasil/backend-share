import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8");
const start = source.indexOf("financeiroRoutes.get('/lancamentos',");
const end = source.indexOf("financeiroRoutes.get('/", start + 1);
const rota = source.slice(start, end);

test("listagem de lançamentos resolve colaborador vinculado ao favorecido", () => {
  assert.match(rota, /LEFT JOIN user_profiles up_colaborador ON up_colaborador\.id = l\.colaborador_id/);
  assert.match(rota, /up_colaborador\.nome_exibicao[\s\S]*up_colaborador\.nome_completo[\s\S]*up_colaborador\.email[\s\S]*AS colaborador_nome/);
});
