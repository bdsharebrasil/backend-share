import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { contextoBaixaCotista } from '../src/financeiro/FinanceiroKernel.ts';

const kernel = await readFile(new URL('../src/financeiro/FinanceiroKernel.ts', import.meta.url), 'utf8');
const contexto = kernel.slice(
  kernel.indexOf('export async function contextoBaixaCotista('),
  kernel.indexOf('export async function settleCotista(', kernel.indexOf('export async function contextoBaixaCotista(')),
);
const baixaDireta = kernel.slice(
  kernel.indexOf('export async function settleCotista('),
  kernel.indexOf('function receiptReplayMatches(', kernel.indexOf('export async function settleCotista(')),
);

function bancoContexto(rateio, envio) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            first: async () => {
              if (sql.includes('FROM rateio_despesas WHERE id = ?')) return values[0] === rateio.id ? rateio : null;
              if (sql.includes('FROM lancamentos WHERE id = ?')) return null;
              if (sql.includes('FROM envio_despesas')) {
                return envio.id === values[0] || envio.lancamento_id === values[1] ? envio : null;
              }
              throw new Error(`Consulta não simulada: ${sql}`);
            },
          };
        },
      };
    },
  };
}

test('contexto resolve o envio por ID ou lancamento_id e identifica pagamento direto pelo caixa CLIENTE', () => {
  assert.match(contexto, /SELECT id, tipo, tipo_caixa, status, descricao, aeronave_id, lancamento_id[\s\S]*FROM envio_despesas WHERE id = \? OR lancamento_id = \?/);
  assert.match(contexto, /upper\(envio\.tipo\) === 'CLIENTE' \|\| upper\(envio\.tipo_caixa\) === 'CLIENTE'/);
  assert.match(contexto, /envio_lancamento_id: envioLancamentoId/);
  assert.match(contexto, /natureza: 'PAGAMENTO_DIRETO'/);
});

test('rateio ligado ao envio por lancamento_id sem lancamento Share fica elegível sem conta bancária', async () => {
  const rateio = {
    id: 'rateio-cliente-1', lancamento_id: 'referencia-envio-1', cotista_id: 'cotista-1',
    aeronave_id: 'aeronave-1', status: 'EM_ABERTO', valor_rateado_centavos: 350000,
    valor_pago_real_centavos: 0, descricao_despesa: 'Despesa do cliente',
  };
  const envio = {
    id: 'envio-cliente-1', lancamento_id: 'referencia-envio-1', tipo: 'cliente',
    tipo_caixa: 'CLIENTE', status: 'EMAIL_ENVIADO', descricao: 'Despesa do cliente', aeronave_id: 'aeronave-1',
  };

  const resultado = await contextoBaixaCotista(bancoContexto(rateio, envio), rateio.id);
  assert.equal(resultado.natureza, 'PAGAMENTO_DIRETO');
  assert.equal(resultado.conta_id, null);
  assert.equal(resultado.envio_id, envio.id);
  assert.equal(resultado.envio_lancamento_id, envio.lancamento_id);
  assert.equal(resultado.lancamento.id, null);
  assert.deepEqual(resultado.rateios, [rateio]);
});

test('tipo_caixa CLIENTE mantém baixa direta quando o tipo do envio varia', async () => {
  const rateio = { id: 'rateio-fallback', lancamento_id: 'referencia-fallback', status: 'EM_ABERTO', cotista_id: 'cotista-1' };
  const envio = { id: 'envio-fallback', lancamento_id: 'referencia-fallback', tipo: 'DESPESA', tipo_caixa: 'CLIENTE', aeronave_id: 'aeronave-1' };

  const resultado = await contextoBaixaCotista(bancoContexto(rateio, envio), rateio.id);
  assert.equal(resultado.natureza, 'PAGAMENTO_DIRETO');
});

test('baixa direta de envio atualiza os rateios pelo ID de referência e conclui o envio real', () => {
  assert.match(baixaDireta, /updateStatement\(db, schema, 'rateio_despesas'/);
  assert.match(baixaDireta, /const envioLancamentoId = nullableText\(initial\.envio_lancamento_id\) \?\? envioId/);
  assert.match(baixaDireta, /WHERE id = \? AND status IN \('CONVERTIDO', 'APROVADO', 'EMAIL_ENVIADO'\)[\s\S]*?rateio_despesas WHERE lancamento_id = \?/);
  assert.match(baixaDireta, /\.bind\(envioId, envioLancamentoId, envioLancamentoId\)/);
  assert.match(baixaDireta, /if \(p\.conta_bancaria_id\) throw new FinanceError\('Pagamento direto do cotista não utiliza uma conta bancária da Share'/);
});
