import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../src/routes/colaboradorVoosRoutes.ts", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const auth = await readFile(new URL("../src/lib/auth.ts", import.meta.url), "utf8");
const ctm = await readFile(new URL("../src/routes/ctmRoutes.ts", import.meta.url), "utf8");
const jornadas = await readFile(new URL("../src/routes/jornadasRoutes.ts", import.meta.url), "utf8");

test("Meus Voos lista somente reservas designadas ao tripulante autenticado", () => {
  assert.match(route, /authenticatedColaborador\(c\)/);
  assert.match(route, /s\.piloto_id = \?1 OR s\.copiloto_id = \?1/);
  assert.match(route, /'aprovada', 'em_voo'.*'em_solo'.*'encerrada', 'concluida'/);
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

test("operações compartilhadas do voo exigem colaborador autenticado ou autenticação interna", () => {
  assert.match(auth, /export async function requireFlightOperationAccess/);
  assert.match(auth, /if \(await checkInternalAuth\(c\)\) return true/);
  assert.match(auth, /authenticatedColaborador\(c\)/);
  assert.match(auth, /return Boolean\(user\)/);
  assert.doesNotMatch(auth, /solicitacaoId, tripulante\.id/);
  assert.match(worker, /requireFlightOperationAccess\(c, c\.req\.param\('id'\)\)/);
  assert.match(ctm, /requireFlightOperationAccess\(c, c\.req\.param\('id'\)\)/);
  assert.match(jornadas, /requireFlightOperationAccess\(c, c\.req\.param\('id'\)\)/);
  assert.match(jornadas, /requireFlightOperationAccess\(c, jornada\.solicitacao_id\)/);
});
