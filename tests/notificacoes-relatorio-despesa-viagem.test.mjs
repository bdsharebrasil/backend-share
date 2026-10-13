import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const inicioNotifyTask = worker.indexOf("async function notifyTask(");
const fimNotifyTask = worker.indexOf("async function notifyUsers(", inicioNotifyTask);
const notifyTask = worker.slice(inicioNotifyTask, fimNotifyTask);
const inicioReportRejection = worker.indexOf("async function notifyReportRejection(");
const inicioReportDecision = worker.indexOf("async function notifyReportDecision(", inicioReportRejection);
const fimReportDecision = worker.indexOf("// ─── Aeronaves Share Brasil", inicioReportDecision);
const notifyReports = worker.slice(inicioReportRejection, fimReportDecision);
const inicioRoute = worker.indexOf("app.get('/api/sharebrasil/notificacoes'");
const fimRoute = worker.indexOf("app.get('/api/sharebrasil/calendario/categorias'", inicioRoute);
const notificationRoutes = worker.slice(inicioRoute, fimRoute);

test("notificações de tarefas permanecem exclusivamente em tarefas_notificacoes", () => {
  assert.match(notifyTask, /INSERT INTO tarefas_notificacoes/);
  assert.doesNotMatch(notifyTask, /INSERT INTO notificacoes/);
});

test("relatórios usam a tabela notificacoes existente com id_from e destinatário", () => {
  assert.match(notifyReports, /notifyUsers\(db, uniqueRecipients, `relatorio_despesa_viagem\/\$\{report\.id\}`/);
  assert.doesNotMatch(notifyReports, /tarefas_notificacoes|INSERT INTO tarefas/);
  assert.match(worker, /INSERT INTO notificacoes \(id, id_from, departamento_destinatario, status, mensagem\)/);
  assert.doesNotMatch(worker, /CREATE TABLE(?: IF NOT EXISTS)? notificacoes/i);
});

test("API filtra por user/departamento e converte status para estado lido", () => {
  assert.match(notificationRoutes, /FROM tarefas_notificacoes/);
  assert.match(notificationRoutes, /FROM notificacoes n/);
  assert.match(notificationRoutes, /departamento_destinatario/);
  assert.match(worker, /'nao_lida'/);
  assert.match(notificationRoutes, /SET status = 'lida'/);
  assert.match(notificationRoutes, /CASE WHEN lower\(COALESCE\(n\.status, ''\)\) IN \('lida', 'lido', 'read'\) THEN 1 ELSE 0 END AS lido/);
  assert.match(notificationRoutes, /DELETE FROM notificacoes WHERE lower\(trim\(COALESCE\(departamento_destinatario/);
});
