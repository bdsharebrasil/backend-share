import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/20261028_relatorio_viagem_unicidade_numero_voo.sql", import.meta.url), "utf8");

const inicioListagem = worker.indexOf("app.get('/api/financeiro/relatorios-despesa-viagem/meus-voos'");
const fimListagem = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/iniciar-do-voo'", inicioListagem);
const rotaListagem = worker.slice(inicioListagem, fimListagem);
const inicioRelatorio = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/iniciar-do-voo'");
const fimRelatorio = worker.indexOf("\napp.", inicioRelatorio + 5);
const rotaRelatorio = worker.slice(inicioRelatorio, fimRelatorio);

test("lista todos os voos atribuídos, inclusive concluídos e antigos", () => {
  assert.match(rotaListagem, /AND \(t1\.user_id = \?1 OR t2\.user_id = \?1\)/);
  assert.doesNotMatch(rotaListagem, /s\.status|date\(s\.data_agendada\) >= date\('now'/);
  assert.doesNotMatch(rotaListagem, /LIMIT 200/);
});

test("início aceita voo de qualquer status e exige vínculo do usuário com a tripulação", () => {
  assert.match(rotaRelatorio, /WHERE s\.numero_voo = \?1 AND \(t1\.user_id = \?2 OR t2\.user_id = \?2\)/);
  assert.doesNotMatch(rotaRelatorio, /s\.status|IN \('aprovada', 'acionado'/);
});

test("relatório existente pelo número do voo é reutilizado e não duplica rascunho tripulante", () => {
  assert.match(rotaRelatorio, /WHERE r\.numero_voo = \?1/);
  assert.match(rotaRelatorio, /buscarRelatorioViagemComNomes\(c, relatorioExistente\.id\)/);
  assert.match(migration, /ON relatorio_despesa_viagem\(numero_voo\)/);
  assert.match(rotaListagem, /SELECT r\.id FROM relatorio_despesa_viagem r WHERE r\.numero_voo = s\.numero_voo/);
});
