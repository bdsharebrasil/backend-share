import test from "node:test";
import assert from "node:assert/strict";
import { classificarNaturezaCusto, projetarCustoPeriodo } from "../shared/natureza-custo.ts";

test("FIXO é forma de rateio: tipo, alias, categoria e periodicidade não definem a natureza", () => {
  for (const tipo of ["FIXO", "VARIAVEL_POR_HORA", "VARIAVEL_POR_VOO", "EXTRA"]) {
    assert.equal(classificarNaturezaCusto({ tipoRateio: tipo, tipo_rateio: tipo, grupoCategoria: tipo, categoria: "Manutenção", periodicidade: "MENSAL" }), "naoClassificados");
  }
});
test("natureza explícita é independente do rateio FIXO ou por utilização", () => {
  assert.equal(classificarNaturezaCusto({ naturezaCusto: "EXTRA", tipoRateio: "FIXO" }), "extras");
  assert.equal(classificarNaturezaCusto({ naturezaCusto: "VARIÁVEL POR HORA", tipoRateio: "FIXO" }), "variaveis");
  assert.equal(classificarNaturezaCusto({ natureza_custo: "FIXO", tipo_rateio: "VARIAVEL_POR_VOO" }), "fixos");
});
test("sem natureza, a estimativa usa o custo/hora observado e não inventa partes fixas ou variáveis", () => {
  const c = { total: 1559658, fixos: 0, variaveis: 0, extras: 0, naoClassificados: 1559658 };
  const p = projetarCustoPeriodo(c, 25 / 60, 1, 10, 2);
  assert.equal(p.metodo, "media_historica");
  assert.equal(Math.round(p.custoHora), 3743179);
  assert.equal(Math.round(p.custoMensal), 37431792);
  assert.equal(p.fixoHora, null);
  assert.equal(p.variavelHora, null);
  assert.equal(p.extraHora, null);
  assert.equal(projetarCustoPeriodo(c, 25 / 60, 1, 20, 1).custoHora, p.custoHora);
});
test("natureza econômica completa permite diluir fixos, mantendo todos os valores", () => {
  const p = projetarCustoPeriodo({ total: 60000, fixos: 40000, variaveis: 15000, extras: 5000, naoClassificados: 0 }, 10, 2, 5);
  assert.equal(p.metodo, "natureza_custo");
  assert.equal(p.fixoHora, 4000);
  assert.equal(p.variavelHora, 1500);
  assert.equal(p.extraHora, 500);
  assert.equal(p.custoHora, 6000);
  assert.equal(p.custoMensal, 30000);
});

