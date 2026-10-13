import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/20261013_notificacoes.sql", import.meta.url), "utf8");
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

test("notificações de tarefas permanecem na tabela exclusiva de tarefas", () => {
  assert.match(notifyTask, /INSERT INTO tarefas_notificacoes/);
  assert.doesNotMatch(notifyTask, /INSERT INTO notificacoes/);
});

test("eventos de aprovação e rejeição do relatório usam notificacoes e id_from", () => {
  assert.match(notifyReports, /notifyUsers\(db, uniqueRecipients, `relatorio_despesa_viagem\/\$\{report\.id\}`/);
  assert.doesNotMatch(notifyReports, /tarefas_notificacoes|INSERT INTO tarefas/);
  assert.match(worker, /INSERT INTO notificacoes \(id, user_id, id_from, mensagem\)/);
});

test("API agrega as duas fontes e atualiza ou remove a tabela correspondente", () => {
  assert.match(notificationRoutes, /FROM tarefas_notificacoes/);
  assert.match(notificationRoutes, /FROM notificacoes n/);
  assert.match(notificationRoutes, /origem_notificacao/);
  assert.match(notificationRoutes, /c\.req\.query\('origem'\) === 'geral' \? 'notificacoes' : 'tarefas_notificacoes'/);
  assert.match(notificationRoutes, /DELETE FROM notificacoes WHERE user_id/);
});

test("migration define origem obrigatória e mensagem opcional para notificações", () => {
  assert.match(migration, /id_from TEXT NOT NULL/);
  assert.match(migration, /mensagem TEXT,/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS notificacoes/);
});
