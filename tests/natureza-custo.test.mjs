import test from "node:test";
import assert from "node:assert/strict";
import { classificarNaturezaCusto, obterClassificacaoNatureza, projetarCustoPeriodo } from "../shared/natureza-custo.ts";

test("natureza não depende da forma de rateio nem da periodicidade", () => {
  for (const tipo of ["FIXO", "VARIAVEL_POR_HORA", "VARIAVEL_POR_VOO", "EXTRA"]) {
    assert.equal(classificarNaturezaCusto({ tipoRateio: tipo, tipo_rateio: tipo, grupoCategoria: tipo, categoria: "Sem categoria", periodicidade: "MENSAL" }), "naoClassificados");
    assert.equal(classificarNaturezaCusto({ tipoRateio: tipo, categoria: "MANUTENÇÃO" }), "variaveis");
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


test("natureza explícita prevalece sobre categoria e descrição", () => {
  assert.deepEqual(obterClassificacaoNatureza({ naturezaCusto: "FIXO", categoria: "MANUTENÇÃO", descricao: "TROCA DE PNEUS" }), { grupo: "fixos", origem: "informada" });
  assert.equal(classificarNaturezaCusto({ naturezaCusto: "", natureza_custo: "VARIÁVEL", categoria: "HANGARAGEM" }), "variaveis");
  assert.equal(classificarNaturezaCusto({ naturezaCusto: "INVÁLIDA", categoria: "HANGARAGEM" }), "naoClassificados");
});
test("categoria mista exige descrição e conflitos continuam sem classificação", () => {
  assert.equal(classificarNaturezaCusto({ categoria: "HANGARAGENS & TAXAS" }), "naoClassificados");
  assert.deepEqual(obterClassificacaoNatureza({ categoria: "HANGARAGENS & TAXAS", descricao: "TAXAS DECEA" }), { grupo: "variaveis", origem: "descricao" });
  assert.equal(classificarNaturezaCusto({ categoria: "HANGARAGENS & TAXAS", descricao: "HANGARAGEM" }), "fixos");
  assert.equal(classificarNaturezaCusto({ categoria: "HANGARAGEM", descricao: "TAXA DECEA" }), "naoClassificados");
  assert.equal(classificarNaturezaCusto({ descricao: "HANGARAGEM E TROCA DE PNEUS" }), "naoClassificados");
});
test("agosto PT-JPK: ADM/hangar fixos; DECEA, peças e pneus variáveis, sem mudar rateios", () => {
  const custos = [
    { categoria: "ADM E TRIP SHARE", descricao: "ADM E PILOT REF JULHO - PT-JPK", valor: 500000, tipoRateio: "FIXO" },
    { categoria: "TAXAS AEROPORTUÁRIAS", descricao: "TARIFA DECEA MAIO", valor: 7133, tipoRateio: "VARIAVEL POR VOO" },
    { categoria: "HANGARAREM", descricao: "HANGARAGEM REF. JULHO - PT-JPK", valor: 350000, tipoRateio: "FIXO" },
    { categoria: "MANUTENÇÃO", descricao: "PEÇAS MANUT. CORRETIVA", valor: 561000, tipoRateio: "VARIAVEL POR HORA" },
    { categoria: "MANUTENÇÃO", descricao: "M.O TROCA DOS PNEUS", valor: 141525, tipoRateio: "FIXO" },
  ];
  const antes = structuredClone(custos);
  const totais = { fixos: 0, variaveis: 0, extras: 0, naoClassificados: 0 };
  for (const custo of custos) totais[classificarNaturezaCusto(custo)] += custo.valor;
  assert.deepEqual(totais, { fixos: 850000, variaveis: 709658, extras: 0, naoClassificados: 0 });
  assert.equal(Object.values(totais).reduce((s, v) => s + v, 0), 1559658);
  assert.equal(classificarNaturezaCusto({ ...custos[4], tipoRateio: "EXTRA" }), "variaveis");
  assert.deepEqual(custos, antes);
});
