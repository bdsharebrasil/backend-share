import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [financeiroRoutes, emailsRoutes] = await Promise.all([
  readFile(new URL('../src/financeiroRoutes.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/emailsRoutes.ts', import.meta.url), 'utf8'),
]);

const resolverInicio = financeiroRoutes.indexOf('async function origemRateio(');
const resolverFim = financeiroRoutes.indexOf("financeiroRoutes.get('/dashboard/financeiro/movimentacoes/:origemTipo/:origemId/rateio-opcoes'", resolverInicio);
const resolver = financeiroRoutes.slice(resolverInicio, resolverFim);
const rateioOpcoesInicio = resolverFim;
const rateioPostInicio = financeiroRoutes.indexOf("financeiroRoutes.post('/dashboard/financeiro/movimentacoes/:origemTipo/:origemId/rateio'", rateioOpcoesInicio);
const rateioPostFim = financeiroRoutes.indexOf("financeiroRoutes.get('/dashboard/financeiro/movimentacoes'", rateioPostInicio);
const rateioOpcoes = financeiroRoutes.slice(rateioOpcoesInicio, rateioPostInicio);
const rateioPost = financeiroRoutes.slice(rateioPostInicio, rateioPostFim);
const marcadorInicio = emailsRoutes.indexOf('async function marcarEmailEnviadoParaOrigens(');
const marcadorFim = emailsRoutes.indexOf("emailRoutes.get('/api/email-envios'", marcadorInicio);
const marcadorEmail = emailsRoutes.slice(marcadorInicio, marcadorFim);

test('origem lancamentos resolve envio_despesas convertido sem duplicar centavos', () => {
  assert.match(resolver, /FROM lancamentos WHERE id = \?/);
  assert.match(resolver, /FROM envio_despesas WHERE id = \? OR lancamento_id = \? LIMIT 1/);
  assert.match(resolver, /Math\.round\(Number\(envio\.valor_total_despesa \?\? envio\.valor \?\? 0\) \* 100\)/);
  assert.match(resolver, /data_emissao: envio\.data_despesa/);
  assert.match(resolver, /envioConvertido: String\(envio\.status \?\? ''\)\.toUpperCase\(\) === 'CONVERTIDO'/);
});

test('envio convertido não permite rateio duplicado e o fluxo de email continua independente', () => {
  assert.match(rateioOpcoes, /if \(origem\.envioConvertido\) return c\.json\(\{ error: 'rateio_ja_existente' \}, 409\)/);
  assert.match(rateioPost, /if \(origem\.envioConvertido\) return c\.json\(\{ error: 'rateio_ja_existente' \}, 409\)/);
  assert.match(marcadorEmail, /if \(prefix === 'lancamento'\)[\s\S]*FROM envio_despesas WHERE id = \?1 OR lancamento_id = \?1 LIMIT 1/);
  assert.match(marcadorEmail, /UPDATE envio_despesas SET email_enviado = 1, email_enviado_em = \?, email_id = \? WHERE id = \?/);
});
