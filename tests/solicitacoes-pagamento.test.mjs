import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiroRoutes.ts", import.meta.url), "utf8");
const inicio = source.indexOf("financeiroRoutes.get('/solicitacoes-pagamento'");
const fim = source.indexOf("financeiroRoutes.get('/lancamentos/opcoes'", inicio);
const rota = source.slice(inicio, fim);

 test("solicitações de pagamento resolvem o fornecedor sem usar o criador como fornecedor", () => {
  assert.match(rota, /COALESCE\(NULLIF\(TRIM\(e\.fornecedor\), ''\), NULLIF\(TRIM\(ff\.apelido\), ''\), NULLIF\(TRIM\(ff\.nome_completo\), ''\), NULLIF\(TRIM\(fc\.nome_fornecedor\), ''\), NULLIF\(TRIM\(fc\.nome_cidade\), ''\)\) AS fornecedor_nome/);
  assert.match(rota, /LEFT JOIN fornecedores_favoritos ff ON ff\.id = e\.fornecedor_id/);
  assert.match(rota, /LEFT JOIN fornecedores_combustivel fc ON fc\.id = e\.fornecedor_id/);
  assert.match(rota, /COALESCE\(u\.nome_exibicao, u\.nome_completo, u\.email, e\.criado_por\) AS solicitante_nome/);
});

test("fila de reembolso colaborador exige colaborador_id e não expõe seu UUID como nome", () => {
  assert.match(rota, /AND NULLIF\(TRIM\(cp\.colaborador_id\), ''\) IS NOT NULL/);
  assert.match(rota, /COALESCE\(NULLIF\(TRIM\(u\.nome_exibicao\), ''\), NULLIF\(TRIM\(u\.nome_completo\), ''\), NULLIF\(TRIM\(u\.email\), ''\)\) AS solicitante_nome/);
  assert.doesNotMatch(rota, /COALESCE\([^\n]*cp\.colaborador_id\) AS solicitante_nome/);
});
