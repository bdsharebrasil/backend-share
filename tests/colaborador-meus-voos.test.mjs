import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../src/routes/colaboradorVoosRoutes.ts", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");

test("Meus Voos lista somente reservas designadas ao tripulante autenticado", () => {
  assert.match(route, /authenticatedColaborador\(c\)/);
  assert.match(route, /s\.piloto_id = \?1 OR s\.copiloto_id = \?1/);
  assert.match(route, /'aprovada', 'encerrada', 'concluida'/);
  assert.match(route, /FROM solicitacoes_reserva_voo s/);
  assert.match(worker, /app\.route\('\/', colaboradorVoosRoutes\)/);
});

test("detalhe do voo exige vínculo do usuário como piloto ou copiloto", () => {
  assert.match(route, /WHERE s\.id = \?1 AND \(s\.piloto_id = \?2 OR s\.copiloto_id = \?2\)/);
  assert.match(route, /if \(!voo\) return c\.notFound\(\)/);
});

test("detalhe reúne hospedagem no período do voo e mensagens recebidas que mencionam o voo", () => {
  assert.match(route, /FROM reservas_hoteis r/);
  assert.match(route, /r\.criado_por = \?1/);
  assert.match(route, /date\(r\.data_checkin\) <= date\(\?3\)/);
  assert.match(route, /m\.destinatario_id = \?1/);
  assert.match(route, /instr\(lower\(COALESCE\(m\.assunto/);
});
