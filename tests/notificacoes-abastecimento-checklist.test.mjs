import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const inicio = worker.indexOf("app.post('/api/interno/agendamento/:id/checklist'");
const fim = worker.indexOf("// ─── Share Brasil: ponto", inicio);
const checklist = worker.slice(inicio, fim);
const notifyInicio = worker.indexOf("async function notifyChecklistAbastecimento(");
const notifyFim = worker.indexOf("function notificationDestinations(", notifyInicio);
const notificador = worker.slice(notifyInicio, notifyFim);

test("abastecimento criado pelo checklist notifica financeiro, financeiro master e administradores", () => {
  assert.match(notificador, /IN \('financeiro', 'financeiro_admin', 'financeiroadmin', 'financeiro_master', 'financeiromaster', 'admin', 'administrador'\)/);
  assert.match(notificador, /IN \('financeiro', 'financeiro_admin', 'financeiroadmin', 'financeiro_master', 'financeiromaster', 'admin', 'administrador', 'administrativo'\)/);
  assert.match(notificador, /usuarios_funcoes/);
  assert.match(notificador, /abastecimento\/\$\{abastecimentoId\}/);
  assert.match(notificador, /finalizar o registro no financeiro/);
});

test("notificação só é disparada quando uma nova linha de abastecimento foi inserida", () => {
  assert.match(checklist, /let abastecimentoCriado = false/);
  assert.match(checklist, /abastecimentoCriado = true/);
  assert.equal([...checklist.matchAll(/notifyChecklistAbastecimento\(/g)].length, 1);
  assert.match(checklist, /if \(abastecimentoCriado && abastecimentoId\) await notifyChecklistAbastecimento/);
});
