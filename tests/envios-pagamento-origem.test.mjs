import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../src/financeiro/enviosPagamentoRoutes.ts", import.meta.url), "utf8");

test("despesas de origem exigem aeronave e origem, mas não número de voo", () => {
  assert.match(route, /if \(!aeronaveId \|\| !\['ABASTECIMENTO', 'RECIBOS', 'RELATORIOS DE VIAGEM'\]/);
  assert.match(route, /numeroVoo \? ' AND TRIM\(a\.numero_voo\) = \?' : ''/);
  assert.match(route, /numeroVoo \? ' AND TRIM\(r\.numero_voo\) = \?' : ''/);
});

test("exclusão de rascunho apaga os destinatários e preserva envios financeiros", () => {
  assert.match(route, /enviosPagamentoRoutes\.delete\('\/envios-pagamento\/rascunhos\/:id'/);
  assert.match(route, /SELECT id FROM envio_pagamento_rascunhos WHERE id = \? AND criado_por = \?/);
  assert.match(route, /DELETE FROM envio_pagamento_email_destinatarios WHERE rascunho_id = \?/);
  assert.match(route, /DELETE FROM envio_pagamento_rascunhos WHERE id = \? AND criado_por = \?/);
  assert.match(route, /AND \(e\.id IS NULL OR UPPER\(COALESCE\(e\.status, ''\)\) <> 'CONCLUIDO'\)/);
});
