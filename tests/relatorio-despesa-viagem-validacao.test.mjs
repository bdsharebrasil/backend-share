import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calcularVencimentoReembolsoTripulante } from "../src/relatorioFinanceiro.ts";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const financeiro = await readFile(new URL("../src/relatorioFinanceiro.ts", import.meta.url), "utf8");
const inicioPatch = worker.indexOf("app.patch('/api/financeiro/relatorios-despesa-viagem/:id'");
const fimPatch = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/:id/finalizar'");
const rotaAtualizacao = worker.slice(inicioPatch, fimPatch);
const inicioMinhas = worker.indexOf("app.get('/api/financeiro/relatorios-despesa-viagem/minhas'");
const fimMinhas = worker.indexOf("app.get('/api/financeiro/relatorios-despesa-viagem',", inicioMinhas);
const rotaMinhas = worker.slice(inicioMinhas, fimMinhas);

test("criação de relatório exige trecho e tripulante", () => {
  const inicioCriacao = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem'");
  const fimCriacao = worker.indexOf("app.patch('/api/financeiro/relatorios-despesa-viagem/:id'");
  const rotaCriacao = worker.slice(inicioCriacao, fimCriacao);

  assert.match(rotaCriacao, /if \(!rota\) return c\.json\(\{ error: 'trecho_obrigatorio' \}, 400\)/);
  assert.match(rotaCriacao, /if \(!tripulacaoId && !nomeTripulante\) return c\.json\(\{ error: 'tripulante_obrigatorio' \}, 400\)/);
});

test("atualização rejeita campos obrigatórios vazios e preserva valores não enviados", () => {
  assert.match(rotaAtualizacao, /const rota = body\.rota === undefined \? String\(atual\.rota \|\| ''\)\.trim\(\)/);
  assert.match(rotaAtualizacao, /if \(!rota\) return c\.json\(\{ error: 'trecho_obrigatorio' \}, 400\)/);
  assert.match(rotaAtualizacao, /if \(!tripulacaoId && !nomeTripulante\) return c\.json\(\{ error: 'tripulante_obrigatorio' \}, 400\)/);
  assert.match(rotaAtualizacao, /rota = \?7/);
  assert.match(rotaAtualizacao, /tripulacaoId \|\| null, nomeTripulante \|\| null/);
});

test("aprovação já gravada pode repetir a sincronização financeira sem duplicar decisão", () => {
  const inicioPublica = worker.indexOf("app.post('/api/public/relatorios-despesa-viagem/aprovacao/:token'");
  const fimPublica = worker.indexOf("app.delete('/api/financeiro/relatorios-despesa-viagem/:id'", inicioPublica);
  const rotaPublica = worker.slice(inicioPublica, fimPublica);

  assert.match(rotaPublica, /retryApprovedSync = body\.aprovado === true && currentApprovalStatus === 'aprovado' && statusRelatorioViagem\(row\.status\) === 'aprovado'/);
  assert.match(rotaPublica, /if \(!retryApprovedSync\) \{\s*await c\.env\.SHARE_DB\.prepare\(`UPDATE relatorio_despesa_viagem/);
  assert.match(rotaPublica, /if \(!retryApprovedSync\) \{\s*try \{\s*await notifyReportDecision/);
  assert.match(rotaPublica, /await sincronizarRelatorioViagemFinanceiro\(c\.env\.SHARE_DB, \{ \.\.\.updated, data_vencimento_reembolso: dataVencimentoReembolso \}/);
});

test("aprovação persiste vencimento do reembolso e usa data de criação do relatório na despesa Share", () => {
  assert.equal(calcularVencimentoReembolsoTripulante({ aprovado_tripulante_1_em: "2026-10-13T20:00:00.000Z" }), "2026-10-16");
  assert.match(financeiro, /data_emissao: dateValue\(report\.criado_em, dateValue\(report\.data_inicio/);
  assert.match(financeiro, /cliente_id = \?, data_emissao = \?, data_vencimento = \?/);
  assert.match(worker, /persistirMetadadosFinanceirosRelatorio\(c\.env\.SHARE_DB, id, userId, null, false, dataVencimentoReembolso\)/);
  assert.match(financeiro, /addTripulantePayableStatements\(/);
});

test("listagem autenticada inclui comprovantes por despesa sem expor o caminho de armazenamento", () => {
  assert.match(rotaMinhas, /FROM relatorio_despesa_viagem_anexos/);
  assert.match(rotaMinhas, /WHERE relatorio_despesa_viagem_id IN \(\$\{placeholders\}\)/);
  assert.match(rotaMinhas, /url_arquivo: `\/api\/financeiro\/relatorios-despesa-viagem/);
  assert.match(rotaMinhas, /anexos: anexosPorRelatorio\.get\(row\.id\) \|\| \[\]/);
  assert.doesNotMatch(rotaMinhas, /caminho_arquivo/);
});
