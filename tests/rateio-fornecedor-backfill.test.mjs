import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const kernel = await readFile(new URL('../src/financeiro/FinanceiroKernel.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/20261027_rateio_fornecedor_id_backfill.sql', import.meta.url), 'utf8');

test('metadados do lançamento reatacam fornecedor registrado pelo nome quando o id não resolve', () => {
  const metadata = kernel.slice(
    kernel.indexOf('async function resolveLancamentoMetadata('),
    kernel.indexOf('/** A categoria Share é a fonte de verdade'),
  );
  assert.match(metadata, /fornecedores_favoritos/);
  assert.match(metadata, /fornecedores_combustivel/);
  assert.match(metadata, /fornecedor_id:\s*fornecedor\?\.id\s*\?\?\s*\(fornecedorId \|\| null\)/);
});

test('rateio de despesas persiste o fornecedor_id herdado do comando', () => {
  const allocation = kernel.slice(
    kernel.indexOf('function clientAllocationStatements('),
    kernel.indexOf('/** Persiste apenas parcelas de cliente'),
  );
  assert.match(allocation, /fornecedor_id:\s*nullableText\(command\.fornecedor_id\)/);
});

test('migration de backfill preenche fornecedor_id vazio a partir dos cadastros existentes', () => {
  assert.match(migration, /UPDATE envio_despesas[\s\S]*?fornecedores_combustivel/);
  assert.match(migration, /UPDATE lancamentos[\s\S]*?fornecedores_favoritos/);
  assert.match(migration, /UPDATE rateio_despesas[\s\S]*?FROM envio_despesas e[\s\S]*?FROM lancamentos l[\s\S]*?FROM contas_apagar cp[\s\S]*?FROM abastecimentos a/);
  assert.match(migration, /fornecedor_id IS NULL OR NULLIF\(TRIM\(rateio_despesas\.fornecedor_id\), ''\) = ''/);
});
