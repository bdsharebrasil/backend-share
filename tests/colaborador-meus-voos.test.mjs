import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { statusPermiteEdicaoFichaPeso } from "../src/routes/ctmRoutes.ts";

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

test("detalhe reúne hospedagem, exibe cliente/cotista em um único campo e usa observações da solicitação como mensagem", () => {
  assert.match(route, /FROM reservas_hoteis r/);
  assert.match(route, /r\.criado_por = \?1/);
  assert.match(route, /date\(r\.data_checkin\) <= date\(\?3\)/);
  assert.match(route, /AS cliente_tipo/);
  assert.match(route, /AS cliente_razao_social/);
  assert.match(route, /const \{ observacoes, \.\.\.vooSemObservacoes \} = voo/);
  assert.match(route, /mensagem: observacoes \?\? null/);
  assert.doesNotMatch(route, /FROM mensagens/);
});

test("ficha pendente pode ser salva em voo aprovado, em operação ou encerrado", () => {
  for (const status of ["aprovada", "em_voo", "em_rota", "em_solo", "pousado", "encerrada", "concluida"]) {
    assert.equal(statusPermiteEdicaoFichaPeso(status), true, `status ${status}`);
  }
  for (const status of ["pendente", "cancelada", "reprovada", "desconhecida"]) {
    assert.equal(statusPermiteEdicaoFichaPeso(status), false, `status ${status}`);
  }
  assert.match(ctm, /if \(!statusPermiteEdicaoFichaPeso\(reserva\.status\)\)/);
  assert.match(ctm, /if \(existente\?\.status === 'FINALIZADA'\)/);
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
