import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiro/dashboardCotistaRoutes.ts", import.meta.url), "utf8");

function projectionColumnCount(branch) {
  const selectIndex = branch.search(/\bSELECT\b/i);
  const fromIndex = branch.search(/\bFROM\b/i);
  assert.notEqual(selectIndex, -1, "cada ramificação deve iniciar com SELECT");
  assert.notEqual(fromIndex, -1, "cada ramificação deve conter FROM");

  const projection = branch
    .slice(selectIndex + "SELECT".length, fromIndex)
    .replace(/\$\{[^{}]*\}/g, "NULL");
  let columns = 1;
  let parenthesisDepth = 0;
  let inString = false;

  for (let index = 0; index < projection.length; index += 1) {
    const character = projection[index];
    if (inString) {
      if (character === "'" && projection[index + 1] === "'") index += 1;
      else if (character === "'") inString = false;
      continue;
    }
    if (character === "'") inString = true;
    else if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth -= 1;
    else if (character === "," && parenthesisDepth === 0) columns += 1;
  }
  return columns;
}

test("dashboard Cotista mantém a mesma projeção nas quatro fontes do UNION ALL", () => {
  const query = source.match(/const rows = await listar\(db, `([\s\S]*?)`, \.\.\.paramsCliente/);
  assert.ok(query, "consulta consolidada do dashboard deve existir");

  const branches = query[1].split(/\bUNION ALL\b/i);
  assert.equal(branches.length, 4, "esperadas as fontes cliente, holding, lançamentos e movimentos");

  const columnCounts = branches.map(projectionColumnCount);
  assert.equal(
    new Set(columnCounts).size,
    1,
    `todas as projeções precisam ter a mesma quantidade de colunas; obtido: ${columnCounts.join(", ")}`,
  );

  const descriptionSlots = [
    /r\.data_emissao AS data,\s*r\.descricao_despesa AS descricao,/,
    /r\.data_emissao AS data,\s*r\.descricao_despesa AS descricao,/,
    /l\.data_emissao AS data,\s*l\.descricao AS descricao,/,
    /mh\.data_emissao AS data,\s*mh\.descricao AS descricao,/,
  ];
  branches.forEach((branch, index) => {
    assert.match(branch, descriptionSlots[index], `a fonte ${index + 1} deve preencher a coluna descricao na mesma posição`);
  });
});
