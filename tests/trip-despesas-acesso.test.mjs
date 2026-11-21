import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const auth = await readFile(new URL("../src/financeiro/financeiroAuth.ts", import.meta.url), "utf8");

function route(source, start, end) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, `Rota ausente: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `Rota seguinte ausente: ${end}`);
  return source.slice(a, b);
}

test("finalização da tripulação é autorizada no middleware e protegida por vínculo ao relatório", () => {
  assert.match(auth, /relatorios-despesa-viagem.*finalizar/);
  const finalize = route(worker,
    "app.post('/api/financeiro/relatorios-despesa-viagem/:id/finalizar'",
    "app.post('/api/financeiro/relatorios-despesa-viagem/:id/voltar-rascunho'");
  assert.match(finalize, /buscarPosicaoTripulanteRelatorio\(db, id, user\.id\)/);
  assert.match(finalize, /usuarioPodeGerenciarFinanceiro\(db, user\.id\)/);
  assert.match(finalize, /relatorio_nao_pertence_ao_tripulante/);
  assert.match(finalize, /relatorio_sem_despesas/);
  assert.match(finalize, /statusFinalizado/);
});

test("PDF privado exige tripulante proprietário ou financeiro autorizado", () => {
  const pdf = route(worker,
    "app.get('/api/financeiro/relatorios-despesa-viagem/:id/pdf'",
    "function parseRejectionAttachments(");
  assert.match(pdf, /authenticatedColaborador\(c\)/);
  assert.match(pdf, /buscarPosicaoTripulanteRelatorio\(c\.env\.SHARE_DB, id, user\.id\)/);
  assert.match(pdf, /relatorio_nao_pertence_ao_tripulante/);
  assert.match(pdf, /Cache-Control': 'private, no-store'/);
  assert.match(pdf, /Content-Type': 'application\/pdf'/);
});

test("comprovantes de minhas usam rota específica que verifica posse do tripulante", () => {
  const minhas = route(worker,
    "app.get('/api/financeiro/relatorios-despesa-viagem/minhas'",
    "app.get('/api/financeiro/relatorios-despesa-viagem',");
  assert.match(minhas, /anexos-tripulante\/\$\{encodeURIComponent\(anexo\.id\)\}\/arquivo/);
  const proof = route(worker,
    "app.get('/api/financeiro/relatorios-despesa-viagem/:id/anexos-tripulante/:anexoId/arquivo'",
    "app.post('/api/financeiro/relatorios-despesa-viagem/:id/finalizar'");
  assert.match(proof, /buscarPosicaoTripulanteRelatorio\(c\.env\.SHARE_DB, idRelatorio, user\.id\)/);
});
