import test from "node:test";
import assert from "node:assert/strict";
import { nomearRotaRelatorio, sequenciaRotaRelatorio } from "../src/relatorioViagemRota.ts";

test("monta a rota cronológica incluindo pernas, sem destinos consecutivos repetidos nem retorno à origem", () => {
  const rota = sequenciaRotaRelatorio(" sbsp ", "sbrj", [
    { numero: 2, destino: "SBCF", jornada_numero: 1 },
    { numero: 1, destino: "SBRJ", jornada_numero: 1 },
    { numero: 1, destino: "SBSP", jornada_numero: 2 },
  ]);

  assert.deepEqual(rota, ["SBSP", "SBRJ", "SBCF"]);
});

test("ordena primeiro por jornada e depois pela perna, mesmo quando os dados chegam fora de ordem", () => {
  const rota = sequenciaRotaRelatorio("SBSP", "SBRJ", [
    { numero: 1, destino: "SBSP", jornada_numero: 2 },
    { numero: 2, destino: "SBCF", jornada_numero: 1 },
    { numero: 1, destino: "SBRJ", jornada_numero: 1 },
  ]);

  assert.deepEqual(rota, ["SBSP", "SBRJ", "SBCF"]);
});

test("usa nomes de aeródromos encontrados e mantém ICAO quando faltar cadastro", () => {
  assert.equal(
    nomearRotaRelatorio(["SBSP", "SBRJ", "SBCF"], new Map([["SBSP", "Aeroporto de Congonhas"]])),
    "Aeroporto de Congonhas - SBRJ - SBCF",
  );
});
