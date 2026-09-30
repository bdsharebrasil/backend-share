import test from "node:test";
import assert from "node:assert/strict";
import { calcularVencimentoReembolsoTripulante } from "../src/relatorioFinanceiro.ts";

test("vence três dias corridos após a aprovação do tripulante quando há um aprovador", () => {
  assert.equal(
    calcularVencimentoReembolsoTripulante({ aprovado_tripulante_1_em: "2026-09-30 12:31:46" }),
    "2026-10-03",
  );
});

test("usa a data da última aprovação quando o relatório exige dois tripulantes", () => {
  assert.equal(
    calcularVencimentoReembolsoTripulante({
      aprovado_tripulante_1_em: "2026-09-28 09:00:00",
      aprovado_tripulante_2_em: "2026-09-30 12:31:46",
    }),
    "2026-10-03",
  );
});

test("calcula dias corridos atravessando fevereiro bissexto e a virada do ano", () => {
  assert.equal(
    calcularVencimentoReembolsoTripulante({ aprovado_tripulante_1_em: "2024-02-28 15:00:00" }),
    "2024-03-02",
  );
  assert.equal(
    calcularVencimentoReembolsoTripulante({ aprovado_tripulante_1_em: "2026-12-30 15:00:00" }),
    "2027-01-02",
  );
});
