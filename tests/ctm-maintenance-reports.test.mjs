import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getAircraftIdsInMaintenance, isActiveCTMServiceOrder } from "../src/lib/ctmMaintenanceStatus.ts";

const source = await readFile(new URL("../src/routes/ctmRoutes.ts", import.meta.url), "utf8");
const inicio = source.indexOf("ctmRoutes.get('/api/ctm/relatorios-manutencao'");
const fim = source.indexOf("for (const [slug", inicio);
const rota = source.slice(inicio, fim);

test("relatórios de manutenção listam somente aeronaves ativas", () => {
  assert.match(rota, /FROM aeronave WHERE lower\(COALESCE\(status, 'ativa'\)\) LIKE 'ativ%'/i);
  assert.match(rota, /r\.aeronave_id IN \(SELECT id FROM aeronave WHERE lower\(COALESCE\(status, 'ativa'\)\) LIKE 'ativ%'\)/i);
});

test("relatórios calculam manutenção pelas ordens OAS abertas, não pelo status da aeronave", () => {
  assert.match(rota, /ctm_ordem_acompanhamento_servico/);
  assert.match(rota, /getAircraftIdsInMaintenance\(orders\.results/);
  assert.match(rota, /in_maintenance: aircraftInMaintenance\.has\(String\(item\.id\)\)/);
  assert.doesNotMatch(rota, /status: item\.status/);
});

test("somente ordens OAS não encerradas sinalizam aeronave em manutenção", () => {
  assert.equal(isActiveCTMServiceOrder("Em andamento"), true);
  assert.equal(isActiveCTMServiceOrder("  ABERTA "), true);
  assert.equal(isActiveCTMServiceOrder("Concluída"), false);
  assert.equal(isActiveCTMServiceOrder("CANCELADO"), false);
  assert.equal(isActiveCTMServiceOrder(""), false);

  assert.deepEqual(
    [...getAircraftIdsInMaintenance([
      { aeronave_id: "a-1", status: "Em andamento" },
      { aeronave_id: "a-1", status: "Concluída" },
      { aeronave_id: "a-2", status: "Cancelada" },
      { aeronave_id: "a-3", status: "" },
      { aeronave_id: "", status: "Aberta" },
    ])],
    ["a-1"],
  );
});
