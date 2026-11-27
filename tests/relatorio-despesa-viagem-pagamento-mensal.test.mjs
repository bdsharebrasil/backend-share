import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const start = worker.indexOf("app.get('/api/financeiro/relatorios-despesa-viagem/minhas'");
const end = worker.indexOf("app.get('/api/financeiro/relatorios-despesa-viagem',", start);
const route = worker.slice(start, end);
const monthSummaryStart = route.indexOf("SELECT COALESCE(SUM(cp.valor_centavos), 0) AS pago_mes_centavos");
const monthSummaryEnd = route.indexOf("const reportRows", monthSummaryStart);
const monthSummary = route.slice(monthSummaryStart, monthSummaryEnd);

test("o total do mês soma apenas baixas pagas vinculadas ao tripulante autenticado", () => {
  assert.match(route, /const requestedMonth = String\(c\.req\.query\('mes'\)/);
  assert.match(route, /const paymentMonth = \/\^\\d\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$\//);
  assert.match(monthSummary, /cp\.idempotency_key = 'RELATORIO_DESPESA_VIAGEM:' \|\| r\.id/);
  assert.match(monthSummary, /CASE WHEN t1\.user_id = \?1 THEN 'tripulante_1' ELSE 'tripulante_2' END/);
  assert.match(monthSummary, /upper\(COALESCE\(cp\.status, ''\)\) = 'PAGO'/);
  assert.match(monthSummary, /cp\.data_pagamento IS NOT NULL/);
  assert.match(monthSummary, /substr\(cp\.data_pagamento, 1, 7\) = \?2/);
  assert.match(route, /resumo_pagamentos:\s*\{\s*mes: paymentMonth,\s*pago_mes_centavos:/);
});

test("a soma mensal percorre contas de todos os relatórios, não só os 200 exibidos", () => {
  assert.match(monthSummary, /SUM\(cp\.valor_centavos\)/);
  assert.match(monthSummary, /INNER JOIN relatorio_despesa_viagem r/);
  assert.doesNotMatch(monthSummary, /LIMIT 200/);
});

test("cada card recebe a data e o valor pagos da conta ligada à sua posição", () => {
  assert.match(route, /MAX\(cp\.data_pagamento\)[\s\S]*AS pagamento_data/);
  assert.match(route, /pagamento_valor: Number\(row\.pagamento_pago_centavos \|\| 0\) \/ 100/);
  assert.match(route, /pagamento_data: row\.pagamento_data \|\| null/);
});
