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

test('rateio referenciado por envio_despesas fornece contexto de pagamento direto sem lançamento Share', () => {
  assert.match(contexto, /SELECT id, tipo, tipo_caixa, status, descricao, aeronave_id FROM envio_despesas WHERE id = \?/);
  assert.match(contexto, /envio && \(upper\(envio\.tipo\) === 'CLIENTE' \|\| upper\(envio\.tipo_caixa\) === 'CLIENTE'\)/);
  assert.match(contexto, /natureza: 'PAGAMENTO_DIRETO'/);
  assert.match(contexto, /envio_id: envio\.id/);
  assert.match(contexto, /rateio_despesas WHERE lancamento_id = \? AND COALESCE\(status, ''\) <> 'CANCELADO'/);
});

test('rateio com lancamento_id do envio de despesas de cliente é baixa direta sem conta Share', async () => {
  const rateio = {
    id: 'rateio-cliente-1', lancamento_id: 'envio-cliente-1', cotista_id: 'cotista-1',
    aeronave_id: 'aeronave-1', status: 'EM_ABERTO', valor_rateado_centavos: 25000,
    valor_pago_real_centavos: 0, descricao_despesa: 'Despesa do cliente',
  };
  const envio = {
    id: 'envio-cliente-1', tipo: 'cliente', tipo_caixa: 'CLIENTE', status: 'CONVERTIDO',
    descricao: 'Despesa do cliente', aeronave_id: 'aeronave-1',
  };
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            first: async () => {
              if (sql.includes('FROM rateio_despesas WHERE id = ?')) return values[0] === rateio.id ? rateio : null;
              if (sql.includes('FROM lancamentos WHERE id = ?')) return null;
              if (sql.includes('FROM envio_despesas WHERE id = ?')) return values[0] === envio.id ? envio : null;
              throw new Error(`Consulta não simulada: ${sql}`);
            },
          };
        },
      };
    },
  };

  const resultado = await contextoBaixaCotista(db, rateio.id);
  assert.equal(resultado.natureza, 'PAGAMENTO_DIRETO');
  assert.equal(resultado.conta_id, null);
  assert.equal(resultado.envio_id, envio.id);
  assert.equal(resultado.lancamento.id, null);
  assert.deepEqual(resultado.rateios, [rateio]);
});

test('tipo_caixa CLIENTE mantém pagamento direto mesmo quando tipo do envio varia', async () => {
  const rateio = { id: 'rateio-fallback', lancamento_id: 'envio-fallback', status: 'EM_ABERTO', cotista_id: 'cotista-1' };
  const envio = { id: 'envio-fallback', tipo: 'DESPESA', tipo_caixa: 'CLIENTE', aeronave_id: 'aeronave-1' };
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return { first: async () => {
            if (sql.includes('FROM rateio_despesas WHERE id = ?')) return rateio;
            if (sql.includes('FROM lancamentos WHERE id = ?')) return null;
            if (sql.includes('FROM envio_despesas WHERE id = ?')) return envio;
            throw new Error(`Consulta não simulada: ${sql}`);
          } };
        },
      };
    },
  };

  assert.equal((await contextoBaixaCotista(db, rateio.id)).natureza, 'PAGAMENTO_DIRETO');
});

test('baixa direta de envio atualiza rateios e conclui envio somente quando todos estiverem pagos', () => {
  assert.match(baixaDireta, /updateStatement\(db, schema, 'rateio_despesas'/);
  assert.match(baixaDireta, /if \(lancamentoId\) statements\.push\(db\.prepare\(`UPDATE lancamentos SET/);
  assert.match(baixaDireta, /if \(envioId\) statements\.push\(db\.prepare\(`UPDATE envio_despesas SET status = 'CONCLUIDO'/);
  assert.match(baixaDireta, /AND NOT EXISTS \(SELECT 1 FROM rateio_despesas WHERE lancamento_id = \? AND COALESCE\(status, ''\) <> 'CANCELADO'/);
  assert.match(baixaDireta, /if \(p\.conta_bancaria_id\) throw new FinanceError\('Pagamento direto do cotista não utiliza uma conta bancária da Share'/);
});
