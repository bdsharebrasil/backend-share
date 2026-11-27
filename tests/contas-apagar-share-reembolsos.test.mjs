import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiro/contasRoutes.ts", import.meta.url), "utf8");
const start = source.indexOf("async function consultarContas");
const end = source.indexOf("contasRoutes.get('/contas-apagar'", start);
const consulta = source.slice(start, end);

test("contas a pagar preserva filtro padrão e permite recuperar obrigação Share reembolsável vinculada", () => {
  assert.match(consulta, /const incluirReembolsos = c\.req\.query\('incluirReembolsos'\) === 'true'/);
  assert.match(consulta, /if \(incluirReembolsos\)\s*\{\s*filtros\.push\("NULLIF\(TRIM\(cp\.colaborador_id\), ''\) IS NULL"\)\s*\} else \{[\s\S]*?COALESCE\(l\.reembolsavel, 0\) = 0[\s\S]*?NOT LIKE '%REEMBOLS%'/);
  assert.match(consulta, /UPPER\(COALESCE\(cp\.origem_tipo, ''\)\) <> 'RELATORIO_DESPESA_VIAGEM'/);
});

test("listagem de contas a pagar resolve o nome do colaborador associado", () => {
  assert.match(consulta, /LEFT JOIN user_profiles up_colaborador ON up_colaborador\.id = cp\.colaborador_id/);
  assert.match(consulta, /up_colaborador\.nome_exibicao[\s\S]*up_colaborador\.nome_completo[\s\S]*up_colaborador\.email[\s\S]*AS colaborador_nome/);
});
