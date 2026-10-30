import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiro/enviosPagamentoRoutes.ts", import.meta.url), "utf8");
const inicio = source.indexOf("enviosPagamentoRoutes.get('/envios-pagamento',");
const fim = source.indexOf("enviosPagamentoRoutes.get('/envios-pagamento/opcoes',", inicio);
const rota = source.slice(inicio, fim);

test("histórico pessoal é filtrado pelo usuário e papel financeiro mantém a visão global", () => {
  assert.match(rota, /await usuarioPodeGerenciarFinanceiro\(c\.env\.SHARE_DB, userId\)/);
  assert.match(rota, /if \(!podeConsultarTodos\)\s*\{\s*filtros\.push\('e\.criado_por = \?'\)/);
  assert.match(rota, /if \(tipo\)\s*\{\s*filtros\.push\('e\.tipo = \?'\)/);
  assert.match(rota, /WHERE \$\{filtros\.join\(' AND '\)\}/);
});
