import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const inicioPatch = worker.indexOf("app.patch('/api/financeiro/relatorios-despesa-viagem/:id'");
const fimPatch = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/:id/finalizar'");
const rotaAtualizacao = worker.slice(inicioPatch, fimPatch);

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
