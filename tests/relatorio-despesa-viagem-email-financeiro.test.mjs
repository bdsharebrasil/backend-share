import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const emailRoutes = await readFile(new URL("../src/routes/emailsRoutes.ts", import.meta.url), "utf8");
const routeStart = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/:id/enviar-cliente'");
const routeEnd = worker.indexOf("app.post('/api/public/relatorios-despesa-viagem/aprovacao/:token'", routeStart);
const reportEmailRoute = worker.slice(routeStart, routeEnd);
const reportEmailAssociation = emailRoutes.slice(emailRoutes.indexOf("} else if (prefix === 'relatorio_pdf')"), emailRoutes.indexOf("} else if (prefix === 'envio_despesa')"));

test("programação idempotente do relatório repara os metadados de email nos lançamentos do cliente e holding", () => {
  assert.match(reportEmailRoute, /\['aprovado', 'enviado_cliente'\]/);
  assert.match(reportEmailRoute, /SET email_enviado_id = \?, email_enviado_em = COALESCE\(email_enviado_em, CURRENT_TIMESTAMP\)[\s\S]*?idempotency_key IN/);
  assert.match(reportEmailRoute, /UPDATE movimentos_holding[\s\S]*?SET email_enviado_id = \?, email_enviado_em = COALESCE/);
});

test("envio do PDF do relatório também associa emails a lançamentos quando não existe financeiro_vinculos", () => {
  assert.match(reportEmailAssociation, /SELECT id FROM lancamentos[\s\S]*?origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = \?1/);
  assert.match(reportEmailAssociation, /lancamentoIds\.push/);
});
